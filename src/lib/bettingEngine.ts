/**
 * Betting engine: expected value, fractional Kelly staking, horse selection,
 * and a blended confidence score.
 *
 * Conventions used throughout this module:
 * - `odds` are decimal odds (e.g. 3.5 returns 3.5x the stake on a win).
 * - `prob` / `model_prob` are win probabilities in the range [0, 1].
 * - Monetary values (`bankroll`, returned stake) share the same currency unit.
 */

/** Fraction of full Kelly to bet (fractional Kelly reduces variance/risk). */
const FRACTIONAL_KELLY = 0.2;

/** Minimum stake once a bet is taken: 0.1% of bankroll. */
const MIN_STAKE_FRACTION = 0.001;

/** Maximum stake on any single bet: 2% of bankroll. */
const MAX_STAKE_FRACTION = 0.02;

/** Tuning for {@link confidenceScore}. */
const CONFIDENCE_TUNING = {
  /** EV (per unit staked) at which the EV signal saturates to 1. */
  evTarget: 0.2,
  /** Model-vs-market edge (probability points) at which edge saturates to 1. */
  edgeTarget: 0.1,
  /** Number of backing tipsters at which agreement saturates to 1. */
  tipsterTarget: 3,
  /** Weight of EV vs. edge within the value gate (edge gets the remainder). */
  evWeight: 0.7,
  /**
   * Confidence for a strong-value bet with zero agreement. 0.6 sits in the
   * "medium" band (see {@link labelConfidence}), so high EV + low agreement
   * surfaces as medium "hidden value" rather than high.
   */
  hiddenValueFloor: 0.6,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface Runner {
  name: string;
  /** Decimal odds. */
  odds: number;
  /** Model-estimated win probability in [0, 1]. */
  model_prob: number;
}

export interface RankedRunner extends Runner {
  /** Expected value per unit staked. */
  ev: number;
}

export interface ConfidenceInputs {
  /** Expected value per unit staked (e.g. 0.15 => +15%). */
  ev: number;
  /** Model win probability in [0, 1]. */
  modelProb: number;
  /** Market-implied win probability in [0, 1] (e.g. de-overrounded 1 / odds). */
  marketProb: number;
  /** Number of tipsters backing the runner. */
  tipsterCount: number;
}

/**
 * Expected value per unit staked for a single decimal-odds bet.
 *
 * Derivation: on a win you net `odds - 1`; on a loss you forfeit `1`, so
 * `EV = prob * (odds - 1) - (1 - prob) = prob * odds - 1`.
 *
 * A positive result means the bet is +EV; zero is break-even.
 */
export function calculateEV(prob: number, odds: number): number {
  return prob * odds - 1;
}

/**
 * Recommended stake using fractional Kelly, scaled by confidence and clamped
 * to the bankroll guardrails.
 *
 * Returns `0` when there is no edge (EV <= 0), no confidence, or the inputs
 * are unusable. When a bet is taken, the stake is bounded between 0.1% and 2%
 * of the bankroll.
 */
export function kellyStake(
  prob: number,
  odds: number,
  bankroll: number,
  confidence: number,
): number {
  if (bankroll <= 0 || odds <= 1) {
    return 0;
  }

  const netOdds = odds - 1;
  // Full Kelly fraction f* = EV / b, where b = odds - 1.
  const fullKelly = calculateEV(prob, odds) / netOdds;
  if (fullKelly <= 0) {
    return 0;
  }

  const scaledConfidence = clamp(confidence, 0, 1);
  const fraction = fullKelly * FRACTIONAL_KELLY * scaledConfidence;
  if (fraction <= 0) {
    return 0;
  }

  const stakeFraction = clamp(fraction, MIN_STAKE_FRACTION, MAX_STAKE_FRACTION);
  return stakeFraction * bankroll;
}

/**
 * Ranks runners by expected value and returns the strongest pick.
 *
 * Returns `null` for an empty list. The returned runner is augmented with its
 * computed `ev`.
 */
export function pickBestHorse(runners: Runner[]): RankedRunner | null {
  if (!runners || runners.length === 0) {
    return null;
  }

  const ranked = runners
    .map((runner) => ({
      ...runner,
      ev: calculateEV(runner.model_prob, runner.odds),
    }))
    .sort((a, b) => b.ev - a.ev);

  return ranked[0];
}

/**
 * Blends a bet's value and corroboration into a single confidence value in
 * [0, 1], combining three signals:
 *
 *   1. EV size — the headline edge (saturates at {@link CONFIDENCE_TUNING.evTarget}).
 *   2. Model-vs-market edge — `modelProb - marketProb`, how far the model has
 *      moved the price.
 *   3. Tipster agreement — how many tipsters back the runner.
 *
 * EV (reinforced by edge) forms a "value gate" that scales the whole score, so
 * a weak-EV bet can never score high. Tipster agreement then lifts a strong bet
 * from the hidden-value floor toward the top of the range. The net effect:
 *
 *   - Low EV               -> low confidence
 *   - High EV, low agreement  -> medium (hidden value)
 *   - High EV, high agreement -> high confidence
 */
export function confidenceScore({
  ev,
  modelProb,
  marketProb,
  tipsterCount,
}: ConfidenceInputs): number {
  // Value gate: how strong is the bet? EV-dominant, reinforced by the model's
  // edge over the market. EV strength is 0 when EV is non-positive (and edge is
  // then non-positive too), so low-value bets always score low.
  const evStrength = clamp(ev / CONFIDENCE_TUNING.evTarget, 0, 1);
  const edgeStrength = clamp(
    (modelProb - marketProb) / CONFIDENCE_TUNING.edgeTarget,
    0,
    1,
  );
  const valueGate =
    CONFIDENCE_TUNING.evWeight * evStrength +
    (1 - CONFIDENCE_TUNING.evWeight) * edgeStrength;

  // Agreement: independent corroboration from the number of backing tipsters.
  const agreement = clamp(tipsterCount / CONFIDENCE_TUNING.tipsterTarget, 0, 1);

  // Agreement lifts a strong bet from the hidden-value floor up to the full
  // value gate; the gate caps everything so weak EV stays low.
  const floor = CONFIDENCE_TUNING.hiddenValueFloor;
  const score = valueGate * (floor + (1 - floor) * agreement);

  return clamp(score, 0, 1);
}

export type ConfidenceLabel = 'high' | 'medium' | 'low';

/**
 * Maps a confidence score to a simple label for display:
 * `>= 0.7` high, `>= 0.55` medium, otherwise low.
 */
export function labelConfidence(score: number): ConfidenceLabel {
  if (score >= 0.7) {
    return 'high';
  }
  if (score >= 0.55) {
    return 'medium';
  }
  return 'low';
}
