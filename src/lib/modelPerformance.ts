/**
 * Pure model recommendation performance maths (Phase 5B).
 *
 * Aggregates the model's rank-1 recommendations into accuracy + ROI metrics from
 * the STORED recommendation odds and stake (not a re-derived settlement price).
 * It is deliberately honest and side-effect free:
 *
 *   - PENDING RACES ARE NEVER COUNTED AS LOSSES. A recommendation whose race has
 *     no recorded result yet contributes to `recommendations_total` /
 *     `pending_count` only — never to winners, losers, strike rate, or P/L.
 *   - NEVER FABRICATES. A winning pick with no usable stored odds contributes a
 *     0 return (the win is still counted), rather than inventing a price.
 *   - NO DB, NO I/O, NO MUTATION — so every rule below is unit-testable.
 *
 * Profit/loss is at the stored stake on the stored decimal odds: a win returns
 * `stake * (odds - 1)`, a loss returns `-stake`. ROI is P/L over the total
 * settled stake. A zero/blank stake therefore contributes nothing to P/L (a
 * stake-suppressed pick is correctly money-neutral) without affecting the
 * pick-accuracy strike rate.
 */

import { isFiniteNumber } from './dataQualityUtils';

/** One evaluated rank-1 recommendation (already matched to its race outcome). */
export interface RecommendationOutcome {
  /** True when the race has a recorded result (a winner is known). */
  settled: boolean;
  /** True when the model's pick won. Only meaningful when `settled`. */
  won: boolean;
  /** Stored recommendation decimal odds, or null when not recorded. */
  odds: number | null;
  /** Stored recommendation stake (points/units), or null when not recorded. */
  stake: number | null;
  /** Stored expected value (per 1 unit), or null when not recorded. */
  ev: number | null;
}

/** Aggregated performance over a set of recommendations. */
export interface ModelPerformance {
  /** All rank-1 recommendations in scope (settled + pending). */
  recommendations_total: number;
  /** Recommendations whose race has a recorded result. */
  settled_count: number;
  /** Recommendations still awaiting a result (never counted as losses). */
  pending_count: number;
  /** Settled picks that won. */
  winners: number;
  /** Settled picks that lost. */
  losers: number;
  /** winners / settled_count * 100 (0 when nothing settled). */
  strike_rate: number;
  /** Cumulative P/L at stored stake/odds over settled picks only. */
  profit_loss: number;
  /** profit_loss / total_staked * 100 (0 when no settled stake). */
  roi: number;
  /** Mean stored EV across all recommendations with a finite EV, else null. */
  average_ev: number | null;
  /** Total settled stake (the ROI denominator); exposed for transparency. */
  total_staked: number;
  /** Races that had a model run but produced no rank-1 recommendation. */
  no_bet_races: number;
}

/** A stake usable for P/L: a finite, positive number, else 0 (never negative). */
function usableStake(stake: number | null): number {
  return isFiniteNumber(stake) && stake > 0 ? stake : 0;
}

/**
 * Aggregates evaluated recommendations into {@link ModelPerformance}.
 *
 * `noBetRaces` is supplied by the caller (races that ran the model but produced
 * no recommendation) since it cannot be derived from the recommendation list
 * itself. Pure; never throws.
 */
export function summarizeModelPerformance(
  outcomes: readonly RecommendationOutcome[],
  noBetRaces = 0,
): ModelPerformance {
  let settledCount = 0;
  let winners = 0;
  let losers = 0;
  let profit = 0;
  let staked = 0;
  let evSum = 0;
  let evCount = 0;

  for (const o of outcomes) {
    if (isFiniteNumber(o.ev)) {
      evSum += o.ev;
      evCount += 1;
    }

    // Pending races are NEVER counted as wins or losses (req 5).
    if (!o.settled) continue;

    settledCount += 1;
    const stake = usableStake(o.stake);
    staked += stake;

    if (o.won) {
      winners += 1;
      // A win pays stake*(odds-1); a win with no usable price returns 0 (no
      // fabrication) but is still a winning pick.
      if (isFiniteNumber(o.odds) && o.odds > 1) {
        profit += stake * (o.odds - 1);
      }
    } else {
      losers += 1;
      profit -= stake;
    }
  }

  const total = outcomes.length;
  return {
    recommendations_total: total,
    settled_count: settledCount,
    pending_count: total - settledCount,
    winners,
    losers,
    strike_rate: settledCount > 0 ? (winners / settledCount) * 100 : 0,
    profit_loss: profit,
    roi: staked > 0 ? (profit / staked) * 100 : 0,
    average_ev: evCount > 0 ? evSum / evCount : null,
    total_staked: staked,
    no_bet_races: noBetRaces,
  };
}
