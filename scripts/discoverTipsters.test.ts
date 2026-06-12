/**
 * Unit tests for the pure tipster needle-scoring + active-pool logic.
 *
 * No DB or network: these exercise the deterministic math only
 * (z-scores, needle_score weights, reliability, promote/demote), on synthetic
 * fixtures. They assert the formula, not any real ROI.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeNeedleScores,
  reliabilityOf,
  zScore,
  populationStats,
  classifyActive,
  type TipsterWindowedStats,
} from '../src/lib/discoverTipsters';

const APPROX = 1e-6;
const close = (a: number, b: number, eps = APPROX) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

function row(over: Partial<TipsterWindowedStats>): TipsterWindowedStats {
  return {
    name: 'T',
    source: 'test',
    longRunRoi: 0,
    recentRoi30d: 0,
    strikeRate: 0.2,
    longestLosingStreak: 0,
    betsCount: 600,
    ...over,
  };
}

test('reliabilityOf: N/(N+400), clamped at 0 for non-positive N', () => {
  close(reliabilityOf(400), 0.5);
  close(reliabilityOf(600), 0.6);
  close(reliabilityOf(100), 100 / 500);
  assert.equal(reliabilityOf(0), 0);
  assert.equal(reliabilityOf(-5), 0);
});

test('zScore: standard score, and 0 when the cohort has no spread', () => {
  close(zScore(2, 0, 2), 1);
  close(zScore(-2, 0, 2), -1);
  assert.equal(zScore(5, 5, 0), 0); // std === 0 -> 0, never NaN/Infinity
});

test('populationStats: mean + population std', () => {
  const { mean, std } = populationStats([1, 2, 3]);
  close(mean, 2);
  close(std, Math.sqrt(2 / 3));
  const single = populationStats([7]);
  close(single.mean, 7);
  close(single.std, 0);
});

test('computeNeedleScores: weighted z-sum, reliability, exp weight', () => {
  // Symmetric cohort: all three signals scale together, so each tipster's
  // three z-scores are equal -> needle = (0.45+0.35+0.20)*z = z.
  const rows = [
    row({ name: 'A', longRunRoi: 0.1, recentRoi30d: 0.2, recentRoi7d: 0.3 }),
    row({ name: 'B', longRunRoi: 0.0, recentRoi30d: 0.0, recentRoi7d: 0.0 }),
    row({ name: 'C', longRunRoi: -0.1, recentRoi30d: -0.2, recentRoi7d: -0.3 }),
  ];
  const [a, b, c] = computeNeedleScores(rows);

  const z = 1.224744871; // (0.1/std) for [0.1,0,-0.1], std=sqrt(1/150)
  close(a.zLong, z);
  close(a.zRecent, z);
  close(a.zStreak, z);
  close(a.needleScore, z);
  close(a.reliability, 0.6);
  close(a.finalWeight, 0.6 * Math.exp(z));

  close(b.needleScore, 0);
  close(b.finalWeight, 0.6);

  close(c.needleScore, -z);
  close(c.finalWeight, 0.6 * Math.exp(-z));

  // Needle ranking matches the momentum ordering A > B > C.
  assert.ok(a.needleScore > b.needleScore);
  assert.ok(b.needleScore > c.needleScore);
});

test('computeNeedleScores: shorter losing streak scores higher (streak fallback)', () => {
  // No 7d ROI -> third signal falls back to -longestLosingStreak. With long &
  // recent held equal, the shorter-streak tipster must get the higher needle.
  const rows = [
    row({ name: 'short', longestLosingStreak: 1 }),
    row({ name: 'long', longestLosingStreak: 9 }),
  ];
  const [shortStreak, longStreak] = computeNeedleScores(rows);
  assert.ok(shortStreak.zStreak > longStreak.zStreak);
  assert.ok(shortStreak.needleScore > longStreak.needleScore);
});

test('computeNeedleScores: empty cohort -> empty', () => {
  assert.deepEqual(computeNeedleScores([]), []);
});

test('classifyActive: promotes when 30d ROI and reliability both clear gates', () => {
  const r = classifyActive(false, 0.05, 0.3);
  assert.equal(r.active, true);
  assert.equal(r.action, 'promote');

  // Already active -> stays active, no churn.
  const already = classifyActive(true, 0.05, 0.3);
  assert.equal(already.active, true);
  assert.equal(already.action, 'unchanged');
});

test('classifyActive: reliability gate blocks promotion', () => {
  // Profitable but too few bets (reliability < 0.2) -> not promoted, not demoted.
  const r = classifyActive(false, 0.05, 0.1);
  assert.equal(r.active, false);
  assert.equal(r.action, 'unchanged');
});

test('classifyActive: demotes when recent ROI decays below the floor', () => {
  const r = classifyActive(true, -0.1, 0.5);
  assert.equal(r.active, false);
  assert.equal(r.action, 'demote');

  // Already inactive -> stays inactive, no churn.
  const already = classifyActive(false, -0.1, 0.5);
  assert.equal(already.active, false);
  assert.equal(already.action, 'unchanged');
});

test('classifyActive: middle band leaves membership unchanged', () => {
  // -0.05 <= ROI < 0: neither promote nor demote.
  assert.equal(classifyActive(true, -0.02, 0.5).active, true);
  assert.equal(classifyActive(true, -0.02, 0.5).action, 'unchanged');
  assert.equal(classifyActive(false, -0.02, 0.5).active, false);
  assert.equal(classifyActive(null, -0.02, 0.5).active, false); // new -> inactive
});
