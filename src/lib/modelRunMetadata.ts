/**
 * Pure model-run metadata builder (audit / versioning).
 *
 * Produces the auditability fields persisted on every `model_runs` row so a run
 * records WHICH model/config/input mode produced it. No I/O, no DB — it is a
 * deterministic function of its inputs, so it is unit-tested in isolation and
 * shared by the producer ({@link import('./runModelForRace')}).
 *
 * INTEGRITY: never fabricates. `input_mode` is derived only from whether usable
 * tipster selections were actually provided. The `data_quality_flags` are the
 * single-source output of {@link import('./modelDataQuality').assessDataQuality}
 * and are passed in by the caller; this module only stores them.
 */

export { DATA_QUALITY_FLAG, type DataQualityFlag } from './modelDataQuality';
import {
  evaluateRunQuality,
  determineModelAdjustments,
  type RunQuality,
  type ModelAdjustments,
} from './modelDataQuality';
export type { RunQuality, ModelAdjustments } from './modelDataQuality';

/** Engine identity tag stored in `model_runs.model_version`. */
export const DEFAULT_MODEL_VERSION = 'market-v1';

/** Which probability model produced the scores (`model_runs.probability_engine_version`). */
export const DEFAULT_PROBABILITY_ENGINE_VERSION = 'market_implied_v1';

/** Which staking model sized the stakes (`model_runs.staking_engine_version`). */
export const DEFAULT_STAKING_ENGINE_VERSION = 'fractional_kelly_0_2_v1';

/**
 * What inputs a run actually used:
 * - `market_only`          : priced market data only (no usable tipster support).
 * - `market_plus_tipsters` : market data plus at least one usable tipster
 *                            selection for the race.
 */
export type InputMode = 'market_only' | 'market_plus_tipsters';

/** The audit/versioning fields written to a `model_runs` row. */
export interface ModelRunMetadata {
  model_version: string;
  probability_engine_version: string;
  staking_engine_version: string;
  input_mode: InputMode;
  config_json: Record<string, unknown>;
  data_quality_flags: string[];
  /**
   * Overall run-quality verdict derived from `data_quality_flags`
   * (`OK | DEGRADED | STALE | INVALID`). Part of the metadata-builder output;
   * NOT yet persisted as its own `model_runs` column (no migration in this
   * batch).
   */
  run_quality: RunQuality;
  /**
   * Advisory, non-invasive adjustments derived from `data_quality_flags`
   * (`{ suppressStaking, reduceConfidence, notes }`). Recorded for VISIBILITY
   * only — downstream probability/staking/selection logic does not consume it
   * yet. Part of the metadata-builder output; not persisted as its own column.
   */
  model_adjustments: ModelAdjustments;
  /**
   * Data-quality-adjusted confidence (Batch F1), supplied by the caller and
   * stored verbatim — this builder computes nothing. OBSERVATIONAL only: not
   * consumed by probability/selection/staking. Omitted when not provided.
   */
  adjusted_confidence?: number;
}

export interface BuildModelRunMetadataInput {
  /**
   * Whether the race has at least one usable tipster selection. "Usable"
   * currently means "≥ 1 selection row was returned for the race". This is a
   * deliberately conservative, reliable signal — it does not attempt to infer
   * partial validity. It drives `input_mode` only; the corresponding
   * `NO_TIPSTER_SELECTIONS` data-quality flag is produced by
   * {@link import('./modelDataQuality').assessDataQuality} and passed in via
   * {@link BuildModelRunMetadataInput.dataQualityFlags}.
   */
  hasUsableTipsterSelections: boolean;
  /**
   * Data-quality flags for the run (the single-source output of
   * `assessDataQuality`). Stored verbatim on `model_runs.data_quality_flags`.
   * Defaults to `[]` when omitted; never fabricated here.
   */
  dataQualityFlags?: string[];
  /**
   * Data-quality-adjusted confidence for the run (computed by the caller via
   * `computeAdjustedConfidence`). Stored verbatim on the output's
   * `adjusted_confidence`; this builder does not compute it. Omitted when not
   * provided.
   */
  adjustedConfidence?: number;
  /** Override `model_version` (defaults to {@link DEFAULT_MODEL_VERSION}). */
  modelVersion?: string;
  /** Override the probability-engine version tag. */
  probabilityEngineVersion?: string;
  /** Override the staking-engine version tag. */
  stakingEngineVersion?: string;
  /**
   * Per-run config snapshot to persist as `config_json`. Defaults to `{}` — it
   * is reserved for richer per-run config capture and is never fabricated.
   */
  config?: Record<string, unknown>;
}

/**
 * Builds the audit/versioning metadata for one model run.
 *
 * The engine version tags default to the constants above (overridable for
 * tests / future engines). `input_mode` is derived from
 * {@link BuildModelRunMetadataInput.hasUsableTipsterSelections}
 * (usable -> `market_plus_tipsters`, none -> `market_only`). The
 * `data_quality_flags` are supplied by the caller (from `assessDataQuality`)
 * and stored verbatim, so flag detection lives in one place; `run_quality` is
 * the single verdict {@link evaluateRunQuality} derives from those flags, and
 * `model_adjustments` is the advisory (non-invasive) action set
 * {@link determineModelAdjustments} derives from them.
 */
export function buildModelRunMetadata(
  input: BuildModelRunMetadataInput,
): ModelRunMetadata {
  const input_mode: InputMode = input.hasUsableTipsterSelections
    ? 'market_plus_tipsters'
    : 'market_only';
  const data_quality_flags = input.dataQualityFlags ?? [];

  const metadata: ModelRunMetadata = {
    model_version: input.modelVersion ?? DEFAULT_MODEL_VERSION,
    probability_engine_version:
      input.probabilityEngineVersion ?? DEFAULT_PROBABILITY_ENGINE_VERSION,
    staking_engine_version:
      input.stakingEngineVersion ?? DEFAULT_STAKING_ENGINE_VERSION,
    input_mode,
    config_json: input.config ?? {},
    data_quality_flags,
    run_quality: evaluateRunQuality(data_quality_flags),
    model_adjustments: determineModelAdjustments(data_quality_flags),
  };

  // Store the caller-supplied adjusted confidence verbatim, only when provided
  // (kept optional so existing callers/output are unchanged).
  if (input.adjustedConfidence !== undefined) {
    metadata.adjusted_confidence = input.adjustedConfidence;
  }

  return metadata;
}
