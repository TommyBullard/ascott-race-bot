/**
 * Unit tests for the pure model performance maths (src/lib/modelPerformance.ts).
 *
 * No DB, no network: synthetic recommendation outcomes exercise the P/L, ROI,
 * strike-rate, average-EV, and settled/pending logic — including the safety
 * rules that pending races are never counted as losses and that a stake-0 or
 * priceless win is handled without fabrication. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeModelPerformance,
  type RecommendationOutcome,
} from '../src/lib/modelPerformance';

/** Builds an outcome with sensible defaults for terse test rows. */
function outcome(o: Partial<RecommendationOutcome> = {}): RecommendationOutcome {
  return { settled: true, won: false, odds: null, stake: null, ev: null, ...o };
}

test('empty input -> all zero, average_ev null (no settled races)', () => {
  const p = summarizeModelPerformance([]);
  assert.equal(p.recommendations_total, 0);
  assert.equal(p.settled_count, 0);
  assert.equal(p.pending_count, 0);
  assert.equal(p.winners, 0);
  assert.equal(p.losers, 0);
  assert.equal(p.strike_rate, 0);
  assert.equal(p.profit_loss, 0);
  assert.equal(p.roi, 0);
  assert.equal(p.average_ev, null);
  assert.equal(p.total_staked, 0);
  assert.equal(p.no_bet_races, 0);
});

test('winner profit: stake * (odds - 1), ROI over staked', () => {
  const p = summarizeModelPerformance([
    outcome({ settled: true, won: true, odds: 3.5, stake: 2 }),
  ]);
  assert.equal(p.settled_count, 1);
  assert.equal(p.winners, 1);
  assert.equal(p.losers, 0);
  assert.equal(p.strike_rate, 100);
  assert.equal(p.profit_loss, 5); // 2 * (3.5 - 1)
  assert.equal(p.total_staked, 2);
  assert.equal(p.roi, 250); // 5 / 2 * 100
});

test('loser loss: -stake', () => {
  const p = summarizeModelPerformance([
    outcome({ settled: true, won: false, odds: 3.5, stake: 2 }),
  ]);
  assert.equal(p.winners, 0);
  assert.equal(p.losers, 1);
  assert.equal(p.strike_rate, 0);
  assert.equal(p.profit_loss, -2);
  assert.equal(p.total_staked, 2);
  assert.equal(p.roi, -100);
});

test('pending ignored: never a loss, only counts toward total/pending', () => {
  const p = summarizeModelPerformance([
    outcome({ settled: false, won: false, odds: 3.5, stake: 2 }),
  ]);
  assert.equal(p.recommendations_total, 1);
  assert.equal(p.settled_count, 0);
  assert.equal(p.pending_count, 1);
  assert.equal(p.winners, 0);
  assert.equal(p.losers, 0);
  assert.equal(p.profit_loss, 0);
  assert.equal(p.total_staked, 0);
  assert.equal(p.roi, 0);
  assert.equal(p.strike_rate, 0);
});

test('zero stake winner: counts as a win but no P/L and no ROI div-by-zero', () => {
  const p = summarizeModelPerformance([
    outcome({ settled: true, won: true, odds: 5, stake: 0 }),
  ]);
  assert.equal(p.winners, 1);
  assert.equal(p.strike_rate, 100);
  assert.equal(p.profit_loss, 0);
  assert.equal(p.total_staked, 0);
  assert.equal(p.roi, 0); // no settled stake -> 0, not NaN/Infinity
});

test('null/negative stake is treated as 0 (never negative staking)', () => {
  const p = summarizeModelPerformance([
    outcome({ settled: true, won: false, stake: null }),
    outcome({ settled: true, won: false, stake: -5 }),
  ]);
  assert.equal(p.losers, 2);
  assert.equal(p.profit_loss, 0);
  assert.equal(p.total_staked, 0);
});

test('winning pick with no usable odds returns 0 (no fabrication) but counts as a win', () => {
  const p = summarizeModelPerformance([
    outcome({ settled: true, won: true, odds: null, stake: 2 }),
    outcome({ settled: true, won: true, odds: 1, stake: 2 }), // odds <= 1 is not a real price
  ]);
  assert.equal(p.winners, 2);
  assert.equal(p.strike_rate, 100);
  assert.equal(p.profit_loss, 0);
  assert.equal(p.total_staked, 4);
  assert.equal(p.roi, 0);
});

test('mixed settled/pending: aggregates correctly, pending excluded from P/L', () => {
  const p = summarizeModelPerformance([
    outcome({ settled: true, won: true, odds: 4, stake: 1, ev: 0.2 }), // +3
    outcome({ settled: true, won: false, odds: 2, stake: 1, ev: -0.1 }), // -1
    outcome({ settled: false, won: false, odds: 3, stake: 1, ev: 0.3 }), // pending
  ]);
  assert.equal(p.recommendations_total, 3);
  assert.equal(p.settled_count, 2);
  assert.equal(p.pending_count, 1);
  assert.equal(p.winners, 1);
  assert.equal(p.losers, 1);
  assert.equal(p.strike_rate, 50);
  assert.equal(p.profit_loss, 2); // +3 - 1
  assert.equal(p.total_staked, 2); // settled stakes only
  assert.equal(p.roi, 100); // 2 / 2 * 100
});

test('average_ev: mean over finite EVs only, across settled AND pending', () => {
  const p = summarizeModelPerformance([
    outcome({ settled: true, won: true, odds: 2, stake: 1, ev: 0.1 }),
    outcome({ settled: false, ev: 0.3 }), // pending still contributes its EV
    outcome({ settled: true, won: false, stake: 1, ev: null }), // null EV ignored
  ]);
  assert.ok(p.average_ev !== null);
  assert.ok(Math.abs((p.average_ev as number) - 0.2) < 1e-9); // (0.1 + 0.3) / 2
});

test('average_ev: null when no finite EVs present', () => {
  const p = summarizeModelPerformance([
    outcome({ settled: true, won: true, odds: 2, stake: 1, ev: null }),
  ]);
  assert.equal(p.average_ev, null);
});

test('no_bet_races passthrough is reported verbatim', () => {
  const p = summarizeModelPerformance(
    [outcome({ settled: true, won: true, odds: 2, stake: 1 })],
    4,
  );
  assert.equal(p.no_bet_races, 4);
});

test('strike rate uses settled count as the denominator (not total)', () => {
  const p = summarizeModelPerformance([
    outcome({ settled: true, won: true, odds: 2, stake: 1 }),
    outcome({ settled: true, won: false, stake: 1 }),
    outcome({ settled: false }), // pending excluded from strike denominator
    outcome({ settled: false }),
  ]);
  assert.equal(p.settled_count, 2);
  assert.equal(p.strike_rate, 50); // 1 / 2, NOT 1 / 4
});
