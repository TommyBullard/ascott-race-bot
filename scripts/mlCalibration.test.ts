/**
 * Unit tests for the ML calibration metrics (src/lib/mlCalibration.ts).
 * No I/O. Locks Brier/log-loss/ECE/MCE, the reliability diagram, and the
 * by-band confidence calibration. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  calibrateBinary,
  calibrateConfidence,
  reliabilityBins,
  brierScore,
  expectedCalibrationError,
  type CalibrationSample,
  type ConfidenceSample,
} from '../src/lib/mlCalibration';

/** Perfectly-calibrated: in each prob bucket the outcome rate equals the prob. */
function calibratedSamples(): CalibrationSample[] {
  const out: CalibrationSample[] = [];
  for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const wins = Math.round(p * 100);
    for (let i = 0; i < 100; i++) out.push({ prob: p, outcome: i < wins ? 1 : 0 });
  }
  return out;
}

test('calibrateBinary: a well-calibrated set has near-zero ECE and matched means', () => {
  const r = calibrateBinary(calibratedSamples());
  assert.equal(r.n, 500);
  assert.ok(r.sufficientSample);
  assert.ok((r.ece ?? 1) < 0.02, `ece ${r.ece}`);
  assert.ok(Math.abs((r.meanPredicted ?? 0) - (r.meanObserved ?? 0)) < 0.02);
  assert.ok((r.brier ?? 1) > 0 && (r.brier ?? 0) < 0.25);
});

test('calibrateBinary: an over-confident model has a large ECE', () => {
  // Predict 0.9 but only 30% win -> badly miscalibrated.
  const over: CalibrationSample[] = Array.from({ length: 200 }, (_, i) => ({
    prob: 0.9,
    outcome: i % 10 < 3 ? 1 : 0,
  }));
  const r = calibrateBinary(over);
  assert.ok((r.ece ?? 0) > 0.5, `ece ${r.ece}`);
  assert.ok((r.meanPredicted ?? 0) > (r.meanObserved ?? 1));
});

test('reliabilityBins: bins partition [0,1]; empty bins report null/0', () => {
  const bins = reliabilityBins([{ prob: 0.05, outcome: 0 }, { prob: 0.95, outcome: 1 }], 10);
  assert.equal(bins.length, 10);
  assert.equal(bins[0].n, 1);
  assert.equal(bins[9].n, 1);
  assert.equal(bins[5].n, 0);
  assert.equal(bins[5].predMean, null);
});

test('empty / no-usable input -> null metrics (never fabricated)', () => {
  assert.equal(brierScore([]), null);
  assert.equal(expectedCalibrationError([]), null);
  const r = calibrateBinary([{ prob: 2, outcome: 1 }, { prob: -1, outcome: 0 }]); // out of range -> dropped
  assert.equal(r.n, 0);
  assert.equal(r.brier, null);
  assert.equal(r.sufficientSample, false);
});

test('boolean outcomes are accepted as 1/0', () => {
  const r = calibrateBinary([
    { prob: 0.5, outcome: true },
    { prob: 0.5, outcome: false },
  ]);
  assert.equal(r.meanObserved, 0.5);
});

test('calibrateConfidence: high band wins more than low band when calibrated', () => {
  const samples: ConfidenceSample[] = [
    ...Array.from({ length: 100 }, (_, i) => ({ score: 0.2, outcome: (i < 10 ? 1 : 0) as 0 | 1 })), // low: 10%
    ...Array.from({ length: 100 }, (_, i) => ({ score: 0.5, outcome: (i < 35 ? 1 : 0) as 0 | 1 })), // med: 35%
    ...Array.from({ length: 100 }, (_, i) => ({ score: 0.8, outcome: (i < 65 ? 1 : 0) as 0 | 1 })), // high: 65%
  ];
  const bands = calibrateConfidence(samples);
  const low = bands.find((b) => b.label === 'low')!;
  const high = bands.find((b) => b.label === 'high')!;
  assert.equal(low.n, 100);
  assert.equal(high.n, 100);
  assert.ok((high.outcomeRate ?? 0) > (low.outcomeRate ?? 1));
  assert.ok((high.outcomeRate ?? 0) > 0.6);
});

test('calibrateConfidence: an empty band reports null rate, not a guess', () => {
  const bands = calibrateConfidence([{ score: 0.8, outcome: 1 }]);
  const low = bands.find((b) => b.label === 'low')!;
  assert.equal(low.n, 0);
  assert.equal(low.outcomeRate, null);
});
