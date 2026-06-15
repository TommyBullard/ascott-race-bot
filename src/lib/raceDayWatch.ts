/**
 * Pure helpers for the race-day pipeline WATCH command
 * (scripts/runRaceDayPipelineWatch.ts, Phase 3D).
 *
 * Argument parsing, interval / until-time validation, the stop decision, and
 * per-cycle summary formatting live here so they are unit-testable without
 * timers, network, or a DB. No I/O, no secrets.
 */

import {
  parsePipelineArgs,
  type PipelineArgs,
  type PipelineSummary,
} from './raceDayPipeline';

/** Default minutes between cycles when --interval-minutes is omitted. */
export const DEFAULT_INTERVAL_MINUTES = 5;

/** Parsed CLI options for the watch runner (extends the single-run options). */
export interface WatchArgs extends PipelineArgs {
  /**
   * Minutes between cycles. `null` means the flag was supplied but invalid
   * (non-numeric or <= 0) — the script then fails with a helpful message.
   */
  intervalMinutes: number | null;
  /** Raw `--until HH:MM` local stop time (validity checked via parseUntilTime). */
  until?: string;
  /**
   * Optional cycle cap (for testing). `undefined` = not supplied; `null` =
   * supplied but invalid (not a positive integer).
   */
  maxCycles?: number | null;
}

/** A local clock time (24h). */
export interface TimeOfDay {
  hours: number;
  minutes: number;
}

const UNTIL_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function parsePositiveNumber(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parsePositiveInteger(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Parses watch argv. Reuses `parsePipelineArgs` for the shared flags
 * (--date/--course/--commit/--dry-run/--allow-stale/--base-url) and adds
 * --interval-minutes (default 5), --until HH:MM, and --max-cycles. Pure.
 */
export function parseWatchArgs(argv: readonly string[]): WatchArgs {
  const base = parsePipelineArgs(argv);
  let intervalMinutes: number | null = DEFAULT_INTERVAL_MINUTES;
  let until: string | undefined;
  let maxCycles: number | null | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--interval-minutes') {
      intervalMinutes = parsePositiveNumber((argv[++i] ?? '').trim());
    } else if (a === '--until') {
      const value = (argv[++i] ?? '').trim();
      until = value === '' ? undefined : value;
    } else if (a === '--max-cycles') {
      maxCycles = parsePositiveInteger((argv[++i] ?? '').trim());
    }
  }
  return { ...base, intervalMinutes, until, maxCycles };
}

/**
 * Parses a `HH:MM` local stop time, returning null when malformed. Accepts
 * 00:00–23:59 (hours 0–23, minutes always two digits 00–59). Pure.
 */
export function parseUntilTime(value: string): TimeOfDay | null {
  const m = UNTIL_RE.exec(value.trim());
  if (!m) return null;
  return { hours: Number(m[1]), minutes: Number(m[2]) };
}

/** True when `now`'s local clock time has reached/passed `until`. Pure. */
export function isUntilReached(until: TimeOfDay, now: Date): boolean {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const untilMinutes = until.hours * 60 + until.minutes;
  return nowMinutes >= untilMinutes;
}

/**
 * The stop decision evaluated before each cycle (and after each completes).
 * Returns a human-readable reason string when the watch should stop, else null.
 * `--max-cycles` is checked first, then `--until`. Pure.
 */
export function shouldStopWatching(
  completedCycles: number,
  maxCycles: number | null | undefined,
  until: TimeOfDay | null,
  now: Date,
): string | null {
  if (maxCycles != null && completedCycles >= maxCycles) return 'max-cycles reached';
  if (until && isUntilReached(until, now)) return 'until time reached';
  return null;
}

/** One completed cycle's record, for formatting. */
export interface CycleRecord {
  cycle: number;
  startedAt: string;
  completedAt: string;
  summary: PipelineSummary;
  dashboardUrl: string;
}

/**
 * Formats one cycle's summary as aligned `key: value` lines: cycle number,
 * start/complete timestamps, the cron + model counts, and the dashboard URL
 * last. No secrets. Pure.
 */
export function formatCycleSummary(record: CycleRecord): string[] {
  const { summary } = record;
  return [
    `  cycle: ${record.cycle}`,
    `  started_at: ${record.startedAt}`,
    `  completed_at: ${record.completedAt}`,
    `  racecards: ${summary.racecards}`,
    `  odds: ${summary.odds}`,
    `  models_run: ${summary.model_races_run}`,
    `  recommendations_created: ${summary.recommendations_created}`,
    `  no_bet_races: ${summary.no_bet_races}`,
    `  failures: ${summary.failures}`,
    `  dashboard_url: ${record.dashboardUrl}`,
  ];
}
