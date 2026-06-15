/**
 * Pure runner matching for tipster-selection ingestion.
 *
 * Maps a tipped horse name to the `runner_id` of a runner IN A GIVEN RACE, using
 * EXACT, normalised matching only — never fuzzy, never a guess. Normalisation is
 * delegated to the project's existing {@link normalizeHorseName} (lower-cased,
 * country suffix like "(IRE)" stripped, punctuation removed, whitespace
 * collapsed), so matching here is consistent with the rest of the pipeline.
 *
 * The function is pure: it does not fetch data, mutate its inputs, or throw. An
 * empty/blank name, no match, or an AMBIGUOUS match (two runners normalising to
 * the same name) all return `null` — the caller skips and reports those rows
 * rather than attributing a pick to the wrong runner.
 */

import { normalizeHorseName } from './raceSync';

/** The minimal runner shape this matcher needs (id may be a string or number). */
export interface MatchableRunner {
  id: string | number;
  horse_name: string;
}

/**
 * Returns the `runner_id` (as a string) of the single runner whose horse name
 * matches `horseName` after normalisation, or `null` when there is no match or
 * more than one candidate (ambiguous). Exact normalised equality only — a
 * partial/fuzzy overlap (e.g. "Frank" vs "Frankel") never matches.
 *
 * Pure and side-effect free: `runners` and its elements are not mutated.
 */
export function matchRunnerId(
  runners: readonly MatchableRunner[],
  horseName: string,
): string | null {
  const target = normalizeHorseName(horseName);
  if (target === '') {
    return null;
  }

  let matchedId: string | null = null;
  let matchCount = 0;
  for (const runner of runners) {
    if (normalizeHorseName(runner.horse_name) === target) {
      matchCount += 1;
      matchedId = String(runner.id);
    }
  }

  // Exactly one match resolves; zero or several (ambiguous) do not.
  return matchCount === 1 ? matchedId : null;
}
