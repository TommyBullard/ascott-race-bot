/**
 * CLI (READ-ONLY): generate a Markdown confidence-decomposition audit from
 * stored data. Phase 5 of the autonomous race-day workflow.
 *
 * For each race it selects the FINAL PRE-OFF run (latest `model_runs` row with
 * `run_time <= off_time`, via the same pure `selectPreOffRun` the dashboard
 * uses) and derives a diagnostic breakdown of WHY the run is Low/Medium/High
 * confidence — data, market, tipster, contextual, race-type, and execution
 * components — from already-stored observability. It is EXPLANATORY only.
 *
 * Usage:
 *   npm run confidence:audit -- --date 2026-06-16 --course Ascot
 *
 * Output (deterministic):
 *   reports/confidence-audit-2026-06-16-ascot.md
 *
 * STRICTLY READ-ONLY and DISPLAY-ONLY. It issues only `select` queries; it NEVER
 * changes the model probability, staking, ranking, recommendation, or the
 * persisted confidence, NEVER makes a component model-active, NEVER fetches a
 * live API, and NEVER writes to the database. The only write is the Markdown
 * file. It loads credentials from `.env.local` / `.env` and never prints them.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse } from '../src/lib/raceSync';
import { selectPreOffRun } from '../src/lib/modelPerformance';
import { STALE_ODDS_THRESHOLD_MS } from '../src/lib/modelDataQuality';
import {
  getDataQualityOutputsFromConfig,
  getTipsterModelAlignmentFromConfig,
} from '../src/lib/modelRunConfigReaders';
import {
  parseConfidenceAuditArgs,
  buildConfidenceAuditPath,
  detectSimilarEv,
  renderConfidenceAuditMarkdown,
  type ConfidenceAuditReport,
  type ConfidenceInputs,
  type RaceConfidenceInput,
} from '../src/lib/confidenceDiagnostics';

const RACES_TABLE = 'races';
const RACE_MEETING_DATE_COLUMN = 'meeting_date';
const RUNNERS_TABLE = 'runners';
const MODEL_RUNS_TABLE = 'model_runs';
const MODEL_RUNNER_SCORES_TABLE = 'model_runner_scores';
const RECOMMENDATIONS_TABLE = 'recommendations';

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

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Reads `config_json.data_quality_metrics` defensively (never throws). */
function readMetrics(configJson: unknown): {
  market_completeness: number | null;
  odds_age_ms: number | null;
  declared_runner_count: number | null;
} {
  const empty = { market_completeness: null, odds_age_ms: null, declared_runner_count: null };
  if (typeof configJson !== 'object' || configJson === null) return empty;
  const metrics = (configJson as Record<string, unknown>).data_quality_metrics;
  if (typeof metrics !== 'object' || metrics === null) return empty;
  const m = metrics as Record<string, unknown>;
  return {
    market_completeness: toNumberOrNull(m.market_completeness),
    odds_age_ms: toNumberOrNull(m.odds_age_ms),
    declared_runner_count: toNumberOrNull(m.declared_runner_count),
  };
}

interface RaceRow {
  id: string | number;
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
}

interface ScoreRow {
  runner_id: string | number;
  market_prob: number | string | null;
  model_prob: number | string | null;
  ev_per_1: number | string | null;
}

function offTimeSortKey(offTime: string | null): number {
  if (!offTime) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(offTime);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

async function buildRaceInput(race: RaceRow, runnerCount: number, nameById: Map<string, string>): Promise<RaceConfidenceInput> {
  const raceId = String(race.id);
  const offTime = race.off_time;

  const emptyInputs: ConfidenceInputs = {
    run_quality: null,
    data_quality_flags: [],
    tipster_alignment_label: null,
    market_completeness: null,
    field_size: runnerCount > 0 ? runnerCount : null,
    similar_ev: null,
    model_market_separation: null,
    pick_odds: null,
    odds_stale: null,
    is_handicap: typeof race.handicap_flag === 'boolean' ? race.handicap_flag : null,
    has_reviewed_context: false,
  };

  const { data: runData, error: runError } = await supabaseAdmin
    .from(MODEL_RUNS_TABLE)
    .select('id, run_time, config_json, data_quality_flags')
    .eq('race_id', raceId)
    .lte('run_time', offTime ?? '9999-12-31')
    .order('run_time', { ascending: true });
  if (runError) throw new Error(`Failed to read model runs for race ${raceId}: ${runError.message}`);
  const runs = (runData ?? []) as RunRow[];
  const chosen = selectPreOffRun(
    runs.map((r) => ({ run_id: String(r.id), run_time: String(r.run_time) })),
    offTime,
  );

  if (!chosen) {
    return {
      race_id: raceId,
      off_time: offTime,
      race_name: race.race_name,
      model_pick_name: null,
      original_confidence_label: null,
      inputs: emptyInputs,
    };
  }

  const selected = runs.find((r) => String(r.id) === chosen.run_id) as RunRow;
  const dq = getDataQualityOutputsFromConfig(selected.config_json);
  const alignment = getTipsterModelAlignmentFromConfig(selected.config_json);
  const alignmentLabel =
    alignment && typeof alignment.alignment_label === 'string' ? alignment.alignment_label : null;
  const flags = Array.isArray(selected.data_quality_flags)
    ? selected.data_quality_flags.filter((f): f is string => typeof f === 'string')
    : [];
  const metrics = readMetrics(selected.config_json);

  // Per-runner scores -> similar EV + the pick's model-vs-market separation.
  const [scoresRes, recRes] = await Promise.all([
    supabaseAdmin
      .from(MODEL_RUNNER_SCORES_TABLE)
      .select('runner_id, market_prob, model_prob, ev_per_1')
      .eq('model_run_id', chosen.run_id),
    supabaseAdmin
      .from(RECOMMENDATIONS_TABLE)
      .select('runner_id, recommendation_rank, confidence_label, odds')
      .eq('model_run_id', chosen.run_id)
      .eq('recommendation_rank', 1)
      .limit(1),
  ]);
  if (scoresRes.error) throw new Error(`Failed to read scores for race ${raceId}: ${scoresRes.error.message}`);
  if (recRes.error) throw new Error(`Failed to read recommendation for race ${raceId}: ${recRes.error.message}`);

  const scores = (scoresRes.data ?? []) as ScoreRow[];
  const similarEv = scores.length > 0 ? detectSimilarEv(scores.map((s) => toNumberOrNull(s.ev_per_1))) : null;

  const rec = (recRes.data ?? [])[0] as
    | { runner_id: string | number; confidence_label: string | null; odds: number | string | null }
    | undefined;
  let pickName: string | null = null;
  let pickOdds: number | null = null;
  let confidenceLabel: string | null = null;
  let separation: number | null = null;
  if (rec) {
    const pickId = String(rec.runner_id);
    pickName = nameById.get(pickId) ?? null;
    pickOdds = toNumberOrNull(rec.odds);
    confidenceLabel = rec.confidence_label ?? null;
    const pickScore = scores.find((s) => String(s.runner_id) === pickId);
    if (pickScore) {
      const mp = toNumberOrNull(pickScore.model_prob);
      const kp = toNumberOrNull(pickScore.market_prob);
      if (mp !== null && kp !== null) separation = Math.abs(mp - kp);
    }
  }

  // Odds staleness: prefer the metric age; else infer from the STALE_ODDS flag.
  let oddsStale: boolean | null = null;
  if (metrics.odds_age_ms !== null) oddsStale = metrics.odds_age_ms > STALE_ODDS_THRESHOLD_MS;
  else if (flags.includes('STALE_ODDS')) oddsStale = true;

  const inputs: ConfidenceInputs = {
    run_quality: dq.run_quality,
    data_quality_flags: flags,
    tipster_alignment_label: alignmentLabel,
    market_completeness: metrics.market_completeness,
    field_size: metrics.declared_runner_count ?? (runnerCount > 0 ? runnerCount : null),
    similar_ev: similarEv,
    model_market_separation: separation,
    pick_odds: pickOdds,
    odds_stale: oddsStale,
    is_handicap: typeof race.handicap_flag === 'boolean' ? race.handicap_flag : null,
    has_reviewed_context: false,
  };

  return {
    race_id: raceId,
    off_time: offTime,
    race_name: race.race_name,
    model_pick_name: pickName,
    original_confidence_label: confidenceLabel,
    inputs,
  };
}

async function main(): Promise<void> {
  loadEnv();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }

  const args = parseConfidenceAuditArgs(process.argv.slice(2));
  if (!args.date) {
    console.error(
      'Usage: npm run confidence:audit -- --date YYYY-MM-DD [--course <name>]\n' +
        '(read-only; writes a Markdown report under reports/, never the database).',
    );
    process.exitCode = 1;
    return;
  }
  const wantCourse = args.course ? normalizeCourse(args.course) : null;

  const { data: raceData, error: raceError } = await supabaseAdmin
    .from(RACES_TABLE)
    .select('id, off_time, course, race_name, handicap_flag')
    .eq(RACE_MEETING_DATE_COLUMN, args.date);
  if (raceError) throw new Error(`Failed to read races for ${args.date}: ${raceError.message}`);

  let races = (raceData ?? []) as RaceRow[];
  if (wantCourse) races = races.filter((r) => normalizeCourse(r.course ?? '') === wantCourse);
  races.sort((a, b) => offTimeSortKey(a.off_time) - offTimeSortKey(b.off_time));
  const raceIds = races.map((r) => String(r.id));

  // Runner names + per-race counts (field size).
  const nameById = new Map<string, string>();
  const countByRace = new Map<string, number>();
  if (raceIds.length > 0) {
    const { data: runnerData, error: runnerError } = await supabaseAdmin
      .from(RUNNERS_TABLE)
      .select('id, race_id, horse_name')
      .in('race_id', raceIds);
    if (runnerError) throw new Error(`Failed to read runners: ${runnerError.message}`);
    for (const r of (runnerData ?? []) as { id: string | number; race_id: string | number; horse_name: string }[]) {
      nameById.set(String(r.id), r.horse_name);
      const raceId = String(r.race_id);
      countByRace.set(raceId, (countByRace.get(raceId) ?? 0) + 1);
    }
  }

  const raceInputs: RaceConfidenceInput[] = [];
  for (const race of races) {
    try {
      raceInputs.push(await buildRaceInput(race, countByRace.get(String(race.id)) ?? 0, nameById));
    } catch (err) {
      console.error(`  skipped race ${String(race.id)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const report: ConfidenceAuditReport = {
    date: args.date,
    course: args.course ?? null,
    generatedAt: new Date().toISOString(),
    races: raceInputs,
  };

  const markdown = renderConfidenceAuditMarkdown(report);
  const outPath = buildConfidenceAuditPath(args.date, args.course);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, 'utf8');

  console.log(`Confidence audit written (read-only DB): ${outPath}`);
  console.log(`  races: ${raceInputs.length}${wantCourse ? ` (course ~ "${args.course}")` : ''}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
