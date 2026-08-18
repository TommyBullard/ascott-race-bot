/**
 * The current racing date, for navigation only.
 *
 * WHY THIS LIVES IN THE COMPONENT LAYER, NOT `src/lib`.
 *
 * The shell components are presentational and carry NO server-module
 * dependency — `appShellAdoption.test.ts` enforces that no `@/lib` specifier
 * may appear in `AppShell`, `AppNavigation`, `navDestinations` or
 * `UiPrimitives`. That boundary is load-bearing: `AppNavigation` is the one
 * `'use client'` component in the shell, so anything it can reach is bundled
 * for the browser. Importing the navigation helper library here to borrow one
 * predicate would ship several hundred lines of row-projection code to every
 * visitor for no benefit.
 *
 * So this module is deliberately self-contained: no imports at all. To stop
 * that independence turning into drift, `scripts/racingNavExposure.test.ts`
 * asserts this timezone equals `RACING_TIME_ZONE` in `src/lib/racingNavigation`
 * and that this validator agrees with `isCanonicalDate` across a shared corpus.
 * The two definitions are kept in step by test rather than by coupling.
 *
 * PURE. No React, no I/O, no environment access, no network, no storage, and —
 * except for the caller-supplied default — no clock read.
 */

/**
 * The civil timezone for UK & Irish racing.
 *
 * Must equal `RACING_TIME_ZONE` in `src/lib/racingNavigation.ts` (asserted).
 * Ireland keeps the same civil offset as the UK year-round, so one zone serves
 * both.
 */
export const RACING_NAV_TIME_ZONE = 'Europe/London';

/** Exact ISO calendar-date shape. Anchored and fixed-width. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strict ISO calendar-date test, mirroring `isCanonicalDate`.
 *
 * Rejects malformed input AND impossible dates, and never normalises:
 * `2026-02-30` would roll to `2026-03-02` under `Date.UTC`, so the round-trip
 * rejects it rather than accepting a different day.
 */
export function isIsoRacingDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
  );
}

/**
 * Separate fields rather than a locale format string, so the assembled value
 * cannot depend on locale ordering or separators.
 */
const RACING_DATE_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: RACING_NAV_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The CURRENT racing calendar date in {@link RACING_NAV_TIME_ZONE}, `YYYY-MM-DD`.
 *
 * "Today" for UK & Irish racing is the LONDON civil date, which is not the UTC
 * date for part of every day: at 23:30 UTC in June, London is already on the
 * next day. Reading the host clock implicitly would instead give whichever zone
 * the deployment happens to run in.
 *
 * PURE and INJECTABLE — the instant is a parameter, so tests never read the
 * real clock and the server can hand the browser the identical value. Returns
 * null for an unusable instant (Invalid Date, NaN, a non-Date) rather than
 * guessing a day; callers then render no link instead of `/date/undefined`.
 *
 * Contacts no time service, persists nothing, and does not change
 * `meeting_date` semantics — it only names the day a link should point at.
 */
export function currentRacingDate(now: Date = new Date()): string | null {
  const ms = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(ms)) return null;

  const parts = RACING_DATE_PARTS.formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const candidate = `${get('year')}-${get('month')}-${get('day')}`;

  // Validated before it can become a route segment.
  return isIsoRacingDate(candidate) ? candidate : null;
}
