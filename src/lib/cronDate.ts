/**
 * Pure day/date resolution for the cron routes (Phase 2B).
 *
 * Turns the `?day=` / `?date=` query params into a concrete target
 * `meeting_date` (YYYY-MM-DD, UTC) that a sync job can filter races by. No I/O,
 * no mutation, deterministic given `now` — so it is trivially unit-testable and
 * shared safely across routes.
 *
 * Precedence (most-specific first):
 *   1. a valid `date` (strict YYYY-MM-DD, round-trip validated) -> that date;
 *   2. `day=tomorrow` -> tomorrow (UTC);
 *   3. otherwise (`day=today`, unset, or unrecognised) -> today (UTC).
 *
 * An invalid `date` is ignored (falls through to `day`/today) rather than
 * throwing, so the default "today" behaviour is preserved; callers surface the
 * resolved `meetingDate` + `source` so the outcome is transparent.
 */

export type CronDateSource = 'today' | 'tomorrow' | 'date';

export interface ResolvedCronDate {
  /** Target meeting date as YYYY-MM-DD (UTC). */
  meetingDate: string;
  /** How it was resolved, for logs / the response. */
  source: CronDateSource;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD (UTC) for a Date. */
function isoDateUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Validates a strict UTC calendar date: matches YYYY-MM-DD AND round-trips
 * exactly (so rolled-over values like 2026-02-30 are rejected, not silently
 * shifted).
 */
function isValidCalendarDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(ms) && isoDateUtc(new Date(ms)) === date;
}

/**
 * Resolves the target meeting date from `{ day, date }`. `date` (when valid)
 * wins over `day`; everything else defaults to today (UTC). `now` is injectable
 * for deterministic tests.
 */
export function resolveCronMeetingDate(
  params: { day?: string | null; date?: string | null },
  now: Date = new Date(),
): ResolvedCronDate {
  const date = (params.date ?? '').trim();
  if (isValidCalendarDate(date)) {
    return { meetingDate: date, source: 'date' };
  }

  const day = (params.day ?? '').trim().toLowerCase();
  if (day === 'tomorrow') {
    const t = new Date(now.getTime());
    t.setUTCDate(t.getUTCDate() + 1);
    return { meetingDate: isoDateUtc(t), source: 'tomorrow' };
  }

  return { meetingDate: isoDateUtc(now), source: 'today' };
}
