/**
 * Pure locked-first performance evaluation — Newmarket rebuild Phase 5B.
 *
 * The shared lower-level evaluator behind the locked-first
 * `computeModelPerformance` mode (src/lib/raceData.ts -> /api/accuracy ->
 * dashboard performance panel). Given each race's official locked decision
 * (`locked_race_decisions` at minutes_before = 5, projected via
 * `toLockedDecision`) and its recorded winner, it builds the OFFICIAL
 * recommendation outcomes and the coverage counts.
 *
 * HONESTY RULES (each enforced by lockedEvaluation.test.ts):
 *   - Official P/L uses ONLY the stored locked pick odds/stake/EV; win/loss
 *     comes ONLY from the stored winner (`runners.finish_pos = 1`).
 *   - PENDING races are never losses (no winner yet -> settled: false; the
 *     shared `summarizeModelPerformance` never counts them).
 *   - `locked_no_bet` is a VALID official decision — a no-bet count, never a
 *     loss.
 *   - `no_run_available` is its own counter — never a loss, never a no-bet.
 *   - `lock_missing` (no lock row) is its own counter — NEVER backfilled and
 *     contributes NOTHING to the official figures; the caller may evaluate
 *     those races separately under the labelled pre-off fallback.
 *   - A `locked_pick` without a pick runner id (impossible per the schema
 *     CHECK) is `unevaluable`: excluded from winners AND losers, never guessed.
 *
 * Pure and deterministic: no I/O, no DB, no clock, no mutation. Display /
 * evaluation only — never a betting instruction.
 */

import type { RecommendationOutcome } from './modelPerformance';
import type { LockedDecision } from './lockedDecisionRead';

/** One race's evaluation input: its official lock (or null) + stored winner. */
export interface LockedEvaluationRace {
  race_id: string;
  /** Winner runner id (`finish_pos = 1`), or null while the race is pending. */
  winner_runner_id: string | null;
  /** The official locked decision, or null when no lock row exists. */
  locked: LockedDecision | null;
}

/** Day-level lock coverage for the accuracy response. */
export interface PerformanceLockCoverage {
  races: number;
  /** Races with ANY official lock row. */
  locked: number;
  locked_pick: number;
  locked_no_bet: number;
  no_run_available: number;
  lock_missing: number;
  /** locked / races * 100, one decimal; 0 when no races. */
  coverage_pct: number;
}

/** Which rule produced the top-level figures (the three display states). */
export type OfficialPerformanceMode =
  | 'official_locked'
  | 'fallback_pre_off'
  | 'mixed';

/** The full pure evaluation result consumed by computeModelPerformance. */
export interface LockedOutcomesResult {
  /** OFFICIAL outcomes: locked_pick races only, at stored locked odds/stake. */
  outcomes: RecommendationOutcome[];
  /** Official no-bet decisions (locked_no_bet) — valid, never losses. */
  lockedNoBet: number;
  /** Races locked with no run available — separate, never losses/no-bets. */
  noRunAvailable: number;
  /** locked_pick rows without a pick runner id — excluded from W/L. */
  unevaluable: number;
  /** Races with NO lock row — fallback-eligible; excluded from official. */
  lockMissingRaceIds: string[];
  coverage: PerformanceLockCoverage;
}

/**
 * Builds the OFFICIAL outcomes + coverage from each race's locked decision and
 * stored winner. Pure; never throws; input order preserved for outcomes.
 */
export function buildLockedOutcomes(
  races: readonly LockedEvaluationRace[],
): LockedOutcomesResult {
  const outcomes: RecommendationOutcome[] = [];
  const lockMissingRaceIds: string[] = [];
  let lockedNoBet = 0;
  let noRunAvailable = 0;
  let unevaluable = 0;
  let lockedPick = 0;

  for (const race of races) {
    const locked = race.locked;
    if (!locked) {
      lockMissingRaceIds.push(race.race_id);
      continue;
    }
    if (locked.decision_status === 'locked_no_bet') {
      lockedNoBet += 1;
      continue;
    }
    if (locked.decision_status === 'no_run_available') {
      noRunAvailable += 1;
      continue;
    }
    // locked_pick
    lockedPick += 1;
    if (!locked.pick_runner_id) {
      unevaluable += 1; // schema-impossible; excluded, never guessed
      continue;
    }
    const settled = race.winner_runner_id !== null;
    outcomes.push({
      settled,
      won: settled && locked.pick_runner_id === race.winner_runner_id,
      odds: locked.pick_odds,
      stake: locked.pick_stake,
      ev: locked.pick_ev,
    });
  }

  const lockedCount = lockedPick + lockedNoBet + noRunAvailable;
  const coverage: PerformanceLockCoverage = {
    races: races.length,
    locked: lockedCount,
    locked_pick: lockedPick,
    locked_no_bet: lockedNoBet,
    no_run_available: noRunAvailable,
    lock_missing: lockMissingRaceIds.length,
    coverage_pct:
      races.length === 0 ? 0 : Math.round((lockedCount / races.length) * 1000) / 10,
  };

  return {
    outcomes,
    lockedNoBet,
    noRunAvailable,
    unevaluable,
    lockMissingRaceIds,
    coverage,
  };
}

/**
 * Resolves which rule labels the top-level figures:
 *   - no locks at all (incl. an unreadable table) -> `fallback_pre_off` — the
 *     caller computes exactly the legacy pre-off result (no regression for
 *     pre-lock dates);
 *   - every race locked -> `official_locked`;
 *   - some locked, some missing -> `mixed` (official figures + a separate
 *     labelled pre-off fallback for the missing races).
 * Pure.
 */
export function resolveOfficialMode(
  coverage: PerformanceLockCoverage,
): OfficialPerformanceMode {
  if (coverage.locked === 0) return 'fallback_pre_off';
  return coverage.lock_missing === 0 ? 'official_locked' : 'mixed';
}
