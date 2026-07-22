/**
 * Tests for the Nationwide Readiness Preflight
 * (src/lib/nationwidePreflight.ts + scripts/nationwidePreflight.ts) —
 * Nationwide rebuild Phase 7A.2b Step 5.
 *
 * Proves this is a SEPARATE command from `producer:preflight` (which stays
 * selected-course-only and still rejects `all-uk-ire` — verified here as a
 * regression check, not modified); the verdict rules (ANY live claim of any
 * scope BLOCKS — the date-level PK conflicts regardless of scope; expired
 * claim is REVIEW, never auto-stolen; mechanism failure/unknown liveness
 * BLOCK; zero/low workload is REVIEW; impossible rollup values BLOCK; missing
 * required configuration BLOCKS); external conditions (Railway/Vercel/local
 * supervisor locks) are NEVER labelled automatically verified — only
 * `operator_attestation` or `unknown`; the health probe reuses the SAME fixed
 * path as `producer:preflight`; JSON output is exactly one deterministic
 * object; the Markdown report is deterministic and never written without
 * `--report`; and — by source scan — this command never accepts a `--course`
 * argument, never passes `--confirm-external` to anything automatically,
 * never mutates the database, and the local-lock scan is read-only.
 * Run with: npm test
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
  type NationwidePreflightInput,
  type NationwidePreflightReport,
} from '../src/lib/nationwidePreflight';
import { evaluateProducerPreflight, isReservedNationwideCourse } from '../src/lib/producerPreflight';
import type { NationwideWorkloadRow } from '../src/lib/nationwideDryRun';

const DATE = '2026-07-18';

function baseInput(over: Partial<NationwidePreflightInput> = {}): NationwidePreflightInput {
  return {
    date: DATE,
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

/* -------------------------- separation from producer:preflight --------------- */

test('SEPARATE command: producer:preflight still rejects the nationwide scope in every spelling (regression, unmodified)', () => {
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

/* -------------------------------- verdict rules ------------------------------- */

test('verdict: invalid date -> BLOCKED', () => {
  const report = evaluateNationwidePreflight(baseInput({ date: '2026-13-40' }));
  assert.equal(report.verdict, 'BLOCKED');
  assert.equal(check(report, 'ownership_mechanism').evidence, 'not_applicable');
});

test('verdict: a LIVE claim of ANY scope (including a course scope) BLOCKS — date-level PK conflicts regardless of scope', () => {
  const report = evaluateNationwidePreflight(
    baseInput({
      confirmExternal: true,
      claim: { kind: 'live', ownerPrefix: 'abcd1234', scope: 'course:newmarket', generation: 2, remainingSeconds: 100, expiresAt: 't' },
    }),
  );
  assert.equal(report.verdict, 'BLOCKED');
  assert.match(check(report, 'active_claim').detail, /course:newmarket/);
  assert.equal(report.suggestedCommand, null);
});

test('verdict: an EXPIRED claim -> REVIEW, explicitly NOT auto-stolen', () => {
  const report = evaluateNationwidePreflight(
    baseInput({ confirmExternal: true, claim: { kind: 'expired', ownerPrefix: 'abcd1234', scope: 'all-uk-ire', generation: 2, expiredSeconds: 200 } }),
  );
  assert.equal(report.verdict, 'REVIEW');
  assert.match(check(report, 'active_claim').detail, /did NOT steal it/);
});

test('verdict: mechanism failure / unknown liveness -> BLOCKED', () => {
  for (const claim of [
    { kind: 'mechanism_failed' as const, failureKind: 'mechanism_unavailable' as const, message: 'missing' },
    { kind: 'unknown_liveness' as const },
  ]) {
    const report = evaluateNationwidePreflight(baseInput({ confirmExternal: true, claim }));
    assert.equal(report.verdict, 'BLOCKED', `claim ${claim.kind} must block`);
  }
});

test('verdict: zero stored races/courses -> REVIEW, never a fabricated READY', () => {
  const report = evaluateNationwidePreflight(baseInput({ confirmExternal: true, workloadRows: [] }));
  assert.equal(report.verdict, 'REVIEW');
  assert.match(check(report, 'stored_workload').detail, /ZERO stored/);
  assert.equal(check(report, 'odds_coverage').evidence, 'not_applicable');
});

test('verdict: odds gap (0 races with odds) -> REVIEW, model coverage concept not applicable here (no model runs exist in a dry-run)', () => {
  const report = evaluateNationwidePreflight(
    baseInput({
      confirmExternal: true,
      workloadRows: [{ race_id: 'r1', course_label: 'Curragh', country: 'IRE', runner_count: 8, has_odds: false, priced_runner_count: null }],
    }),
  );
  assert.equal(report.verdict, 'REVIEW');
  assert.equal(check(report, 'odds_coverage').status, 'review');
});

test('verdict: impossible rollup values (priced_runner_count exceeds runner_count) BLOCK the verdict', () => {
  const report = evaluateNationwidePreflight(
    baseInput({
      confirmExternal: true,
      workloadRows: [{ race_id: 'bad', course_label: 'Curragh', country: 'IRE', runner_count: 3, has_odds: true, priced_runner_count: 9 }],
    }),
  );
  assert.equal(report.verdict, 'BLOCKED');
  assert.equal(check(report, 'rollup_reconciliation').status, 'blocked');
});

test('verdict: complete, consistent, fully-attested workload -> READY; suggested command is text only', () => {
  const report = evaluateNationwidePreflight(baseInput({ confirmExternal: true }));
  assert.equal(report.verdict, 'READY');
  assert.equal(report.suggestedCommand, buildSuggestedNationwideCommand(DATE));
  assert.match(report.suggestedCommand!, /^npm run nationwide:dry-run -- --date 2026-07-18 --mode live-provider$/);
});

test('verdict: missing required configuration (incl. CRON_SECRET) -> BLOCKED, values never rendered', () => {
  const report = evaluateNationwidePreflight(
    baseInput({ confirmExternal: true, env: { supabaseUrl: true, serviceRoleKey: true, cronSecret: false, projectHost: null } }),
  );
  assert.equal(report.verdict, 'BLOCKED');
  assert.match(check(report, 'required_configuration').detail, /CRON_SECRET/);
  assert.match(check(report, 'required_configuration').detail, /values are never read/);
});

test('verdict: invalid base URL -> BLOCKED; server unreachable -> REVIEW normally, BLOCKED with --require-server; wrong app always BLOCKED', () => {
  const badUrl = evaluateNationwidePreflight(baseInput({ confirmExternal: true, baseUrl: { raw: 'http://u:p@x', valid: false, origin: null, reason: 'creds' } }));
  assert.equal(badUrl.verdict, 'BLOCKED');

  const unreachable = baseInput({ confirmExternal: true, server: { mode: 'probed', outcome: { result: 'unreachable', detail: 'net error' } } });
  assert.equal(evaluateNationwidePreflight(unreachable).verdict, 'REVIEW');
  assert.equal(evaluateNationwidePreflight({ ...unreachable, requireServer: true }).verdict, 'BLOCKED');

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
  // readdirSync/existsSync only — never a write/removal call in the scan function.
  const scanFn = src.slice(src.indexOf('function scanLocalSupervisorLocks'), src.indexOf('function createWorkloadClient'));
  assert.equal(/writeFileSync|rmSync|unlinkSync|rmdirSync/.test(scanFn), false);
});

test('CLI never passes --confirm-external automatically to any downstream process (it has no downstream process)', () => {
  const src = CLI();
  assert.equal(/spawn|exec\(/.test(src), false); // confirms there IS no downstream process to leak the flag into
});

test('the dry-run CLI never PARSES --confirm-external (docstring prose explaining its absence is not support; that concept belongs to the preflight only)', () => {
  const dryRunSrc = readFileSync('scripts/nationwideDryRun.ts', 'utf8');
  assert.equal(/case '--confirm-external'|args\.confirmExternal\b/.test(dryRunSrc), false);
});

test('the report file is written ONLY under --report (single guarded write)', () => {
  const src = CLI();
  const writes = src.match(/writeFileSync\(/g) ?? [];
  assert.equal(writes.length, 1);
  const guardIdx = src.indexOf('if (args.report)');
  const writeIdx = src.indexOf('writeFileSync(');
  assert.ok(guardIdx >= 0 && writeIdx > guardIdx);
});

test('production paths remain untouched by Step 5 (no nationwide-dry-run/preflight/scope references leak into them)', () => {
  // "Nationwide rebuild Phase ..." is this codebase's standing project-header
  // convention in EVERY file — not evidence of Step 5 awareness. Check for the
  // new modules/CLI names and the reserved scope specifically instead.
  for (const file of [
    'scripts/runRaceDayPipeline.ts',
    'scripts/runRaceDayPipelineWatch.ts',
    'race-day-local/start-race-day.bat',
    'race-day-local/watch-pipeline.bat',
    'race-day-local/watch-locks.bat',
    'race-day-local/watch-results.bat',
  ]) {
    const src = readFileSync(file, 'utf8');
    assert.equal(
      /nationwideDryRun|nationwidePreflight|nationwideOwnership|nationwide:dry-run|nationwide:preflight|all-uk-ire/.test(src),
      false,
      `${file} must not reference the Step 5 nationwide modules/CLI/scope`,
    );
  }
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
