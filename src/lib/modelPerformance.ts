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

/* -------------------------------------------------------------------------- */
/* Pre-off ("as-of off time") evaluation                                      */
/* -------------------------------------------------------------------------- */

/**
 * A model run candidate for pre-off selection (minimal shape).
 *
 * `run_time` is the ISO 8601 timestamp the run was produced.
 */
export interface PreOffRunCandidate {
  /** Model run id. */
  run_id: string;
  /** When the run was produced (ISO 8601). */
  run_time: string;
}

/**
 * Selects the latest model run produced at or before the scheduled off time
 * ("as-of off time"). This is the read-only evaluation rule that ignores
 * post-off reruns — which can run on stale odds and supersede the valid pre-off
 * run in `is_current`, erasing a recommendation that was live at the off.
 *
 * Rules:
 *   - Only runs with `run_time <= offTime` are eligible.
 *   - Among eligible runs, the one with the greatest `run_time` wins.
 *   - Returns null when `offTime` is missing/unparseable, no run qualifies, or
 *     the list is empty.
 *
 * Pure; never throws. Input order does not matter (the max is scanned for).
 */
export function selectPreOffRun<T extends PreOffRunCandidate>(
  runs: readonly T[],
  offTime: string | null | undefined,
): T | null {
  if (!offTime) return null;
  const offMs = new Date(offTime).getTime();
  if (!Number.isFinite(offMs)) return null;

  let best: T | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    const ms = new Date(run.run_time).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms <= offMs && ms > bestMs) {
      best = run;
      bestMs = ms;
    }
  }
  return best;
}

/** A race with its result signal, for outcome building. */
export interface EvaluatedRaceResult {
  /** Race id. */
  race_id: string;
  /** Winner runner id, or null when the race has no recorded result yet. */
  winner_runner_id: string | null;
}

/** The rank-1 recommendation backing a selected run (odds/stake/ev resolved). */
export interface SelectedRunRecommendation {
  /** The recommended runner id (compared against the winner to decide `won`). */
  runner_id: string;
  /** Stored decimal odds, or null when not recorded. */
  odds: number | null;
  /** Stored stake (already resolved from stake/stake_amount), or null. */
  stake: number | null;
  /** Stored EV per 1 unit, or null when not recorded. */
  ev: number | null;
}

/**
 * Builds evaluated recommendation outcomes from an already-selected run per race
 * (e.g. the pre-off run from {@link selectPreOffRun}) plus the rank-1
 * recommendation for each selected run.
 *
 *   - A race whose selected run HAS a recommendation yields one
 *     {@link RecommendationOutcome} (settled iff the race has a recorded
 *     winner; `won` iff the recommended runner is that winner).
 *   - A race whose selected run has NO recommendation is counted as a no-bet
 *     race.
 *   - A race with no selected run at all is out of scope (neither an outcome nor
 *     a no-bet) — mirroring the prior "no current run" behaviour.
 *
 * The key property: a later post-off run cannot erase a valid pre-off
 * recommendation, because selection already excluded the post-off run, so the
 * pre-off run's recommendation is the one evaluated here.
 *
 * Pure; never throws.
 */
export function buildPreOffOutcomes(params: {
  races: readonly EvaluatedRaceResult[];
  selectedRunIdByRace: ReadonlyMap<string, string>;
  recsByRunId: ReadonlyMap<string, SelectedRunRecommendation>;
}): { outcomes: RecommendationOutcome[]; noBetRaces: number } {
  const { races, selectedRunIdByRace, recsByRunId } = params;
  const outcomes: RecommendationOutcome[] = [];
  let noBetRaces = 0;

  for (const race of races) {
    const runId = selectedRunIdByRace.get(race.race_id);
    if (runId === undefined) continue; // no run at/before off time → out of scope

    const rec = recsByRunId.get(runId);
    if (!rec) {
      noBetRaces += 1; // selected run made no rank-1 recommendation → no-bet
      continue;
    }

    const settled = race.winner_runner_id !== null;
    outcomes.push({
      settled,
      won: settled && rec.runner_id === race.winner_runner_id,
      odds: rec.odds,
      stake: rec.stake,
      ev: rec.ev,
    });
  }

  return { outcomes, noBetRaces };
}
