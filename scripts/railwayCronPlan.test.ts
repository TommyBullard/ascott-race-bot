/**
 * Tests for the Railway race-day automation planner + one-shot refresh helper.
 *
 * Proves: the cron plan prints the three commands on the 5-minute schedule; the
 * date resolver is deterministic; the helper runs exactly once (no loop); and the
 * new code introduces no bet-placement, no positive auto-betting language, and no
 * public UI write control.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  RACE_DAY_CRON_SCHEDULE,
  DEFAULT_RACE_DAY_COURSE,
  DEFAULT_BASE_URL,
  RACE_DAY_SAFETY_WARNINGS,
  resolveRaceDayToday,
  buildRailwayCronPlan,
  renderRailwayCronPlanText,
  parseCronPlanArgs,
  parseRefreshTodayArgs,
  buildRefreshTodayCommandArgs,
  runRefreshOnce,
} from '../src/lib/railwayCronPlan';

/* -------------------------------------------------------------------------- */
/* Date resolver — deterministic                                              */
/* -------------------------------------------------------------------------- */

test('resolveRaceDayToday: deterministic + UTC for a fixed now', () => {
  const now = new Date('2026-06-19T08:00:00Z');
  assert.equal(resolveRaceDayToday(now), '2026-06-19');
  // Same input -> same output (deterministic).
  assert.equal(resolveRaceDayToday(now), resolveRaceDayToday(now));
});

test('resolveRaceDayToday: late-UTC evening stays the UTC calendar day', () => {
  assert.equal(resolveRaceDayToday(new Date('2026-06-19T23:30:00Z')), '2026-06-19');
  assert.equal(resolveRaceDayToday(new Date('2026-06-19T00:00:00Z')), '2026-06-19');
});

test('resolveRaceDayToday: default now returns a YYYY-MM-DD string', () => {
  assert.match(resolveRaceDayToday(), /^\d{4}-\d{2}-\d{2}$/);
});

/* -------------------------------------------------------------------------- */
/* Cron plan content                                                          */
/* -------------------------------------------------------------------------- */

const fixedNow = new Date('2026-06-19T09:00:00Z');

test('buildRailwayCronPlan: defaults to today (UTC) + Ascot, three jobs', () => {
  const plan = buildRailwayCronPlan({ now: fixedNow });
  assert.equal(plan.date, '2026-06-19');
  assert.equal(plan.course, DEFAULT_RACE_DAY_COURSE);
  assert.deepEqual(
    plan.jobs.map((j) => j.id),
    ['pipeline-refresh', 't-minus-capture', 'results-auto-check'],
  );
});

test('cron plan prints the pipeline refresh command', () => {
  const text = renderRailwayCronPlanText(buildRailwayCronPlan({ date: '2026-06-19', now: fixedNow }));
  assert.match(text, /race-day:refresh-today -- --course Ascot/);
  assert.match(text, /npm run pipeline:day -- --date 2026-06-19 --course Ascot --commit/);
});

test('cron plan prints the T-minus capture command', () => {
  const text = renderRailwayCronPlanText(buildRailwayCronPlan({ now: fixedNow }));
  assert.match(text, /npm run capture:t-minus -- .*--course Ascot --minutes-before 5/);
});

test('cron plan prints the results:auto command', () => {
  const text = renderRailwayCronPlanText(buildRailwayCronPlan({ now: fixedNow }));
  assert.match(text, /npm run results:auto -- .*--course Ascot/);
});

test('cron plan uses the */5 * * * * schedule for every job', () => {
  const plan = buildRailwayCronPlan({ now: fixedNow });
  assert.equal(RACE_DAY_CRON_SCHEDULE, '*/5 * * * *');
  for (const job of plan.jobs) assert.equal(job.schedule, '*/5 * * * *');
  assert.match(renderRailwayCronPlanText(plan), /\*\/5 \* \* \* \*/);
});

test('cron plan marks only the pipeline job as a DB write', () => {
  const plan = buildRailwayCronPlan({ now: fixedNow });
  const writes = plan.jobs.filter((j) => j.writesDb).map((j) => j.id);
  assert.deepEqual(writes, ['pipeline-refresh']);
});

test('cron plan includes the public dashboard URL', () => {
  const text = renderRailwayCronPlanText(buildRailwayCronPlan({ date: '2026-06-19', now: fixedNow }));
  assert.match(text, /Public dashboard: http:\/\/localhost:3000\/\?date=2026-06-19&course=Ascot/);
});

test('cron plan quotes a multi-word course', () => {
  const plan = buildRailwayCronPlan({ course: 'Royal Ascot', now: fixedNow });
  assert.ok(plan.jobs.every((j) => j.command.includes('"Royal Ascot"')));
});

/* -------------------------------------------------------------------------- */
/* Safety: no auto-betting / no bet placement                                 */
/* -------------------------------------------------------------------------- */

const BET_PLACEMENT_RE = /placeOrder|placeBet|submitOrder|sendOrder/i;
const POSITIVE_BET_RE = /\bbet on\b|\bwill win\b|\bplace a bet\b|auto-?betting (is )?(on|enabled|active)/i;

test('no bet-placement commands appear in any cron job', () => {
  const plan = buildRailwayCronPlan({ now: fixedNow });
  for (const job of plan.jobs) {
    assert.doesNotMatch(job.command, BET_PLACEMENT_RE);
    assert.doesNotMatch(job.datePinnedCommand, BET_PLACEMENT_RE);
  }
});

test('rendered plan has only NEGATED betting language (safety disclaimers)', () => {
  const text = renderRailwayCronPlanText(buildRailwayCronPlan({ now: fixedNow }));
  // Negated safety disclaimers ARE present...
  assert.match(text, /never places bets/i);
  assert.match(text, /never enables auto-betting/i);
  // ...and no positive bet/auto-bet language or placement call is present.
  assert.doesNotMatch(text, BET_PLACEMENT_RE);
  assert.doesNotMatch(text, POSITIVE_BET_RE);
});

test('safety warnings cover read-only UI, one-shot, and no-auto-betting', () => {
  const joined = RACE_DAY_SAFETY_WARNINGS.join(' ');
  assert.match(joined, /read-only/i);
  assert.match(joined, /once and exits|one-shot/i);
  assert.match(joined, /never .*auto-betting|no auto-betting/i);
});

/* -------------------------------------------------------------------------- */
/* race-day:refresh-today — one-shot, no loop                                 */
/* -------------------------------------------------------------------------- */

test('parseRefreshTodayArgs: commit by default, --dry-run disables commit', () => {
  assert.deepEqual(parseRefreshTodayArgs([]), {
    course: 'Ascot',
    baseUrl: DEFAULT_BASE_URL,
    commit: true,
    dryRun: false,
  });
  const dry = parseRefreshTodayArgs(['--dry-run', '--course', 'Ascot']);
  assert.equal(dry.commit, false);
  assert.equal(dry.dryRun, true);
  const custom = parseRefreshTodayArgs(['--course', 'Newbury', '--base-url', 'https://app.example.com/']);
  assert.equal(custom.course, 'Newbury');
  assert.equal(custom.baseUrl, 'https://app.example.com');
});

test('buildRefreshTodayCommandArgs: adds --commit only when committing', () => {
  const withCommit = buildRefreshTodayCommandArgs({
    date: '2026-06-19',
    course: 'Ascot',
    baseUrl: 'http://localhost:3000',
    commit: true,
  });
  assert.deepEqual(withCommit, [
    '--date',
    '2026-06-19',
    '--course',
    'Ascot',
    '--base-url',
    'http://localhost:3000',
    '--commit',
  ]);
  const noCommit = buildRefreshTodayCommandArgs({
    date: '2026-06-19',
    course: 'Ascot',
    baseUrl: 'http://localhost:3000',
    commit: false,
  });
  assert.ok(!noCommit.includes('--commit'));
});

test('runRefreshOnce: spawns EXACTLY ONE command then returns (no loop)', () => {
  let calls = 0;
  let seenScript = '';
  let seenArgs: readonly string[] = [];
  const result = runRefreshOnce({
    now: fixedNow,
    course: 'Ascot',
    baseUrl: 'http://localhost:3000',
    commit: true,
    spawn: (script, npmArgs) => {
      calls += 1;
      seenScript = script;
      seenArgs = npmArgs;
      return { status: 0 };
    },
  });
  assert.equal(calls, 1); // one-shot: exactly one spawn
  assert.equal(result.ranCount, 1);
  assert.equal(result.date, '2026-06-19');
  assert.equal(seenScript, 'pipeline:day');
  assert.ok(seenArgs.includes('--commit'));
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
});

test('runRefreshOnce: a non-zero spawn exit is reported as not-ok', () => {
  const result = runRefreshOnce({
    now: fixedNow,
    course: 'Ascot',
    baseUrl: 'http://localhost:3000',
    commit: false,
    spawn: () => ({ status: 2 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.ok(!result.command.includes('--commit'));
});

test('parseCronPlanArgs: parses date/course/base-url/minutes-before', () => {
  const a = parseCronPlanArgs(['--date', '2026-06-19', '--course', 'Ascot', '--minutes-before', '10']);
  assert.equal(a.date, '2026-06-19');
  assert.equal(a.course, 'Ascot');
  assert.equal(a.minutesBefore, 10);
  // Invalid date is ignored (falls back to today downstream).
  assert.equal(parseCronPlanArgs(['--date', '19-06-2026']).date, undefined);
});

/* -------------------------------------------------------------------------- */
/* Source scans — no loops, no bet placement, no public UI write control      */
/* -------------------------------------------------------------------------- */

const LIB_SRC = readFileSync('src/lib/railwayCronPlan.ts', 'utf8');
const PLAN_CLI_SRC = readFileSync('scripts/railwayCronPlan.ts', 'utf8');
const REFRESH_CLI_SRC = readFileSync('scripts/raceDayRefreshToday.ts', 'utf8');
const ALL_NEW_SRC = `${LIB_SRC}\n${PLAN_CLI_SRC}\n${REFRESH_CLI_SRC}`;

test('source: helper has no infinite loop / timer (one-shot only)', () => {
  // Match actual timer/loop CALLS, not prose mentions (the lib documents "no
  // setInterval" etc.), so require the call paren / infinite-for form.
  const LOOP_RE = /setInterval\s*\(|setTimeout\s*\(|while\s*\(|for\s*\(\s*;;/;
  assert.doesNotMatch(LIB_SRC, LOOP_RE);
  assert.doesNotMatch(REFRESH_CLI_SRC, LOOP_RE);
});

test('source: no bet-placement call tokens in the new code', () => {
  assert.doesNotMatch(ALL_NEW_SRC, BET_PLACEMENT_RE);
});

test('source: introduces no public UI write control', () => {
  const UI_WRITE_RE = /<button|onClick=|<form|NEXT_PUBLIC|method:\s*['"]POST/;
  assert.doesNotMatch(ALL_NEW_SRC, UI_WRITE_RE);
});

test('source: the read-only planner CLI performs no DB writes / spawns', () => {
  assert.doesNotMatch(PLAN_CLI_SRC, /supabaseAdmin|\.insert\(|\.update\(|\.upsert\(|\.delete\(|spawnSync|spawn\(/);
});
