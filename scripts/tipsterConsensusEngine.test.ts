/**
 * Unit tests for the Tipster Consensus Engine (src/lib/tipsterConsensusEngine.ts).
 *
 * No network or DB. These lock the quality-weighted strength bands (incl. the two
 * dashboard examples), conflict handling, the favourite/value/outsider typing,
 * and the "<n> of <N> weighted tipsters support <runner>" display line.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConsensusEngineResult,
  classifyStrength,
  tipsterQualityWeight,
  DEFAULT_TIPSTER_WEIGHT,
  type ConsensusRunnerInput,
  type ConsensusSelectionInput,
} from '../src/lib/tipsterConsensusEngine';

/** Builds N selections on one runner from sequential tipster ids. */
function backers(runnerId: string, n: number, startAt = 0): ConsensusSelectionInput[] {
  return Array.from({ length: n }, (_, i) => ({ runner_id: runnerId, tipster_id: `t${startAt + i}` }));
}

test('dashboard example: Strong — 7 of 9 weighted tipsters support horse', () => {
  const runners: ConsensusRunnerInput[] = [
    { runner_id: 'A', odds: 3.0 },
    { runner_id: 'B', odds: 5.0 },
    { runner_id: 'C', odds: 9.0 },
  ];
  const selections = [
    ...backers('A', 7, 0), // 7 back A
    ...backers('B', 1, 7), // 1 backs B
    ...backers('C', 1, 8), // 1 backs C
  ];
  const r = buildConsensusEngineResult(runners, selections);
  assert.equal(r.strength, 'STRONG');
  assert.equal(r.supporters, 7);
  assert.equal(r.total_tipsters, 9);
  assert.equal(r.consensus_runner_id, 'A');
  assert.equal(r.detail, '7 of 9 weighted tipsters support runner A');
  assert.ok(r.weighted_share !== null && r.weighted_share > 0.7);
});

test('dashboard example: Weak — 3 of 12 weighted tipsters support horse', () => {
  const runners: ConsensusRunnerInput[] = Array.from({ length: 10 }, (_, i) => ({
    runner_id: String.fromCharCode(65 + i), // A..J
    odds: 4 + i,
  }));
  const selections = [
    ...backers('A', 3, 0), // 3 back A (the leader)
    // 9 tipsters each back their own distinct runner B..J
    ...Array.from({ length: 9 }, (_, i) => ({ runner_id: String.fromCharCode(66 + i), tipster_id: `s${i}` })),
  ];
  const r = buildConsensusEngineResult(runners, selections);
  assert.equal(r.strength, 'WEAK');
  assert.equal(r.supporters, 3);
  assert.equal(r.total_tipsters, 12);
  assert.equal(r.consensus_runner_id, 'A');
  assert.equal(r.detail, '3 of 12 weighted tipsters support runner A');
});

test('NONE: no matched selections yields No consensus', () => {
  const r = buildConsensusEngineResult(
    [{ runner_id: 'A' }, { runner_id: 'B' }],
    [{ runner_id: 'Z', tipster_id: 't1' }], // unmatched runner
  );
  assert.equal(r.strength, 'NONE');
  assert.equal(r.type, 'NONE');
  assert.equal(r.consensus_runner_id, null);
  assert.equal(r.weighted_share, null);
  assert.match(r.detail, /No tipster selections/);
});

test('MODERATE: solid majority but short of the strong gates', () => {
  const runners: ConsensusRunnerInput[] = [
    { runner_id: 'A', odds: 2.5 },
    { runner_id: 'B', odds: 3.5 },
  ];
  // 3 back A, 2 back B -> share 0.6 but margin 0.2 (< 0.25) -> MODERATE.
  const selections = [...backers('A', 3, 0), ...backers('B', 2, 3)];
  const r = buildConsensusEngineResult(runners, selections);
  assert.equal(r.strength, 'MODERATE');
  assert.equal(r.supporters, 3);
  assert.equal(r.total_tipsters, 5);
});

test('conflict: several runners backed with a small margin caps at MODERATE', () => {
  const runners: ConsensusRunnerInput[] = [
    { runner_id: 'A', odds: 3 },
    { runner_id: 'B', odds: 3 },
  ];
  // 6 back A, 5 back B -> share ~0.545, margin ~0.09 (< 0.15) -> conflict, MODERATE.
  const selections = [...backers('A', 6, 0), ...backers('B', 5, 6)];
  const r = buildConsensusEngineResult(runners, selections);
  assert.equal(r.conflict, true);
  assert.notEqual(r.strength, 'STRONG');
  assert.ok(r.reasons.some((x) => x.includes('conflicting selections')));
});

test('type: VALUE when the supported runner has a positive model edge', () => {
  const runners: ConsensusRunnerInput[] = [
    { runner_id: 'A', odds: 6, model_prob: 0.25, market_prob: 0.17 }, // edge +0.08
    { runner_id: 'B', odds: 2 },
  ];
  const r = buildConsensusEngineResult(runners, [...backers('A', 5, 0), ...backers('B', 1, 5)]);
  assert.equal(r.consensus_runner_id, 'A');
  assert.equal(r.type, 'VALUE');
  assert.ok(r.consensus_edge !== null && r.consensus_edge > 0.05);
});

test('type: FAVOURITE when consensus is the market favourite with no edge', () => {
  const runners: ConsensusRunnerInput[] = [
    { runner_id: 'A', odds: 2.0, model_prob: 0.5, market_prob: 0.5 }, // favourite, edge 0
    { runner_id: 'B', odds: 6.0 },
  ];
  const r = buildConsensusEngineResult(runners, [...backers('A', 4, 0), ...backers('B', 1, 4)]);
  assert.equal(r.type, 'FAVOURITE');
  assert.equal(r.is_market_favourite, true);
});

test('type: OUTSIDER when consensus is a longshot without edge', () => {
  const runners: ConsensusRunnerInput[] = [
    { runner_id: 'A', odds: 12.0, model_prob: 0.08, market_prob: 0.083 }, // longshot, ~0 edge
    { runner_id: 'B', odds: 2.0 },
  ];
  const r = buildConsensusEngineResult(runners, [...backers('A', 4, 0), ...backers('B', 1, 4)]);
  assert.equal(r.type, 'OUTSIDER');
  assert.equal(r.is_outsider, true);
  assert.equal(r.is_market_favourite, false);
});

test('quality weighting can flip the consensus leader vs raw counts', () => {
  const runners: ConsensusRunnerInput[] = [
    { runner_id: 'A', odds: 4 },
    { runner_id: 'B', odds: 5 },
  ];
  // 2 weak tipsters back A; 1 strong tipster backs B.
  const selections = [
    { runner_id: 'A', tipster_id: 'weak1' },
    { runner_id: 'A', tipster_id: 'weak2' },
    { runner_id: 'B', tipster_id: 'sharp' },
  ];
  const weights = new Map<string, number>([
    ['weak1', 0.2],
    ['weak2', 0.2],
    ['sharp', 1.0],
  ]);
  const weighted = buildConsensusEngineResult(runners, selections, { weights });
  assert.equal(weighted.consensus_runner_id, 'B'); // 1.0 > 0.4
  const unweighted = buildConsensusEngineResult(runners, selections);
  assert.equal(unweighted.consensus_runner_id, 'A'); // 2 backers > 1
});

test('runnerNames render the horse name in the detail line', () => {
  const r = buildConsensusEngineResult(
    [{ runner_id: 'A', odds: 3 }],
    backers('A', 3, 0),
    { runnerNames: { A: 'Galloping Major' } },
  );
  assert.equal(r.detail, '3 of 3 weighted tipsters support Galloping Major');
});

test('classifyStrength: gates behave as documented', () => {
  assert.equal(classifyStrength(0.8, 5, 0.5, false), 'STRONG');
  assert.equal(classifyStrength(0.8, 5, 0.5, true), 'MODERATE'); // conflict blocks strong
  assert.equal(classifyStrength(0.5, 2, 0.1, false), 'MODERATE');
  assert.equal(classifyStrength(0.3, 1, 0.3, false), 'WEAK');
  assert.equal(classifyStrength(0.9, 0, 0.9, false), 'NONE');
});

test('tipsterQualityWeight: bounded, ROI-monotone, neutral when unknown', () => {
  assert.equal(tipsterQualityWeight({}), DEFAULT_TIPSTER_WEIGHT);
  const strong = tipsterQualityWeight({ roi: 0.3, strike_rate: 0.3 });
  const weak = tipsterQualityWeight({ roi: -0.2, strike_rate: 0.1 });
  assert.ok(strong > weak);
  assert.ok(strong <= 1 && weak >= 0.1);
});
