/**
 * Pure helpers for the homepage race-day navigation links — course/date-aware
 * (multi-course rebuild; no course name is ever hardcoded here).
 *
 * These are NAVIGATION ONLY: they produce in-app dashboard deep links
 * (`/?day=today&course=…`, `/?date=…&course=…`, `/results-audit?…`). They call
 * no backend route, write nothing, trigger no wagering actions, and carry no
 * write-mode flag. The dashboard they link to is read-only.
 *
 * Deterministic and clock-free: "today" links use the API's own `?day=today`
 * resolution (no date is computed here), and the previous-day link is derived
 * from the SELECTED date by pure UTC arithmetic — so server and client render
 * identical hrefs (no hydration risk). Pure; no I/O.
 */

/** The dashboard's URL scope, as parsed from `?date=…&course=…`. */
export interface RaceDayScope {
  /** Selected meeting date (YYYY-MM-DD), or null. */
  date: string | null;
  /** Selected course name (verbatim), or null. */
  course: string | null;
}

/** One navigation link (a plain in-app anchor target + its wording). */
export interface RaceDayNavLink {
  href: string;
  label: string;
}

/** The full homepage nav: primary button, optional previous-day link, audit link. */
export interface RaceDayNavView {
  primary: RaceDayNavLink;
  /** Present only when a valid `date` is selected (selected date − 1 day). */
  previousDay: RaceDayNavLink | null;
  /** Deep link to /results-audit preserving the current query verbatim. */
  audit: RaceDayNavLink;
}

/** Shown above the links when no date/course is selected (unscoped homepage). */
export const RACE_DAY_NAV_EMPTY_MESSAGE =
  'Choose a race-day view below. The dashboard is read-only and auto-refreshes once a date/course is selected.';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses the {date, course} scope from a query string (leading `?` optional). Pure. */
export function parseRaceDayScope(search: string | null | undefined): RaceDayScope {
  if (!search) return { date: null, course: null };
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const date = (params.get('date') ?? '').trim();
  const course = (params.get('course') ?? '').trim();
  return {
    date: ISO_DATE_RE.test(date) ? date : null,
    course: course !== '' ? course : null,
  };
}

/**
 * The previous calendar day (UTC) for a strict YYYY-MM-DD date, or null when
 * the input is not a valid date. Pure arithmetic — no clock is read, so the
 * result is identical on server and client. Handles month/year boundaries.
 */
export function previousIsoDate(date: string): string | null {
  if (!ISO_DATE_RE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Builds an in-app dashboard deep link for an explicit date (+ optional
 * course). A relative path — a normal navigation target, never an API route.
 * Pure; inputs are URL-encoded.
 */
export function buildRaceDayHref(view: { date: string; course?: string | null }): string {
  const course = (view.course ?? '').trim();
  return course === ''
    ? `/?date=${encodeURIComponent(view.date)}`
    : `/?date=${encodeURIComponent(view.date)}&course=${encodeURIComponent(course)}`;
}

/**
 * Builds the homepage navigation from the current URL scope. Course-aware —
 * the wording names the SELECTED course only (no course is ever hardcoded):
 *
 *   - primary: "View Today's {course} Races" -> `/?day=today&course={course}`
 *     (the API resolves "today" itself, so no date is computed here); without
 *     a selected course it is the generic "View Today's Races" -> `/?day=today`.
 *   - previousDay: only when a valid date is selected — "View Previous Day
 *     {course} Results" linking the selected date − 1 (same course scope).
 *   - audit: "Prediction Audit →" -> `/results-audit{search}` (query preserved
 *     verbatim so date/course carry through).
 *
 * Pure; deterministic for a given `search` string.
 */
export function buildRaceDayNavView(search: string | null | undefined): RaceDayNavView {
  const scope = parseRaceDayScope(search);
  const course = scope.course;

  const primary: RaceDayNavLink = course
    ? {
        href: `/?day=today&course=${encodeURIComponent(course)}`,
        label: `View Today's ${course} Races`,
      }
    : { href: '/?day=today', label: "View Today's Races" };

  const prevDate = scope.date ? previousIsoDate(scope.date) : null;
  const previousDay: RaceDayNavLink | null = prevDate
    ? {
        href: buildRaceDayHref({ date: prevDate, course }),
        label: course ? `View Previous Day ${course} Results` : 'View Previous Day Results',
      }
    : null;

  const query = search && search !== '' ? (search.startsWith('?') ? search : `?${search}`) : '';
  const audit: RaceDayNavLink = {
    href: `/results-audit${query}`,
    label: 'Prediction Audit →',
  };

  return { primary, previousDay, audit };
}
