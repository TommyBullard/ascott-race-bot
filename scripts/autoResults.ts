/**
 * CLI (READ-ONLY): automated result-settlement framework with safe fallback.
 * Phase 2 of the autonomous race-day workflow.
 *
 * It attempts a READ-ONLY official-results access for a date, classifies the
 * source status, and prints a clear operator summary with a strict settlement
 * safety gate. The primary source is The Racing API `/v1/results`; when that is
 * plan-blocked / unavailable it FALLS BACK to the Free-plan daily endpoint
 * `/v1/results/today/free` (today only) and builds a per-race dry-run audit by
 * matching the free payload to the stored races/runners. If neither yields a
 * safe, complete result it falls back to the existing manual CSV importer.
 *
 * DRY-RUN BY DEFAULT. This phase NEVER writes to the database: it issues only
 * SELECT reads via Supabase (to match results to stored races/runners) and never
 * mutates. Even with `--commit` it does not persist (automated match-settlement
 * is a future phase — the manual importer remains the write path). The free
 * schema carries finishing position only, so SP/BSP are left null and NEVER
 * fabricated. The safety gate refuses to commit unless every condition is clean.
 *
 * Usage:
 *   npm run results:auto -- --date 2026-06-16 --course Ascot
 *   npm run results:auto -- --date 2026-06-16 --course Ascot --commit   (future)
 *
 * SAFETY:
 *   - Read-only Racing API requests + SELECT-only Supabase reads (no mutations).
 *   - Credentials are read from the environment but NEVER printed (presence only).
 *   - Never fabricates a result or an SP/BSP; a blocked/partial/ambiguous source
 *     -> manual CSV fallback.
 *
 * Reuses the existing read-only probe classification (`categorizeResultsAccessError`)
 * and the Racing API client; the manual importer's safety standards are mirrored
 * by the pure safety gate. Requires RACING_API_USER + RACING_API_KEY for the
 * access attempt (absent -> a safe `missing_credentials` status, still no writes).
 */

import { createRacingApiClient, type RacingApiClient, type ResultFreeRace } from '../src/lib/racingApi';
import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse, normalizeHorseName } from '../src/lib/raceSync';
import {
  categorizeResultsAccessError,
  countResults,
  isValidIsoDate,
} from './probeRacingApiResultsAccess';
import {
  parseAutoResultsArgs,
  mapResultsAccessCategory,
  evaluateSettlementSafety,
  buildManualImportCommand,
  renderAutoResultsSummary,
  RESULTS_SOURCE_LABEL,
  type AutoResultsReport,
  type ResultSourceStatus,
  type SettlementAudit,
} from '../src/lib/autoResults';
import {
  shouldTryFreeFallback,
  isTodayUtc,
  filterFreeRacesByCourse,
  collectFreeSettlements,
  buildFreeResultsReport,
  renderFreeResultsSummary,
  shouldFetchMoreFreeResults,
  FREE_RESULTS_MAX_LIMIT,
  type DbRaceLite,
  type DbRunnerLite,
} from '../src/lib/freeResultsMatch';

/** Default UK + Irish region codes for The Racing API (matches the live sync). */
const DEFAULT_REGIONS = ['gb', 'ire'];

/** Loads env from `.env.local`, then `.env`; falls back to the shell env. */
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

/**
 * A source-blocked / unavailable settlement audit. Used when no official payload
 * could be obtained: nothing is fabricated, and the safety gate will refuse.
 */
function blockedAudit(status: ResultSourceStatus): SettlementAudit {
  return {
    source_status: status,
    results_official_confirmed: false,
    partial: true,
    unmatched_races: 0,
    unmatched_runners: 0,
    ambiguous_rows: 0,
    has_winner: false,
    duplicate_winner_conflict: false,
    would_overwrite_nonnull_with_null: false,
  };
}

/** Pages through the free daily results (limit 100 / skip), with a hard cap. */
async function pageAllFreeResults(
  client: RacingApiClient,
  regionCodes: string[],
): Promise<ResultFreeRace[]> {
  const all: ResultFreeRace[] = [];
  const limit = FREE_RESULTS_MAX_LIMIT;
  let skip = 0;
  for (let guard = 0; guard < 100; guard++) {
    const page = await client.getTodayFreeResults({ regionCodes, limit, skip });
    const rows = page.results ?? [];
    all.push(...rows);
    const total = typeof page.total === 'number' ? page.total : all.length;
    if (!shouldFetchMoreFreeResults({ total, skip, returned: rows.length, limit })) break;
    skip += rows.length;
  }
  return all;
}

/** SELECT-only read of the stored races (+ their runners) for the meeting day. */
async function fetchDbRacesAndRunners(
  date: string,
  course: string | undefined,
): Promise<{ races: DbRaceLite[]; runnersByRace: Map<string, DbRunnerLite[]> }> {
  const wantCourse = course ? normalizeCourse(course) : null;
  const { data: raceData, error: raceError } = await supabaseAdmin
    .from('races')
    .select('id, course, off_time, race_name')
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

/** Prints the commit decision for the free path (this phase never persists). */
function handleCommitRequest(commit: boolean, settleReady: number): void {
  if (!commit) return;
  if (settleReady === 0) {
    console.error('\nRefusing to commit — no race passed the safety gate (see per-race reasons above).');
    process.exitCode = 1;
  } else {
    console.log(
      `\nCommit gates pass for ${settleReady} race(s), but automated settlement persistence is not ` +
        'enabled in this phase; use the manual importer to write results.',
    );
  }
}

/** Runs the free daily-results fallback (today only) and prints the dry-run audit. */
async function runFreeFallback(opts: {
  date: string;
  course: string | undefined;
  commit: boolean;
  primaryStatus: ResultSourceStatus;
  primaryDetail: string | null;
}): Promise<void> {
  const { date, course, commit, primaryStatus, primaryDetail } = opts;
  const manualImportCommand = buildManualImportCommand(date, course);
  const base = {
    date,
    course: course ?? null,
    commitRequested: commit,
    primarySource: RESULTS_SOURCE_LABEL,
    primaryStatus,
    primaryDetail,
    manualImportCommand,
  };

  // The free endpoint is TODAY-only; for any other date it cannot help.
  if (!isTodayUtc(date)) {
    const report = buildFreeResultsReport({
      ...base,
      freeAttempted: false,
      freeNotApplicableReason: `the free endpoint only covers today (${new Date().toISOString().slice(0, 10)}); ${date} is not today`,
      freeResultsFound: 0,
      settlements: [],
      pendingDbRaces: [],
    });
    console.log(renderFreeResultsSummary(report));
    handleCommitRequest(commit, 0);
    return;
  }

  const client: RacingApiClient = createRacingApiClient();
  let freeRaces: ResultFreeRace[];
  try {
    const all = await pageAllFreeResults(client, DEFAULT_REGIONS);
    freeRaces = all.filter((r) => (r.date ?? '') === date); // defensive (endpoint is today-only)
  } catch (error) {
    const report = buildFreeResultsReport({
      ...base,
      freeAttempted: false,
      freeNotApplicableReason: `free results unavailable (${error instanceof Error ? error.message : String(error)})`,
      freeResultsFound: 0,
      settlements: [],
      pendingDbRaces: [],
    });
    console.log(renderFreeResultsSummary(report));
    handleCommitRequest(commit, 0);
    return;
  }

  const byCourse = filterFreeRacesByCourse(freeRaces, course, normalizeCourse);
  const { races: dbRaces, runnersByRace } = await fetchDbRacesAndRunners(date, course);
  const { settlements, pending } = collectFreeSettlements({
    freeRaces: byCourse,
    dbRaces,
    runnersByRace,
    normalizeCourse,
    normalizeHorseName,
  });

  const report = buildFreeResultsReport({
    ...base,
    freeAttempted: true,
    freeNotApplicableReason: null,
    freeResultsFound: byCourse.length,
    settlements,
    pendingDbRaces: pending,
  });
  console.log(renderFreeResultsSummary(report));
  handleCommitRequest(commit, report.settle_ready_count);
}

async function main(): Promise<void> {
  loadEnv();

  const args = parseAutoResultsArgs(process.argv.slice(2));
  if (!args.date || !isValidIsoDate(args.date)) {
    console.error(
      'Usage: npm run results:auto -- --date YYYY-MM-DD [--course <name>] [--commit]',
    );
    console.error(
      '(--date must be a valid calendar date; dry-run by default — never writes the\n' +
        'database. --commit is reserved for a future phase and is refused unless every\n' +
        'safety gate passes.)',
    );
    process.exitCode = 1;
    return;
  }
  const date = args.date;

  // Report credential PRESENCE only (booleans) — never the values themselves.
  const hasUser = (process.env.RACING_API_USER ?? '').trim() !== '';
  const hasKey = (process.env.RACING_API_KEY ?? '').trim() !== '';

  let status: ResultSourceStatus;
  let detail: string | null = null;
  let audit: SettlementAudit | null = null;

  if (!hasUser || !hasKey) {
    status = 'missing_credentials';
    detail =
      'Missing RACING_API_USER / RACING_API_KEY in .env.local (or .env); cannot ' +
      'attempt automated results — use the manual CSV importer.';
  } else {
    try {
      const client: RacingApiClient = createRacingApiClient();
      const res = await client.getResults({
        startDate: date,
        endDate: date,
        regionCodes: DEFAULT_REGIONS,
      });
      const count = countResults(res);
      status = 'available';
      // The /v1/results -> DB match-settlement is a future integration; until it
      // is enabled we treat the response as partial so the gate refuses to
      // auto-commit. (The free fallback below does the per-race dry-run audit.)
      audit = { ...blockedAudit('available'), partial: true };
      detail =
        `results endpoint returned ${count} result row(s); automated ` +
        'match-settlement is not enabled in this phase — settle via the manual importer.';
    } catch (error) {
      const info = categorizeResultsAccessError(error);
      status = mapResultsAccessCategory(info.category);
      detail = info.hint;
    }
  }

  // Fall back to the FREE daily endpoint when the primary source is plan-blocked
  // / unavailable (and we have credentials to call it).
  if (hasUser && hasKey && shouldTryFreeFallback(status)) {
    await runFreeFallback({
      date,
      course: args.course,
      commit: args.commit,
      primaryStatus: status,
      primaryDetail: detail,
    });
    return;
  }

  // Otherwise: the existing single-source summary (unchanged).
  const safetyAudit: SettlementAudit = audit ?? blockedAudit(status);
  const safety = evaluateSettlementSafety(safetyAudit);

  const report: AutoResultsReport = {
    date,
    course: args.course ?? null,
    source_attempted: RESULTS_SOURCE_LABEL,
    source_status: status,
    status_detail: detail,
    commit_requested: args.commit,
    audit,
    safety,
    fallback_required: !safety.canCommit,
    manual_import_command: buildManualImportCommand(date, args.course),
  };

  console.log(renderAutoResultsSummary(report));

  // This phase NEVER writes. --commit is gated; even when the gates pass,
  // settlement persistence is deferred to a future phase (manual import remains
  // the write path). Refuse loudly if --commit was requested but blocked.
  if (args.commit) {
    if (!safety.canCommit) {
      console.error(
        `\nRefusing to commit — ${safety.blockers.length} safety gate(s) failed (see blockers above).`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        '\nCommit gates pass, but automated settlement persistence is not enabled in this phase; ' +
          'use the manual importer to write results.',
      );
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
