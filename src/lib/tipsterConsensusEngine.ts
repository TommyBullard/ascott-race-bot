/**
 * Tipster Consensus Engine — quality-weighted agreement scoring (Phase 4E).
 *
 * Turns a race's approved tipster selections into a single, EXPLAINABLE consensus
 * verdict: how strongly the (quality-weighted) tipsters agree on one runner, and
 * what KIND of runner it is (favourite / value / outsider). It supersedes the
 * unweighted observational consensus (modelTipsterConsensus.ts) for display +
 * feature purposes, while keeping the same integrity contract:
 *
 *   - STRICTLY OBSERVATIONAL. It does NOT change model probability, EV, staking,
 *     selection, ranking, or any recommendation. It is decision-support only.
 *   - PURE — no I/O, no DB, no network — so every rule is unit-testable.
 *   - NEVER FABRICATES. A runner contributes only when a real selection matches a
 *     known runner; unknown tipsters get a neutral weight; missing odds/edge just
 *     make a classification dimension unavailable (never invented).
 *
 * Strength bands (see docs/TIPSTER_CONSENSUS_ENGINE.md):
 *   NONE     — no matched selections.
 *   WEAK     — at least one backer, below MODERATE.
 *   MODERATE — weighted share >= 0.45 and >= 2 backers.
 *   STRONG   — weighted share >= 0.60, >= 3 backers, and margin >= 0.25.
 * Conflicting selections (several runners backed with a small margin) cap the
 * verdict at MODERATE and set `conflict`.
 */

// --- Tunable thresholds (exported so tests + docs stay in sync) ------------

/** Neutral weight for a backer with no quality weight supplied. */
export const DEFAULT_TIPSTER_WEIGHT = 0.5;

/** Weighted-share gates for the strength bands. */
export const STRONG_SHARE = 0.6;
export const MODERATE_SHARE = 0.45;

/** Minimum distinct backers for each band (stops "1 of 1 = 100%" being strong). */
export const STRONG_MIN_BACKERS = 3;
export const MODERATE_MIN_BACKERS = 2;

/** Minimum lead over the runner-up (share points) for STRONG. */
export const STRONG_MARGIN = 0.25;

/** Below this lead with >1 runner backed, the field is "conflicted". */
export const CONFLICT_MARGIN = 0.15;

/** Model edge (model_prob − market_prob) at/above which a pick reads as "value". */
export const VALUE_EDGE = 0.03;

/** Decimal odds at/above which the consensus runner reads as an "outsider". */
export const OUTSIDER_ODDS = 8;

/** ROI scale for the default quality-weight helper. */
export const QUALITY_ROI_SCALE = 0.1;

// --- Inputs -----------------------------------------------------------------

/** A priced runner with the optional context used to classify consensus type. */
export interface ConsensusRunnerInput {
  runner_id: string | number;
  /** Decimal odds (favourite / outsider classification). */
  odds?: number | null;
  /** Model probability (value classification, with market_prob/edge). */
  model_prob?: number | null;
  /** De-overrounded market probability. */
  market_prob?: number | null;
  /** Model edge = model_prob − market_prob; derived if omitted. */
  edge?: number | null;
}

/** One tipster pick: which runner a tipster selected. */
export interface ConsensusSelectionInput {
  runner_id: string | number;
  tipster_id: string | number;
}

/** Strength bands, weakest-first. */
export type ConsensusStrength = 'NONE' | 'WEAK' | 'MODERATE' | 'STRONG';

/** The kind of runner the consensus landed on. */
export type ConsensusType = 'NONE' | 'FAVOURITE' | 'VALUE' | 'OUTSIDER' | 'MID';

/** Per-runner weighted support (every known runner, canonical order). */
export interface ConsensusRunnerSupport {
  runner_id: string;
  backers: number;
  weighted_support: number;
  weighted_share: number;
  raw_share: number;
}

/** The full, explainable consensus verdict. NOT a betting input. */
export interface ConsensusEngineResult {
  strength: ConsensusStrength;
  /** Continuous 0..1 strength (for the ML feature); 0 when NONE. */
  strength_score: number;
  type: ConsensusType;
  consensus_runner_id: string | null;
  /** Distinct backers of the consensus runner. */
  supporters: number;
  /** Distinct tipsters with a matched selection in the race. */
  total_tipsters: number;
  /** Σ quality weight backing the consensus runner. */
  weighted_supporters: number;
  /** Σ quality weight across all matched selections. */
  total_weighted: number;
  /** weighted_supporters / total_weighted, or null when none. */
  weighted_share: number | null;
  /** Lead over the runner-up in weighted share (0 when single/none). */
  margin: number;
  /** True when several runners are backed with a small margin. */
  conflict: boolean;
  /** Is the consensus runner the market favourite? (null when no odds.) */
  is_market_favourite: boolean | null;
  /** Is it an outsider (odds >= OUTSIDER_ODDS)? (null when no odds.) */
  is_outsider: boolean | null;
  /** Model edge on the consensus runner, or null when unknown. */
  consensus_edge: number | null;
  runner_support: ConsensusRunnerSupport[];
  /** "Strong" / "Moderate" / "Weak" / "No consensus". */
  headline: string;
  /** "7 of 9 weighted tipsters support <runner>". */
  detail: string;
  reasons: string[];
}

/** Options for {@link buildConsensusEngineResult}. */
export interface ConsensusEngineOptions {
  /** tipster_id → quality weight (>0). Missing → DEFAULT_TIPSTER_WEIGHT. */
  weights?: Map<string, number> | Record<string, number>;
  /** runner_id → display name, for the `detail` line. */
  runnerNames?: Map<string, string> | Record<string, string>;
}

// --- Small pure helpers -----------------------------------------------------

/** Clamps to [0, 1]. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Reads a weight for a tipster from a Map or record; neutral when absent/invalid. */
function weightFor(
  tipsterId: string,
  weights: ConsensusEngineOptions['weights'],
): number {
  if (!weights) return DEFAULT_TIPSTER_WEIGHT;
  const raw = weights instanceof Map ? weights.get(tipsterId) : weights[tipsterId];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_TIPSTER_WEIGHT;
}

/** Reads a runner name from a Map or record, or null. */
function nameFor(
  runnerId: string,
  names: ConsensusEngineOptions['runnerNames'],
): string | null {
  if (!names) return null;
  const raw = names instanceof Map ? names.get(runnerId) : names[runnerId];
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/** A finite number, else null. */
function numOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Rounds to `dp` decimals. */
function round(v: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/**
 * Derives a bounded quality weight in (0, 1] from a tipster's headline stats,
 * for use as the consensus weighting. Absolute (not cohort-relative), so it is
 * stable across races: `0.5 + 0.5·tanh(roi/scale)` nudged by strike rate.
 * Unknown inputs fall back toward the neutral 0.5. Pure; never fabricates.
 */
export function tipsterQualityWeight(stats: {
  roi?: number | null;
  strike_rate?: number | null;
}): number {
  const roi = numOrNull(stats.roi);
  const strike = numOrNull(stats.strike_rate);
  if (roi === null && strike === null) return DEFAULT_TIPSTER_WEIGHT;
  const roiPart = roi === null ? 0 : Math.tanh(roi / QUALITY_ROI_SCALE); // [-1,1]
  const strikePart = strike === null ? 0 : clamp01(strike) - 0.2; // mild nudge
  const w = 0.5 + 0.45 * roiPart + 0.1 * strikePart;
  return Math.min(1, Math.max(0.1, w));
}

// --- Engine -----------------------------------------------------------------

/** Classifies the strength band from the weighted share, backers, margin, conflict. */
export function classifyStrength(
  weightedShare: number,
  backers: number,
  margin: number,
  conflict: boolean,
): ConsensusStrength {
  if (backers <= 0) return 'NONE';
  if (
    !conflict &&
    weightedShare >= STRONG_SHARE &&
    backers >= STRONG_MIN_BACKERS &&
    margin >= STRONG_MARGIN
  ) {
    return 'STRONG';
  }
  if (weightedShare >= MODERATE_SHARE && backers >= MODERATE_MIN_BACKERS) {
    return 'MODERATE';
  }
  return 'WEAK';
}

/** Human label for a strength band. */
function strengthHeadline(strength: ConsensusStrength): string {
  switch (strength) {
    case 'STRONG':
      return 'Strong';
    case 'MODERATE':
      return 'Moderate';
    case 'WEAK':
      return 'Weak';
    default:
      return 'No consensus';
  }
}

/**
 * Builds the quality-weighted consensus verdict for a race. Pure & deterministic.
 *
 * - Aggregates each runner's distinct backers + summed quality weight; the
 *   consensus runner is the highest weighted support (ties broken by more
 *   backers, then shorter odds, then field order).
 * - `margin` is the leader's weighted-share lead over the runner-up; a small
 *   margin with >1 runner backed flags `conflict` and caps strength at MODERATE.
 * - Type: VALUE when the consensus runner's model edge ≥ VALUE_EDGE, else
 *   FAVOURITE when it is the market favourite, else OUTSIDER when it is a
 *   longshot (odds ≥ OUTSIDER_ODDS), else MID. Classification dimensions that
 *   lack data (no odds / no edge) are reported as null, never guessed.
 */
export function buildConsensusEngineResult(
  runners: readonly ConsensusRunnerInput[],
  selections: readonly ConsensusSelectionInput[],
  options: ConsensusEngineOptions = {},
): ConsensusEngineResult {
  // Canonical runner order + membership.
  const order: string[] = [];
  const known = new Set<string>();
  const runnerById = new Map<string, ConsensusRunnerInput>();
  for (const r of runners) {
    const id = String(r.runner_id);
    if (!known.has(id)) {
      known.add(id);
      order.push(id);
      runnerById.set(id, r);
    }
  }

  // Aggregate weighted support per runner over DISTINCT (tipster, runner) pairs.
  const backersByRunner = new Map<string, Set<string>>();
  const weightByRunner = new Map<string, number>();
  const allTipsters = new Set<string>();
  for (const sel of selections) {
    const runnerId = String(sel.runner_id);
    const tipsterId = String(sel.tipster_id);
    if (!known.has(runnerId)) continue; // unmatched: never attributed
    allTipsters.add(tipsterId);
    let set = backersByRunner.get(runnerId);
    if (!set) {
      set = new Set<string>();
      backersByRunner.set(runnerId, set);
    }
    if (set.has(tipsterId)) continue; // a tipster counts once per runner
    set.add(tipsterId);
    weightByRunner.set(runnerId, (weightByRunner.get(runnerId) ?? 0) + weightFor(tipsterId, options.weights));
  }

  const totalWeighted = [...weightByRunner.values()].reduce((s, w) => s + w, 0);
  const totalTipsters = allTipsters.size;

  const runner_support: ConsensusRunnerSupport[] = order.map((id) => {
    const backers = backersByRunner.get(id)?.size ?? 0;
    const weighted = weightByRunner.get(id) ?? 0;
    return {
      runner_id: id,
      backers,
      weighted_support: round(weighted),
      weighted_share: totalWeighted > 0 ? round(weighted / totalWeighted) : 0,
      raw_share: totalTipsters > 0 ? round(backers / totalTipsters) : 0,
    };
  });

  // No matched selections → NONE.
  if (totalWeighted <= 0 || totalTipsters === 0) {
    return {
      strength: 'NONE',
      strength_score: 0,
      type: 'NONE',
      consensus_runner_id: null,
      supporters: 0,
      total_tipsters: 0,
      weighted_supporters: 0,
      total_weighted: 0,
      weighted_share: null,
      margin: 0,
      conflict: false,
      is_market_favourite: null,
      is_outsider: null,
      consensus_edge: null,
      runner_support,
      headline: 'No consensus',
      detail: 'No tipster selections for this race',
      reasons: ['No matched tipster selections — NO_TIPSTER_CONSENSUS'],
    };
  }

  // Rank by weighted support; tie-break: more backers, shorter odds, field order.
  const ranked = [...runner_support].sort((a, b) => {
    if (b.weighted_support !== a.weighted_support) return b.weighted_support - a.weighted_support;
    if (b.backers !== a.backers) return b.backers - a.backers;
    const oddsA = numOrNull(runnerById.get(a.runner_id)?.odds) ?? Infinity;
    const oddsB = numOrNull(runnerById.get(b.runner_id)?.odds) ?? Infinity;
    if (oddsA !== oddsB) return oddsA - oddsB;
    return order.indexOf(a.runner_id) - order.indexOf(b.runner_id);
  });

  const leader = ranked[0];
  const runnerUp = ranked[1];
  const weightedShare = leader.weighted_share;
  const margin = round(weightedShare - (runnerUp?.weighted_share ?? 0));
  const backedRunners = runner_support.filter((r) => r.backers > 0).length;
  const conflict = backedRunners > 1 && margin < CONFLICT_MARGIN;

  let strength = classifyStrength(weightedShare, leader.backers, margin, conflict);
  // Conflict caps the verdict at MODERATE.
  if (conflict && strength === 'STRONG') strength = 'MODERATE';

  const strength_score = round(
    clamp01(
      0.6 * weightedShare +
        0.25 * clamp01(margin / STRONG_MARGIN) +
        0.15 * clamp01(leader.backers / STRONG_MIN_BACKERS),
    ) * (conflict ? 0.85 : 1),
  );

  // --- Type classification (favourite / value / outsider) -------------------
  const leaderRunner = runnerById.get(leader.runner_id);
  const odds = numOrNull(leaderRunner?.odds);
  const edge =
    numOrNull(leaderRunner?.edge) ??
    (numOrNull(leaderRunner?.model_prob) !== null && numOrNull(leaderRunner?.market_prob) !== null
      ? (leaderRunner!.model_prob as number) - (leaderRunner!.market_prob as number)
      : null);

  // Market favourite = the runner with the shortest odds (when any odds exist).
  let favouriteId: string | null = null;
  let bestOdds = Infinity;
  for (const id of order) {
    const o = numOrNull(runnerById.get(id)?.odds);
    if (o !== null && o < bestOdds) {
      bestOdds = o;
      favouriteId = id;
    }
  }
  const isFavourite = favouriteId === null ? null : leader.runner_id === favouriteId;
  const isOutsider = odds === null ? null : odds >= OUTSIDER_ODDS;

  let type: ConsensusType;
  if (edge !== null && edge >= VALUE_EDGE) {
    type = 'VALUE'; // model + tipsters agree the runner is underpriced
  } else if (isFavourite === true) {
    type = 'FAVOURITE';
  } else if (isOutsider === true) {
    type = 'OUTSIDER';
  } else {
    type = 'MID';
  }

  // --- Display + reasons ----------------------------------------------------
  const name = nameFor(leader.runner_id, options.runnerNames) ?? `runner ${leader.runner_id}`;
  const headline = strengthHeadline(strength);
  const detail = `${leader.backers} of ${totalTipsters} weighted tipsters support ${name}`;

  const reasons: string[] = [
    `${headline} consensus: ${detail}`,
    `weighted share ${(weightedShare * 100).toFixed(1)}% (margin ${(margin * 100).toFixed(1)}pp over runner-up)`,
  ];
  if (conflict) reasons.push(`conflicting selections across ${backedRunners} runners → capped at ${strength}`);
  switch (type) {
    case 'VALUE':
      reasons.push(`value consensus: model edge ${((edge ?? 0) * 100).toFixed(1)}pp on the supported runner`);
      break;
    case 'FAVOURITE':
      reasons.push('favourite consensus: tipsters back the market favourite');
      break;
    case 'OUTSIDER':
      reasons.push(`outsider consensus: supported runner is a longshot (odds ${odds?.toFixed(1) ?? '?'})`);
      break;
    default:
      break;
  }

  return {
    strength,
    strength_score,
    type,
    consensus_runner_id: leader.runner_id,
    supporters: leader.backers,
    total_tipsters: totalTipsters,
    weighted_supporters: round(leader.weighted_support),
    total_weighted: round(totalWeighted),
    weighted_share: round(weightedShare),
    margin,
    conflict,
    is_market_favourite: isFavourite,
    is_outsider: isOutsider,
    consensus_edge: edge === null ? null : round(edge),
    runner_support,
    headline,
    detail,
    reasons,
  };
}
