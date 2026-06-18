/**
 * Unit tests for the pure config_json readers (src/lib/modelRunConfigReaders.ts).
 *
 * No DB or network: synthetic config_json blobs (including null/malformed). These
 * lock down safe extraction of the observability outputs, the safe fallbacks for
 * missing/invalid fields, and that inputs are never mutated. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getTipsterConsensusFromConfig,
  getTipsterModelAlignmentFromConfig,
  getTipsterConsensusSummaryFromConfig,
  getDataQualityOutputsFromConfig,
  getModelObservabilityFromConfig,
} from '../src/lib/modelRunConfigReaders';

/** A full, well-formed config_json blob (the producer's shape). */
function fullConfig() {
  return {
    data_quality_thresholds: { min_market_completeness: 0.8 },
    data_quality_metrics: { priced_runner_count: 7 },
    run_quality: 'DEGRADED',
    model_adjustments: { suppressStaking: true, reduceConfidence: false, notes: ['x'] },
    data_quality_summary: ['⚠ Low market completeness (0.72)'],
    data_quality_short_summary: 'DEGRADED — Low market completeness (0.72)',
    tipster_consensus: {
      runner_support: [{ runner_id: 'a', selection_count: 2, support_share: 1 }],
      consensus_runner_id: 'a',
    },
    tipster_model_alignment: { alignment_label: 'ALIGNED' },
    tipster_consensus_summary: ['👥 Tipster consensus: runner a with 100.0% support'],
    tipster_consensus_short_summary: 'Tipsters aligned with recommendation',
  };
}

// --- full config ------------------------------------------------------------

test('full config: every reader returns the expected values', () => {
  const c = fullConfig();

  const consensus = getTipsterConsensusFromConfig(c);
  assert.ok(consensus);
  assert.equal(consensus!.consensus_runner_id, 'a');

  const alignment = getTipsterModelAlignmentFromConfig(c);
  assert.ok(alignment);
  assert.equal(alignment!.alignment_label, 'ALIGNED');

  const summary = getTipsterConsensusSummaryFromConfig(c);
  assert.deepEqual(summary.summary, [
    '👥 Tipster consensus: runner a with 100.0% support',
  ]);
  assert.equal(summary.short_summary, 'Tipsters aligned with recommendation');

  const dq = getDataQualityOutputsFromConfig(c);
  assert.equal(dq.run_quality, 'DEGRADED');
  assert.deepEqual(dq.model_adjustments, {
    suppressStaking: true,
    reduceConfidence: false,
    notes: ['x'],
  });
  assert.deepEqual(dq.data_quality_summary, ['⚠ Low market completeness (0.72)']);
  assert.equal(
    dq.data_quality_short_summary,
    'DEGRADED — Low market completeness (0.72)',
  );
});

// --- missing config ---------------------------------------------------------

test('missing config (null/undefined): safe nulls + empty arrays, no throw', () => {
  for (const c of [null, undefined]) {
    assert.equal(getTipsterConsensusFromConfig(c), null);
    assert.equal(getTipsterModelAlignmentFromConfig(c), null);
    assert.deepEqual(getTipsterConsensusSummaryFromConfig(c), {
      summary: [],
      short_summary: null,
    });
    assert.deepEqual(getDataQualityOutputsFromConfig(c), {
      run_quality: null,
      model_adjustments: null,
      data_quality_summary: [],
      data_quality_short_summary: null,
    });
  }
});

// --- malformed config -------------------------------------------------------

test('malformed config (primitives / arrays): treated as empty, no throw', () => {
  for (const c of [42, 'a string', true, ['array'], Symbol('s')]) {
    assert.equal(getTipsterConsensusFromConfig(c), null);
    assert.equal(getTipsterModelAlignmentFromConfig(c), null);
    assert.deepEqual(getTipsterConsensusSummaryFromConfig(c).summary, []);
    assert.equal(getDataQualityOutputsFromConfig(c).run_quality, null);
  }
});

// --- missing individual keys ------------------------------------------------

test('missing individual keys: each reader falls back independently', () => {
  const partial = { run_quality: 'OK' }; // only one key present
  assert.equal(getTipsterConsensusFromConfig(partial), null);
  assert.equal(getTipsterModelAlignmentFromConfig(partial), null);
  assert.deepEqual(getTipsterConsensusSummaryFromConfig(partial), {
    summary: [],
    short_summary: null,
  });
  const dq = getDataQualityOutputsFromConfig(partial);
  assert.equal(dq.run_quality, 'OK');
  assert.equal(dq.model_adjustments, null);
  assert.deepEqual(dq.data_quality_summary, []);
});

test('structurally-wrong nested objects -> null (consensus without runner_support)', () => {
  const c = {
    tipster_consensus: { consensus_runner_id: 'a' }, // no runner_support
    tipster_model_alignment: { foo: 'bar' }, // no alignment_label
  };
  assert.equal(getTipsterConsensusFromConfig(c), null);
  assert.equal(getTipsterModelAlignmentFromConfig(c), null);
});

// --- invalid array values ---------------------------------------------------

test('summary arrays with invalid values: non-strings dropped, wrong type -> []', () => {
  const c = {
    data_quality_summary: ['ok', 42, null, { x: 1 }, 'fine'],
    tipster_consensus_summary: 'not an array',
    data_quality_short_summary: 123, // not a string -> null
  };
  const dq = getDataQualityOutputsFromConfig(c);
  assert.deepEqual(dq.data_quality_summary, ['ok', 'fine']);
  assert.equal(dq.data_quality_short_summary, null);

  const summary = getTipsterConsensusSummaryFromConfig(c);
  assert.deepEqual(summary.summary, []); // string, not array -> []
});

// --- no mutation ------------------------------------------------------------

test('readers never mutate the input', () => {
  const c = fullConfig();
  const snapshot = JSON.parse(JSON.stringify(c));
  getTipsterConsensusFromConfig(c);
  getTipsterModelAlignmentFromConfig(c);
  getTipsterConsensusSummaryFromConfig(c);
  getDataQualityOutputsFromConfig(c);
  assert.deepEqual(c, snapshot);

  // The returned summary array is a NEW array (filtering), not the same ref.
  const arrConfig = { data_quality_summary: ['a', 'b'] };
  const dq = getDataQualityOutputsFromConfig(arrConfig);
  dq.data_quality_summary.push('mutated');
  assert.deepEqual(arrConfig.data_quality_summary, ['a', 'b']);
});

// --- getModelObservabilityFromConfig (Batch J1 aggregator) ------------------

test('observability: full config maps every field to the camelCase API shape', () => {
  const c = { ...fullConfig(), data_quality_adjusted_confidence: 0.64 };
  const o = getModelObservabilityFromConfig(c);
  assert.equal(o.runQuality, 'DEGRADED');
  assert.deepEqual(o.modelAdjustments, {
    suppressStaking: true,
    reduceConfidence: false,
    notes: ['x'],
  });
  assert.equal(o.dataQualityAdjustedConfidence, 0.64);
  assert.equal(
    o.dataQualityShortSummary,
    'DEGRADED — Low market completeness (0.72)',
  );
  assert.deepEqual(o.dataQualitySummary, ['⚠ Low market completeness (0.72)']);
  assert.ok(o.tipsterConsensus);
  assert.equal(o.tipsterConsensus!.consensus_runner_id, 'a');
  assert.ok(o.tipsterModelAlignment);
  assert.equal(o.tipsterModelAlignment!.alignment_label, 'ALIGNED');
  assert.equal(
    o.tipsterConsensusShortSummary,
    'Tipsters aligned with recommendation',
  );
  assert.deepEqual(o.tipsterConsensusSummary, [
    '👥 Tipster consensus: runner a with 100.0% support',
  ]);
});

test('observability: null/malformed config -> fully empty, null-safe shape (no throw)', () => {
  for (const c of [null, undefined, 42, 'str', ['arr']]) {
    const o = getModelObservabilityFromConfig(c);
    assert.deepEqual(o, {
      runQuality: null,
      modelAdjustments: null,
      dataQualityAdjustedConfidence: null,
      dataQualityShortSummary: null,
      dataQualitySummary: [],
      tipsterConsensus: null,
      tipsterModelAlignment: null,
      tipsterConsensusShortSummary: null,
      tipsterConsensusSummary: [],
      tipsterConsensusEngine: null,
    });
  }
});

test('observability: legacy partial config -> present keys mapped, missing -> null/[]', () => {
  // A pre-J1 run with only data-quality keys, no tipster keys.
  const o = getModelObservabilityFromConfig({
    run_quality: 'OK',
    data_quality_summary: ['ok'],
  });
  assert.equal(o.runQuality, 'OK');
  assert.deepEqual(o.dataQualitySummary, ['ok']);
  assert.equal(o.tipsterConsensus, null);
  assert.equal(o.tipsterModelAlignment, null);
  assert.equal(o.tipsterConsensusShortSummary, null);
  assert.deepEqual(o.tipsterConsensusSummary, []);
  assert.equal(o.dataQualityAdjustedConfidence, null);
});

test('observability: adjusted confidence only mapped when a finite number', () => {
  assert.equal(
    getModelObservabilityFromConfig({ data_quality_adjusted_confidence: 0 })
      .dataQualityAdjustedConfidence,
    0,
  );
  for (const bad of [null, 'x', undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      getModelObservabilityFromConfig({ data_quality_adjusted_confidence: bad })
        .dataQualityAdjustedConfidence,
      null,
    );
  }
});
