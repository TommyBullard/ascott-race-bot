/**
 * Unit tests for the review-only tipster evidence scoring
 * (src/lib/tipsterEvidenceScore.ts).
 *
 * No DB, no network, no model: these assert the advisory triage score, tier, and
 * reasons across strong / watchlist / reject / missing-field cases, the clamp
 * bounds, and that the input is never mutated. The score is explicitly NOT fed
 * to the model. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreTipsterEvidence,
  tierForScore,
  TIER_1_MIN_SCORE,
  WATCHLIST_MIN_SCORE,
  type EvidenceInput,
} from '../src/lib/tipsterEvidenceScore';

// ---------------------------------------------------------------------------
// Whole-assessment scenarios
// ---------------------------------------------------------------------------

test('high-evidence candidate -> tier_1_candidate (full marks, no penalties)', () => {
  const input: EvidenceInput = {
    proofedLongRunRecord: true,
    recentFormEvidence: true,
    sampleSize: 1000,
    transparentFullHistory: true,
    valueOrientation: true,
    ukIreRelevance: true,
    royalAscotRelevance: true,
    sourceAccessibleCompliant: true,
    proofUrl: 'https://example.com/proof',
  };
  const result = scoreTipsterEvidence(input);
  assert.equal(result.evidence_score, 100);
  assert.equal(result.evidence_tier, 'tier_1_candidate');
  assert.ok(result.reasons.some((r) => r.includes('proofed long-run record')));
  // No penalty reasons present.
  assert.equal(result.reasons.some((r) => r.startsWith('-')), false);
});

test('watchlist candidate -> watchlist (partial evidence, one penalty)', () => {
  const input: EvidenceInput = {
    proofedLongRunRecord: true, // +20
    sampleSize: 60, // +8 (50..199)
    ukIreRelevance: true, // +10
    sourceAccessibleCompliant: true, // +10
    proofUrl: 'https://example.com/proof',
    unclearStaking: true, // -8
  };
  const result = scoreTipsterEvidence(input);
  assert.equal(result.evidence_score, 40); // 48 - 8
  assert.equal(result.evidence_tier, 'watchlist');
  assert.ok(result.reasons.some((r) => r.includes('unclear staking')));
});

test('reject candidate -> reject_or_research_more (penalties dominate, clamped to 0)', () => {
  const input: EvidenceInput = {
    ukIreRelevance: true, // +10
    screenshotOnly: true, // -15
    marketingOnly: true, // -15
    // no sample size (-10), no proof URL (-10)
  };
  const result = scoreTipsterEvidence(input);
  assert.equal(result.evidence_score, 0); // clamp(10 - 50)
  assert.equal(result.evidence_tier, 'reject_or_research_more');
  assert.ok(result.reasons.some((r) => r.includes('screenshot-only')));
  assert.ok(result.reasons.some((r) => r.includes('marketing-only')));
  assert.ok(result.reasons.some((r) => r.includes('no sample size')));
  assert.ok(result.reasons.some((r) => r.includes('no proof URL')));
});

test('missing fields -> reject_or_research_more, never throws, honest reasons', () => {
  const result = scoreTipsterEvidence({});
  assert.equal(result.evidence_score, 0);
  assert.equal(result.evidence_tier, 'reject_or_research_more');
  // The two essential-field penalties are reported.
  assert.ok(result.reasons.some((r) => r.includes('no sample size')));
  assert.ok(result.reasons.some((r) => r.includes('no proof URL')));
  // Nothing was credited.
  assert.equal(result.reasons.some((r) => r.startsWith('+')), false);
});

test('does not mutate its input', () => {
  const input: EvidenceInput = {
    proofedLongRunRecord: true,
    sampleSize: 250,
    proofUrl: 'https://example.com/proof',
  };
  const snapshot = JSON.stringify(input);
  scoreTipsterEvidence(input);
  assert.equal(JSON.stringify(input), snapshot);
});

// ---------------------------------------------------------------------------
// Scoring details
// ---------------------------------------------------------------------------

test('tiny sample is credited a little but penalised (net caution)', () => {
  const result = scoreTipsterEvidence({
    sampleSize: 10, // +4 then -10 tiny
    proofUrl: 'https://example.com/proof',
  });
  // 4 - 10 = -6 -> clamped to 0.
  assert.equal(result.evidence_score, 0);
  assert.ok(result.reasons.some((r) => r.includes('tiny sample')));
  // Tiny sample must NOT also trigger the "no sample size" penalty.
  assert.equal(result.reasons.some((r) => r.includes('no sample size')), false);
});

test('sample-size bands increase the credit with N', () => {
  const base: EvidenceInput = { proofUrl: 'https://example.com/p' };
  const small = scoreTipsterEvidence({ ...base, sampleSize: 120 }).evidence_score; // +8
  const mid = scoreTipsterEvidence({ ...base, sampleSize: 300 }).evidence_score; // +12
  const big = scoreTipsterEvidence({ ...base, sampleSize: 800 }).evidence_score; // +16
  assert.equal(small, 8);
  assert.equal(mid, 12);
  assert.equal(big, 16);
});

test('non-positive / non-finite sample size is treated as no sample', () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
    const result = scoreTipsterEvidence({
      sampleSize: bad as number | null | undefined,
      proofUrl: 'https://example.com/p',
    });
    assert.ok(result.reasons.some((r) => r.includes('no sample size')));
  }
});

test('blank/whitespace proof URL counts as no proof URL', () => {
  const result = scoreTipsterEvidence({ proofUrl: '   ', sampleSize: 500 });
  assert.ok(result.reasons.some((r) => r.includes('no proof URL')));
});

test('only an explicit boolean true credits a dimension (truthy strings ignored)', () => {
  const result = scoreTipsterEvidence({
    // Deliberately wrong types — must NOT be credited.
    proofedLongRunRecord: 'yes' as unknown as boolean,
    valueOrientation: 1 as unknown as boolean,
    sampleSize: 500,
    proofUrl: 'https://example.com/p',
  });
  // Only sample (+16) credited; the two bad-typed flags ignored.
  assert.equal(result.evidence_score, 16);
  assert.equal(result.reasons.some((r) => r.includes('proofed long-run record')), false);
  assert.equal(result.reasons.some((r) => r.includes('value orientation')), false);
});

test('score is clamped to 0..100', () => {
  const maxed = scoreTipsterEvidence({
    proofedLongRunRecord: true,
    recentFormEvidence: true,
    sampleSize: 5000,
    transparentFullHistory: true,
    valueOrientation: true,
    ukIreRelevance: true,
    royalAscotRelevance: true,
    sourceAccessibleCompliant: true,
    proofUrl: 'https://example.com/proof',
  });
  assert.equal(maxed.evidence_score, 100); // exactly 100, not more

  const floored = scoreTipsterEvidence({
    screenshotOnly: true,
    marketingOnly: true,
    unclearStaking: true,
  });
  assert.equal(floored.evidence_score, 0); // never negative
});

test('output shape is advisory-only (score, tier, reasons) — nothing model-facing', () => {
  const result = scoreTipsterEvidence({ sampleSize: 500, proofUrl: 'https://e.com/p' });
  assert.deepEqual(Object.keys(result).sort(), [
    'evidence_score',
    'evidence_tier',
    'reasons',
  ]);
});

// ---------------------------------------------------------------------------
// tierForScore boundaries
// ---------------------------------------------------------------------------

test('tierForScore: boundaries are inclusive at the floor', () => {
  assert.equal(tierForScore(100), 'tier_1_candidate');
  assert.equal(tierForScore(TIER_1_MIN_SCORE), 'tier_1_candidate'); // 70
  assert.equal(tierForScore(TIER_1_MIN_SCORE - 1), 'watchlist'); // 69
  assert.equal(tierForScore(WATCHLIST_MIN_SCORE), 'watchlist'); // 40
  assert.equal(tierForScore(WATCHLIST_MIN_SCORE - 1), 'reject_or_research_more'); // 39
  assert.equal(tierForScore(0), 'reject_or_research_more');
});
