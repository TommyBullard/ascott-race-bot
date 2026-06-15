/**
 * Unit tests for the observational tipster-consensus builder
 * (src/lib/modelTipsterConsensus.ts).
 *
 * No DB or network: synthetic runner IDs + selections. These lock down match vs
 * unmatched counting, support_share math (no divide-by-zero), deterministic
 * consensus + tie-breaking, and stable output ordering. The helper is purely
 * observational \u2014 it never feeds probabilities/selection/staking. Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTipsterConsensus,
  buildTipsterModelAlignment,
  buildTipsterConsensusSummary,
  type TipsterConsensusSelection,
} from '../src/lib/modelTipsterConsensus';

const sel = (
  runner_id: string | number,
  tipster_id?: string | number,
): TipsterConsensusSelection => ({ runner_id, tipster_id });

test('no tipster selections -> zeros, no consensus, support_share 0 (no divide-by-zero)', () => {
  const r = buildTipsterConsensus({ runnerIds: ['a', 'b', 'c'], tipsterSelections: [] });
  assert.equal(r.total_tipster_selections, 0);
  assert.equal(r.matched_tipster_selections, 0);
  assert.equal(r.unmatched_tipster_selections, 0);
  assert.deepEqual(
    r.runner_support,
    [
      { runner_id: 'a', selection_count: 0, support_share: 0 },
      { runner_id: 'b', selection_count: 0, support_share: 0 },
      { runner_id: 'c', selection_count: 0, support_share: 0 },
    ],
  );
  assert.equal(r.consensus_runner_id, null);
  assert.equal(r.consensus_selection_count, 0);
  assert.equal(r.consensus_support_share, null);
});

test('all selections matched -> counts + support_share correct', () => {
  const r = buildTipsterConsensus({
    runnerIds: ['a', 'b', 'c'],
    tipsterSelections: [sel('a'), sel('a'), sel('b')],
  });
  assert.equal(r.total_tipster_selections, 3);
  assert.equal(r.matched_tipster_selections, 3);
  assert.equal(r.unmatched_tipster_selections, 0);
  assert.deepEqual(r.runner_support, [
    { runner_id: 'a', selection_count: 2, support_share: 2 / 3 },
    { runner_id: 'b', selection_count: 1, support_share: 1 / 3 },
    { runner_id: 'c', selection_count: 0, support_share: 0 },
  ]);
  assert.equal(r.consensus_runner_id, 'a');
  assert.equal(r.consensus_selection_count, 2);
  assert.equal(r.consensus_support_share, 2 / 3);
});

test('some selections unmatched -> counted separately, not forced onto runners', () => {
  const r = buildTipsterConsensus({
    runnerIds: ['a', 'b'],
    tipsterSelections: [sel('a'), sel('zzz'), sel('b'), sel('qqq')],
  });
  assert.equal(r.total_tipster_selections, 4);
  assert.equal(r.matched_tipster_selections, 2);
  assert.equal(r.unmatched_tipster_selections, 2);
  // support_share uses MATCHED as the denominator (not total).
  assert.deepEqual(r.runner_support, [
    { runner_id: 'a', selection_count: 1, support_share: 0.5 },
    { runner_id: 'b', selection_count: 1, support_share: 0.5 },
  ]);
});

test('consensus runner found = highest selection_count', () => {
  const r = buildTipsterConsensus({
    runnerIds: ['a', 'b', 'c'],
    tipsterSelections: [sel('b'), sel('b'), sel('b'), sel('a'), sel('c')],
  });
  assert.equal(r.consensus_runner_id, 'b');
  assert.equal(r.consensus_selection_count, 3);
  assert.equal(r.consensus_support_share, 3 / 5);
});

test('deterministic tie-breaking -> preserves runnerIds order (first wins)', () => {
  // 'b' and 'a' both have 1; runnerIds order is [b, a, c] -> 'b' wins.
  const r = buildTipsterConsensus({
    runnerIds: ['b', 'a', 'c'],
    tipsterSelections: [sel('a'), sel('b')],
  });
  assert.equal(r.consensus_runner_id, 'b');
  assert.equal(r.consensus_selection_count, 1);
  // Output order follows runnerIds, not selection order.
  assert.deepEqual(
    r.runner_support.map((s) => s.runner_id),
    ['b', 'a', 'c'],
  );
});

test('support_share sums to 1 across matched runners (within float tolerance)', () => {
  const r = buildTipsterConsensus({
    runnerIds: ['a', 'b', 'c', 'd'],
    tipsterSelections: [sel('a'), sel('a'), sel('b'), sel('c')],
  });
  const sum = r.runner_support.reduce((acc, s) => acc + s.support_share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `support_share sum ${sum} \u2248 1`);
});

test('numeric runner IDs are normalised to strings and matched correctly', () => {
  const r = buildTipsterConsensus({
    runnerIds: [1, 2, 3],
    tipsterSelections: [sel(1), sel(2), sel(2), sel(99)],
  });
  assert.equal(r.matched_tipster_selections, 3);
  assert.equal(r.unmatched_tipster_selections, 1);
  assert.equal(r.consensus_runner_id, '2');
  assert.deepEqual(
    r.runner_support.map((s) => s.runner_id),
    ['1', '2', '3'],
  );
});

test('stable output ordering: runner_support follows runnerIds even with duplicate runnerIds', () => {
  // Duplicate runnerId 'a' -> deduped, first position kept.
  const r = buildTipsterConsensus({
    runnerIds: ['a', 'b', 'a'],
    tipsterSelections: [sel('a'), sel('b')],
  });
  assert.deepEqual(
    r.runner_support.map((s) => s.runner_id),
    ['a', 'b'],
  );
  assert.equal(r.runner_support.length, 2);
});

// --- buildTipsterModelAlignment (Batch H2) ----------------------------------

const consensus = (id: string | null) => ({ consensus_runner_id: id });
const runner = (id: string) => ({ runner_id: id });

test('alignment: no consensus -> NO_TIPSTER_CONSENSUS', () => {
  const r = buildTipsterModelAlignment({
    tipsterConsensus: consensus(null),
    recommendedRunner: runner('a'),
    topModelRunner: runner('a'),
  });
  assert.equal(r.alignment_label, 'NO_TIPSTER_CONSENSUS');
  assert.equal(r.consensus_runner_id, null);
  assert.equal(r.recommended_runner_id, 'a');
  assert.equal(r.consensus_matches_recommendation, null);
  assert.equal(r.consensus_matches_top_model, null);
});

test('alignment: consensus but no recommendation -> NO_RECOMMENDATION', () => {
  const r = buildTipsterModelAlignment({
    tipsterConsensus: consensus('a'),
    recommendedRunner: undefined,
    topModelRunner: runner('a'),
  });
  assert.equal(r.alignment_label, 'NO_RECOMMENDATION');
  assert.equal(r.recommended_runner_id, null);
  assert.equal(r.consensus_matches_recommendation, null);
  // top-model match is still computable.
  assert.equal(r.consensus_matches_top_model, true);
});

test('alignment: consensus matches recommendation -> ALIGNED', () => {
  const r = buildTipsterModelAlignment({
    tipsterConsensus: consensus('a'),
    recommendedRunner: runner('a'),
    topModelRunner: runner('a'),
  });
  assert.equal(r.alignment_label, 'ALIGNED');
  assert.equal(r.consensus_matches_recommendation, true);
});

test('alignment: consensus matches top model but not recommendation -> PARTIALLY_ALIGNED', () => {
  const r = buildTipsterModelAlignment({
    tipsterConsensus: consensus('a'),
    recommendedRunner: runner('b'), // recommendation differs
    topModelRunner: runner('a'), // top model matches consensus
  });
  assert.equal(r.alignment_label, 'PARTIALLY_ALIGNED');
  assert.equal(r.consensus_matches_recommendation, false);
  assert.equal(r.consensus_matches_top_model, true);
});

test('alignment: consensus differs from both -> DIVERGENT', () => {
  const r = buildTipsterModelAlignment({
    tipsterConsensus: consensus('a'),
    recommendedRunner: runner('b'),
    topModelRunner: runner('c'),
  });
  assert.equal(r.alignment_label, 'DIVERGENT');
  assert.equal(r.consensus_matches_recommendation, false);
  assert.equal(r.consensus_matches_top_model, false);
});

test('alignment: null-safe with all inputs missing -> NO_TIPSTER_CONSENSUS', () => {
  const r = buildTipsterModelAlignment({ tipsterConsensus: consensus(null) });
  assert.deepEqual(r, {
    consensus_runner_id: null,
    recommended_runner_id: null,
    top_model_runner_id: null,
    consensus_matches_recommendation: null,
    consensus_matches_top_model: null,
    alignment_label: 'NO_TIPSTER_CONSENSUS',
  });
});

test('alignment: numeric runner ids are normalised before comparison', () => {
  const r = buildTipsterModelAlignment({
    tipsterConsensus: consensus('2'),
    recommendedRunner: { runner_id: 2 }, // numeric -> '2'
    topModelRunner: { runner_id: 2 },
  });
  assert.equal(r.alignment_label, 'ALIGNED');
  assert.equal(r.recommended_runner_id, '2');
});

test('alignment: deterministic output for identical inputs', () => {
  const input = {
    tipsterConsensus: consensus('a'),
    recommendedRunner: runner('b'),
    topModelRunner: runner('a'),
  };
  assert.deepEqual(
    buildTipsterModelAlignment(input),
    buildTipsterModelAlignment(input),
  );
});

// --- buildTipsterConsensusSummary (Batch H3) --------------------------------

const INFO = '\u2139';
const PEOPLE = '\u{1F465}';
const OK = '\u2705';
const WARN = '\u26A0';

const consensusFull = (
  id: string | null,
  support: number | null,
) => ({ consensus_runner_id: id, consensus_support_share: support });

test('summary: no selections -> single info line + "No tipster consensus"', () => {
  const r = buildTipsterConsensusSummary(consensusFull(null, null), {
    alignment_label: 'NO_TIPSTER_CONSENSUS',
  });
  assert.deepEqual(r.summary, [`${INFO} No tipster selections available`]);
  assert.equal(r.short_summary, 'No tipster consensus');
});

test('summary: consensus + aligned -> consensus line (1dp %) + align line', () => {
  const r = buildTipsterConsensusSummary(consensusFull('a', 0.425), {
    alignment_label: 'ALIGNED',
  });
  assert.deepEqual(r.summary, [
    `${PEOPLE} Tipster consensus: runner a with 42.5% support`,
    `${OK} Tipsters align with the model recommendation`,
  ]);
  assert.equal(r.short_summary, 'Tipsters aligned with recommendation');
});

test('summary: divergent from recommendation', () => {
  const r = buildTipsterConsensusSummary(consensusFull('a', 0.6), {
    alignment_label: 'DIVERGENT',
  });
  assert.deepEqual(r.summary, [
    `${PEOPLE} Tipster consensus: runner a with 60.0% support`,
    `${WARN} Tipsters prefer a different runner than the model recommendation`,
  ]);
  assert.equal(r.short_summary, 'Tipsters divergent from recommendation');
});

test('summary: partially aligned (top model but not recommendation)', () => {
  const r = buildTipsterConsensusSummary(consensusFull('a', 0.5), {
    alignment_label: 'PARTIALLY_ALIGNED',
  });
  assert.equal(
    r.summary[1],
    `${WARN} Tipsters align with the top model runner but not the recommendation`,
  );
  assert.equal(r.short_summary, 'Tipsters partially aligned with model');
});

test('summary: consensus but no recommendation', () => {
  const r = buildTipsterConsensusSummary(consensusFull('a', 0.5), {
    alignment_label: 'NO_RECOMMENDATION',
  });
  assert.deepEqual(r.summary, [
    `${PEOPLE} Tipster consensus: runner a with 50.0% support`,
    `${INFO} Tipster consensus exists but no model recommendation was made`,
  ]);
  assert.equal(r.short_summary, 'Tipster consensus, no recommendation');
});

test('summary: missing support share -> percentage omitted safely, no fabrication', () => {
  const r = buildTipsterConsensusSummary(consensusFull('a', null), {
    alignment_label: 'NO_TIPSTER_CONSENSUS',
  });
  // consensus id present but share null: consensus line shows fallback text;
  // label NO_TIPSTER_CONSENSUS adds no align line.
  assert.deepEqual(r.summary, [
    `${PEOPLE} Tipster consensus: runner a with support unavailable`,
  ]);
  assert.equal(r.short_summary, 'Tipster consensus');
});

test('summary: percentage formatted to exactly 1 decimal place', () => {
  const r = buildTipsterConsensusSummary(consensusFull('x', 1 / 3), {
    alignment_label: 'ALIGNED',
  });
  assert.equal(
    r.summary[0],
    `${PEOPLE} Tipster consensus: runner x with 33.3% support`,
  );
});

test('summary: deterministic output for identical inputs', () => {
  const c = consensusFull('a', 0.5);
  const a = { alignment_label: 'ALIGNED' as const };
  assert.deepEqual(
    buildTipsterConsensusSummary(c, a),
    buildTipsterConsensusSummary(c, a),
  );
});
