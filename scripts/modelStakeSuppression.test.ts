/**
 * Unit tests for the stake-suppression safeguard (src/lib/modelStakeSuppression.ts).
 *
 * No DB or network. The suppression DECISION comes from `determineModelAdjustments`
 * (the single source of the `suppressStaking` rule); `applyStakeSuppression`
 * applies it by zeroing ONLY the selected bet's stake. These tests assert that
 * behaviour plus the strict invariants: selection identity, ranking, runner
 * order, and confidence are never touched. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyStakeSuppression } from '../src/lib/modelStakeSuppression';
import { determineModelAdjustments } from '../src/lib/modelDataQuality';

/** A scored-runner-like bet (mirrors the fields the producer carries). */
interface Bet {
  runner_id: string;
  stake: number;
  confidence: number;
  ev: number;
  rank: number;
}

function bet(over: Partial<Bet> = {}): Bet {
  return {
    runner_id: 'r1',
    stake: 5,
    confidence: 0.7,
    ev: 0.12,
    rank: 1,
    ...over,
  };
}

/** Derives the suppress flag exactly as the producer does. */
const suppress = (flags: string[]) =>
  determineModelAdjustments(flags).suppressStaking;

test('no flags -> stake unchanged', () => {
  const b = bet({ stake: 5 });
  applyStakeSuppression(b, suppress([]));
  assert.equal(b.stake, 5);
});

test('LOW_MARKET_COMPLETENESS -> stake becomes 0, selection unchanged', () => {
  const b = bet({ stake: 5 });
  const returned = applyStakeSuppression(b, suppress(['LOW_MARKET_COMPLETENESS']));
  assert.equal(b.stake, 0);
  // Same object back (selection identity preserved).
  assert.equal(returned, b);
  // Everything except stake is untouched.
  assert.equal(b.runner_id, 'r1');
  assert.equal(b.confidence, 0.7);
  assert.equal(b.ev, 0.12);
  assert.equal(b.rank, 1);
});

test('NO_PRICED_RUNNERS -> stake becomes 0', () => {
  const b = bet({ stake: 3 });
  applyStakeSuppression(b, suppress(['NO_PRICED_RUNNERS']));
  assert.equal(b.stake, 0);
});

test('multiple flags including a suppressor -> still suppressed', () => {
  const b = bet({ stake: 7 });
  applyStakeSuppression(
    b,
    suppress(['STALE_ODDS', 'LOW_MARKET_COMPLETENESS', 'NO_TIPSTER_SELECTIONS']),
  );
  assert.equal(b.stake, 0);
});

test('non-suppressing flags only -> stake unchanged (regression)', () => {
  const b = bet({ stake: 4 });
  // STALE_ODDS / MISSING_RUNNER_ODDS drive reduceConfidence, NOT suppressStaking.
  applyStakeSuppression(b, suppress(['STALE_ODDS', 'MISSING_RUNNER_ODDS']));
  assert.equal(b.stake, 4);
});

test('no topBet -> no change (no throw)', () => {
  assert.equal(applyStakeSuppression(undefined, true), undefined);
  assert.equal(applyStakeSuppression(undefined, false), undefined);
});

test('suppressStaking = false -> staking unchanged regardless of object', () => {
  const b = bet({ stake: 6 });
  applyStakeSuppression(b, false);
  assert.equal(b.stake, 6);
});

test('ranking + runner order unchanged across a field (only chosen bet stake zeroed)', () => {
  const field: Bet[] = [
    bet({ runner_id: 'a', stake: 5, rank: 1, confidence: 0.8 }),
    bet({ runner_id: 'b', stake: 0, rank: 2, confidence: 0.5 }),
    bet({ runner_id: 'c', stake: 0, rank: 3, confidence: 0.3 }),
  ];
  const topBet = field.find((s) => s.stake > 0); // 'a'
  applyStakeSuppression(topBet, suppress(['LOW_MARKET_COMPLETENESS']));

  // Order + ranks + confidence untouched; only 'a' stake zeroed.
  assert.deepEqual(
    field.map((f) => f.runner_id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    field.map((f) => f.rank),
    [1, 2, 3],
  );
  assert.deepEqual(
    field.map((f) => f.confidence),
    [0.8, 0.5, 0.3],
  );
  assert.equal(field[0].stake, 0);
});
