/**
 * Tests for the Nationwide Readiness Preflight
 * (src/lib/nationwidePreflight.ts + scripts/nationwidePreflight.ts) —
 * Nationwide rebuild Phase 7A.2b Step 5, mode-aware correction.
 *
 * Proves: `--target-mode` is REQUIRED (no default) and is validated by the
 * REAL exported parser (`parseArgs`) before anything else runs; missing/
 * invalid target mode, and any unrecognised flag, are rejected rather than
 * silently ignored; the parser's output genuinely flows into the REAL
 * evaluator (`evaluateNationwidePreflight`) — not just a pure-helper
 * approximation of it; an empty stored workload BLOCKS `stored-only` (nothing
 * to score) but is an ACCEPTABLE precondition for `live-provider` (which
 * exists to ingest it) — never the same generic message for both; human,
 * JSON, and Markdown output all surface `target_mode` /
 * `pre_ingestion_workload_state` / `stored_workload_required` /
 * `expected_write_boundary` / `external_checks_source` / `verdict`; this
 * remains a SEPARATE command from `producer:preflight` (unmodified,
 * regression-tested); external conditions are never labelled automatically
 * verified; `nationwideDryRun`'s live-provider path is never executed by
 * these tests; and Step 1–4 files remain byte-unaware of the nationwide
 * modules. Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildNationwidePreflightJson,
  buildNationwidePreflightPath,
  buildSuggestedNationwideCommand,
  evaluateNationwidePreflight,
  renderNationwidePreflightConsole,
  renderNationwidePreflightMarkdown,
  LIVE_PROVIDER_WRITE_BOUNDARY,
  type NationwidePreflightInput,
  type NationwidePreflightReport,
} from '../src/lib/nationwidePreflight';
import { evaluateProducerPreflight, isReservedNationwideCourse } from '../src/lib/producerPreflight';
import { parseNationwideCliMode, type NationwideWorkloadRow } from '../src/lib/nationwideDryRun';
import { parseArgs } from './nationwidePreflight';

const DATE = '2026-07-18';

function baseInput(over: Partial<NationwidePreflightInput> = {}): NationwidePreflightInput {
  return {
    date: DATE,
    targetMode: 'live-provider',
    requireServer: false,
    confirmExternal: false,
    env: { supabaseUrl: true, serviceRoleKey: true, cronSecret: true, projectHost: 'abc.supabase.co' },
    baseUrl: { raw: 'http://localhost:3000', valid: true, origin: 'http://localhost:3000', reason: null },
    claim: { kind: 'absent' },
    workloadRows: [
      { race_id: 'r1', course_label: 'Curragh', country: 'IRE', runner_count: 8, has_odds: true, priced_runner_count: 8 },
      { race_id: 'r2', course_label: 'Down Royal', country: 'IRE', runner_count: 6, has_odds: true, priced_runner_count: 5 },
    ] as NationwideWorkloadRow[],
    workloadError: null,
    server: { mode: 'probed', outcome: { result: 'ok', detail: 'health ok' } },
    localLockSlugsForDate: [],
    ...over,
  };
}

function check(report: NationwidePreflightReport, id: string) {
  const c = report.checks.find((c) => c.id === id);
  assert.ok(c, `missing check ${id}`);
  return c!;
}

/* ----------------------- 1-3: real parser -> real evaluator ------------------- */

test('1. real parser: missing --target-mode leaves it null, which parseNationwideCliMode rejects', () => {
  const { args, unknownFlags } = parseArgs(['--date', DATE]);
  assert.equal(args.targetMode, null);
  assert.equal(unknownFlags.length, 0);
  assert.equal(parseNationwideCliMode(args.targetMode), null);
});

test('2. real parser: invalid --target-mode value is captured verbatim, which parseNationwideCliMode rejects', () => {
  const { args } = parseArgs(['--date', DATE, '--target-mode', 'bogus']);
  assert.equal(args.targetMode, 'bogus');
  assert.equal(parseNationwideCliMode(args.targetMode), null);
});

test('3. real parser output flows into the real evaluator: --target-mode stored-only produces report.targetMode === stored-only', () => {
  const { args } = parseArgs(['--date', DATE, '--target-mode', 'stored-only']);
  const targetMode = parseNationwideCliMode(args.targetMode);
  assert.ok(targetMode);
  const report = evaluateNationwidePreflight(baseInput({ targetMode: targetMode!, workloadRows: [] }));
  assert.equal(report.targetMode, 'stored-only');
  assert.equal(report.verdict, 'BLOCKED'); // zero workload + stored-only
});

test('10. real parser rejects an unrecognised flag rather than silently ignoring it', () => {
  const { unknownFlags } = parseArgs(['--date', DATE, '--target-mode', 'stored-only', '--bogus-flag']);
  assert.deepEqual(unknownFlags, ['--bogus-flag']);
});

/* ---------------------- 4-5: mode-aware empty-workload verdict ---------------- */

test('4. real evaluator: stored-only with ZERO stored races is BLOCKED with the exact "nothing to score" reason', () => {
  const report = evaluateNationwidePreflight(baseInput({ targetMode: 'stored-only', confirmExternal: true, workloadRows: [] }));
  assert.equal(report.verdict, 'BLOCKED');
  assert.equal(report.preIngestionWorkloadState, 'empty');
  assert.equal(report.storedWorkloadRequired, true);
  assert.equal(report.expectedWriteBoundary.length, 0);
  const c = check(report, 'stored_workload');
  assert.equal(c.status, 'blocked');
  assert.match(c.detail, /stored-only mode has no stored workload to score/);
});

test('5. real evaluator: live-provider with ZERO stored races is an ACCEPTABLE pre-ingestion state — PASS/INFO, never REVIEW/BLOCKED for that reason alone', () => {
  const report = evaluateNationwidePreflight(baseInput({ targetMode: 'live-provider', confirmExternal: true, workloadRows: [] }));
  assert.equal(report.preIngestionWorkloadState, 'empty');
  assert.equal(report.storedWorkloadRequired, false);
  assert.deepEqual(report.expectedWriteBoundary, LIVE_PROVIDER_WRITE_BOUNDARY);
  const c = check(report, 'stored_workload');
  assert.ok(c.status === 'pass' || c.status === 'info', `expected pass/info, got ${c.status}`);
  assert.match(c.detail, /pre-ingestion workload empty; live-provider mode is expected to ingest racecards and odds under the nationwide claim/);
  // With everything else clean and attested, empty pre-ingestion workload alone must not block/review this run.
  assert.equal(report.verdict, 'READY');
});

test('9. the zero-race message is genuinely mode-specific — never the same text for both modes, never the old generic wording', () => {
  const storedOnly = check(
    evaluateNationwidePreflight(baseInput({ targetMode: 'stored-only', confirmExternal: true, workloadRows: [] })),
    'stored_workload',
  ).detail;
  const liveProvider = check(
    evaluateNationwidePreflight(baseInput({ targetMode: 'live-provider', confirmExternal: true, workloadRows: [] })),
    'stored_workload',
  ).detail;
  assert.notEqual(storedOnly, liveProvider);
  const legacyGeneric = 'ZERO stored races/courses for this date — racecards have not been ingested yet (never fetched by this command)';
  assert.notEqual(storedOnly, legacyGeneric);
  assert.notEqual(liveProvider, legacyGeneric);
});

/* --------------------------------- 6-8: output surfaces ------------------------ */

test('6. human console output differs between the two modes and names the mode in the heading', () => {
  const storedReport = evaluateNationwidePreflight(baseInput({ targetMode: 'stored-only', confirmExternal: true, workloadRows: [] }));
  const liveReport = evaluateNationwidePreflight(baseInput({ targetMode: 'live-provider', confirmExternal: true, workloadRows: [] }));
  const storedOut = renderNationwidePreflightConsole(storedReport).join('\n');
  const liveOut = renderNationwidePreflightConsole(liveReport).join('\n');
  assert.notEqual(storedOut, liveOut);
  assert.match(storedOut, /target mode: stored-only/);
  assert.match(liveOut, /target mode: live-provider/);
  assert.match(storedOut, /has no stored workload to score/);
  assert.match(liveOut, /expected to ingest racecards and odds/);
});

test('7. JSON includes target_mode (and the other required mode fields)', () => {
  const report = evaluateNationwidePreflight(baseInput({ targetMode: 'stored-only', confirmExternal: true, workloadRows: [] }));
  const json = buildNationwidePreflightJson(report) as Record<string, unknown>;
  assert.equal(json.target_mode, 'stored-only');
  assert.equal(json.pre_ingestion_workload_state, 'empty');
  assert.equal(json.stored_workload_required, true);
  assert.deepEqual(json.expected_write_boundary, []);
  assert.equal(json.external_checks_source, 'operator_attestation');
  assert.equal(json.verdict, 'BLOCKED');
});

test('8. Markdown includes target_mode (and the other required mode fields)', () => {
  const report = evaluateNationwidePreflight(baseInput({ targetMode: 'live-provider', confirmExternal: true, workloadRows: [] }));
  const md = renderNationwidePreflightMarkdown(report, '2026-07-18T00:00:00.000Z');
  assert.match(md, /target mode: live-provider/);
  assert.match(md, /Pre-ingestion workload state: `empty`/);
  assert.match(md, /Stored workload required: `false`/);
  assert.match(md, /`races`, `runners`, `market_snapshots`, `runner_quotes`, `cron_runs`/);
});

/* ----------------------- 11-12: external attestation (live-provider) ---------- */

test('11. live-provider without --confirm-external remains REVIEW (externals unconfirmed), even with an empty pre-ingestion workload', () => {
  const report = evaluateNationwidePreflight(baseInput({ targetMode: 'live-provider', confirmExternal: false, workloadRows: [] }));
  assert.equal(report.verdict, 'REVIEW');
  assert.equal(report.externalChecksSource, 'unknown');
  assert.equal(check(report, 'stored_workload').status === 'blocked', false); // NOT blocked by the empty workload itself
});

test('12. live-provider WITH --confirm-external becomes READY once every other automated check passes', () => {
  const report = evaluateNationwidePreflight(baseInput({ targetMode: 'live-provider', confirmExternal: true, workloadRows: [] }));
  assert.equal(report.verdict, 'READY');
  assert.equal(report.externalChecksSource, 'operator_attestation');
  assert.equal(report.suggestedCommand, buildSuggestedNationwideCommand(DATE, 'live-provider'));
  assert.match(report.suggestedCommand!, /^npm run nationwide:dry-run -- --date 2026-07-18 --mode live-provider --report$/);
});

/* --------------------------- both modes: unrelated BLOCKED reasons ------------- */

test('both modes: a LIVE claim of any scope BLOCKS regardless of target mode', () => {
  for (const targetMode of ['stored-only', 'live-provider'] as const) {
    const report = evaluateNationwidePreflight(
      baseInput({
        targetMode,
        confirmExternal: true,
        claim: { kind: 'live', ownerPrefix: 'abcd1234', scope: 'course:newmarket', generation: 2, remainingSeconds: 100, expiresAt: 't' },
      }),
    );
    assert.equal(report.verdict, 'BLOCKED', `mode ${targetMode} must still block on a live claim`);
    assert.equal(report.suggestedCommand, null);
  }
});

test('both modes: ownership mechanism failure BLOCKS regardless of target mode', () => {
  for (const targetMode of ['stored-only', 'live-provider'] as const) {
    const report = evaluateNationwidePreflight(
      baseInput({ targetMode, confirmExternal: true, claim: { kind: 'mechanism_failed', failureKind: 'mechanism_unavailable', message: 'missing' } }),
    );
    assert.equal(report.verdict, 'BLOCKED', `mode ${targetMode} must still block`);
  }
});

test('both modes: an invariant violation in EXISTING stored data (non-empty workload) BLOCKS regardless of target mode', () => {
  const badRows: NationwideWorkloadRow[] = [{ race_id: 'bad', course_label: 'Curragh', country: 'IRE', runner_count: 3, has_odds: true, priced_runner_count: 9 }];
  for (const targetMode of ['stored-only', 'live-provider'] as const) {
    const report = evaluateNationwidePreflight(baseInput({ targetMode, confirmExternal: true, workloadRows: badRows }));
    assert.equal(report.verdict, 'BLOCKED', `mode ${targetMode} must still block on an invariant violation`);
    assert.equal(report.preIngestionWorkloadState, 'present');
  }
});

test('both modes: server failure under --require-server BLOCKS regardless of target mode', () => {
  for (const targetMode of ['stored-only', 'live-provider'] as const) {
    const report = evaluateNationwidePreflight(
      baseInput({ targetMode, confirmExternal: true, requireServer: true, server: { mode: 'probed', outcome: { result: 'unreachable', detail: 'net error' } } }),
    );
    assert.equal(report.verdict, 'BLOCKED', `mode ${targetMode} must still block`);
  }
});

/* -------------------------- separation from producer:preflight --------------- */

test('15. SEPARATE command: producer:preflight still rejects the nationwide scope in every spelling (regression, unmodified)', () => {
  for (const raw of ['all-uk-ire', 'all uk ire', 'ALL-UK-IRE']) {
    assert.equal(isReservedNationwideCourse(raw), true);
  }
  const report = evaluateProducerPreflight({
    date: DATE,
    courseRaw: 'all-uk-ire',
    requireServer: false,
    confirmExternal: true,
    env: { supabaseUrl: true, serviceRoleKey: true, cronSecret: true, projectHost: null },
    baseUrl: { raw: 'http://localhost:3000', valid: true, origin: 'http://localhost:3000', reason: null },
    claim: { kind: 'absent' },
    workload: { races: 5, runners: 50, racesWithOdds: 5, racesWithModelRuns: 0, settled: 0, upcoming: 5 },
    workloadError: null,
    server: { mode: 'probed', outcome: { result: 'ok', detail: 'ok' } },
  });
  assert.equal(report.verdict, 'BLOCKED');
  assert.equal(report.scope, null);
});

test('nationwidePreflight.ts never rejects all-uk-ire itself (it IS the nationwide scope) and takes no --course argument', () => {
  const lib = readFileSync('src/lib/nationwidePreflight.ts', 'utf8');
  assert.equal(/isReservedNationwideCourse/.test(lib), false);
  const cli = readFileSync('scripts/nationwidePreflight.ts', 'utf8');
  assert.equal(/--course/.test(cli), false);
});

/* -------------------------------- other verdict rules ------------------------- */

test('verdict: invalid date -> BLOCKED', () => {
  const report = evaluateNationwidePreflight(baseInput({ date: '2026-13-40' }));
  assert.equal(report.verdict, 'BLOCKED');
  assert.equal(check(report, 'ownership_mechanism').evidence, 'not_applicable');
  assert.equal(report.preIngestionWorkloadState, 'invalid');
});

test('verdict: an EXPIRED claim -> REVIEW, explicitly NOT auto-stolen', () => {
  const report = evaluateNationwidePreflight(
    baseInput({ confirmExternal: true, claim: { kind: 'expired', ownerPrefix: 'abcd1234', scope: 'all-uk-ire', generation: 2, expiredSeconds: 200 } }),
  );
  assert.equal(report.verdict, 'REVIEW');
  assert.match(check(report, 'active_claim').detail, /did NOT steal it/);
});

test('verdict: odds gap (0 races with odds) on a non-empty stored workload -> REVIEW for both modes', () => {
  for (const targetMode of ['stored-only', 'live-provider'] as const) {
    const report = evaluateNationwidePreflight(
      baseInput({
        targetMode,
        confirmExternal: true,
        workloadRows: [{ race_id: 'r1', course_label: 'Curragh', country: 'IRE', runner_count: 8, has_odds: false, priced_runner_count: null }],
      }),
    );
    assert.equal(report.verdict, 'REVIEW');
    assert.equal(check(report, 'odds_coverage').status, 'review');
    assert.equal(report.preIngestionWorkloadState, 'present');
  }
});

test('verdict: stored-only with a complete, consistent, fully-attested non-empty workload -> READY', () => {
  const report = evaluateNationwidePreflight(baseInput({ targetMode: 'stored-only', confirmExternal: true }));
  assert.equal(report.verdict, 'READY');
  assert.equal(report.preIngestionWorkloadState, 'present');
  assert.equal(report.suggestedCommand, buildSuggestedNationwideCommand(DATE, 'stored-only'));
  assert.match(report.suggestedCommand!, /^npm run nationwide:dry-run -- --date 2026-07-18 --mode stored-only --report$/);
});

test('verdict: missing required configuration (incl. CRON_SECRET) -> BLOCKED, values never rendered', () => {
  const report = evaluateNationwidePreflight(
    baseInput({ confirmExternal: true, env: { supabaseUrl: true, serviceRoleKey: true, cronSecret: false, projectHost: null } }),
  );
  assert.equal(report.verdict, 'BLOCKED');
  assert.match(check(report, 'required_configuration').detail, /CRON_SECRET/);
  assert.match(check(report, 'required_configuration').detail, /values are never read/);
});

test('verdict: invalid base URL -> BLOCKED; server unreachable -> REVIEW normally; wrong app always BLOCKED', () => {
  const badUrl = evaluateNationwidePreflight(baseInput({ confirmExternal: true, baseUrl: { raw: 'http://u:p@x', valid: false, origin: null, reason: 'creds' } }));
  assert.equal(badUrl.verdict, 'BLOCKED');

  const unreachable = baseInput({ confirmExternal: true, server: { mode: 'probed', outcome: { result: 'unreachable', detail: 'net error' } } });
  assert.equal(evaluateNationwidePreflight(unreachable).verdict, 'REVIEW');

  const wrongApp = baseInput({ confirmExternal: true, server: { mode: 'probed', outcome: { result: 'wrong_app', detail: 'HTTP 500' } } });
  assert.equal(evaluateNationwidePreflight(wrongApp).verdict, 'BLOCKED');
});

/* --------------------------- external honesty (Correction 2) ------------------ */

test('without --confirm-external: Railway/Vercel/local-process checks stay UNKNOWN and best verdict is REVIEW', () => {
  const report = evaluateNationwidePreflight(baseInput({ confirmExternal: false }));
  assert.equal(report.verdict, 'REVIEW');
  assert.equal(report.externalChecksSource, 'unknown');
  for (const id of ['railway_job_state', 'vercel_cron_state']) {
    const c = check(report, id);
    assert.equal(c.evidence, 'unknown');
    assert.match(c.detail, /UNKNOWN|MANUAL/);
  }
});

test('with --confirm-external: labelled operator_attested, NEVER "automatically verified"', () => {
  const report = evaluateNationwidePreflight(baseInput({ confirmExternal: true }));
  assert.equal(report.externalChecksSource, 'operator_attestation');
  for (const id of ['railway_job_state', 'vercel_cron_state']) {
    const c = check(report, id);
    assert.equal(c.evidence, 'operator_attested');
    assert.match(c.detail, /NOT automatically verified/);
  }
  const everywhere = JSON.stringify(buildNationwidePreflightJson(report)) + renderNationwidePreflightMarkdown(report, '2026-07-18T00:00:00.000Z');
  assert.equal(/automatically verified/i.test(everywhere.replace(/NOT automatically verified/gi, '')), false);
});

test('local supervisor.lock signals: presence is strong automated evidence (REVIEW) regardless of attestation; absence still needs attestation', () => {
  const found = evaluateNationwidePreflight(baseInput({ confirmExternal: true, localLockSlugsForDate: ['race-day-2026-07-18-newmarket'] }));
  const c = check(found, 'local_supervisor_locks');
  assert.equal(c.status, 'review');
  assert.equal(c.evidence, 'automatically_verified');
  assert.match(c.detail, /race-day-2026-07-18-newmarket/);

  const absentUnconfirmed = evaluateNationwidePreflight(baseInput({ confirmExternal: false, localLockSlugsForDate: [] }));
  assert.equal(check(absentUnconfirmed, 'local_supervisor_locks').evidence, 'unknown');
});

test('bypass entry points are always listed and never affect the verdict', () => {
  const report = evaluateNationwidePreflight(baseInput({ confirmExternal: true }));
  const c = check(report, 'bypass_entry_points');
  assert.equal(c.status, 'info');
  assert.match(c.detail, /run-model/);
  assert.match(c.detail, /operational/);
});

/* --------------------------------- output safety ------------------------------ */

test('outputs never contain env values or authorization material', () => {
  const sentinel = 'SENTINEL-NEVER-PRINT-98765';
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = sentinel;
  try {
    const report = evaluateNationwidePreflight(baseInput({ confirmExternal: true }));
    const all =
      renderNationwidePreflightConsole(report).join('\n') +
      JSON.stringify(buildNationwidePreflightJson(report)) +
      renderNationwidePreflightMarkdown(report, '2026-07-18T00:00:00.000Z');
    assert.equal(all.includes(sentinel), false);
    assert.equal(/Authorization/i.test(all), false);
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  }
});

test('JSON output: exactly one deterministic object; marks read_only + nationwide_execution disabled', () => {
  const report = evaluateNationwidePreflight(baseInput({ confirmExternal: true }));
  const a = buildNationwidePreflightJson(report);
  const b = buildNationwidePreflightJson(report);
  assert.deepEqual(a, b);
  const parsed = JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
  assert.equal(parsed.read_only, true);
  assert.equal(parsed.nationwide_execution, 'disabled');
  assert.equal(parsed.suggested_command_executed, false);
});

test('Markdown: deterministic and honest about external checks', () => {
  const report = evaluateNationwidePreflight(baseInput());
  const md1 = renderNationwidePreflightMarkdown(report, '2026-07-18T09:00:00.000Z');
  const md2 = renderNationwidePreflightMarkdown(report, '2026-07-18T09:00:00.000Z');
  assert.equal(md1, md2);
  assert.match(md1, /READ ONLY/);
  assert.match(md1, /manual\/operator-attested unless proven/);
});

test('report path: reports/nationwide-preflight-<date>.md', () => {
  assert.equal(buildNationwidePreflightPath(DATE), 'reports/nationwide-preflight-2026-07-18.md');
});

/* --------------------------------- source scans -------------------------------- */

const CLI = () => readFileSync('scripts/nationwidePreflight.ts', 'utf8');
const LIB = () => readFileSync('src/lib/nationwidePreflight.ts', 'utf8');

test('CLI is read-only: no Supabase writes, no --commit, no child processes, local-lock scan never mutates', () => {
  const src = CLI();
  assert.equal(/\.(insert|update|upsert|delete)\s*\(/.test(src), false);
  assert.equal(/args\.commit|case '--commit'/.test(src), false);
  assert.equal(/child_process|spawnSync|execSync/.test(src), false);
  const scanFn = src.slice(src.indexOf('function scanLocalSupervisorLocks'), src.indexOf('function createWorkloadClient'));
  assert.equal(/writeFileSync|rmSync|unlinkSync|rmdirSync/.test(scanFn), false);
});

test('CLI validates --target-mode BEFORE any status RPC, workload query, health probe, or write', () => {
  const src = CLI();
  const modeCheckIdx = src.indexOf('parseNationwideCliMode(args.targetMode)');
  const statusRpcIdx = src.indexOf('fetchProducerClaimStatus(');
  const workloadIdx = src.indexOf('fetchNationwideWorkloadRows(');
  const probeIdx = src.indexOf('probeHealthEndpoint(');
  const writeIdx = src.indexOf('writeFileSync(');
  assert.ok(modeCheckIdx > 0);
  assert.ok(statusRpcIdx > modeCheckIdx, 'status RPC must come after the mode check');
  assert.ok(workloadIdx > modeCheckIdx, 'workload query must come after the mode check');
  assert.ok(probeIdx > modeCheckIdx, 'health probe must come after the mode check');
  assert.ok(writeIdx > modeCheckIdx, 'any write must come after the mode check');
});

test('CLI never passes --confirm-external automatically to any downstream process (it has no downstream process)', () => {
  const src = CLI();
  assert.equal(/spawn|exec\(/.test(src), false);
});

test('14. the dry-run CLI never PARSES --confirm-external, and its live-provider path is never invoked by these tests', () => {
  const dryRunSrc = readFileSync('scripts/nationwideDryRun.ts', 'utf8');
  assert.equal(/case '--confirm-external'|args\.confirmExternal\b/.test(dryRunSrc), false);
  // These tests import ONLY pure evaluation/rendering from nationwidePreflight —
  // never scripts/nationwideDryRun.ts's main() / live-provider execution path.
  const thisTestSrc = readFileSync('scripts/nationwidePreflight.test.ts', 'utf8');
  assert.equal(/from '\.\/nationwideDryRun'/.test(thisTestSrc.replace(/from '\.\/nationwidePreflight'/g, '')), false);
});

test('the report file is written ONLY under --report (single guarded write)', () => {
  const src = CLI();
  const writes = src.match(/writeFileSync\(/g) ?? [];
  assert.equal(writes.length, 1);
  const guardIdx = src.indexOf('if (args.report)');
  const writeIdx = src.indexOf('writeFileSync(');
  assert.ok(guardIdx >= 0 && writeIdx > guardIdx);
});

test('16. production paths and Step 1-4 files remain untouched by this correction (no NEW nationwide-module references leak into them)', () => {
  // Every file below is checked for awareness of the NEW Step 5 modules/CLI
  // names and the new --target-mode flag specifically — NOT for the bare
  // 'all-uk-ire' literal, which several Step 1-3 files legitimately contain
  // already: producerClaim.ts DEFINES `ALL_UK_IRE_SCOPE = 'all-uk-ire'`, and
  // producerPreflight.ts's entire purpose (Step 3) is to REJECT that exact
  // literal as a course. Neither is new Step 5 awareness.
  const newModuleRe = /nationwideDryRun|nationwidePreflight|nationwideOwnership|nationwide:dry-run|nationwide:preflight|--target-mode/;
  for (const file of [
    'src/lib/producerClaim.ts',
    'src/lib/producerOwnership.ts',
    'src/lib/producerPreflight.ts',
    'scripts/runRaceDayPipeline.ts',
    'scripts/runRaceDayPipelineWatch.ts',
    'race-day-local/start-race-day.bat',
    'race-day-local/watch-pipeline.bat',
    'race-day-local/watch-locks.bat',
    'race-day-local/watch-results.bat',
  ]) {
    const src = readFileSync(file, 'utf8');
    assert.equal(newModuleRe.test(src), false, `${file} must not reference the NEW Step 5 nationwide modules/CLI/flag`);
  }
  // Sanity: confirm the pre-existing Step 1/3 nationwide-scope handling is
  // genuinely still there (proves the exclusion above is deliberate, not a
  // silent gap).
  assert.match(readFileSync('src/lib/producerClaim.ts', 'utf8'), /ALL_UK_IRE_SCOPE\s*=\s*'all-uk-ire'/);
  assert.match(readFileSync('src/lib/producerPreflight.ts', 'utf8'), /RESERVED_NATIONWIDE_NORMALISED/);
});

test('the status RPC (via producerClaim) is the only ownership operation this preflight performs', () => {
  const src = CLI();
  assert.match(src, /fetchProducerClaimStatus\(/);
  assert.equal(/tryAcquireProducerClaim|heartbeatProducerClaim|releaseProducerClaim|acquireNationwideOwnership/.test(src), false);
});

test('LIB reuses the SAME fixed health probe path builder as producer:preflight (no second probe target)', () => {
  const preflightSrc = readFileSync('src/lib/producerPreflight.ts', 'utf8');
  assert.match(preflightSrc, /\/api\/cron\/health\?date=/);
  assert.equal(/\/api\/cron\/health\?date=/.test(LIB()), false); // reused via import, not re-declared
  assert.match(LIB(), /from '\.\/producerPreflight'/);
});

test('LIB reuses the SAME NationwideCliMode/parseNationwideCliMode as nationwideDryRun.ts — no second mode type', () => {
  assert.match(LIB(), /from '\.\/nationwideDryRun'/);
  assert.equal(/export type NationwideCliMode = 'stored-only'/.test(LIB()), false); // re-exported, not redeclared
});
