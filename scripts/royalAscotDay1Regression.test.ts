/**
 * Regression tests for the Royal Ascot Day 1 (2026-06-16) post-off superseding
 * bug.
 *
 * THE BUG: the pipeline kept running after race off times. Each post-off rerun
 * (on stale, frozen odds) produced NO positive-EV bet, yet was written as the
 * race's new `is_current` run — superseding the valid pre-off run that DID carry
 * a recommendation. The dashboard, which then read `is_current`, showed
 * "0/4 winners, settled 4, pending 0, 3 no-bet" — when the honest as-of-off-time
 * record was 0/7.
 *
 * THE FIX (Option B): performance is evaluated AS-OF OFF TIME — per race, the
 * latest run with `run_time <= off_time` (the pure `selectPreOffRun`), then
 * `buildPreOffOutcomes` + `summarizeModelPerformance`. These tests drive that
 * exact pure pipeline (the same one `computeModelPerformance` uses in `pre_off`
 * mode) over synthetic, minimal run histories — no DB, no network, no secrets.
 *
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

/* --------------------------------- model --------------------------------- */

/** One model run in a race's history (id + when it was produced). */
interface Run {
  run_id: string;
  run_time: string;
}

/** A synthetic race: its off time, recorded winner (or null), and run history. */
interface RaceFixture {
  race_id: string;
  off_time: string;
  winner_runner_id: string | null;
  runs: Run[];
}

/**
 * Evaluates a set of races AS-OF OFF TIME, exactly as the production
 * `computeModelPerformance` does in `pre_off` mode: pick each race's latest run
 * with `run_time <= off_time` via `selectPreOffRun`, then build outcomes +
 * no-bet via `buildPreOffOutcomes`, then aggregate via
 * `summarizeModelPerformance`. Pure; no DB.
 */
function evaluateAsOfOffTime(
  races: readonly RaceFixture[],
  recsByRunId: ReadonlyMap<string, SelectedRunRecommendation>,
) {
  const selectedRunIdByRace = new Map<string, string>();
  for (const race of races) {
    const chosen = selectPreOffRun(race.runs, race.off_time);
    if (chosen) selectedRunIdByRace.set(race.race_id, chosen.run_id);
  }
  const { outcomes, noBetRaces } = buildPreOffOutcomes({
    races: races.map((r) => ({
      race_id: r.race_id,
      winner_runner_id: r.winner_runner_id,
    })),
    selectedRunIdByRace,
    recsByRunId,
  });
  return summarizeModelPerformance(outcomes, noBetRaces);
}

/** Evaluates races using a CALLER-CHOSEN run per race (e.g. the post-off run). */
function evaluateWithSelectedRuns(
  races: readonly RaceFixture[],
  selectedRunIdByRace: ReadonlyMap<string, string>,
  recsByRunId: ReadonlyMap<string, SelectedRunRecommendation>,
) {
  const { outcomes, noBetRaces } = buildPreOffOutcomes({
    races: races.map((r) => ({
      race_id: r.race_id,
      winner_runner_id: r.winner_runner_id,
    })),
    selectedRunIdByRace,
    recsByRunId,
  });
  return summarizeModelPerformance(outcomes, noBetRaces);
}

/** Terse rank-1 recommendation builder (a $1 stake on `runner` by default). */
function rec(runner: string, over: Partial<SelectedRunRecommendation> = {}): SelectedRunRecommendation {
  return { runner_id: runner, odds: 5, stake: 1, ev: 0.1, ...over };
}

/* ------------------------------ task 1: units ----------------------------- */

test('regression: a post-off no-bet run does NOT erase a valid pre-off recommendation', () => {
  // race went off at 16:00; pre-off run (with a rec) at 15:55; a later post-off
  // run at 19:15 produced NO rec (the live failure). As-of off time must keep
  // the pre-off recommendation.
  const races: RaceFixture[] = [
    {
      race_id: 'r',
      off_time: '2026-06-16T16:00:00Z',
      winner_runner_id: 'winner',
      runs: [
        { run_id: 'preoff', run_time: '2026-06-16T15:55:00Z' },
        { run_id: 'postoff', run_time: '2026-06-16T19:15:00Z' },
      ],
    },
  ];
  const recs = new Map([['preoff', rec('pick')]]); // only the pre-off run had a rec

  const perf = evaluateAsOfOffTime(races, recs);
  assert.equal(perf.recommendations_total, 1); // the pre-off rec survived
  assert.equal(perf.no_bet_races, 0); // NOT erased into a no-bet
  assert.equal(perf.settled_count, 1);
  assert.equal(perf.losers, 1); // pick !== winner
});

test('regression: a post-off stale run is ignored by as-of-off-time selection', () => {
  const runs: Run[] = [
    { run_id: 'preoff', run_time: '2026-06-16T15:55:00Z' },
    { run_id: 'stale-1', run_time: '2026-06-16T16:05:00Z' },
    { run_id: 'stale-2', run_time: '2026-06-16T19:15:00Z' },
  ];
  const chosen = selectPreOffRun(runs, '2026-06-16T16:00:00Z');
  assert.equal(chosen?.run_id, 'preoff'); // never a post-off stale run
});

test('regression: the latest run before off_time is selected over earlier pre-off runs', () => {
  const races: RaceFixture[] = [
    {
      race_id: 'r',
      off_time: '2026-06-16T16:00:00Z',
      winner_runner_id: 'late-pick', // the LATER pre-off pick is the winner
      runs: [
        { run_id: 'early', run_time: '2026-06-16T15:30:00Z' },
        { run_id: 'late', run_time: '2026-06-16T15:58:00Z' },
      ],
    },
  ];
  // Each pre-off run recommended a different runner; the later one must win out.
  const recs = new Map([
    ['early', rec('early-pick')],
    ['late', rec('late-pick')],
  ]);

  const perf = evaluateAsOfOffTime(races, recs);
  assert.equal(perf.winners, 1); // late-pick matched the winner -> proves 'late' was used
  assert.equal(perf.losers, 0);
});

test('regression: latest pre-off run with NO recommendation counts the race as no-bet', () => {
  // An earlier pre-off run had a rec, but the FINAL pre-off run did not — the
  // race is genuinely no-bet as of the off (not a phantom settled bet).
  const races: RaceFixture[] = [
    {
      race_id: 'r',
      off_time: '2026-06-16T16:00:00Z',
      winner_runner_id: 'winner',
      runs: [
        { run_id: 'early-with-rec', run_time: '2026-06-16T15:30:00Z' },
        { run_id: 'final-no-rec', run_time: '2026-06-16T15:58:00Z' },
      ],
    },
  ];
  const recs = new Map([['early-with-rec', rec('pick')]]); // final run has none

  const perf = evaluateAsOfOffTime(races, recs);
  assert.equal(perf.no_bet_races, 1);
  assert.equal(perf.recommendations_total, 0);
  assert.equal(perf.settled_count, 0);
});

test('regression: latest pre-off recommendation on a settled race counts as settled', () => {
  const races: RaceFixture[] = [
    {
      race_id: 'r',
      off_time: '2026-06-16T16:00:00Z',
      winner_runner_id: 'pick', // pick won
      runs: [{ run_id: 'preoff', run_time: '2026-06-16T15:55:00Z' }],
    },
  ];
  const perf = evaluateAsOfOffTime(races, new Map([['preoff', rec('pick', { odds: 4, stake: 1 })]]));
  assert.equal(perf.settled_count, 1);
  assert.equal(perf.pending_count, 0);
  assert.equal(perf.winners, 1);
  assert.equal(perf.profit_loss, 3); // 1 * (4 - 1)
});

test('regression: pending count uses unsettled races with a valid pre-off recommendation', () => {
  const races: RaceFixture[] = [
    {
      race_id: 'r',
      off_time: '2026-06-16T16:00:00Z',
      winner_runner_id: null, // no result yet
      runs: [{ run_id: 'preoff', run_time: '2026-06-16T15:55:00Z' }],
    },
  ];
  const perf = evaluateAsOfOffTime(races, new Map([['preoff', rec('pick')]]));
  assert.equal(perf.recommendations_total, 1);
  assert.equal(perf.pending_count, 1);
  assert.equal(perf.settled_count, 0);
  assert.equal(perf.losers, 0); // pending is NEVER a loss
});

/* --------------------- task 2: the final three Ascot races ---------------- */

/**
 * Each of the day's last three races had a genuine final pre-off recommendation,
 * then later post-off run(s) that produced no bet. As-of-off-time evaluation
 * must keep the pre-off recommendation (settled, scored) rather than reporting
 * the race as no-bet. Winners differ from the picks (all three lost), matching
 * the real result. Synthetic, minimal.
 */
const FINAL_THREE: ReadonlyArray<{
  label: string;
  race: RaceFixture;
  preOffRunId: string;
  pick: string;
}> = [
  {
    label: '17:00 Ascot Stakes',
    pick: 'Small Fry',
    preOffRunId: 'r5-preoff',
    race: {
      race_id: 'race-17-00',
      off_time: '2026-06-16T16:00:00Z', // 17:00 BST
      winner_runner_id: 'Kizlyar',
      runs: [
        { run_id: 'r5-preoff', run_time: '2026-06-16T15:55:00Z' },
        { run_id: 'r5-postoff', run_time: '2026-06-16T19:15:00Z' }, // no-bet rerun
      ],
    },
  },
  {
    label: '17:35 Wolferton Stakes',
    pick: 'Ghostwriter',
    preOffRunId: 'r6-preoff',
    race: {
      race_id: 'race-17-35',
      off_time: '2026-06-16T16:35:00Z', // 17:35 BST
      winner_runner_id: 'Map Of Stars',
      runs: [
        { run_id: 'r6-preoff', run_time: '2026-06-16T16:31:00Z' },
        { run_id: 'r6-postoff', run_time: '2026-06-16T19:15:00Z' }, // no-bet rerun
      ],
    },
  },
  {
    label: '18:10 Copper Horse Stakes',
    pick: 'Gamrai',
    preOffRunId: 'r7-preoff',
    race: {
      race_id: 'race-18-10',
      off_time: '2026-06-16T17:10:00Z', // 18:10 BST
      winner_runner_id: 'Daiquiri Bay',
      runs: [
        { run_id: 'r7-preoff', run_time: '2026-06-16T17:07:00Z' },
        { run_id: 'r7-postoff', run_time: '2026-06-16T19:15:00Z' }, // no-bet rerun
      ],
    },
  },
];

for (const { label, race, preOffRunId, pick } of FINAL_THREE) {
  test(`regression: ${label} keeps its pre-off pick despite a later post-off no-bet run`, () => {
    const recs = new Map([[preOffRunId, rec(pick, { odds: 6, stake: 1 })]]);

    // The post-off run must be ignored by selection...
    const chosen = selectPreOffRun(race.runs, race.off_time);
    assert.equal(chosen?.run_id, preOffRunId);

    // ...and the pre-off recommendation must survive evaluation (settled loss,
    // NOT a no-bet).
    const perf = evaluateAsOfOffTime([race], recs);
    assert.equal(perf.recommendations_total, 1, `${label}: rec should survive`);
    assert.equal(perf.no_bet_races, 0, `${label}: must not be no-bet`);
    assert.equal(perf.settled_count, 1, `${label}: race is settled`);
    assert.equal(perf.losers, 1, `${label}: pick did not win`);
  });
}

/* ----------------- full-card contrast: pre-off vs current ----------------- */

/**
 * The whole Day-1 card. Races 1–4 carried a pre-off rec and stayed rec-bearing
 * post-off (the dashboard counted them, all losers → 0/4). Races 5–7 carried a
 * pre-off rec but their post-off rerun was a no-bet that became `is_current`.
 *
 * - AS-OF OFF TIME (the fix): every race keeps its pre-off rec → the honest 0/7.
 * - CURRENT-POINTER (the bug): races 5–7 evaluate their post-off no-bet run →
 *   the dashboard's wrong "settled 4, 3 no-bet".
 *
 * Both views are computed with the SAME pure helpers, differing ONLY in which
 * run is selected — which is exactly what the fix changed.
 */
const DAY1_CARD: RaceFixture[] = [
  // Races 1–4: a pre-off rec + a post-off rec-bearing rerun (same losing pick).
  ...['1', '2', '3', '4'].map((n) => ({
    race_id: `race-${n}`,
    off_time: `2026-06-16T1${n}:00:00Z`,
    winner_runner_id: `winner-${n}`,
    runs: [
      { run_id: `r${n}-preoff`, run_time: `2026-06-16T0${n}:55:00Z` },
      { run_id: `r${n}-postoff`, run_time: '2026-06-16T19:15:00Z' },
    ],
  })),
  // Races 5–7: a pre-off rec + a post-off NO-BET rerun.
  ...FINAL_THREE.map(({ race }) => race),
];

/** rank-1 recs: every pre-off run picks a loser; races 1–4 post-off runs re-pick
 *  the same loser; races 5–7 post-off runs have NO rec (the bug). */
const DAY1_RECS = new Map<string, SelectedRunRecommendation>([
  ...['1', '2', '3', '4'].flatMap((n) => [
    [`r${n}-preoff`, rec(`pick-${n}`, { odds: 5, stake: 1 })] as const,
    [`r${n}-postoff`, rec(`pick-${n}`, { odds: 5, stake: 1 })] as const,
  ]),
  ['r5-preoff', rec('Small Fry', { odds: 6, stake: 1 })],
  ['r6-preoff', rec('Ghostwriter', { odds: 6, stake: 1 })],
  ['r7-preoff', rec('Gamrai', { odds: 6, stake: 1 })],
  // r5/r6/r7 -postoff intentionally absent: those reruns made no bet.
]);

test('regression: as-of-off-time evaluation reports the honest 0/7 for the whole card', () => {
  const perf = evaluateAsOfOffTime(DAY1_CARD, DAY1_RECS);
  assert.equal(perf.recommendations_total, 7); // all seven pre-off recs counted
  assert.equal(perf.settled_count, 7);
  assert.equal(perf.pending_count, 0);
  assert.equal(perf.no_bet_races, 0); // NONE erased by post-off no-bet runs
  assert.equal(perf.winners, 0);
  assert.equal(perf.losers, 7);
  assert.equal(perf.strike_rate, 0);
  assert.equal(perf.total_staked, 7);
  assert.equal(perf.profit_loss, -7); // seven 1pt losers
  assert.equal(perf.roi, -100);
});

test('regression: the OLD current-pointer selection reproduces the buggy 4 settled / 3 no-bet', () => {
  // Reproduce the bug by selecting each race's LATEST (post-off) run, as the
  // `is_current` pointer did. Races 1–4 post-off runs still carry a rec; races
  // 5–7 post-off runs do not.
  const currentPointer = new Map<string, string>([
    ...['1', '2', '3', '4'].map((n) => [`race-${n}`, `r${n}-postoff`] as const),
    ['race-17-00', 'r5-postoff'],
    ['race-17-35', 'r6-postoff'],
    ['race-18-10', 'r7-postoff'],
  ]);

  const perf = evaluateWithSelectedRuns(DAY1_CARD, currentPointer, DAY1_RECS);
  // The exact wrong dashboard numbers from the incident:
  assert.equal(perf.settled_count, 4);
  assert.equal(perf.winners, 0); // 0/4
  assert.equal(perf.pending_count, 0);
  assert.equal(perf.no_bet_races, 3);

  // And it genuinely differs from the as-of-off-time record, proving the fix
  // matters (and that this test would catch a regression to current-pointer).
  const fixed = evaluateAsOfOffTime(DAY1_CARD, DAY1_RECS);
  assert.notEqual(perf.settled_count, fixed.settled_count);
  assert.notEqual(perf.no_bet_races, fixed.no_bet_races);
});

/* ----------- task 3: user-noted snapshot vs final pre-off run ------------- */

/**
 * On Day 1 the operator's notes captured a snapshot 5–9 minutes before the off,
 * but the model ran AGAIN closer to the off (still pre-off) and changed its
 * rank-1 pick. BOTH snapshots are pre-off (`run_time <= off_time`), so the rule
 * "latest run before off_time" must select the FINAL pre-off run — the operator
 * note is audit evidence, not the decision record.
 *
 * In each case below the synthetic `winner` is set to the USER-NOTED pick on
 * purpose: if evaluation wrongly used the note's earlier snapshot it would score
 * a WIN, so asserting a LOSS proves the FINAL pre-off pick was evaluated. (In
 * reality none of these won; the synthetic winner only isolates the selection.)
 */
const NOTE_VS_FINAL: ReadonlyArray<{
  label: string;
  off_time: string;
  userSnapshot: { run_id: string; run_time: string; pick: string };
  finalPreOff: { run_id: string; run_time: string; pick: string };
}> = [
  {
    label: '17:00 Ascot Stakes',
    off_time: '2026-06-16T16:00:00Z',
    userSnapshot: { run_id: 'r5-usernote', run_time: '2026-06-16T15:51:02Z', pick: 'Small Fry' },
    finalPreOff: { run_id: 'r5-final', run_time: '2026-06-16T15:55:21Z', pick: 'Puturhandstogether' },
  },
  {
    label: '17:35 Wolferton Stakes',
    off_time: '2026-06-16T16:35:00Z',
    userSnapshot: { run_id: 'r6-usernote', run_time: '2026-06-16T16:30:16Z', pick: 'Ghostwriter' },
    finalPreOff: { run_id: 'r6-final', run_time: '2026-06-16T16:31:25Z', pick: 'Haatem' },
  },
  {
    label: '18:10 Copper Horse Stakes',
    off_time: '2026-06-16T17:10:00Z',
    userSnapshot: { run_id: 'r7-usernote', run_time: '2026-06-16T16:53:33Z', pick: 'Gamrai' },
    finalPreOff: { run_id: 'r7-final', run_time: '2026-06-16T17:07:24Z', pick: 'Sing Us A Song' },
  },
];

for (const { label, off_time, userSnapshot, finalPreOff } of NOTE_VS_FINAL) {
  test(`regression: ${label} evaluates the final pre-off run, not the earlier user-noted snapshot`, () => {
    const runs: Run[] = [
      { run_id: userSnapshot.run_id, run_time: userSnapshot.run_time },
      { run_id: finalPreOff.run_id, run_time: finalPreOff.run_time },
    ];

    // Selection must pick the FINAL pre-off run, even though BOTH are pre-off.
    const chosen = selectPreOffRun(runs, off_time);
    assert.equal(
      chosen?.run_id,
      finalPreOff.run_id,
      `${label}: must select the final pre-off run, not the user-noted snapshot`,
    );

    // Evaluate with the winner set to the USER-NOTED pick: a LOSS proves the
    // final pre-off pick was scored, not the note's earlier snapshot.
    const race: RaceFixture = {
      race_id: `race-${finalPreOff.run_id}`,
      off_time,
      winner_runner_id: userSnapshot.pick,
      runs,
    };
    const recs = new Map<string, SelectedRunRecommendation>([
      [userSnapshot.run_id, rec(userSnapshot.pick)],
      [finalPreOff.run_id, rec(finalPreOff.pick)],
    ]);

    const perf = evaluateAsOfOffTime([race], recs);
    assert.equal(perf.recommendations_total, 1, `${label}: one evaluated rec`);
    assert.equal(perf.winners, 0, `${label}: the final pre-off pick is not the user-noted runner`);
    assert.equal(perf.losers, 1, `${label}: scored the final pre-off pick, not the user note`);
  });
}
