/**
 * Dynamic tipster weighting — assembly, read-only API shaping, and snapshots.
 *
 * Bridges the stored tipster record (the leaderboard projection of
 * `tipster_priors` + the discovery snapshot) to the pure dynamic-weight scorer,
 * and shapes the result for the dashboard + an optional as-of snapshot row.
 *
 * DECISION-SUPPORT ONLY. This module never touches the model, EV, staking, or
 * any recommendation. It reuses {@link fetchTipsterLeaderboard} (read-only) and
 * either returns the explainable weights or upserts them into the additive
 * `tipster_dynamic_weights` history. The betting path is unchanged.
 *
 * NEVER FABRICATES: factors the stored record does not carry (Ascot / festival /
 * calibration segments need the pick-level pipeline) are passed as null, so they
 * are reported as "not present" and reduce coverage rather than being invented.
 */

import { supabaseAdmin } from './supabaseAdmin';
import { fetchTipsterLeaderboard, type TipsterLeaderboardEntry } from './raceData';
import {
  scoreDynamicTipsterWeight,
  type DynamicWeightResult,
  type TipsterFactorInputs,
} from './tipsterDynamicWeight';

const DYNAMIC_WEIGHTS_TABLE = 'tipster_dynamic_weights';

/** A tipster's identity + their explainable dynamic-weight assessment. */
export interface DynamicWeightEntry {
  tipster_id: string;
  name: string;
  affiliation: string | null;
  source: string | null;
  isActive: boolean;
  asOfDate: string | null;
  assessment: DynamicWeightResult;
}

/**
 * Maps a leaderboard entry to dynamic-weight factor inputs. ROI / strike / recent
 * form / sample come from the proofed record; the Ascot / festival / calibration
 * segments are not in this projection, so they are null (computed later by the
 * pick-level pipeline — never fabricated here). `asOfDate` proxies recency.
 */
export function leaderboardEntryToInputs(entry: TipsterLeaderboardEntry): TipsterFactorInputs {
  return {
    betsCount: entry.betsCount,
    roi: entry.longRunRoi,
    strikeRate: entry.strikeRate,
    recentRoi: entry.recentRoi30d,
    lastSeenDate: entry.asOfDate,
    ascotRoi: null,
    ascotSampleSize: null,
    festivalRoi: null,
    festivalSampleSize: null,
    calibrationScore: null,
    calibrationSampleSize: null,
  };
}

/** Options for building dynamic-weight entries. */
export interface BuildDynamicWeightOptions {
  /** Gradual-ramp factor in [0,1]; default 0 (no influence). */
  rampAlpha?: number;
  /** "Now" for recency math (injectable for tests). */
  now?: Date;
}

/**
 * Scores every leaderboard entry into an explainable dynamic weight and sorts by
 * `dynamic_weight` descending. Pure; deterministic given `now`.
 */
export function buildDynamicWeightEntries(
  entries: readonly TipsterLeaderboardEntry[],
  options: BuildDynamicWeightOptions = {},
): DynamicWeightEntry[] {
  const rows = entries.map((entry) => ({
    tipster_id: entry.tipster_id,
    name: entry.name,
    affiliation: entry.affiliation,
    source: entry.source,
    isActive: entry.isActive,
    asOfDate: entry.asOfDate,
    assessment: scoreDynamicTipsterWeight(leaderboardEntryToInputs(entry), {
      rampAlpha: options.rampAlpha,
      now: options.now,
    }),
  }));
  rows.sort((a, b) => b.assessment.dynamic_weight - a.assessment.dynamic_weight);
  return rows;
}

/**
 * Read-only: fetches the tipster leaderboard and returns each tipster's
 * explainable dynamic weight. Never writes. Never affects betting.
 *
 * @throws if the underlying leaderboard read fails.
 */
export async function fetchDynamicTipsterWeights(
  options: BuildDynamicWeightOptions = {},
): Promise<DynamicWeightEntry[]> {
  const entries = await fetchTipsterLeaderboard();
  return buildDynamicWeightEntries(entries, options);
}

/** The `tipster_dynamic_weights` row shape for one as-of snapshot. */
export interface DynamicWeightSnapshotRow {
  tipster_id: string;
  as_of_date: string;
  bets_count: number | null;
  dynamic_weight: number;
  raw_skill: number;
  reliability: number;
  coverage: number;
  ramp_alpha: number;
  effective_weight: number;
  roi: number | null;
  strike_rate: number | null;
  recent_roi: number | null;
  ascot_roi: number | null;
  ascot_sample_size: number | null;
  festival_roi: number | null;
  festival_sample_size: number | null;
  calibration_score: number | null;
  calibration_sample_size: number | null;
  factors: DynamicWeightResult['factors'];
  reasons: string[];
}

/** Reads a numeric factor's raw value from an assessment, or null. */
function factorRaw(assessment: DynamicWeightResult, factor: string): number | null {
  return assessment.factors.find((f) => f.factor === factor)?.rawValue ?? null;
}

/** Builds a snapshot row from a scored entry for a given as-of date. Pure. */
export function snapshotRowFromEntry(
  entry: DynamicWeightEntry,
  asOfDate: string,
): DynamicWeightSnapshotRow {
  const a = entry.assessment;
  return {
    tipster_id: entry.tipster_id,
    as_of_date: asOfDate,
    bets_count: a.bets_count,
    dynamic_weight: a.dynamic_weight,
    raw_skill: a.raw_skill,
    reliability: a.reliability,
    coverage: a.coverage,
    ramp_alpha: a.ramp_alpha,
    effective_weight: a.effective_weight,
    roi: factorRaw(a, 'roi'),
    strike_rate: factorRaw(a, 'strike_rate'),
    recent_roi: factorRaw(a, 'recent_form'),
    ascot_roi: factorRaw(a, 'ascot'),
    ascot_sample_size: a.factors.find((f) => f.factor === 'ascot')?.sampleSize ?? null,
    festival_roi: factorRaw(a, 'festival'),
    festival_sample_size: a.factors.find((f) => f.factor === 'festival')?.sampleSize ?? null,
    calibration_score: factorRaw(a, 'calibration'),
    calibration_sample_size:
      a.factors.find((f) => f.factor === 'calibration')?.sampleSize ?? null,
    factors: a.factors,
    reasons: a.reasons,
  };
}

/**
 * Upserts as-of snapshots into `tipster_dynamic_weights`, one row per tipster
 * for `asOfDate` (idempotent on the unique `(tipster_id, as_of_date)` index).
 * Decision-support persistence only — it writes NO model/staking table.
 *
 * @throws if a write fails.
 */
export async function persistDynamicWeightSnapshots(
  entries: readonly DynamicWeightEntry[],
  asOfDate: string,
): Promise<number> {
  let written = 0;
  for (const entry of entries) {
    const row = snapshotRowFromEntry(entry, asOfDate);
    const { error } = await supabaseAdmin
      .from(DYNAMIC_WEIGHTS_TABLE)
      .upsert(row, { onConflict: 'tipster_id,as_of_date' });
    if (error) {
      throw new Error(`Failed to upsert dynamic weight for ${entry.tipster_id}: ${error.message}`);
    }
    written++;
  }
  return written;
}
