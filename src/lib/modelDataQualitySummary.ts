/**
 * Pure, read-only data-quality SUMMARY builder (Batch F3) — observability only.
 *
 * Turns the already-computed data-quality intelligence (flags, metrics,
 * run_quality, adjusted/base confidence, model adjustments) into human-readable
 * lines plus a one-line short summary, for downstream UI / dashboards /
 * debugging. It changes NOTHING about model behaviour, selection, staking, or
 * probabilities.
 *
 * INTEGRITY: never fabricates. A metric-derived detail is shown ONLY when the
 * metric is present; missing values are simply omitted. Inputs are never
 * mutated; output ordering is deterministic. Flag severity is sourced from
 * {@link getFlagSeverity} (single source) rather than re-deciding it here.
 */

import { getFlagSeverity, type DataQualityMetrics } from './modelDataQuality';
import type { DataQualityFlag, RunQuality } from './modelDataQuality';
import type { ModelAdjustments } from './modelDataQuality';
import { FLAG_LABEL, isFiniteNumber } from './dataQualityUtils';

/** Emoji markers (consistent across the summary). */
const ICON = {
  ok: '\u2705', // ✅
  warning: '\u26A0', // ⚠
  info: '\u2139', // ℹ
  suppression: '\u{1F6D1}', // 🛑
  confidence: '\u{1F4C9}', // 📉
} as const;

/** Metrics this summary reads (subset of {@link DataQualityMetrics}). */
export type DataQualitySummaryMetrics = Pick<
  DataQualityMetrics,
  | 'market_completeness'
  | 'priced_runner_count'
  | 'declared_runner_count'
  | 'odds_age_ms'
>;

/** The structured summary returned by {@link buildDataQualitySummary}. */
export interface DataQualitySummary {
  summary: string[];
  short_summary: string;
  run_quality: string;
}

/** Emoji marker for a flag, from its (single-source) severity. */
function iconForFlag(flag: string): string {
  const severity = getFlagSeverity(flag);
  if (severity === 'critical' || severity === 'warning') {
    return ICON.warning;
  }
  return ICON.info;
}

/** Optional metric-derived `(detail)` for a flag; '' when the metric is absent. */
function flagDetail(flag: string, metrics: DataQualitySummaryMetrics): string {
  if (
    flag === 'LOW_MARKET_COMPLETENESS' &&
    isFiniteNumber(metrics.market_completeness)
  ) {
    return ` (${metrics.market_completeness.toFixed(2)})`;
  }
  if (flag === 'STALE_ODDS' && isFiniteNumber(metrics.odds_age_ms)) {
    return ` (${(metrics.odds_age_ms / 60_000).toFixed(1)} min old)`;
  }
  if (
    flag === 'MISSING_RUNNER_ODDS' &&
    isFiniteNumber(metrics.priced_runner_count) &&
    isFiniteNumber(metrics.declared_runner_count)
  ) {
    return ` (${metrics.priced_runner_count}/${metrics.declared_runner_count} priced)`;
  }
  return '';
}

/** One short clause per flag for the short summary (with metric detail). */
function shortClause(flag: string, metrics: DataQualitySummaryMetrics): string {
  const label = FLAG_LABEL[flag as DataQualityFlag] ?? flag;
  return `${label}${flagDetail(flag, metrics)}`;
}

/**
 * Builds a structured, human-readable summary of a run's data quality.
 *
 * `summary` is a list of display lines (run-quality header, one per flag, an
 * optional confidence-change line, and an optional suppression line).
 * `short_summary` is a single line: the run-quality verdict followed by the top
 * issues. `run_quality` echoes the verdict.
 *
 * Pure: inputs are not mutated and the output is deterministic (flags are
 * rendered in the order given, which is already canonical from
 * `assessDataQuality`; duplicates are removed while preserving first position).
 */
export function buildDataQualitySummary(
  flags: readonly string[],
  metrics: DataQualitySummaryMetrics,
  runQuality: RunQuality,
  adjustedConfidence?: number,
  baseConfidence?: number,
  modelAdjustments?: ModelAdjustments,
): DataQualitySummary {
  // De-duplicate flags while preserving first-seen order (no input mutation).
  const uniqueFlags = [...new Set(flags)];

  const summary: string[] = [];

  // Header: run-quality verdict (✅ for OK, ⚠ otherwise).
  const headerIcon = runQuality === 'OK' ? ICON.ok : ICON.warning;
  summary.push(`${headerIcon} Data quality: ${runQuality}`);

  // One line per flag, marked by severity and enriched with a metric detail.
  for (const flag of uniqueFlags) {
    const label = FLAG_LABEL[flag as DataQualityFlag] ?? flag;
    summary.push(`${iconForFlag(flag)} ${label}${flagDetail(flag, metrics)}`);
  }

  // Confidence change (only when both values are present and they differ).
  if (
    isFiniteNumber(baseConfidence) &&
    isFiniteNumber(adjustedConfidence) &&
    baseConfidence !== adjustedConfidence
  ) {
    summary.push(
      `${ICON.confidence} Confidence adjusted: ${baseConfidence.toFixed(2)} \u2192 ${adjustedConfidence.toFixed(2)}`,
    );
  }

  // Suppression notice (only when staking was suppressed).
  if (modelAdjustments?.suppressStaking) {
    const reason = uniqueFlags.includes('NO_PRICED_RUNNERS')
      ? 'no priced runners'
      : uniqueFlags.includes('LOW_MARKET_COMPLETENESS')
        ? 'low market completeness'
        : 'insufficient data quality';
    summary.push(`${ICON.suppression} Staking suppressed due to ${reason}`);
  }

  // Short, one-line summary: verdict + the issues, each with its metric detail,
  // in canonical (input) order — deterministic and stable. OK with no issues
  // stays terse.
  const clauses = uniqueFlags.map((f) => shortClause(f, metrics));
  const short_summary =
    clauses.length > 0 ? `${runQuality} \u2014 ${clauses.join(', ')}` : runQuality;

  return { summary, short_summary, run_quality: runQuality };
}
