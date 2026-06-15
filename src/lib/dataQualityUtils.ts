/**
 * Shared, pure utilities for the data-quality modules (Batch G1).
 *
 * Consolidates helpers that were duplicated across `modelDataQuality.ts`,
 * `modelDataQualitySummary.ts`, and `modelConfidence.ts` so there is a single
 * source of truth and no future drift. This is a consolidation module only: it
 * contains NO logic, thresholds, or formatting decisions of its own.
 *
 * The `DataQualityFlag` type is imported type-only (erased at runtime) so this
 * module has no runtime dependency on `modelDataQuality.ts`, avoiding an import
 * cycle.
 */

import type { DataQualityFlag } from './modelDataQuality';

/** True when `value` is a usable, finite number. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Canonical human-readable base label for each data-quality flag (any
 * metric-derived detail is appended by the caller, not here). Single source of
 * truth shared by every data-quality summary/formatter.
 *
 * NOTE (Batch G1): `STALE_ODDS` is `'Stale odds'` \u2014 the wording already used by
 * the production summary (`buildDataQualitySummary`). The legacy
 * `formatDataQualitySummary` previously used `'Odds are stale'`; it now uses
 * this canonical label too.
 */
export const FLAG_LABEL: Record<DataQualityFlag, string> = {
  NO_MARKET_SNAPSHOT: 'No market snapshot',
  NO_PRICED_RUNNERS: 'No priced runners',
  MISSING_RUNNER_ODDS: 'Missing runner odds',
  LOW_MARKET_COMPLETENESS: 'Low market completeness',
  STALE_ODDS: 'Stale odds',
  LOW_RUNNER_COUNT: 'Low runner count',
  NO_TIPSTER_SELECTIONS: 'No tipster selections',
  TIPSTER_SELECTIONS_UNMATCHED: 'Tipster selections unmatched',
};
