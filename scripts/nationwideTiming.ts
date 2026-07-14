/**
 * CLI (READ-ONLY): nationwide dry-run TIMING harness — Nationwide rebuild
 * Phase 7A.2a.
 *
 * For a meeting date it walks EVERY stored race (all courses, unless
 * `--course` is given) SEQUENTIALLY — matching the real `pipeline:watch` /
 * `runModelForMeetingRaces` for-loop exactly, not a hypothetical parallelised
 * version — and for each race times, then runs, the SAME read + pure-score
 * path `runModelForRace` uses BEFORE it writes anything: `fetchRaceModelInputs`
 * + `fetchTipsterSelections` + `getTipsterStats` (all SELECT-only) then
 * `scoreRaceRunners` (pure, in-memory — the exact scoring core
 * `runModelForRace` calls, already reused this way, read-only, by
 * `scripts/backtest.ts`).
 *
 * DELIBERATELY DOES NOT apply the production pre-off guard
 * (`evaluateModelRunGuard`, which skips POST_OFF/RESULTED races). That guard
 * exists to protect the WRITTEN decision record from a stale post-off write;
 * this harness never writes anything, so that risk cannot occur here, and
 * skipping post-off/resulted races would make the harness useless for its
 * actual purpose — retrospective measurement against already-completed race
 * days. Every race is timed regardless of off status; the only skip is a race
 * with nothing to score (no priced field / no market snapshot).
 *
 * It NEVER calls `runModelForRace` itself, so it NEVER inserts/updates a
 * `model_runs` / `model_runner_scores` / `recommendations` row. It NEVER
 * calls `lock:t-minus` or touches `locked_race_decisions`. It NEVER settles a
 * result and NEVER places a bet. There is NO `--commit` flag anywhere in this
 * file — there is nothing to gate, because nothing here ever writes to the
 * database. The only write is the local Markdown evidence report under
 * `reports/`.
 *
 * PURPOSE: measure whether the EXISTING system can read + score every UK/IRE
 * race nationwide inside one 5-minute watcher cycle, with per-race failures
 * isolated (a thrown error is caught per race and recorded — it never aborts
 * the run). This is evidence-gathering for a future gated decision (Phase
 * 7B); it does not enable, schedule, or invoke nationwide commit mode.
 *
 * Usage:
 *   npm run timing:nationwide -- --date 2026-07-11 [--course <name>]
 *
 * Credentials load from .env.local / .env and are never printed.
 * Decision-support only — not betting advice.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import {
  fetchRaceModelInputs,
  fetchTipsterSelections,
  getTipsterStats,
} from '../src/lib/raceData';
import {
  scoreRaceRunners,
  tipsterStatsFromPriors,
} from '../src/lib/runModelForRace';
import { normalizeCourse } from '../src/lib/raceSync';
import { parseTMinusCaptureArgs } from '../src/lib/tMinusCapture';
import {
  buildNationwideTimingReport,
  buildNationwideTimingPath,
  renderNationwideTimingMarkdown,
  type NationwideTimingRaceInput,
} from '../src/lib/nationwideTiming';

/** Fixed synthetic bankroll for scoring only — does not affect timing, and
 *  keeps this harness from reading `bankroll_ledger`. Never persisted. */
const TIMING_BANKROLL = 1000;

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

interface RaceRow {
  id: string | number;
  course: string | null;
  off_time: string | null;
  race_name: string | null;
  status: string | null;
}

/** Times + reads + scores ONE race (never writes). Isolated: throws are caught by the caller. */
async function timeOneRace(raceId: string): Promise<{ durationMs: number; runnerCount: number } | null> {
  const started = performance.now();
  const inputs = await fetchRaceModelInputs(raceId);
  if (!inputs || inputs.runners.length === 0) {
    return null; // NO_PRICED_FIELD — not an error, not scored
  }
  const [selections, priors] = await Promise.all([
    fetchTipsterSelections(raceId),
    getTipsterStats(),
  ]);
  const stats = tipsterStatsFromPriors(priors);
  scoreRaceRunners(inputs, selections, stats, TIMING_BANKROLL); // pure, in-memory, no write
  const durationMs = performance.now() - started;
  return { durationMs, runnerCount: inputs.runners.length };
}

function printSummary(report: ReturnType<typeof buildNationwideTimingReport>): void {
  console.log(`\nNationwide dry-run timing evidence — ${report.date}`);
  console.log('READ ONLY — no writes to model_runs / recommendations / locked_race_decisions\n');
  console.log(
    `Races: considered ${report.races_considered} · scored ${report.races_scored} · ` +
      `skipped(no-priced-field ${report.races_skipped_no_priced_field}) · failed ${report.races_failed}`,
  );
  console.log(`Runners scored: ${report.runners_scored}`);
  if (report.duration) {
    const d = report.duration;
    console.log(
      `Timing: total ${d.total_ms.toFixed(0)}ms · mean ${d.mean_ms.toFixed(0)}ms · ` +
        `median ${d.median_ms.toFixed(0)}ms · p95 ${d.p95_ms.toFixed(0)}ms · max ${d.max_ms.toFixed(0)}ms ` +
        `(slowest: ${d.slowest_race_id})`,
    );
    console.log(
      `Watcher cadence: ${report.watcher_cadence_ms}ms · margin: ${report.margin_ms === null ? '—' : report.margin_ms.toFixed(0)}ms`,
    );
  } else {
    console.log('Timing: no races were scored — no timing data.');
  }
  if (report.failures.length > 0) {
    console.log('\nIsolated failures:');
    for (const f of report.failures) console.log(`  ⚠ ${f.race_id}: ${f.error}`);
  }
  console.log(`\nVerdict: ${report.verdict}`);
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
      'Usage: npm run timing:nationwide -- --date YYYY-MM-DD [--course <name>]\n' +
        '(SELECT-only nationwide dry-run TIMING harness; writes a Markdown evidence\n' +
        'report under reports/, never the database. There is no --commit flag.)',
    );
    process.exitCode = 1;
    return;
  }

  const { data: raceData, error: raceError } = await supabaseAdmin
    .from('races')
    .select('id, course, off_time, race_name, status')
    .eq('meeting_date', args.date);
  if (raceError) {
    console.error(`FAIL: races query unreadable — ${raceError.message}`);
    process.exitCode = 2;
    return;
  }
  let races = (raceData ?? []) as RaceRow[];
  if (args.course) {
    const want = normalizeCourse(args.course);
    races = races.filter((r) => normalizeCourse(r.course ?? '') === want);
  }

  const inputs: NationwideTimingRaceInput[] = [];
  for (const race of races) {
    const raceId = String(race.id);
    const base = { race_id: raceId, course_label: race.course, off_time: race.off_time, status: race.status };

    try {
      const result = await timeOneRace(raceId);
      if (result === null) {
        inputs.push({
          ...base,
          runner_count: 0,
          duration_ms: null,
          scored: false,
          skip_reason: 'NO_PRICED_FIELD',
          error: null,
        });
        console.log(`  skipped ${raceId}  (no priced field / no market snapshot)`);
      } else {
        inputs.push({
          ...base,
          runner_count: result.runnerCount,
          duration_ms: result.durationMs,
          scored: true,
          skip_reason: null,
          error: null,
        });
        console.log(`  scored  ${raceId}  runners=${result.runnerCount}  ${result.durationMs.toFixed(0)}ms`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      inputs.push({
        ...base,
        runner_count: 0,
        duration_ms: null,
        scored: false,
        skip_reason: null,
        error: message,
      });
      console.error(`  FAILED  ${raceId}  ${message} (isolated — continuing)`);
    }
  }

  const report = buildNationwideTimingReport(args.date, inputs);
  printSummary(report);

  const markdown = renderNationwideTimingMarkdown(report, new Date().toISOString());
  const outPath = buildNationwideTimingPath(args.date);
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
