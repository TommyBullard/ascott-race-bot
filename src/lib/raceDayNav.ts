/**
 * Pure constants + href builder for the homepage race-day navigation links.
 *
 * These are NAVIGATION ONLY: they produce in-app dashboard deep links
 * (`/?date=…&course=…`). They call no backend route, write nothing, trigger no
 * wagering actions, and carry no write-mode flag. The dashboard they link to is
 * read-only and auto-refreshes once a date/course is in the URL. Pure; no I/O.
 */

export interface RaceDayView {
  /** Meeting date, YYYY-MM-DD. */
  date: string;
  /** Course name. */
  course: string;
}

/** Today's launch view (hardcoded for the Ascot launch). */
export const TODAY_ASCOT_VIEW: RaceDayView = { date: '2026-06-19', course: 'Ascot' };

/** Yesterday's results view. */
export const YESTERDAY_ASCOT_VIEW: RaceDayView = { date: '2026-06-18', course: 'Ascot' };

/**
 * Builds the in-app dashboard deep link for a race-day view. A relative path
 * (`/?date=…&course=…`) — a normal navigation target, never an API route. Pure.
 */
export function buildRaceDayHref(view: RaceDayView): string {
  return `/?date=${encodeURIComponent(view.date)}&course=${encodeURIComponent(view.course)}`;
}

/** `/?date=2026-06-19&course=Ascot` */
export const TODAY_ASCOT_HREF = buildRaceDayHref(TODAY_ASCOT_VIEW);

/** `/?date=2026-06-18&course=Ascot` */
export const YESTERDAY_ASCOT_HREF = buildRaceDayHref(YESTERDAY_ASCOT_VIEW);

/** Primary button label. */
export const VIEW_TODAY_LABEL = "View Today's Ascot Races";

/** Secondary link label. */
export const VIEW_YESTERDAY_LABEL = "View Yesterday's Ascot Results";

/** Shown above the links when no date/course is selected (unscoped homepage). */
export const RACE_DAY_NAV_EMPTY_MESSAGE =
  'Choose a race-day view below. The dashboard is read-only and auto-refreshes once a date/course is selected.';
