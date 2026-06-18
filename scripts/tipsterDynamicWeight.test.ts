/**
 * Unit tests for the pure dynamic tipster weighting module
 * (src/lib/tipsterDynamicWeight.ts).
 *
 * No network or DB. These lock the seven-factor formula, the sample-size
 * shrinkage toward neutral, the calibration (ECE) score, and the safety
 * invariant that the default ramp (alpha=0) yields a neutral effective weight
 * (no betting influence). Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreDynamicTipsterWeight,
  computeCalibrationScore,
  reliabilityOf,
  shrinkToNeutral,
  skillFromRoi,
  recencyReliability,
  applyRamp,
  NEUTRAL_WEIGHT,
  DEFAULT_RAMP_ALPHA,
  type TipsterFactorInputs,
} from '../src/lib/tipsterDynamicWeight';

const NOW = new Date('2026-06-18T12:00:00Z');

/** A strong, well-evidenced tipster fixture. */
function strongInputs(): TipsterFactorInputs {
  return {
    betsCount: 1200,
    roi: 0.18,
    strikeRate: 0.3,
    recentRoi: 0.14,
    lastSeenDate: '2026-06-16',
    ascotRoi: 0.2,
    ascotSampleSize: 120,
    festivalRoi: 0.16,
    festivalSampleSize: 90,
    calibrationScore: 0.85,
    calibrationSampleSize: 400,
  };
}

test('defaults: ramp alpha is 0 (no betting influence by default)', () => {
  assert.equal(DEFAULT_RAMP_ALPHA, 0);
  const r = scoreDynamicTipsterWeight(strongInputs(), { now: NOW });
  // Strong tipster earns a high dynamic weight…
  assert.ok(r.dynamic_weight > 0.6, `expected > 0.6, got ${r.dynamic_weight}`);
  // …but the effective (ramped) weight is neutral because alpha defaults to 0.
  assert.equal(r.effective_weight, NEUTRAL_WEIGHT);
  assert.equal(r.ramp_alpha, 0);
});

test('reliabilityOf: shrinks with sample size; 0 when absent', () => {
  assert.equal(reliabilityOf(null), 0);
  assert.equal(reliabilityOf(0), 0);
  assert.equal(reliabilityOf(200), 0.5); // N/(N+200)
  assert.ok(reliabilityOf(800) > reliabilityOf(200));
});

test('shrinkToNeutral: factor 0 -> neutral; factor 1 -> unchanged', () => {
  assert.equal(shrinkToNeutral(0.9, 0), NEUTRAL_WEIGHT);
  assert.equal(shrinkToNeutral(0.9, 1), 0.9);
  assert.equal(shrinkToNeutral(0.9, 0.5), 0.7); // 0.5 + 0.5*(0.9-0.5)
});

test('skillFromRoi: break-even is neutral; profit > 0.5; loss < 0.5', () => {
  assert.equal(skillFromRoi(0), 0.5);
  assert.ok(skillFromRoi(0.2) > 0.5);
  assert.ok(skillFromRoi(-0.2) < 0.5);
});

test('small samples are not rewarded: tiny N shrinks toward neutral', () => {
  const base = { roi: 0.25, strikeRate: 0.3, recentRoi: 0.2, lastSeenDate: '2026-06-16' };
  const tiny = scoreDynamicTipsterWeight({ ...base, betsCount: 10 }, { now: NOW });
  const large = scoreDynamicTipsterWeight({ ...base, betsCount: 1500 }, { now: NOW });
  // Same per-bet performance, but the small-sample weight sits far closer to 0.5.
  assert.ok(Math.abs(tiny.dynamic_weight - NEUTRAL_WEIGHT) < Math.abs(large.dynamic_weight - NEUTRAL_WEIGHT));
  assert.ok(tiny.dynamic_weight < large.dynamic_weight);
  assert.ok(tiny.reasons.some((r) => r.toLowerCase().includes('small sample')));
});

test('no sample at all -> fully neutral dynamic weight', () => {
  const r = scoreDynamicTipsterWeight({ roi: 0.3, strikeRate: 0.4 }, { now: NOW });
  assert.equal(r.dynamic_weight, NEUTRAL_WEIGHT);
  assert.equal(r.reliability, 0);
  assert.ok(r.reasons.some((x) => x.includes('neutral')));
});

test('a losing record scores below neutral', () => {
  const r = scoreDynamicTipsterWeight(
    { betsCount: 1500, roi: -0.12, recentRoi: -0.1, strikeRate: 0.1, lastSeenDate: '2026-06-16' },
    { now: NOW },
  );
  assert.ok(r.dynamic_weight < NEUTRAL_WEIGHT, `expected < 0.5, got ${r.dynamic_weight}`);
});

test('thin Ascot/festival segments are shrunk toward neutral (not rewarded)', () => {
  const thin = scoreDynamicTipsterWeight(
    { betsCount: 1500, roi: 0.05, ascotRoi: 0.5, ascotSampleSize: 3 },
    { now: NOW },
  );
  const deep = scoreDynamicTipsterWeight(
    { betsCount: 1500, roi: 0.05, ascotRoi: 0.5, ascotSampleSize: 300 },
    { now: NOW },
  );
  const thinAscot = thin.factors.find((f) => f.factor === 'ascot');
  const deepAscot = deep.factors.find((f) => f.factor === 'ascot');
  assert.ok(thinAscot && deepAscot);
  // The thin segment's skill sits closer to neutral despite the same raw ROI.
  assert.ok(Math.abs((thinAscot?.skill ?? 0) - 0.5) < Math.abs((deepAscot?.skill ?? 0) - 0.5));
});

test('stale recent form is decayed toward neutral', () => {
  const fresh = scoreDynamicTipsterWeight(
    { betsCount: 800, recentRoi: 0.25, lastSeenDate: '2026-06-17' },
    { now: NOW },
  );
  const stale = scoreDynamicTipsterWeight(
    { betsCount: 800, recentRoi: 0.25, lastSeenDate: '2026-01-01' },
    { now: NOW },
  );
  const fr = fresh.factors.find((f) => f.factor === 'recent_form');
  const st = stale.factors.find((f) => f.factor === 'recent_form');
  assert.ok((fr?.skill ?? 0) > (st?.skill ?? 0));
});

test('coverage: missing factors reduce coverage and damp the weight', () => {
  const full = scoreDynamicTipsterWeight(strongInputs(), { now: NOW });
  const sparse = scoreDynamicTipsterWeight(
    { betsCount: 1200, roi: 0.18 },
    { now: NOW },
  );
  assert.ok(full.coverage > sparse.coverage);
  assert.ok(sparse.coverage < 1);
  // Same ROI, but sparse coverage pulls the composite closer to neutral.
  assert.ok(Math.abs(sparse.dynamic_weight - 0.5) < Math.abs(full.dynamic_weight - 0.5));
});

test('ramp: alpha scales influence linearly between neutral and the dynamic weight', () => {
  const r = scoreDynamicTipsterWeight(strongInputs(), { now: NOW, rampAlpha: 0.5 });
  const expected = 0.5 + 0.5 * (r.dynamic_weight - 0.5);
  assert.ok(Math.abs(r.effective_weight - expected) < 1e-9);
  assert.equal(applyRamp(0.8, 0), 0.5);
  assert.equal(applyRamp(0.8, 1), 0.8);
});

test('recencyReliability: fresh=1, horizon=0, unknown=1', () => {
  assert.equal(recencyReliability(0), 1);
  assert.equal(recencyReliability(7), 1);
  assert.equal(recencyReliability(90), 0);
  assert.equal(recencyReliability(null), 1);
});

test('computeCalibrationScore: perfectly calibrated -> high score; miscalibrated -> low', () => {
  // 25%-implied picks that win ~25% of the time (well calibrated).
  const calibrated = Array.from({ length: 100 }, (_, i) => ({
    impliedProb: 0.25,
    won: (i % 4 === 0 ? 1 : 0) as 0 | 1,
  }));
  const good = computeCalibrationScore(calibrated);
  assert.ok(good.score !== null && good.score > 0.8, `expected > 0.8, got ${good.score}`);

  // 80%-implied picks that almost never win (badly calibrated).
  const miscalibrated = Array.from({ length: 100 }, (_, i) => ({
    impliedProb: 0.8,
    won: (i % 20 === 0 ? 1 : 0) as 0 | 1,
  }));
  const bad = computeCalibrationScore(miscalibrated);
  assert.ok(bad.score !== null && bad.score < 0.3, `expected < 0.3, got ${bad.score}`);
});

test('computeCalibrationScore: no usable picks -> null (never fabricated)', () => {
  const r = computeCalibrationScore([]);
  assert.equal(r.score, null);
  assert.equal(r.ece, null);
  assert.equal(r.sampleSize, 0);
});

test('factors breakdown: every factor is reported, present flag is accurate', () => {
  const r = scoreDynamicTipsterWeight({ betsCount: 500, roi: 0.1 }, { now: NOW });
  assert.equal(r.factors.length, 6);
  const roi = r.factors.find((f) => f.factor === 'roi');
  const ascot = r.factors.find((f) => f.factor === 'ascot');
  assert.equal(roi?.present, true);
  assert.equal(ascot?.present, false);
  assert.equal(ascot?.contribution, 0);
});
