/**
 * Unit tests for the ML training-example builder (src/lib/mlTrainingExample.ts).
 * No I/O. Locks the leakage-segregated data model + the outcome derivation.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTrainingExample,
  isExampleSettled,
  FEATURE_FIELDS,
  LABEL_FIELDS,
  type TrainingExampleInput,
} from '../src/lib/mlTrainingExample';

function input(over: Partial<TrainingExampleInput> = {}): TrainingExampleInput {
  return {
    raceId: 'r1',
    runnerId: 'A',
    modelRunId: 'run1',
    meetingDate: '2026-06-18',
    course: 'Ascot',
    offTime: '2026-06-18T14:30:00Z',
    modelVersion: 'market-v1',
    fieldSize: 9,
    recommended: true,
    recommendationRank: 1,
    modelProb: 0.42,
    marketProb: 0.33,
    edge: 0.09,
    ev: 0.18,
    odds: 3.0,
    confidenceScore: 0.62,
    confidenceLabel: 'Medium',
    isFavourite: false,
    finishPos: 1,
    favouriteWon: false,
    favouritePlaced: true,
    bsp: 3.2,
    sp: 3.0,
    ...over,
  };
}

test('builds an example with the tracked fields + derived won/placed', () => {
  const ex = buildTrainingExample(input());
  assert.equal(ex.recommended, true);
  assert.equal(ex.model_prob, 0.42);
  assert.equal(ex.ev, 0.18);
  assert.equal(ex.odds, 3.0);
  assert.equal(ex.confidence_score, 0.62);
  assert.equal(ex.is_favourite, false);
  assert.equal(ex.won, true); // finish_pos 1
  assert.equal(ex.placed, true);
  assert.equal(ex.favourite_won, false);
  assert.equal(ex.bsp_decimal, 3.2);
  assert.ok(isExampleSettled(ex));
});

test('an unsettled example has null won/placed (never fabricated)', () => {
  const ex = buildTrainingExample(input({ finishPos: null }));
  assert.equal(ex.finish_pos, null);
  assert.equal(ex.won, null);
  assert.equal(ex.placed, null);
  assert.equal(isExampleSettled(ex), false);
});

test('placed reflects top-3; 4th does not place but is settled', () => {
  const fourth = buildTrainingExample(input({ finishPos: 4 }));
  assert.equal(fourth.won, false);
  assert.equal(fourth.placed, false);
  assert.equal(isExampleSettled(fourth), true);
  const third = buildTrainingExample(input({ finishPos: 3 }));
  assert.equal(third.placed, true);
});

test('non-finite numerics normalise to null; blanks to null', () => {
  const ex = buildTrainingExample(
    input({ modelProb: Number.NaN, ev: Infinity, odds: null, confidenceLabel: '  ' }),
  );
  assert.equal(ex.model_prob, null);
  assert.equal(ex.ev, null);
  assert.equal(ex.odds, null);
  assert.equal(ex.confidence_label, null);
});

test('feature and label fields are disjoint (leakage segregation)', () => {
  const overlap = FEATURE_FIELDS.filter((f) => (LABEL_FIELDS as readonly string[]).includes(f as string));
  assert.deepEqual(overlap, []);
  // The outcome lives only in the labels.
  assert.ok((LABEL_FIELDS as readonly string[]).includes('won'));
  assert.ok(!(FEATURE_FIELDS as readonly string[]).includes('won'));
  // BSP is a label, never a feature.
  assert.ok((LABEL_FIELDS as readonly string[]).includes('bsp_decimal'));
  assert.ok(!(FEATURE_FIELDS as readonly string[]).includes('bsp_decimal'));
});
