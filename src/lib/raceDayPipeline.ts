/**
 * Pure helpers for the local race-day pipeline operator script
 * (scripts/runRaceDayPipeline.ts, Phase 3C).
 *
 * Argument parsing, URL building, the date->day mapping for racecards, and
 * summary formatting live here so they are unit-testable without a network or a
 * DB. No I/O, no secrets: a `CRON_SECRET` is only ever used by the script to set
 * an Authorization header — it is never read or formatted here.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_BASE_URL = 'http://localhost:3000';

/** Parsed CLI options for the pipeline runner. */
export interface PipelineArgs {
  /** Target meeting date (YYYY-MM-DD); undefined when missing/invalid. */
  date?: string;
  /** Optional course filter (verbatim; normalised downstream for matching). */
  course?: string;
  /** Write mode: only performs cron calls + model runs when true. */
  commit: boolean;
  /** Dry-run flag (explicit; the default is also a dry run). */
  dryRun: boolean;
  /**
   * Allow the model to run even when the odds refresh failed (stale-odds
   * override). Default false: a failed odds step skips the model run so it can't
   * re-score against stale odds.
   */
  allowStale: boolean;
  /** Base URL for the cron HTTP calls (trailing slash stripped). */
  baseUrl: string;
}

/**
 * Parses argv (already sliced past `node script`). `--date` requires a strict
 * YYYY-MM-DD value; `--base-url` defaults to http://localhost:3000 with any
 * trailing slashes stripped. Writes are gated solely on `--commit`. Pure.
 */
export function parsePipelineArgs(argv: readonly string[]): PipelineArgs {
  const args: PipelineArgs = {
    commit: false,
    dryRun: false,
    allowStale: false,
    baseUrl: DEFAULT_BASE_URL,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.commit = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--allow-stale') args.allowStale = true;
    else if (a === '--date') {
      const value = (argv[++i] ?? '').trim();
      if (DATE_RE.test(value)) args.date = value;
    } else if (a === '--course') {
      const value = (argv[++i] ?? '').trim();
      if (value !== '') args.course = value;
    } else if (a === '--base-url') {
      const value = (argv[++i] ?? '').trim();
      if (value !== '') args.baseUrl = value.replace(/\/+$/, '');
    }
  }
  return args;
}

/**
 * Maps a target meeting date to the `?day` value the racecards cron accepts.
 * The Racing API only serves racecards for today / tomorrow, so a date that is
 * neither (UTC) returns `null` — the caller then SKIPS the racecards refresh
 * (the cards may already be in the DB from an earlier run) rather than silently
 * refreshing the wrong day. Pure; `now` is injectable for tests.
 */
export function dayParamForDate(
  date: string,
  now: Date,
): 'today' | 'tomorrow' | null {
  const today = now.toISOString().slice(0, 10);
  const t = new Date(now.getTime());
  t.setUTCDate(t.getUTCDate() + 1);
  const tomorrow = t.toISOString().slice(0, 10);
  if (date === today) return 'today';
  if (date === tomorrow) return 'tomorrow';
  return null;
}

/** Builds `${baseUrl}${path}?k=v&...`, omitting null/empty params. Pure. */
export function buildUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string | undefined | null> = {},
): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
    .join('&');
  return `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
}

/** The dashboard deep link for a date (+ optional course). Pure. */
export function dashboardUrl(
  baseUrl: string,
  date: string,
  course?: string,
): string {
  return buildUrl(baseUrl, '/', { date, course });
}

/** Outcome of one HTTP cron step. */
export type CronStepStatus = 'ok' | 'failed' | 'skipped';

/**
 * Printed (and exported for tests) when the model run is skipped because the
 * odds refresh failed. The exact wording is part of the operator contract.
 */
export const ODDS_FAILED_SKIP_MESSAGE =
  'Skipping model run because odds refresh failed. Start the dev server or pass --allow-stale to override.';

/**
 * Safety gate for COMMIT mode: the model only runs when the odds refresh
 * succeeded, OR the operator explicitly passed `--allow-stale`. This prevents
 * re-scoring races against stale odds when the odds step failed (e.g. the dev
 * server was down). The racecards status is intentionally NOT consulted — a
 * failed racecards step alone is tolerated (the cards may already be in the DB)
 * as long as the odds are fresh. Pure.
 */
export function shouldRunModelAfterCron(
  oddsStatus: CronStepStatus,
  allowStale: boolean,
): boolean {
  return oddsStatus === 'ok' || allowStale;
}

/** The odds-cron counts surfaced in the pipeline summary. */
export interface OddsCounts {
  races_considered: number;
  markets_matched: number;
  snapshots_written: number;
  quotes_written: number;
}

/**
 * Reads the odds-cron response body into the summary counts, null-safely
 * (missing / non-numeric fields become 0). Never fabricates. Pure.
 */
export function readOddsCounts(body: unknown): OddsCounts {
  const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return {
    races_considered: num(o.racesConsidered),
    markets_matched: num(o.marketsMatched),
    snapshots_written: num(o.snapshotsWritten),
    quotes_written: num(o.quotesWritten),
  };
}

/** The full pipeline summary printed at the end. */
export interface PipelineSummary {
  racecards: CronStepStatus;
  odds: CronStepStatus;
  races_considered: number;
  markets_matched: number;
  snapshots_written: number;
  quotes_written: number;
  model_races_found: number;
  model_races_run: number;
  recommendations_created: number;
  no_bet_races: number;
  failures: number;
}

/**
 * Formats the summary as aligned `key: value` lines, with the dashboard URL
 * last. No secrets are ever included. Pure.
 */
export function formatPipelineSummary(
  summary: PipelineSummary,
  dashboard: string,
): string[] {
  const lines = Object.entries(summary).map(([k, v]) => `  ${k}: ${v}`);
  lines.push(`  dashboard_url: ${dashboard}`);
  return lines;
}
