/**
 * Unit tests for the pure feature-importance engine (src/lib/featureImportance.ts).
 * No I/O. Locks the lift + correlation signals, the sample guard, and ranking.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreFeatureImportance,
  rankFeatureImportance,
  MIN_FEATURE_SAMPLES,
  type FeatureObservation,
  type FeatureExtractor,
} from '../src/lib/featureImportance';

/** Builds n observations where the outcome probability rises with the value. */
function risingSignal(n: number): FeatureObservation[] {
  return Array.from({ length: n }, (_, i) => {
    const value = i / n; // 0..1
    // Higher value -> more likely to win (deterministic threshold pattern).
    const outcome = (i % 100) / 100 < value ? 1 : 0;
    return { value, outcome: outcome as 0 | 1 };
  });
}

test('a strongly predictive feature scores positive lift + positive correlation', () => {
  const imp = scoreFeatureImportance('model_prob', risingSignal(500));
  assert.equal(imp.scored, true);
  assert.ok((imp.lift ?? 0) > 0.3, `lift ${imp.lift}`);
  assert.ok((imp.correlation ?? 0) > 0.3, `corr ${imp.correlation}`);
  assert.ok(imp.binRates.length >= 2);
  // Win rate should rise from the lowest to the highest bin.
  const present = imp.binRates.filter((r): r is number => r !== null);
  assert.ok(present[present.length - 1] > present[0]);
});

test('a noise feature scores near-zero correlation', () => {
  const obs: FeatureObservation[] = Array.from({ length: 400 }, (_, i) => ({
    value: (i * 7919) % 100, // pseudo-random, unrelated to outcome
    outcome: (i % 2) as 0 | 1,
  }));
  const imp = scoreFeatureImportance('noise', obs);
  assert.equal(imp.scored, true);
  assert.ok(Math.abs(imp.correlation ?? 1) < 0.15, `corr ${imp.correlation}`);
});

test('insufficient sample -> not scored (no invented importance)', () => {
  const imp = scoreFeatureImportance('thin', risingSignal(MIN_FEATURE_SAMPLES - 1));
  assert.equal(imp.scored, false);
  assert.equal(imp.lift, null);
  assert.equal(imp.correlation, null);
  assert.match(imp.note, /insufficient sample/);
});

test('null / non-finite feature values are dropped from the sample', () => {
  const obs: FeatureObservation[] = [
    ...risingSignal(60),
    { value: null, outcome: 1 },
    { value: Number.NaN, outcome: 0 },
  ];
  const imp = scoreFeatureImportance('with_nulls', obs);
  assert.equal(imp.n, 60); // the 2 unusable rows excluded
});

test('rankFeatureImportance: predictive features rank above noise; unscored last', () => {
  type Row = { p: number; r: number; noise: number; thin: number | null; won: 0 | 1 };
  const rows: Row[] = Array.from({ length: 300 }, (_, i) => {
    const p = i / 300;
    return {
      p,
      r: 1 - p,
      noise: (i * 7919) % 100,
      thin: i < 10 ? i : null, // mostly null -> unscored
      won: (((i % 100) / 100 < p ? 1 : 0) as 0 | 1),
    };
  });
  const features: FeatureExtractor<Row>[] = [
    { feature: 'p', extract: (x) => x.p },
    { feature: 'noise', extract: (x) => x.noise },
    { feature: 'thin', extract: (x) => x.thin },
  ];
  const ranked = rankFeatureImportance(rows, features, (x) => x.won);
  assert.equal(ranked[0].feature, 'p'); // strongest association first
  assert.equal(ranked[ranked.length - 1].feature, 'thin'); // unscored sorts last
  assert.equal(ranked[ranked.length - 1].scored, false);
});
