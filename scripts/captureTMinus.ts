/**
 * CLI (READ-ONLY): generate a Markdown (+ optional JSON) T-minus-N pre-race
 * capture from stored model history. Phase 1 of the autonomous race-day workflow.
 *
 * For each race on a meeting day (optionally one course) it records the model
 * state as it stood N minutes before the off — the latest `model_runs` row with
 * `run_time <= off_time - minutes_before` — and captures the pick, market
 * favourite, alternatives, data quality, tipster state, and warnings. The
 * capture run is chosen with the same pure `selectPreOffRun` the dashboard uses
 * (with the cutoff moved to the capture target), so runs after the capture
 * target are reported but not selected, and post-off reruns are ignored.
 *
 * The per-race capture builder + race fetch live in scripts/tMinusCaptureData.ts
 * (shared, verbatim, with the T-minus lock CLI so the lock can never diverge
 * from what this report shows).
 *
 * Usage:
 *   npm run capture:t-minus -- --date 2026-06-16 --course Ascot --minutes-before 5
 *
 * Output (deterministic):
 *   reports/t-minus-5-capture-2026-06-16-ascot.md
 *   reports/t-minus-5-capture-2026-06-16-ascot.json
 *
 * STRICTLY READ-ONLY. It issues only `select` queries via the service-role
 * client; it NEVER runs the model, fetches live odds, imports results, mutates
 * the database, or reads manual notes. The only writes are the report files. It
 * loads credentials from `.env.local` / `.env` and never prints them.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  loadEnv,
  fetchMeetingRaces,
  buildRaceCapture,
} from './tMinusCaptureData';
import {
  parseTMinusCaptureArgs,
  buildTMinusCapturePath,
  buildTMinusCaptureJson,
  renderTMinusCaptureMarkdown,
  type TMinusCaptureReport,
  type TMinusRaceCapture,
} from '../src/lib/tMinusCapture';

async function main(): Promise<void> {
  loadEnv();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }

  const args = parseTMinusCaptureArgs(process.argv.slice(2));
  if (!args.date || args.minutesBefore === undefined) {
    console.error(
      'Usage: npm run capture:t-minus -- --date YYYY-MM-DD [--course <name>] [--minutes-before N]\n' +
        '(N is a positive integer, default 5; read-only; writes a Markdown + JSON report\n' +
        'under reports/, never the database).',
    );
    process.exitCode = 1;
    return;
  }
  const minutesBefore = args.minutesBefore;

  // Races for the meeting day (read-only; course-normalised; off-time sorted).
  const races = await fetchMeetingRaces(args.date, args.course ?? null);

  // Build each race capture; isolate per-race failures so one bad race can't
  // sink the whole report.
  const captures: TMinusRaceCapture[] = [];
  for (const race of races) {
    try {
      captures.push(await buildRaceCapture(race, minutesBefore));
    } catch (err) {
      console.error(
        `  skipped race ${String(race.id)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const report: TMinusCaptureReport = {
    date: args.date,
    course: args.course ?? null,
    minutes_before: minutesBefore,
    generatedAt: new Date().toISOString(),
    races: captures,
  };

  const markdown = renderTMinusCaptureMarkdown(report);
  const mdPath = buildTMinusCapturePath(args.date, minutesBefore, args.course, 'md');
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, markdown, 'utf8');

  const jsonPath = buildTMinusCapturePath(args.date, minutesBefore, args.course, 'json');
  writeFileSync(jsonPath, JSON.stringify(buildTMinusCaptureJson(report), null, 2) + '\n', 'utf8');

  console.log(`T-minus-${minutesBefore} capture written (read-only DB):`);
  console.log(`  ${mdPath}`);
  console.log(`  ${jsonPath}`);
  console.log(`  races: ${captures.length}${args.course ? ` (course ~ "${args.course}")` : ''}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
