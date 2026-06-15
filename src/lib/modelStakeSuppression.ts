/**
 * Stake suppression (Batch F2) — the first behavioural safeguard.
 *
 * When data quality is insufficient, the selected bet's STAKE is zeroed while
 * the selection itself is preserved (for explainability). This module contains
 * the pure, side-effect-contained mutation; the decision of WHETHER to suppress
 * comes from `determineModelAdjustments` (the single source of that rule) and is
 * passed in as a boolean.
 *
 * STRICT SCOPE: it only ever writes `topBet.stake`. It does NOT touch
 * probabilities, EV, confidence, rank, runner order, or the selection identity,
 * and it does nothing when there is no selected bet.
 */

/** Minimal shape of the selected bet this layer can suppress (stake only). */
export interface SuppressibleBet {
  stake: number;
}

/**
 * Applies stake suppression to the selected bet IN PLACE: when `suppressStaking`
 * is true and a `topBet` exists, sets `topBet.stake = 0`. Otherwise leaves it
 * untouched. Returns the same `topBet` reference (or `undefined`) so the
 * selection identity is provably preserved.
 *
 * Only the `stake` field is ever mutated; every other field (confidence, ev,
 * rank, ids) is left exactly as-is. No-op when `topBet` is `undefined`.
 */
export function applyStakeSuppression<T extends SuppressibleBet>(
  topBet: T | undefined,
  suppressStaking: boolean,
): T | undefined {
  if (topBet && suppressStaking) {
    topBet.stake = 0;
  }
  return topBet;
}
