/**
 * Unit tests for the pure confidence-scaling layer (src/lib/modelConfidence.ts).
 *
 * No DB or network: these assert the multiplicative data-quality adjustment,
 * its skip-when-missing behaviour, and [0, 1] clamping. Observational only \u2014 the
 * value does not affect probabilities/selection/staking. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeAdjustedConfidence,
  MISSING_RUNNER_ODDS_CONFIDENCE_FACTOR,
  STALE_ODDS_CONFIDENCE_FACTOR,
} from '../src/lib/modelConfidence';
import { STALE_ODDS_THRESHOLD_MS } from '../src/lib/modelDataQuality';

const EPS = 1e-9;
const close = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < EPS, `expected ${a} \u2248 ${b}`);

const NO_METRICS = { market_completeness: null, odds_age_ms: null };

test('no flags / no metrics -> confidence unchanged', () => {
  close(computeAdjustedConfidence(0.8, [], NO_METRICS), 0.8);
});

test('reduced completeness -> scaled directly', () => {
  close(
    computeAdjustedConfidence(0.8, [], {
      market_completeness: 0.72,
      odds_age_ms: null,
    }),
    0.8 * 0.72,
  );
  // Full completeness (1.0) leaves confidence unchanged.
  close(
    computeAdjustedConfidence(0.8, [], {
      market_completeness: 1,
      odds_age_ms: null,
    }),
    0.8,
  );
});

test('stale odds -> 0.9 reduction when age exceeds the threshold', () => {
  close(
    computeAdjustedConfidence(0.8, [], {
      market_completeness: null,
      odds_age_ms: STALE_ODDS_THRESHOLD_MS + 1,
    }),
    0.8 * STALE_ODDS_CONFIDENCE_FACTOR,
  );
  // Exactly at the threshold is NOT stale (strict greater-than) -> no reduction.
  close(
    computeAdjustedConfidence(0.8, [], {
      market_completeness: null,
      odds_age_ms: STALE_ODDS_THRESHOLD_MS,
    }),
    0.8,
  );
});

test('missing runner odds flag -> 0.95 reduction', () => {
  close(
    computeAdjustedConfidence(0.8, ['MISSING_RUNNER_ODDS'], NO_METRICS),
    0.8 * MISSING_RUNNER_ODDS_CONFIDENCE_FACTOR,
  );
});

test('combined factors -> multiplicative result', () => {
  // completeness 0.5 * stale 0.9 * missing 0.95, on base 0.8.
  close(
    computeAdjustedConfidence(0.8, ['MISSING_RUNNER_ODDS'], {
      market_completeness: 0.5,
      odds_age_ms: STALE_ODDS_THRESHOLD_MS + 60_000,
    }),
    0.8 * 0.5 * 0.9 * 0.95,
  );
});

test('clamping: result never exceeds 1 or drops below 0', () => {
  // No factors apply, but an out-of-range base is clamped.
  close(computeAdjustedConfidence(1.5, [], NO_METRICS), 1);
  close(computeAdjustedConfidence(-0.5, [], NO_METRICS), 0);
  // A normal in-range run stays within bounds.
  const r = computeAdjustedConfidence(0.9, ['MISSING_RUNNER_ODDS'], {
    market_completeness: 0.8,
    odds_age_ms: STALE_ODDS_THRESHOLD_MS + 1,
  });
  assert.ok(r >= 0 && r <= 1);
});

test('missing metrics -> only flag-driven factors apply (no fabrication)', () => {
  // Both metrics null: completeness + stale are skipped; only the flag applies.
  close(
    computeAdjustedConfidence(0.8, ['MISSING_RUNNER_ODDS'], NO_METRICS),
    0.8 * MISSING_RUNNER_ODDS_CONFIDENCE_FACTOR,
  );
  // STALE_ODDS flag present but odds_age_ms unknown -> stale is NOT applied
  // (the stale factor is driven by the metric, not the flag).
  close(computeAdjustedConfidence(0.8, ['STALE_ODDS'], NO_METRICS), 0.8);
});

test('non-finite base confidence -> returned unchanged', () => {
  assert.ok(Number.isNaN(computeAdjustedConfidence(Number.NaN, [], NO_METRICS)));
});
