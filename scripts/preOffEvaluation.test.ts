/**
 * Unit tests for the pure "as-of off time" (pre-off) evaluation helpers
 * (src/lib/modelPerformance.ts): selectPreOffRun + buildPreOffOutcomes.
 *
 * No DB, no network: synthetic runs/recommendations exercise the selection rule
 * (latest run at/before off time wins; post-off reruns ignored) and the outcome
 * building (no-bet counting, settled/pending, and the guarantee that a post-off
 * run with no recommendation cannot erase a valid pre-off recommendation).
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectPreOffRun,
  buildPreOffOutcomes,
  summarizeModelPerformance,
  type SelectedRunRecommendation,
} from '../src/lib/modelPerformance';

const OFF = '2026-06-16T16:00:00.000Z'; // scheduled off time used across tests

/** Terse run-candidate builder. */
function run(run_id: string, run_time: string) {
  return { run_id, run_time };
}

/** Terse rank-1 recommendation builder. */
function rec(o: Partial<SelectedRunRecommendation> = {}): SelectedRunRecommendation {
  return { runner_id: 'r1', odds: 5, stake: 1, ev: 0.1, ...o };
}

/* ----------------------------- selectPreOffRun ---------------------------- */

test('selectPreOffRun: latest pre-off run wins over earlier pre-off run', () => {
  const chosen = selectPreOffRun(
    [
      run('a', '2026-06-16T15:40:00.000Z'),
      run('c', '2026-06-16T15:55:00.000Z'), // latest <= off
      run('b', '2026-06-16T15:50:00.000Z'),
    ],
    OFF,
  );
  assert.equal(chosen?.run_id, 'c');
});

test('selectPreOffRun: a run exactly at off time is eligible (inclusive)', () => {
  const chosen = selectPreOffRun(
    [run('at-off', OFF), run('before', '2026-06-16T15:59:00.000Z')],
    OFF,
  );
  assert.equal(chosen?.run_id, 'at-off');
});

test('selectPreOffRun: post-off run is ignored, latest pre-off picked instead', () => {
  const chosen = selectPreOffRun(
    [
      run('pre', '2026-06-16T15:55:00.000Z'),
      run('post', '2026-06-16T16:31:00.000Z'), // after off -> excluded
    ],
    OFF,
  );
  assert.equal(chosen?.run_id, 'pre');
});

test('selectPreOffRun: a post-off STALE rerun never supersedes the pre-off run', () => {
  // Mirrors the live bug: many post-off reruns exist and are newer, but none
  // are eligible, so the pre-off run remains selected.
  const chosen = selectPreOffRun(
    [
      run('pre', '2026-06-16T15:50:00.000Z'),
      run('post-1', '2026-06-16T16:05:00.000Z'),
      run('post-2', '2026-06-16T18:15:00.000Z'),
      run('post-3', '2026-06-16T19:15:00.000Z'),
    ],
    OFF,
  );
  assert.equal(chosen?.run_id, 'pre');
});

test('selectPreOffRun: all runs after off time -> null', () => {
  const chosen = selectPreOffRun(
    [run('p1', '2026-06-16T16:05:00.000Z'), run('p2', '2026-06-16T17:00:00.000Z')],
    OFF,
  );
  assert.equal(chosen, null);
});

test('selectPreOffRun: missing/invalid off time -> null (cannot evaluate)', () => {
  assert.equal(selectPreOffRun([run('a', OFF)], null), null);
  assert.equal(selectPreOffRun([run('a', OFF)], undefined), null);
  assert.equal(selectPreOffRun([run('a', OFF)], 'not-a-date'), null);
});

test('selectPreOffRun: empty run list -> null', () => {
  assert.equal(selectPreOffRun([], OFF), null);
});

/* --------------------------- buildPreOffOutcomes -------------------------- */

test('buildPreOffOutcomes: selected run with no recommendation counts as no-bet', () => {
  const { outcomes, noBetRaces } = buildPreOffOutcomes({
    races: [{ race_id: 'race1', winner_runner_id: 'w1' }],
    selectedRunIdByRace: new Map([['race1', 'run1']]),
    recsByRunId: new Map(), // run1 produced no rank-1 rec
  });
  assert.equal(outcomes.length, 0);
  assert.equal(noBetRaces, 1);
});

test('buildPreOffOutcomes: race with no selected run is out of scope (not no-bet)', () => {
  const { outcomes, noBetRaces } = buildPreOffOutcomes({
    races: [{ race_id: 'race1', winner_runner_id: null }],
    selectedRunIdByRace: new Map(), // no pre-off run at all
    recsByRunId: new Map(),
  });
  assert.equal(outcomes.length, 0);
  assert.equal(noBetRaces, 0);
});

test('buildPreOffOutcomes: settled win when the recommended runner is the winner', () => {
  const { outcomes } = buildPreOffOutcomes({
    races: [{ race_id: 'race1', winner_runner_id: 'horseA' }],
    selectedRunIdByRace: new Map([['race1', 'run1']]),
    recsByRunId: new Map([['run1', rec({ runner_id: 'horseA', odds: 4, stake: 2 })]]),
  });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].settled, true);
  assert.equal(outcomes[0].won, true);
  assert.equal(outcomes[0].odds, 4);
  assert.equal(outcomes[0].stake, 2);
});

test('buildPreOffOutcomes: settled loss when the winner differs from the pick', () => {
  const { outcomes } = buildPreOffOutcomes({
    races: [{ race_id: 'race1', winner_runner_id: 'horseB' }],
    selectedRunIdByRace: new Map([['race1', 'run1']]),
    recsByRunId: new Map([['run1', rec({ runner_id: 'horseA' })]]),
  });
  assert.equal(outcomes[0].settled, true);
  assert.equal(outcomes[0].won, false);
});

test('buildPreOffOutcomes: unsettled race (no winner) is pending, never a loss', () => {
  const { outcomes } = buildPreOffOutcomes({
    races: [{ race_id: 'race1', winner_runner_id: null }],
    selectedRunIdByRace: new Map([['race1', 'run1']]),
    recsByRunId: new Map([['run1', rec({ runner_id: 'horseA' })]]),
  });
  assert.equal(outcomes[0].settled, false);
  assert.equal(outcomes[0].won, false);
});

/* ----------------------- composition: the real bug ------------------------ */

test('post-off run with no recommendation does NOT erase a valid pre-off recommendation', () => {
  // race history: a valid pre-off run (with a rec) then a later post-off rerun
  // that produced NO rec (the live failure that made the dashboard show no-bet).
  const runs = [
    run('preoff', '2026-06-16T15:55:00.000Z'),
    run('postoff', '2026-06-16T16:31:00.000Z'),
  ];

  // Step 1: selection ignores the post-off run.
  const chosen = selectPreOffRun(runs, OFF);
  assert.equal(chosen?.run_id, 'preoff');

  // Step 2: only the pre-off run's rec exists (the post-off run had none).
  const { outcomes, noBetRaces } = buildPreOffOutcomes({
    races: [{ race_id: 'race1', winner_runner_id: 'horseB' }],
    selectedRunIdByRace: new Map([['race1', chosen!.run_id]]),
    recsByRunId: new Map([['preoff', rec({ runner_id: 'horseA', odds: 6, stake: 1 })]]),
  });

  // The pre-off recommendation survives: it's a settled outcome, not a no-bet.
  assert.equal(noBetRaces, 0);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].settled, true);
  assert.equal(outcomes[0].won, false);

  const perf = summarizeModelPerformance(outcomes, noBetRaces);
  assert.equal(perf.settled_count, 1);
  assert.equal(perf.no_bet_races, 0);
});

test('settled/pending counts are correct across a mixed pre-off card', () => {
  // race1: settled winner-match (pre-off rec). race2: pending (pre-off rec, no
  // result yet). race3: pre-off run with no rec -> no-bet. race4: no pre-off run.
  const races = [
    { race_id: 'race1', winner_runner_id: 'a' },
    { race_id: 'race2', winner_runner_id: null },
    { race_id: 'race3', winner_runner_id: 'c' },
    { race_id: 'race4', winner_runner_id: 'd' },
  ];
  const selectedRunIdByRace = new Map([
    ['race1', 'run1'],
    ['race2', 'run2'],
    ['race3', 'run3'],
    // race4 absent -> out of scope
  ]);
  const recsByRunId = new Map<string, SelectedRunRecommendation>([
    ['run1', rec({ runner_id: 'a', odds: 3, stake: 1 })], // settled win
    ['run2', rec({ runner_id: 'x', odds: 5, stake: 1 })], // pending
    // run3 absent -> no-bet
  ]);

  const { outcomes, noBetRaces } = buildPreOffOutcomes({
    races,
    selectedRunIdByRace,
    recsByRunId,
  });
  const perf = summarizeModelPerformance(outcomes, noBetRaces);

  assert.equal(perf.recommendations_total, 2); // race1 + race2
  assert.equal(perf.settled_count, 1); // race1
  assert.equal(perf.pending_count, 1); // race2
  assert.equal(perf.winners, 1);
  assert.equal(perf.losers, 0);
  assert.equal(perf.no_bet_races, 1); // race3
});
