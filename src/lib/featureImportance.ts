/**
 * ML learning pipeline — pure, explainable feature-importance analysis.
 *
 * Ranks how strongly each captured FEATURE relates to a binary outcome (e.g.
 * `won`) using two transparent, model-free signals computed from the captured
 * training examples:
 *   - LIFT: the spread in outcome rate across the feature's quantile bins
 *     (how much the win rate moves from the lowest to the highest feature band).
 *   - point-biserial CORRELATION with the outcome (direction + strength).
 *
 * STRICTLY SHADOW / DECISION-SUPPORT: it explains historical associations to
 * guide future experimentation; it TRAINS NOTHING, makes no ML model active, and
 * never changes probability, EV, staking, or any recommendation. PURE — no I/O,
 * no DB, no ML library — fully unit-testable. NEVER FABRICATES: a feature with
 * too few usable values is reported as `insufficient`, never given a score.
 * Association is NOT causation — this is a research aid, not a promotion gate.
 */

/** Minimum usable rows before a feature's importance is scored. */
export const MIN_FEATURE_SAMPLES = 50;
/** Default quantile bins for the lift computation. */
export const DEFAULT_QUANTILE_BINS = 5;

/** One observation: a numeric feature value and the 0/1 outcome. */
export interface FeatureObservation {
  value: number | null;
  outcome: 0 | 1 | boolean;
}

/** The importance verdict for one feature. */
export interface FeatureImportance {
  feature: string;
  /** Usable (non-null, finite) observations. */
  n: number;
  /** True when n >= MIN_FEATURE_SAMPLES. */
  scored: boolean;
  /** Outcome-rate spread across quantile bins (0..1), or null when unscored. */
  lift: number | null;
  /** Point-biserial correlation with the outcome (−1..1), or null. */
  correlation: number | null;
  /** Per-bin outcome rate (low→high feature value), for the dashboard. */
  binRates: (number | null)[];
  /** Short, honest explanation. */
  note: string;
}

function isNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function toOutcome(v: 0 | 1 | boolean): 0 | 1 {
  return v === true || v === 1 ? 1 : 0;
}

function round(v: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Population Pearson correlation (point-biserial when y is 0/1). 0 when flat. */
function correlation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return 0; // a constant feature/outcome has no correlation
  return cov / Math.sqrt(vx * vy);
}

/**
 * Quantile-bins the sorted values into `bins` groups of (near) equal size and
 * returns each group's outcome rate, low→high. Equal-value boundaries are kept
 * stable by binning on sorted index, so ties never crash a bin. Pure.
 */
function quantileBinRates(
  pairs: { x: number; y: 0 | 1 }[],
  bins: number,
): { rates: (number | null)[]; lift: number | null } {
  const k = Math.max(2, Math.floor(bins));
  const sorted = [...pairs].sort((a, b) => a.x - b.x);
  const n = sorted.length;
  const rates: (number | null)[] = [];
  for (let b = 0; b < k; b++) {
    const start = Math.floor((b * n) / k);
    const end = Math.floor(((b + 1) * n) / k);
    if (end <= start) {
      rates.push(null);
      continue;
    }
    let sum = 0;
    for (let i = start; i < end; i++) sum += sorted[i].y;
    rates.push(round(sum / (end - start)));
  }
  const present = rates.filter((r): r is number => r !== null);
  const lift = present.length >= 2 ? round(Math.max(...present) - Math.min(...present)) : null;
  return { rates, lift };
}

/**
 * Scores one feature's importance from its observations: the outcome-rate lift
 * across quantile bins and the point-biserial correlation with the outcome.
 * A feature with fewer than {@link MIN_FEATURE_SAMPLES} usable rows is returned
 * `scored: false` (no score invented). Pure.
 */
export function scoreFeatureImportance(
  feature: string,
  observations: readonly FeatureObservation[],
  bins: number = DEFAULT_QUANTILE_BINS,
): FeatureImportance {
  const pairs: { x: number; y: 0 | 1 }[] = [];
  for (const o of observations) {
    if (isNum(o.value)) pairs.push({ x: o.value, y: toOutcome(o.outcome) });
  }
  const n = pairs.length;
  if (n < MIN_FEATURE_SAMPLES) {
    return {
      feature,
      n,
      scored: false,
      lift: null,
      correlation: null,
      binRates: [],
      note: `insufficient sample (${n} < ${MIN_FEATURE_SAMPLES}) — not scored`,
    };
  }
  const { rates, lift } = quantileBinRates(pairs, bins);
  const corr = round(correlation(pairs.map((p) => p.x), pairs.map((p) => p.y)));
  const dir = corr > 0 ? 'higher' : corr < 0 ? 'lower' : 'flat';
  return {
    feature,
    n,
    scored: true,
    lift,
    correlation: corr,
    binRates: rates,
    note:
      lift === null
        ? `correlation ${corr} (${dir})`
        : `win-rate lift ${lift} across bins; correlation ${corr} (${dir} feature → more wins)`,
  };
}

/** An extractor pulling a numeric feature value out of an example row `T`. */
export interface FeatureExtractor<T> {
  feature: string;
  extract: (row: T) => number | null;
}

/**
 * Scores a set of features over captured examples and returns them RANKED by
 * absolute correlation (strongest association first); unscored features
 * (insufficient sample) sort last. `outcomeOf` selects the binary label (e.g.
 * `won`). Pure; never fabricates.
 */
export function rankFeatureImportance<T>(
  rows: readonly T[],
  features: readonly FeatureExtractor<T>[],
  outcomeOf: (row: T) => 0 | 1 | boolean,
  bins: number = DEFAULT_QUANTILE_BINS,
): FeatureImportance[] {
  const scored = features.map((f) =>
    scoreFeatureImportance(
      f.feature,
      rows.map((r) => ({ value: f.extract(r), outcome: outcomeOf(r) })),
      bins,
    ),
  );
  return scored.sort((a, b) => {
    if (a.scored !== b.scored) return a.scored ? -1 : 1;
    return Math.abs(b.correlation ?? 0) - Math.abs(a.correlation ?? 0);
  });
}
