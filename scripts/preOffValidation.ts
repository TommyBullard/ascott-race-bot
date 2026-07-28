/**
 * CLI (STRICTLY SELECT-ONLY): pre-off decision-support validation scorecard.
 *
 * Builds a reproducible, read-only scorecard from ALREADY-PERSISTED pre-off
 * evidence over a settled date range: probability calibration, a market
 * baseline, decision ROI/strike/no-bet, confidence bands and stored-EV honesty,
 * with an honest sample gate and a PASS / REVIEW / INSUFFICIENT_EVIDENCE
 * verdict.
 *
 * Usage:
 *   npm run validate:pre-off -- --from YYYY-MM-DD --to YYYY-MM-DD \
 *     [--course <name>] [--report] [--json]
 *
 * `--from` and `--to` are MANDATORY — there is no implicit window. Invalid input
 * (missing/malformed/impossible dates, from>to, blank course, unknown flags,
 * `--commit`) fails via the pure parser BEFORE any database, filesystem,
 * provider, or model access.
 *
 * IT NEVER runs, re-scores, or persists a model: no `scoreRaceRunners`,
 * `runModelForRace`, `refreshModelForMeeting`, or `runModelForMeetingRaces`. It
 * issues ONLY `select` queries via the service-role client, mirroring
 * `report:day`'s read pattern, and joins the FINAL PRE-OFF run
 * (`run_time <= off_time`, via `selectPreOffRun`) to stored scores /
 * recommendations / finishing positions. The ONLY writes are the optional local
 * report files (`--report` / `--json`). Credentials load from .env.local / .env
 * and are never printed. Decision-support only — no bet is placed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse } from '../src/lib/raceSync';
import { selectPreOffRun } from '../src/lib/modelPerformance';
import {
  aggregatePreOffValidation,
  buildPreOffValidationJsonPath,
  buildPreOffValidationMarkdownPath,
  parsePreOffValidationArgs,
  renderPreOffValidationConsole,
  renderPreOffValidationMarkdown,
  type ResolvedPick,
  type ResolvedPreOffRace,
  type ResolvedRunnerScore,
} from '../src/lib/preOffValidation';

const RACES_TABLE = 'races';
const RACE_MEETING_DATE_COLUMN = 'meeting_date';
const MODEL_RUNS_TABLE = 'model_runs';
const MODEL_RUNNER_SCORES_TABLE = 'model_runner_scores';
const RECOMMENDATIONS_TABLE = 'recommendations';
const RUNNERS_TABLE = 'runners';

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
}

/** Resolves one race to its selected pre-off run's stored evidence. SELECT-only. */
async function resolveRace(race: RaceRow): Promise<ResolvedPreOffRace> {
  const raceId = String(race.id);

  // Runners: recorded finishing positions (winner = finish_pos = 1).
  const { data: runnerData, error: runnerError } = await supabaseAdmin
    .from(RUNNERS_TABLE)
    .select('id, finish_pos')
    .eq('race_id', raceId);
  if (runnerError) throw new Error(`runners read failed for race ${raceId}: ${runnerError.message}`);
  const finishById = new Map<string, number | null>();
  for (const r of (runnerData ?? []) as { id: string | number; finish_pos: number | string | null }[]) {
    finishById.set(String(r.id), toNumberOrNull(r.finish_pos));
  }
  const winners = [...finishById.entries()]
    .filter(([, pos]) => pos === 1)
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));
  const winnerRunnerId = winners[0] ?? null;
  const settled = winnerRunnerId !== null;

  // All model runs for the race; select the latest PRE-OFF run.
  const { data: runData, error: runError } = await supabaseAdmin
    .from(MODEL_RUNS_TABLE)
    .select('id, run_time')
    .eq('race_id', raceId);
  if (runError) throw new Error(`model_runs read failed for race ${raceId}: ${runError.message}`);
  const runs = ((runData ?? []) as { id: string | number; run_time: string | null }[]).map((r) => ({
    run_id: String(r.id),
    run_time: String(r.run_time ?? ''),
  }));
  const chosen = selectPreOffRun(runs, race.off_time);

  const base: ResolvedPreOffRace = {
    race_id: raceId,
    course: race.course,
    off_time: race.off_time,
    has_pre_off_run: chosen !== null,
    // selectPreOffRun only ever returns a run with run_time <= off_time; the
    // aggregator re-checks this as an executable pre-off boundary invariant.
    selected_run_time: chosen ? chosen.run_time : null,
    settled,
    winner_runner_id: winnerRunnerId,
    runners: [],
    pick: null,
  };
  if (!chosen) return base;

  // The selected run's per-runner scores + its rank-1 recommendation.
  const [scoresRes, recRes] = await Promise.all([
    supabaseAdmin
      .from(MODEL_RUNNER_SCORES_TABLE)
      .select('runner_id, market_prob, model_prob')
      .eq('model_run_id', chosen.run_id),
    supabaseAdmin
      .from(RECOMMENDATIONS_TABLE)
      .select('runner_id, confidence_label, stake_amount, odds, ev')
      .eq('model_run_id', chosen.run_id)
      .eq('recommendation_rank', 1)
      .limit(1),
  ]);
  if (scoresRes.error) throw new Error(`model_runner_scores read failed for race ${raceId}: ${scoresRes.error.message}`);
  if (recRes.error) throw new Error(`recommendations read failed for race ${raceId}: ${recRes.error.message}`);

  base.runners = ((scoresRes.data ?? []) as {
    runner_id: string | number;
    market_prob: number | string | null;
    model_prob: number | string | null;
  }[]).map((s): ResolvedRunnerScore => {
    const id = String(s.runner_id);
    return {
      runner_id: id,
      model_prob: toNumberOrNull(s.model_prob),
      market_prob: toNumberOrNull(s.market_prob),
      finish_pos: finishById.get(id) ?? null,
    };
  });

  const rec = ((recRes.data ?? []) as {
    runner_id: string | number;
    confidence_label: string | null;
    stake_amount: number | string | null;
    odds: number | string | null;
    ev: number | string | null;
  }[])[0];
  if (rec) {
    const pick: ResolvedPick = {
      runner_id: String(rec.runner_id),
      odds: toNumberOrNull(rec.odds),
      stake: toNumberOrNull(rec.stake_amount),
      ev: toNumberOrNull(rec.ev),
      confidence_label: rec.confidence_label ?? null,
    };
    base.pick = pick;
  }
  return base;
}

async function main(): Promise<void> {
  // 1. Validate input FIRST — before any DB/filesystem/provider/model access.
  const parsed = parsePreOffValidationArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(
      `Error: ${parsed.error}\n\n` +
        'Usage: npm run validate:pre-off -- --from YYYY-MM-DD --to YYYY-MM-DD [--course <name>] [--report] [--json]\n' +
        '(READ-ONLY: stored evidence only. No --commit; never runs or re-scores the model.)',
    );
    process.exitCode = 1;
    return;
  }
  const { from, to, course, report, json } = parsed.args;

  loadEnv();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }

  // 2. SELECT the races in scope (inclusive date range; optional course filter).
  const { data: raceData, error: raceError } = await supabaseAdmin
    .from(RACES_TABLE)
    .select('id, off_time, course')
    .gte(RACE_MEETING_DATE_COLUMN, from)
    .lte(RACE_MEETING_DATE_COLUMN, to);
  if (raceError) {
    console.error(`FAIL: races query unreadable — ${raceError.message}`);
    process.exitCode = 2;
    return;
  }
  let races = (raceData ?? []) as RaceRow[];
  if (course) {
    const want = normalizeCourse(course);
    races = races.filter((r) => normalizeCourse(r.course ?? '') === want);
  }

  // 3. Resolve each race (per-race failures are isolated but COUNTED, so the
  //    evidence-quality verdict can reflect incompleteness — never silently zeroed).
  const resolved: ResolvedPreOffRace[] = [];
  let readErrors = 0;
  for (const race of races) {
    try {
      resolved.push(await resolveRace(race));
    } catch (err) {
      readErrors += 1;
      console.error(`  note: race ${String(race.id)} skipped (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  // 4. Aggregate + render.
  const reportObj = aggregatePreOffValidation(resolved, {
    from,
    to,
    course,
    generatedAtIso: new Date().toISOString(),
    readErrors,
  });

  if (json && !report) {
    console.log(JSON.stringify(reportObj, null, 2));
  } else {
    for (const line of renderPreOffValidationConsole(reportObj)) console.log(line);
  }

  if (report) {
    const path = buildPreOffValidationMarkdownPath(from, to, course);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderPreOffValidationMarkdown(reportObj), 'utf8');
    console.log(`\nReport written (database untouched): ${path}`);
  }
  if (json) {
    const path = buildPreOffValidationJsonPath(from, to, course);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(reportObj, null, 2)}\n`, 'utf8');
    console.log(`Machine-readable report: ${path}`);
  }

  if (reportObj.verdict === 'PASS') process.exitCode = 0;
  else if (reportObj.verdict === 'FAIL') process.exitCode = 2; // invariant violation / leakage
  else process.exitCode = 3; // REVIEW or INSUFFICIENT_EVIDENCE — not a clean pass.
}

const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  });
}
