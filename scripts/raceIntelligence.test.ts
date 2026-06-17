/**
 * Unit tests for the pure, display-only Race Intelligence module
 * (src/lib/raceIntelligence.ts) plus read-only source-scan guards on the panel
 * + dashboard wiring.
 *
 * The derivations are pure and deterministic, so no DB / network is needed. The
 * source scans lock down the task's safety rules: this shadow layer never writes
 * to the DB, never places bets, never exposes `--commit`, and never imports or
 * changes the model / staking / ranking engines. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EACH_WAY_MIN_ODDS,
  EACH_WAY_MAX_ODDS,
  EACH_WAY_MIN_RANK,
  EACH_WAY_MAX_RANK,
  LARGE_FIELD_THRESHOLD,
  MODEL_PROB_UNAVAILABLE_WARNING,
  NO_WIN_VALUE_WARNING,
  NO_EACH_WAY_WARNING,
  EACH_WAY_DISCLAIMER,
  deriveMostLikelyWinner,
  deriveWinValueCandidate,
  deriveEachWayCandidate,
  formatFinishPosition,
  buildRaceIntelligence,
  type RaceIntelRunner,
} from '../src/lib/raceIntelligence';

/** Em dash the module uses for unknown / not-applicable values. */
const DASH = '\u2014';

/** Build a runner with sensible null defaults; override only what a test needs. */
function runner(over: Partial<RaceIntelRunner> & { runner_id: string }): RaceIntelRunner {
  return {
    horse_name: `Horse ${over.runner_id}`,
    odds: null,
    market_prob: null,
    model_prob: null,
    ev: null,
    confidence_score: null,
    rank: null,
    finish_pos: null,
    ...over,
  };
}

/* --------------------------- most likely winner --------------------------- */

test('deriveMostLikelyWinner: picks the highest model_prob runner', () => {
  const runners = [
    runner({ runner_id: 'a', model_prob: 0.30, rank: 2 }),
    runner({ runner_id: 'b', model_prob: 0.50, rank: 1 }),
    runner({ runner_id: 'c', model_prob: 0.20, rank: 3 }),
  ];
  const got = deriveMostLikelyWinner(runners, null);
  assert.equal(got?.runner.runner_id, 'b');
  assert.equal(got?.basis, 'model_prob');
});

test('deriveMostLikelyWinner: falls back to market favourite when no model_prob', () => {
  const runners = [runner({ runner_id: 'a' }), runner({ runner_id: 'b' })];
  const fav = runner({ runner_id: 'fav', odds: 2.5 });
  const got = deriveMostLikelyWinner(runners, fav);
  assert.equal(got?.runner.runner_id, 'fav');
  assert.equal(got?.basis, 'market_favourite');
});

test('deriveMostLikelyWinner: null when neither model_prob nor favourite exist', () => {
  assert.equal(deriveMostLikelyWinner([runner({ runner_id: 'a' })], null), null);
  assert.equal(deriveMostLikelyWinner([], null), null);
});

test('deriveMostLikelyWinner: ties break by lower rank (order-independent)', () => {
  const a = runner({ runner_id: 'a', model_prob: 0.5, rank: 2 });
  const b = runner({ runner_id: 'b', model_prob: 0.5, rank: 1 });
  assert.equal(deriveMostLikelyWinner([a, b], null)?.runner.runner_id, 'b');
  assert.equal(deriveMostLikelyWinner([b, a], null)?.runner.runner_id, 'b');
});

/* ---------------------------- win-value candidate ------------------------- */

test('deriveWinValueCandidate: picks the highest strictly-positive EV', () => {
  const runners = [
    runner({ runner_id: 'a', ev: 0.10, rank: 1 }),
    runner({ runner_id: 'b', ev: 0.30, rank: 2 }),
    runner({ runner_id: 'c', ev: -0.20, rank: 3 }),
  ];
  assert.equal(deriveWinValueCandidate(runners)?.runner_id, 'b');
});

test('deriveWinValueCandidate: null when no runner has positive EV', () => {
  const runners = [
    runner({ runner_id: 'a', ev: 0 }),
    runner({ runner_id: 'b', ev: -0.1 }),
    runner({ runner_id: 'c', ev: null }),
  ];
  assert.equal(deriveWinValueCandidate(runners), null);
});

/* --------------------------- each-way candidate --------------------------- */

test('deriveEachWayCandidate: best mid-priced, top-5, positive-EV non-favourite by EV', () => {
  const runners = [
    runner({ runner_id: 'fav', ev: 0.4, rank: 1, odds: 6 }), // favourite -> excluded
    runner({ runner_id: 'b', ev: 0.20, rank: 2, odds: 6 }),
    runner({ runner_id: 'c', ev: 0.30, rank: 3, odds: 8 }),
    runner({ runner_id: 'd', ev: 0.50, rank: 6, odds: 9 }), // rank too high -> excluded
  ];
  const got = deriveEachWayCandidate(runners, 'fav');
  assert.equal(got?.runner_id, 'c'); // highest EV within the qualifying pool
});

test('deriveEachWayCandidate: excludes the favourite, rank-1, out-of-band odds, non-positive EV', () => {
  const favOnly = [runner({ runner_id: 'fav', ev: 0.3, rank: 2, odds: 6 })];
  assert.equal(deriveEachWayCandidate(favOnly, 'fav'), null); // only runner is the favourite

  const rank1 = [runner({ runner_id: 'a', ev: 0.3, rank: 1, odds: 6 })];
  assert.equal(deriveEachWayCandidate(rank1, null), null); // rank below EACH_WAY_MIN_RANK

  const shortPriced = [runner({ runner_id: 'a', ev: 0.3, rank: 2, odds: 2.0 })];
  assert.equal(deriveEachWayCandidate(shortPriced, null), null); // below odds band

  const longPriced = [runner({ runner_id: 'a', ev: 0.3, rank: 2, odds: 40 })];
  assert.equal(deriveEachWayCandidate(longPriced, null), null); // above odds band

  const noEv = [runner({ runner_id: 'a', ev: 0, rank: 2, odds: 6 })];
  assert.equal(deriveEachWayCandidate(noEv, null), null); // EV not positive
});

test('deriveEachWayCandidate: odds band boundaries are inclusive', () => {
  const atMin = [runner({ runner_id: 'a', ev: 0.2, rank: 2, odds: EACH_WAY_MIN_ODDS })];
  const atMax = [runner({ runner_id: 'b', ev: 0.2, rank: 3, odds: EACH_WAY_MAX_ODDS })];
  assert.equal(deriveEachWayCandidate(atMin, null)?.runner_id, 'a');
  assert.equal(deriveEachWayCandidate(atMax, null)?.runner_id, 'b');
});

test('each-way rank window matches the exported constants', () => {
  assert.equal(EACH_WAY_MIN_RANK, 2);
  assert.equal(EACH_WAY_MAX_RANK, 5);
  assert.ok(EACH_WAY_MIN_ODDS < EACH_WAY_MAX_ODDS);
});

/* --------------------------- finish position ------------------------------ */

test('formatFinishPosition: ordinals + dash for missing/invalid', () => {
  assert.equal(formatFinishPosition(1), '1st');
  assert.equal(formatFinishPosition(2), '2nd');
  assert.equal(formatFinishPosition(3), '3rd');
  assert.equal(formatFinishPosition(4), '4th');
  assert.equal(formatFinishPosition(11), '11th');
  assert.equal(formatFinishPosition(12), '12th');
  assert.equal(formatFinishPosition(13), '13th');
  assert.equal(formatFinishPosition(21), '21st');
  assert.equal(formatFinishPosition(22), '22nd');
  assert.equal(formatFinishPosition(23), '23rd');
  assert.equal(formatFinishPosition(1.0), '1st');
  assert.equal(formatFinishPosition(0), DASH);
  assert.equal(formatFinishPosition(-1), DASH);
  assert.equal(formatFinishPosition(null), DASH);
  assert.equal(formatFinishPosition(undefined), DASH);
  assert.equal(formatFinishPosition(Number.NaN), DASH);
});

/* --------------------------- buildRaceIntelligence ------------------------ */

test('buildRaceIntelligence: assembles candidates + isModelPick flags', () => {
  const runners = [
    runner({ runner_id: 'fav', model_prob: 0.45, ev: 0.05, rank: 1, odds: 2.2 }),
    runner({ runner_id: 'b', model_prob: 0.20, ev: 0.35, rank: 2, odds: 6 }),
    runner({ runner_id: 'c', model_prob: 0.15, ev: 0.10, rank: 3, odds: 9 }),
  ];
  const fav = runners[0];
  const intel = buildRaceIntelligence({
    runners,
    favourite: fav,
    modelPickRunnerId: 'fav',
    settled: false,
  });

  assert.equal(intel.mostLikelyWinner?.runner_id, 'fav'); // highest model_prob
  assert.equal(intel.mostLikelyWinner?.isModelPick, true);
  assert.equal(intel.winValueCandidate?.runner_id, 'b'); // highest positive EV
  assert.equal(intel.winValueCandidate?.isModelPick, false);
  assert.equal(intel.eachWayCandidate?.runner_id, 'b'); // best EW-pool by EV
  assert.equal(intel.marketFavourite?.runner_id, 'fav');
});

test('buildRaceIntelligence: missing data -> null candidates + data warnings', () => {
  const intel = buildRaceIntelligence({
    runners: [],
    favourite: null,
    modelPickRunnerId: null,
    settled: false,
  });
  assert.equal(intel.mostLikelyWinner, null);
  assert.equal(intel.winValueCandidate, null);
  assert.equal(intel.eachWayCandidate, null);
  assert.equal(intel.marketFavourite, null);
  assert.ok(intel.warnings.includes(NO_WIN_VALUE_WARNING));
  assert.ok(intel.warnings.includes(NO_EACH_WAY_WARNING));
});

test('buildRaceIntelligence: favourite fallback adds the model-prob-unavailable warning', () => {
  const fav = runner({ runner_id: 'fav', odds: 3.0 });
  const intel = buildRaceIntelligence({
    runners: [runner({ runner_id: 'a', ev: 0.2, rank: 2, odds: 6 })],
    favourite: fav,
    modelPickRunnerId: null,
    settled: false,
  });
  assert.equal(intel.mostLikelyWinner?.runner_id, 'fav');
  assert.ok(intel.warnings.includes(MODEL_PROB_UNAVAILABLE_WARNING));
});

test('buildRaceIntelligence: settled race surfaces finishing positions (else null)', () => {
  const runners = [
    runner({ runner_id: 'a', model_prob: 0.5, ev: 0.3, rank: 2, odds: 6, finish_pos: 1 }),
  ];
  const settled = buildRaceIntelligence({
    runners,
    favourite: null,
    modelPickRunnerId: null,
    settled: true,
  });
  assert.equal(settled.mostLikelyWinner?.finish_pos, 1);
  assert.equal(formatFinishPosition(settled.mostLikelyWinner?.finish_pos ?? null), '1st');

  const live = buildRaceIntelligence({
    runners,
    favourite: null,
    modelPickRunnerId: null,
    settled: false,
  });
  assert.equal(live.mostLikelyWinner?.finish_pos, null); // not shown pre-settlement
});

test('buildRaceIntelligence: large field adds a volatility warning', () => {
  const runners = Array.from({ length: LARGE_FIELD_THRESHOLD }, (_, i) =>
    runner({ runner_id: `r${i}`, model_prob: 0.1, ev: -0.1, rank: i + 1, odds: 5 }),
  );
  const intel = buildRaceIntelligence({
    runners,
    favourite: null,
    modelPickRunnerId: null,
    settled: false,
  });
  assert.ok(intel.warnings.some((w) => w.includes('Larger field')));
});

test('the model pick is never changed: modelPickRunnerId only sets the comparison flag', () => {
  const runners = [
    runner({ runner_id: 'a', model_prob: 0.6, ev: 0.1, rank: 1, odds: 2 }),
    runner({ runner_id: 'b', model_prob: 0.2, ev: 0.5, rank: 2, odds: 6 }),
  ];
  const asA = buildRaceIntelligence({ runners, favourite: runners[0], modelPickRunnerId: 'a', settled: false });
  const asB = buildRaceIntelligence({ runners, favourite: runners[0], modelPickRunnerId: 'b', settled: false });
  // Same derived runners regardless of which is flagged as the model pick.
  assert.equal(asA.mostLikelyWinner?.runner_id, asB.mostLikelyWinner?.runner_id);
  assert.equal(asA.winValueCandidate?.runner_id, asB.winValueCandidate?.runner_id);
  // Only the isModelPick flag moves.
  assert.equal(asA.mostLikelyWinner?.isModelPick, true); // 'a' is highest prob + the pick
  assert.equal(asB.mostLikelyWinner?.isModelPick, false);
  assert.equal(asB.winValueCandidate?.isModelPick, true); // 'b' is highest EV + the pick
});

test('buildRaceIntelligence is deterministic for identical inputs', () => {
  const runners = [
    runner({ runner_id: 'a', model_prob: 0.4, ev: 0.2, rank: 2, odds: 6 }),
    runner({ runner_id: 'b', model_prob: 0.3, ev: 0.1, rank: 3, odds: 9 }),
  ];
  const input = { runners, favourite: runners[0], modelPickRunnerId: 'a', settled: true };
  assert.deepEqual(buildRaceIntelligence(input), buildRaceIntelligence(input));
});

/* --------------------- read-only guards (source scans) -------------------- */

test('the intelligence module is pure: no imports, DB, fs, env, network, or engines', () => {
  const lib = readFileSync('src/lib/raceIntelligence.ts', 'utf8');
  // Zero imports keeps it a dependency-free, display-only derivation helper.
  assert.equal(/^\s*import\s/m.test(lib), false);
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs/.test(lib), false);
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/\bfetch\s*\(/.test(lib), false);
  // Never pulls in model/staking/ranking logic (it only READS stored fields).
  assert.equal(/bettingEngine|modelProbabilities|kellyStake|scoreRaceRunners/.test(lib), false);
});

test('the intelligence module + panel never place bets or expose --commit', () => {
  const lib = readFileSync('src/lib/raceIntelligence.ts', 'utf8');
  const panel = readFileSync('src/components/RaceIntelligencePanel.tsx', 'utf8');
  for (const src of [lib, panel]) {
    assert.equal(/placeOrder|placeBet|placeOrders|submitOrder|sendOrder/i.test(src), false);
    assert.equal(/--commit/.test(src), false);
  }
});

test('the intelligence panel is presentational: no fetch, DB, or write methods', () => {
  const panel = readFileSync('src/components/RaceIntelligencePanel.tsx', 'utf8');
  assert.equal(/\bfetch\s*\(/.test(panel), false);
  assert.equal(/supabaseAdmin/.test(panel), false);
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(panel), false);
  assert.equal(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(panel), false);
});

test('the dashboard renders the read-only Race Intelligence panel', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.match(page, /RaceIntelligencePanel/);
  assert.match(page, /buildRaceIntelligence/);
  // The dashboard still performs no DB writes (re-asserted for this wiring).
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(page), false);
});

test('the read layer surfaces finish positions read-only (settled-gated select only)', () => {
  const rd = readFileSync('src/lib/raceData.ts', 'utf8');
  // fetchRaceCard reads finish_pos via a plain select; it never writes here.
  assert.match(rd, /\.select\('id, finish_pos'\)/);
  assert.match(rd, /card\.runners = scores\.map\(toRunner\)/);
});
