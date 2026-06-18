/**
 * ML learning pipeline — the canonical training-example data model + builder.
 *
 * One {@link TrainingExample} is the immutable, leakage-segregated snapshot of a
 * single (race, runner) once the race has settled: the pre-off model output
 * (recommendation, model probability, EV, odds, confidence, favourite flag) plus
 * the post-race outcome (finish position, won, placed, favourite result, BSP/SP).
 * Captured automatically as races settle, these rows ARE the self-building
 * training dataset that future ML experimentation, model calibration, confidence
 * calibration, and feature-importance analysis read.
 *
 * STRICTLY SHADOW / DECISION-SUPPORT:
 *   - It captures already-computed production output; it NEVER changes model
 *     probability, EV, staking, ranking, or any recommendation. No ML model is
 *     made active by this layer.
 *   - PURE here (no I/O): the builder is deterministic and unit-testable; the
 *     capture writer lives in mlCapture.ts.
 *   - LEAKAGE-SEGREGATED: {@link FEATURE_FIELDS} (pre-off-known) and
 *     {@link LABEL_FIELDS} (post-race) are kept explicitly separate so a trainer
 *     can never use an outcome as an input. BSP is a LABEL only.
 *   - NEVER FABRICATES: a missing value stays null; `won`/`placed` are null until
 *     a real finishing position exists.
 */

import { deriveWon, derivePlaced } from './trainingExport';

/** The inputs to build one training example (already-computed values). */
export interface TrainingExampleInput {
  raceId: string;
  runnerId: string;
  modelRunId?: string | null;
  meetingDate?: string | null;
  course?: string | null;
  offTime?: string | null;
  modelVersion?: string | null;
  fieldSize?: number | null;

  /* ---- pre-off FEATURES (the tracked decision inputs) ---- */
  /** Was this runner the staked recommendation (the bet)? */
  recommended: boolean;
  /** Recommendation rank (1 = the bet), or null when not recommended. */
  recommendationRank?: number | null;
  modelProb: number | null;
  marketProb: number | null;
  edge: number | null;
  /** Expected value per 1 unit staked. */
  ev: number | null;
  /** Pre-off decimal odds the runner was scored on. */
  odds: number | null;
  confidenceScore: number | null;
  confidenceLabel?: string | null;
  /** Was this the market favourite (shortest price)? */
  isFavourite: boolean;

  /* ---- post-race LABELS (the outcome) ---- */
  finishPos: number | null;
  /** Did the race's FAVOURITE win? (race-level outcome, stamped on every row.) */
  favouriteWon?: boolean | null;
  /** Did the race's favourite place? */
  favouritePlaced?: boolean | null;
  /** Betfair SP — LABEL ONLY. */
  bsp?: number | null;
  sp?: number | null;
}

/** One captured training example (the `ml_training_examples` row shape). */
export interface TrainingExample {
  race_id: string;
  runner_id: string;
  model_run_id: string | null;
  meeting_date: string | null;
  course: string | null;
  off_time: string | null;
  model_version: string | null;
  field_size: number | null;

  /* features */
  recommended: boolean;
  recommendation_rank: number | null;
  model_prob: number | null;
  market_prob: number | null;
  edge: number | null;
  ev: number | null;
  odds: number | null;
  confidence_score: number | null;
  confidence_label: string | null;
  is_favourite: boolean;

  /* labels */
  finish_pos: number | null;
  won: boolean | null;
  placed: boolean | null;
  favourite_won: boolean | null;
  favourite_placed: boolean | null;
  bsp_decimal: number | null;
  sp_decimal: number | null;
}

/** Pre-off FEATURE field names (safe ML inputs). */
export const FEATURE_FIELDS: readonly (keyof TrainingExample)[] = [
  'recommended',
  'recommendation_rank',
  'model_prob',
  'market_prob',
  'edge',
  'ev',
  'odds',
  'confidence_score',
  'confidence_label',
  'is_favourite',
  'field_size',
];

/** Post-race LABEL field names (NEVER ML inputs). */
export const LABEL_FIELDS: readonly (keyof TrainingExample)[] = [
  'finish_pos',
  'won',
  'placed',
  'favourite_won',
  'favourite_placed',
  'bsp_decimal',
  'sp_decimal',
];

/** A finite number, else null. */
function numOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A non-empty trimmed string, else null. */
function strOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

/** A nullable boolean passthrough (only true/false survive). */
function boolOrNull(v: boolean | null | undefined): boolean | null {
  return v === true ? true : v === false ? false : null;
}

/**
 * Builds one immutable, leakage-segregated training example from already-computed
 * values. `won`/`placed` derive from the finishing position via the shared
 * {@link deriveWon}/{@link derivePlaced} (null until the race is settled), so the
 * capture never fabricates an outcome. Pure; never throws.
 */
export function buildTrainingExample(input: TrainingExampleInput): TrainingExample {
  const finish = numOrNull(input.finishPos);
  return {
    race_id: input.raceId,
    runner_id: input.runnerId,
    model_run_id: strOrNull(input.modelRunId),
    meeting_date: strOrNull(input.meetingDate),
    course: strOrNull(input.course),
    off_time: strOrNull(input.offTime),
    model_version: strOrNull(input.modelVersion),
    field_size: numOrNull(input.fieldSize),

    recommended: input.recommended === true,
    recommendation_rank: numOrNull(input.recommendationRank),
    model_prob: numOrNull(input.modelProb),
    market_prob: numOrNull(input.marketProb),
    edge: numOrNull(input.edge),
    ev: numOrNull(input.ev),
    odds: numOrNull(input.odds),
    confidence_score: numOrNull(input.confidenceScore),
    confidence_label: strOrNull(input.confidenceLabel),
    is_favourite: input.isFavourite === true,

    finish_pos: finish,
    won: deriveWon(finish),
    placed: derivePlaced(finish),
    favourite_won: boolOrNull(input.favouriteWon),
    favourite_placed: boolOrNull(input.favouritePlaced),
    bsp_decimal: numOrNull(input.bsp),
    sp_decimal: numOrNull(input.sp),
  };
}

/** True once a real finishing position exists (the example is label-complete). */
export function isExampleSettled(example: TrainingExample): boolean {
  return example.finish_pos !== null;
}
