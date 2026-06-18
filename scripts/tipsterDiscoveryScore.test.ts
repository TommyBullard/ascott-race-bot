/**
 * Unit tests for the pure Tipster Discovery scoring/plan module
 * (src/lib/tipsterDiscoveryScore.ts).
 *
 * No network or DB. These lock the advisory confidence framework, the dedup
 * rules, and the safety invariant that capture is ALWAYS `status: 'pending'`
 * and NEVER fabricates a missing metric. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreDiscoveryConfidence,
  reliabilityOf,
  recencyDaysOf,
  normalizeTipsterName,
  discoveryDedupeKey,
  toDiscoveryCandidateRow,
  buildDiscoveryPlan,
  tierForScore,
  TIER_1_MIN_SCORE,
  WATCHLIST_MIN_SCORE,
  type DiscoveredTipsterProfile,
} from '../src/lib/tipsterDiscoveryScore';

const NOW = new Date('2026-06-18T12:00:00Z');

test('reliabilityOf: shrinks with sample size; 0 when absent/non-positive', () => {
  assert.equal(reliabilityOf(null), 0);
  assert.equal(reliabilityOf(0), 0);
  assert.equal(reliabilityOf(-5), 0);
  assert.equal(reliabilityOf(400), 0.5); // N / (N + 400)
  assert.ok(reliabilityOf(1200) > reliabilityOf(400));
});

test('recencyDaysOf: whole days since last seen; null when unknown; floors at 0', () => {
  assert.equal(recencyDaysOf(null, NOW), null);
  assert.equal(recencyDaysOf('', NOW), null);
  assert.equal(recencyDaysOf('2026-06-18', NOW), 0);
  assert.equal(recencyDaysOf('2026-06-15', NOW), 3);
  // A future date never goes negative.
  assert.equal(recencyDaysOf('2026-06-20', NOW), 0);
});

test('tierForScore: thresholds at 70 / 40', () => {
  assert.equal(tierForScore(TIER_1_MIN_SCORE), 'tier_1_candidate');
  assert.equal(tierForScore(WATCHLIST_MIN_SCORE), 'watchlist');
  assert.equal(tierForScore(WATCHLIST_MIN_SCORE - 0.1), 'reject_or_research_more');
});

test('scoreDiscoveryConfidence: strong, profitable, fresh, large sample -> tier_1', () => {
  const result = scoreDiscoveryConfidence(
    {
      sampleSize: 800,
      strikeRate: 0.32,
      placedRate: 0.55,
      roi: 0.18,
      roiRecent: 0.12,
      lastSeenDate: '2026-06-17',
    },
    { now: NOW },
  );
  assert.equal(result.confidence_tier, 'tier_1_candidate');
  assert.ok(result.discovery_confidence >= TIER_1_MIN_SCORE);
  assert.equal(result.recency_days, 1);
  assert.ok(result.reliability > 0.6);
});

test('scoreDiscoveryConfidence: no metrics at all -> 0, reject, with penalties (never fabricates)', () => {
  const result = scoreDiscoveryConfidence({}, { now: NOW });
  assert.equal(result.discovery_confidence, 0);
  assert.equal(result.confidence_tier, 'reject_or_research_more');
  assert.equal(result.recency_days, null);
  assert.equal(result.reliability, 0);
  // The essential-evidence penalties are surfaced for the operator.
  assert.ok(result.reasons.some((r) => r.includes('no sample size')));
  assert.ok(result.reasons.some((r) => r.includes('no ROI evidence')));
});

test('scoreDiscoveryConfidence: tiny sample is penalised vs a large one', () => {
  const base = { roi: 0.1, strikeRate: 0.25, lastSeenDate: '2026-06-17' };
  const tiny = scoreDiscoveryConfidence({ ...base, sampleSize: 20 }, { now: NOW });
  const large = scoreDiscoveryConfidence({ ...base, sampleSize: 800 }, { now: NOW });
  assert.ok(tiny.discovery_confidence < large.discovery_confidence);
  assert.ok(tiny.reasons.some((r) => r.includes('tiny sample')));
});

test('scoreDiscoveryConfidence: a stale record loses recency credit and is penalised', () => {
  const fresh = scoreDiscoveryConfidence(
    { sampleSize: 600, roi: 0.1, lastSeenDate: '2026-06-17' },
    { now: NOW },
  );
  const stale = scoreDiscoveryConfidence(
    { sampleSize: 600, roi: 0.1, lastSeenDate: '2026-01-01' },
    { now: NOW },
  );
  assert.ok(stale.discovery_confidence < fresh.discovery_confidence);
  assert.ok(stale.reasons.some((r) => r.includes('stale record')));
});

test('scoreDiscoveryConfidence: a losing ROI scores below break-even', () => {
  const losing = scoreDiscoveryConfidence(
    { sampleSize: 600, roi: -0.15, lastSeenDate: '2026-06-17' },
    { now: NOW },
  );
  const breakeven = scoreDiscoveryConfidence(
    { sampleSize: 600, roi: 0, lastSeenDate: '2026-06-17' },
    { now: NOW },
  );
  assert.ok(losing.discovery_confidence < breakeven.discovery_confidence);
});

test('scoreDiscoveryConfidence: winnerRate is used when strikeRate is absent', () => {
  const withStrike = scoreDiscoveryConfidence(
    { sampleSize: 600, roi: 0.1, strikeRate: 0.3, lastSeenDate: '2026-06-17' },
    { now: NOW },
  );
  const withWinner = scoreDiscoveryConfidence(
    { sampleSize: 600, roi: 0.1, winnerRate: 0.3, lastSeenDate: '2026-06-17' },
    { now: NOW },
  );
  assert.equal(withStrike.discovery_confidence, withWinner.discovery_confidence);
});

test('normalizeTipsterName / discoveryDedupeKey: case + whitespace insensitive', () => {
  assert.equal(normalizeTipsterName('  Sharp   Sam  '), 'sharp sam');
  assert.equal(
    discoveryDedupeKey('Racing-Post', '  Sharp  Sam '),
    'racing-post::sharp sam',
  );
});

test('toDiscoveryCandidateRow: status is always pending; metrics verbatim; missing stay null', () => {
  const row = toDiscoveryCandidateRow(
    {
      discoveredName: '  Sharp Sam ',
      sourceLabel: 'racing-post-tips',
      sourceUrl: 'https://example.com/leaderboard',
      profileUrl: ' https://example.com/sharp ',
      affiliation: 'Racing Post',
      metrics: { sampleSize: 600, roi: 0.12, strikeRate: 0.28, lastSeenDate: '2026-06-17' },
    },
    { now: NOW },
  );
  assert.equal(row.status, 'pending');
  assert.equal(row.discovered_name, 'Sharp Sam');
  assert.equal(row.normalized_name, 'sharp sam');
  assert.equal(row.profile_url, 'https://example.com/sharp');
  assert.equal(row.roi, 0.12);
  // Metrics the source did not publish stay null — never invented.
  assert.equal(row.placed_rate, null);
  assert.equal(row.roi_recent, null);
  assert.equal(row.winner_rate, null);
  assert.ok(row.discovery_confidence > 0);
  assert.ok(Array.isArray(row.confidence_reasons));
});

test('buildDiscoveryPlan: dedups by (source, name), keeping the largest sample', () => {
  const profiles: DiscoveredTipsterProfile[] = [
    {
      discoveredName: 'Sharp Sam',
      sourceLabel: 'src-a',
      metrics: { sampleSize: 120, roi: 0.05 },
    },
    {
      discoveredName: 'sharp  sam', // same person, different sample
      sourceLabel: 'src-a',
      metrics: { sampleSize: 900, roi: 0.2 },
    },
    {
      discoveredName: 'Sharp Sam', // same name, DIFFERENT source -> distinct
      sourceLabel: 'src-b',
      metrics: { sampleSize: 300, roi: 0.1 },
    },
    {
      discoveredName: '   ', // blank -> skipped
      sourceLabel: 'src-a',
      metrics: {},
    },
  ];

  const plan = buildDiscoveryPlan(profiles, { now: NOW });
  assert.equal(plan.received, 4);
  assert.equal(plan.deduped, 2); // (src-a/sharp sam) collapsed; (src-b/sharp sam) separate; blank dropped

  const srcA = plan.rows.find((r) => r.source_label === 'src-a');
  assert.ok(srcA);
  assert.equal(srcA?.sample_size, 900); // most-proofed row wins the collapse
  assert.ok(plan.rows.every((r) => r.status === 'pending'));
});
