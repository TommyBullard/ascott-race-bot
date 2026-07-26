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
 *
 * OWNERSHIP (Slice 4a): on the `--commit` path only, it performs ONE read-only,
 * FAIL-CLOSED foreign-claim check for the requested date before the model loop.
 * If a live producer owns the date — or ownership cannot be verified — it
 * REFUSES before the first model operation and exits non-zero. Dry-run never
 * queries claim status. It never acquires, heartbeats, releases, or steals a
 * claim, and never repeats the status read per race.
 */

import { fileURLToPath } from 'node:url';

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
import {
  assertDirectModelClaimClear,
  formatDirectModelRefusal,
  type DirectModelClaimDecision,
} from '../src/lib/directModelClaimCheck';

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

export interface RaceRow {
  id: string;
  course: string | null;
  off_time: string | null;
  race_name: string | null;
  status: string | null;
}

/** Read-only fetch of a meeting's races. SELECT-only. */
export async function fetchRaceRows(
  date: string,
  client: { from: typeof supabaseAdmin.from } = supabaseAdmin,
): Promise<RaceRow[]> {
  const { data, error } = await client
    .from(RACES_TABLE)
    .select('id, course, off_time, race_name, status')
    .eq(RACE_MEETING_DATE_COLUMN, date);
  if (error) {
    throw new Error(`races lookup failed for ${date}: ${error.message}`);
  }
  return ((data ?? []) as RaceRow[]).map((r) => ({
    id: String(r.id),
    course: r.course,
    off_time: r.off_time,
    race_name: r.race_name,
    status: r.status,
  }));
}

type ModelDayOutcome = Awaited<ReturnType<typeof runModelForMeetingRaces>>[number];
type OnOutcome = (race: MeetingRace, outcome: ModelDayOutcome) => void;

/** Injected side effects, so the CLI flow is unit-testable without I/O. */
export interface ModelDayCliDeps {
  fetchRaces: (date: string) => Promise<RaceRow[]>;
  /** Read-only foreign-claim check (commit path only). */
  assertClaimClear: (date: string) => Promise<DirectModelClaimDecision>;
  /** Runs the shared model-day loop; injected so tests need no real model. */
  runMeeting: (races: MeetingRace[], onOutcome: OnOutcome) => Promise<ModelDayOutcome[]>;
  log: (message: string) => void;
  errorLog: (message: string) => void;
}

/**
 * The CLI flow. Order is fixed: parse -> fetch races -> (dry-run lists & stops,
 * NO claim query) -> (commit) foreign-claim check ONCE -> only if allowed, run
 * the shared model loop. Returns the process exit code; never calls
 * process.exit.
 */
export async function runModelDayCli(argv: readonly string[], deps: ModelDayCliDeps): Promise<number> {
  const args = parseModelDayArgs(argv);

  if (!args.date) {
    deps.errorLog(
      'Usage: npm run model:day -- --date YYYY-MM-DD [--course <name>] [--commit]\n' +
        '(dry run by default; pass --commit to write model runs).',
    );
    return 1;
  }

  const rows = await deps.fetchRaces(args.date);
  const races = prepareMeetingRaces(rows, args.course);

  const scope = `${args.date}${args.course ? ` course~"${args.course}"` : ''}`;
  deps.log(`Run model for race day — ${args.commit ? 'COMMIT' : 'DRY RUN'} — ${scope}\n`);

  if (races.length === 0) {
    deps.log('No races match the given date/course.');
    return 0;
  }

  // DRY RUN: list what would run, write nothing, and never query claim status.
  if (!args.commit) {
    deps.log(`${races.length} race(s) would be run:`);
    for (const r of races) {
      const time = r.off_time ? new Date(r.off_time).toISOString().slice(11, 16) : '—';
      deps.log(`  ${time}  ${r.course ?? '—'}  ${r.race_name ?? ''}  (${r.id})`);
    }
    deps.log('\n(dry run) No model runs written. Re-run with --commit to run the model.');
    return 0;
  }

  // COMMIT: one read-only, fail-closed foreign-claim check BEFORE the loop.
  const decision = await deps.assertClaimClear(args.date);
  if (!decision.allow) {
    deps.errorLog(formatDirectModelRefusal(args.date, decision));
    return 1;
  }

  // Allowed: run the model per race via the shared loop (unchanged).
  const outcomes = await deps.runMeeting(races, (race: MeetingRace, o: ModelDayOutcome) => {
    if (o.status === 'run') {
      deps.log(`  run     ${race.id}  scored=${o.scored} recommended=${o.recommended}`);
    } else if (o.status === 'skipped') {
      const why =
        o.skipReason === 'POST_OFF'
          ? 'post-off: race already started'
          : o.skipReason === 'RESULTED'
            ? 'resulted: race already settled'
            : 'no priced runners / market snapshot';
      deps.log(`  skipped ${race.id}  (${why})`);
    } else {
      deps.errorLog(`  FAILED  ${race.id}  ${o.error}`);
    }
  });

  const summary = summarizeModelDayOutcomes(outcomes);
  deps.log('\nSummary:');
  for (const line of formatModelDaySummary(summary)) deps.log(line);

  return summary.failures > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  loadEnv();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exit(1);
  }
  const exitCode = await runModelDayCli(process.argv.slice(2), {
    fetchRaces: (date) => fetchRaceRows(date),
    assertClaimClear: (date) => assertDirectModelClaimClear(date),
    runMeeting: (races, onOutcome) => runModelForMeetingRaces(races, runModelForRace, onOutcome),
    log: (message) => console.log(message),
    errorLog: (message) => console.error(message),
  });
  process.exit(exitCode);
}

// Run only when invoked directly (never when imported by a test).
const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
