/**
 * CLI: LIVE race-day operating-plan MVP. Phase 10 of the autonomous race-day
 * workflow.
 *
 * It prints a deterministic, SAFE operating SCHEDULE + operator command plan for
 * a race day. It is PLAN-ONLY: it executes NOTHING, writes NO database, spawns no
 * child commands, and never passes a commit flag. The only optional write is the
 * Markdown plan file when `--output` is given.
 *
 * The CLI may perform a SELECT-only read of stored races (id / off_time / course
 * / race_name) to populate the per-race schedule. That lookup is best-effort: if
 * credentials are absent or the query fails, the plan still renders with the
 * "no stored races" warning rather than failing. The future modes
 * (--operate / --allow-writes / --auto-results) are documented but NOT active.
 *
 * Usage:
 *   npm run race-day:live-plan -- --date 2026-06-17 --course Ascot
 *   npm run race-day:live-plan -- --date 2026-06-16 --course Ascot --output reports/live-plan-2026-06-16-ascot.md
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse } from '../src/lib/raceSync';
import {
  parseLivePlanArgs,
  buildLivePlan,
  renderLivePlanMarkdown,
  type LivePlanRaceInput,
} from '../src/lib/raceDayLivePlan';

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
async function fetchRaces(date: string, course: string | undefined): Promise<LivePlanRaceInput[]> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Note: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping race lookup (plan still renders).');
    return [];
  }
  try {
    const { data, error } = await supabaseAdmin
      .from(RACES_TABLE)
      .select('id, off_time, course, race_name')
      .eq(RACE_MEETING_DATE_COLUMN, date);
    if (error) {
      console.error(`Note: race lookup failed (${error.message}); rendering the plan without stored races.`);
      return [];
    }
    let races = (data ?? []) as LivePlanRaceInput[];
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
  const args = parseLivePlanArgs(process.argv.slice(2));
  if (args.errors.length > 0 || !args.date) {
    console.error('race-day:live-plan — print a SAFE, plan-only live race-day operating schedule.\n');
    for (const error of args.errors) console.error(`  - ${error}`);
    console.error('\nUsage: npm run race-day:live-plan -- --date YYYY-MM-DD [--course <name>] [--output <path.md>]');
    console.error('Plan-only: nothing is executed, no database writes, no commit flag.');
    process.exitCode = 1;
    return;
  }

  loadEnv();
  const races = await fetchRaces(args.date, args.course);

  const plan = buildLivePlan({
    date: args.date,
    course: args.course,
    races,
    requestedFutureModes: args.requestedFutureModes,
  });
  const markdown = renderLivePlanMarkdown(plan);

  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, markdown, 'utf8');
    console.log(`Live race-day plan written (plan-only; nothing executed): ${args.output}`);
    console.log(`  races: ${plan.races.length}${args.course ? ` (course ~ "${args.course}")` : ''}`);
  } else {
    console.log(markdown);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
