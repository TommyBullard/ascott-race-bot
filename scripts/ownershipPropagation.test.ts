/**
 * Tests for ownership-context propagation (src/lib/ownershipPropagation.ts) and
 * its wiring into `createCallCron` (src/lib/raceDayPipelineRunner.ts) —
 * Phase 7A route-hardening, B/C Slice 3.
 *
 * Fully offline: `buildOwnershipHeader` is pure; `createCallCron` is exercised
 * with an INJECTED global `fetch` stub (no real HTTP, no Supabase, no provider,
 * no claim). Plus source scans for the fail-closed / no-logging / boundary
 * properties. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import {
  OWNERSHIP_CONTEXT_HEADER,
  OwnershipPropagationError,
  buildOwnershipHeader,
  type OwnershipContextSource,
  type PropagationResult,
} from '../src/lib/ownershipPropagation';
import { parseOwnershipContext } from '../src/lib/ownershipContext';
import { createCallCron } from '../src/lib/raceDayPipelineRunner';

const DATE = '2026-07-25';
const OWNER = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const SECRET = 'slice3-secret-value';

/** A believed selected-course-shaped source. */
function courseSource(over: Partial<OwnershipContextSource> = {}): OwnershipContextSource {
  return { raceDate: DATE, ownerId: OWNER, generation: 2, scope: 'course:ascot', believed: true, ...over };
}

/** A believed nationwide-shaped source (all-uk-ire). */
function nationwideSource(over: Partial<OwnershipContextSource> = {}): OwnershipContextSource {
  return { raceDate: DATE, ownerId: OWNER, generation: 4, scope: 'all-uk-ire', believed: true, ...over };
}

function okHeader(r: PropagationResult): string {
  assert.equal(r.ok, true);
  return (r as { ok: true; header: string }).header;
}

/* -------------------------------------------------------------------------- */
/* 1-12 buildOwnershipHeader (pure)                                            */
/* -------------------------------------------------------------------------- */

test('1. valid selected-course source creates a header', () => {
  const r = buildOwnershipHeader(courseSource());
  assert.equal(r.ok, true);
});

test('2. valid nationwide source creates a header', () => {
  const r = buildOwnershipHeader(nationwideSource());
  assert.equal(r.ok, true);
});

test('3-4. header contains exactly v/date/owner/generation/scope, and no mode', () => {
  const parsed = parseOwnershipContext(okHeader(buildOwnershipHeader(courseSource())));
  assert.equal(parsed.kind, 'valid');
  const ctx = (parsed as unknown as { context: Record<string, unknown> }).context;
  assert.deepEqual(Object.keys(ctx).sort(), ['date', 'generation', 'owner', 'scope', 'v']);
  assert.equal('mode' in ctx, false);
});

test('5. header round-trips through parseOwnershipContext to the source values', () => {
  const src = nationwideSource();
  const parsed = parseOwnershipContext(okHeader(buildOwnershipHeader(src)));
  assert.equal(parsed.kind, 'valid');
  assert.deepEqual((parsed as { context: unknown }).context, {
    v: 1,
    date: src.raceDate,
    owner: src.ownerId,
    generation: src.generation,
    scope: src.scope,
  });
});

test('6. non-believed source fails (not_believed)', () => {
  const r = buildOwnershipHeader(courseSource({ believed: false }));
  assert.deepEqual(r, { ok: false, reason: 'not_believed' });
});

test('7. invalid date fails', () => {
  for (const raceDate of ['2026-13-01', '2026-02-30', '2026-1-1', '', 'today']) {
    assert.deepEqual(buildOwnershipHeader(courseSource({ raceDate })), { ok: false, reason: 'invalid_date' });
  }
});

test('8. blank / non-string owner fails', () => {
  assert.deepEqual(buildOwnershipHeader(courseSource({ ownerId: '' })), { ok: false, reason: 'invalid_owner' });
  assert.deepEqual(buildOwnershipHeader(courseSource({ ownerId: '   ' })), { ok: false, reason: 'invalid_owner' });
  assert.deepEqual(
    buildOwnershipHeader(courseSource({ ownerId: 123 as unknown as string })),
    { ok: false, reason: 'invalid_owner' },
  );
});

test('9. invalid generation fails (zero, negative, decimal, non-number)', () => {
  for (const generation of [0, -1, 2.5, Number.NaN, '2' as unknown as number]) {
    assert.deepEqual(buildOwnershipHeader(courseSource({ generation })), { ok: false, reason: 'invalid_generation' });
  }
});

test('10. invalid scope fails', () => {
  for (const scope of ['', 'nonsense', 'course:', 'course:Ascot', 'all uk ire']) {
    assert.deepEqual(buildOwnershipHeader(courseSource({ scope })), { ok: false, reason: 'invalid_scope' });
  }
});

test('11. builder NEVER throws on malformed input (failure is a value)', () => {
  const junk: unknown[] = [null, undefined, {}, 42, 'x', [], { believed: true }, { believed: true, raceDate: 5 }];
  for (const j of junk) {
    assert.doesNotThrow(() => buildOwnershipHeader(j as OwnershipContextSource));
    assert.equal(buildOwnershipHeader(j as OwnershipContextSource).ok, false);
  }
});

test('12. the module performs no I/O and no environment access', () => {
  const s = readFileSync('src/lib/ownershipPropagation.ts', 'utf8');
  assert.doesNotMatch(s, /\bfetch\(/);
  assert.doesNotMatch(s, /node:fs|node:child_process|node:net|node:https?/);
  assert.doesNotMatch(s, /require\(/);
  assert.doesNotMatch(s, /supabaseAdmin|\.rpc\(|\.from\(/);
  assert.doesNotMatch(s, /process\.env/);
  assert.doesNotMatch(s, /console\./);
});

/* -------------------------------------------------------------------------- */
/* 13-28 createCallCron with injected fetch                                    */
/* -------------------------------------------------------------------------- */

interface FetchCapture {
  calls: { url: string; headers: Record<string, string> }[];
}

function stubFetch(capture: FetchCapture, body: unknown = { ok: true }, status = 200): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    capture.calls.push({ url: String(url), headers: { ...headers } });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function withFetch(fn: (capture: FetchCapture) => Promise<void>, body?: unknown, status?: number): Promise<void> {
  const capture: FetchCapture = { calls: [] };
  const origFetch = globalThis.fetch;
  const origSecret = process.env.CRON_SECRET;
  globalThis.fetch = stubFetch(capture, body, status);
  process.env.CRON_SECRET = SECRET;
  try {
    await fn(capture);
  } finally {
    globalThis.fetch = origFetch;
    if (origSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = origSecret;
  }
}

test('13. createCallCron preserves the Authorization: Bearer header', async () => {
  await withFetch(async (cap) => {
    const call = createCallCron(); // no source
    await call('http://localhost/api/cron/odds?date=2026-07-25');
    assert.equal(cap.calls[0].headers.Authorization, `Bearer ${SECRET}`);
  });
});

test('14. CronCallResult shape + method/URL/body handling preserved', async () => {
  await withFetch(async (cap) => {
    const call = createCallCron();
    const res = await call('http://localhost/api/cron/odds');
    assert.deepEqual(Object.keys(res).sort(), ['body', 'ok']);
    assert.equal(res.ok, true);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(cap.calls[0].url, 'http://localhost/api/cron/odds');
  });
});

test('15. NO ownership callback -> no x-producer-ownership header (compat)', async () => {
  await withFetch(async (cap) => {
    await createCallCron()('http://localhost/api/cron/racecards?day=today');
    assert.equal(cap.calls[0].headers[OWNERSHIP_CONTEXT_HEADER], undefined);
  });
});

test('16. callback returning a valid source -> attaches the ownership header', async () => {
  await withFetch(async (cap) => {
    await createCallCron(() => courseSource())('http://localhost/api/cron/odds');
    const header = cap.calls[0].headers[OWNERSHIP_CONTEXT_HEADER];
    assert.ok(header, 'ownership header present');
    assert.equal(parseOwnershipContext(header).kind, 'valid');
  });
});

test('17. callback returning undefined -> FAILS before fetch (zero HTTP)', async () => {
  await withFetch(async (cap) => {
    const call = createCallCron(() => undefined);
    await assert.rejects(() => call('http://localhost/api/cron/odds'), OwnershipPropagationError);
    assert.equal(cap.calls.length, 0);
  });
});

test('18. callback returning a NON-BELIEVED source -> FAILS before fetch (zero HTTP)', async () => {
  await withFetch(async (cap) => {
    const call = createCallCron(() => courseSource({ believed: false }));
    await assert.rejects(() => call('http://localhost/api/cron/odds'), OwnershipPropagationError);
    assert.equal(cap.calls.length, 0);
  });
});

test('19-20. callback returning a MALFORMED source -> FAILS before fetch, never anonymous', async () => {
  for (const bad of [courseSource({ raceDate: 'nope' }), courseSource({ scope: 'bad' }), courseSource({ generation: 0 })]) {
    await withFetch(async (cap) => {
      const call = createCallCron(() => bad);
      await assert.rejects(() => call('http://localhost/api/cron/odds'), OwnershipPropagationError);
      // Zero requests, and crucially NOT a context-less request.
      assert.equal(cap.calls.length, 0);
    });
  }
});

test('21. context is rebuilt immediately before EACH call (live state read per call)', async () => {
  await withFetch(async (cap) => {
    const state = courseSource();
    const call = createCallCron(() => state);
    await call('http://localhost/api/cron/racecards?day=today');
    state.generation = 7; // simulate a re-acquire/steal bumping generation
    await call('http://localhost/api/cron/odds');
    const g1 = (parseOwnershipContext(cap.calls[0].headers[OWNERSHIP_CONTEXT_HEADER]) as { context: { generation: number } }).context.generation;
    const g2 = (parseOwnershipContext(cap.calls[1].headers[OWNERSHIP_CONTEXT_HEADER]) as { context: { generation: number } }).context.generation;
    assert.equal(g1, 2);
    assert.equal(g2, 7);
  });
});

test('22. different current generations produce different per-call headers', async () => {
  await withFetch(async (cap) => {
    const state = courseSource({ generation: 1 });
    const call = createCallCron(() => state);
    await call('http://localhost/api/cron/odds');
    state.generation = 2;
    await call('http://localhost/api/cron/odds');
    assert.notEqual(cap.calls[0].headers[OWNERSHIP_CONTEXT_HEADER], cap.calls[1].headers[OWNERSHIP_CONTEXT_HEADER]);
  });
});

test('23. the serialized context is not cached across calls (loss between calls fails closed)', async () => {
  await withFetch(async (cap) => {
    const state = courseSource();
    const call = createCallCron(() => state);
    await call('http://localhost/api/cron/racecards?day=today'); // sends header
    state.believed = false; // ownership lost between calls
    await assert.rejects(() => call('http://localhost/api/cron/odds'), OwnershipPropagationError);
    assert.equal(cap.calls.length, 1); // second call never fetched
  });
});

test('27-28. provider failure still returns { ok:false, body } (not a throw)', async () => {
  await withFetch(
    async (cap) => {
      const res = await createCallCron(() => courseSource())('http://localhost/api/cron/odds');
      assert.equal(res.ok, false);
      assert.deepEqual(res.body, { ok: false, error: 'nope' });
      assert.equal(cap.calls.length, 1); // it DID fetch (a real provider failure)
    },
    { ok: false, error: 'nope' },
    500,
  );
});

test('20b. no CRON_SECRET -> no Authorization, but ownership header still attached for a believed source', async () => {
  const capture: FetchCapture = { calls: [] };
  const origFetch = globalThis.fetch;
  const origSecret = process.env.CRON_SECRET;
  globalThis.fetch = stubFetch(capture);
  delete process.env.CRON_SECRET;
  try {
    await createCallCron(() => courseSource())('http://localhost/api/cron/odds');
    assert.equal(capture.calls[0].headers.Authorization, undefined);
    assert.ok(capture.calls[0].headers[OWNERSHIP_CONTEXT_HEADER]);
  } finally {
    globalThis.fetch = origFetch;
    if (origSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = origSecret;
  }
});

/* -------------------------------------------------------------------------- */
/* 24-26 No logging of header / owner / raw body                               */
/* -------------------------------------------------------------------------- */

const RUNNER_SRC = readFileSync('src/lib/raceDayPipelineRunner.ts', 'utf8');
const PROP_SRC = readFileSync('src/lib/ownershipPropagation.ts', 'utf8');
const seam = (): string => RUNNER_SRC.slice(RUNNER_SRC.indexOf('export function createCallCron'));

test('24-25. neither the header, the serialized context, nor a full owner id is logged in the seam', () => {
  const s = seam();
  assert.doesNotMatch(s, /console\.(log|error|warn)/);
  assert.doesNotMatch(s, /OWNERSHIP_CONTEXT_HEADER\s*\}|\$\{.*header/);
  // The propagation lib logs nothing at all.
  assert.doesNotMatch(PROP_SRC, /console\./);
});

test('26. the TEMP-DIAG raw cron-body logging block is absent from createCallCron', () => {
  const s = seam();
  assert.doesNotMatch(s, /TEMP-DIAG callCron/);
  assert.doesNotMatch(s, /body=\$\{JSON\.stringify\(body\)\}/);
  assert.doesNotMatch(s, /res\.statusText/); // the diagnostic's only statusText use is gone
});

/* -------------------------------------------------------------------------- */
/* 29-42 Wiring + integration source scans                                     */
/* -------------------------------------------------------------------------- */

const src = (p: string): string => readFileSync(p, 'utf8');

test('29-31. selected-course pipeline sends context via the seam; model stays in-process', () => {
  const day = src('scripts/runRaceDayPipeline.ts');
  assert.match(day, /createCallCron\(\(\)\s*=>\s*ownership\.state\)/);
  // The model runs in-process (runModelForRace as runOneRace) — not via a route.
  assert.match(day, /runOneRace:\s*runModelForRace/);
  assert.doesNotMatch(day, /\/api\/run-model/);
});

test('32-33. both pipeline scripts acquire ownership BEFORE wiring the seam', () => {
  for (const f of ['scripts/runRaceDayPipeline.ts', 'scripts/runRaceDayPipelineWatch.ts']) {
    const t = src(f);
    const acquireAt = t.indexOf('acquireProducerOwnership(');
    const wireAt = t.indexOf('createCallCron(');
    assert.ok(acquireAt > 0 && wireAt > acquireAt, `${f}: must acquire before wiring the seam`);
  }
});

test('34-37. watcher/pipeline read CURRENT state per call; scope preserved; loss fails closed', () => {
  // The callback closes over the live state object, so later cycles read fresh
  // belief/generation (behavioural proof is tests 21-23). Source-level: the
  // callback form is used (not a pre-serialized string).
  for (const f of ['scripts/runRaceDayPipeline.ts', 'scripts/runRaceDayPipelineWatch.ts']) {
    assert.match(src(f), /createCallCron\(\(\)\s*=>\s*ownership\.state\)/);
  }
  // The guard wrapper still throws on !believed before the call (fail-closed).
  assert.match(src('src/lib/producerOwnership.ts'), /if \(!state\.believed\) throw new OwnershipLostError/);
});

test('38-41. nationwide live-provider sends context; state read per call; scope all-uk-ire', () => {
  const nw = src('scripts/nationwideDryRun.ts');
  assert.match(nw, /createCallCron\(\(\)\s*=>\s*state\)/);
  // racecards + odds are the calls made through this seam.
  assert.match(nw, /\/api\/cron\/racecards/);
  assert.match(nw, /\/api\/cron\/odds/);
  // The nationwide claim scope is the reserved all-uk-ire (unchanged).
  assert.match(src('src/lib/nationwideOwnership.ts'), /ALL_UK_IRE_SCOPE|all-uk-ire/);
});

test('42. nationwide stored-only path makes NO protected provider call', () => {
  const nw = src('scripts/nationwideDryRun.ts');
  // The createCallCron seam is used only inside the live-provider branch.
  const liveIdx = nw.indexOf("mode === 'live-provider'");
  const callIdx = nw.indexOf('createCallCron(');
  assert.ok(liveIdx > 0 && callIdx > liveIdx, 'seam wired inside the live-provider branch');
  assert.match(nw, /stored-only: no provider stages at all/);
});

/* -------------------------------------------------------------------------- */
/* 43-64 Boundary: nothing else changed                                        */
/* -------------------------------------------------------------------------- */

test('43-45. claim lifecycle (acquire/heartbeat/release) unchanged in orchestrators', () => {
  assert.match(src('scripts/runRaceDayPipeline.ts'), /acquireProducerOwnership\(|createHeartbeatController\(|releaseProducerOwnership\(/);
  assert.match(src('scripts/nationwideDryRun.ts'), /releaseNationwideOwnership\(state, heartbeat/);
});

test('46-48. createCallCron changed ONLY to add the header + remove TEMP-DIAG (fetch/ok logic intact)', () => {
  const s = seam();
  assert.match(s, /await fetch\(url, \{ method: 'GET', headers \}\)/);
  assert.match(s, /return \{ ok: res\.ok && okFlag, body \}/);
});

test('49. tipster-discovery receives no context (exempt, unchanged)', () => {
  const t = src('src/app/api/cron/tipster-discovery/route.ts');
  assert.doesNotMatch(t, /routeOwnershipGuard|ownershipContext|ownershipPropagation|x-producer-ownership/);
});

test('50. health / read-only routes get no ownership header', () => {
  // The pipeline seam only calls racecards + odds; health is never called with a context.
  assert.doesNotMatch(src('src/lib/raceDayPipelineRunner.ts'), /\/api\/cron\/health/);
  assert.doesNotMatch(src('src/app/api/cron/health/route.ts'), /ownershipPropagation|x-producer-ownership/);
});

test('51-52. lock:t-minus and results:auto remain claim-free and context-free', () => {
  for (const f of ['scripts/lockTMinus.ts', 'scripts/autoResults.ts']) {
    assert.doesNotMatch(src(f), /ownershipPropagation|createCallCron|x-producer-ownership|tryAcquireProducerClaim/);
  }
});

test('53-54. createCallCron never acquires/heartbeats/releases or queries claim status', () => {
  const s = seam();
  assert.doesNotMatch(s, /tryAcquireProducerClaim|heartbeatProducerClaim|releaseProducerClaim|fetchProducerClaimStatus|producer_claim_status/);
});

test('55-59. Slice 1/2 wire+guard+routes+auth+migration+deploy files are byte-identical to HEAD', () => {
  const normalize = (s: string): string => s.replace(/\r\n/g, '\n');
  for (const f of [
    'src/lib/ownershipContext.ts',
    'src/lib/routeOwnershipGuard.ts',
    'src/lib/auth.ts',
    'src/app/api/cron/racecards/route.ts',
    'src/app/api/cron/odds/route.ts',
    'src/app/api/cron/model/route.ts',
    'src/app/api/cron/results/route.ts',
    'src/app/api/cron/training-capture/route.ts',
    'src/app/api/run-model/route.ts',
    'supabase/migrations/20260711000000_producer_run_claims.sql',
    'vercel.json',
    'docs/RAILWAY_RACE_DAY_AUTOMATION.md',
  ]) {
    const committed = execFileSync('git', ['show', `HEAD:${f}`], { encoding: 'utf8' });
    assert.equal(normalize(src(f)), normalize(committed), `${f} changed`);
  }
});

test('60-63. no model persistence / betting / Slice-4 CLI refusal / deploy logic introduced', () => {
  for (const f of ['src/lib/ownershipPropagation.ts', 'src/lib/raceDayPipelineRunner.ts']) {
    const t = src(f);
    assert.doesNotMatch(t, /placeBet|placeOrder|createOrder|placeInstruction/i);
    assert.doesNotMatch(t, /\.insert\(|\.upsert\(|\.update\(/); // no new writes
    assert.doesNotMatch(t, /PRODUCER_OWNERSHIP_ENFORCEMENT/); // no enforcement/Slice-4 flag here
  }
});
