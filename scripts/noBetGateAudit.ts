/**
 * CLI (READ-ONLY): generate a Markdown no-bet gate research audit from stored
 * data. Phase 6 of the autonomous race-day workflow.
 *
 * For each race it selects the FINAL PRE-OFF run (latest `model_runs` row with
 * `run_time <= off_time`, via the same pure `selectPreOffRun` the dashboard
 * uses) and resolves the pick, outcome, stake/odds/EV, and the data-quality /
 * tipster / confidence signals. It then SIMULATES candidate skip rules and
 * reports what would have happened — RESEARCH ONLY.
 *
 * Usage:
 *   npm run gates:audit -- --date 2026-06-16 --course Ascot
 *
 * Output (deterministic):
 *   reports/no-bet-gate-audit-2026-06-16-ascot.md
 *
 * STRICTLY READ-ONLY and RESEARCH-ONLY. It issues only `select` queries; it
 * NEVER changes a live recommendation, NEVER activates a gate, NEVER suppresses
 * a real model output, NEVER fetches a live API, and NEVER writes to the
 * database. The only write is the Markdown file. Credentials load from
 * `.env.local` / `.env` and are never printed.
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
import { detectSimilarEv, deriveRaceTypeConfidence } from '../src/lib/confidenceDiagnostics';
import {
  parseGateAuditArgs,
  buildGateAuditPath,
  renderGateAuditMarkdown,
  type GateAuditReport,
  type GateRaceInput,
} from '../src/lib/noBetGateAudit';

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
  ev_per_1: number | string | null;
}

function offTimeSortKey(offTime: string | null): number {
  if (!offTime) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(offTime);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

async function buildRaceInput(
  race: RaceRow,
  runnerCount: number,
  nameById: Map<string, string>,
  finishById: Map<string, number | null>,
  winnerName: string | null,
  hasResult: boolean,
): Promise<GateRaceInput> {
  const raceId = String(race.id);
  const offTime = race.off_time;
  const fieldSize = runnerCount > 0 ? runnerCount : null;
  const isHandicap = typeof race.handicap_flag === 'boolean' ? race.handicap_flag : null;

  const base: GateRaceInput = {
    race_id: raceId,
    off_time: offTime,
    race_name: race.race_name,
    model_pick_name: null,
    confidence_label: null,
    run_quality: null,
    tipster_alignment_label: null,
    field_size: fieldSize,
    similar_ev: null,
    race_type_confidence_low: null,
    has_pick: false,
    has_result: hasResult,
    won: false,
    odds: null,
    stake: null,
    ev: null,
    winner_name: winnerName,
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
  if (!chosen) return base;

  const selected = runs.find((r) => String(r.id) === chosen.run_id) as RunRow;
  base.run_quality = getDataQualityOutputsFromConfig(selected.config_json).run_quality;
  const alignment = getTipsterModelAlignmentFromConfig(selected.config_json);
  base.tipster_alignment_label =
    alignment && typeof alignment.alignment_label === 'string' ? alignment.alignment_label : null;

  const [scoresRes, recRes] = await Promise.all([
    supabaseAdmin
      .from(MODEL_RUNNER_SCORES_TABLE)
      .select('runner_id, ev_per_1')
      .eq('model_run_id', chosen.run_id),
    supabaseAdmin
      .from(RECOMMENDATIONS_TABLE)
      .select('runner_id, recommendation_rank, confidence_label, stake_amount, odds, ev')
      .eq('model_run_id', chosen.run_id)
      .eq('recommendation_rank', 1)
      .limit(1),
  ]);
  if (scoresRes.error) throw new Error(`Failed to read scores for race ${raceId}: ${scoresRes.error.message}`);
  if (recRes.error) throw new Error(`Failed to read recommendation for race ${raceId}: ${recRes.error.message}`);

  const scores = (scoresRes.data ?? []) as ScoreRow[];
  base.similar_ev = scores.length > 0 ? detectSimilarEv(scores.map((s) => toNumberOrNull(s.ev_per_1))) : null;
  base.race_type_confidence_low =
    deriveRaceTypeConfidence({
      run_quality: base.run_quality,
      data_quality_flags: [],
      tipster_alignment_label: base.tipster_alignment_label,
      market_completeness: null,
      field_size: fieldSize,
      similar_ev: base.similar_ev,
      model_market_separation: null,
      pick_odds: null,
      odds_stale: null,
      is_handicap: isHandicap,
      has_reviewed_context: false,
    }).level === 'low';

  const rec = (recRes.data ?? [])[0] as
    | {
        runner_id: string | number;
        confidence_label: string | null;
        stake_amount: number | string | null;
        odds: number | string | null;
        ev: number | string | null;
      }
    | undefined;
  if (rec) {
    const pickId = String(rec.runner_id);
    base.has_pick = true;
    base.model_pick_name = nameById.get(pickId) ?? null;
    base.confidence_label = rec.confidence_label ?? null;
    base.stake = toNumberOrNull(rec.stake_amount);
    base.odds = toNumberOrNull(rec.odds);
    base.ev = toNumberOrNull(rec.ev);
    base.won = hasResult && finishById.get(pickId) === 1;
  }

  return base;
}

async function main(): Promise<void> {
  loadEnv();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }

  const args = parseGateAuditArgs(process.argv.slice(2));
  if (!args.date) {
    console.error(
      'Usage: npm run gates:audit -- --date YYYY-MM-DD [--course <name>]\n' +
        '(read-only research; writes a Markdown report under reports/, never the database).',
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

  // Runner names, finishing positions, winners + per-race counts.
  const nameById = new Map<string, string>();
  const finishById = new Map<string, number | null>();
  const countByRace = new Map<string, number>();
  const winnerByRace = new Map<string, string | null>();
  const hasResultByRace = new Map<string, boolean>();
  if (raceIds.length > 0) {
    const { data: runnerData, error: runnerError } = await supabaseAdmin
      .from(RUNNERS_TABLE)
      .select('id, race_id, horse_name, finish_pos')
      .in('race_id', raceIds);
    if (runnerError) throw new Error(`Failed to read runners: ${runnerError.message}`);
    for (const r of (runnerData ?? []) as {
      id: string | number;
      race_id: string | number;
      horse_name: string;
      finish_pos: number | string | null;
    }[]) {
      const id = String(r.id);
      const raceId = String(r.race_id);
      nameById.set(id, r.horse_name);
      const finish = toNumberOrNull(r.finish_pos);
      finishById.set(id, finish);
      countByRace.set(raceId, (countByRace.get(raceId) ?? 0) + 1);
      if (finish === 1) {
        if (!winnerByRace.has(raceId)) winnerByRace.set(raceId, r.horse_name);
        hasResultByRace.set(raceId, true);
      }
    }
  }

  const raceInputs: GateRaceInput[] = [];
  for (const race of races) {
    const raceId = String(race.id);
    try {
      raceInputs.push(
        await buildRaceInput(
          race,
          countByRace.get(raceId) ?? 0,
          nameById,
          finishById,
          winnerByRace.get(raceId) ?? null,
          hasResultByRace.get(raceId) === true,
        ),
      );
    } catch (err) {
      console.error(`  skipped race ${raceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const report: GateAuditReport = {
    date: args.date,
    course: args.course ?? null,
    generatedAt: new Date().toISOString(),
    races: raceInputs,
  };

  const markdown = renderGateAuditMarkdown(report);
  const outPath = buildGateAuditPath(args.date, args.course);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, 'utf8');

  console.log(`No-bet gate audit written (read-only DB): ${outPath}`);
  console.log(`  races: ${raceInputs.length}${wantCourse ? ` (course ~ "${args.course}")` : ''}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
