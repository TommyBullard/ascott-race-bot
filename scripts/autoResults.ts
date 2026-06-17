/**
 * CLI (READ-ONLY): automated result-settlement framework with safe fallback.
 * Phase 2 of the autonomous race-day workflow.
 *
 * It attempts a single READ-ONLY official-results access (The Racing API
 * `/v1/results`) for a date, classifies the source status, and prints a clear
 * operator summary with a strict settlement safety gate. If the source is
 * plan-blocked / unavailable (the current known blocker is the Standard-plan
 * requirement), it falls back cleanly to the existing manual CSV importer.
 *
 * DRY-RUN BY DEFAULT. This phase NEVER writes to the database: it issues no
 * Supabase calls at all, and even with `--commit` it does not persist (automated
 * match-settlement is a future phase — the manual importer remains the write
 * path). The safety gate refuses to commit unless every condition is clean.
 *
 * Usage:
 *   npm run results:auto -- --date 2026-06-16 --course Ascot
 *   npm run results:auto -- --date 2026-06-16 --course Ascot --commit   (future)
 *
 * SAFETY:
 *   - One read-only Racing API request (no Supabase access, no mutations).
 *   - Credentials are read from the environment but NEVER printed (presence only).
 *   - Never fabricates a result; a blocked/partial source -> manual CSV fallback.
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
      // Phase 2 delivers the SAFE FRAMEWORK + fallback. The automated
      // payload -> DB match-settlement (validate/match exactly like the manual
      // importer) is the future integration point; until it is enabled we never
      // claim an official, fully-matched settlement, so the response is treated
      // as partial and the safety gate refuses to auto-commit. No fabrication.
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
