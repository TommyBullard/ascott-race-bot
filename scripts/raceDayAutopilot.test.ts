/**
 * Unit tests for the pure race-day autopilot helpers (src/lib/raceDayAutopilot.ts)
 * and read-only / offline guards for the CLI (scripts/raceDayAutopilot.ts).
 *
 * No DB, no network, no secrets, no real child processes: a fake runner exercises
 * the read-only orchestration, and source scans prove the autopilot performs no
 * DB writes, makes no direct external API call, and never references the forbidden
 * model / pipeline / --commit commands. Expected report paths are cross-checked
 * against the project's real report-path builders so they cannot drift. Run with:
 *   npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseAutopilotArgs,
  buildAutopilotPlan,
  renderAutopilotPlanMarkdown,
  assertReadonlyCommand,
  runReadonlyPlan,
  buildSpawnArgs,
  quoteSpawnArg,
  formatCommandInvocation,
  isValidIsoDate,
  READONLY_COMMAND_IDS,
  DEFAULT_MINUTES_BEFORE,
  type PlannedCommand,
  type CommandResult,
} from '../src/lib/raceDayAutopilot';

import { buildPreOffSnapshotPath } from '../src/lib/preOffSnapshot';
import { buildTMinusCapturePath } from '../src/lib/tMinusCapture';
import { buildDayReportPath } from '../src/lib/dayReport';
import { buildTipsterAuditPath } from '../src/lib/tipsterAudit';
import { buildConfidenceAuditPath } from '../src/lib/confidenceDiagnostics';
import { buildGateAuditPath } from '../src/lib/noBetGateAudit';

const PLAN_INPUT = { date: '2026-06-16', course: 'Ascot', mode: 'plan-only' as const, minutesBefore: 5 };

function cmd(over: Partial<PlannedCommand> = {}): PlannedCommand {
  return { id: 'report:day', script: 'report:day', args: ['--date', '2026-06-16'], readonly: true, ...over };
}

/* ------------------------------- arg parsing ------------------------------ */

test('parseAutopilotArgs: parses date, course, minutes-before; defaults to plan-only', () => {
  const a = parseAutopilotArgs(['--date', '2026-06-16', '--course', 'Ascot', '--minutes-before', '10']);
  assert.equal(a.date, '2026-06-16');
  assert.equal(a.course, 'Ascot');
  assert.equal(a.minutesBefore, 10);
  assert.equal(a.mode, 'plan-only');
  assert.deepEqual(a.errors, []);
});

test('parseAutopilotArgs: minutes-before defaults to 5 when omitted', () => {
  const a = parseAutopilotArgs(['--date', '2026-06-16', '--course', 'Ascot']);
  assert.equal(a.minutesBefore, DEFAULT_MINUTES_BEFORE);
});

test('parseAutopilotArgs: --run-readonly is recognised', () => {
  const a = parseAutopilotArgs(['--date', '2026-06-16', '--course', 'Ascot', '--run-readonly']);
  assert.equal(a.mode, 'run-readonly');
  assert.deepEqual(a.errors, []);
});

test('parseAutopilotArgs: rejects invalid / missing dates', () => {
  assert.ok(parseAutopilotArgs(['--course', 'Ascot']).errors.length > 0); // missing
  assert.ok(parseAutopilotArgs(['--date', '2026-13-40']).errors.some((e) => /Invalid --date/.test(e)));
  assert.ok(parseAutopilotArgs(['--date', '2026-02-30']).errors.some((e) => /Invalid --date/.test(e))); // not a real day
  assert.ok(parseAutopilotArgs(['--date', '06-16-2026']).errors.some((e) => /Invalid --date/.test(e)));
});

test('parseAutopilotArgs: rejects invalid minutes-before', () => {
  for (const bad of ['0', '-5', 'abc', '5.5', '']) {
    const a = parseAutopilotArgs(['--date', '2026-06-16', '--minutes-before', bad]);
    assert.ok(a.errors.some((e) => /Invalid --minutes-before/.test(e)), `expected reject for "${bad}"`);
  }
});

test('isValidIsoDate: strict calendar validation', () => {
  assert.equal(isValidIsoDate('2026-06-16'), true);
  assert.equal(isValidIsoDate('2026-02-30'), false);
  assert.equal(isValidIsoDate('2026-13-01'), false);
  assert.equal(isValidIsoDate('2026-6-1'), false);
});

/* --------------------------------- plan ----------------------------------- */

test('buildAutopilotPlan: run-list contains ONLY the whitelisted read-only commands, in order', () => {
  const plan = buildAutopilotPlan(PLAN_INPUT);
  assert.deepEqual(plan.commands.map((c) => c.id), [...READONLY_COMMAND_IDS]);
  for (const c of plan.commands) {
    assert.ok((READONLY_COMMAND_IDS as readonly string[]).includes(c.id));
    assert.equal(c.readonly, true);
  }
});

test('buildAutopilotPlan: run-list excludes forbidden commands and never passes --commit', () => {
  const plan = buildAutopilotPlan(PLAN_INPUT);
  const runIds = plan.commands.map((c) => c.id) as string[];
  for (const forbidden of ['pipeline:day', 'pipeline:watch', 'model:day', 'run:model', 'import:results']) {
    assert.equal(runIds.includes(forbidden), false);
  }
  assert.equal(
    plan.commands.some((c) => c.args.some((a) => a.toLowerCase() === '--commit')),
    false,
  );
});

test('buildAutopilotPlan: never-run list documents pipeline/model/--commit/import:results --commit', () => {
  const plan = buildAutopilotPlan(PLAN_INPUT);
  const neverText = plan.neverRun.map((n) => n.command).join(' | ');
  assert.match(neverText, /pipeline:day/);
  assert.match(neverText, /pipeline:watch/);
  assert.match(neverText, /model:day/);
  assert.match(neverText, /--commit/);
  assert.match(neverText, /import:results --commit/);
});

test('buildAutopilotPlan: capture:t-minus carries the minutes-before target', () => {
  const plan = buildAutopilotPlan({ ...PLAN_INPUT, minutesBefore: 7 });
  const tminus = plan.commands.find((c) => c.id === 'capture:t-minus')!;
  assert.deepEqual(tminus.args, ['--date', '2026-06-16', '--course', 'Ascot', '--minutes-before', '7']);
});

test('buildAutopilotPlan: manual results fallback is rendered with the slugged path', () => {
  const plan = buildAutopilotPlan(PLAN_INPUT);
  assert.equal(plan.manualResultsFallback, 'npm run import:results -- --file data/results-2026-06-16-ascot.csv');
});

test('buildAutopilotPlan: expected report paths match the real builders (no drift) and are deterministic', () => {
  const plan = buildAutopilotPlan(PLAN_INPUT);
  assert.deepEqual(plan.expectedReports, [
    buildPreOffSnapshotPath('2026-06-16', 'Ascot'),
    buildTMinusCapturePath('2026-06-16', 5, 'Ascot'),
    buildDayReportPath('2026-06-16', 'Ascot'),
    buildTipsterAuditPath('2026-06-16', 'Ascot'),
    buildConfidenceAuditPath('2026-06-16', 'Ascot'),
    buildGateAuditPath('2026-06-16', 'Ascot'),
  ]);
  // deterministic
  assert.deepEqual(buildAutopilotPlan(PLAN_INPUT), plan);
});

test('buildAutopilotPlan: course omitted -> em dash, no slug in paths', () => {
  const plan = buildAutopilotPlan({ date: '2026-06-16', mode: 'plan-only', minutesBefore: 5 });
  assert.equal(plan.course, null);
  assert.equal(plan.expectedReports[0], 'reports/pre-off-snapshot-2026-06-16.md');
  assert.equal(plan.manualResultsFallback, 'npm run import:results -- --file data/results-2026-06-16.csv');
  assert.match(renderAutopilotPlanMarkdown(plan), /Course: \u2014/);
});

/* ------------------------------- rendering -------------------------------- */

test('renderAutopilotPlanMarkdown: deterministic + covers the required plan sections', () => {
  const plan = buildAutopilotPlan(PLAN_INPUT);
  const md = renderAutopilotPlanMarkdown(plan);
  assert.equal(md, renderAutopilotPlanMarkdown(plan)); // deterministic (no timestamps)
  for (const heading of [
    '## 1. Date and course',
    '## 2. Mode',
    '## 3. Safe command checklist',
    '## 4. Commands it would run',
    '## 5. Commands it will never run',
    '## 6. T-minus capture target',
    '## 7. Results automation status',
    '## 8. Manual results fallback',
    '## 9. Expected report outputs',
    '## 10. Safety disclaimer',
  ]) {
    assert.ok(md.includes(heading), `missing heading: ${heading}`);
  }
  // results:auto dry-run/fallback status is surfaced
  assert.match(md, /dry-run \/ fallback only/i);
  // manual fallback + minutes-before default surfaced
  assert.ok(md.includes(plan.manualResultsFallback));
  assert.match(md, /minutes-before = 5 \(default 5\)/);
  // decision-support disclaimer
  assert.match(md, /Decision-support only/);
  assert.match(md, /No auto-betting/);
});

test('renderAutopilotPlanMarkdown: the rendered run-list contains no forbidden command and no --commit', () => {
  const md = renderAutopilotPlanMarkdown(buildAutopilotPlan(PLAN_INPUT));
  const wouldRun = md.split('## 4. Commands it would run')[1].split('## 5.')[0];
  for (const forbidden of ['pipeline:day', 'pipeline:watch', 'model:day', '--commit']) {
    assert.equal(wouldRun.includes(forbidden), false, `run-list must not include ${forbidden}`);
  }
});

/* ----------------------- safety gate + run orchestration ------------------ */

test('assertReadonlyCommand: allows whitelisted; rejects non-whitelisted, forbidden, and --commit', () => {
  assert.doesNotThrow(() => assertReadonlyCommand(cmd()));
  assert.throws(() => assertReadonlyCommand(cmd({ id: 'model:day' as never, script: 'model:day' })), /non-whitelisted/);
  assert.throws(() => assertReadonlyCommand(cmd({ id: 'pipeline:day' as never, script: 'pipeline:day' })), /non-whitelisted/);
  assert.throws(() => assertReadonlyCommand(cmd({ args: ['--date', '2026-06-16', '--commit'] })), /--commit/);
});

test('buildSpawnArgs: npm run <script> -- <args>', () => {
  assert.deepEqual(buildSpawnArgs(cmd({ args: ['--date', '2026-06-16', '--course', 'Ascot'] })), [
    'run',
    'report:day',
    '--',
    '--date',
    '2026-06-16',
    '--course',
    'Ascot',
  ]);
});

test('quoteSpawnArg: leaves simple tokens; quotes whitespace/metacharacters; strips embedded quotes', () => {
  // simple, safe tokens are untouched
  for (const safe of ['--date', '2026-06-16', 'results:auto', 'Ascot', '--', '5']) {
    assert.equal(quoteSpawnArg(safe), safe);
  }
  // multi-word course is wrapped so shell:true keeps it one token
  assert.equal(quoteSpawnArg('Royal Ascot'), '"Royal Ascot"');
  // shell metacharacters are neutralised by quoting (no injection)
  assert.equal(quoteSpawnArg('Ascot&del'), '"Ascot&del"');
  // an embedded double quote (breakout vector) is removed
  assert.equal(quoteSpawnArg('a"b c'), '"ab c"');
  // empty -> explicit empty token
  assert.equal(quoteSpawnArg(''), '""');
});

test('formatCommandInvocation: copy-pasteable npm invocation', () => {
  assert.equal(
    formatCommandInvocation(cmd({ args: ['--date', '2026-06-16', '--course', 'Ascot'] })),
    'npm run report:day -- --date 2026-06-16 --course Ascot',
  );
});

test('runReadonlyPlan: runs every command via the INJECTED runner (no real exec) when all succeed', () => {
  const plan = buildAutopilotPlan(PLAN_INPUT);
  const calls: string[] = [];
  const fakeRunner = (c: PlannedCommand): CommandResult => {
    calls.push(c.id);
    return { id: c.id, ok: true, exitCode: 0 };
  };
  const outcome = runReadonlyPlan(plan, fakeRunner);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.stoppedAt, null);
  assert.deepEqual(calls, [...READONLY_COMMAND_IDS]);
  assert.equal(outcome.results.length, READONLY_COMMAND_IDS.length);
});

test('runReadonlyPlan: stops at the first failure; later commands are NOT run', () => {
  const plan = buildAutopilotPlan(PLAN_INPUT);
  const calls: string[] = [];
  const fakeRunner = (c: PlannedCommand): CommandResult => {
    calls.push(c.id);
    return { id: c.id, ok: c.id !== 'capture:t-minus', exitCode: c.id !== 'capture:t-minus' ? 0 : 1 };
  };
  const outcome = runReadonlyPlan(plan, fakeRunner);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stoppedAt, 'capture:t-minus');
  assert.deepEqual(calls, ['results:auto', 'snapshot:pre-off', 'capture:t-minus']); // stopped, no report:day onward
});

/* --------------------- offline / no-DB / no-API guards -------------------- */

test('no DB writes / no direct external API: the autopilot lib + script are offline', () => {
  const lib = readFileSync('src/lib/raceDayAutopilot.ts', 'utf8');
  const script = readFileSync('scripts/raceDayAutopilot.ts', 'utf8');
  for (const source of [lib, script]) {
    assert.equal(/supabaseAdmin/.test(source), false);
    assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(source), false);
    assert.equal(/createRacingApiClient|BetfairClient|axios|getResults|\bfetch\s*\(/.test(source), false);
  }
  // The pure lib does no I/O at all.
  assert.equal(/node:fs|node:child_process|process\.env/.test(lib), false);
});

test('the CLI script never hardcodes a forbidden model/pipeline command or --commit', () => {
  const script = readFileSync('scripts/raceDayAutopilot.ts', 'utf8');
  for (const forbidden of ['pipeline:day', 'pipeline:watch', 'model:day', '--commit']) {
    assert.equal(script.includes(forbidden), false, `script must not reference ${forbidden}`);
  }
});
