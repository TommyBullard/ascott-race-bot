/**
 * Tests for the post-off / resulted model-run safety guard.
 *
 * Two layers, both DB-free:
 *   1. The pure policy `evaluateModelRunGuard` (+ the `notCurrentMarker` used by
 *      the diagnostic write path).
 *   2. The shared run loop `runModelForMeetingRaces`, which must SKIP post-off /
 *      resulted races BEFORE calling the injected `runOne` — proving a post-off
 *      rerun never reaches the writer that would supersede the pre-off run — and
 *      the summary tally `summarizeModelDayOutcomes`.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateModelRunGuard,
  type ModelRunGuardInput,
} from '../src/lib/modelRunGuard';
import { notCurrentMarker, currentMarker } from '../src/lib/modelRunHistory';
import {
  runModelForMeetingRaces,
  summarizeModelDayOutcomes,
  type MeetingRace,
  type RaceRunOutcome,
} from '../src/lib/modelDayRun';

// Fixed "now": races before this are post-off, after are pre-off.
const NOW = new Date('2026-06-16T16:30:00.000Z');

function race(over: Partial<MeetingRace> = {}): MeetingRace {
  return {
    id: 'race-1',
    course: 'Ascot',
    off_time: '2026-06-16T17:10:00.000Z', // pre-off by default
    race_name: 'Test Stakes',
    ...over,
  };
}

/* --------------------------- evaluateModelRunGuard ------------------------ */

test('guard: a resulted race is skipped (RESULTED)', () => {
  const input: ModelRunGuardInput = { off_time: '2026-06-16T17:10:00.000Z', status: 'result' };
  const decision = evaluateModelRunGuard(input, NOW);
  assert.equal(decision.skip, true);
  assert.equal(decision.reason, 'RESULTED');
});

test('guard: RESULTED wins even when off time is still in the future', () => {
  // A race can be marked result early; status takes precedence over the clock.
  const decision = evaluateModelRunGuard(
    { off_time: '2026-06-16T18:00:00.000Z', status: 'result' },
    NOW,
  );
  assert.equal(decision.reason, 'RESULTED');
});

test('guard: a post-off race is skipped (POST_OFF)', () => {
  const decision = evaluateModelRunGuard(
    { off_time: '2026-06-16T16:00:00.000Z', status: 'open' }, // 30 min before now
    NOW,
  );
  assert.equal(decision.skip, true);
  assert.equal(decision.reason, 'POST_OFF');
});

test('guard: a pre-off race runs (no skip, no reason)', () => {
  const decision = evaluateModelRunGuard(
    { off_time: '2026-06-16T17:10:00.000Z', status: null }, // 40 min after now
    NOW,
  );
  assert.equal(decision.skip, false);
  assert.equal(decision.reason, null);
});

test('guard: off time exactly at now is NOT post-off (strictly greater)', () => {
  const decision = evaluateModelRunGuard(
    { off_time: NOW.toISOString(), status: null },
    NOW,
  );
  assert.equal(decision.skip, false);
  assert.equal(decision.reason, null);
});

test('guard: unknown / blank off time does not trigger POST_OFF', () => {
  assert.equal(evaluateModelRunGuard({ off_time: null, status: null }, NOW).reason, null);
  assert.equal(evaluateModelRunGuard({ off_time: '', status: null }, NOW).reason, null);
  assert.equal(evaluateModelRunGuard({ off_time: 'not-a-date', status: null }, NOW).reason, null);
});

test('guard: allowPostOff diagnostic override does NOT skip, but keeps the reason', () => {
  const decision = evaluateModelRunGuard(
    { off_time: '2026-06-16T16:00:00.000Z', status: null },
    NOW,
    { allowPostOff: true },
  );
  assert.equal(decision.skip, false); // proceeds
  assert.equal(decision.reason, 'POST_OFF'); // caller writes a NON-current run
});

test('guard: allowPostOff override also applies to a resulted race', () => {
  const decision = evaluateModelRunGuard(
    { off_time: '2026-06-16T16:00:00.000Z', status: 'result' },
    NOW,
    { allowPostOff: true },
  );
  assert.equal(decision.skip, false);
  assert.equal(decision.reason, 'RESULTED');
});

/* ------------------------------- markers --------------------------------- */

test('notCurrentMarker: stamps is_current=false (diagnostic runs never become current)', () => {
  assert.deepEqual(notCurrentMarker(), { is_current: false, superseded_at: null });
  // Sanity: the normal marker is the opposite, so the two paths are distinct.
  assert.deepEqual(currentMarker(), { is_current: true, superseded_at: null });
});

/* ------------------- runModelForMeetingRaces (loop guard) ----------------- */

test('loop: resulted race is skipped and runOne is never called', async () => {
  const called: string[] = [];
  const races: MeetingRace[] = [race({ id: 'resulted', status: 'result' })];
  const outcomes = await runModelForMeetingRaces(
    races,
    async (id) => {
      called.push(id);
      return { scored: 8, recommended: 1 };
    },
    undefined,
    NOW,
  );
  assert.deepEqual(called, []); // writer never invoked
  assert.equal(outcomes[0].status, 'skipped');
  assert.equal(outcomes[0].skipReason, 'RESULTED');
});

test('loop: post-off race is skipped and runOne is never called', async () => {
  const called: string[] = [];
  const races: MeetingRace[] = [race({ id: 'postoff', off_time: '2026-06-16T16:00:00.000Z' })];
  const outcomes = await runModelForMeetingRaces(
    races,
    async (id) => {
      called.push(id);
      return { scored: 8, recommended: 1 };
    },
    undefined,
    NOW,
  );
  assert.deepEqual(called, []);
  assert.equal(outcomes[0].status, 'skipped');
  assert.equal(outcomes[0].skipReason, 'POST_OFF');
});

test('loop: pre-off race still runs (runOne is called)', async () => {
  const called: string[] = [];
  const races: MeetingRace[] = [race({ id: 'preoff', off_time: '2026-06-16T17:10:00.000Z' })];
  const outcomes = await runModelForMeetingRaces(
    races,
    async (id) => {
      called.push(id);
      return { scored: 8, recommended: 1 };
    },
    undefined,
    NOW,
  );
  assert.deepEqual(called, ['preoff']);
  assert.equal(outcomes[0].status, 'run');
  assert.equal(outcomes[0].recommended, 1);
});

test('loop: a post-off skip cannot supersede — the writer (runOne) is bypassed', async () => {
  // runModelForRace (the real runOne) is the ONLY thing that supersedes the
  // pre-off run. The loop must skip the post-off race WITHOUT calling it, so the
  // existing current run is left intact. A mixed card proves only the pre-off
  // race reaches the writer.
  const called: string[] = [];
  const races: MeetingRace[] = [
    race({ id: 'preoff', off_time: '2026-06-16T17:10:00.000Z' }),
    race({ id: 'postoff', off_time: '2026-06-16T15:55:00.000Z' }),
    race({ id: 'resulted', off_time: '2026-06-16T15:20:00.000Z', status: 'result' }),
  ];
  const outcomes = await runModelForMeetingRaces(
    races,
    async (id) => {
      called.push(id);
      return { scored: 8, recommended: 1 };
    },
    undefined,
    NOW,
  );
  assert.deepEqual(called, ['preoff']); // post-off + resulted never written
  assert.equal(outcomes.find((o) => o.raceId === 'postoff')?.skipReason, 'POST_OFF');
  assert.equal(outcomes.find((o) => o.raceId === 'resulted')?.skipReason, 'RESULTED');
});

/* ----------------------- summary reports skip reasons --------------------- */

test('summary: skipped_post_off / skipped_resulted are reported distinctly', () => {
  const outcomes: RaceRunOutcome[] = [
    { raceId: 'a', status: 'run', recommended: 1, scored: 8 },
    { raceId: 'b', status: 'skipped', skipReason: 'POST_OFF' },
    { raceId: 'c', status: 'skipped', skipReason: 'RESULTED' },
    { raceId: 'd', status: 'skipped', skipReason: 'POST_OFF' },
    { raceId: 'e', status: 'skipped' }, // no-priced-field skip (no reason)
  ];
  const s = summarizeModelDayOutcomes(outcomes);
  assert.equal(s.races_found, 5);
  assert.equal(s.races_run, 1);
  assert.equal(s.skipped_post_off, 2);
  assert.equal(s.skipped_resulted, 1);
  assert.equal(s.skipped_races, 1); // the reasonless skip only
});

test('summary: a clean pre-off card reports zero post-off / resulted skips', () => {
  const s = summarizeModelDayOutcomes([
    { raceId: 'a', status: 'run', recommended: 1 },
    { raceId: 'b', status: 'run', recommended: 0 },
  ]);
  assert.equal(s.skipped_post_off, 0);
  assert.equal(s.skipped_resulted, 0);
  assert.equal(s.no_bet_races, 1);
});
