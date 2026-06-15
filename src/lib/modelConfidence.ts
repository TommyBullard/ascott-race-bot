/**
 * Pure confidence-scaling layer (Batch F1) — OBSERVATIONAL ONLY.
 *
 * Derives a data-quality-adjusted confidence from a base confidence value. This
 * is the FIRST step of applying data-quality impact and is deliberately
 * non-invasive: it does NOT change probabilities, selection, or staking. The
 * result is recorded for monitoring/future use; nothing downstream consumes it.
 *
 * No I/O, no side effects, no fabrication: each multiplicative factor is applied
 * ONLY when its proving data is present; missing inputs leave confidence
 * unchanged for that factor. The staleness threshold is imported from
 * `modelDataQuality` so there is a single source of truth.
 */

import { DATA_QUALITY_FLAG, STALE_ODDS_THRESHOLD_MS } from './modelDataQuality';
import { isFiniteNumber } from './dataQualityUtils';

/** Confidence multiplier applied when the latest odds snapshot is stale. */
export const STALE_ODDS_CONFIDENCE_FACTOR = 0.9;

/** Confidence multiplier applied when at least one runner lacks usable odds. */
export const MISSING_RUNNER_ODDS_CONFIDENCE_FACTOR = 0.95;

/**
 * The metric fields {@link computeAdjustedConfidence} reads. Each is `null` when
 * unknown (and the corresponding factor is then skipped). Structurally
 * compatible with `DataQualityMetrics`, so a full metrics object can be passed.
 */
export interface AdjustedConfidenceMetrics {
  market_completeness: number | null;
  odds_age_ms: number | null;
}

/** Clamps a value into the inclusive [0, 1] range. */
function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Computes a data-quality-adjusted confidence from `baseConfidence`.
 *
 * Applies multiplicative factors, each only when its proving data exists:
 *   - `market_completeness` (when known): multiplies confidence directly
 *     (e.g. 0.72 scales confidence to 72%).
 *   - stale odds (when `odds_age_ms` is known and exceeds
 *     {@link STALE_ODDS_THRESHOLD_MS}): multiplies by
 *     {@link STALE_ODDS_CONFIDENCE_FACTOR}.
 *   - `MISSING_RUNNER_ODDS` flag present: multiplies by
 *     {@link MISSING_RUNNER_ODDS_CONFIDENCE_FACTOR}.
 *
 * The result is clamped to [0, 1]. When `baseConfidence` is not a finite number
 * it is returned unchanged. When no factor's inputs are present, the (clamped)
 * base confidence is returned unchanged. Pure: no side effects.
 */
export function computeAdjustedConfidence(
  baseConfidence: number,
  flags: readonly string[],
  metrics: AdjustedConfidenceMetrics,
): number {
  // Unusable base -> return as-is (no fabrication, no NaN coercion).
  if (!isFiniteNumber(baseConfidence)) {
    return baseConfidence;
  }

  let confidence = baseConfidence;

  // Market completeness scales confidence directly when known.
  if (isFiniteNumber(metrics.market_completeness)) {
    confidence *= metrics.market_completeness;
  }

  // Stale odds: fixed haircut when the (known) snapshot age exceeds the threshold.
  if (
    isFiniteNumber(metrics.odds_age_ms) &&
    metrics.odds_age_ms > STALE_ODDS_THRESHOLD_MS
  ) {
    confidence *= STALE_ODDS_CONFIDENCE_FACTOR;
  }

  // Missing runner odds: fixed haircut when the flag is present.
  if (flags.includes(DATA_QUALITY_FLAG.MISSING_RUNNER_ODDS)) {
    confidence *= MISSING_RUNNER_ODDS_CONFIDENCE_FACTOR;
  }

  return clamp01(confidence);
}
