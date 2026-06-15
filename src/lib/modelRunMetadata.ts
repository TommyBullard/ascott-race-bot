/**
 * Pure model-run metadata builder (audit / versioning).
 *
 * Produces the auditability fields persisted on every `model_runs` row so a run
 * records WHICH model/config/input mode produced it. No I/O, no DB — it is a
 * deterministic function of its inputs, so it is unit-tested in isolation and
 * shared by the producer ({@link import('./runModelForRace')}).
 *
 * INTEGRITY: never fabricates. The input mode and data-quality flags are derived
 * only from whether usable tipster selections were actually provided; missing
 * tipster data yields `market_only` + a `NO_TIPSTER_SELECTIONS` flag rather than
 * any invented support.
 */

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

/** Structured data-quality flags persisted on `model_runs.data_quality_flags`. */
export const DATA_QUALITY_FLAG = {
  /** No usable tipster selections were available, so the run is market-only. */
  NO_TIPSTER_SELECTIONS: 'NO_TIPSTER_SELECTIONS',
} as const;

export type DataQualityFlag =
  (typeof DATA_QUALITY_FLAG)[keyof typeof DATA_QUALITY_FLAG];

/** The audit/versioning fields written to a `model_runs` row. */
export interface ModelRunMetadata {
  model_version: string;
  probability_engine_version: string;
  staking_engine_version: string;
  input_mode: InputMode;
  config_json: Record<string, unknown>;
  data_quality_flags: string[];
}

export interface BuildModelRunMetadataInput {
  /**
   * Whether the race has at least one usable tipster selection. "Usable"
   * currently means "≥ 1 selection row was returned for the race". This is a
   * deliberately conservative, reliable signal — it does not attempt to infer
   * partial validity.
   *
   * TODO: if needed later, tighten "usable" to "selections that reference a
   * priced runner in this race" and add a distinct flag for the fetch-failed
   * case. Both are intentionally left as a single market-only signal for now to
   * avoid inventing behaviour.
   */
  hasUsableTipsterSelections: boolean;
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
 * tests / future engines). `input_mode` and `data_quality_flags` are derived
 * purely from {@link BuildModelRunMetadataInput.hasUsableTipsterSelections}:
 *
 *   - usable selections  -> `market_plus_tipsters`, no flag
 *   - none               -> `market_only`, flag `NO_TIPSTER_SELECTIONS`
 */
export function buildModelRunMetadata(
  input: BuildModelRunMetadataInput,
): ModelRunMetadata {
  const data_quality_flags: string[] = [];

  let input_mode: InputMode;
  if (input.hasUsableTipsterSelections) {
    input_mode = 'market_plus_tipsters';
  } else {
    input_mode = 'market_only';
    data_quality_flags.push(DATA_QUALITY_FLAG.NO_TIPSTER_SELECTIONS);
  }

  return {
    model_version: input.modelVersion ?? DEFAULT_MODEL_VERSION,
    probability_engine_version:
      input.probabilityEngineVersion ?? DEFAULT_PROBABILITY_ENGINE_VERSION,
    staking_engine_version:
      input.stakingEngineVersion ?? DEFAULT_STAKING_ENGINE_VERSION,
    input_mode,
    config_json: input.config ?? {},
    data_quality_flags,
  };
}
