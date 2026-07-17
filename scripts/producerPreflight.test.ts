/**
 * Tests for the Producer Readiness Preflight
 * (src/lib/producerPreflight.ts + scripts/producerPreflight.ts) — Nationwide
 * rebuild Phase 7A.2b Step 3.
 *
 * Proves, with pure inputs and fake fetch clients (no DB, no network): the
 * reserved nationwide course input is rejected in every spelling and can never
 * become a course scope; verdict rules (live claim BLOCKED, expired claim
 * REVIEW and never auto-stolen, mechanism/permission/malformed BLOCKED, zero
 * races REVIEW, no odds REVIEW, zero model runs still READY-eligible — model
 * coverage is never a blocker); external conditions stay UNKNOWN unless the
 * operator explicitly attests them, and attestation is labelled
 * operator_attested, never automatically verified; the health probe hits ONLY
 * the fixed read-only path with a bounded timeout, GET-only, redirects
 * refused, credentials-in-URL rejected, 401/403 classified honestly, and no
 * authorization value in any output; renderers are deterministic, single-JSON-
 * object, and secret-free; and — by source scan — the CLI references the
 * status RPC as its only ownership operation, performs no writes, spawns no
 * child processes, imports no provider/model/pipeline/ownership module, and
 * rejects --commit. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  HEALTH_PROBE_TIMEOUT_MS,
  buildHealthProbeUrl,
  buildPreflightJson,
  buildProducerPreflightPath,
  buildSuggestedPipelineCommand,
  evaluateProducerPreflight,
  isReservedNationwideCourse,
  probeHealthEndpoint,
  renderPreflightConsole,
  renderPreflightMarkdown,
  summarizeClaimStatus,
  validateBaseUrl,
  type HealthFetch,
  type HealthProbeInit,
  type PreflightInput,
  type ProducerPreflightReport,
} from '../src/lib/producerPreflight';
import type { StatusOutcome } from '../src/lib/producerClaim';

const DATE = '2026-07-17';

/* ------------------- reserved nationwide input (correction 1) ---------------- */

test('reserved nationwide course: every spelling and normalised equivalent is detected', () => {
  for (const raw of [
    'all-uk-ire',
    'all uk ire',
    'ALL-UK-IRE',
    'All UK Ire',
    '  all-uk-ire  ',
    'all_uk_ire', // punctuation normalises to spaces
    'ALL  UK  IRE',
  ]) {
    assert.equal(isReservedNationwideCourse(raw), true, `should reject reserved input: "${raw}"`);
  }
  assert.equal(isReservedNationwideCourse('Newmarket'), false);
  assert.equal(isReservedNationwideCourse('Royal Ascot'), false);
});

test('reserved nationwide course: the evaluator BLOCKS it and never builds a course scope from it', () => {
  for (const raw of ['all-uk-ire', 'all uk ire', 'All UK Ire']) {
    const report = evaluateProducerPreflight(baseInput({ courseRaw: raw }));
    assert.equal(report.verdict, 'BLOCKED');
    assert.equal(report.scope, null); // never course:all-uk-ire / course:all uk ire
    const check = report.checks.find((c) => c.id === 'date_course_scope');
    assert.equal(check?.status, 'blocked');
    assert.match(check?.detail ?? '', /reserved nationwide scope/);
    const everywhere = JSON.stringify(buildPreflightJson(report)) + renderPreflightMarkdown(report, '2026-07-17T00:00:00.000Z');
    assert.equal(everywhere.includes('course:all-uk-ire'), false);
    assert.equal(everywhere.includes('course:all uk ire'), false);
  }
});

/* ------------------------------ base URL / probe URL -------------------------- */

test('validateBaseUrl: http/https only, no URL credentials, origin extracted', () => {
  assert.equal(validateBaseUrl('http://localhost:3000').valid, true);
  assert.equal(validateBaseUrl('https://app.example.com').origin, 'https://app.example.com');
  assert.equal(validateBaseUrl('not a url').valid, false);
  assert.equal(validateBaseUrl('ftp://x').valid, false);
  const withCreds = validateBaseUrl('http://user:pass@localhost:3000');
  assert.equal(withCreds.valid, false);
  assert.match(withCreds.reason ?? '', /credentials/);
});

test('health probe URL: fixed read-only path only, derived from origin + date', () => {
  assert.equal(
    buildHealthProbeUrl('http://localhost:3000', DATE),
    `http://localhost:3000/api/cron/health?date=${DATE}`,
  );
});

/* ------------------------------ health probe --------------------------------- */

function okHealthBody(): unknown {
  return { meetingDate: DATE, day: 'date', generatedAt: 't', health: { overall: 'ok' }, cronJobs: [] };
}

function fakeFetch(
  impl: (url: string, init: HealthProbeInit) => Promise<{ status: number; json(): Promise<unknown> }>,
): { fetchFn: HealthFetch; seen: { url: string | null; init: HealthProbeInit | null } } {
  const seen: { url: string | null; init: HealthProbeInit | null } = { url: null, init: null };
  const fetchFn: HealthFetch = (url, init) => {
    seen.url = url;
    seen.init = init;
    return impl(url, init);
  };
  return { fetchFn, seen };
}

test('probe: GET-only, redirects refused, bounded AbortSignal, bearer sent but never echoed', async () => {
  const { fetchFn, seen } = fakeFetch(async () => ({ status: 200, json: async () => okHealthBody() }));
  const outcome = await probeHealthEndpoint('http://localhost:3000', DATE, 'super-secret-value', fetchFn);
  assert.equal(outcome.result, 'ok');
  assert.equal(seen.url, `http://localhost:3000/api/cron/health?date=${DATE}`);
  assert.equal(seen.init?.method, 'GET');
  assert.equal(seen.init?.redirect, 'manual');
  assert.ok(seen.init?.signal instanceof AbortSignal); // bounded timeout attached
  assert.equal(seen.init?.headers.Authorization, 'Bearer super-secret-value'); // sent…
  assert.equal(JSON.stringify(outcome).includes('super-secret-value'), false); // …never echoed
  assert.equal(HEALTH_PROBE_TIMEOUT_MS, 5_000);
});

test('probe: any 3xx is refused (redirects are never followed, cross-origin or otherwise)', async () => {
  const { fetchFn } = fakeFetch(async () => ({ status: 302, json: async () => null }));
  const outcome = await probeHealthEndpoint('http://localhost:3000', DATE, null, fetchFn);
  assert.equal(outcome.result, 'redirect_refused');
});

test('probe: 401 and 403 are classified honestly (reachable, auth not accepted)', async () => {
  const u = await probeHealthEndpoint('http://x', DATE, null, fakeFetch(async () => ({ status: 401, json: async () => null })).fetchFn);
  assert.equal(u.result, 'unauthorized');
  assert.match(u.detail, /401/);
  const f = await probeHealthEndpoint('http://x', DATE, null, fakeFetch(async () => ({ status: 403, json: async () => null })).fetchFn);
  assert.equal(f.result, 'forbidden');
});

test('probe: timeout and network errors classified distinctly; never throws', async () => {
  const timeoutErr = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const t = await probeHealthEndpoint('http://x', DATE, null, fakeFetch(async () => Promise.reject(timeoutErr)).fetchFn);
  assert.equal(t.result, 'timeout');
  assert.match(t.detail, /5000ms/);
  const n = await probeHealthEndpoint('http://x', DATE, null, fakeFetch(async () => Promise.reject(new Error('ECONNREFUSED'))).fetchFn);
  assert.equal(n.result, 'unreachable');
});

test('probe: reachable but wrong app / malformed body classified as wrong_app', async () => {
  const notJson = await probeHealthEndpoint('http://x', DATE, null, fakeFetch(async () => ({
    status: 200,
    json: async () => {
      throw new Error('not json');
    },
  })).fetchFn);
  assert.equal(notJson.result, 'wrong_app');
  const wrongShape = await probeHealthEndpoint('http://x', DATE, null, fakeFetch(async () => ({
    status: 200,
    json: async () => ({ hello: 'world' }),
  })).fetchFn);
  assert.equal(wrongShape.result, 'wrong_app');
  const serverError = await probeHealthEndpoint('http://x', DATE, null, fakeFetch(async () => ({
    status: 500,
    json: async () => ({ error: 'x' }),
  })).fetchFn);
  assert.equal(serverError.result, 'wrong_app');
});

/* --------------------------- claim status summary ----------------------------- */

function statusOutcome(over: Partial<Extract<StatusOutcome, { ok: true }>> = {}): StatusOutcome {
  return {
    ok: true,
    claim: {
      raceDate: DATE,
      scope: 'course:newmarket',
      ownerId: 'owner-abcdefghij',
      generation: 2,
      claimedAt: 't1',
      heartbeatAt: 't2',
      expiresAt: 't3',
      hostname: null,
      pid: null,
      appVersion: null,
      mode: null,
    },
    serverNowIso: 't0',
    liveness: { status: 'live', remainingSeconds: 120, expiredSeconds: null },
    ...over,
  };
}

test('summarizeClaimStatus: absent / live / expired / unknown / mechanism_failed, with 8-char owner prefix only', () => {
  assert.deepEqual(
    summarizeClaimStatus({ ok: true, claim: null, serverNowIso: 't', liveness: { status: 'absent', remainingSeconds: null, expiredSeconds: null } }),
    { kind: 'absent' },
  );
  const live = summarizeClaimStatus(statusOutcome());
  assert.equal(live.kind, 'live');
  assert.equal(live.kind === 'live' && live.ownerPrefix, 'owner-ab'); // prefix, never the full id
  const expired = summarizeClaimStatus(
    statusOutcome({ liveness: { status: 'expired', remainingSeconds: null, expiredSeconds: 90 } }),
  );
  assert.equal(expired.kind, 'expired');
  const unknown = summarizeClaimStatus(
    statusOutcome({ liveness: { status: 'unknown', remainingSeconds: null, expiredSeconds: null } }),
  );
  assert.equal(unknown.kind, 'unknown_liveness');
  const failed = summarizeClaimStatus({ ok: false, failure: { kind: 'mechanism_unavailable', message: 'missing' } });
  assert.equal(failed.kind, 'mechanism_failed');
});

/* ------------------------------ the evaluator --------------------------------- */

function baseInput(over: Partial<PreflightInput> = {}): PreflightInput {
  return {
    date: DATE,
    courseRaw: 'Newmarket',
    requireServer: false,
    confirmExternal: false,
    env: { supabaseUrl: true, serviceRoleKey: true, cronSecret: true, projectHost: 'abc.supabase.co' },
    baseUrl: { raw: 'http://localhost:3000', valid: true, origin: 'http://localhost:3000', reason: null },
    claim: { kind: 'absent' },
    workload: { races: 7, runners: 70, racesWithOdds: 7, racesWithModelRuns: 0, settled: 0, upcoming: 7 },
    workloadError: null,
    server: { mode: 'probed', outcome: { result: 'ok', detail: 'health ok' } },
    ...over,
  };
}

function check(report: ProducerPreflightReport, id: string) {
  const c = report.checks.find((c) => c.id === id);
  assert.ok(c, `missing check ${id}`);
  return c!;
}

test('verdict: full local evidence + operator attestation → READY; suggestion is text only', () => {
  const report = evaluateProducerPreflight(baseInput({ confirmExternal: true }));
  assert.equal(report.verdict, 'READY');
  assert.equal(report.scope, 'course:newmarket');
  assert.equal(report.suggestedCommand, buildSuggestedPipelineCommand(DATE, 'Newmarket'));
  assert.match(report.suggestedCommand!, /^npm run pipeline:day -- --date 2026-07-17 --course "Newmarket" --commit$/);
  // Zero model runs did NOT prevent READY (correction 3):
  assert.equal(check(report, 'model_coverage').status, 'info');
});

test('verdict: without --confirm-external the best result is REVIEW and external checks stay UNKNOWN', () => {
  const report = evaluateProducerPreflight(baseInput({ confirmExternal: false }));
  assert.equal(report.verdict, 'REVIEW');
  assert.equal(report.externalChecksSource, 'unknown');
  for (const id of ['railway_job_state', 'vercel_cron_state', 'local_process_knowledge']) {
    const c = check(report, id);
    assert.equal(c.status, 'review');
    assert.ok(c.evidence === 'unknown', `${id} must be unknown without attestation`);
    assert.match(c.detail, /MANUAL|UNKNOWN/i);
  }
});

test('attestation honesty (correction 2): --confirm-external is operator_attested, NEVER automatically verified', () => {
  const report = evaluateProducerPreflight(baseInput({ confirmExternal: true }));
  assert.equal(report.externalChecksSource, 'operator_attestation');
  for (const id of ['railway_job_state', 'vercel_cron_state', 'local_process_knowledge']) {
    const c = check(report, id);
    assert.equal(c.evidence, 'operator_attested');
    assert.match(c.detail, /NOT automatically verified/);
  }
  const json = buildPreflightJson(report) as { external_checks_source?: unknown };
  assert.equal(json.external_checks_source, 'operator_attestation');
  const md = renderPreflightMarkdown(report, '2026-07-17T00:00:00.000Z');
  assert.match(md, /operator_attestation/);
  assert.match(md, /manual\/operator-attested unless proven/);
});

test('verdict: a LIVE claim forces BLOCKED', () => {
  const report = evaluateProducerPreflight(
    baseInput({
      confirmExternal: true,
      claim: { kind: 'live', ownerPrefix: 'abcd1234', scope: 'course:ascot', generation: 3, remainingSeconds: 100, expiresAt: 't' },
    }),
  );
  assert.equal(report.verdict, 'BLOCKED');
  assert.match(check(report, 'active_claim').detail, /LIVE claim/);
  assert.equal(report.suggestedCommand, null);
});

test('verdict: an EXPIRED claim produces REVIEW and is explicitly NOT auto-stolen', () => {
  const report = evaluateProducerPreflight(
    baseInput({
      confirmExternal: true,
      claim: { kind: 'expired', ownerPrefix: 'abcd1234', scope: 'course:ascot', generation: 3, expiredSeconds: 300 },
    }),
  );
  assert.equal(report.verdict, 'REVIEW');
  assert.match(check(report, 'active_claim').detail, /did NOT steal it/);
});

test('verdict: mechanism missing/permission-denied/malformed and unknown liveness all force BLOCKED', () => {
  for (const claim of [
    { kind: 'mechanism_failed' as const, failureKind: 'mechanism_unavailable' as const, message: 'relation missing' },
    { kind: 'mechanism_failed' as const, failureKind: 'transient_uncertain' as const, message: 'uncertain' },
    { kind: 'unknown_liveness' as const },
  ]) {
    const report = evaluateProducerPreflight(baseInput({ confirmExternal: true, claim }));
    assert.equal(report.verdict, 'BLOCKED', `claim ${claim.kind} must block`);
  }
});

test('verdict: zero stored races → REVIEW (never a fabricated READY, never BLOCKED)', () => {
  const report = evaluateProducerPreflight(
    baseInput({
      confirmExternal: true,
      workload: { races: 0, runners: 0, racesWithOdds: 0, racesWithModelRuns: 0, settled: 0, upcoming: 0 },
    }),
  );
  assert.equal(report.verdict, 'REVIEW');
  assert.match(check(report, 'stored_races').detail, /did NOT fetch/);
  assert.equal(check(report, 'stored_odds').evidence, 'not_applicable');
});

test('verdict: races with no odds → REVIEW; model coverage NEVER blocks by itself (correction 3)', () => {
  const noOdds = evaluateProducerPreflight(
    baseInput({
      confirmExternal: true,
      workload: { races: 7, runners: 70, racesWithOdds: 0, racesWithModelRuns: 0, settled: 0, upcoming: 7 },
    }),
  );
  assert.equal(noOdds.verdict, 'REVIEW');
  assert.equal(check(noOdds, 'stored_odds').status, 'review');

  for (const runs of [0, 3, 7]) {
    const report = evaluateProducerPreflight(
      baseInput({
        confirmExternal: true,
        workload: { races: 7, runners: 70, racesWithOdds: 7, racesWithModelRuns: runs, settled: 0, upcoming: 7 },
      }),
    );
    assert.equal(check(report, 'model_coverage').status, 'info', `coverage ${runs}/7 must stay informational`);
    assert.equal(report.verdict, 'READY', `coverage ${runs}/7 must not prevent READY`);
  }
});

test('verdict: missing required configuration (incl. CRON_SECRET) → BLOCKED with named-variables-only rationale', () => {
  const report = evaluateProducerPreflight(
    baseInput({
      confirmExternal: true,
      env: { supabaseUrl: true, serviceRoleKey: true, cronSecret: false, projectHost: 'abc.supabase.co' },
    }),
  );
  assert.equal(report.verdict, 'BLOCKED');
  const c = check(report, 'required_configuration');
  assert.match(c.detail, /CRON_SECRET/); // the NAME
  assert.match(c.detail, /values are never read/);
});

test('verdict: server unreachable/timeout → REVIEW normally, BLOCKED under --require-server; wrong app always BLOCKED', () => {
  const unreachable = baseInput({ confirmExternal: true, server: { mode: 'probed', outcome: { result: 'unreachable', detail: 'network error' } } });
  assert.equal(evaluateProducerPreflight(unreachable).verdict, 'REVIEW');
  assert.equal(evaluateProducerPreflight({ ...unreachable, requireServer: true }).verdict, 'BLOCKED');

  const wrongApp = baseInput({ confirmExternal: true, server: { mode: 'probed', outcome: { result: 'wrong_app', detail: 'unexpected response (HTTP 500)' } } });
  assert.equal(evaluateProducerPreflight(wrongApp).verdict, 'BLOCKED');

  const skipped = baseInput({ confirmExternal: true, server: { mode: 'skipped', outcome: null } });
  const skippedReport = evaluateProducerPreflight(skipped);
  assert.equal(skippedReport.verdict, 'REVIEW');
  assert.equal(check(skippedReport, 'server_reachability').evidence, 'unknown');
});

test('verdict: 401/403 from the probe are honest REVIEW (or BLOCKED with --require-server), never OK', () => {
  const unauthorized = baseInput({
    confirmExternal: true,
    server: { mode: 'probed', outcome: { result: 'unauthorized', detail: 'reachable, but the CRON_SECRET bearer was not accepted (HTTP 401)' } },
  });
  assert.equal(evaluateProducerPreflight(unauthorized).verdict, 'REVIEW');
  assert.equal(evaluateProducerPreflight({ ...unauthorized, requireServer: true }).verdict, 'BLOCKED');
});

test('verdict: invalid base URL → BLOCKED', () => {
  const report = evaluateProducerPreflight(
    baseInput({ confirmExternal: true, baseUrl: { raw: 'http://u:p@x', valid: false, origin: null, reason: 'URL credentials are not permitted in the base URL' } }),
  );
  assert.equal(report.verdict, 'BLOCKED');
});

test('verdict: invalid date / missing course → BLOCKED, downstream checks not_applicable', () => {
  const badDate = evaluateProducerPreflight(baseInput({ date: '2026-13-40' }));
  assert.equal(badDate.verdict, 'BLOCKED');
  assert.equal(check(badDate, 'ownership_mechanism').evidence, 'not_applicable');
  const noCourse = evaluateProducerPreflight(baseInput({ courseRaw: '   ' }));
  assert.equal(noCourse.verdict, 'BLOCKED');
});

test('bypass entry points are always listed (gated / exempt / bypasses) and never affect the verdict', () => {
  const report = evaluateProducerPreflight(baseInput({ confirmExternal: true }));
  const c = check(report, 'bypass_entry_points');
  assert.equal(c.status, 'info');
  assert.match(c.detail, /pipeline:day, pipeline:watch/);
  assert.match(c.detail, /lock:t-minus, results:auto/);
  assert.match(c.detail, /run-model/);
  assert.match(c.detail, /operational restrictions/);
});

test('course normalisation is reused: "Royal Ascot" produces scope course:ascot', () => {
  const report = evaluateProducerPreflight(baseInput({ courseRaw: 'Royal Ascot', confirmExternal: true }));
  assert.equal(report.scope, 'course:ascot');
});

/* --------------------------- output safety / determinism ---------------------- */

test('outputs never contain env values or authorization material', () => {
  const sentinel = 'SENTINEL-NEVER-PRINT-12345';
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = sentinel;
  try {
    const report = evaluateProducerPreflight(baseInput({ confirmExternal: true }));
    const all =
      renderPreflightConsole(report).join('\n') +
      JSON.stringify(buildPreflightJson(report)) +
      renderPreflightMarkdown(report, '2026-07-17T00:00:00.000Z');
    assert.equal(all.includes(sentinel), false);
    assert.equal(/Bearer\s+[A-Za-z0-9]/.test(all), false);
    assert.equal(/Authorization/i.test(all), false);
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  }
});

test('JSON output: exactly one deterministic object, round-trips, marks read_only + not-executed + nationwide disabled', () => {
  const report = evaluateProducerPreflight(baseInput({ confirmExternal: true }));
  const a = buildPreflightJson(report);
  const b = buildPreflightJson(report);
  assert.deepEqual(a, b); // deterministic
  const parsed = JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
  assert.equal(parsed.read_only, true);
  assert.equal(parsed.suggested_command_executed, false);
  assert.equal(parsed.nationwide_execution, 'disabled');
  assert.equal(parsed.verdict, 'READY');
});

test('Markdown: deterministic for fixed timestamp and contains every required statement', () => {
  const report = evaluateProducerPreflight(baseInput());
  const md1 = renderPreflightMarkdown(report, '2026-07-17T09:00:00.000Z');
  const md2 = renderPreflightMarkdown(report, '2026-07-17T09:00:00.000Z');
  assert.equal(md1, md2);
  assert.match(md1, /READ ONLY/);
  assert.match(md1, /No provider or model work was started/);
  assert.match(md1, /No ownership claim was acquired/);
  assert.match(md1, /Nationwide execution remains disabled/);
  assert.match(md1, /manual\/operator-attested unless proven/);
  assert.match(md1, /suggested pipeline command was NOT executed/);
});

test('report path: reports/producer-preflight-<date>-<normalised-slug>.md', () => {
  assert.equal(buildProducerPreflightPath(DATE, 'Newmarket'), 'reports/producer-preflight-2026-07-17-newmarket.md');
  assert.equal(buildProducerPreflightPath(DATE, 'Royal Ascot'), 'reports/producer-preflight-2026-07-17-ascot.md');
});

test('console output: header, READ ONLY line, verdict, and operator actions per verdict', () => {
  const ready = renderPreflightConsole(evaluateProducerPreflight(baseInput({ confirmExternal: true }))).join('\n');
  assert.match(ready, /^Producer readiness — 2026-07-17 — Newmarket/);
  assert.match(ready, /READ ONLY/);
  assert.match(ready, /Verdict: READY/);
  assert.match(ready, /NOT executed/);
  const blocked = renderPreflightConsole(
    evaluateProducerPreflight(baseInput({ claim: { kind: 'live', ownerPrefix: 'x', scope: 'course:ascot', generation: 1, remainingSeconds: 1, expiresAt: 't' } })),
  ).join('\n');
  assert.match(blocked, /NO producer should start/);
});

/* ------------------------------ source scans ---------------------------------- */
// Scans inspect actual imports/calls/statements — not prose (the docstrings
// legitimately describe forbidden operations in order to forbid them).

const LIB_SRC = () => readFileSync('src/lib/producerPreflight.ts', 'utf8');
const CLI_SRC = () => readFileSync('scripts/producerPreflight.ts', 'utf8');

test('the status RPC is the ONLY ownership operation referenced (no claim/heartbeat/release)', () => {
  for (const src of [LIB_SRC(), CLI_SRC()]) {
    assert.equal(/\b(tryAcquireProducerClaim|heartbeatProducerClaim|releaseProducerClaim|acquireProducerOwnership)\s*\(/.test(src), false);
  }
  assert.match(CLI_SRC(), /fetchProducerClaimStatus\(/);
});

test('no Supabase write methods, no write RPCs, no child processes, no provider/model/pipeline imports', () => {
  for (const [name, src] of [['lib', LIB_SRC()], ['cli', CLI_SRC()]] as const) {
    assert.equal(/\.(insert|update|upsert|delete)\s*\(/.test(src), false, `${name}: no write methods`);
    assert.equal(/child_process|spawnSync|spawn\(|execSync|fork\(/.test(src), false, `${name}: no child processes`);
    assert.equal(
      /from\s+['"][^'"]*\/(racingApi|betfairExchange|liveSync|runModelForRace|producerOwnership|lockTMinus|autoResults|raceDayPipelineRunner|runRaceDayPipeline\w*)['"]/.test(src),
      false,
      `${name}: no provider/model/pipeline/ownership imports`,
    );
  }
});

test('the health probe path is fixed in the lib and the CLI has no fetch of its own', () => {
  // The ONE permitted URL is built by the lib's fixed builder (not operator-configurable).
  assert.match(LIB_SRC(), /`\$\{origin\}\/api\/cron\/health\?date=/);
  // The CLI performs no direct fetch — its only network path is probeHealthEndpoint.
  assert.match(CLI_SRC(), /probeHealthEndpoint\(/);
  assert.equal(/\bfetch\s*\(/.test(CLI_SRC()), false);
});

test('the CLI rejects --commit explicitly and has no commit-mode support', () => {
  const src = CLI_SRC();
  assert.match(src, /rawArgv\.includes\('--commit'\)/); // explicit rejection branch
  assert.match(src, /--commit is not supported/);
  assert.equal(/args\.commit|commitRequested|case '--commit'/.test(src), false); // never PARSED as a mode
});

test('the CLI rejects the --skip-server/--require-server conflict', () => {
  assert.match(CLI_SRC(), /args\.skipServer && args\.requireServer/);
});

test('the report file is written ONLY under --report (single guarded write)', () => {
  const src = CLI_SRC();
  const writes = src.match(/writeFileSync\(/g) ?? [];
  assert.equal(writes.length, 1);
  const guardIdx = src.indexOf('if (args.report)');
  const writeIdx = src.indexOf('writeFileSync(');
  assert.ok(guardIdx >= 0 && writeIdx > guardIdx, 'writeFileSync must sit inside the --report guard');
});

test('production paths remain untouched by Step 3 (no preflight references leak into them)', () => {
  for (const file of [
    'scripts/runRaceDayPipeline.ts',
    'scripts/runRaceDayPipelineWatch.ts',
    'scripts/lockTMinus.ts',
    'scripts/autoResults.ts',
    'src/lib/raceDayPipelineRunner.ts',
    'src/lib/runModelForRace.ts',
  ]) {
    const src = readFileSync(file, 'utf8');
    assert.equal(/producerPreflight/i.test(src), false, `${file} must not reference the preflight`);
  }
});
