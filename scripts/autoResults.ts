/**
 * CLI (READ-ONLY): automated result-settlement framework with safe fallback.
 * Phase 2 of the autonomous race-day workflow.
 *
 * It attempts a READ-ONLY official-results access for a date, classifies the
 * source status, and prints a clear operator summary with a strict settlement
 * safety gate. The primary source is The Racing API `/v1/results`; when that is
 * plan-blocked / unavailable it FALLS BACK (today only) to the Basic same-day
 * endpoint `/v1/results/today`, then the Free `/v1/results/today/free`, building a
 * per-race dry-run audit by matching the payload to the stored races/runners. If
 * neither yields a safe, complete result it falls back to the manual CSV importer.
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

import { createRacingApiClient, type RacingApiClient } from '../src/lib/racingApi';
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
  buildFreeResultsReport,
  renderFreeResultsSummary,
} from '../src/lib/freeResultsMatch';
import { settleTodayResults } from '../src/lib/todayResultsSettlement';

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

/** Reports a no-op commit when the today endpoints produced nothing to settle. */
function reportNothingCommitted(commit: boolean): void {
  if (commit) {
    console.error('\nNothing committed \u2014 the same-day endpoints were not available/applicable; use the manual importer.');
    process.exitCode = 1;
  }
}

/**
 * Runs the same-day today-results fallback (Basic `/v1/results/today` preferred,
 * then Free `/v1/results/today/free`) and prints the dry-run audit. Today-only.
 */
async function runTodayFallback(opts: {
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

  // The today endpoints are TODAY-only; for any other date they cannot help.
  if (!isTodayUtc(date)) {
    const report = buildFreeResultsReport({
      ...base,
      freeAttempted: false,
      freeNotApplicableReason: `the same-day endpoints only cover today (${new Date().toISOString().slice(0, 10)}); ${date} is not today`,
      freeResultsFound: 0,
      settlements: [],
      pendingDbRaces: [],
    });
    console.log(renderFreeResultsSummary(report));
    reportNothingCommitted(commit);
    return;
  }

  // Try Basic `/v1/results/today` first, then Free `/v1/results/today/free`; the
  // shared settler writes ONLY when `commit` is true (idempotent finish_pos +
  // race status; never SP/BSP). It throws only when BOTH today endpoints fail.
  let settled;
  try {
    settled = await settleTodayResults({ date, course, commit });
  } catch (error) {
    const report = buildFreeResultsReport({
      ...base,
      freeAttempted: false,
      freeNotApplicableReason: `today results unavailable (${error instanceof Error ? error.message : String(error)})`,
      freeResultsFound: 0,
      settlements: [],
      pendingDbRaces: [],
    });
    console.log(renderFreeResultsSummary(report));
    reportNothingCommitted(commit);
    return;
  }

  const report = buildFreeResultsReport({
    ...base,
    freeAttempted: true,
    freeNotApplicableReason: null,
    freeSource: settled.label,
    resultSource: settled.source,
    freeResultsFound: settled.freeResultsFound,
    settlements: settled.settlements,
    pendingDbRaces: settled.pending,
    committedRaces: commit ? settled.committed.races : undefined,
    committedRunners: commit ? settled.committed.runners : undefined,
  });
  console.log(renderFreeResultsSummary(report));

  if (commit && report.settle_ready_count === 0) {
    console.error('\nNothing committed \u2014 no race passed the safety gate (see per-race reasons above).');
    process.exitCode = 1;
  }
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

  // Fall back to the same-day today endpoints (Basic `/v1/results/today` first,
  // then Free `/v1/results/today/free`) when the primary source is plan-blocked /
  // unavailable (and we have credentials to call them).
  if (hasUser && hasKey && shouldTryFreeFallback(status)) {
    await runTodayFallback({
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
