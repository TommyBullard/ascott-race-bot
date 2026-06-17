/**
 * Unit tests for the pure controlled race-day operate helpers
 * (src/lib/raceDayOperate.ts) and read-only / no-exec guards for the CLI
 * (scripts/raceDayOperate.ts).
 *
 * No DB, no network, no child processes: synthetic race rows exercise the
 * schedule arithmetic, command plan, the injected-runner seam (with a FAKE
 * runner only), and the deterministic Markdown. Source scans prove the operator
 * performs no DB writes, makes no external API call, spawns no child command,
 * never hardcodes a commit flag, and never auto-executes a write/approval
 * command. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseOperateArgs,
  isValidIsoDate,
  hhmmUtc,
  buildRaceOperateWindow,
  buildOperatePlan,
  buildDashboardUrl,
  isAutoRunnable,
  collectPlanCommands,
  simulateReadOnlyRun,
  renderOperatePlanMarkdown,
  REFRESH_OFFSET_MIN,
  PIPELINE_REFRESH_OFFSET_MIN,
  CAPTURE_OFFSET_MIN,
  RESULT_CHECK_OFFSET_MIN,
  NO_RACES_WARNING,
  FUTURE_FLAGS,
  type OperateRaceInput,
  type OperateCommand,
  type OperateRunner,
  type OperateStepResult,
} from '../src/lib/raceDayOperate';

const RACES: OperateRaceInput[] = [
  { id: 'r2', race_name: 'Second Race', off_time: '2026-06-17T14:05:00.000Z', course: 'Ascot', status: null },
  { id: 'r1', race_name: 'First Race', off_time: '2026-06-17T13:30:00.000Z', course: 'Ascot', status: null },
];

// A fixed "now" well before the first off, so the next action is deterministic.
const NOW = Date.parse('2026-06-17T10:00:00.000Z');

function plan(over: Partial<Parameters<typeof buildOperatePlan>[0]> = {}) {
  return buildOperatePlan({ date: '2026-06-17', course: 'Ascot', races: RACES, now: NOW, ...over });
}

/* ------------------------------- arg parsing ------------------------------ */

test('parseOperateArgs: default mode is plan-only (nothing can switch it)', () => {
  const a = parseOperateArgs(['--date', '2026-06-17', '--course', 'Ascot']);
  assert.equal(a.mode, 'plan-only');
  assert.equal(a.date, '2026-06-17');
  assert.equal(a.course, 'Ascot');
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.requestedFutureFlags, []);
});

test('parseOperateArgs: rejects missing / invalid dates', () => {
  assert.ok(parseOperateArgs(['--course', 'Ascot']).errors.length > 0);
  assert.ok(parseOperateArgs(['--date', '2026-13-40']).errors.some((e) => /Invalid --date/.test(e)));
  assert.ok(parseOperateArgs(['--date', '2026-02-30']).errors.some((e) => /Invalid --date/.test(e)));
});

test('parseOperateArgs: future flags are captured (inert), stay plan-only, values consumed', () => {
  const a = parseOperateArgs([
    '--date', '2026-06-17',
    '--allow-pipeline-writes',
    '--allow-result-commit',
    '--run-once-readonly',
    '--watch',
    '--minutes-before', '5',
    '--stop-after-race', '14:05',
  ]);
  assert.equal(a.mode, 'plan-only');
  assert.deepEqual(a.errors, []);
  assert.deepEqual(
    [...a.requestedFutureFlags].sort(),
    ['--allow-pipeline-writes', '--allow-result-commit', '--minutes-before', '--run-once-readonly', '--stop-after-race', '--watch'],
  );
  // The consumed values ("5", "14:05") must not be misparsed as a date/course.
  assert.equal(a.course, undefined);
});

test('isValidIsoDate: strict calendar validation', () => {
  assert.equal(isValidIsoDate('2026-06-17'), true);
  assert.equal(isValidIsoDate('2026-02-30'), false);
  assert.equal(isValidIsoDate('2026-6-1'), false);
});

/* ------------------------------- schedule --------------------------------- */

test('schedule offsets are T-15 / T-7 / T-5 / +30', () => {
  assert.equal(REFRESH_OFFSET_MIN, 15);
  assert.equal(PIPELINE_REFRESH_OFFSET_MIN, 7);
  assert.equal(CAPTURE_OFFSET_MIN, 5);
  assert.equal(RESULT_CHECK_OFFSET_MIN, 30);
});

test('hhmmUtc: formats UTC HH:mm with a minute offset; null for missing/invalid', () => {
  assert.equal(hhmmUtc('2026-06-17T15:00:00.000Z'), '15:00');
  assert.equal(hhmmUtc('2026-06-17T15:00:00.000Z', -15), '14:45');
  assert.equal(hhmmUtc('2026-06-17T15:00:00.000Z', 30), '15:30');
  assert.equal(hhmmUtc(null), null);
  assert.equal(hhmmUtc('not-a-date'), null);
});

test('buildRaceOperateWindow: all windows correct (T-15/T-7/T-5/off/+30)', () => {
  const w = buildRaceOperateWindow({ id: 'r1', race_name: 'First', off_time: '2026-06-17T15:00:00.000Z' });
  assert.equal(w.off_hhmm, '15:00');
  assert.equal(w.refresh_hhmm, '14:45'); // T-15
  assert.equal(w.pipeline_refresh_hhmm, '14:53'); // T-7
  assert.equal(w.capture_hhmm, '14:55'); // T-5
  assert.equal(w.post_off_lock_hhmm, '15:00');
  assert.equal(w.result_check_hhmm, '15:30'); // off + 30
});

test('buildRaceOperateWindow: missing off_time -> all windows null (never fabricated)', () => {
  const w = buildRaceOperateWindow({ id: 'r1', race_name: 'First', off_time: null });
  assert.equal(w.off_hhmm, null);
  assert.equal(w.refresh_hhmm, null);
  assert.equal(w.pipeline_refresh_hhmm, null);
  assert.equal(w.capture_hhmm, null);
  assert.equal(w.result_check_hhmm, null);
});

test('buildOperatePlan: races sorted by off time ascending; mode plan-only', () => {
  const p = plan();
  assert.deepEqual(p.races.map((r) => r.race_name), ['First Race', 'Second Race']);
  assert.equal(p.mode, 'plan-only');
});

test('buildDashboardUrl: read-only dashboard URL with date + course', () => {
  assert.equal(buildDashboardUrl('2026-06-17', 'Ascot'), 'http://localhost:3000/?date=2026-06-17&course=Ascot');
  assert.equal(buildDashboardUrl('2026-06-17', null), 'http://localhost:3000/?date=2026-06-17');
});

test('buildOperatePlan: dashboard reminders are read-only (URL + status API)', () => {
  const p = plan();
  assert.equal(p.dashboardUrl, 'http://localhost:3000/?date=2026-06-17&course=Ascot');
  assert.match(p.dashboardNote, /no commit or write controls/i);
  assert.match(p.statusApiNote, /\/api\/race-day\/status/);
  assert.match(p.statusApiNote, /read-only/i);
});

/* ------------------------------ command plan ------------------------------ */

test('buildOperatePlan: preflight is check:env + check:db (read-only)', () => {
  const p = plan();
  const cmds = p.preflight.map((c) => c.command);
  assert.ok(cmds.some((c) => c.startsWith('npm run check:env')));
  assert.ok(cmds.some((c) => c.startsWith('npm run check:db')));
  assert.ok(p.preflight.every(isAutoRunnable));
});

test('buildOperatePlan: pipeline refresh is manual-approval / writes DB only', () => {
  const p = plan();
  const pipeline = p.perRaceCommands.find((c) => c.command.includes('pipeline:day'));
  assert.ok(pipeline);
  assert.equal(pipeline!.writesDb, true);
  assert.equal(pipeline!.requiresApproval, true);
  assert.ok(pipeline!.command.includes('--commit')); // documented as the write step
});

test('buildOperatePlan: capture:t-minus is present and read-only', () => {
  const p = plan();
  const capture = p.perRaceCommands.find((c) => c.command.includes('capture:t-minus'));
  assert.ok(capture);
  assert.equal(isAutoRunnable(capture!), true);
  assert.match(capture!.command, /--minutes-before 5/);
});

test('buildOperatePlan: settlement has results:auto dry-run first, then commit as manual-only', () => {
  const p = plan();
  assert.equal(p.settlement.length, 2);
  const dry = p.settlement[0];
  const commit = p.settlement[1];
  assert.equal(dry.command, 'npm run results:auto -- --date 2026-06-17 --course Ascot');
  assert.equal(isAutoRunnable(dry), true);
  assert.ok(commit.command.includes('results:auto') && commit.command.includes('--commit'));
  assert.equal(commit.writesDb, true);
  assert.equal(commit.requiresApproval, true);
  assert.match(p.pendingRacesNote, /Pending .*left untouched/i);
});

test('buildOperatePlan: end-of-day includes every reporting command', () => {
  const cmds = plan().endOfDay.map((c) => c.command);
  for (const script of [
    'report:day', 'export:training-data', 'tipsters:audit', 'confidence:audit',
    'gates:audit', 'place:audit', 'lessons:day', 'ml:evaluate',
  ]) {
    assert.ok(cmds.some((c) => c.includes(`npm run ${script}`)), `missing end-of-day command: ${script}`);
  }
  assert.ok(plan().endOfDay.every(isAutoRunnable));
});

test('safety: every command carrying the commit flag requires approval; safe sections have none', () => {
  const p = plan();
  for (const c of collectPlanCommands(p)) {
    if (c.command.includes('--commit')) assert.equal(c.requiresApproval, true);
  }
  // preflight + end-of-day are the routinely-run sections: none may carry --commit
  for (const c of [...p.preflight, ...p.endOfDay]) {
    assert.equal(c.command.includes('--commit'), false);
  }
  // exactly two write/approval commands: the pipeline refresh + the settlement commit
  const writes = collectPlanCommands(p).filter((c) => c.writesDb || c.requiresApproval);
  assert.equal(writes.length, 2);
});

test('buildOperatePlan: future flags documented (inactive); passing them adds an inert warning', () => {
  const p = plan({ requestedFutureFlags: ['--run-once-readonly'] });
  assert.deepEqual(
    p.futureFlags.map((f) => f.flag),
    ['--allow-pipeline-writes', '--allow-result-commit', '--run-once-readonly', '--watch', '--minutes-before', '--stop-after-race'],
  );
  for (const f of FUTURE_FLAGS) assert.match(f.description, /NOT implemented in this phase/);
  assert.ok(p.warnings.some((w) => /not implemented in this phase/.test(w)));
});

test('buildOperatePlan: empty race list yields the no-races warning (never fabricated)', () => {
  const p = plan({ races: [] });
  assert.ok(p.warnings.includes(NO_RACES_WARNING));
  assert.equal(p.races.length, 0);
});

/* --------------------------- injected runner seam ------------------------- */

test('simulateReadOnlyRun: a FAKE runner only ever sees read-only commands', () => {
  const p = plan();
  const seen: string[] = [];
  const fakeRunner: OperateRunner = (cmd: OperateCommand): OperateStepResult => {
    seen.push(cmd.command);
    return { label: cmd.label, command: cmd.command, status: 'ok' };
  };

  const report = simulateReadOnlyRun(p, fakeRunner);

  const autoRunnable = collectPlanCommands(p).filter(isAutoRunnable);
  assert.equal(report.executed.length, autoRunnable.length);
  assert.equal(seen.length, autoRunnable.length);
  // Nothing the fake runner saw carries the commit flag or writes the DB.
  for (const cmd of seen) assert.equal(cmd.includes('--commit'), false);
  assert.ok(report.executed.every((r) => r.status === 'ok'));
});

test('simulateReadOnlyRun: write/approval commands are skipped, never auto-executed', () => {
  const p = plan();
  let commitSeen = false;
  const fakeRunner: OperateRunner = (cmd: OperateCommand): OperateStepResult => {
    if (cmd.command.includes('--commit')) commitSeen = true;
    return { label: cmd.label, command: cmd.command, status: 'ok' };
  };

  const report = simulateReadOnlyRun(p, fakeRunner);

  assert.equal(commitSeen, false); // the runner is NEVER handed a commit command
  assert.equal(report.skipped.length, 2);
  for (const s of report.skipped) assert.equal(s.status, 'skipped');
  const skippedCmds = report.skipped.map((s) => s.command);
  assert.ok(skippedCmds.some((c) => c.includes('pipeline:day') && c.includes('--commit')));
  assert.ok(skippedCmds.some((c) => c.includes('results:auto') && c.includes('--commit')));
});

/* -------------------------------- rendering ------------------------------- */

test('renderOperatePlanMarkdown: deterministic + covers all required sections', () => {
  const p = plan();
  const md = renderOperatePlanMarkdown(p);
  assert.equal(md, renderOperatePlanMarkdown(p)); // deterministic (no wall clock)
  for (const heading of [
    '## Current next action',
    '## 1. Preflight',
    '## 2. Per-race schedule (UTC)',
    '## 3. Per-race operator commands',
    '## 4. Result settlement',
    '## 5. End of day',
    '## 6. Dashboard',
    '## 7. Future flags (documented, NOT active in this phase)',
    '## 8. Safety',
  ]) {
    assert.ok(md.includes(heading), `missing heading: ${heading}`);
  }
  // schedule windows for the first race (off 13:30): T-15 13:15, T-7 13:23, T-5 13:25
  assert.match(md, /13:15 \| 13:23 \| 13:25/);
  // dashboard URL + plan-only + commit step flagged
  assert.ok(md.includes('http://localhost:3000/?date=2026-06-17&course=Ascot'));
  assert.match(md, /Mode: plan-only/);
  assert.match(md, /MANUAL APPROVAL — WRITES DB/);
  // dashboard reminds the operator the status polling endpoint is read-only
  assert.match(md, /\/api\/race-day\/status.*read-only/i);
  // safety disclaimers (negated betting language only)
  assert.match(md, /No auto-betting and no bet placement/);
  assert.match(md, /No GenAI winner prediction/);
});

test('renderOperatePlanMarkdown: empty races -> warning + em-dash schedule, still deterministic', () => {
  const p = plan({ races: [] });
  const md = renderOperatePlanMarkdown(p);
  assert.equal(md, renderOperatePlanMarkdown(p));
  assert.ok(md.includes(NO_RACES_WARNING));
});

/* --------------------- offline / no-DB / no-exec guards ------------------- */

test('the operate lib is pure (only depends on operatorNextAction/raceDayStatus; no I/O, no exec, no commit literal)', () => {
  const lib = readFileSync('src/lib/raceDayOperate.ts', 'utf8');
  // Every import must resolve to the two reused pure helpers — nothing else.
  const importSources = lib.match(/from\s+'[^']+'/g) ?? [];
  assert.ok(importSources.length > 0);
  for (const src of importSources) {
    assert.match(src, /'\.\/(operatorNextAction|raceDayStatus)'/);
  }
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(lib), false);
  assert.equal(/createRacingApiClient|BetfairClient|axios|getResults|\bfetch\s*\(/.test(lib), false);
  assert.equal(/child_process|spawnSync|\bspawn\s*\(|execSync|\bexec\s*\(/.test(lib), false);
  assert.equal(/supabaseAdmin|node:fs|process\.env/.test(lib), false);
  assert.equal(/bettingEngine|modelProbabilities|kellyStake|scoreRaceRunners|runModelForRace/.test(lib), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/i.test(lib), false);
  // The literal commit flag never appears in source (it is constructed at runtime).
  assert.equal(/--commit/.test(lib), false);
});

test('the operate CLI is read-only (select-only, no exec, no commit literal, never invokes the runner)', () => {
  const cli = readFileSync('scripts/raceDayOperate.ts', 'utf8');
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(cli), false);
  assert.equal(/child_process|spawnSync|\bspawn\s*\(|execSync|\bexec\s*\(/.test(cli), false);
  assert.equal(/createRacingApiClient|BetfairClient|axios|getResults|\bfetch\s*\(/.test(cli), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder|runModelForRace|kellyStake|bettingEngine/i.test(cli), false);
  assert.equal(/--commit/.test(cli), false); // CLI hardcodes no commit flag of its own
  // Default mode executes nothing: the CLI never drives the runner seam.
  assert.equal(/simulateReadOnlyRun/.test(cli), false);
  // It reads through a read-only SELECT only.
  assert.match(cli, /\.select\(/);
});
