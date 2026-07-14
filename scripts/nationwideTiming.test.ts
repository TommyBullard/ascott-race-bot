/**
 * Tests for the nationwide dry-run TIMING harness (src/lib/nationwideTiming.ts
 * + the SELECT-only CLI) — Nationwide rebuild Phase 7A.2a.
 *
 * Proves the pure aggregation (reconciliation, duration stats, verdict
 * thresholds, zero-scored edge case, that post-off/resulted races are still
 * scored rather than skipped) and — by source scan — that neither the lib nor
 * the CLI can write, run the model, create a lock, or accept --commit. Run
 * with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildNationwideTimingReport,
  renderNationwideTimingMarkdown,
  buildNationwideTimingPath,
  WATCHER_CADENCE_MS,
  REVIEW_THRESHOLD_MS,
  type NationwideTimingRaceInput,
} from '../src/lib/nationwideTiming';

/** A scored race with terse-test defaults. */
function scoredRace(over: Partial<NationwideTimingRaceInput> = {}): NationwideTimingRaceInput {
  return {
    race_id: 'r1',
    course_label: 'Newmarket',
    off_time: '2026-07-11T14:00:00.000Z',
    status: null,
    runner_count: 10,
    duration_ms: 100,
    scored: true,
    skip_reason: null,
    error: null,
    ...over,
  };
}

function skippedRace(reason: NationwideTimingRaceInput['skip_reason'], over: Partial<NationwideTimingRaceInput> = {}): NationwideTimingRaceInput {
  return {
    race_id: 'r-skip',
    course_label: 'Newmarket',
    off_time: '2026-07-11T14:00:00.000Z',
    status: null,
    runner_count: 0,
    duration_ms: null,
    scored: false,
    skip_reason: reason,
    error: null,
    ...over,
  };
}

function failedRace(over: Partial<NationwideTimingRaceInput> = {}): NationwideTimingRaceInput {
  return {
    race_id: 'r-fail',
    course_label: 'Newmarket',
    off_time: '2026-07-11T14:00:00.000Z',
    status: null,
    runner_count: 0,
    duration_ms: null,
    scored: false,
    skip_reason: null,
    error: 'boom',
    ...over,
  };
}

test('reconciles races_considered = scored + skipped(no_priced_field) + failed', () => {
  const races = [
    scoredRace({ race_id: 'a' }),
    skippedRace('NO_PRICED_FIELD', { race_id: 'b' }),
    failedRace({ race_id: 'c' }),
  ];
  const report = buildNationwideTimingReport('2026-07-11', races);
  assert.equal(report.races_considered, 3);
  assert.equal(report.races_scored, 1);
  assert.equal(report.races_skipped_no_priced_field, 1);
  assert.equal(report.races_failed, 1);
  assert.deepEqual(report.invariant_violations, []);
});

test('a post-off or resulted race is still scored (not skipped) — this harness never writes', () => {
  // Unlike the production model-run guard, the timing harness has no reason
  // to skip an already-off/resulted race: it never persists anything, so the
  // write-safety concern that guard exists for cannot apply here, and
  // retrospective measurement against completed race days depends on scoring
  // every race regardless of off status.
  const races = [scoredRace({ race_id: 'a', status: 'result', off_time: '2020-01-01T00:00:00.000Z' })];
  const report = buildNationwideTimingReport('2026-07-11', races);
  assert.equal(report.races_scored, 1);
});

test('duration stats: total/min/mean/median/p95/max computed correctly on a fixed fixture', () => {
  const durations = [10, 20, 30, 40, 100];
  const races = durations.map((d, i) => scoredRace({ race_id: `r${i}`, duration_ms: d }));
  const report = buildNationwideTimingReport('2026-07-11', races);
  assert.ok(report.duration);
  const d = report.duration!;
  assert.equal(d.total_ms, 200);
  assert.equal(d.min_ms, 10);
  assert.equal(d.max_ms, 100);
  assert.equal(d.mean_ms, 40);
  assert.equal(d.median_ms, 30);
  // p95 of [10,20,30,40,100] (nearest-rank, ceil(0.95*5)=5) -> the max.
  assert.equal(d.p95_ms, 100);
  assert.equal(d.slowest_race_id, 'r4');
  assert.equal(report.runners_scored, durations.length * 10);
});

test('zero scored races -> duration is null (never a fabricated zero)', () => {
  const races = [skippedRace('NO_PRICED_FIELD'), failedRace()];
  const report = buildNationwideTimingReport('2026-07-11', races);
  assert.equal(report.duration, null);
  assert.equal(report.margin_ms, null);
  assert.equal(report.runners_scored, 0);
});

test('verdict PASS: total_ms below the REVIEW threshold, no failures/skips', () => {
  const races = [scoredRace({ duration_ms: REVIEW_THRESHOLD_MS - 1000 })];
  const report = buildNationwideTimingReport('2026-07-11', races);
  assert.equal(report.verdict, 'PASS');
});

test('verdict REVIEW: total_ms at/above the REVIEW threshold but below cadence', () => {
  const races = [scoredRace({ duration_ms: REVIEW_THRESHOLD_MS })];
  const report = buildNationwideTimingReport('2026-07-11', races);
  assert.equal(report.verdict, 'REVIEW');
});

test('verdict REVIEW: any isolated failure forces REVIEW even with fast timing', () => {
  const races = [scoredRace({ duration_ms: 100 }), failedRace()];
  const report = buildNationwideTimingReport('2026-07-11', races);
  assert.equal(report.verdict, 'REVIEW');
  assert.ok(report.verdict_reasons.some((r) => /failure/.test(r)));
});

test('verdict REVIEW: any skip (no-priced-field) forces REVIEW even with fast timing', () => {
  const races = [scoredRace({ duration_ms: 100 }), skippedRace('NO_PRICED_FIELD')];
  const report = buildNationwideTimingReport('2026-07-11', races);
  assert.equal(report.verdict, 'REVIEW');
});

test('verdict FAIL: total_ms meets/exceeds the watcher cadence', () => {
  const races = [scoredRace({ duration_ms: WATCHER_CADENCE_MS })];
  const report = buildNationwideTimingReport('2026-07-11', races);
  assert.equal(report.verdict, 'FAIL');
});

test('well-formed input never produces an invariant violation', () => {
  const races = [scoredRace({ duration_ms: 1 }), skippedRace('NO_PRICED_FIELD'), failedRace()];
  const report = buildNationwideTimingReport('2026-07-11', races);
  assert.deepEqual(report.invariant_violations, []);
});

test('failures are listed verbatim, never summarised away', () => {
  const races = [failedRace({ race_id: 'x', error: 'read timeout' })];
  const report = buildNationwideTimingReport('2026-07-11', races);
  assert.deepEqual(report.failures, [{ race_id: 'x', error: 'read timeout' }]);
});

test('renderNationwideTimingMarkdown is deterministic and states the no-write guarantee', () => {
  const report = buildNationwideTimingReport('2026-07-11', [scoredRace({ duration_ms: 50 })]);
  const a = renderNationwideTimingMarkdown(report, 'T');
  const b = renderNationwideTimingMarkdown(report, 'T');
  assert.equal(a, b);
  assert.match(a, /READ ONLY/);
  assert.match(a, /does not enable nationwide commit mode/);
  assert.match(a, /No `--commit` flag exists/);
});

test('buildNationwideTimingPath is deterministic: reports/nationwide-timing-<date>.md', () => {
  assert.equal(buildNationwideTimingPath('2026-07-11'), 'reports/nationwide-timing-2026-07-11.md');
});

test('lib is pure: no I/O, no DB, no writes', () => {
  const src = readFileSync('src/lib/nationwideTiming.ts', 'utf8');
  assert.doesNotMatch(src, /supabaseAdmin|fetch\(|https?:\/\/|node:fs/);
  assert.doesNotMatch(src, /\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/);
  assert.doesNotMatch(src, /placeOrder|placeBet|submitOrder/i);
});

test('CLI has no --commit flag and never writes model/lock/result data', () => {
  const src = readFileSync('scripts/nationwideTiming.ts', 'utf8');
  // No argv parsing recognises a --commit flag (the doc comment mentioning the
  // ABSENCE of --commit is fine; what must never appear is code that PARSES it).
  assert.doesNotMatch(src, /args\.commit|===\s*'--commit'|parsed\.commit/);
  assert.doesNotMatch(src, /\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/);
  // The doc comments and the import path (../src/lib/runModelForRace, which
  // also exports the reused pure scoreRaceRunners/tipsterStatsFromPriors)
  // legitimately mention the name; what must never appear is an actual CALL.
  assert.doesNotMatch(src, /runModelForRace\(/);
  // The doc comment legitimately NAMES `lock:t-minus` / `locked_race_decisions`
  // (explaining they are never touched); what must never appear is an actual
  // import of the lock module or a query against that table.
  assert.doesNotMatch(src, /from ['"].*lockTMinus['"]|LOCKED_DECISIONS_TABLE|\.from\(\s*['"]locked_race_decisions['"]/);
  assert.doesNotMatch(src, /importResultsCsv|settleTodayResults|autoResults/);
  assert.doesNotMatch(src, /placeOrder|placeBet|submitOrder/i);
  // setInterval/cron/node-schedule usage, not the prose word "schedule".
  assert.doesNotMatch(src, /setInterval\(|require\(['"]node-cron['"]|cron\.schedule\(/);
  // It DOES reuse the pure scoring core and the read-only fetchers.
  assert.match(src, /scoreRaceRunners/);
  assert.match(src, /fetchRaceModelInputs/);
  // It deliberately does NOT apply the production pre-off/resulted guard —
  // this harness never writes, so that write-safety guard doesn't apply, and
  // skipping post-off/resulted races would break retrospective measurement.
  // The doc comment explaining that absence legitimately NAMES the guard
  // function; what must never appear is an actual import of it.
  assert.doesNotMatch(src, /from ['"].*modelRunGuard['"]/);
});
