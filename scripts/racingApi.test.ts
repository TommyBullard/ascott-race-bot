/**
 * Unit tests for The Racing API adapter — pure logic only.
 *
 * No network: a fake `RacingApiClient` returns fixture responses shaped exactly
 * like the documented API (per-course rows with `runners`/`rides`, `"1st"`,
 * `"1_pl"`). These assert the aggregation + mapping (the INTEGRITY-critical
 * code that turns real API numbers into signals) and the enumeration/cap logic.
 * They never assert against a live feed.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateAnalysisRows,
  collectEntitiesFromRacecards,
  createRacingApiClient,
  fetchRacingApiSignals,
  mapAggregatesToSignal,
  roiFromAggregate,
  strikeRateFromAggregate,
  windowDates,
  RACING_API_SOURCE,
  type JockeyAnalysisResponse,
  type RacecardsResponse,
  type RacingApiClient,
  type TrainerAnalysisResponse,
} from '../src/lib/racingApi';

const APPROX = 1e-9;
const close = (a: number, b: number, eps = APPROX) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

// --- aggregation -----------------------------------------------------------

test('aggregateAnalysisRows: sums runs (runners OR rides), wins, profit/loss', () => {
  const agg = aggregateAnalysisRows([
    { course: 'Ascot', runners: 200, '1st': 40, '1_pl': 30 },
    { course: 'York', runners: 100, '1st': 10, '1_pl': -10 },
  ]);
  assert.equal(agg.runs, 300);
  assert.equal(agg.wins, 50);
  close(agg.profitLoss, 20);
});

test('aggregateAnalysisRows: reads jockey `rides`, ignores missing/NaN, handles empty', () => {
  const agg = aggregateAnalysisRows([
    { rides: 30, '1st': 6, '1_pl': 9 },
    { rides: undefined, '1st': 2, '1_pl': Number.NaN as unknown as number },
  ]);
  assert.equal(agg.runs, 30);
  assert.equal(agg.wins, 8);
  close(agg.profitLoss, 9);

  const empty = aggregateAnalysisRows([]);
  assert.deepEqual(empty, { runs: 0, wins: 0, profitLoss: 0 });
  assert.deepEqual(aggregateAnalysisRows(undefined), { runs: 0, wins: 0, profitLoss: 0 });
});

test('roiFromAggregate / strikeRateFromAggregate: ratios, and 0 when no runs', () => {
  close(roiFromAggregate({ runs: 300, wins: 50, profitLoss: 20 }), 20 / 300);
  close(strikeRateFromAggregate({ runs: 300, wins: 50, profitLoss: 20 }), 50 / 300);
  assert.equal(roiFromAggregate({ runs: 0, wins: 0, profitLoss: 5 }), 0);
  assert.equal(strikeRateFromAggregate({ runs: 0, wins: 0, profitLoss: 0 }), 0);
});

// --- window math -----------------------------------------------------------

test('windowDates: [today - days, today] in UTC YYYY-MM-DD', () => {
  const now = new Date('2026-06-12T09:30:00Z');
  assert.deepEqual(windowDates(now, 365), {
    startDate: '2025-06-12',
    endDate: '2026-06-12',
  });
  assert.deepEqual(windowDates(now, 30), {
    startDate: '2026-05-13',
    endDate: '2026-06-12',
  });
  assert.deepEqual(windowDates(now, 7), {
    startDate: '2026-06-05',
    endDate: '2026-06-12',
  });
});

// --- mapping ---------------------------------------------------------------

test('mapAggregatesToSignal: maps windows to a signal, never fabricates streak/A-E', () => {
  const signal = mapAggregatesToSignal({
    name: 'Alpha Trainer',
    kind: 'trainer',
    longRun: { runs: 300, wins: 50, profitLoss: 20 },
    recent30: { runs: 20, wins: 5, profitLoss: 8 },
    recent7: { runs: 5, wins: 2, profitLoss: 3 },
  });
  assert.equal(signal.name, 'Alpha Trainer (trainer)');
  assert.equal(signal.source, RACING_API_SOURCE);
  assert.equal(signal.affiliation, 'trainer');
  assert.equal(signal.betsCount, 300);
  assert.equal(signal.winsCount, 50);
  close(signal.longRunRoi, 20 / 300);
  close(signal.recentRoi30d, 8 / 20);
  close(signal.recentRoi7d as number, 3 / 5);
  close(signal.strikeRate, 50 / 300);
  assert.equal(signal.longestLosingStreak, 0); // never invented
});

test('mapAggregatesToSignal: recentRoi7d omitted when the short window had no runs', () => {
  const noShort = mapAggregatesToSignal({
    name: 'Beta Trainer',
    kind: 'trainer',
    longRun: { runs: 50, wins: 5, profitLoss: -5 },
    recent30: { runs: 0, wins: 0, profitLoss: 0 },
    recent7: { runs: 0, wins: 0, profitLoss: 0 },
  });
  assert.equal(noShort.recentRoi7d, undefined);
  assert.equal(noShort.recentRoi30d, 0);

  const absentShort = mapAggregatesToSignal({
    name: 'W. Buick',
    kind: 'jockey',
    longRun: { runs: 400, wins: 60, profitLoss: 40 },
    recent30: { runs: 30, wins: 6, profitLoss: 9 },
  });
  assert.equal(absentShort.name, 'W. Buick (jockey)');
  assert.equal(absentShort.recentRoi7d, undefined);
});

// --- enumeration -----------------------------------------------------------

test('collectEntitiesFromRacecards: dedupes by id, counts runners, ranks desc', () => {
  const pages: RacecardsResponse[] = [
    {
      racecards: [
        {
          runners: [
            { trainer: 'Alpha', trainer_id: 'trn_1', jockey: 'Speedy', jockey_id: 'jky_1' },
            { trainer: 'Alpha', trainer_id: 'trn_1', jockey: 'Steady', jockey_id: 'jky_2' },
          ],
        },
      ],
    },
    {
      racecards: [
        {
          runners: [
            // trainer_id present, name only supplied here -> fallback then fill
            { trainer_id: 'trn_2' },
            { trainer: 'Beta', trainer_id: 'trn_2', jockey: 'Speedy', jockey_id: 'jky_1' },
          ],
        },
      ],
    },
  ];
  const { trainers, jockeys } = collectEntitiesFromRacecards(pages);

  assert.deepEqual(
    trainers.map((t) => [t.id, t.name, t.runnerCount]),
    [
      ['trn_1', 'Alpha', 2],
      ['trn_2', 'Beta', 2], // name back-filled from the second runner
    ],
  );
  // jky_1 (2) ranks above jky_2 (1)
  assert.deepEqual(
    jockeys.map((j) => [j.id, j.name, j.runnerCount]),
    [
      ['jky_1', 'Speedy', 2],
      ['jky_2', 'Steady', 1],
    ],
  );
});

// --- adapter end-to-end (fake client, no network) --------------------------

const NOW = new Date('2026-06-12T09:00:00Z');

function makeFakeClient(): RacingApiClient {
  const long = windowDates(NOW, 365).startDate;
  const r30 = windowDates(NOW, 30).startDate;
  const r7 = windowDates(NOW, 7).startDate;

  const trainers: Record<string, Record<string, TrainerAnalysisResponse>> = {
    trn_1: {
      [long]: {
        trainer: 'Alpha Trainer',
        courses: [
          { runners: 200, '1st': 40, '1_pl': 30 },
          { runners: 100, '1st': 10, '1_pl': -10 },
        ],
      },
      [r30]: { trainer: 'Alpha Trainer', courses: [{ runners: 20, '1st': 5, '1_pl': 8 }] },
      [r7]: { trainer: 'Alpha Trainer', courses: [{ runners: 5, '1st': 2, '1_pl': 3 }] },
    },
    trn_2: {
      [long]: { trainer: 'Beta Trainer', courses: [{ runners: 50, '1st': 5, '1_pl': -5 }] },
      [r30]: { trainer: 'Beta Trainer', courses: [] },
      [r7]: { trainer: 'Beta Trainer', courses: [] },
    },
    trn_zero: {
      [long]: { trainer: 'Zero Trainer', courses: [] },
      [r30]: { trainer: 'Zero Trainer', courses: [] },
      [r7]: { trainer: 'Zero Trainer', courses: [] },
    },
  };

  const jockeys: Record<string, Record<string, JockeyAnalysisResponse>> = {
    jky_1: {
      [long]: { jockey: 'Speedy Jockey', courses: [{ rides: 400, '1st': 60, '1_pl': 40 }] },
      [r30]: { jockey: 'Speedy Jockey', courses: [{ rides: 30, '1st': 6, '1_pl': 9 }] },
      [r7]: { jockey: 'Speedy Jockey', courses: [{ rides: 8, '1st': 2, '1_pl': 4 }] },
    },
    jky_2: {
      [long]: { jockey: 'Steady Jockey', courses: [{ rides: 80, '1st': 8, '1_pl': -8 }] },
      [r30]: { jockey: 'Steady Jockey', courses: [] },
      [r7]: { jockey: 'Steady Jockey', courses: [] },
    },
  };

  const todayCards: RacecardsResponse = {
    racecards: [
      {
        runners: [
          { trainer: 'Alpha Trainer', trainer_id: 'trn_1', jockey: 'Speedy Jockey', jockey_id: 'jky_1' },
          { trainer: 'Alpha Trainer', trainer_id: 'trn_1', jockey: 'Steady Jockey', jockey_id: 'jky_2' },
          { trainer: 'Beta Trainer', trainer_id: 'trn_2', jockey: 'Speedy Jockey', jockey_id: 'jky_1' },
        ],
      },
      {
        runners: [
          { trainer: 'Alpha Trainer', trainer_id: 'trn_1', jockey: 'Speedy Jockey', jockey_id: 'jky_1' },
          { trainer: 'Zero Trainer', trainer_id: 'trn_zero', jockey: 'Steady Jockey', jockey_id: 'jky_2' },
        ],
      },
    ],
  };
  const tomorrowCards: RacecardsResponse = {
    racecards: [
      {
        runners: [
          { trainer: 'Beta Trainer', trainer_id: 'trn_2', jockey: 'Steady Jockey', jockey_id: 'jky_2' },
        ],
      },
    ],
  };

  return {
    async getFreeRacecards({ day }) {
      return day === 'today' ? todayCards : tomorrowCards;
    },
    async getTrainerCourseAnalysis(id, { startDate }) {
      return trainers[id]?.[startDate ?? ''] ?? { courses: [] };
    },
    async getJockeyCourseAnalysis(id, { startDate }) {
      return jockeys[id]?.[startDate ?? ''] ?? { courses: [] };
    },
    // Not exercised by these tests; stubbed to satisfy the client interface.
    async getStandardRacecards() {
      return { racecards: [] };
    },
    async getResults() {
      return { results: [] };
    },
  };
}

test('fetchRacingApiSignals: builds real signals, skips zero-run entities', async () => {
  const signals = await fetchRacingApiSignals({ now: NOW }, makeFakeClient());

  const byName = new Map(signals.map((s) => [s.name, s]));
  // trn_zero has no long-window runs -> NO fabricated signal.
  assert.equal(byName.has('Zero Trainer (trainer)'), false);
  // The four entities with real long-window data are present.
  assert.deepEqual(
    [...byName.keys()].sort(),
    [
      'Alpha Trainer (trainer)',
      'Beta Trainer (trainer)',
      'Speedy Jockey (jockey)',
      'Steady Jockey (jockey)',
    ],
  );

  const alpha = byName.get('Alpha Trainer (trainer)')!;
  assert.equal(alpha.source, RACING_API_SOURCE);
  assert.equal(alpha.betsCount, 300);
  assert.equal(alpha.winsCount, 50);
  close(alpha.longRunRoi, 20 / 300);
  close(alpha.recentRoi30d, 8 / 20);
  close(alpha.recentRoi7d as number, 3 / 5);
  close(alpha.strikeRate, 50 / 300);
  assert.equal(alpha.longestLosingStreak, 0);

  const speedy = byName.get('Speedy Jockey (jockey)')!;
  assert.equal(speedy.betsCount, 400); // rides, real count
  close(speedy.longRunRoi, 40 / 400);
  close(speedy.recentRoi7d as number, 4 / 8);

  // Beta + Steady had no recent runs -> recentRoi7d omitted, recentRoi30d = 0.
  assert.equal(byName.get('Beta Trainer (trainer)')!.recentRoi7d, undefined);
  assert.equal(byName.get('Steady Jockey (jockey)')!.recentRoi30d, 0);
});

test('fetchRacingApiSignals: honours maxTrainers / maxJockeys caps', async () => {
  const onlyTopTrainer = await fetchRacingApiSignals(
    { now: NOW, maxTrainers: 1, maxJockeys: 0 },
    makeFakeClient(),
  );
  assert.equal(onlyTopTrainer.length, 1);
  assert.equal(onlyTopTrainer[0].name, 'Alpha Trainer (trainer)'); // most runners
});

test('fetchRacingApiSignals: shortWindowDays=null omits the 7d signal entirely', async () => {
  const signals = await fetchRacingApiSignals(
    { now: NOW, shortWindowDays: null, maxJockeys: 0 },
    makeFakeClient(),
  );
  for (const s of signals) {
    assert.equal(s.recentRoi7d, undefined);
  }
});

test('createRacingApiClient: real client is constructable without credentials', () => {
  // Construction must not touch env (lazy); only a real request would validate.
  assert.equal(typeof createRacingApiClient().getFreeRacecards, 'function');
});
