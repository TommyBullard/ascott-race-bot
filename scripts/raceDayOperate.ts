/**
 * CLI: CONTROLLED race-day operator MVP.
 *
 * It prints a deterministic, SAFE operating PLAN + next-action for a race day. It
 * is PLAN-ONLY: it executes NOTHING, writes NO database (and writes no files),
 * spawns no child commands, and never passes a commit flag of its own. It prints
 * the plan to stdout.
 *
 * The CLI may perform a SELECT-only read of stored races (id / off_time / course
 * / race_name / status) to populate the per-race schedule + the next action.
 * That lookup is best-effort: if credentials are absent or the query fails, the
 * plan still renders with the "no stored races" warning rather than failing. The
 * future flags (--allow-pipeline-writes / --allow-result-commit /
 * --run-once-readonly / --watch / --minutes-before / --stop-after-race) are
 * documented but NOT active.
 *
 * Usage:
 *   npm run race-day:operate -- --date 2026-06-17 --course Ascot
 */

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse } from '../src/lib/raceSync';
import {
  parseOperateArgs,
  buildOperatePlan,
  renderOperatePlanMarkdown,
  type OperateRaceInput,
} from '../src/lib/raceDayOperate';

const RACES_TABLE = 'races';
const RACE_MEETING_DATE_COLUMN = 'meeting_date';

/** Loads env from `.env.local`, then `.env`; falls back to the shell env. */
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Not present; try the next, then fall back to the shell env.
    }
  }
}

/**
 * SELECT-only, best-effort read of stored races for the date (optionally one
 * course). Returns [] (and logs a note) if credentials are missing or the query
 * fails — the plan still renders with the no-races warning. Never writes.
 */
async function fetchRaces(date: string, course: string | undefined): Promise<OperateRaceInput[]> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Note: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping race lookup (plan still renders).');
    return [];
  }
  try {
    const { data, error } = await supabaseAdmin
      .from(RACES_TABLE)
      .select('id, off_time, course, race_name, status')
      .eq(RACE_MEETING_DATE_COLUMN, date);
    if (error) {
      console.error(`Note: race lookup failed (${error.message}); rendering the plan without stored races.`);
      return [];
    }
    let races = (data ?? []) as OperateRaceInput[];
    if (course) {
      const want = normalizeCourse(course);
      races = races.filter((r) => normalizeCourse(r.course ?? '') === want);
    }
    return races;
  } catch (err) {
    console.error(`Note: race lookup error (${err instanceof Error ? err.message : String(err)}); rendering the plan without stored races.`);
    return [];
  }
}

async function main(): Promise<void> {
  const args = parseOperateArgs(process.argv.slice(2));
  if (args.errors.length > 0 || !args.date) {
    console.error('race-day:operate — print a SAFE, plan-only controlled race-day operating plan.\n');
    for (const error of args.errors) console.error(`  - ${error}`);
    console.error('\nUsage: npm run race-day:operate -- --date YYYY-MM-DD [--course <name>]');
    console.error('Plan-only: nothing is executed, no database writes, no orders, no commit flag.');
    process.exitCode = 1;
    return;
  }

  loadEnv();
  const races = await fetchRaces(args.date, args.course);

  const plan = buildOperatePlan({
    date: args.date,
    course: args.course,
    races,
    now: Date.now(),
    requestedFutureFlags: args.requestedFutureFlags,
  });

  console.log(renderOperatePlanMarkdown(plan));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
