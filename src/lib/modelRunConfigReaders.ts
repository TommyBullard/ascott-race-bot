/**
 * Pure, read-only readers for the observability outputs persisted in
 * `model_runs.config_json` (Batches D–H).
 *
 * These let persisted data-quality + tipster-consensus outputs be inspected
 * safely from a config_json blob (e.g. when building a dashboard or debugging),
 * without re-running the model. They NEVER throw on missing/malformed input,
 * never mutate, make no DB calls, and never fabricate values — a missing or
 * structurally-wrong field yields `null` or a documented safe default.
 *
 * `config_json` is untyped at the DB boundary, so every helper accepts `unknown`
 * and narrows defensively.
 */

/** True for a non-null, non-array plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a property from an unknown value only when it is an object. */
function getProp(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

/** Returns `value` when it is a string, else `null`. */
function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Returns a NEW array containing only the string entries of `value`, or `[]`
 * when `value` is not an array. Non-string entries are dropped (safe), and the
 * input is never mutated.
 */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

/**
 * Returns the `tipster_consensus` object from a config_json blob when it is
 * structurally usable (an object exposing `runner_support`), else `null`.
 */
export function getTipsterConsensusFromConfig(
  configJson: unknown,
): Record<string, unknown> | null {
  const consensus = getProp(configJson, 'tipster_consensus');
  // Minimal structural check: a usable consensus carries `runner_support`.
  if (isObject(consensus) && 'runner_support' in consensus) {
    return consensus;
  }
  return null;
}

/**
 * Returns the `tipster_model_alignment` object when it is structurally usable
 * (an object exposing `alignment_label`), else `null`.
 */
export function getTipsterModelAlignmentFromConfig(
  configJson: unknown,
): Record<string, unknown> | null {
  const alignment = getProp(configJson, 'tipster_model_alignment');
  if (isObject(alignment) && 'alignment_label' in alignment) {
    return alignment;
  }
  return null;
}

/** A human-readable summary read from config_json. */
export interface ConfigSummary {
  summary: string[];
  short_summary: string | null;
}

/**
 * Returns the tipster consensus summary (`{ summary, short_summary }`) from a
 * config_json blob. `summary` is always a string array (missing/invalid -> `[]`,
 * non-string entries dropped); `short_summary` is a string or `null`.
 */
export function getTipsterConsensusSummaryFromConfig(
  configJson: unknown,
): ConfigSummary {
  return {
    summary: asStringArray(getProp(configJson, 'tipster_consensus_summary')),
    short_summary: asStringOrNull(
      getProp(configJson, 'tipster_consensus_short_summary'),
    ),
  };
}

/** The data-quality observability outputs read from config_json. */
export interface DataQualityOutputs {
  run_quality: string | null;
  model_adjustments: Record<string, unknown> | null;
  data_quality_summary: string[];
  data_quality_short_summary: string | null;
}

/**
 * Returns the data-quality outputs persisted in config_json, with safe defaults
 * where missing: `run_quality` (string|null), `model_adjustments` (object|null),
 * `data_quality_summary` (string[]; `[]` when missing), and
 * `data_quality_short_summary` (string|null). Never throws, never mutates.
 */
export function getDataQualityOutputsFromConfig(
  configJson: unknown,
): DataQualityOutputs {
  const adjustments = getProp(configJson, 'model_adjustments');
  return {
    run_quality: asStringOrNull(getProp(configJson, 'run_quality')),
    model_adjustments: isObject(adjustments) ? adjustments : null,
    data_quality_summary: asStringArray(
      getProp(configJson, 'data_quality_summary'),
    ),
    data_quality_short_summary: asStringOrNull(
      getProp(configJson, 'data_quality_short_summary'),
    ),
  };
}
