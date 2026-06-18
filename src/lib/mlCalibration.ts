/**
 * ML learning pipeline — pure calibration metrics (model + confidence).
 *
 * Computes whether a predicted probability matches reality, from captured
 * outcomes. Two uses:
 *   - MODEL CALIBRATION: does `model_prob` match the realised win rate?
 *   - CONFIDENCE CALIBRATION: does the `confidence_score` band match the realised
 *     win/place rate?
 *
 * STRICTLY SHADOW / DECISION-SUPPORT: it reads outcomes and reports metrics; it
 * never changes the production model, probability, EV, staking, or any
 * recommendation. PURE — no I/O, no DB, no ML library — so every metric is
 * deterministic and unit-testable. NEVER FABRICATES: with no usable samples the
 * metrics are null, never guessed.
 */

/** One settled prediction: a probability in [0,1] and a 0/1 outcome. */
export interface CalibrationSample {
  prob: number;
  outcome: 0 | 1 | boolean;
}

/** Default number of equal-width reliability-diagram bins. */
export const DEFAULT_BINS = 10;

/** Minimum samples before calibration metrics are meaningful (advisory). */
export const MIN_CALIBRATION_SAMPLES = 100;

/** A finite number in [0,1]. */
function isProb(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** Coerces an outcome to 0/1. */
function toOutcome(v: 0 | 1 | boolean): 0 | 1 {
  return v === true || v === 1 ? 1 : 0;
}

/** Keeps only samples with a usable probability. */
function usable(samples: readonly CalibrationSample[]): { p: number; y: 0 | 1 }[] {
  const out: { p: number; y: 0 | 1 }[] = [];
  for (const s of samples) {
    if (isProb(s.prob)) out.push({ p: s.prob, y: toOutcome(s.outcome) });
  }
  return out;
}

/** One reliability-diagram bin. */
export interface ReliabilityBin {
  /** Bin index (0-based). */
  bin: number;
  /** Lower/upper probability edges of the bin. */
  lo: number;
  hi: number;
  /** Mean predicted probability of samples in the bin. */
  predMean: number | null;
  /** Observed outcome rate (the realised frequency) in the bin. */
  obsRate: number | null;
  /** Number of samples in the bin. */
  n: number;
}

/** Rounds to `dp` decimals. */
function round(v: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/**
 * Partitions samples into `bins` equal-width probability bins and reports, per
 * bin, the mean predicted probability vs the observed outcome rate (the
 * reliability diagram). Empty bins report null means with n=0. Pure.
 */
export function reliabilityBins(
  samples: readonly CalibrationSample[],
  bins: number = DEFAULT_BINS,
): ReliabilityBin[] {
  const k = Math.max(1, Math.floor(bins));
  const rows = usable(samples);
  const sumP = new Array<number>(k).fill(0);
  const sumY = new Array<number>(k).fill(0);
  const n = new Array<number>(k).fill(0);

  for (const { p, y } of rows) {
    const idx = Math.min(k - 1, Math.floor(p * k));
    sumP[idx] += p;
    sumY[idx] += y;
    n[idx] += 1;
  }

  return Array.from({ length: k }, (_, i) => ({
    bin: i,
    lo: round(i / k),
    hi: round((i + 1) / k),
    predMean: n[i] > 0 ? round(sumP[i] / n[i]) : null,
    obsRate: n[i] > 0 ? round(sumY[i] / n[i]) : null,
    n: n[i],
  }));
}

/** Mean Brier score (lower is better), or null when no usable samples. */
export function brierScore(samples: readonly CalibrationSample[]): number | null {
  const rows = usable(samples);
  if (rows.length === 0) return null;
  const sum = rows.reduce((acc, { p, y }) => acc + (p - y) ** 2, 0);
  return round(sum / rows.length);
}

/** Mean log loss (lower is better), clamped to avoid ±∞, or null. */
export function logLoss(samples: readonly CalibrationSample[]): number | null {
  const rows = usable(samples);
  if (rows.length === 0) return null;
  const eps = 1e-15;
  const sum = rows.reduce((acc, { p, y }) => {
    const pc = Math.min(1 - eps, Math.max(eps, p));
    return acc - (y === 1 ? Math.log(pc) : Math.log(1 - pc));
  }, 0);
  return round(sum / rows.length);
}

/**
 * Expected Calibration Error: the sample-weighted mean gap between predicted
 * probability and observed rate across bins. Lower is better; null when empty.
 */
export function expectedCalibrationError(
  samples: readonly CalibrationSample[],
  bins: number = DEFAULT_BINS,
): number | null {
  const rows = usable(samples);
  if (rows.length === 0) return null;
  const binRows = reliabilityBins(samples, bins);
  let ece = 0;
  for (const b of binRows) {
    if (b.n === 0 || b.predMean === null || b.obsRate === null) continue;
    ece += (b.n / rows.length) * Math.abs(b.predMean - b.obsRate);
  }
  return round(ece);
}

/** Maximum Calibration Error: the worst per-bin gap. Null when empty. */
export function maxCalibrationError(
  samples: readonly CalibrationSample[],
  bins: number = DEFAULT_BINS,
): number | null {
  const rows = usable(samples);
  if (rows.length === 0) return null;
  let mce = 0;
  for (const b of reliabilityBins(samples, bins)) {
    if (b.n === 0 || b.predMean === null || b.obsRate === null) continue;
    mce = Math.max(mce, Math.abs(b.predMean - b.obsRate));
  }
  return round(mce);
}

/** The full calibration report for a set of predictions. */
export interface CalibrationReport {
  n: number;
  /** True when n >= MIN_CALIBRATION_SAMPLES (advisory reliability flag). */
  sufficientSample: boolean;
  brier: number | null;
  logLoss: number | null;
  ece: number | null;
  mce: number | null;
  /** Mean predicted probability across all usable samples. */
  meanPredicted: number | null;
  /** Mean observed outcome rate across all usable samples. */
  meanObserved: number | null;
  bins: ReliabilityBin[];
}

/**
 * Assembles the full calibration report (Brier, log loss, ECE, MCE, the
 * reliability diagram, and the headline predicted-vs-observed means) from settled
 * predictions. Use it for MODEL calibration (`{prob: model_prob, outcome: won}`)
 * or any probability→binary-outcome pair. Pure; never fabricates.
 */
export function calibrateBinary(
  samples: readonly CalibrationSample[],
  bins: number = DEFAULT_BINS,
): CalibrationReport {
  const rows = usable(samples);
  const n = rows.length;
  const meanPredicted = n > 0 ? round(rows.reduce((a, r) => a + r.p, 0) / n) : null;
  const meanObserved = n > 0 ? round(rows.reduce((a, r) => a + r.y, 0) / n) : null;
  return {
    n,
    sufficientSample: n >= MIN_CALIBRATION_SAMPLES,
    brier: brierScore(samples),
    logLoss: logLoss(samples),
    ece: expectedCalibrationError(samples, bins),
    mce: maxCalibrationError(samples, bins),
    meanPredicted,
    meanObserved,
    bins: reliabilityBins(samples, bins),
  };
}

// --- Confidence calibration (by band) --------------------------------------

/** One settled confidence observation: a score + the binary outcome. */
export interface ConfidenceSample {
  /** Confidence score in [0,1], or a label mapped to one upstream. */
  score: number;
  outcome: 0 | 1 | boolean;
}

/** A confidence band's realised outcome rate. */
export interface ConfidenceBand {
  label: string;
  lo: number;
  hi: number;
  n: number;
  /** Mean confidence score in the band. */
  meanScore: number | null;
  /** Realised outcome rate (win or place) in the band. */
  outcomeRate: number | null;
}

/** Default confidence bands (low / medium / high), matching the model labels. */
export const DEFAULT_CONFIDENCE_BANDS: readonly { label: string; lo: number; hi: number }[] = [
  { label: 'low', lo: 0, hi: 0.45 },
  { label: 'medium', lo: 0.45, hi: 0.6 },
  { label: 'high', lo: 0.6, hi: 1.0001 },
];

/**
 * Buckets settled confidence observations into bands and reports each band's
 * realised outcome rate — the confidence-calibration table (does "high
 * confidence" actually win/place more often?). Pure; empty bands report null.
 */
export function calibrateConfidence(
  samples: readonly ConfidenceSample[],
  bands: readonly { label: string; lo: number; hi: number }[] = DEFAULT_CONFIDENCE_BANDS,
): ConfidenceBand[] {
  return bands.map((band) => {
    let sumScore = 0;
    let sumOut = 0;
    let n = 0;
    for (const s of samples) {
      if (typeof s.score !== 'number' || !Number.isFinite(s.score)) continue;
      if (s.score >= band.lo && s.score < band.hi) {
        sumScore += s.score;
        sumOut += toOutcome(s.outcome);
        n += 1;
      }
    }
    return {
      label: band.label,
      lo: band.lo,
      hi: band.hi,
      n,
      meanScore: n > 0 ? round(sumScore / n) : null,
      outcomeRate: n > 0 ? round(sumOut / n) : null,
    };
  });
}
