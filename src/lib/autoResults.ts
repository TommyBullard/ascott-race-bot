/**
 * Pure helpers for the read-only automated result-settlement framework
 * (scripts/autoResults.ts). Phase 2 of the autonomous race-day workflow.
 *
 * This module is the SAFE DECISION layer. It classifies the official results
 * source status, evaluates a strict settlement safety gate, and renders the
 * operator summary + the manual CSV fallback instruction. It performs NO I/O —
 * no database, no network, no model maths, staking, ranking or tipster-weighting
 * change, and NO mutation — so every rule is unit-testable. Nothing is
 * fabricated: missing values stay null/blank/unknown.
 *
 * The framework's posture is fail-safe: commit is allowed ONLY when every gate
 * passes (source available, result official/confirmed, response complete, all
 * match counts clean, a single winner, and no patch that would null an existing
 * result). Anything else falls back to the existing manual CSV importer.
 */

/** How the official results source responded to a read-only access attempt. */
export type ResultSourceStatus =
  | 'available'
  | 'plan_blocked'
  | 'missing_credentials'
  | 'unauthorized'
  | 'rate_limited'
  | 'unavailable';

/** The canonical fallback status line shown when results cannot be auto-settled. */
export const FALLBACK_REQUIRED_MESSAGE =
  'automated results unavailable \u2014 manual CSV fallback required';

/** The source label reported for the official results endpoint. */
export const RESULTS_SOURCE_LABEL = 'The Racing API /v1/results';

/** The source label for the Basic-tier same-day endpoint. */
export const TODAY_BASIC_RESULTS_SOURCE_LABEL = 'The Racing API /v1/results/today';

/** The source label for the Free-tier same-day endpoint. */
export const TODAY_FREE_RESULTS_SOURCE_LABEL = 'The Racing API /v1/results/today/free';

/**
 * Which official-results endpoint produced a settlement attempt, in preference
 * order: the Standard `/v1/results` primary, then the Basic same-day
 * `/v1/results/today`, then the Free same-day `/v1/results/today/free`.
 */
export type ResultSource = 'primary_standard' | 'today_basic' | 'today_free';

/** Maps a {@link ResultSource} to its human-readable endpoint label. Pure. */
export function resultSourceLabel(source: ResultSource): string {
  switch (source) {
    case 'primary_standard':
      return RESULTS_SOURCE_LABEL;
    case 'today_basic':
      return TODAY_BASIC_RESULTS_SOURCE_LABEL;
    case 'today_free':
      return TODAY_FREE_RESULTS_SOURCE_LABEL;
  }
}

/**
 * Maps a probe error category (from `categorizeResultsAccessError`) to a source
 * status. A "standard plan required" response is the known current blocker.
 * Unknown categories map to the safe `unavailable`. Pure.
 */
export function mapResultsAccessCategory(category: string): ResultSourceStatus {
  switch (category) {
    case 'standard_plan_required':
      return 'plan_blocked';
    case 'missing_credentials':
      return 'missing_credentials';
    case 'unauthorized':
      return 'unauthorized';
    case 'rate_limited':
      return 'rate_limited';
    default:
      return 'unavailable';
  }
}

/** True only when the source is fully available. Pure. */
export function isSourceAvailable(status: ResultSourceStatus): boolean {
  return status === 'available';
}

/** True when the source is plan-blocked (the known current blocker). Pure. */
export function isPlanBlocked(status: ResultSourceStatus): boolean {
  return status === 'plan_blocked';
}

/** Slugifies a course for filenames (lower-cased, non-alphanumerics -> `-`). */
function slugifyCourse(course?: string | null): string {
  return (course ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Builds the EXACT manual fallback command to settle a race day from a CSV,
 * matching the existing importer's file convention
 * (`data/results-<date>[-<course-slug>].csv`). Pure.
 */
export function buildManualImportCommand(
  date: string,
  course?: string | null,
): string {
  const slug = slugifyCourse(course);
  const file = slug ? `data/results-${date}-${slug}.csv` : `data/results-${date}.csv`;
  return `npm run import:results -- --file ${file}`;
}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

/** Parsed CLI options for the auto-results framework. */
export interface AutoResultsArgs {
  /** Raw `--date` value (validated by the caller via `isValidIsoDate`). */
  date?: string;
  /** Optional course filter (verbatim; normalised by the caller). */
  course?: string;
  /** Whether `--commit` was requested. Default false (dry-run). */
  commit: boolean;
}

/**
 * Parses argv (already sliced past `node script`). `--date` is kept verbatim
 * (strict validation is a separate step), `--course` is trimmed, and `--commit`
 * is a boolean flag that defaults to false so the tool is dry-run by default.
 * Pure; read-only.
 */
export function parseAutoResultsArgs(argv: readonly string[]): AutoResultsArgs {
  const args: AutoResultsArgs = { commit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const value = (argv[++i] ?? '').trim();
      if (value !== '') args.date = value;
    } else if (a === '--course') {
      const value = (argv[++i] ?? '').trim();
      if (value !== '') args.course = value;
    } else if (a === '--commit') {
      args.commit = true;
    }
  }
  return args;
}

/* -------------------------------------------------------------------------- */
/* Safety gate                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The audit signals the safety gate reasons about. These mirror the manual
 * importer's safety standards (`detectRaceConflicts` / `raceHasWinner` /
 * `buildRunnerResultPatch`) plus the source-availability + confirmation status.
 */
export interface SettlementAudit {
  /** The classified source status. */
  source_status: ResultSourceStatus;
  /** Result is official / weighed-in / confirmed. */
  results_official_confirmed: boolean;
  /** Source response is partial and cannot safely settle the race. */
  partial: boolean;
  /** Races in scope that could not be matched. */
  unmatched_races: number;
  /** Runners in scope that could not be matched. */
  unmatched_runners: number;
  /** Rows that matched ambiguously (more than one candidate). */
  ambiguous_rows: number;
  /** At least one finish_pos = 1 was recorded. */
  has_winner: boolean;
  /** More than one runner marked finish_pos = 1. */
  duplicate_winner_conflict: boolean;
  /** A patch would overwrite an existing non-null result with null. */
  would_overwrite_nonnull_with_null: boolean;
  /**
   * An existing non-null finish_pos (or the existing winner) conflicts with the
   * incoming result. Optional so non-free sources that cannot conflict omit it.
   */
  existing_result_conflict?: boolean;
}

/** The safety-gate verdict: whether commit is allowed, plus every blocker. */
export interface SettlementSafety {
  canCommit: boolean;
  blockers: string[];
}

/**
 * The single safety-gate decision. Commit is allowed ONLY when the source is
 * available, the result is official/confirmed, the response is complete, every
 * match count is clean, a winner exists, there is no duplicate-winner conflict,
 * and no patch would null an existing result. Each failed condition is reported
 * as a human-readable blocker, in a fixed order for determinism. Pure; never
 * throws; never mutates.
 */
export function evaluateSettlementSafety(
  audit: SettlementAudit,
): SettlementSafety {
  const blockers: string[] = [];

  if (audit.source_status !== 'available') {
    blockers.push(`result source is ${audit.source_status} (not available)`);
  }
  if (!audit.results_official_confirmed) {
    blockers.push('result is not official/weighed-in/confirmed');
  }
  if (audit.partial) {
    blockers.push('source response is partial and cannot safely settle the race');
  }
  if (audit.unmatched_races > 0) {
    blockers.push(`unmatched_races > 0 (${audit.unmatched_races})`);
  }
  if (audit.unmatched_runners > 0) {
    blockers.push(`unmatched_runners > 0 (${audit.unmatched_runners})`);
  }
  if (audit.ambiguous_rows > 0) {
    blockers.push(`ambiguous_rows > 0 (${audit.ambiguous_rows})`);
  }
  if (!audit.has_winner) {
    blockers.push('no winner (no finish_pos = 1 recorded)');
  }
  if (audit.duplicate_winner_conflict) {
    blockers.push('duplicate winner conflict (more than one finish_pos = 1)');
  }
  if (audit.would_overwrite_nonnull_with_null) {
    blockers.push('attempting to overwrite a non-null result with null');
  }
  if (audit.existing_result_conflict) {
    blockers.push('existing result conflicts with the incoming result (finish_pos / winner mismatch)');
  }

  return { canCommit: blockers.length === 0, blockers };
}

/* -------------------------------------------------------------------------- */
/* Operator summary rendering                                                 */
/* -------------------------------------------------------------------------- */

/** The full operator report for one auto-results attempt. */
export interface AutoResultsReport {
  date: string;
  course: string | null;
  /** Human label of the source attempted (e.g. the Racing API results endpoint). */
  source_attempted: string;
  source_status: ResultSourceStatus;
  /** A short, secret-free status hint, or null. */
  status_detail: string | null;
  /** Whether `--commit` was requested (the tool still never writes here). */
  commit_requested: boolean;
  /** The dry-run audit, or null when no official payload produced one. */
  audit: SettlementAudit | null;
  /** The safety-gate verdict. */
  safety: SettlementSafety;
  /** Whether the operator must fall back to the manual CSV importer. */
  fallback_required: boolean;
  /** The exact manual fallback command. */
  manual_import_command: string;
}

/**
 * Renders the deterministic operator summary: date/course, the source attempted
 * and its status, the dry-run audit (or a clear em-dash when none), the commit
 * decision with blockers, and — when settlement is unsafe — the canonical
 * fallback message plus the exact manual import command. Pure; no I/O.
 */
export function renderAutoResultsSummary(report: AutoResultsReport): string {
  const lines: string[] = [];

  lines.push(
    `Automated result settlement \u2014 ${report.commit_requested ? 'COMMIT REQUESTED' : 'DRY RUN'}`,
  );
  lines.push(`  date: ${report.date}`);
  lines.push(`  course: ${report.course ?? 'All'}`);
  lines.push(`  result source attempted: ${report.source_attempted}`);
  lines.push(`  source status: ${report.source_status}`);
  if (report.status_detail) {
    lines.push(`  detail: ${report.status_detail}`);
  }

  if (report.audit) {
    lines.push('  dry-run audit:');
    lines.push(`    results_official_confirmed: ${report.audit.results_official_confirmed}`);
    lines.push(`    partial: ${report.audit.partial}`);
    lines.push(`    unmatched_races: ${report.audit.unmatched_races}`);
    lines.push(`    unmatched_runners: ${report.audit.unmatched_runners}`);
    lines.push(`    ambiguous_rows: ${report.audit.ambiguous_rows}`);
    lines.push(`    has_winner: ${report.audit.has_winner}`);
    lines.push(`    duplicate_winner_conflict: ${report.audit.duplicate_winner_conflict}`);
  } else {
    lines.push('  dry-run audit: \u2014 (no official result payload available)');
  }

  lines.push(`  commit allowed: ${report.safety.canCommit ? 'yes' : 'no'}`);
  if (report.safety.blockers.length > 0) {
    lines.push('  commit blockers:');
    for (const blocker of report.safety.blockers) {
      lines.push(`    - ${blocker}`);
    }
  }

  if (report.fallback_required) {
    lines.push(`  ${FALLBACK_REQUIRED_MESSAGE}`);
    lines.push(`  manual fallback: ${report.manual_import_command}`);
  }

  return lines.join('\n');
}
