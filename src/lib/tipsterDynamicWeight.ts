/**
 * Dynamic tipster weighting — pure scoring, shrinkage, calibration & explanation.
 *
 * Turns a tipster's proofed record into a single, explainable DECISION-SUPPORT
 * weight in [0, 1] (0.5 = neutral) from seven factors: ROI, strike rate, Ascot
 * performance, festival performance, recent form, confidence calibration, and
 * sample size. It is deliberately and strictly NON-BETTING:
 *
 *   - It NEVER changes model probability, EV, staking, ranking, or any
 *     recommendation. The live betting path (modelProbabilities.ts /
 *     bettingEngine.ts / recommendBet.ts) is untouched. This module only
 *     produces an advisory weight + an explanation for display and audit.
 *   - The `effective_weight` it reports is gated by a GRADUAL RAMP `alpha` that
 *     DEFAULTS TO 0 — i.e. by default every tipster is reported as neutral (0.5),
 *     so wiring this in (later, behind a validated flag) would be a no-op until
 *     `alpha` is deliberately raised. Influence can only grow gradually.
 *   - It is PURE — no I/O, no DB, no network — so every rule is unit-testable.
 *     It NEVER fabricates: a factor scores only when its metric is present;
 *     missing factors are omitted (and reduce coverage), never guessed.
 *
 * Design (see docs/TIPSTER_DYNAMIC_WEIGHTING.md):
 *   skillᵢ        = bounded map of factor i to [0,1] (0.5 neutral)
 *   skillᵢ        = shrinkToNeutral(skillᵢ, reliability(nᵢ))   // per-factor sample
 *   raw_skill     = Σ wᵢ·skillᵢ / Σ wᵢ        over PRESENT factors (coverage-aware)
 *   reliability   = N / (N + K)               // global sample size
 *   dynamic_weight= shrinkToNeutral(raw_skill, reliability · coverage)
 *   effective     = 0.5 + alpha · (dynamic_weight − 0.5)        // gradual ramp
 * Absolute anchors (not cohort min-max) keep scores comparable across runs and
 * explainable on their own.
 */

import { isFiniteNumber } from './dataQualityUtils';

// --- Tunable anchors (exported so tests + docs stay in sync) ---------------

/** Blend weights over the six PERFORMANCE factors (sum to 1). Sample size is
 * the shrinkage driver, not a blended factor. */
export const FACTOR_WEIGHTS = {
  roi: 0.3,
  recent_form: 0.22,
  calibration: 0.18,
  strike_rate: 0.12,
  ascot: 0.1,
  festival: 0.08,
} as const;

export type FactorName = keyof typeof FACTOR_WEIGHTS;

/** ROI fraction that maps to a strong (~0.73) skill via the logistic. */
export const ROI_SCALE = 0.1;
/** Strike-rate baseline (neutral) and scale for the logistic. */
export const STRIKE_BASELINE = 0.15;
export const STRIKE_SCALE = 0.12;

/** Global reliability shrinkage constant: `reliability = N / (N + K)`. */
export const RELIABILITY_K = 200;
/** Segment (Ascot / festival / calibration) shrinkage constant — smaller N. */
export const SEGMENT_K = 50;

/** Calibration: bins for the reliability diagram + the ECE→score scale. */
export const CALIBRATION_BINS = 5;
export const ECE_SCALE = 0.2;

/** Recency: full credit at/under this; fully neutralised at/over the horizon. */
export const FRESH_RECENCY_DAYS = 7;
export const STALE_RECENCY_DAYS = 90;

/** Neutral weight: the midpoint everything shrinks toward. */
export const NEUTRAL_WEIGHT = 0.5;

/**
 * Default ramp `alpha`. 0 = NO influence (everyone neutral) — the safe default
 * so this can never alter betting until an operator deliberately raises it after
 * out-of-sample validation.
 */
export const DEFAULT_RAMP_ALPHA = 0;

// --- Small pure helpers -----------------------------------------------------

/** Standard logistic squashing to (0, 1). */
export function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Clamps a number into [lo, hi]. */
function clampRange(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/** A finite number, else null. */
function numOrNull(value: number | null | undefined): number | null {
  return isFiniteNumber(value) ? value : null;
}

/** A usable sample size: finite and > 0, else null. */
function usableSample(value: number | null | undefined): number | null {
  return isFiniteNumber(value) && value > 0 ? value : null;
}

/** Reliability shrinkage `N / (N + K)`; 0 for an absent/non-positive sample. */
export function reliabilityOf(sampleSize: number | null | undefined, k: number = RELIABILITY_K): number {
  const n = usableSample(sampleSize);
  return n === null ? 0 : n / (n + k);
}

/** Pulls a [0,1] skill toward neutral by `(1 - factor)`. factor∈[0,1]. */
export function shrinkToNeutral(skill: number, factor: number): number {
  const f = clampRange(factor, 0, 1);
  return NEUTRAL_WEIGHT + f * (skill - NEUTRAL_WEIGHT);
}

/** Maps an ROI fraction to a [0,1] skill (0.5 at break-even). */
export function skillFromRoi(roi: number, scale: number = ROI_SCALE): number {
  return logistic(roi / scale);
}

/** Maps a strike rate to a [0,1] skill around a baseline expectation. */
export function skillFromStrike(strikeRate: number): number {
  return logistic((clampRange(strikeRate, 0, 1) - STRIKE_BASELINE) / STRIKE_SCALE);
}

/** Whole days between `lastSeenDate` and `now` (>=0), or null when unknown. */
export function recencyDaysOf(lastSeenDate: string | null | undefined, now: Date): number | null {
  if (!lastSeenDate || lastSeenDate.trim() === '') return null;
  const iso = lastSeenDate.length <= 10 ? `${lastSeenDate}T00:00:00Z` : lastSeenDate;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const days = Math.floor((now.getTime() - ms) / 86_400_000);
  return days < 0 ? 0 : days;
}

/** Recency reliability: 1 when fresh, decaying linearly to 0 at the horizon. */
export function recencyReliability(recencyDays: number | null): number {
  if (recencyDays === null) return 1; // unknown recency does not penalise (no data)
  if (recencyDays <= FRESH_RECENCY_DAYS) return 1;
  if (recencyDays >= STALE_RECENCY_DAYS) return 0;
  return 1 - (recencyDays - FRESH_RECENCY_DAYS) / (STALE_RECENCY_DAYS - FRESH_RECENCY_DAYS);
}

// --- Confidence calibration (ECE) ------------------------------------------

/** One settled pick: the tipster's implied win prob and whether it won. */
export interface CalibrationSample {
  /** Implied win probability of the pick in [0, 1] (e.g. 1/decimal_odds). */
  impliedProb: number;
  /** 1 when the pick won, 0 otherwise. */
  won: 0 | 1 | boolean;
}

/** The calibration assessment over a set of settled picks. */
export interface CalibrationResult {
  /** Expected Calibration Error (lower is better), or null when no usable picks. */
  ece: number | null;
  /** Calibration skill in [0,1] (1 = perfectly calibrated), or null. */
  score: number | null;
  /** Number of usable picks. */
  sampleSize: number;
}

/**
 * Computes the Expected Calibration Error and a [0,1] calibration score from
 * settled picks, by binning on implied probability and comparing each bin's mean
 * implied prob to its realised hit-rate. `score = clamp(1 - ECE/ECE_SCALE)`.
 * Pure; never fabricates (no usable picks → null score). NOT a betting input.
 */
export function computeCalibrationScore(
  samples: readonly CalibrationSample[],
  options: { bins?: number } = {},
): CalibrationResult {
  const bins = Math.max(1, options.bins ?? CALIBRATION_BINS);
  const usable = samples.filter((s) => isFiniteNumber(s.impliedProb) && s.impliedProb >= 0 && s.impliedProb <= 1);
  if (usable.length === 0) {
    return { ece: null, score: null, sampleSize: 0 };
  }

  const binSum = new Array<number>(bins).fill(0); // Σ implied
  const binHit = new Array<number>(bins).fill(0); // Σ outcome
  const binN = new Array<number>(bins).fill(0);

  for (const s of usable) {
    const won = s.won === true || s.won === 1 ? 1 : 0;
    const idx = Math.min(bins - 1, Math.floor(s.impliedProb * bins));
    binSum[idx] += s.impliedProb;
    binHit[idx] += won;
    binN[idx] += 1;
  }

  let ece = 0;
  for (let b = 0; b < bins; b++) {
    if (binN[b] === 0) continue;
    const meanImplied = binSum[b] / binN[b];
    const hitRate = binHit[b] / binN[b];
    ece += (binN[b] / usable.length) * Math.abs(meanImplied - hitRate);
  }

  const score = clampRange(1 - ece / ECE_SCALE, 0, 1);
  return { ece, score, sampleSize: usable.length };
}

// --- Factor inputs + result -------------------------------------------------

/**
 * The proofed inputs for one tipster. Every field is optional/nullable: a factor
 * scores only when its metric is present. Segment ROIs (Ascot/festival) carry
 * their OWN sample size so a thin segment is shrunk hard toward neutral.
 */
export interface TipsterFactorInputs {
  /** Global settled-bet count N (drives the global shrinkage). */
  betsCount?: number | null;
  /** Long-run ROI fraction. */
  roi?: number | null;
  /** Strike rate (win fraction) in [0, 1]. */
  strikeRate?: number | null;
  /** Recent-window (e.g. 30d) ROI fraction. */
  recentRoi?: number | null;
  /** Date of the most recent recorded selection (for recency decay). */
  lastSeenDate?: string | null;
  /** ROI on Ascot races + the number of Ascot bets behind it. */
  ascotRoi?: number | null;
  ascotSampleSize?: number | null;
  /** ROI across festival meetings + the number of festival bets behind it. */
  festivalRoi?: number | null;
  festivalSampleSize?: number | null;
  /** Pre-computed calibration score in [0,1] + the picks behind it. */
  calibrationScore?: number | null;
  calibrationSampleSize?: number | null;
}

/** One factor's signed contribution to the composite, fully explained. */
export interface FactorContribution {
  factor: FactorName;
  present: boolean;
  /** The source metric (ROI fraction, strike rate, calibration score, …) or null. */
  rawValue: number | null;
  /** [0,1] skill after any per-segment shrinkage (0.5 neutral). */
  skill: number;
  /** Blend weight from {@link FACTOR_WEIGHTS}. */
  weight: number;
  /** Segment sample size (null for whole-record factors). */
  sampleSize: number | null;
  /** Per-factor reliability applied (1 for whole-record factors). */
  reliability: number;
  /** Signed contribution `weight·(skill − 0.5)`. */
  contribution: number;
}

/** The full, explainable dynamic-weight assessment. NOT a betting input. */
export interface DynamicWeightResult {
  /** [0,1] decision-support weight after global shrinkage (0.5 neutral). */
  dynamic_weight: number;
  /** [0,1] composite before global shrinkage. */
  raw_skill: number;
  /** Global sample reliability `N/(N+K)`. */
  reliability: number;
  /** Share of factor weight that was present (0..1). */
  coverage: number;
  /** Ramp factor used (0 = neutral/off). */
  ramp_alpha: number;
  /** `0.5 + alpha·(dynamic_weight − 0.5)` — what an integration WOULD apply. */
  effective_weight: number;
  /** Global settled-bet count, echoed for display. */
  bets_count: number | null;
  /** Per-factor breakdown (only present factors carry a contribution). */
  factors: FactorContribution[];
  /** Human-readable credits/debits explaining the weight. */
  reasons: string[];
}

/** Options for {@link scoreDynamicTipsterWeight}. */
export interface ScoreOptions {
  /** Gradual-ramp factor in [0,1]; default 0 (no influence). */
  rampAlpha?: number;
  /** "Now" for recency math (injectable for tests). */
  now?: Date;
  /** Global shrinkage K (default {@link RELIABILITY_K}). */
  reliabilityK?: number;
}

/** Formats a fraction as a signed percent for reasons. */
function pct(value: number): string {
  const p = value * 100;
  const sign = p > 0 ? '+' : p < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(p).toFixed(1)}%`;
}

/** Rounds to 3 dp (stable display + comparison). */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Scores a tipster's dynamic decision-support weight from the seven factors,
 * with per-segment and global sample-size shrinkage toward neutral, plus a
 * gradual ramp. Pure; never mutates input, never throws, never fabricates a
 * missing factor. The result is advisory only — it does not touch betting.
 */
export function scoreDynamicTipsterWeight(
  inputs: TipsterFactorInputs,
  options: ScoreOptions = {},
): DynamicWeightResult {
  const now = options.now ?? new Date();
  const rampAlpha = clampRange(options.rampAlpha ?? DEFAULT_RAMP_ALPHA, 0, 1);
  const k = options.reliabilityK ?? RELIABILITY_K;

  const betsCount = usableSample(inputs.betsCount);
  const reasons: string[] = [];
  const factors: FactorContribution[] = [];

  /** Records one factor (present or absent) and accrues its contribution. */
  function addFactor(
    name: FactorName,
    rawValue: number | null,
    skillRaw: number | null,
    sampleSize: number | null,
    factorReliability: number,
  ): void {
    const weight = FACTOR_WEIGHTS[name];
    if (skillRaw === null) {
      factors.push({
        factor: name,
        present: false,
        rawValue: null,
        skill: NEUTRAL_WEIGHT,
        weight,
        sampleSize,
        reliability: 0,
        contribution: 0,
      });
      return;
    }
    const skill = shrinkToNeutral(skillRaw, factorReliability);
    factors.push({
      factor: name,
      present: true,
      rawValue,
      skill: round3(skill),
      weight,
      sampleSize,
      reliability: round3(factorReliability),
      contribution: round3(weight * (skill - NEUTRAL_WEIGHT)),
    });
  }

  // ROI (whole record).
  const roi = numOrNull(inputs.roi);
  addFactor('roi', roi, roi === null ? null : skillFromRoi(roi), betsCount, 1);
  if (roi !== null) reasons.push(`ROI ${pct(roi)}`);

  // Recent form (whole record, decayed by recency).
  const recentRoi = numOrNull(inputs.recentRoi);
  const recencyDays = recencyDaysOf(inputs.lastSeenDate, now);
  const recencyRel = recencyReliability(recencyDays);
  addFactor(
    'recent_form',
    recentRoi,
    recentRoi === null ? null : skillFromRoi(recentRoi),
    null,
    recencyRel,
  );
  if (recentRoi !== null) {
    reasons.push(
      `recent ROI ${pct(recentRoi)}` +
        (recencyDays !== null ? ` (${recencyDays}d old, recency×${round3(recencyRel)})` : ''),
    );
  }

  // Confidence calibration (segment-shrunk).
  const calib = numOrNull(inputs.calibrationScore);
  const calibN = usableSample(inputs.calibrationSampleSize);
  addFactor('calibration', calib, calib, calibN, reliabilityOf(calibN, SEGMENT_K));
  if (calib !== null) reasons.push(`calibration ${round3(calib)} (n=${calibN ?? 0})`);

  // Strike rate (whole record).
  const strike = numOrNull(inputs.strikeRate);
  addFactor('strike_rate', strike, strike === null ? null : skillFromStrike(strike), betsCount, 1);
  if (strike !== null) reasons.push(`strike ${(strike * 100).toFixed(1)}%`);

  // Ascot performance (segment-shrunk).
  const ascotRoi = numOrNull(inputs.ascotRoi);
  const ascotN = usableSample(inputs.ascotSampleSize);
  addFactor(
    'ascot',
    ascotRoi,
    ascotRoi === null ? null : skillFromRoi(ascotRoi),
    ascotN,
    reliabilityOf(ascotN, SEGMENT_K),
  );
  if (ascotRoi !== null) reasons.push(`Ascot ROI ${pct(ascotRoi)} (n=${ascotN ?? 0})`);

  // Festival performance (segment-shrunk).
  const festRoi = numOrNull(inputs.festivalRoi);
  const festN = usableSample(inputs.festivalSampleSize);
  addFactor(
    'festival',
    festRoi,
    festRoi === null ? null : skillFromRoi(festRoi),
    festN,
    reliabilityOf(festN, SEGMENT_K),
  );
  if (festRoi !== null) reasons.push(`festival ROI ${pct(festRoi)} (n=${festN ?? 0})`);

  // Composite over PRESENT factors (coverage-aware).
  const present = factors.filter((f) => f.present);
  const presentWeight = present.reduce((s, f) => s + f.weight, 0);
  const totalWeight = Object.values(FACTOR_WEIGHTS).reduce((s, w) => s + w, 0);
  const coverage = totalWeight > 0 ? presentWeight / totalWeight : 0;

  const rawSkill =
    presentWeight > 0
      ? NEUTRAL_WEIGHT + present.reduce((s, f) => s + f.contribution, 0) / presentWeight
      : NEUTRAL_WEIGHT;

  // Global shrinkage: pull toward neutral by reliability AND coverage.
  const reliability = reliabilityOf(betsCount, k);
  const dynamicWeight = shrinkToNeutral(rawSkill, reliability * coverage);
  const effectiveWeight = NEUTRAL_WEIGHT + rampAlpha * (dynamicWeight - NEUTRAL_WEIGHT);

  // Lead the reasons with the headline shrinkage story.
  reasons.unshift(
    `N=${betsCount ?? 0} → reliability ${round3(reliability)}, coverage ${round3(coverage)} ` +
      `→ weight ${round3(dynamicWeight)} (raw ${round3(rawSkill)})`,
  );
  if (betsCount === null) {
    reasons.push('no sample → shrunk fully to neutral (0.5)');
  } else if (reliability < 0.25) {
    reasons.push(`small sample (N=${betsCount}) → heavily shrunk toward neutral`);
  }
  if (rampAlpha === 0) {
    reasons.push('ramp α=0 → effective weight neutral (no betting influence)');
  }

  return {
    dynamic_weight: round3(dynamicWeight),
    raw_skill: round3(rawSkill),
    reliability: round3(reliability),
    coverage: round3(coverage),
    ramp_alpha: rampAlpha,
    effective_weight: round3(effectiveWeight),
    bets_count: betsCount,
    factors,
    reasons,
  };
}

/**
 * Applies the gradual ramp to a dynamic weight: `0.5 + alpha·(w − 0.5)`. Exposed
 * so an integration layer (later, behind a validated flag) can ramp influence in
 * ONE place. `alpha = 0` returns neutral (0.5); `alpha = 1` returns `w`.
 */
export function applyRamp(dynamicWeight: number, alpha: number): number {
  const a = clampRange(alpha, 0, 1);
  return NEUTRAL_WEIGHT + a * (dynamicWeight - NEUTRAL_WEIGHT);
}
