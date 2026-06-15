/**
 * Pure mapping from a race card's observability object (exposed by
 * GET /api/recommendations, sourced from model_runs.config_json by Batch J1) to
 * the flat, presentational props consumed by <RaceExplanationPanel>.
 *
 * This is the read-only seam between the API shape and the dashboard UI. It does
 * null-safe extraction from the loosely-typed observability values — the
 * tipster-model alignment label and the stake-suppression / reduce-confidence
 * flags — and nothing else. It performs NO model computation: every value is
 * read straight from persisted model output. Safe to import in client code
 * (no React, no DB, no server-only deps).
 */

/**
 * The observability sub-shape the panel needs. Mirrors the camelCase
 * `ModelRunObservability` exposed on `RaceCard`, but every field is optional and
 * null-safe so missing / legacy / malformed data never throws.
 */
export interface RaceObservabilityLike {
  runQuality?: string | null;
  modelAdjustments?: Record<string, unknown> | null;
  dataQualityAdjustedConfidence?: number | null;
  dataQualityShortSummary?: string | null;
  dataQualitySummary?: string[] | null;
  tipsterModelAlignment?: Record<string, unknown> | null;
  tipsterConsensusShortSummary?: string | null;
  tipsterConsensusSummary?: string[] | null;
}

/** Flat, presentational props for <RaceExplanationPanel>. */
export interface RaceExplanationProps {
  dataQualityShortSummary: string | null;
  dataQualitySummary: string[] | null;
  tipsterConsensusShortSummary: string | null;
  tipsterConsensusSummary: string[] | null;
  runQuality: string | null;
  alignmentLabel: string | null;
  stakeSuppressed: boolean;
  confidenceReduced: boolean;
  adjustedConfidence: number | null;
}

/** A non-empty string, else null. */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** A non-empty array of non-empty strings, else null. */
function asStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  );
  return items.length > 0 ? items : null;
}

/** A finite number, else null. */
function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Strictly reads a boolean flag from a loosely-typed record (only `true`). */
function readFlag(
  record: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  return !!record && record[key] === true;
}

/**
 * Flattens a race card's observability object into the panel props. Tolerant of
 * `null` / `undefined` / partial input: returns all-null / `false` so the panel
 * renders its safe empty state. Never fabricates values.
 */
export function deriveRaceExplanationProps(
  observability: RaceObservabilityLike | null | undefined,
): RaceExplanationProps {
  const o = observability ?? {};
  return {
    dataQualityShortSummary: asString(o.dataQualityShortSummary),
    dataQualitySummary: asStringList(o.dataQualitySummary),
    tipsterConsensusShortSummary: asString(o.tipsterConsensusShortSummary),
    tipsterConsensusSummary: asStringList(o.tipsterConsensusSummary),
    runQuality: asString(o.runQuality),
    alignmentLabel: asString(o.tipsterModelAlignment?.alignment_label),
    stakeSuppressed: readFlag(o.modelAdjustments, 'suppressStaking'),
    confidenceReduced: readFlag(o.modelAdjustments, 'reduceConfidence'),
    adjustedConfidence: asFiniteNumber(o.dataQualityAdjustedConfidence),
  };
}
