/**
 * Pure helpers for append-only model-run history (`is_current` / `superseded_at`).
 *
 * No I/O — these are the deterministic pieces the producer
 * ({@link import('./runModelForRace')}) and the read paths
 * ({@link import('./raceData')}) share so the supersession + current-row
 * filtering logic is unit-testable without a live database.
 *
 * Model: output is APPEND-ONLY. A fresh run writes new rows stamped
 * {@link currentMarker} (`is_current = true`, `superseded_at = null`); the
 * race's prior current rows are UPDATED with {@link buildSupersedePatch}
 * (`is_current = false`, `superseded_at = now`). Historical rows are never
 * deleted, so any past run remains queryable.
 */

/** Fields stamped on freshly-written, current model output rows. */
export interface CurrentMarker {
  is_current: true;
  superseded_at: null;
}

/**
 * The marker merged into every newly-inserted current row (model_runs,
 * model_runner_scores, recommendations).
 */
export function currentMarker(): CurrentMarker {
  return { is_current: true, superseded_at: null };
}

/** Fields stamped on a freshly-written, NON-current (diagnostic) output row. */
export interface NotCurrentMarker {
  is_current: false;
  superseded_at: null;
}

/**
 * Marker for a run that is written but must NOT become the current run — e.g. an
 * explicit post-off diagnostic run, which must never supersede the valid pre-off
 * run. Distinct from {@link buildSupersedePatch}: this stamps a brand-new row as
 * non-current at insert time (no `superseded_at`), rather than retiring a row
 * that used to be current.
 */
export function notCurrentMarker(): NotCurrentMarker {
  return { is_current: false, superseded_at: null };
}

/** Patch applied to a previously-current row when a newer run supersedes it. */
export interface SupersedePatch {
  is_current: false;
  /** ISO 8601 timestamp the row stopped being current. */
  superseded_at: string;
}

/**
 * Builds the patch that marks a prior current row as superseded. `now` is
 * injectable so tests are deterministic; it defaults to the wall clock.
 */
export function buildSupersedePatch(now: Date = new Date()): SupersedePatch {
  return { is_current: false, superseded_at: now.toISOString() };
}

/**
 * Given the ids of a race's currently-current model runs, returns the ids that
 * must be superseded (UPDATED, never deleted). Ids are normalised to strings.
 *
 * `excludeRunId` omits a run from the set. The producer inserts the new current
 * run FIRST, so its query for `is_current = true` runs INCLUDES the just-
 * inserted run; passing its id as `excludeRunId` leaves only the OLDER current
 * runs to supersede (and keeps the new run + its children current). When
 * omitted, every supplied id is returned.
 */
export function selectRunIdsToSupersede(
  currentRunIds: readonly (string | number)[],
  excludeRunId?: string | number,
): string[] {
  const exclude = excludeRunId === undefined ? undefined : String(excludeRunId);
  return currentRunIds.map(String).filter((id) => id !== exclude);
}
