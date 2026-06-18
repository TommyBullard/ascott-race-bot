/**
 * Unit tests for the pure observability->panel-props mapper
 * (src/lib/raceExplanation.ts).
 *
 * No DOM, no React: synthetic observability objects (including null/partial/
 * malformed) that lock down null-safe extraction of the alignment label and the
 * stake-suppression / reduce-confidence flags, plus the safe empty fallbacks.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveRaceExplanationProps,
  type RaceObservabilityLike,
} from '../src/lib/raceExplanation';

/** A full, well-formed observability object (the API's camelCase shape). */
function fullObservability(): RaceObservabilityLike {
  return {
    runQuality: 'DEGRADED',
    modelAdjustments: { suppressStaking: true, reduceConfidence: true, notes: ['x'] },
    dataQualityAdjustedConfidence: 0.64,
    dataQualityShortSummary: 'DEGRADED — Low market completeness (0.72)',
    dataQualitySummary: ['⚠ Low market completeness (0.72)'],
    tipsterModelAlignment: { alignment_label: 'ALIGNED' },
    tipsterConsensusShortSummary: 'Tipsters aligned with recommendation',
    tipsterConsensusSummary: ['👥 Tipster consensus: runner a with 100.0% support'],
  };
}

test('full observability maps every field to flat panel props', () => {
  const p = deriveRaceExplanationProps(fullObservability());
  assert.equal(p.runQuality, 'DEGRADED');
  assert.equal(p.dataQualityShortSummary, 'DEGRADED — Low market completeness (0.72)');
  assert.deepEqual(p.dataQualitySummary, ['⚠ Low market completeness (0.72)']);
  assert.equal(p.tipsterConsensusShortSummary, 'Tipsters aligned with recommendation');
  assert.deepEqual(p.tipsterConsensusSummary, [
    '👥 Tipster consensus: runner a with 100.0% support',
  ]);
  assert.equal(p.alignmentLabel, 'ALIGNED');
  assert.equal(p.stakeSuppressed, true);
  assert.equal(p.confidenceReduced, true);
  assert.equal(p.adjustedConfidence, 0.64);
});

test('null / undefined -> fully empty, null-safe props (panel shows empty state)', () => {
  for (const input of [null, undefined]) {
    assert.deepEqual(deriveRaceExplanationProps(input), {
      dataQualityShortSummary: null,
      dataQualitySummary: null,
      tipsterConsensusShortSummary: null,
      tipsterConsensusSummary: null,
      runQuality: null,
      alignmentLabel: null,
      stakeSuppressed: false,
      confidenceReduced: false,
      adjustedConfidence: null,
      consensusStrength: null,
      consensusType: null,
      consensusDetail: null,
    });
  }
});

test('flags are strict: only boolean true counts, missing adjustments -> false', () => {
  // Truthy-but-not-true values must NOT flip the flags on.
  const p = deriveRaceExplanationProps({
    modelAdjustments: { suppressStaking: 'yes', reduceConfidence: 1 } as unknown as Record<
      string,
      unknown
    >,
  });
  assert.equal(p.stakeSuppressed, false);
  assert.equal(p.confidenceReduced, false);

  // No modelAdjustments at all.
  const q = deriveRaceExplanationProps({ runQuality: 'OK' });
  assert.equal(q.stakeSuppressed, false);
  assert.equal(q.confidenceReduced, false);
});

test('alignment label is null unless a non-empty string is present', () => {
  assert.equal(deriveRaceExplanationProps({ tipsterModelAlignment: null }).alignmentLabel, null);
  assert.equal(
    deriveRaceExplanationProps({ tipsterModelAlignment: {} }).alignmentLabel,
    null,
  );
  assert.equal(
    deriveRaceExplanationProps({
      tipsterModelAlignment: { alignment_label: '   ' },
    }).alignmentLabel,
    null,
  );
  assert.equal(
    deriveRaceExplanationProps({
      tipsterModelAlignment: { alignment_label: 42 } as unknown as Record<string, unknown>,
    }).alignmentLabel,
    null,
  );
});

test('adjustedConfidence only kept when a finite number; summaries drop non-strings', () => {
  for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, '0.5']) {
    assert.equal(
      deriveRaceExplanationProps({
        dataQualityAdjustedConfidence: bad as unknown as number,
      }).adjustedConfidence,
      null,
    );
  }
  assert.equal(
    deriveRaceExplanationProps({ dataQualityAdjustedConfidence: 0 }).adjustedConfidence,
    0,
  );

  // Non-string entries are filtered; an all-invalid / empty list -> null.
  const p = deriveRaceExplanationProps({
    dataQualitySummary: ['ok', '', '  ', 7 as unknown as string],
    tipsterConsensusSummary: [],
  });
  assert.deepEqual(p.dataQualitySummary, ['ok']);
  assert.equal(p.tipsterConsensusSummary, null);
});

test('partial observability (data quality only) leaves tipster fields null', () => {
  const p = deriveRaceExplanationProps({
    runQuality: 'STALE',
    dataQualityShortSummary: 'STALE — odds 12m old',
  });
  assert.equal(p.runQuality, 'STALE');
  assert.equal(p.dataQualityShortSummary, 'STALE — odds 12m old');
  assert.equal(p.alignmentLabel, null);
  assert.equal(p.tipsterConsensusShortSummary, null);
  assert.equal(p.tipsterConsensusSummary, null);
  assert.equal(p.stakeSuppressed, false);
  assert.equal(p.confidenceReduced, false);
});
