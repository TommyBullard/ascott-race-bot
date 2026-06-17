/**
 * Pure selection for the dashboard's top summary bar.
 *
 * The `/api/accuracy` response carries TWO summaries:
 *   - `accuracy`  : the global, lifetime record (all settled races, all time).
 *   - `performance`: the per-day/course record, evaluated AS-OF OFF TIME (the
 *     corrected, pre-off model run — see `computeModelPerformance`).
 *
 * When the dashboard is scoped to a meeting day/course (a `?date` / `?day` /
 * `?course` deep link), the top summary must reflect the **race-day**
 * `performance` block, NOT the lifetime `accuracy` — otherwise the header shows
 * lifetime totals while the performance panel below shows the (different)
 * race-day record. The lifetime object is preserved for the unscoped view and
 * never overrides a scoped race-day summary.
 *
 * No React, no I/O — so the choice is unit-testable.
 */

/** Minimal shape of the lifetime `accuracy` object (server `ModelAccuracy`). */
export interface LifetimeAccuracyLike {
  racesSettled: number;
  winners: number;
  strikeRatePct: number;
  profitPoints: number;
  roiPct: number;
  computedAt?: string | null;
}

/** Minimal shape of the per-day `performance` object (server `ModelPerformanceResult`). */
export interface RaceDayPerformanceLike {
  settled_count: number;
  winners: number;
  strike_rate: number;
  profit_loss: number;
  roi: number;
  computedAt?: string | null;
  /** Run-selection rule behind the figures; `pre_off` is the API default. */
  evaluationMode?: 'pre_off' | 'current';
}

/** A normalized, source-tagged summary for the header bar. */
export interface DashboardSummary {
  /** Which block produced the figures. */
  source: 'lifetime' | 'race_day';
  winners: number;
  settled: number;
  strikeRatePct: number;
  profitLoss: number;
  roiPct: number;
  /** When the underlying snapshot was computed (ISO 8601), or null. */
  computedAt: string | null;
  /**
   * Evaluation rule for a race-day summary (`pre_off` by default, mirroring
   * `/api/accuracy`); null for the lifetime summary, which is not off-time scoped.
   */
  evaluationMode: 'pre_off' | 'current' | null;
}

/** Query-string keys that scope the dashboard to a meeting day/course. */
const SCOPE_KEYS = ['date', 'day', 'course'] as const;

/**
 * True when the dashboard URL query scopes the view to a meeting day/course
 * (any non-empty `?date` / `?day` / `?course`). A leading `?` is optional.
 * Pure; tolerates null/undefined/empty.
 */
export function hasRaceDayScope(search: string | null | undefined): boolean {
  if (!search) return false;
  const params = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
  return SCOPE_KEYS.some((key) => {
    const value = params.get(key);
    return value !== null && value.trim() !== '';
  });
}

/**
 * Chooses the figures for the dashboard's top summary bar.
 *
 *   - SCOPED (date/course active) + a `performance` block present → use the
 *     race-day `performance` (the corrected, pre-off record). The legacy
 *     lifetime `accuracy` does NOT override it.
 *   - Otherwise → use the lifetime `accuracy` (global record).
 *   - Neither available → null (the bar renders nothing).
 *
 * Pure; never throws.
 */
export function selectDashboardSummary(
  accuracy: LifetimeAccuracyLike | null | undefined,
  performance: RaceDayPerformanceLike | null | undefined,
  scoped: boolean,
): DashboardSummary | null {
  if (scoped && performance) {
    return {
      source: 'race_day',
      winners: performance.winners,
      settled: performance.settled_count,
      strikeRatePct: performance.strike_rate,
      profitLoss: performance.profit_loss,
      roiPct: performance.roi,
      computedAt: performance.computedAt ?? null,
      // Surface what the API reported; default to the API's own default.
      evaluationMode: performance.evaluationMode ?? 'pre_off',
    };
  }
  if (accuracy) {
    return {
      source: 'lifetime',
      winners: accuracy.winners,
      settled: accuracy.racesSettled,
      strikeRatePct: accuracy.strikeRatePct,
      profitLoss: accuracy.profitPoints,
      roiPct: accuracy.roiPct,
      computedAt: accuracy.computedAt ?? null,
      evaluationMode: null,
    };
  }
  return null;
}

/**
 * Whether the dashboard's top AccuracyBar should render.
 *
 * A `source: 'race_day'` summary is the scoped, pre-off record that the
 * Recommendation performance panel already shows in full — rendering the bar
 * as well would duplicate the same winners/strike/profit/ROI figures. Hide the
 * bar in that case; keep it for the unscoped lifetime/global summary (and only
 * when a summary is present at all).
 *
 * Pure; tolerates null/undefined.
 */
export function shouldShowAccuracyBar(
  summary: DashboardSummary | null | undefined,
): boolean {
  return !!summary && summary.source !== 'race_day';
}
