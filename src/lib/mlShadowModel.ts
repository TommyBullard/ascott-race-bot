/**
 * OFFLINE, SHADOW-ONLY candidate ML model (logistic regression).
 *
 * Trains a small, explainable, fully-deterministic logistic-regression model
 * from the leakage-safe `export:training-data` CSV and scores a race's runners
 * with a shadow win-probability. This is RESEARCH / DECISION-SUPPORT ONLY:
 *
 *   - `model_active` is ALWAYS false. Nothing here changes the production model
 *     probability, EV, ranking, staking, confidence, the no-bet gate, or any
 *     recommendation. It places/suggests no bet.
 *   - PURE: no I/O, no network, no database, no external ML library. The CLIs do
 *     the file reads/writes; this module only computes.
 *   - LEAKAGE-SEGREGATED: every post-race / outcome column is forbidden from the
 *     feature set ({@link checkFeatureLeakage}); if the check fails, the caller
 *     must NOT train.
 *   - NEVER FABRICATES: a missing feature is mean-imputed (standardised 0), a
 *     blank label drops the row from training. Metrics are honest in-sample fit
 *     with a small-sample warning surfaced separately.
 */

import { LABEL_COLUMNS } from './trainingExport';
import { LEAKAGE_COLUMNS, type ParsedCsv } from './mlShadowEvaluation';

/** The label this shadow model predicts (post-race win flag — a LABEL only). */
export const SHADOW_LABEL_COLUMN = 'won';

/**
 * Candidate PRE-OFF feature columns (all known before the off). The trainer
 * keeps only those actually populated in the training CSV; the chosen set is
 * recorded in the model metadata. Contains NO post-race/outcome column.
 */
export const SHADOW_FEATURE_COLUMNS: readonly string[] = [
  'model_prob_pre_off',
  'market_rank_pre_off',
  'model_rank_pre_off',
  'ev_pre_off',
  'confidence',
  'pre_off_odds',
  'field_size',
  'is_handicap',
];

/** Below this many SETTLED races the shadow model is not trustworthy. */
export const MIN_SHADOW_TRAINING_RACES = 100;

/** The union of every column forbidden as a feature (labels + leakage). */
export function forbiddenFeatureColumns(): string[] {
  return Array.from(new Set<string>([...LABEL_COLUMNS, ...LEAKAGE_COLUMNS]));
}

/** The result of the mandatory pre-training leakage check. */
export interface LeakageCheck {
  passed: boolean;
  /** Any requested feature columns that are forbidden (post-race/outcome). */
  forbidden: string[];
  checkedFeatures: string[];
}

/**
 * Verifies no requested feature column is a post-race/outcome (label/leakage)
 * column. If `forbidden` is non-empty the caller MUST refuse to train. Pure.
 */
export function checkFeatureLeakage(featureColumns: readonly string[]): LeakageCheck {
  const forbiddenSet = new Set(forbiddenFeatureColumns());
  const forbidden = featureColumns.filter((c) => forbiddenSet.has(c));
  return { passed: forbidden.length === 0, forbidden, checkedFeatures: [...featureColumns] };
}

/* -------------------------------------------------------------------------- */
/* Parsing CSV cells                                                          */
/* -------------------------------------------------------------------------- */

/** A finite number from a CSV cell, else null (never fabricated). */
function cellNumber(v: string | undefined): number | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A boolean CSV cell as 1/0, else null. Accepts 1/0, true/false, yes/no. */
function cellBool(v: string | undefined): number | null {
  if (v == null) return null;
  const t = v.trim().toLowerCase();
  if (t === 'true' || t === '1' || t === 'yes') return 1;
  if (t === 'false' || t === '0' || t === 'no') return 0;
  return null;
}

/** Reads one feature value (booleans encoded 1/0), else null. */
function featureValue(record: Record<string, string>, column: string): number | null {
  if (column === 'is_handicap') return cellBool(record[column]);
  return cellNumber(record[column]);
}

/** Reads the binary label (won) as 1/0, else null (row not settled). */
export function labelValue(record: Record<string, string>): number | null {
  return cellBool(record[SHADOW_LABEL_COLUMN]);
}

/* -------------------------------------------------------------------------- */
/* Model shape                                                                */
/* -------------------------------------------------------------------------- */

/** The trained, serialisable shadow model + its full provenance metadata. */
export interface ShadowModel {
  kind: 'logistic_regression';
  /** ALWAYS false — this model is never production-active. */
  model_active: false;
  /** Recorded for reproducibility; training is deterministic regardless. */
  seed: number;
  trained_at: string;
  training_date_range: { from: string | null; to: string | null };
  course: string | null;
  row_count: number;
  race_count: number;
  /** Settled runner-rows used as training examples (rows with a known label). */
  settled_count: number;
  /** Distinct settled races — the basis for the small-sample warning. */
  settled_race_count: number;
  feature_columns: string[];
  label: string;
  leakage_check: LeakageCheck;
  /** Per-feature training mean/std used for standardisation + imputation. */
  standardization: { mean: number[]; std: number[] };
  weights: number[];
  bias: number;
  /** Honest IN-SAMPLE fit metrics (not out-of-sample skill). */
  evaluation: {
    in_sample_brier: number | null;
    in_sample_log_loss: number | null;
    in_sample_top1_race_hit_rate: number | null;
    positives: number;
    negatives: number;
    iterations: number;
    learning_rate: number;
  };
  notes: string;
}

/** Options for {@link trainShadowModel}. */
export interface TrainShadowOptions {
  from?: string | null;
  to?: string | null;
  course?: string | null;
  seed?: number;
  iterations?: number;
  learningRate?: number;
  featureColumns?: readonly string[];
  trainedAt?: string;
}

/** The outcome of a training attempt (a model, or a leakage refusal). */
export interface TrainShadowResult {
  model: ShadowModel | null;
  leakage: LeakageCheck;
  error: string | null;
}

/* -------------------------------------------------------------------------- */
/* Math (pure, deterministic)                                                 */
/* -------------------------------------------------------------------------- */

/** Numerically-stable logistic sigmoid. */
export function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

interface Matrix {
  X: number[][]; // raw feature rows (settled only)
  y: number[]; // 0/1 labels
  raceIds: string[];
  winnerByRace: Map<string, boolean>;
}

/** Builds the settled training matrix (rows with a known label only). Pure. */
function buildMatrix(
  parsed: ParsedCsv,
  featureColumns: readonly string[],
): Matrix {
  const X: number[][] = [];
  const y: number[] = [];
  const raceIds: string[] = [];
  for (const record of parsed.rows) {
    const label = labelValue(record);
    if (label === null) continue; // not settled -> never a training row
    const row = featureColumns.map((c) => {
      const v = featureValue(record, c);
      return v === null ? Number.NaN : v;
    });
    X.push(row);
    y.push(label);
    raceIds.push(String(record.race_id ?? ''));
  }
  return { X, y, raceIds, winnerByRace: new Map() };
}

/** Column means over finite values (ignoring NaN). */
function columnMeans(X: number[][], cols: number): number[] {
  const means = new Array<number>(cols).fill(0);
  for (let j = 0; j < cols; j++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < X.length; i++) {
      const v = X[i][j];
      if (Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
    means[j] = n > 0 ? sum / n : 0;
  }
  return means;
}

/** Column population std over finite values (0 -> 1 to avoid divide-by-zero). */
function columnStds(X: number[][], means: number[], cols: number): number[] {
  const stds = new Array<number>(cols).fill(1);
  for (let j = 0; j < cols; j++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < X.length; i++) {
      const v = X[i][j];
      if (Number.isFinite(v)) {
        sum += (v - means[j]) ** 2;
        n++;
      }
    }
    const variance = n > 0 ? sum / n : 0;
    const sd = Math.sqrt(variance);
    stds[j] = sd > 1e-9 ? sd : 1;
  }
  return stds;
}

/** Standardises one raw row, mean-imputing missing (NaN) values to 0. Pure. */
function standardizeRow(raw: number[], mean: number[], std: number[]): number[] {
  return raw.map((v, j) => (Number.isFinite(v) ? (v - mean[j]) / std[j] : 0));
}

/* -------------------------------------------------------------------------- */
/* Training                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Trains the shadow logistic-regression model deterministically (zero-init
 * batch gradient descent on standardised, mean-imputed features). Runs the
 * mandatory leakage check FIRST — if any feature is a post-race/outcome column,
 * it returns `model: null` with the leakage detail and does NOT train. Pure;
 * never throws on empty/degenerate input (returns an explanatory error).
 */
export function trainShadowModel(
  parsed: ParsedCsv,
  options: TrainShadowOptions = {},
): TrainShadowResult {
  const requested = options.featureColumns ?? SHADOW_FEATURE_COLUMNS;

  // 1. MANDATORY leakage check — never train on an outcome column.
  const leakage = checkFeatureLeakage(requested);
  if (!leakage.passed) {
    return {
      model: null,
      leakage,
      error: `Leakage check failed: forbidden feature column(s) ${leakage.forbidden.join(', ')}. Refusing to train.`,
    };
  }

  // 2. Keep only feature columns actually present + populated in the CSV.
  const headerSet = new Set(parsed.header);
  const present = requested.filter((c) => headerSet.has(c));
  const fullMatrix = buildMatrix(parsed, present);
  const usableFeatures = present.filter((_, j) =>
    fullMatrix.X.some((row) => Number.isFinite(row[j])),
  );
  if (usableFeatures.length === 0) {
    return { model: null, leakage, error: 'No usable (populated) pre-off feature columns in the export.' };
  }

  const matrix = buildMatrix(parsed, usableFeatures);
  const settledRaces = new Set(matrix.raceIds.filter((r) => r !== '')).size;
  const totalRaces = new Set(
    parsed.rows.map((r) => String(r.race_id ?? '')).filter((r) => r !== ''),
  ).size;
  if (matrix.y.length === 0) {
    return {
      model: null,
      leakage,
      error: 'No settled rows (no known `won` label) to train on.',
    };
  }

  const cols = usableFeatures.length;
  const mean = columnMeans(matrix.X, cols);
  const std = columnStds(matrix.X, mean, cols);
  const Z = matrix.X.map((row) => standardizeRow(row, mean, std));

  // 3. Deterministic batch gradient descent (zero init).
  const iterations = options.iterations ?? 600;
  const lr = options.learningRate ?? 0.1;
  const weights = new Array<number>(cols).fill(0);
  let bias = 0;
  const n = Z.length;
  for (let iter = 0; iter < iterations; iter++) {
    const gradW = new Array<number>(cols).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      let z = bias;
      for (let j = 0; j < cols; j++) z += weights[j] * Z[i][j];
      const p = sigmoid(z);
      const err = p - matrix.y[i];
      gradB += err;
      for (let j = 0; j < cols; j++) gradW[j] += err * Z[i][j];
    }
    bias -= (lr * gradB) / n;
    for (let j = 0; j < cols; j++) weights[j] -= (lr * gradW[j]) / n;
  }

  const positives = matrix.y.reduce((a, b) => a + b, 0);
  const negatives = n - positives;

  const model: ShadowModel = {
    kind: 'logistic_regression',
    model_active: false,
    seed: options.seed ?? 42,
    trained_at: options.trainedAt ?? new Date().toISOString(),
    training_date_range: { from: options.from ?? null, to: options.to ?? null },
    course: options.course ?? null,
    row_count: parsed.rows.length,
    race_count: totalRaces,
    settled_count: matrix.y.length,
    settled_race_count: settledRaces,
    feature_columns: usableFeatures,
    label: SHADOW_LABEL_COLUMN,
    leakage_check: leakage,
    standardization: { mean, std },
    weights,
    bias,
    evaluation: {
      in_sample_brier: null,
      in_sample_log_loss: null,
      in_sample_top1_race_hit_rate: null,
      positives,
      negatives,
      iterations,
      learning_rate: lr,
    },
    notes:
      'ML shadow model — not model-active. Research/decision-support only. Does not affect ' +
      'production probabilities, EV, staking, confidence, the no-bet gate, or any recommendation.',
  };

  // 4. Honest IN-SAMPLE metrics (fit, not skill).
  const metrics = evaluateInSample(model, parsed, settledRaces);
  model.evaluation.in_sample_brier = metrics.brier;
  model.evaluation.in_sample_log_loss = metrics.logLoss;
  model.evaluation.in_sample_top1_race_hit_rate = metrics.top1HitRate;

  return { model, leakage, error: null };
}

/* -------------------------------------------------------------------------- */
/* Prediction + scoring                                                        */
/* -------------------------------------------------------------------------- */

/** Predicts the shadow win-probability for one CSV record. Pure. */
export function predictProb(model: ShadowModel, record: Record<string, string>): number {
  const raw = model.feature_columns.map((c) => {
    const v = featureValue(record, c);
    return v === null ? Number.NaN : v;
  });
  const z = standardizeRow(raw, model.standardization.mean, model.standardization.std);
  let acc = model.bias;
  for (let j = 0; j < z.length; j++) acc += model.weights[j] * z[j];
  return sigmoid(acc);
}

/** One scored runner in a race (shadow output only — never a recommendation). */
export interface ShadowScoredRunner {
  race_id: string;
  runner_id: string;
  runner_name: string | null;
  ml_prob: number;
  ml_rank: number;
  /** Pre-off odds carried through for display (not used by the model output). */
  odds: number | null;
}

/** Groups CSV records by `race_id`, preserving first-seen race order. Pure. */
export function groupByRace(
  records: readonly Record<string, string>[],
): Map<string, Record<string, string>[]> {
  const map = new Map<string, Record<string, string>[]>();
  for (const r of records) {
    const id = String(r.race_id ?? '');
    if (id === '') continue;
    const list = map.get(id) ?? [];
    list.push(r);
    map.set(id, list);
  }
  return map;
}

/**
 * Scores one race's runners and ranks them by shadow win-probability (desc).
 * Ties break by runner_id for determinism. ml_rank is 1-based. Pure.
 */
export function scoreRace(
  model: ShadowModel,
  raceRecords: readonly Record<string, string>[],
): ShadowScoredRunner[] {
  const scored = raceRecords.map((r) => ({
    race_id: String(r.race_id ?? ''),
    runner_id: String(r.runner_id ?? ''),
    runner_name: (r.runner_name ?? '').trim() === '' ? null : r.runner_name.trim(),
    ml_prob: predictProb(model, r),
    ml_rank: 0,
    odds: cellNumber(r.pre_off_odds),
  }));
  scored.sort((a, b) => (b.ml_prob - a.ml_prob) || a.runner_id.localeCompare(b.runner_id));
  scored.forEach((s, i) => (s.ml_rank = i + 1));
  return scored;
}

/** In-sample metric outputs. */
interface InSampleMetrics {
  brier: number | null;
  logLoss: number | null;
  top1HitRate: number | null;
}

/**
 * Computes honest IN-SAMPLE fit metrics over the SETTLED rows: Brier score, log
 * loss, and the per-race top-1 hit rate (did the ML rank-1 runner actually win).
 * Pure; never claims out-of-sample skill.
 */
function evaluateInSample(
  model: ShadowModel,
  parsed: ParsedCsv,
  _settledRaces: number,
): InSampleMetrics {
  let brierSum = 0;
  let logLossSum = 0;
  let count = 0;
  const settledRecords: Record<string, string>[] = [];
  for (const record of parsed.rows) {
    const y = labelValue(record);
    if (y === null) continue;
    settledRecords.push(record);
    const p = predictProb(model, record);
    brierSum += (p - y) ** 2;
    const clamped = Math.min(1 - 1e-12, Math.max(1e-12, p));
    logLossSum += -(y * Math.log(clamped) + (1 - y) * Math.log(1 - clamped));
    count++;
  }
  if (count === 0) return { brier: null, logLoss: null, top1HitRate: null };

  // Per-race top-1 hit rate among races that have a recorded winner.
  let racesWithWinner = 0;
  let top1Hits = 0;
  for (const [, records] of groupByRace(settledRecords)) {
    const hasWinner = records.some((r) => cellBool(r[SHADOW_LABEL_COLUMN]) === 1);
    if (!hasWinner) continue;
    racesWithWinner++;
    const ranked = scoreRace(model, records);
    if (ranked.length > 0 && cellBool(records.find((r) => String(r.runner_id) === ranked[0].runner_id)?.[SHADOW_LABEL_COLUMN]) === 1) {
      top1Hits++;
    }
  }
  return {
    brier: brierSum / count,
    logLoss: logLossSum / count,
    top1HitRate: racesWithWinner > 0 ? top1Hits / racesWithWinner : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                               */
/* -------------------------------------------------------------------------- */

/** Serialises a model to pretty JSON. Pure. */
export function serializeModel(model: ShadowModel): string {
  return JSON.stringify(model, null, 2) + '\n';
}

/**
 * Parses + validates a serialised shadow model. Returns null on any structural
 * problem (never throws). Enforces `model_active === false`. Pure.
 */
export function parseModel(text: string): ShadowModel | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const m = obj as Record<string, unknown>;
  if (m.kind !== 'logistic_regression') return null;
  if (m.model_active !== false) return null;
  if (!Array.isArray(m.feature_columns) || !Array.isArray(m.weights)) return null;
  const std = m.standardization as { mean?: unknown; std?: unknown } | undefined;
  if (!std || !Array.isArray(std.mean) || !Array.isArray(std.std)) return null;
  return obj as ShadowModel;
}

/** True when the model was trained on too few settled RACES to trust. Pure. */
export function isSmallSample(model: Pick<ShadowModel, 'settled_race_count'>): boolean {
  return model.settled_race_count < MIN_SHADOW_TRAINING_RACES;
}
