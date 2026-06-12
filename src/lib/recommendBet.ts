/**
 * Bet recommendation for a single race — read directly from the DB model
 * pipeline's output.
 *
 * The probability model, anti-crowd ("de-herded") support, EV, confidence, and
 * fractional-Kelly staking are all computed upstream and persisted in
 * `model_runs` / `model_runner_scores` / `recommendations`. This module simply
 * reads the latest run's top recommendation; it no longer recomputes anything
 * in TypeScript.
 *
 * Returns `null` when the race has no model run / recommendation yet.
 */

import {
  fetchRaceRecommendations,
  type RaceRecommendation,
} from './raceData';

export type { RaceRecommendation } from './raceData';

/**
 * Returns the top (rank 1) recommendation for `race_id`, or `null` when the
 * race has no recommendations yet.
 *
 * @throws if any underlying Supabase query fails.
 */
export async function recommendBet(
  race_id: string,
): Promise<RaceRecommendation | null> {
  const recommendations = await fetchRaceRecommendations(race_id);
  if (recommendations.length === 0) {
    return null;
  }

  // fetchRaceRecommendations orders by recommendation_rank ascending, so the
  // first row is the top pick; fall back to an explicit rank-1 lookup.
  return recommendations.find((rec) => rec.rank === 1) ?? recommendations[0];
}

