/**
 * CLI (READ-ONLY): nationwide UK & Ireland audit — Nationwide rebuild
 * Phase 7A.1.
 *
 * For a meeting date it inspects EVERY stored race (all courses) and prints an
 * honest per-course operational rollup: race/runner counts, odds & model
 * coverage, diagnostic pick/no-bet counts, official T-minus-5 lock coverage
 * (time-aware not_locked_yet vs LOCK MISSING), official locked outcomes,
 * results progress, course-identity warnings, and an evidence-gate verdict.
 * It also writes a deterministic Markdown report under `reports/`.
 *
 * Usage:
 *   npm run audit:nationwide -- --date 2026-07-11 [--course <name>]
 *
 * STRICTLY SELECT-ONLY. There is NO --commit flag and no write path: it never
 * inserts/updates/upserts/deletes, never runs the model, never fetches odds,
 * racecards, or results from any provider, never creates or mutates a lock,
 * and never settles anything. The ONLY write is the local Markdown report
 * file. Credentials load from .env.local / .env and are never printed.
 * Per-race read failures are isolated (that race reports unknown coverage;
 * every other course still appears). The verdict is informational only — it
 * never enables, schedules, or invokes nationwide commit mode.
 * Decision-support only — not betting advice.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { classifyTableProbe } from '../src/lib/dbHealthSpec';
import { selectPreOffRun } from '../src/lib/modelPerformance';
import { LOCKED_DECISIONS_TABLE, OFFICIAL_MINUTES_BEFORE } from '../src/lib/lockTMinus';
import {
  LOCKED_DECISION_COLUMNS,
  toLockedDecision,
  type LockedDecision,
} from '../src/lib/lockedDecisionRead';
import { parseTMinusCaptureArgs } from '../src/lib/tMinusCapture';
import { normalizeCourse } from '../src/lib/raceSync';
import {
  buildNationwideAudit,
  buildNationwideAuditPath,
  renderNationwideAuditMarkdown,
  type NationwideAuditRaceInput,
  type NationwideAuditReport,
} from '../src/lib/nationwideAudit';

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
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

interface RaceRow {
  id: string | number;
  course: string | null;
  country: string | null;
  off_time: string | null;
  race_name: string | null;
  status: string | null;
}

/**
 * Bulk read of the date's official locked decisions, keyed by race id.
 * Fail-open: a missing table or read error yields `available: false` — lock
 * coverage is then reported UNKNOWN (never fabricated as zero or missing).
 */
async function readLockedDecisions(
  ids: readonly string[],
): Promise<{ available: boolean; byRace: Map<string, LockedDecision> }> {
  const byRace = new Map<string, LockedDecision>();
  if (ids.length === 0) return { available: true, byRace };
  const { data, error } = await supabaseAdmin
    .from(LOCKED_DECISIONS_TABLE)
    .select(`race_id, ${LOCKED_DECISION_COLUMNS}`)
    .in('race_id', ids as string[])
    .eq('minutes_before', OFFICIAL_MINUTES_BEFORE);
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

/** Reads one race's runner/odds/model coverage. SELECT-only; throws on error. */
async function buildRaceInput(
  race: RaceRow,
  locked: LockedDecision | null,
  oddsProbe: { failed: boolean },
): Promise<NationwideAuditRaceInput> {
  const raceId = String(race.id);

  // Runners: count + recorded winner (finish_pos = 1).
  const { data: runnerData, error: runnerError } = await supabaseAdmin
    .from('runners')
    .select('id, finish_pos')
    .eq('race_id', raceId);
  if (runnerError) {
    throw new Error(`runners read failed: ${runnerError.message}`);
  }
  const runners = (runnerData ?? []) as { id: string | number; finish_pos: number | string | null }[];
  const winner = runners
    .filter((r) => toNumberOrNull(r.finish_pos) === 1)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];

  // Latest odds snapshot + its priced-runner count. Fail-open to UNKNOWN.
  let hasOdds: boolean | null = null;
  let pricedRunnerCount: number | null = null;
  if (!oddsProbe.failed) {
    const { data: snapData, error: snapError } = await supabaseAdmin
      .from('market_snapshots')
      .select('id, snapshot_time')
      .eq('race_id', raceId)
      .order('snapshot_time', { ascending: false })
      .limit(1);
    if (snapError) {
      oddsProbe.failed = true; // report once; odds coverage becomes unknown
    } else {
      const snapshot = ((snapData ?? []) as { id: string | number }[])[0];
      hasOdds = snapshot !== undefined;
      if (snapshot) {
        const { data: quoteData, error: quoteError } = await supabaseAdmin
          .from('runner_quotes')
          .select('runner_id')
          .eq('snapshot_id', String(snapshot.id));
        if (quoteError) {
          oddsProbe.failed = true;
          hasOdds = null;
        } else {
          pricedRunnerCount = new Set(
            ((quoteData ?? []) as { runner_id: string | number }[]).map((q) => String(q.runner_id)),
          ).size;
        }
      } else {
        pricedRunnerCount = 0;
      }
    }
  }

  // Pre-off model run + rank-1 diagnostic recommendation (comparison only).
  const { data: runData, error: runError } = await supabaseAdmin
    .from('model_runs')
    .select('id, run_time')
    .eq('race_id', raceId)
    .order('run_time', { ascending: true });
  if (runError) {
    throw new Error(`model_runs read failed: ${runError.message}`);
  }
  const runs = ((runData ?? []) as { id: string | number; run_time: string | null }[]).map((r) => ({
    run_id: String(r.id),
    run_time: String(r.run_time),
  }));
  let hasPreOffRun: boolean | null;
  let hasDiagnosticPick: boolean | null = null;
  if (runs.length === 0) {
    hasPreOffRun = false;
  } else if (!race.off_time) {
    hasPreOffRun = null; // runs exist but pre-off cannot be evaluated
  } else {
    const chosen = selectPreOffRun(runs, race.off_time);
    hasPreOffRun = chosen !== null;
    if (chosen) {
      const { data: recData, error: recError } = await supabaseAdmin
        .from('recommendations')
        .select('runner_id')
        .eq('model_run_id', chosen.run_id)
        .eq('recommendation_rank', 1)
        .limit(1);
      if (recError) {
        throw new Error(`recommendations read failed: ${recError.message}`);
      }
      hasDiagnosticPick = ((recData ?? []) as unknown[]).length > 0;
    }
  }

  return {
    race_id: raceId,
    course_label: race.course,
    country: race.country,
    off_time: race.off_time,
    race_name: race.race_name,
    status: race.status,
    runner_count: runners.length,
    winner_runner_id: winner ? String(winner.id) : null,
    has_odds: hasOdds,
    priced_runner_count: pricedRunnerCount,
    has_pre_off_run: hasPreOffRun,
    has_diagnostic_pick: hasDiagnosticPick,
    locked,
    read_error: null,
  };
}

/** Console rendering (compact mirror of the Markdown). */
function printReport(report: NationwideAuditReport): void {
  const t = report.totals;
  const u = (v: number | null): string => (v === null ? 'unknown' : String(v));
  console.log(`\nNationwide UK & Ireland audit — ${report.date}`);
  console.log('READ ONLY\n');
  console.log(
    `Overall: courses ${t.courses} · races ${t.races} · runners ${t.runners} · ` +
      `odds ${u(t.races_with_odds)}/${t.races} · priced ${u(t.priced_runners)}/${t.runners}`,
  );
  console.log(
    `Model: pre-off runs ${u(t.races_with_pre_off_run)}/${t.races} (${t.model_coverage_pct === null ? '—' : `${t.model_coverage_pct.toFixed(1)}%`}) · ` +
      `diagnostic picks ${u(t.diagnostic_picks)} · diagnostic no-bets ${u(t.diagnostic_no_bets)}`,
  );
  console.log(
    `Locks: rows ${u(t.locked_rows)}/${t.races} (${t.lock_coverage_pct === null ? '—' : `${t.lock_coverage_pct.toFixed(1)}%`}) · ` +
      `picks ${u(t.locked_picks)} · no-bets ${u(t.locked_no_bets)} · no-run ${u(t.no_run_available)} · ` +
      `not yet ${u(t.not_locked_yet)} · MISSING ${u(t.lock_missing)}`,
  );
  console.log(
    `Results: settled ${t.settled} · pending ${t.pending} · upcoming ${t.upcoming} · ` +
      `coverage ${t.result_coverage_pct === null ? '—' : `${t.result_coverage_pct.toFixed(1)}%`}`,
  );
  console.log('\nPer course:');
  for (const c of report.courses) {
    const lock = c.lock
      ? `locks ${c.lock.locked}/${c.races} (missing ${c.lock.lock_missing}, not-yet ${c.lock.not_locked_yet})`
      : 'locks unknown';
    console.log(
      `  ${c.course}: races ${c.races} · runners ${c.runners} · odds ${u(c.races_with_odds)}/${c.races} · ` +
        `runs ${u(c.races_with_pre_off_run)}/${c.races} · ${lock} · settled ${c.settled}/${c.races}` +
        (c.official && c.official.settled_count > 0
          ? ` · official W${c.official.winners}/L${c.official.losers} no-bet ${c.official.no_bet_races}`
          : '') +
        (c.warnings.length > 0 ? ` · ⚠ ${c.warnings.length} warning(s)` : ''),
    );
  }
  if (report.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of report.warnings) console.log(`  ⚠ ${w}`);
  }
  console.log(`\nEvidence-gate verdict: ${report.verdict}`);
  for (const r of report.verdict_reasons) console.log(`  - ${r}`);
  console.log('\nThis report does not enable nationwide commit mode.');
}

async function main(): Promise<void> {
  loadEnv();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }

  const args = parseTMinusCaptureArgs(process.argv.slice(2));
  if (!args.date) {
    console.error(
      'Usage: npm run audit:nationwide -- --date YYYY-MM-DD [--course <name>]\n' +
        '(SELECT-only nationwide audit; writes a Markdown report under reports/,\n' +
        'never the database. There is no --commit flag.)',
    );
    process.exitCode = 1;
    return;
  }

  // 1. PRIMARY read: every stored race for the date (all courses). A failure
  //    here is the one genuine audit-level failure -> non-zero exit.
  const { data: raceData, error: raceError } = await supabaseAdmin
    .from('races')
    .select('id, course, country, off_time, race_name, status')
    .eq('meeting_date', args.date);
  if (raceError) {
    console.error(`FAIL: primary races query unreadable — ${raceError.message}`);
    process.exitCode = 2;
    return;
  }
  let races = (raceData ?? []) as RaceRow[];
  if (args.course) {
    const want = normalizeCourse(args.course);
    races = races.filter((r) => normalizeCourse(r.course ?? '') === want);
  }
  const ids = races.map((r) => String(r.id));

  // 2. Bulk official locks (fail-open to UNKNOWN, never fabricated).
  const lockedRead = await readLockedDecisions(ids);

  // 3. Per-race coverage reads with ISOLATED failures: one bad race reports
  //    unknown coverage; every other course still appears.
  const oddsProbe = { failed: false };
  const inputs: NationwideAuditRaceInput[] = [];
  for (const race of races) {
    const locked = lockedRead.byRace.get(String(race.id)) ?? null;
    try {
      inputs.push(await buildRaceInput(race, locked, oddsProbe));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  note: race ${String(race.id)} read failed (${message}) — isolated.`);
      inputs.push({
        race_id: String(race.id),
        course_label: race.course,
        country: race.country,
        off_time: race.off_time,
        race_name: race.race_name,
        status: race.status,
        runner_count: 0,
        winner_runner_id: null,
        has_odds: null,
        priced_runner_count: null,
        has_pre_off_run: null,
        has_diagnostic_pick: null,
        locked,
        read_error: message,
      });
    }
  }

  const globalWarnings: string[] = [];
  if (oddsProbe.failed) {
    globalWarnings.push('odds tables were partially unreadable — odds coverage shown as unknown');
  }

  const report = buildNationwideAudit({
    date: args.date,
    now: Date.now(),
    races: inputs,
    lockedTableAvailable: lockedRead.available,
    globalWarnings,
  });

  printReport(report);

  const markdown = renderNationwideAuditMarkdown(report, new Date().toISOString());
  const outPath = buildNationwideAuditPath(args.date);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, 'utf8');
  console.log(`\nMarkdown report written (read-only DB): ${outPath}`);

  if (report.verdict === 'FAIL') {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
});
