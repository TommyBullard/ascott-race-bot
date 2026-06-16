/**
 * Shared single-cycle orchestration for the race-day pipeline.
 *
 * This is the ONE place that performs a single "refresh racecards + refresh odds
 * + run the day's models" cycle, so the single-run operator script
 * (scripts/runRaceDayPipeline.ts) and the watch loop
 * (scripts/runRaceDayPipelineWatch.ts) share identical behaviour — there is no
 * second copy of the orchestration to drift.
 *
 * The cycle itself (`runPipelineCommitCycle`) takes its side-effecting pieces as
 * injected dependencies (the cron HTTP caller, the races lookup, the per-race
 * model runner, and the loggers), so it is unit-testable with fakes — no network
 * or DB. The real wiring lives in the `createCallCron` / `createFetchRaceRows`
 * factories, which the scripts use. CRON_SECRET is only ever sent as a Bearer
 * header by `createCallCron`; it is never logged here.
 */

import {
  buildPipelineUrls,
  readOddsCounts,
  shouldRunModelAfterCron,
  ODDS_FAILED_SKIP_MESSAGE,
  type CronStepStatus,
  type PipelineSummary,
} from './raceDayPipeline';
import {
  prepareMeetingRaces,
  runModelForMeetingRaces,
  summarizeModelDayOutcomes,
  type MeetingRace,
  type RunOneRace,
} from './modelDayRun';
import { supabaseAdmin } from './supabaseAdmin';

const RACES_TABLE = 'races';
const RACE_MEETING_DATE_COLUMN = 'meeting_date';

/** Result of one cron HTTP call: whether it succeeded + the parsed body. */
export interface CronCallResult {
  ok: boolean;
  body: unknown;
}

/** Injected side-effecting dependencies for one pipeline cycle. */
export interface PipelineRunnerDeps {
  /** GET a cron route, returning ok + parsed JSON body. */
  callCron: (url: string) => Promise<CronCallResult>;
  /** Fetch the meeting's race rows for a date. */
  fetchRaceRows: (date: string) => Promise<MeetingRace[]>;
  /** Run the model for one race (the real `runModelForRace`, or a fake in tests). */
  runOneRace: RunOneRace;
  /** Optional stdout logger (defaults to console.log). */
  log?: (line: string) => void;
  /** Optional stderr logger (defaults to console.error). */
  errorLog?: (line: string) => void;
}

/** Inputs that vary per cycle. */
export interface PipelineRunOptions {
  date: string;
  course?: string;
  baseUrl: string;
  /** When true, run the model even if the odds refresh failed (stale override). */
  allowStale: boolean;
  /** "Now" for the date->day mapping (injectable for tests). */
  now: Date;
}

/** What one cycle produced. */
export interface PipelineRunResult {
  summary: PipelineSummary;
  dashboardUrl: string;
  racecards: CronStepStatus;
  odds: CronStepStatus;
  /** Whether the model step actually ran (false when skipped on failed odds). */
  modelRan: boolean;
}

/**
 * Runs ONE pipeline cycle: racecards refresh (when the date is today/tomorrow),
 * odds refresh, then the day's models gated on a fresh odds refresh (override
 * with `allowStale`). Prints the same per-step lines as the single-run script
 * and returns the assembled summary. Does not place bets, change model maths, or
 * print secrets. Side effects come only from the injected deps.
 */
export async function runPipelineCommitCycle(
  deps: PipelineRunnerDeps,
  opts: PipelineRunOptions,
): Promise<PipelineRunResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));
  const { racecardsUrl, oddsUrl, dashboardUrl: dashUrl } = buildPipelineUrls(
    opts.baseUrl,
    opts.date,
    opts.course,
    opts.now,
  );

  // 1. Racecards (only when the date is today/tomorrow).
  let racecards: CronStepStatus = 'skipped';
  if (racecardsUrl) {
    try {
      const { ok, body } = await deps.callCron(racecardsUrl);
      racecards = ok ? 'ok' : 'failed';
      const b = body as { tier?: string; racesInserted?: number; runnersInserted?: number } | null;
      log(
        `  racecards: ${racecards}` +
          (b ? `  (tier=${b.tier ?? '?'} racesInserted=${b.racesInserted ?? '?'} runnersInserted=${b.runnersInserted ?? '?'})` : ''),
      );
    } catch (err) {
      racecards = 'failed';
      errorLog(`  racecards: failed  ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    log(`  racecards: skipped  (${opts.date} is not today/tomorrow)`);
  }

  // 2. Odds.
  let odds: CronStepStatus = 'failed';
  let oddsCounts = readOddsCounts(null);
  try {
    const { ok, body } = await deps.callCron(oddsUrl);
    odds = ok ? 'ok' : 'failed';
    oddsCounts = readOddsCounts(body);
    log(
      `  odds:      ${odds}  (considered=${oddsCounts.races_considered} matched=${oddsCounts.markets_matched} snapshots=${oddsCounts.snapshots_written} quotes=${oddsCounts.quotes_written})`,
    );
  } catch (err) {
    odds = 'failed';
    errorLog(`  odds:      failed  ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Model (in-process) — gated on a fresh odds refresh so we never re-score
  //    against stale odds (override: allowStale). A failed racecards step alone
  //    does NOT block the model (cards may already be in the DB).
  let modelSummary = summarizeModelDayOutcomes([]);
  let modelRan = false;
  if (shouldRunModelAfterCron(odds, opts.allowStale)) {
    modelRan = true;
    const rows = await deps.fetchRaceRows(opts.date);
    const races = prepareMeetingRaces(rows, opts.course);
    log(
      `\n  model: running ${races.length} race(s)…` +
        (opts.allowStale && odds !== 'ok' ? ' (--allow-stale: odds not fresh)' : ''),
    );
    const outcomes = await runModelForMeetingRaces(
      races,
      deps.runOneRace,
      (race: MeetingRace, o) => {
        if (o.status === 'run') log(`    run     ${race.id}  scored=${o.scored} recommended=${o.recommended}`);
        else if (o.status === 'skipped')
          log(
            `    skipped ${race.id}  (${
              o.skipReason === 'POST_OFF'
                ? 'post-off: race already started'
                : o.skipReason === 'RESULTED'
                  ? 'resulted: race already settled'
                  : 'no priced runners / market snapshot'
            })`,
          );
        else errorLog(`    FAILED  ${race.id}  ${o.error}`);
      },
      opts.now,
    );
    modelSummary = summarizeModelDayOutcomes(outcomes);
  } else {
    log(`\n${ODDS_FAILED_SKIP_MESSAGE}`);
  }

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
    skipped_post_off: modelSummary.skipped_post_off,
    skipped_resulted: modelSummary.skipped_resulted,
    failures: modelSummary.failures,
  };
  return { summary, dashboardUrl: dashUrl, racecards, odds, modelRan };
}

/**
 * Builds the real cron caller: GET with the CRON_SECRET bearer (read from the
 * environment at call time; never logged). The route is "ok" only when the HTTP
 * status is ok AND the body's `ok` flag (when present) is true.
 */
export function createCallCron(): (url: string) => Promise<CronCallResult> {
  return async (url: string) => {
    const secret = process.env.CRON_SECRET;
    const headers: Record<string, string> = secret ? { Authorization: `Bearer ${secret}` } : {};
    const res = await fetch(url, { method: 'GET', headers });
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
  };
}

/** Builds the real races lookup (Supabase) for a meeting date. */
export function createFetchRaceRows(): (date: string) => Promise<MeetingRace[]> {
  return async (date: string) => {
    const { data, error } = await supabaseAdmin
      .from(RACES_TABLE)
      .select('id, course, off_time, race_name, status')
      .eq(RACE_MEETING_DATE_COLUMN, date);
    if (error) {
      throw new Error(`races lookup failed for ${date}: ${error.message}`);
    }
    const rows = (data ?? []) as {
      id: string | number;
      course: string | null;
      off_time: string | null;
      race_name: string | null;
      status: string | null;
    }[];
    return rows.map((r) => ({
      id: String(r.id),
      course: r.course,
      off_time: r.off_time,
      race_name: r.race_name,
      status: r.status,
    }));
  };
}
