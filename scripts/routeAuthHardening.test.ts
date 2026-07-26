/**
 * Route-level tests for Phase 7A hardening, Step A: fail-closed `CRON_SECRET`
 * on every write-capable route, and the permanent 410 deprecation of
 * `/api/settle`.
 *
 * These run the REAL exported handlers in-process (no HTTP server, no
 * deployment, no database, no provider), plus source-level scans for the
 * properties that cannot be proven by invocation alone.
 *
 * DELIBERATE LIMIT: an authorized cron call is NOT invoked here — doing so
 * would execute real provider ingestion, model persistence, or settlement.
 * Acceptance is proven through the pure helper (scripts/auth.test.ts) plus the
 * scan showing each route delegates to it. That boundary is intentional.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SECRET = 'route-test-secret-value';

/** Every write-capable route hardened in Step A. */
const WRITE_CAPABLE_ROUTES = [
  { id: 'racecards', path: 'src/app/api/cron/racecards/route.ts', url: 'http://localhost/api/cron/racecards' },
  { id: 'odds', path: 'src/app/api/cron/odds/route.ts', url: 'http://localhost/api/cron/odds' },
  { id: 'model', path: 'src/app/api/cron/model/route.ts', url: 'http://localhost/api/cron/model' },
  { id: 'results', path: 'src/app/api/cron/results/route.ts', url: 'http://localhost/api/cron/results' },
  {
    id: 'training-capture',
    path: 'src/app/api/cron/training-capture/route.ts',
    url: 'http://localhost/api/cron/training-capture',
  },
  {
    id: 'tipster-discovery',
    path: 'src/app/api/cron/tipster-discovery/route.ts',
    url: 'http://localhost/api/cron/tipster-discovery',
  },
] as const;

type RouteHandler = (request: Request) => Promise<Response>;

/** Imports a route module by repo-relative path. */
async function importRoute(path: string): Promise<Record<string, unknown>> {
  const specifier = `../${path.replace(/^src\//, 'src/').replace(/\.ts$/, '')}`;
  return (await import(specifier)) as Record<string, unknown>;
}

/**
 * Runs `fn` with `CRON_SECRET` set to `value` (or removed when undefined),
 * always restoring the previous value — the suite shares one process.
 */
async function withCronSecret(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const saved = process.env.CRON_SECRET;
  if (value === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = value;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  }
}

const src = (path: string): string => readFileSync(path, 'utf8');

/* -------------------------------------------------------------------------- */
/* Fail-closed behaviour on the real handlers                                 */
/* -------------------------------------------------------------------------- */

for (const route of WRITE_CAPABLE_ROUTES) {
  test(`${route.id}: MISSING CRON_SECRET refuses (503) — the route is never open`, async () => {
    await withCronSecret(undefined, async () => {
      const mod = await importRoute(route.path);
      const res = await (mod.GET as RouteHandler)(new Request(route.url));
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: 'Endpoint unavailable' });
    });
  });

  test(`${route.id}: BLANK CRON_SECRET refuses (503)`, async () => {
    await withCronSecret('   ', async () => {
      const mod = await importRoute(route.path);
      const res = await (mod.GET as RouteHandler)(
        new Request(route.url, { headers: { authorization: 'Bearer    ' } }),
      );
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: 'Endpoint unavailable' });
    });
  });

  test(`${route.id}: incorrect bearer is rejected (401), body reveals nothing`, async () => {
    await withCronSecret(SECRET, async () => {
      const mod = await importRoute(route.path);
      const res = await (mod.GET as RouteHandler)(
        new Request(route.url, { headers: { authorization: 'Bearer wrong-token' } }),
      );
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.deepEqual(body, { error: 'Unauthorized' });
      assert.ok(!JSON.stringify(body).includes(SECRET));
    });
  });

  test(`${route.id}: missing Authorization header is rejected (401)`, async () => {
    await withCronSecret(SECRET, async () => {
      const mod = await importRoute(route.path);
      const res = await (mod.GET as RouteHandler)(new Request(route.url));
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'Unauthorized' });
    });
  });
}

test('run-model: fail-closed on a missing secret and on a wrong bearer (POST)', async () => {
  const url = 'http://localhost/api/run-model?race_id=abc';
  await withCronSecret(undefined, async () => {
    const mod = await importRoute('src/app/api/run-model/route.ts');
    const res = await (mod.POST as RouteHandler)(new Request(url, { method: 'POST' }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'Endpoint unavailable' });
  });
  await withCronSecret(SECRET, async () => {
    const mod = await importRoute('src/app/api/run-model/route.ts');
    const res = await (mod.POST as RouteHandler)(
      new Request(url, { method: 'POST', headers: { authorization: 'Bearer nope' } }),
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'Unauthorized' });
  });
});

test('every write-capable route delegates to the fail-closed helper', () => {
  for (const route of [...WRITE_CAPABLE_ROUTES.map((r) => r.path), 'src/app/api/run-model/route.ts']) {
    const text = src(route);
    assert.match(text, /requireCronSecret\(/, `${route} does not call requireCronSecret`);
    assert.match(text, /describeCronAuthFailure\(/, `${route} does not use the shared refusal`);
    // The removed fail-open convention must not reappear anywhere.
    assert.doesNotMatch(text, /if \(cronSecret\)/, `${route} still has the fail-open guard`);
    assert.doesNotMatch(text, /isAuthorized\(/, `${route} still uses the removed fail-open helper`);
  }
});

test('the auth check is the FIRST work in each handler (before any provider/model/query call)', () => {
  // Real work calls only — patterns chosen to avoid matching "async function".
  const WORK = [
    /\bsyncRacecards\(/,
    /\bsyncOddsFromBetfair\(/,
    /\bsyncResults\(/,
    /\brefreshModelForMeeting\(/,
    /\bcaptureTrainingExamples\(/,
    /\bdiscoverTipsters\(/,
    /\brunModelForRace\(/,
    /\bsearchParams\.get\(/,
    /\bfetchRacingApiSignals\(/,
  ];
  for (const route of [...WRITE_CAPABLE_ROUTES.map((r) => r.path), 'src/app/api/run-model/route.ts']) {
    const text = src(route);
    const authAt = text.indexOf('requireCronSecret(');
    assert.ok(authAt > 0, `${route}: no auth check found`);
    for (const pattern of WORK) {
      const m = pattern.exec(text);
      if (m) {
        assert.ok(authAt < m.index, `${route}: ${pattern} appears before the auth check`);
      }
    }
  }
});

/* -------------------------------------------------------------------------- */
/* /api/settle — permanently gone, with no write path                         */
/* -------------------------------------------------------------------------- */

const SETTLE_PATH = 'src/app/api/settle/route.ts';

test('/api/settle: POST returns 410 Gone', async () => {
  const mod = await importRoute(SETTLE_PATH);
  const res = await (mod.POST as () => Promise<Response>)();
  assert.equal(res.status, 410);
});

test('/api/settle: GET (browser navigation) also returns an inert 410', async () => {
  const mod = await importRoute(SETTLE_PATH);
  const res = await (mod.GET as () => Promise<Response>)();
  assert.equal(res.status, 410);
});

test('/api/settle: exports only the two inert handlers (no other entry point)', async () => {
  const mod = await importRoute(SETTLE_PATH);
  assert.deepEqual(
    Object.keys(mod)
      .filter((k) => k !== 'dynamic')
      .sort(),
    ['GET', 'POST'],
  );
});

test('/api/settle: handlers take NO request argument, so no input is readable', async () => {
  const mod = await importRoute(SETTLE_PATH);
  assert.equal((mod.GET as () => unknown).length, 0);
  assert.equal((mod.POST as () => unknown).length, 0);
});

test('/api/settle: the 410 body is generic and secret-free', async () => {
  const mod = await importRoute(SETTLE_PATH);
  for (const handler of [mod.GET, mod.POST] as (() => Promise<Response>)[]) {
    const body = (await (await handler()).json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['error']);
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /CRON_SECRET|SUPABASE|SERVICE_ROLE|BETFAIR|RACING_API|Bearer/i);
    assert.doesNotMatch(text, /npm run|race_id|winning_runner_id|finish_pos|owner|supabase/i);
    assert.match(text, /removed/i);
  }
});

test('/api/settle: contains no database access of any kind', () => {
  const text = src(SETTLE_PATH);
  assert.doesNotMatch(text, /supabaseAdmin/);
  assert.doesNotMatch(text, /\.from\(/);
  assert.doesNotMatch(text, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  assert.doesNotMatch(text, /\.rpc\(/);
});

test('/api/settle: cannot update runners.finish_pos or race status', () => {
  const text = src(SETTLE_PATH);
  assert.doesNotMatch(text, /finish_pos/);
  assert.doesNotMatch(text, /'runners'|"runners"/);
  assert.doesNotMatch(text, /'races'|"races"/);
  // No table write of any kind (the meaningful proof — the only `status` in the
  // file is the HTTP 410 status option, which cannot mutate a race).
  assert.doesNotMatch(text, /\.update\(|\.upsert\(|\.insert\(/);
  assert.doesNotMatch(text, /status\s*=\s*'result'|status:\s*'result'/);
});

test('/api/settle: imports no settlement helper and no provider client', () => {
  const text = src(SETTLE_PATH);
  assert.doesNotMatch(text, /from\s+'@\/lib\/raceData'/);
  assert.doesNotMatch(text, /settleRace\(/);
  assert.doesNotMatch(text, /computeModelAccuracy\(/);
  assert.doesNotMatch(text, /settleTodayResults\(|syncResults\(|importResults/);
  assert.doesNotMatch(text, /createRacingApiClient\(|betfair/i);
  // Exactly one import: NextResponse.
  const imports = [...text.matchAll(/^import .*$/gm)].map((m) => m[0]);
  assert.deepEqual(imports, ["import { NextResponse } from 'next/server';"]);
});

test('/api/settle: performs no outbound call and spawns nothing', () => {
  const text = src(SETTLE_PATH);
  assert.doesNotMatch(text, /\bfetch\(/);
  assert.doesNotMatch(text, /node:child_process|spawn\(|exec\(/);
  assert.doesNotMatch(text, /node:fs|writeFileSync/);
});

test('no other route re-exposes the settlement helper over HTTP', () => {
  const routes = [
    ...WRITE_CAPABLE_ROUTES.map((r) => r.path),
    'src/app/api/run-model/route.ts',
    'src/app/api/settle/route.ts',
    'src/app/api/recommend-bet/route.ts',
    'src/app/api/accuracy/route.ts',
    'src/app/api/recommendations/route.ts',
  ];
  for (const route of routes) {
    assert.doesNotMatch(src(route), /settleRace\(/, `${route} calls settleRace`);
  }
});

/* -------------------------------------------------------------------------- */
/* Boundary: everything Step A must NOT have touched                          */
/* -------------------------------------------------------------------------- */

test('guarded settlement tooling is unchanged and still available', () => {
  // The audited manual path and the read-only audit both survive untouched.
  const importer = src('scripts/importResultsCsv.ts');
  assert.match(importer, /finish_pos/);
  const autoResults = src('scripts/autoResults.ts');
  assert.doesNotMatch(autoResults, /requireCronSecret|describeCronAuthFailure/);
  assert.doesNotMatch(importer, /requireCronSecret|describeCronAuthFailure/);
});

test('nationwide dry-run and write-boundary evidence tooling are untouched', () => {
  for (const file of [
    'src/lib/nationwideDryRun.ts',
    'scripts/nationwideDryRun.ts',
    'src/lib/nationwideOwnership.ts',
    'src/lib/nationwidePreflight.ts',
    'src/lib/nationwideWriteBoundaryAudit.ts',
    'scripts/nationwideWriteBoundaryAudit.ts',
    'scripts/nationwideWriteBoundaryCompare.ts',
  ]) {
    assert.doesNotMatch(src(file), /requireCronSecret|describeCronAuthFailure/, `${file} was modified`);
  }
});

test('selected-course ownership, supervisor and lock tooling are untouched', () => {
  for (const file of [
    'src/lib/producerClaim.ts',
    'src/lib/producerOwnership.ts',
    'src/lib/producerPreflight.ts',
    'src/lib/raceDayLauncher.ts',
    'src/lib/raceDayPipelineRunner.ts',
    'scripts/runRaceDayPipeline.ts',
    'scripts/runRaceDayPipelineWatch.ts',
    'scripts/lockTMinus.ts',
  ]) {
    assert.doesNotMatch(src(file), /requireCronSecret|describeCronAuthFailure/, `${file} was modified`);
  }
  // The pipeline still authenticates its cron calls exactly as before.
  assert.match(src('src/lib/raceDayPipelineRunner.ts'), /Authorization: `Bearer \$\{secret\}`/);
});

test('no ownership verification was introduced in this step (B and C are deferred)', () => {
  for (const route of [...WRITE_CAPABLE_ROUTES.map((r) => r.path), 'src/app/api/settle/route.ts']) {
    const text = src(route);
    assert.doesNotMatch(text, /producer_claim_status|fetchProducerClaimStatus|ownershipContext|x-producer-ownership/i);
  }
});

test('no migration, Railway, or Vercel configuration changed', () => {
  // vercel.json cron schedules are byte-for-byte the same as before this phase.
  const vercel = JSON.parse(src('vercel.json')) as { crons: { path: string; schedule: string }[] };
  assert.deepEqual(
    vercel.crons.map((c) => `${c.path} ${c.schedule}`),
    [
      '/api/cron/tipster-discovery 0 6 * * *',
      '/api/cron/racecards 0 7 * * *',
      '/api/cron/odds */5 * * * *',
      '/api/cron/model 2-59/5 * * * *',
      '/api/cron/results */5 * * * *',
      '/api/cron/training-capture 4-59/5 * * * *',
    ],
  );
  // These files must be byte-identical to the committed baseline (c66d9b5).
  // A word-scan would false-positive on the migration's own comment prose, so
  // compare against git HEAD directly instead.
  const normalize = (s: string): string => s.replace(/\r\n/g, '\n');
  // Migration + vercel.json remain byte-identical (config, never touched). The
  // RAILWAY doc is documentation, not configuration — Slice 4b edits its wording
  // only (see ownershipEnforcementDocs.test), so it is not asserted here.
  for (const file of [
    'supabase/migrations/20260711000000_producer_run_claims.sql',
    'vercel.json',
  ]) {
    const committed = execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' });
    assert.equal(normalize(src(file)), normalize(committed), `${file} differs from HEAD`);
  }
});

test('read-only routes were deliberately left alone (Step A covers write paths)', () => {
  for (const file of ['src/app/api/cron/health/route.ts', 'src/app/api/ml/calibration/route.ts']) {
    const text = src(file);
    // Still read-only, so still out of scope for the fail-closed change.
    assert.doesNotMatch(text, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
    assert.doesNotMatch(text, /requireCronSecret\(/);
  }
});

test('no betting or order-placement functionality was introduced', () => {
  for (const file of [
    'src/lib/auth.ts',
    'src/app/api/settle/route.ts',
    ...WRITE_CAPABLE_ROUTES.map((r) => r.path),
    'src/app/api/run-model/route.ts',
  ]) {
    const text = src(file);
    assert.doesNotMatch(text, /placeBet\(|placeOrder\(|placeOrders\(|createOrder\(/);
    assert.doesNotMatch(text, /\/betting\/rest|placeInstruction/i);
  }
});
