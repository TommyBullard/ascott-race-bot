/**
 * Operator script: refresh racecards + odds and run the model for a whole race
 * day in ONE command, so you don't hand-call the cron endpoints or set
 * CRON_SECRET in the terminal.
 *
 * It loads `.env.local` (so CRON_SECRET / Supabase creds come from there), then:
 *   1. calls /api/cron/racecards (via `?day` — the Racing API only serves
 *      today/tomorrow racecards, so a date that is neither is SKIPPED here, not
 *      silently refreshed for the wrong day);
 *   2. calls /api/cron/odds?date=YYYY-MM-DD;
 *   3. runs the model for the selected date/course IN-PROCESS, reusing the same
 *      `runModelForRace` + shared `modelDayRun` helpers as `npm run model:day`.
 *
 *   - DRY-RUN BY DEFAULT: prints the URLs / operation it would run, writes nothing.
 *   - Writes only with `--commit`.
 *   - `--date YYYY-MM-DD` (required), `--course Ascot` (optional),
 *     `--base-url http://localhost:3000` (optional; default shown).
 *   - SAFETY (commit mode): if the odds refresh fails, the model run is SKIPPED
 *     by default so it can't re-score against stale odds. Pass `--allow-stale`
 *     to run the model anyway. A failed racecards step alone does NOT skip the
 *     model (the cards may already be in the DB).
 *
 * Usage:
 *   npm run pipeline:day -- --date 2026-06-16 --course Ascot --dry-run
 *   npm run pipeline:day -- --date 2026-06-16 --course Ascot --commit
 *   npm run pipeline:day -- --date 2026-06-16 --course Ascot --commit --allow-stale
 *
 * REQUIRES (commit mode): a running dev server at --base-url, plus CRON_SECRET +
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env.local`. The CRON_SECRET value
 * is NEVER printed. This script does not place bets.
 */

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { runModelForRace } from '../src/lib/runModelForRace';
import {
  prepareMeetingRaces,
  runModelForMeetingRaces,
  summarizeModelDayOutcomes,
  type MeetingRace,
} from '../src/lib/modelDayRun';
import {
  parsePipelineArgs,
  dayParamForDate,
  buildUrl,
  dashboardUrl,
  readOddsCounts,
  formatPipelineSummary,
  shouldRunModelAfterCron,
  ODDS_FAILED_SKIP_MESSAGE,
  type CronStepStatus,
  type PipelineSummary,
} from '../src/lib/raceDayPipeline';

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

/** Authorization header from CRON_SECRET (never logs the value). */
function authHeaders(): Record<string, string> {
  const secret = process.env.CRON_SECRET;
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

/** GETs a cron route; returns ok + parsed JSON body (best-effort). */
async function callCron(
  url: string,
): Promise<{ ok: boolean; body: unknown }> {
  const res = await fetch(url, { method: 'GET', headers: authHeaders() });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body; leave null.
  }
  const okFlag =
    body && typeof body === 'object' && 'ok' in (body as Record<string, unknown>)
      ? (body as { ok?: unknown }).ok === true
      : res.ok;
  return { ok: res.ok && okFlag, body };
}

async function main(): Promise<void> {
  const args = parsePipelineArgs(process.argv.slice(2));

  if (!args.date) {
    console.error(
      'Usage: npm run pipeline:day -- --date YYYY-MM-DD [--course <name>] ' +
        '[--base-url http://localhost:3000] [--commit] [--allow-stale]\n' +
        '(dry run by default; pass --commit to refresh racecards/odds and run models).',
    );
    process.exitCode = 1;
    return;
  }

  loadEnv();

  const dayParam = dayParamForDate(args.date, new Date());
  const racecardsUrl = dayParam
    ? buildUrl(args.baseUrl, '/api/cron/racecards', { day: dayParam })
    : null;
  const oddsUrl = buildUrl(args.baseUrl, '/api/cron/odds', { date: args.date });
  const dashUrl = dashboardUrl(args.baseUrl, args.date, args.course);
  const scope = `${args.date}${args.course ? ` course~"${args.course}"` : ''}`;

  console.log(
    `Race-day pipeline — ${args.commit ? 'COMMIT' : 'DRY RUN'} — ${scope}\n`,
  );

  // DRY RUN: print the plan, write nothing.
  if (!args.commit) {
    console.log('Would call:');
    console.log(
      `  racecards: ${racecardsUrl ?? `(skipped — ${args.date} is not today/tomorrow; Racing API only serves those)`}`,
    );
    console.log(`  odds:      ${oddsUrl}`);
    console.log(
      `  model:     run model in-process for ${scope} (reuses runModelForRace, like model:day)`,
    );
    console.log(`  CRON_SECRET: ${process.env.CRON_SECRET ? 'set' : 'MISSING (required for --commit)'}`);
    console.log(`\nDashboard: ${dashUrl}`);
    console.log('\n(dry run) Nothing called or written. Re-run with --commit.');
    return;
  }

  // COMMIT: validate the secrets we need (helpful messages; never printed).
  if (!process.env.CRON_SECRET) {
    console.error(
      'Missing CRON_SECRET. Add it to .env.local (it must match the value the dev ' +
        'server loaded). It is required to authenticate the /api/cron/* calls.',
    );
    process.exitCode = 1;
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }

  // 1. Racecards (only when the date is today/tomorrow).
  let racecards: CronStepStatus = 'skipped';
  if (racecardsUrl) {
    try {
      const { ok, body } = await callCron(racecardsUrl);
      racecards = ok ? 'ok' : 'failed';
      const b = body as { tier?: string; racesInserted?: number; runnersInserted?: number } | null;
      console.log(
        `  racecards: ${racecards}` +
          (b ? `  (tier=${b.tier ?? '?'} racesInserted=${b.racesInserted ?? '?'} runnersInserted=${b.runnersInserted ?? '?'})` : ''),
      );
    } catch (err) {
      racecards = 'failed';
      console.error(`  racecards: failed  ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log(`  racecards: skipped  (${args.date} is not today/tomorrow)`);
  }

  // 2. Odds.
  let odds: CronStepStatus = 'failed';
  let oddsCounts = readOddsCounts(null);
  try {
    const { ok, body } = await callCron(oddsUrl);
    odds = ok ? 'ok' : 'failed';
    oddsCounts = readOddsCounts(body);
    console.log(
      `  odds:      ${odds}  (considered=${oddsCounts.races_considered} matched=${oddsCounts.markets_matched} snapshots=${oddsCounts.snapshots_written} quotes=${oddsCounts.quotes_written})`,
    );
  } catch (err) {
    odds = 'failed';
    console.error(`  odds:      failed  ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Model (in-process; same path as model:day) — gated on a fresh odds
  //    refresh so we never re-score against stale odds (override: --allow-stale).
  //    A failed racecards step alone does NOT block the model (cards may already
  //    be in the DB); only a failed/absent odds refresh does.
  let modelSummary = summarizeModelDayOutcomes([]);
  if (shouldRunModelAfterCron(odds, args.allowStale)) {
    const { data, error } = await supabaseAdmin
      .from(RACES_TABLE)
      .select('id, course, off_time, race_name')
      .eq(RACE_MEETING_DATE_COLUMN, args.date);
    if (error) {
      throw new Error(`races lookup failed for ${args.date}: ${error.message}`);
    }
    const rows = ((data ?? []) as RaceRow[]).map((r) => ({
      id: String(r.id),
      course: r.course,
      off_time: r.off_time,
      race_name: r.race_name,
    }));
    const races = prepareMeetingRaces(rows, args.course);
    console.log(
      `\n  model: running ${races.length} race(s)…` +
        (args.allowStale && odds !== 'ok' ? ' (--allow-stale: odds not fresh)' : ''),
    );
    const outcomes = await runModelForMeetingRaces(races, runModelForRace, (race: MeetingRace, o) => {
      if (o.status === 'run') console.log(`    run     ${race.id}  scored=${o.scored} recommended=${o.recommended}`);
      else if (o.status === 'skipped') console.log(`    skipped ${race.id}  (no priced runners / market snapshot)`);
      else console.error(`    FAILED  ${race.id}  ${o.error}`);
    });
    modelSummary = summarizeModelDayOutcomes(outcomes);
  } else {
    console.log(`\n${ODDS_FAILED_SKIP_MESSAGE}`);
  }

  // Final summary.
  const summary: PipelineSummary = {
    racecards,
    odds,
    races_considered: oddsCounts.races_considered,
    markets_matched: oddsCounts.markets_matched,
    snapshots_written: oddsCounts.snapshots_written,
    quotes_written: oddsCounts.quotes_written,
    model_races_found: modelSummary.races_found,
    model_races_run: modelSummary.races_run,
    recommendations_created: modelSummary.recommendations_created,
    no_bet_races: modelSummary.no_bet_races,
    failures: modelSummary.failures,
  };
  console.log('\nSummary:');
  for (const line of formatPipelineSummary(summary, dashUrl)) console.log(line);

  if (racecards === 'failed' || odds === 'failed' || summary.failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
