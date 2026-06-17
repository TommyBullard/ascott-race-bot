/**
 * CLI (READ-ONLY): export ML training data as a leakage-safe CSV from stored data.
 *
 * For every race in a meeting-date range (optionally one course) it selects the
 * model's FINAL PRE-OFF run — the latest `model_runs` row with
 * `run_time <= off_time` — and emits ONE ROW PER RUNNER joining:
 *   - pre-race race/runner attributes,
 *   - the pre-off priced odds (from the run's market snapshot),
 *   - the pre-off per-runner model probability / EV / confidence (and derived
 *     market & model ranks),
 *   - the pre-off data-quality + tipster observability,
 *   - and, kept strictly SEPARATE, the official result LABELS (finish_pos, won,
 *     placed, SP, BSP).
 * The pre-off run is chosen with the same pure `selectPreOffRun` the dashboard
 * uses, so post-off reruns are ignored. The final BSP is a label only; post-off
 * odds and post-race text are never emitted as features.
 *
 * Usage:
 *   npm run export:training-data -- --from 2026-06-16 --to 2026-06-16 --course Ascot
 *
 * Output (deterministic):
 *   data/exports/training-data-2026-06-16-to-2026-06-16-ascot.csv
 *
 * STRICTLY READ-ONLY. It issues only `select` queries via the service-role
 * client; it NEVER runs the model, fetches live odds, imports results, mutates
 * the database, or reads manual notes. The only write is the CSV file. It loads
 * credentials from `.env.local` / `.env` and never prints them.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse } from '../src/lib/raceSync';
import { selectPreOffRun } from '../src/lib/modelPerformance';
import {
  getDataQualityOutputsFromConfig,
  getTipsterModelAlignmentFromConfig,
} from '../src/lib/modelRunConfigReaders';
import {
  parseTrainingExportArgs,
  buildTrainingExportPath,
  computeProbRanks,
  extractTipsterSupportShares,
  deriveWon,
  derivePlaced,
  renderTrainingCsv,
  type TrainingRunnerRow,
} from '../src/lib/trainingExport';

const RACES_TABLE = 'races';
const RACE_MEETING_DATE_COLUMN = 'meeting_date';
const MODEL_RUNS_TABLE = 'model_runs';
const MODEL_RUNNER_SCORES_TABLE = 'model_runner_scores';
const RUNNERS_TABLE = 'runners';
const RUNNER_QUOTES_TABLE = 'runner_quotes';

/** Loads env from `.env.local`, then `.env`; falls back to the shell env. */
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Not present; try the next, then fall back to shell env.
    }
  }
}

/** Coerces a possibly null/string DB numeric to a number, or `null`. */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Coerces a possibly null DB text value to a trimmed string, or `null`. */
function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

interface RaceRow {
  id: string | number;
  meeting_date: string | null;
  off_time: string | null;
  course: string | null;
  race_name: string | null;
  handicap_flag: boolean | null;
}

interface RunRow {
  id: string | number;
  run_time: string | null;
  config_json: unknown;
  data_quality_flags: unknown;
  market_snapshot_id: string | number | null;
}

interface RunnerRow {
  id: string | number;
  horse_name: string;
  trainer: string | null;
  jockey: string | null;
  draw: number | string | null;
  official_rating: number | string | null;
  weight_lbs: number | string | null;
  finish_pos: number | string | null;
  sp_decimal: number | string | null;
  bsp_decimal: number | string | null;
}

interface ScoreRow {
  runner_id: string | number;
  market_prob: number | string | null;
  model_prob: number | string | null;
  ev_per_1: number | string | null;
  confidence_score: number | string | null;
}

/** Sort key for off_time: known instants ascending, unknowns last. */
function offTimeSortKey(offTime: string | null): number {
  if (!offTime) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(offTime);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Builds the runner rows for one race from stored data. Read-only; never writes.
 * Returns an empty array when the race has no pre-off model run (the caller
 * counts those as skipped) so the export stays grounded in real model history.
 */
async function buildRaceRows(race: RaceRow): Promise<TrainingRunnerRow[]> {
  const raceId = String(race.id);
  const offTime = race.off_time;

  // Runner attributes + official result labels (read-only).
  const { data: runnerData, error: runnerError } = await supabaseAdmin
    .from(RUNNERS_TABLE)
    .select('id, horse_name, trainer, jockey, draw, official_rating, weight_lbs, finish_pos, sp_decimal, bsp_decimal')
    .eq('race_id', raceId);
  if (runnerError) {
    throw new Error(`Failed to read runners for race ${raceId}: ${runnerError.message}`);
  }
  const runners = (runnerData ?? []) as RunnerRow[];

  // All model runs for the race (append-only history). Read-only.
  const { data: runData, error: runError } = await supabaseAdmin
    .from(MODEL_RUNS_TABLE)
    .select('id, run_time, config_json, data_quality_flags, market_snapshot_id')
    .eq('race_id', raceId)
    .order('run_time', { ascending: true });
  if (runError) {
    throw new Error(`Failed to read model runs for race ${raceId}: ${runError.message}`);
  }
  const runs = (runData ?? []) as RunRow[];

  // Select the latest PRE-OFF run (run_time <= off_time); post-off runs ignored.
  const chosen = selectPreOffRun(
    runs.map((r) => ({ run_id: String(r.id), run_time: String(r.run_time) })),
    offTime,
  );
  if (!chosen) {
    return []; // No pre-off run -> no model features; skip this race.
  }
  const selected = runs.find((r) => String(r.id) === chosen.run_id) as RunRow;

  // Run-level observability (pre-off) from config_json + the flags column.
  const dq = getDataQualityOutputsFromConfig(selected.config_json);
  const alignment = getTipsterModelAlignmentFromConfig(selected.config_json);
  const alignmentLabel =
    alignment && typeof alignment.alignment_label === 'string'
      ? alignment.alignment_label
      : null;
  const flags = Array.isArray(selected.data_quality_flags)
    ? selected.data_quality_flags.filter((f): f is string => typeof f === 'string')
    : [];
  const supportShares = extractTipsterSupportShares(selected.config_json);

  // Per-runner pre-off scores + the run's stored pre-off quote odds (read-only).
  const [scoresRes, quotesRes] = await Promise.all([
    supabaseAdmin
      .from(MODEL_RUNNER_SCORES_TABLE)
      .select('runner_id, market_prob, model_prob, ev_per_1, confidence_score')
      .eq('model_run_id', chosen.run_id),
    selected.market_snapshot_id != null
      ? supabaseAdmin
          .from(RUNNER_QUOTES_TABLE)
          .select('runner_id, odds_decimal')
          .eq('snapshot_id', selected.market_snapshot_id)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const res of [scoresRes, quotesRes]) {
    if (res.error) {
      throw new Error(`Failed to read export data for race ${raceId}: ${res.error.message}`);
    }
  }

  const scores = (scoresRes.data ?? []) as ScoreRow[];
  const scoreById = new Map<string, ScoreRow>();
  for (const s of scores) scoreById.set(String(s.runner_id), s);

  // First stored pre-off quote per runner (deterministic); the priced odds.
  const oddsById = new Map<string, number | null>();
  for (const q of (quotesRes.data ?? []) as {
    runner_id: string | number;
    odds_decimal: number | string | null;
  }[]) {
    const id = String(q.runner_id);
    if (!oddsById.has(id)) oddsById.set(id, toNumberOrNull(q.odds_decimal));
  }

  // Derive market & model ranks from the pre-off probabilities (pure helper).
  const marketRanks = computeProbRanks(
    scores.map((s) => ({ runner_id: String(s.runner_id), prob: toNumberOrNull(s.market_prob) })),
  );
  const modelRanks = computeProbRanks(
    scores.map((s) => ({ runner_id: String(s.runner_id), prob: toNumberOrNull(s.model_prob) })),
  );

  const fieldSize = runners.length;

  const rows: TrainingRunnerRow[] = runners.map((runner) => {
    const id = String(runner.id);
    const score = scoreById.get(id);
    const finishPos = toNumberOrNull(runner.finish_pos);
    return {
      // pre-race FEATURES
      race_id: raceId,
      runner_id: id,
      race_date: race.meeting_date,
      course: race.course,
      off_time: race.off_time,
      race_name: race.race_name,
      race_type: null, // not persisted in the current schema
      is_handicap: typeof race.handicap_flag === 'boolean' ? race.handicap_flag : null,
      field_size: fieldSize,
      runner_name: runner.horse_name ?? null,
      draw: toNumberOrNull(runner.draw),
      age: null, // not persisted in the current schema
      weight: toNumberOrNull(runner.weight_lbs),
      official_rating: toNumberOrNull(runner.official_rating),
      trainer: toStringOrNull(runner.trainer),
      jockey: toStringOrNull(runner.jockey),
      pre_off_odds: oddsById.get(id) ?? null,
      market_rank_pre_off: marketRanks.get(id) ?? null,
      model_prob_pre_off: score ? toNumberOrNull(score.model_prob) : null,
      model_rank_pre_off: modelRanks.get(id) ?? null,
      ev_pre_off: score ? toNumberOrNull(score.ev_per_1) : null,
      confidence: score ? toNumberOrNull(score.confidence_score) : null,
      data_quality: dq.run_quality,
      data_quality_flags: flags,
      tipster_alignment: alignmentLabel,
      tipster_support_share: supportShares.get(id) ?? null,
      // post-race LABELS
      finish_pos: finishPos,
      won: deriveWon(finishPos),
      placed: derivePlaced(finishPos),
      sp_decimal: toNumberOrNull(runner.sp_decimal),
      bsp_decimal: toNumberOrNull(runner.bsp_decimal),
    };
  });

  // Deterministic within-race order: by market rank (favourite first), then id.
  rows.sort(
    (a, b) =>
      (a.market_rank_pre_off ?? Number.POSITIVE_INFINITY) -
        (b.market_rank_pre_off ?? Number.POSITIVE_INFINITY) ||
      a.runner_id.localeCompare(b.runner_id),
  );

  return rows;
}

async function main(): Promise<void> {
  loadEnv();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }

  const args = parseTrainingExportArgs(process.argv.slice(2));
  if (!args.from || !args.to) {
    console.error(
      'Usage: npm run export:training-data -- --from YYYY-MM-DD --to YYYY-MM-DD [--course <name>]\n' +
        '(read-only; writes a CSV under data/exports/, never the database).',
    );
    process.exitCode = 1;
    return;
  }

  const wantCourse = args.course ? normalizeCourse(args.course) : null;

  // Races in the meeting-date range (read-only).
  const { data: raceData, error: raceError } = await supabaseAdmin
    .from(RACES_TABLE)
    .select('id, meeting_date, off_time, course, race_name, handicap_flag')
    .gte(RACE_MEETING_DATE_COLUMN, args.from)
    .lte(RACE_MEETING_DATE_COLUMN, args.to);
  if (raceError) {
    throw new Error(`Failed to read races for ${args.from}..${args.to}: ${raceError.message}`);
  }

  let races = (raceData ?? []) as RaceRow[];
  if (wantCourse) {
    races = races.filter((r) => normalizeCourse(r.course ?? '') === wantCourse);
  }
  // Deterministic race order: by off time, then id.
  races.sort(
    (a, b) =>
      offTimeSortKey(a.off_time) - offTimeSortKey(b.off_time) ||
      String(a.id).localeCompare(String(b.id)),
  );

  const allRows: TrainingRunnerRow[] = [];
  let racesWithRun = 0;
  let racesSkipped = 0;
  for (const race of races) {
    try {
      const rows = await buildRaceRows(race);
      if (rows.length === 0) {
        racesSkipped += 1; // no pre-off run for this race
        continue;
      }
      racesWithRun += 1;
      allRows.push(...rows);
    } catch (err) {
      racesSkipped += 1;
      console.error(
        `  skipped race ${String(race.id)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const csv = renderTrainingCsv(allRows);
  const outPath = buildTrainingExportPath(args.from, args.to, args.course);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, csv, 'utf8');

  console.log(`Training data exported (read-only DB): ${outPath}`);
  console.log(
    `  rows: ${allRows.length} · races with a pre-off run: ${racesWithRun} · ` +
      `races skipped (no pre-off run): ${racesSkipped}` +
      `${wantCourse ? ` · course ~ "${args.course}"` : ''}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
