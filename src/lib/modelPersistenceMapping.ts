/**
 * Pure mappers that turn scored runners into the insert payloads for
 * `model_runner_scores` and `recommendations` (Phase 2E).
 *
 * The live schema carries BOTH a set of canonical/display columns (odds,
 * model_probability, market_probability, fair_odds, ev, confidence,
 * confidence_label, stake, market_rank/model_rank, rank) AND the older
 * compatibility columns the writer has always populated (market_prob, model_prob,
 * edge, ev_per_1, confidence_score, rank_in_race / stake_pct, stake_amount,
 * kelly_fraction_used, rationale_json). Previously only the compatibility columns
 * were written, leaving the display columns null. These mappers populate BOTH
 * from the SAME already-computed values, so SQL / dashboards see complete rows.
 *
 * INTEGRITY: nothing here changes the model maths, staking, ranking, or
 * selection — it only re-projects values the scorer already produced.
 *   - `odds` is the runner's REAL priced decimal odds (carried from the quote on
 *     the scored runner), never derived from probability.
 *   - `fair_odds` is the model's own fair price = 1 / model_probability (a
 *     standard, documented transform), or null when model_probability <= 0.
 *   - `market_rank` / `model_rank` are descriptive ranks by market / model
 *     probability (favourite = 1); they do NOT affect EV-based selection, which
 *     keeps using `rank` / `rank_in_race`.
 * Pure: no I/O, no mutation of inputs.
 */

import { labelConfidence } from './bettingEngine';

/** The scored-runner shape these mappers read (structural; matches ScoredRunner). */
export interface ScoredRunnerLike {
  runner_id: string;
  odds: number;
  market_prob: number;
  model_prob: number;
  edge: number;
  ev: number;
  confidence: number;
  stake: number;
  rank: number;
}

/** Canonical + compatibility fields for one `model_runner_scores` row. */
export interface ModelRunnerScoreFields {
  runner_id: string;
  // Canonical / display columns.
  odds: number;
  market_probability: number;
  model_probability: number;
  fair_odds: number | null;
  ev: number;
  confidence: number;
  confidence_label: string;
  stake: number;
  market_rank: number;
  model_rank: number;
  // Compatibility columns (unchanged from the original writer).
  market_prob: number;
  model_prob: number;
  edge: number;
  ev_per_1: number;
  confidence_score: number;
  rank_in_race: number;
}

/** Canonical + compatibility fields for the single `recommendations` row. */
export interface RecommendationFields {
  // Canonical / display columns.
  rank: number;
  odds: number;
  market_probability: number;
  model_probability: number;
  fair_odds: number | null;
  ev: number;
  confidence: number;
  confidence_label: string;
  stake: number;
  // Compatibility columns (unchanged from the original writer).
  recommendation_rank: number;
  stake_pct: number;
  stake_amount: number;
  kelly_fraction_used: number;
  mandatory_floor_applied: boolean;
  daily_cap_restricted: boolean;
  rationale_json: {
    ev: number;
    model_prob: number;
    market_prob: number;
    edge: number;
    confidence: number;
  };
}

/** The model's fair price (1 / model_prob), or null when not a usable prob. */
export function fairOddsFromProb(modelProb: number): number | null {
  return Number.isFinite(modelProb) && modelProb > 0 ? 1 / modelProb : null;
}

/**
 * Builds a runner_id -> 1-based rank map by a probability key, descending
 * (highest probability = rank 1). Ties resolve by the input order (stable).
 * Pure; does not mutate `scored`.
 */
function rankByProbDesc(
  scored: readonly ScoredRunnerLike[],
  key: 'market_prob' | 'model_prob',
): Map<string, number> {
  const order = scored
    .map((s, index) => ({ id: s.runner_id, prob: s[key], index }))
    .sort((a, b) => b.prob - a.prob || a.index - b.index);
  const ranks = new Map<string, number>();
  order.forEach((entry, i) => ranks.set(entry.id, i + 1));
  return ranks;
}

/**
 * Maps every scored runner to its `model_runner_scores` field object, populating
 * both the canonical/display and compatibility columns. The caller adds the
 * persistence linkage (`model_run_id`, current marker). Pure.
 */
export function buildModelRunnerScoreFields(
  scored: readonly ScoredRunnerLike[],
): ModelRunnerScoreFields[] {
  const marketRanks = rankByProbDesc(scored, 'market_prob');
  const modelRanks = rankByProbDesc(scored, 'model_prob');

  return scored.map((s) => ({
    runner_id: s.runner_id,
    // Canonical / display.
    odds: s.odds,
    market_probability: s.market_prob,
    model_probability: s.model_prob,
    fair_odds: fairOddsFromProb(s.model_prob),
    ev: s.ev,
    confidence: s.confidence,
    confidence_label: labelConfidence(s.confidence),
    stake: s.stake,
    market_rank: marketRanks.get(s.runner_id) ?? s.rank,
    model_rank: modelRanks.get(s.runner_id) ?? s.rank,
    // Compatibility.
    market_prob: s.market_prob,
    model_prob: s.model_prob,
    edge: s.edge,
    ev_per_1: s.ev,
    confidence_score: s.confidence,
    rank_in_race: s.rank,
  }));
}

/**
 * Maps the selected top bet to the `recommendations` field object, populating
 * both the canonical/display and compatibility columns. The caller adds the
 * persistence linkage (`model_run_id`, `race_id`, `runner_id`, current marker).
 * `stake_pct` is the bankroll percentage (stake / bankroll * 100), matching the
 * original writer. Pure.
 */
export function buildRecommendationFields(params: {
  topBet: ScoredRunnerLike;
  bankroll: number;
  baseKellyFraction: number;
}): RecommendationFields {
  const { topBet, bankroll, baseKellyFraction } = params;
  return {
    // Canonical / display.
    rank: 1,
    odds: topBet.odds,
    market_probability: topBet.market_prob,
    model_probability: topBet.model_prob,
    fair_odds: fairOddsFromProb(topBet.model_prob),
    ev: topBet.ev,
    confidence: topBet.confidence,
    confidence_label: labelConfidence(topBet.confidence),
    stake: topBet.stake,
    // Compatibility.
    recommendation_rank: 1,
    stake_pct: bankroll > 0 ? (topBet.stake / bankroll) * 100 : 0,
    stake_amount: topBet.stake,
    kelly_fraction_used: baseKellyFraction,
    mandatory_floor_applied: false,
    daily_cap_restricted: false,
    rationale_json: {
      ev: topBet.ev,
      model_prob: topBet.model_prob,
      market_prob: topBet.market_prob,
      edge: topBet.edge,
      confidence: topBet.confidence,
    },
  };
}
