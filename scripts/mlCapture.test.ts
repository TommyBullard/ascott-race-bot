/**
 * Unit tests for ML training-capture (src/lib/mlCapture.ts) after the
 * settlement -> capture DECOUPLING.
 *
 * No DB: the watermark decision is the PURE selectUncapturedRaceIds, the row
 * construction is the PURE buildExamplesForCard, and the orchestrator
 * captureTrainingExamples is driven by injected fake CaptureDeps. Covers the
 * required cases: watermark skip, force recapture, settlement gate, model-run
 * gate, per-race isolation, and idempotency. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectUncapturedRaceIds,
  buildExamplesForCard,
  captureTrainingExamples,
  type CaptureDeps,
} from '../src/lib/mlCapture';
import type { RaceCard, RaceCardRunner } from '../src/lib/raceData';
import type { TrainingExample } from '../src/lib/mlTrainingExample';

/* ------------------------------- fixtures -------------------------------- */

type Prices = Map<string, { bsp: number | null; sp: number | null }>;

function makeRunner(id: string, finishPos: number | null): RaceCardRunner {
  return {
    runner_id: id,
    horse_name: `H-${id}`,
    odds: 3,
    market_prob: 0.3,
    model_prob: 0.35,
    edge: 0.05,
    ev: 0.1,
    confidence_score: 0.6,
    rank: 1,
    finish_pos: finishPos,
  };
}

function makeCard(opts: {
  raceId: string;
  status: string | null;
  hasModelRun: boolean;
  runners: RaceCardRunner[];
  modelPickId?: string | null;
  favouriteId?: string | null;
}): RaceCard {
  const pick = opts.modelPickId ? opts.runners.find((r) => r.runner_id === opts.modelPickId) ?? null : null;
  const fav = opts.favouriteId ? opts.runners.find((r) => r.runner_id === opts.favouriteId) ?? null : null;
  return {
    race_id: opts.raceId,
    off_time: '2026-06-18T14:00:00.000Z',
    course: 'Ascot',
    race_name: 'Test Stakes',
    favourite: fav,
    modelPick: pick
      ? { ...pick, confidence_label: 'Strong', stake_amount: 1, stake_pct: 1, rationale: null, isFavourite: false }
      : null,
    alternatives: [],
    runners: opts.runners,
    hasModelRun: opts.hasModelRun,
    latestOddsSnapshotTime: null,
    latestModelRunTime: null,
    status: opts.status,
    result_time: null,
  } as unknown as RaceCard;
}

interface DepCalls {
  fetchCard: string[];
  upsert: TrainingExample[][];
  fetchCapturedCalled: boolean;
}

function makeDeps(config: {
  raceIds: string[];
  captured?: string[];
  cards: Map<string, RaceCard | Error>;
}): { deps: CaptureDeps; calls: DepCalls } {
  const calls: DepCalls = { fetchCard: [], upsert: [], fetchCapturedCalled: false };
  const deps: CaptureDeps = {
    fetchRaceIds: async () => [...config.raceIds],
    fetchCapturedRaceIds: async () => {
      calls.fetchCapturedCalled = true;
      return new Set(config.captured ?? []);
    },
    fetchCard: async (id) => {
      calls.fetchCard.push(id);
      const c = config.cards.get(id);
      if (c instanceof Error) throw c;
      if (!c) throw new Error(`no card for ${id}`);
      return c;
    },
    fetchPrices: async (): Promise<Prices> => new Map(),
    upsertExamples: async (rows) => {
      calls.upsert.push(rows);
    },
  };
  return { deps, calls };
}

const settledCard = (raceId: string) =>
  makeCard({
    raceId,
    status: 'result',
    hasModelRun: true,
    runners: [makeRunner(`${raceId}a`, 1), makeRunner(`${raceId}b`, 3)],
    modelPickId: `${raceId}a`,
    favouriteId: `${raceId}a`,
  });

/* ------------------------- pure: watermark select ------------------------ */

test('selectUncapturedRaceIds: nothing captured -> all, order preserved', () => {
  assert.deepEqual(selectUncapturedRaceIds(['a', 'b', 'c'], new Set()), ['a', 'b', 'c']);
});

test('selectUncapturedRaceIds: skips already-captured ids', () => {
  assert.deepEqual(selectUncapturedRaceIds(['a', 'b', 'c'], new Set(['b'])), ['a', 'c']);
});

test('selectUncapturedRaceIds: all captured -> empty', () => {
  assert.deepEqual(selectUncapturedRaceIds(['a', 'b', 'c'], new Set(['a', 'b', 'c'])), []);
});

test('selectUncapturedRaceIds: force ignores the watermark -> all', () => {
  assert.deepEqual(selectUncapturedRaceIds(['a', 'b'], new Set(['a', 'b']), true), ['a', 'b']);
});

test('selectUncapturedRaceIds: empty input -> empty', () => {
  assert.deepEqual(selectUncapturedRaceIds([], new Set(['x'])), []);
});

/* ------------------------ pure: buildExamplesForCard --------------------- */

test('buildExamplesForCard: recommended + is_favourite + won flags are correct', () => {
  const runners = [makeRunner('r1', 1), makeRunner('r2', 3)];
  const card = makeCard({ raceId: 'R', status: 'result', hasModelRun: true, runners, modelPickId: 'r1', favouriteId: 'r2' });
  const examples = buildExamplesForCard(card, new Map());

  const e1 = examples.find((e) => e.runner_id === 'r1')!;
  const e2 = examples.find((e) => e.runner_id === 'r2')!;

  assert.equal(e1.recommended, true);
  assert.equal(e1.is_favourite, false);
  assert.equal(e1.won, true); // finished 1st

  assert.equal(e2.recommended, false);
  assert.equal(e2.is_favourite, true);
  assert.equal(e2.won, false); // finished 3rd
});

test('buildExamplesForCard: favourite_won is stamped on every row', () => {
  // Favourite (r1) WON -> favourite_won true for all rows.
  const wonRunners = [makeRunner('r1', 1), makeRunner('r2', 2)];
  const wonCard = makeCard({ raceId: 'R', status: 'result', hasModelRun: true, runners: wonRunners, modelPickId: 'r2', favouriteId: 'r1' });
  for (const e of buildExamplesForCard(wonCard, new Map())) assert.equal(e.favourite_won, true);

  // Favourite (r1) BEATEN -> favourite_won false for all rows.
  const lostRunners = [makeRunner('r1', 4), makeRunner('r2', 1)];
  const lostCard = makeCard({ raceId: 'R', status: 'result', hasModelRun: true, runners: lostRunners, modelPickId: 'r2', favouriteId: 'r1' });
  for (const e of buildExamplesForCard(lostCard, new Map())) assert.equal(e.favourite_won, false);
});

/* --------------------- orchestrator: captureTrainingExamples -------------- */

test('captureTrainingExamples: settled + uncaptured -> captured', async () => {
  const { deps, calls } = makeDeps({ raceIds: ['r1'], captured: [], cards: new Map([['r1', settledCard('r1')]]) });
  const summary = await captureTrainingExamples('2026-06-18', {}, deps);

  assert.equal(summary.racesConsidered, 1);
  assert.equal(summary.racesSkipped, 0);
  assert.equal(summary.racesCaptured, 1);
  assert.equal(summary.examplesWritten, 2);
  assert.deepEqual(calls.fetchCard, ['r1']);
  assert.equal(calls.upsert.length, 1);
  assert.equal(calls.upsert[0].length, 2);
});

test('captureTrainingExamples: already-captured race is skipped (no fetch, no upsert)', async () => {
  const { deps, calls } = makeDeps({ raceIds: ['r1'], captured: ['r1'], cards: new Map([['r1', settledCard('r1')]]) });
  const summary = await captureTrainingExamples('2026-06-18', {}, deps);

  assert.equal(summary.racesConsidered, 1);
  assert.equal(summary.racesSkipped, 1);
  assert.equal(summary.racesCaptured, 0);
  assert.equal(summary.examplesWritten, 0);
  assert.deepEqual(calls.fetchCard, []); // watermark short-circuits the work
  assert.equal(calls.upsert.length, 0);
});

test('captureTrainingExamples: mixed batch captures only the uncaptured race', async () => {
  const { deps, calls } = makeDeps({
    raceIds: ['r1', 'r2'],
    captured: ['r1'],
    cards: new Map<string, RaceCard | Error>([
      ['r1', settledCard('r1')],
      ['r2', settledCard('r2')],
    ]),
  });
  const summary = await captureTrainingExamples('2026-06-18', {}, deps);

  assert.equal(summary.racesConsidered, 2);
  assert.equal(summary.racesSkipped, 1);
  assert.equal(summary.racesCaptured, 1);
  assert.deepEqual(calls.fetchCard, ['r2']); // r1 skipped by watermark
});

test('captureTrainingExamples: force re-captures already-captured (skips watermark read)', async () => {
  const { deps, calls } = makeDeps({ raceIds: ['r1'], captured: ['r1'], cards: new Map([['r1', settledCard('r1')]]) });
  const summary = await captureTrainingExamples('2026-06-18', { force: true }, deps);

  assert.equal(summary.racesSkipped, 0);
  assert.equal(summary.racesCaptured, 1);
  assert.equal(calls.fetchCapturedCalled, false); // force never reads the watermark
  assert.deepEqual(calls.fetchCard, ['r1']);
  assert.equal(calls.upsert.length, 1);
});

test('captureTrainingExamples: unsettled race (status != result) is skipped', async () => {
  const card = makeCard({ raceId: 'r1', status: 'open', hasModelRun: true, runners: [makeRunner('r1a', null)], modelPickId: 'r1a', favouriteId: 'r1a' });
  const { deps, calls } = makeDeps({ raceIds: ['r1'], captured: [], cards: new Map([['r1', card]]) });
  const summary = await captureTrainingExamples('2026-06-18', {}, deps);

  assert.equal(summary.racesCaptured, 0);
  assert.equal(calls.upsert.length, 0);
});

test('captureTrainingExamples: race without a model run is skipped', async () => {
  const card = makeCard({ raceId: 'r1', status: 'result', hasModelRun: false, runners: [makeRunner('r1a', 1)], modelPickId: null, favouriteId: 'r1a' });
  const { deps, calls } = makeDeps({ raceIds: ['r1'], captured: [], cards: new Map([['r1', card]]) });
  const summary = await captureTrainingExamples('2026-06-18', {}, deps);

  assert.equal(summary.racesCaptured, 0);
  assert.equal(calls.upsert.length, 0);
});

test('captureTrainingExamples: a per-race failure is isolated', async () => {
  const { deps, calls } = makeDeps({
    raceIds: ['bad', 'good'],
    captured: [],
    cards: new Map<string, RaceCard | Error>([
      ['bad', new Error('boom')],
      ['good', settledCard('good')],
    ]),
  });
  const summary = await captureTrainingExamples('2026-06-18', {}, deps);

  assert.equal(summary.racesConsidered, 2);
  assert.equal(summary.racesCaptured, 1); // the good race still captured
  assert.equal(calls.upsert.length, 1);
});

test('captureTrainingExamples: deterministic rows (idempotent upsert payload)', async () => {
  const cards = () => new Map<string, RaceCard | Error>([['r1', settledCard('r1')]]);
  const first = makeDeps({ raceIds: ['r1'], captured: [], cards: cards() });
  const second = makeDeps({ raceIds: ['r1'], captured: [], cards: cards() });

  await captureTrainingExamples('2026-06-18', {}, first.deps);
  await captureTrainingExamples('2026-06-18', {}, second.deps);

  // Same inputs -> identical upsert payload, so the (race_id,runner_id) upsert
  // refreshes the same rows rather than duplicating.
  assert.deepEqual(first.calls.upsert[0], second.calls.upsert[0]);
});
