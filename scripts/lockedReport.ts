/**
 * CLI (READ-ONLY): locked-decision performance report — Newmarket rebuild
 * Phase 5A.
 *
 * For a meeting day (optionally one course) it evaluates the OFFICIAL race-day
 * decisions — `locked_race_decisions` rows at `minutes_before = 5` — against
 * the stored results (`runners.finish_pos`), and compares each with the FINAL
 * PRE-OFF diagnostic pick (the legacy fallback rule). Lock-missing races stay
 * lock-missing (never backfilled, never counted as losses or no-bets); pending
 * races stay pending.
 *
 * Usage:
 *   npm run report:locked -- --date 2026-07-09 --course Newmarket [--minutes-before 5]
 *
 * STRICTLY READ-ONLY. It issues only `select` queries via the service-role
 * client; it NEVER writes the database, mutates a locked row, runs the model,
 * fetches live odds, or settles results. There is no commit flag. The only
 * write is the Markdown report file. Credentials load from `.env.local` /
 * `.env` and are never printed. Decision-support only — not betting advice.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { classifyTableProbe } from '../src/lib/dbHealthSpec';
import { selectPreOffRun } from '../src/lib/modelPerformance';
import { LOCKED_DECISIONS_TABLE } from '../src/lib/lockTMinus';
import {
  LOCKED_DECISION_COLUMNS,
  toLockedDecision,
  type LockedDecision,
} from '../src/lib/lockedDecisionRead';
import { loadEnv, fetchMeetingRaces, type RaceRow } from './tMinusCaptureData';
import {
  parseLockedReportArgs,
  buildLockedReportPath,
  buildLockedDayReport,
  renderLockedDayReportMarkdown,
  type DiagnosticPick,
  type LockedReportRaceInput,
} from '../src/lib/lockedDayReport';

/** Coerces a possibly null/string DB numeric to a number, or null. */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Bulk read of the day's official locked decisions, keyed by race id.
 * Fail-open: a missing table (pre-migration) or read error yields
 * `available: false` and an empty map — every race is then honestly reported
 * as lock_missing with a prominent report warning.
 */
async function readLockedDecisions(
  ids: readonly string[],
  minutesBefore: number,
): Promise<{ available: boolean; byRace: Map<string, LockedDecision> }> {
  const byRace = new Map<string, LockedDecision>();
  if (ids.length === 0) return { available: true, byRace };
  const { data, error } = await supabaseAdmin
    .from(LOCKED_DECISIONS_TABLE)
    .select(`race_id, ${LOCKED_DECISION_COLUMNS}`)
    .in('race_id', ids as string[])
    .eq('minutes_before', minutesBefore);
  if (error) {
    if (classifyTableProbe(error) !== 'missing') {
      console.error(`Note: locked_race_decisions read failed (${error.message}).`);
    }
    return { available: false, byRace };
  }
  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const decision = toLockedDecision(raw);
    if (decision && typeof raw.race_id !== 'undefined') {
      byRace.set(String(raw.race_id), decision);
    }
  }
  return { available: true, byRace };
}

/** Builds one race's evaluation input from stored data. Read-only. */
async function buildRaceInput(
  race: RaceRow,
  locked: LockedDecision | null,
): Promise<LockedReportRaceInput> {
  const raceId = String(race.id);

  // Runner names + finishing positions (the result source; reportDay pattern).
  const { data: runnerData, error: runnerError } = await supabaseAdmin
    .from('runners')
    .select('id, horse_name, finish_pos')
    .eq('race_id', raceId);
  if (runnerError) {
    throw new Error(`Failed to read runners for race ${raceId}: ${runnerError.message}`);
  }
  const nameById = new Map<string, string>();
  const finishById = new Map<string, number | null>();
  for (const r of (runnerData ?? []) as {
    id: string | number;
    horse_name: string;
    finish_pos: number | string | null;
  }[]) {
    nameById.set(String(r.id), r.horse_name);
    finishById.set(String(r.id), toNumberOrNull(r.finish_pos));
  }
  const winner = ((runnerData ?? []) as { id: string | number; horse_name: string; finish_pos: number | string | null }[])
    .filter((r) => toNumberOrNull(r.finish_pos) === 1)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];

  // Final pre-off diagnostic run + its rank-1 pick (fallback rule; read-only).
  const { data: runData, error: runError } = await supabaseAdmin
    .from('model_runs')
    .select('id, run_time')
    .eq('race_id', raceId)
    .order('run_time', { ascending: true });
  if (runError) {
    throw new Error(`Failed to read model runs for race ${raceId}: ${runError.message}`);
  }
  const runs = ((runData ?? []) as { id: string | number; run_time: string | null }[]).map(
    (r) => ({ run_id: String(r.id), run_time: String(r.run_time) }),
  );
  const preOffRun = race.off_time ? selectPreOffRun(runs, race.off_time) : null;

  let diagnostic: DiagnosticPick | null = null;
  if (preOffRun) {
    const { data: recData, error: recError } = await supabaseAdmin
      .from('recommendations')
      .select('runner_id, recommendation_rank, odds')
      .eq('model_run_id', preOffRun.run_id)
      .eq('recommendation_rank', 1)
      .limit(1);
    if (recError) {
      throw new Error(
        `Failed to read diagnostic recommendation for race ${raceId}: ${recError.message}`,
      );
    }
    const rec = ((recData ?? []) as {
      runner_id: string | number;
      odds: number | string | null;
    }[])[0];
    if (rec) {
      const id = String(rec.runner_id);
      diagnostic = {
        runner_id: id,
        horse_name: nameById.get(id) ?? null,
        odds: toNumberOrNull(rec.odds),
        finish_pos: finishById.get(id) ?? null,
      };
    }
  }

  return {
    race_id: raceId,
    race_name: race.race_name,
    course: race.course,
    off_time: race.off_time,
    locked,
    settled: winner !== undefined,
    winner_name: winner?.horse_name ?? null,
    locked_pick_finish: locked?.pick_runner_id
      ? (finishById.get(locked.pick_runner_id) ?? null)
      : null,
    diagnostic,
    diagnostic_run_exists: preOffRun !== null,
  };
}

async function main(): Promise<void> {
  loadEnv();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }

  const args = parseLockedReportArgs(process.argv.slice(2));
  if (!args.date || args.minutesBefore === undefined) {
    console.error(
      'Usage: npm run report:locked -- --date YYYY-MM-DD [--course <name>] [--minutes-before N]\n' +
        '(read-only locked-decision performance report; evaluates official\n' +
        'locked_race_decisions first; writes a Markdown report only, never the database).',
    );
    process.exitCode = 1;
    return;
  }
  const minutesBefore = args.minutesBefore;

  const races = await fetchMeetingRaces(args.date, args.course ?? null);
  const ids = races.map((r) => String(r.id));

  const lockedRead = await readLockedDecisions(ids, minutesBefore);

  // Per-race inputs; isolate failures so one bad race cannot sink the report.
  const inputs: LockedReportRaceInput[] = [];
  for (const race of races) {
    try {
      inputs.push(
        await buildRaceInput(race, lockedRead.byRace.get(String(race.id)) ?? null),
      );
    } catch (err) {
      console.error(
        `  skipped race ${String(race.id)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const report = buildLockedDayReport({
    date: args.date,
    course: args.course ?? null,
    minutesBefore,
    generatedAt: new Date().toISOString(),
    lockedTableAvailable: lockedRead.available,
    inputs,
  });

  const markdown = renderLockedDayReportMarkdown(report);
  const outPath = buildLockedReportPath(args.date, args.course);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, 'utf8');

  const o = report.official;
  const headline = report.races.filter(
    (r) => r.outcome_divergence === 'diagnostic_won_official_lost',
  ).length;
  console.log(`Locked-decision report written (read-only): ${outPath}`);
  console.log(
    `  coverage: ${report.coverage.locked}/${report.coverage.races} (${report.coverage.coverage_pct.toFixed(1)}%) · ` +
      `locked picks ${o.recommendations_total} (W${o.winners}/L${o.losers}, pending ${o.pending_count}) · ` +
      `no-bet ${report.locked_no_bet_count} · no-run ${report.no_run_available_count} · ` +
      `lock-missing ${report.coverage.missing} · diagnostic-won-official-lost ${headline}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
