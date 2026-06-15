/**
 * Operator script: run the model for every race on a selected date (and,
 * optionally, course) — so you don't have to POST each race_id by hand.
 *
 * It reuses the SAME `runModelForRace` the cron pipeline and `run:model` use
 * (the established direct-call pattern), so model maths / staking / selection /
 * persistence are entirely unchanged — this only iterates the chosen races.
 *
 *   - DRY-RUN BY DEFAULT: lists the races that WOULD run and writes nothing.
 *   - Writes only with `--commit`.
 *   - `--date YYYY-MM-DD` selects the meeting day (required).
 *   - `--course Ascot` filters to that course (normalised — matches Royal Ascot).
 *
 * Usage:
 *   npm run model:day -- --date 2026-06-16 --course Ascot --dry-run
 *   npm run model:day -- --date 2026-06-16 --course Ascot --commit
 *
 * REQUIRES SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env.local` (or `.env`).
 * It does NOT call Betfair / the Racing API and never places a bet.
 */

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { runModelForRace } from '../src/lib/runModelForRace';
import {
  parseModelDayArgs,
  prepareMeetingRaces,
  runModelForMeetingRaces,
  summarizeModelDayOutcomes,
  formatModelDaySummary,
  type MeetingRace,
} from '../src/lib/modelDayRun';

const RACES_TABLE = 'races';
const RACE_MEETING_DATE_COLUMN = 'meeting_date';

/** Loads env from .env.local then .env (first found wins). */
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Try the next; fall back to the shell environment.
    }
  }
}

interface RaceRow {
  id: string;
  course: string | null;
  off_time: string | null;
  race_name: string | null;
}

async function main(): Promise<void> {
  const args = parseModelDayArgs(process.argv.slice(2));

  if (!args.date) {
    console.error(
      'Usage: npm run model:day -- --date YYYY-MM-DD [--course <name>] [--commit]\n' +
        '(dry run by default; pass --commit to write model runs).',
    );
    process.exitCode = 1;
    return;
  }

  loadEnv();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }

  // Select the day's races (id + course/time for filtering + display).
  const { data, error } = await supabaseAdmin
    .from(RACES_TABLE)
    .select('id, course, off_time, race_name')
    .eq(RACE_MEETING_DATE_COLUMN, args.date);
  if (error) {
    throw new Error(`races lookup failed for ${args.date}: ${error.message}`);
  }

  // Filter to the optional course (normalised) + order by off time (shared with
  // the Phase 3C pipeline via modelDayRun).
  const rows = ((data ?? []) as RaceRow[]).map((r) => ({
    id: String(r.id),
    course: r.course,
    off_time: r.off_time,
    race_name: r.race_name,
  }));
  const races = prepareMeetingRaces(rows, args.course);

  const scope = `${args.date}${args.course ? ` course~"${args.course}"` : ''}`;
  console.log(
    `Run model for race day — ${args.commit ? 'COMMIT' : 'DRY RUN'} — ${scope}\n`,
  );

  if (races.length === 0) {
    console.log('No races match the given date/course.');
    return;
  }

  // DRY RUN: list what would run, write nothing.
  if (!args.commit) {
    console.log(`${races.length} race(s) would be run:`);
    for (const r of races) {
      const time = r.off_time ? new Date(r.off_time).toISOString().slice(11, 16) : '\u2014';
      console.log(`  ${time}  ${r.course ?? '\u2014'}  ${r.race_name ?? ''}  (${r.id})`);
    }
    console.log('\n(dry run) No model runs written. Re-run with --commit to run the model.');
    return;
  }

  // COMMIT: run the model per race (shared loop), logging each outcome.
  const outcomes = await runModelForMeetingRaces(
    races,
    runModelForRace,
    (race: MeetingRace, o) => {
      if (o.status === 'run') {
        console.log(`  run     ${race.id}  scored=${o.scored} recommended=${o.recommended}`);
      } else if (o.status === 'skipped') {
        console.log(`  skipped ${race.id}  (no priced runners / market snapshot)`);
      } else {
        console.error(`  FAILED  ${race.id}  ${o.error}`);
      }
    },
  );

  const summary = summarizeModelDayOutcomes(outcomes);
  console.log('\nSummary:');
  for (const line of formatModelDaySummary(summary)) console.log(line);

  if (summary.failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
