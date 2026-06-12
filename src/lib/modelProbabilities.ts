/**
 * Model probability estimation driven by quality-weighted tipster support.
 *
 * Each runner starts from a base probability (market-implied when odds are
 * available for every runner, otherwise an equal split). Each backing tipster
 * contributes a quality weight derived from their ROI, A/E, and strike rate; a
 * runner's summed weighted support boosts its probability. An anti-crowd bias
 * then rewards "hidden value" (strong but lightly-tipped runners) and penalizes
 * over-tipped favourites, before probabilities are normalized to sum to 1.
 *
 * Conventions:
 * - `odds` are decimal odds (e.g. 4.0 => 25% market-implied probability).
 * - `model_prob` is a win probability in [0, 1]; across a race they sum to 1.
 * - tipster `weight` is in [0, 1]; missing stats fall back to a neutral weight.
 */

type RunnerId = string | number;
type TipsterId = string | number;

/** Weights for combining tipster quality metrics into a single [0, 1] weight. */
const TIPSTER_WEIGHT_FACTORS = {
  roi: 0.5,
  ae: 0.3,
  strikeRate: 0.2,
} as const;

/**
 * Weight used for a backing tipster that has no entry in `tipsterStats`. 0.5 is
 * the neutral midpoint of the [0, 1] weight scale, so unknown tipsters still
 * contribute support without dominating.
 */
const DEFAULT_TIPSTER_WEIGHT = 0.5;

/**
 * Strength of the anti-crowd adjustment. The multiplier
 * `1 + VALUE_SIGNAL_STRENGTH * value_signal` boosts runners whose
 * quality-weighted backing exceeds their raw popularity and fades those where
 * it lags. `value_signal` lies in [-1, 1], so at strength 1 the factor is in
 * [0, 2].
 */
const VALUE_SIGNAL_STRENGTH = 1;

/** Crowd share above which a runner is treated as an overhyped favourite. */
const CROWD_FAVOURITE_THRESHOLD = 0.4;

/** Multiplier applied to overhyped favourites (crowd share above threshold). */
const OVERHYPED_FAVOURITE_PENALTY = 0.5;

/**
 * Odds-band boundaries (decimal odds) used to focus the model on the realistic
 * +EV zone. Prices below `shortMax` are treated as too efficient (overbet
 * favourites); prices above `highMin` as too random (longshots).
 */
const ODDS_BANDS = {
  shortMax: 2.0,
  highMin: 12.0,
} as const;

/** Multipliers applied to model probability by odds band. */
const ODDS_BAND_MULTIPLIERS = {
  short: 0.8,
  mid: 1.0,
  high: 0.85,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Returns the odds-band multiplier for a decimal price:
 * - `< 2.0` => 0.8 (too efficient / overbet favourites)
 * - `2.0`–`12.0` => 1.0 (value zone; the 8.0–12.0 sub-band is treated as
 *   neutral since the rules only penalize prices above 12.0)
 * - `> 12.0` => 0.85 (too random / longshots)
 *
 * Runners without a usable price get the neutral multiplier (no penalty).
 */
function oddsBandMultiplier(odds: number | undefined): number {
  if (typeof odds !== 'number' || !Number.isFinite(odds) || odds <= 1) {
    return ODDS_BAND_MULTIPLIERS.mid;
  }
  if (odds < ODDS_BANDS.shortMax) {
    return ODDS_BAND_MULTIPLIERS.short;
  }
  if (odds > ODDS_BANDS.highMin) {
    return ODDS_BAND_MULTIPLIERS.high;
  }
  return ODDS_BAND_MULTIPLIERS.mid;
}

export interface ProbabilityRunner {
  runner_id: RunnerId;
  /**
   * Optional decimal odds. When present (and > 1) for every runner, they seed
   * market-implied base probabilities; otherwise probabilities start equal.
   */
  odds?: number;
}

export interface TipsterSelection {
  runner_id: RunnerId;
  tipster_id: TipsterId;
}

export interface TipsterStats {
  tipster_id: TipsterId;
  /** Return on investment (may be negative). Higher is better. */
  roi: number;
  /** Actual-vs-expected ratio. Higher is better. */
  ae: number;
  /** Strike rate (win fraction) in [0, 1]. */
  strike_rate: number;
}

export interface RunnerProbability {
  runner_id: RunnerId;
  model_prob: number;
}

/**
 * Seeds base probabilities for the field.
 *
 * Uses market-implied probabilities (`1 / odds`, normalized to strip the
 * overround) when every runner has valid odds; falls back to an equal split.
 */
function getBaseProbabilities(runners: ProbabilityRunner[]): number[] {
  const hasAllOdds = runners.every(
    (runner) => typeof runner.odds === 'number' && runner.odds > 1,
  );

  if (hasAllOdds) {
    const implied = runners.map((runner) => 1 / (runner.odds as number));
    const total = implied.reduce((sum, value) => sum + value, 0);
    if (total > 0) {
      return implied.map((value) => value / total);
    }
  }

  const equal = 1 / runners.length;
  return runners.map(() => equal);
}

/**
 * Computes a quality weight in [0, 1] for each tipster from their stats:
 *
 *   weight = 0.5 * normROI + 0.3 * normAE + 0.2 * strikeRate
 *
 * ROI and A/E are min-max normalized across the supplied tipsters (so they are
 * relative to the current set); strike rate is used directly (clamped to
 * [0, 1]). When every tipster shares the same ROI (or A/E), that term is
 * treated as neutral (0.5).
 */
function computeTipsterWeights(
  tipsterStats: TipsterStats[],
): Map<TipsterId, number> {
  const weights = new Map<TipsterId, number>();
  if (tipsterStats.length === 0) {
    return weights;
  }

  const rois = tipsterStats.map((stat) => stat.roi);
  const aes = tipsterStats.map((stat) => stat.ae);
  const roiMin = Math.min(...rois);
  const roiMax = Math.max(...rois);
  const aeMin = Math.min(...aes);
  const aeMax = Math.max(...aes);

  const normalize = (value: number, min: number, max: number): number =>
    max > min ? (value - min) / (max - min) : 0.5;

  for (const stat of tipsterStats) {
    const weight =
      TIPSTER_WEIGHT_FACTORS.roi * normalize(stat.roi, roiMin, roiMax) +
      TIPSTER_WEIGHT_FACTORS.ae * normalize(stat.ae, aeMin, aeMax) +
      TIPSTER_WEIGHT_FACTORS.strikeRate * clamp(stat.strike_rate, 0, 1);
    weights.set(stat.tipster_id, weight);
  }

  return weights;
}

/** Per-runner backing: summed tipster quality weight and distinct backer count. */
interface RunnerSupport {
  weighted: number;
  backers: number;
}

/**
 * Aggregates tipster backing per runner: the summed quality weight and the
 * number of distinct backers. A tipster picking the same runner more than once
 * is counted once; a backer without stats contributes
 * {@link DEFAULT_TIPSTER_WEIGHT}. Also returns the total distinct tipsters in
 * the race (the denominator for crowd share).
 */
function aggregateTipsterSupport(
  tipsterSelections: TipsterSelection[],
  tipsterWeights: Map<TipsterId, number>,
): { support: Map<RunnerId, RunnerSupport>; totalTipsters: number } {
  const support = new Map<RunnerId, RunnerSupport>();
  const seen = new Map<RunnerId, Set<TipsterId>>();
  const allTipsters = new Set<TipsterId>();

  if (!tipsterSelections) {
    return { support, totalTipsters: 0 };
  }

  for (const selection of tipsterSelections) {
    allTipsters.add(selection.tipster_id);

    let tipsters = seen.get(selection.runner_id);
    if (!tipsters) {
      tipsters = new Set<TipsterId>();
      seen.set(selection.runner_id, tipsters);
    }
    if (tipsters.has(selection.tipster_id)) {
      continue;
    }
    tipsters.add(selection.tipster_id);

    const weight =
      tipsterWeights.get(selection.tipster_id) ?? DEFAULT_TIPSTER_WEIGHT;
    const current = support.get(selection.runner_id) ?? {
      weighted: 0,
      backers: 0,
    };
    current.weighted += weight;
    current.backers += 1;
    support.set(selection.runner_id, current);
  }

  return { support, totalTipsters: allTipsters.size };
}

/**
 * Calculates normalized model probabilities for a race using quality-weighted
 * tipster support.
 *
 * @param runners            Runners in the race.
 * @param tipsterSelections  Tipster picks as `{ runner_id, tipster_id }`.
 * @param tipsterStats       Per-tipster `{ roi, ae, strike_rate }` used to
 *                           weight support. Tipsters absent here fall back to a
 *                           neutral weight; defaults to no stats.
 * @returns One `{ runner_id, model_prob }` per runner; `model_prob` sums to 1.
 */
export function calculateModelProbabilities(
  runners: ProbabilityRunner[],
  tipsterSelections: TipsterSelection[],
  tipsterStats: TipsterStats[] = [],
): RunnerProbability[] {
  if (!runners || runners.length === 0) {
    return [];
  }

  const baseProbs = getBaseProbabilities(runners);
  const tipsterWeights = computeTipsterWeights(tipsterStats);
  const { support, totalTipsters } = aggregateTipsterSupport(
    tipsterSelections,
    tipsterWeights,
  );

  // Total weighted support across the field, used to turn each runner's
  // weighted support into a share comparable with crowd share.
  const totalWeighted = [...support.values()].reduce(
    (sum, entry) => sum + entry.weighted,
    0,
  );

  const boosted = runners.map((runner, index) => {
    const entry = support.get(runner.runner_id) ?? { weighted: 0, backers: 0 };

    // Existing behavior: boost by quality-weighted support. `1 + weighted`
    // keeps un-backed runners at their base probability instead of collapsing
    // to 0.
    let value = baseProbs[index] * (1 + entry.weighted);

    // Anti-crowd bias.
    // - crowd_share: raw popularity = distinct backers / all tipsters.
    // - weighted_share: quality-weighted backing as a share of the field.
    // We compare *shares* so both sit on the same [0, 1] scale. Using the raw
    // weighted sum here would make any well-backed runner look "valuable" and
    // reward crowding — the opposite of the goal.
    const crowdShare = totalTipsters > 0 ? entry.backers / totalTipsters : 0;
    const weightedShare =
      totalWeighted > 0 ? entry.weighted / totalWeighted : 0;
    const valueSignal = weightedShare - crowdShare;

    // Reward hidden value (positive signal), fade over-tipped runners
    // (negative). Clamped so the multiplier never goes negative.
    value *= Math.max(0, 1 + VALUE_SIGNAL_STRENGTH * valueSignal);

    // Strong penalty for an overhyped favourite backed by most of the crowd.
    if (crowdShare > CROWD_FAVOURITE_THRESHOLD) {
      value *= OVERHYPED_FAVOURITE_PENALTY;
    }

    // Odds-band weighting: focus the model on the realistic +EV zone by
    // penalizing over-efficient short prices and random longshots.
    value *= oddsBandMultiplier(runner.odds);

    return value;
  });

  const total = boosted.reduce((sum, value) => sum + value, 0);

  // Defensive fallback: if every weight collapsed to 0, split equally.
  if (total <= 0) {
    const equal = 1 / runners.length;
    return runners.map((runner) => ({
      runner_id: runner.runner_id,
      model_prob: equal,
    }));
  }

  return runners.map((runner, index) => ({
    runner_id: runner.runner_id,
    model_prob: boosted[index] / total,
  }));
}
