/**
 * Unit tests for the model-persistence mappers (src/lib/modelPersistenceMapping.ts).
 *
 * No DB: synthetic scored runners verify that BOTH the canonical/display columns
 * and the older compatibility columns are populated from the same values, the
 * fair-odds / rank derivations, and null-safety. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildModelRunnerScoreFields,
  buildRecommendationFields,
  fairOddsFromProb,
  type ScoredRunnerLike,
} from '../src/lib/modelPersistenceMapping';

function scored(): ScoredRunnerLike[] {
  return [
    // runner b: highest model prob; runner a: highest market prob; c: top EV.
    { runner_id: 'a', odds: 3.0, market_prob: 0.5, model_prob: 0.3, edge: -0.2, ev: -0.1, confidence: 0.4, stake: 0, rank: 3 },
    { runner_id: 'b', odds: 5.0, market_prob: 0.3, model_prob: 0.45, edge: 0.15, ev: 0.25, confidence: 0.8, stake: 12.5, rank: 1 },
    { runner_id: 'c', odds: 8.0, market_prob: 0.2, model_prob: 0.25, edge: 0.05, ev: 0.1, confidence: 0.6, stake: 4, rank: 2 },
  ];
}

test('fairOddsFromProb: 1/p for usable probs, null otherwise', () => {
  assert.equal(fairOddsFromProb(0.25), 4);
  assert.equal(fairOddsFromProb(0.5), 2);
  assert.equal(fairOddsFromProb(0), null);
  assert.equal(fairOddsFromProb(-0.1), null);
  assert.equal(fairOddsFromProb(Number.NaN), null);
  assert.equal(fairOddsFromProb(Number.POSITIVE_INFINITY), null);
});

test('buildModelRunnerScoreFields: populates BOTH canonical + compatibility columns', () => {
  const rows = buildModelRunnerScoreFields(scored());
  const b = rows.find((r) => r.runner_id === 'b')!;

  // Canonical/display columns.
  assert.equal(b.odds, 5.0);
  assert.equal(b.market_probability, 0.3);
  assert.equal(b.model_probability, 0.45);
  assert.equal(b.fair_odds, 1 / 0.45);
  assert.equal(b.ev, 0.25);
  assert.equal(b.confidence, 0.8);
  assert.equal(b.confidence_label, 'high'); // >= 0.7
  assert.equal(b.stake, 12.5);

  // Compatibility columns carry the SAME underlying values.
  assert.equal(b.market_prob, b.market_probability);
  assert.equal(b.model_prob, b.model_probability);
  assert.equal(b.ev_per_1, b.ev);
  assert.equal(b.confidence_score, b.confidence);
  assert.equal(b.edge, 0.15);
  assert.equal(b.rank_in_race, 1);
});

test('buildModelRunnerScoreFields: market_rank / model_rank by probability desc', () => {
  const rows = buildModelRunnerScoreFields(scored());
  const byId = new Map(rows.map((r) => [r.runner_id, r]));

  // market_prob desc: a(0.5)=1, b(0.3)=2, c(0.2)=3
  assert.equal(byId.get('a')!.market_rank, 1);
  assert.equal(byId.get('b')!.market_rank, 2);
  assert.equal(byId.get('c')!.market_rank, 3);

  // model_prob desc: b(0.45)=1, a(0.3)=2, c(0.25)=3
  assert.equal(byId.get('b')!.model_rank, 1);
  assert.equal(byId.get('a')!.model_rank, 2);
  assert.equal(byId.get('c')!.model_rank, 3);

  // The EV-based rank_in_race is unchanged (selection logic untouched).
  assert.equal(byId.get('b')!.rank_in_race, 1);
  assert.equal(byId.get('c')!.rank_in_race, 2);
  assert.equal(byId.get('a')!.rank_in_race, 3);
});

test('buildModelRunnerScoreFields: null-safe fair_odds when model_prob is 0', () => {
  const rows = buildModelRunnerScoreFields([
    { runner_id: 'z', odds: 10, market_prob: 0.1, model_prob: 0, edge: -0.1, ev: -1, confidence: 0.2, stake: 0, rank: 1 },
  ]);
  assert.equal(rows[0].fair_odds, null);
  assert.equal(rows[0].confidence_label, 'low');
  // odds is still the real priced value, never derived.
  assert.equal(rows[0].odds, 10);
});

test('buildModelRunnerScoreFields: does not mutate its input', () => {
  const input = scored();
  const snapshot = JSON.parse(JSON.stringify(input));
  buildModelRunnerScoreFields(input);
  assert.deepEqual(input, snapshot);
});

test('buildRecommendationFields: populates BOTH canonical + compatibility columns', () => {
  const topBet = scored()[1]; // runner b
  const fields = buildRecommendationFields({ topBet, bankroll: 1000, baseKellyFraction: 0.2 });

  // Canonical/display.
  assert.equal(fields.rank, 1);
  assert.equal(fields.odds, 5.0);
  assert.equal(fields.market_probability, 0.3);
  assert.equal(fields.model_probability, 0.45);
  assert.equal(fields.fair_odds, 1 / 0.45);
  assert.equal(fields.ev, 0.25);
  assert.equal(fields.confidence, 0.8);
  assert.equal(fields.confidence_label, 'high');
  assert.equal(fields.stake, 12.5);

  // Compatibility.
  assert.equal(fields.recommendation_rank, 1);
  assert.equal(fields.stake_amount, 12.5);
  assert.equal(fields.stake_pct, (12.5 / 1000) * 100); // 1.25
  assert.equal(fields.kelly_fraction_used, 0.2);
  assert.equal(fields.mandatory_floor_applied, false);
  assert.equal(fields.daily_cap_restricted, false);
  assert.deepEqual(fields.rationale_json, {
    ev: 0.25,
    model_prob: 0.45,
    market_prob: 0.3,
    edge: 0.15,
    confidence: 0.8,
  });
});

test('buildRecommendationFields: stake_pct is 0 when bankroll is 0 (no div-by-zero)', () => {
  const topBet = scored()[1];
  const fields = buildRecommendationFields({ topBet, bankroll: 0, baseKellyFraction: 0.2 });
  assert.equal(fields.stake_pct, 0);
  assert.equal(fields.stake_amount, 12.5); // raw stake preserved
});

test('buildRecommendationFields: a suppressed (stake 0) bet still maps cleanly', () => {
  // After stake suppression, topBet.stake is 0 but the selection/identity stay.
  const topBet: ScoredRunnerLike = { ...scored()[1], stake: 0 };
  const fields = buildRecommendationFields({ topBet, bankroll: 1000, baseKellyFraction: 0.2 });
  assert.equal(fields.stake, 0);
  assert.equal(fields.stake_amount, 0);
  assert.equal(fields.stake_pct, 0);
  // Display values for the pick are still complete (not null).
  assert.equal(fields.odds, 5.0);
  assert.equal(fields.model_probability, 0.45);
  assert.equal(fields.confidence_label, 'high');
});
