/**
 * Shared I/O orchestration for SAME-DAY result settlement from The Racing API's
 * today endpoints, with a Basic-then-Free preference:
 *
 *   1. `/v1/results/today`       (BASIC plan) — preferred same-day source
 *   2. `/v1/results/today/free`  (FREE plan)  — fallback when Basic is unavailable
 *
 * Both are consumed through the SAME pure matching/audit pipeline in
 * `freeResultsMatch.ts` (finishing `position` only), so SP/BSP are NEVER read or
 * fabricated, writes are idempotent (existing-null finish_pos -> set; never SP/BSP),
 * a conflicting existing result blocks the race, and pending/blocked races are
 * never touched. This is the single auto-writer for today-source settlement; both
 * `scripts/autoResults.ts` (operator CLI, dry-run by default) and the results cron
 * (`liveSync.syncResults`, on a Standard-plan block for today) reuse it.
 *
 * The matching/audit/safety logic is pure and unit-tested in `freeResultsMatch.ts`;
 * this module only adds the network paging, the SELECT-only DB reads, and the
 * commit-gated finish_pos / race-status writer.
 */

import { supabaseAdmin } from './supabaseAdmin';
import {
  createRacingApiClient,
  isStandardPlanRequiredError,
  type RacingApiClient,
  type ResultFreeRace,
} from './racingApi';
import { normalizeCourse, normalizeHorseName } from './raceSync';
import {
  TODAY_BASIC_RESULTS_SOURCE_LABEL,
  TODAY_FREE_RESULTS_SOURCE_LABEL,
  type ResultSource,
} from './autoResults';
import {
  collectFreeSettlements,
  commitOpsForSettlement,
  filterFreeRacesByCourse,
  isTodayUtc,
  shouldFetchMoreFreeResults,
  FREE_RESULTS_MAX_LIMIT,
  type DbRaceLite,
  type DbRunnerLite,
  type FreeRaceSettlement,
  type PendingDbRace,
} from './freeResultsMatch';

/** Default UK + Irish region codes for The Racing API (matches the live sync). */
export const DEFAULT_RESULT_REGIONS = ['gb', 'ire'];

/** The same-day today sources, in preference order (Basic first, then Free). */
export type TodaySource = 'today_basic' | 'today_free';

/**
 * True when a failed `/v1/results` (Standard) attempt should fall back to the
 * same-day today endpoints: only when the error is the known "Standard Plan
 * required" block AND the requested date is today (the today endpoints are
 * today-only). Any OTHER error returns false so a real failure is never masked.
 * Pure.
 */
export function shouldUseTodayFallback(
  error: unknown,
  date: string,
  now: Date = new Date(),
): boolean {
  return isStandardPlanRequiredError(error) && isTodayUtc(date, now);
}

/** Picks the client method for a today source. */
function todayResultsFetcher(
  client: RacingApiClient,
  source: TodaySource,
): (params: { regionCodes: string[]; limit: number; skip: number }) => Promise<{
  results?: ResultFreeRace[] | null;
  total?: number;
}> {
  return source === 'today_basic'
    ? (params) => client.getTodayResults(params)
    : (params) => client.getTodayFreeResults(params);
}

/** Pages through a today-results endpoint (limit 100 / skip), with a hard cap. */
export async function pageTodayResults(
  client: RacingApiClient,
  regionCodes: string[],
  source: TodaySource,
): Promise<ResultFreeRace[]> {
  const fetchPage = todayResultsFetcher(client, source);
  const all: ResultFreeRace[] = [];
  const limit = FREE_RESULTS_MAX_LIMIT;
  let skip = 0;
  for (let guard = 0; guard < 100; guard++) {
    const page = await fetchPage({ regionCodes, limit, skip });
    const rows = page.results ?? [];
    all.push(...rows);
    const total = typeof page.total === 'number' ? page.total : all.length;
    if (!shouldFetchMoreFreeResults({ total, skip, returned: rows.length, limit })) break;
    skip += rows.length;
  }
  return all;
}

/** A successful today-results fetch: which source produced the rows + its label. */
export interface TodayResultsFetch {
  source: ResultSource;
  label: string;
  races: ResultFreeRace[];
}

/**
 * Fetches today's results preferring the Basic endpoint, falling back to the Free
 * endpoint only when Basic FAILS (throws — e.g. the plan lacks Basic). A
 * successful Basic response (even empty) is used as-is. Throws an aggregated error
 * only when BOTH endpoints fail, so the caller can surface a clear diagnostic /
 * the manual CSV fallback.
 */
export async function fetchTodayResultsWithFallback(
  client: RacingApiClient,
  regionCodes: string[] = DEFAULT_RESULT_REGIONS,
): Promise<TodayResultsFetch> {
  try {
    const races = await pageTodayResults(client, regionCodes, 'today_basic');
    return { source: 'today_basic', label: TODAY_BASIC_RESULTS_SOURCE_LABEL, races };
  } catch (basicErr) {
    try {
      const races = await pageTodayResults(client, regionCodes, 'today_free');
      return { source: 'today_free', label: TODAY_FREE_RESULTS_SOURCE_LABEL, races };
    } catch (freeErr) {
      const basicMsg = basicErr instanceof Error ? basicErr.message : String(basicErr);
      const freeMsg = freeErr instanceof Error ? freeErr.message : String(freeErr);
      throw new Error(
        `today results unavailable (basic: ${basicMsg}; free: ${freeMsg})`,
      );
    }
  }
}

/** SELECT-only read of the stored races (+ their runners) for the meeting day. */
export async function fetchDbRacesAndRunners(
  date: string,
  course: string | undefined,
): Promise<{ races: DbRaceLite[]; runnersByRace: Map<string, DbRunnerLite[]> }> {
  const wantCourse = course ? normalizeCourse(course) : null;
  const { data: raceData, error: raceError } = await supabaseAdmin
    .from('races')
    .select('id, course, off_time, race_name, status')
    .eq('meeting_date', date);
  if (raceError) throw new Error(`Failed to read races for ${date}: ${raceError.message}`);
  let races = (raceData ?? []) as DbRaceLite[];
  if (wantCourse) races = races.filter((r) => normalizeCourse(r.course ?? '') === wantCourse);

  const runnersByRace = new Map<string, DbRunnerLite[]>();
  if (races.length > 0) {
    const ids = races.map((r) => r.id);
    const { data: runnerData, error: runnerError } = await supabaseAdmin
      .from('runners')
      .select('id, race_id, horse_name, finish_pos')
      .in('race_id', ids);
    if (runnerError) throw new Error(`Failed to read runners: ${runnerError.message}`);
    for (const row of (runnerData ?? []) as Array<{
      id: string;
      race_id: string;
      horse_name: string | null;
      finish_pos: number | null;
    }>) {
      const list = runnersByRace.get(row.race_id) ?? [];
      list.push({ id: row.id, horse_name: row.horse_name, finish_pos: row.finish_pos });
      runnersByRace.set(row.race_id, list);
    }
  }
  return { races, runnersByRace };
}

/**
 * Writes ONLY settle-ready races to the DB: for each, applies the idempotent
 * runner finish_pos updates (existing-null -> set; NEVER SP/BSP) and marks the
 * race settled (`status='result'`, `official_result_time`) using the same schema
 * convention as the manual importer. Idempotent: a re-run finds no `update` ops
 * and (if the race is already `result`) writes nothing. Pending / blocked races
 * are NEVER touched. Returns the actual committed counts.
 */
export async function applyFreeSettlements(
  settlements: readonly FreeRaceSettlement[],
  statusById: ReadonlyMap<string, string | null>,
): Promise<{ races: number; runners: number }> {
  let races = 0;
  let runners = 0;
  const nowIso = new Date().toISOString();
  for (const s of settlements) {
    if (!s.safety.canCommit || !s.matched_db_race_id) continue; // settle-ready + matched only
    const ops = commitOpsForSettlement(s);
    for (const u of ops.updates) {
      const { error } = await supabaseAdmin
        .from('runners')
        .update({ finish_pos: u.finish_pos })
        .eq('id', u.runner_id);
      if (error) throw new Error(`runner result update failed: ${error.message}`);
      runners += 1;
    }
    // Mark settled only when something changed or the race is not already 'result'
    // (keeps a re-run a true no-op).
    const alreadyResult = (statusById.get(s.matched_db_race_id) ?? null) === 'result';
    if (ops.updates.length > 0 || !alreadyResult) {
      const { error } = await supabaseAdmin
        .from('races')
        .update({ status: 'result', official_result_time: nowIso })
        .eq('id', s.matched_db_race_id);
      if (error) throw new Error(`race status update failed: ${error.message}`);
      races += 1;
    }
  }
  return { races, runners };
}

/** The outcome of a same-day today-source settlement (dry-run or committed). */
export interface TodaySettlementResult {
  /** Which same-day endpoint produced the rows. */
  source: ResultSource;
  /** The endpoint label for that source. */
  label: string;
  /** Count of today races returned, after the optional course filter. */
  freeResultsFound: number;
  /** Per-race settlements + audits. */
  settlements: FreeRaceSettlement[];
  /** Stored races with no today result yet (left untouched). */
  pending: PendingDbRace[];
  /** Actual writes performed (0/0 unless `commit` was true). */
  committed: { races: number; runners: number };
}

/**
 * Settles today's results for a meeting from the today endpoints (Basic, then
 * Free), reusing the shared matching/audit gate. Read-only unless `commit` is
 * true, in which case it writes ONLY settle-ready races (idempotent finish_pos +
 * race status; never SP/BSP). Throws when BOTH today endpoints are unavailable so
 * the caller can fall back to the manual CSV importer / return a diagnostic.
 */
export async function settleTodayResults(params: {
  date: string;
  course?: string;
  commit: boolean;
  client?: RacingApiClient;
  regionCodes?: string[];
}): Promise<TodaySettlementResult> {
  const client = params.client ?? createRacingApiClient();
  const regions = params.regionCodes ?? DEFAULT_RESULT_REGIONS;

  const fetched = await fetchTodayResultsWithFallback(client, regions);
  const byCourse = filterFreeRacesByCourse(fetched.races, params.course, normalizeCourse);
  const { races: dbRaces, runnersByRace } = await fetchDbRacesAndRunners(params.date, params.course);
  const { settlements, pending } = collectFreeSettlements({
    freeRaces: byCourse,
    dbRaces,
    runnersByRace,
    normalizeCourse,
    normalizeHorseName,
  });

  let committed = { races: 0, runners: 0 };
  if (params.commit) {
    const statusById = new Map(dbRaces.map((r) => [r.id, r.status ?? null]));
    committed = await applyFreeSettlements(settlements, statusById);
  }

  return {
    source: fetched.source,
    label: fetched.label,
    freeResultsFound: byCourse.length,
    settlements,
    pending,
    committed,
  };
}
