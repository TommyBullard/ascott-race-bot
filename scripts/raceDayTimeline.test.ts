/**
 * Unit tests for the read-only race-day timeline module (src/lib/raceDayTimeline.ts)
 * plus read-only source-scan guards on the panel + dashboard wiring.
 *
 * The derivations are pure and deterministic given an injected `now`, so no DB /
 * network is needed. The scans lock down the task's rules: the timeline derives
 * from stored state only, never writes the DB, never calls an external API, never
 * exposes `--commit`, and never imports model/staking logic. Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  TIMELINE_WARN_STALE_ODDS,
  TIMELINE_WARN_STALE_MODEL,
  TIMELINE_WARN_NO_CAPTURE,
  TIMELINE_WARN_POST_OFF_IGNORED,
  TIMELINE_WARN_RESULT_PENDING,
  buildTimelineEntry,
  buildRaceDayTimeline,
  type TimelineInput,
} from '../src/lib/raceDayTimeline';

/** A fixed clock so every windowed derivation is deterministic. */
const NOW = Date.parse('2026-06-17T14:00:00Z');
/** Build an ISO time `mins` minutes from NOW (negative = already past). */
function offIso(minsFromNow: number): string {
  return new Date(NOW + minsFromNow * 60_000).toISOString();
}
/** Build a timeline input with sensible defaults. */
function input(over: Partial<TimelineInput> & { race_id?: string } = {}): TimelineInput {
  return { race_id: 'r', off_time: offIso(0), ...over };
}

/* --------------------------------- sorting -------------------------------- */

test('buildRaceDayTimeline sorts entries by off time (ascending)', () => {
  const t = buildRaceDayTimeline(
    [
      input({ race_id: 'c', off_time: offIso(20) }),
      input({ race_id: 'a', off_time: offIso(-10) }),
      input({ race_id: 'b', off_time: offIso(5) }),
    ],
    NOW,
  );
  assert.deepEqual(t.map((e) => e.race_id), ['a', 'b', 'c']);
});

test('buildRaceDayTimeline sorts unknown/unparseable off times last', () => {
  const t = buildRaceDayTimeline(
    [
      input({ race_id: 'x', off_time: null }),
      input({ race_id: 'a', off_time: offIso(-10) }),
      input({ race_id: 'y', off_time: 'not-a-date' }),
    ],
    NOW,
  );
  assert.equal(t[0].race_id, 'a');
  assert.deepEqual(t.slice(1).map((e) => e.race_id).sort(), ['x', 'y']);
});

test('buildRaceDayTimeline does not mutate the input array order', () => {
  const arr = [
    input({ race_id: 'a', off_time: offIso(5) }),
    input({ race_id: 'b', off_time: offIso(-5) }),
  ];
  buildRaceDayTimeline(arr, NOW);
  assert.deepEqual(arr.map((x) => x.race_id), ['a', 'b']);
});

/* ----------------------------- T-minus target ----------------------------- */

test('tMinusCaptureTarget is off time − 5 minutes (null when off unknown)', () => {
  assert.equal(buildTimelineEntry(input({ off_time: offIso(0) }), NOW).tMinusCaptureTarget, offIso(-5));
  assert.equal(buildTimelineEntry(input({ off_time: offIso(30) }), NOW).tMinusCaptureTarget, offIso(25));
  assert.equal(buildTimelineEntry(input({ off_time: null }), NOW).tMinusCaptureTarget, null);
});

/* ------------------------------ capture state ----------------------------- */

test('capture available when a pre-off model run exists', () => {
  const e = buildTimelineEntry(
    input({ off_time: offIso(0), hasModelRun: true, modelUpdatedAt: offIso(-6) }),
    NOW,
  );
  assert.equal(e.captureAvailable, true);
  assert.equal(e.captureStatus, 'captured');
  assert.equal(e.preOffRunTime, offIso(-6));
  assert.equal(e.warnings.includes(TIMELINE_WARN_NO_CAPTURE), false);
});

test('capture missing when there is no model run', () => {
  const e = buildTimelineEntry(
    input({ off_time: offIso(0), hasModelRun: false, modelUpdatedAt: null }),
    NOW,
  );
  assert.equal(e.captureAvailable, false);
  assert.equal(e.captureStatus, 'missing');
  assert.ok(e.warnings.includes(TIMELINE_WARN_NO_CAPTURE));
});

/* ------------------------ post-off not source of truth -------------------- */

test('a post-off-only run is not surfaced as the pre-off record', () => {
  const e = buildTimelineEntry(
    input({
      off_time: offIso(-30),
      hasModelRun: true,
      modelUpdatedAt: offIso(-20), // 10m AFTER off
      status: 'result',
    }),
    NOW,
  );
  assert.equal(e.preOffRunTime, null); // post-off run is NOT the record
  assert.equal(e.captureStatus, 'post-off-only');
  assert.ok(e.warnings.includes(TIMELINE_WARN_NO_CAPTURE));
});

test('a settled race with a pre-off run flags that post-off runs are ignored', () => {
  const e = buildTimelineEntry(
    input({
      off_time: offIso(-30),
      hasModelRun: true,
      modelUpdatedAt: offIso(-35), // 5m BEFORE off
      status: 'result',
    }),
    NOW,
  );
  assert.equal(e.preOffRunTime, offIso(-35));
  assert.ok(e.warnings.includes(TIMELINE_WARN_POST_OFF_IGNORED));
});

/* --------------------------- result / settled ----------------------------- */

test('settled race exposes settled state + time', () => {
  const e = buildTimelineEntry(
    input({ off_time: offIso(-30), status: 'result', resultTime: offIso(-25) }),
    NOW,
  );
  assert.equal(e.raceState, 'settled');
  assert.equal(e.resultStatus, 'settled');
  assert.equal(e.settledTime, offIso(-25));
});

test('a race past off without a result is pending (with a warning)', () => {
  const e = buildTimelineEntry(input({ off_time: offIso(-10), status: null }), NOW);
  assert.equal(e.resultStatus, 'pending');
  assert.ok(e.warnings.includes(TIMELINE_WARN_RESULT_PENDING));
});

/* ------------------------------ staleness --------------------------------- */

test('stale odds: judged as-of off for finished races, vs now for upcoming', () => {
  // Finished race, odds captured 35m before off -> stale at off.
  const stale = buildTimelineEntry(
    input({ off_time: offIso(-60), status: 'result', oddsUpdatedAt: offIso(-95) }),
    NOW,
  );
  assert.equal(stale.oddsStale, true);
  assert.ok(stale.warnings.includes(TIMELINE_WARN_STALE_ODDS));

  // Finished race, odds captured 3m before off -> fresh at off.
  const fresh = buildTimelineEntry(
    input({ off_time: offIso(-60), status: 'result', oddsUpdatedAt: offIso(-63) }),
    NOW,
  );
  assert.equal(fresh.oddsStale, false);

  // Upcoming race, odds 20m old vs now -> stale.
  const upcoming = buildTimelineEntry(
    input({ off_time: offIso(30), oddsUpdatedAt: offIso(-20) }),
    NOW,
  );
  assert.equal(upcoming.oddsStale, true);
});

test('stale model is driven by the run-quality verdict', () => {
  assert.equal(buildTimelineEntry(input({ runQuality: 'STALE' }), NOW).modelStale, true);
  assert.ok(buildTimelineEntry(input({ runQuality: 'stale' }), NOW).warnings.includes(TIMELINE_WARN_STALE_MODEL));
  assert.equal(buildTimelineEntry(input({ runQuality: 'OK' }), NOW).modelStale, false);
  assert.equal(buildTimelineEntry(input({ runQuality: null }), NOW).modelStale, false);
});

/* ------------------------------ missing values ---------------------------- */

test('missing fields surface as null / unknown', () => {
  const e = buildTimelineEntry({ race_id: 'r', off_time: null }, NOW);
  assert.equal(e.off_time, null);
  assert.equal(e.race_name, null);
  assert.equal(e.course, null);
  assert.equal(e.oddsUpdatedAt, null);
  assert.equal(e.modelUpdatedAt, null);
  assert.equal(e.preOffRunTime, null);
  assert.equal(e.tMinusCaptureTarget, null);
  assert.equal(e.settledTime, null);
  assert.equal(e.raceState, 'unknown');
});

/* ------------------------------ determinism ------------------------------- */

test('buildRaceDayTimeline is deterministic for identical inputs', () => {
  const inputs = [
    input({ race_id: 'a', off_time: offIso(5), modelUpdatedAt: offIso(-3) }),
    input({ race_id: 'b', off_time: offIso(-5), status: 'result' }),
  ];
  assert.deepEqual(buildRaceDayTimeline(inputs, NOW), buildRaceDayTimeline(inputs, NOW));
});

/* --------------------- read-only guards (source scans) -------------------- */

test('the timeline module performs no I/O and imports no engine logic', () => {
  const lib = readFileSync('src/lib/raceDayTimeline.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs/.test(lib), false);
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/\bfetch\s*\(/.test(lib), false);
  assert.equal(/bettingEngine|modelProbabilities|kellyStake|scoreRaceRunners/.test(lib), false);
});

test('the timeline panel is presentational and read-only', () => {
  const panel = readFileSync('src/components/RaceTimelinePanel.tsx', 'utf8');
  assert.equal(/\bfetch\s*\(/.test(panel), false);
  assert.equal(/supabaseAdmin/.test(panel), false);
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(panel), false);
  assert.equal(/--commit/.test(panel), false);
  assert.equal(/placeOrder|placeBet|submitOrder/i.test(panel), false);
});

test('the dashboard renders the read-only race-day timeline', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.match(page, /RaceTimelinePanel/);
  assert.match(page, /buildRaceDayTimeline/);
});
