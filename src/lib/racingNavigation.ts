/**
 * Pure helpers for canonical racing navigation (/date, /meeting, /race).
 *
 * CANONICAL IDENTITY ONLY. Every route handle here comes from a STORED column
 * — `races.meeting_date`, `races.course_key`, `races.race_slug`. Nothing in
 * this module derives, recomputes or repairs a handle: `courseKey()` and
 * `raceSlug()` in `raceSync.ts` remain the only producers, and they run at
 * ingestion time. A row that never stored a handle is simply not linkable
 * (see {@link canonicalRaceHref}), which is what keeps the 719 historical
 * pre-Programme-0 rows out of the canonical URL space without mutating them.
 *
 * PURE. No React, no Supabase, no environment access, no I/O and no clock
 * reads. Deterministic: the same inputs always produce the same output, on the
 * server and in a test.
 *
 * Decision-support only. Nothing here places, recommends or settles a bet.
 */

/* -------------------------------------------------------------------------- */
/* Route parameter validation — every value is UNTRUSTED input                */
/* -------------------------------------------------------------------------- */

/** Exact ISO calendar date shape. Deliberately anchored and fixed-width. */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Route-handle charset. `courseKey()` lower-cases, strips punctuation to
 * spaces and hyphenates, and `raceSlug()` emits `HHMM-slugified-name`, so both
 * stored handles live in `[a-z0-9-]`. Anything else is not a handle this
 * application ever wrote, so it can only be a probe or a typo.
 */
export const ROUTE_HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Upper bound on a handle segment, so a pathological URL is cheap to reject. */
export const MAX_HANDLE_LENGTH = 120;

/**
 * Strict ISO calendar-date test.
 *
 * Rejects malformed input AND impossible dates, and — importantly — NEVER
 * normalises: `2026-02-30` would roll to `2026-03-02` under `Date.UTC`, so the
 * round-trip below rejects it rather than silently answering for a different
 * day. Two-digit years fall to the same round-trip, since `Date.UTC(26, …)`
 * means 1926, so `0026-01-01` cannot resolve either.
 */
export function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

/** Strict stored-handle test for `course_key` / `race_slug` route segments. */
export function isCanonicalHandle(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_HANDLE_LENGTH &&
    ROUTE_HANDLE_PATTERN.test(value)
  );
}

/**
 * Decodes one raw route segment.
 *
 * Next already percent-decodes params, but a malformed sequence can still
 * arrive (or a double-encoded one), and `decodeURIComponent` THROWS on those.
 * Returning null instead keeps a bad URL a 404 rather than a server error.
 */
export function decodeRouteSegment(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Date arithmetic — pure, UTC, no clock                                      */
/* -------------------------------------------------------------------------- */

const DAY_MS = 86_400_000;

function shiftIsoDate(date: string, days: number): string | null {
  if (!isCanonicalDate(date)) return null;
  const ms = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/** The calendar day before `date`, or null when `date` is not canonical. */
export function previousMeetingDate(date: string): string | null {
  return shiftIsoDate(date, -1);
}

/** The calendar day after `date`, or null when `date` is not canonical. */
export function nextMeetingDate(date: string): string | null {
  return shiftIsoDate(date, 1);
}

/* -------------------------------------------------------------------------- */
/* Canonical hrefs — stored handles only, never a UUID                        */
/* -------------------------------------------------------------------------- */

/** The date page for a canonical meeting date. */
export function canonicalDateHref(date: string | null | undefined): string | null {
  return isCanonicalDate(date) ? `/date/${date}` : null;
}

/** The meeting page, or null when either handle is absent or unusable. */
export function canonicalMeetingHref(
  date: string | null | undefined,
  courseKey: string | null | undefined,
): string | null {
  if (!isCanonicalDate(date) || !isCanonicalHandle(courseKey)) return null;
  return `/date/${date}/meeting/${courseKey}`;
}

/**
 * The race page, or null when ANY handle is absent.
 *
 * Null is the historical-row path: a pre-Programme-0 race carries
 * `course_key = null` and `race_slug = null`, so it yields no href and the UI
 * renders it as plain text. No handle is ever invented to fill the gap.
 */
export function canonicalRaceHref(
  date: string | null | undefined,
  courseKey: string | null | undefined,
  raceSlug: string | null | undefined,
): string | null {
  const meeting = canonicalMeetingHref(date, courseKey);
  if (meeting === null || !isCanonicalHandle(raceSlug)) return null;
  return `${meeting}/race/${raceSlug}`;
}

/* -------------------------------------------------------------------------- */
/* Stored row shapes (read-only projections)                                  */
/* -------------------------------------------------------------------------- */

/** A `races` row as the navigation reads project it. Nulls mean NOT RECORDED. */
export interface NavigationRaceRow {
  id: string;
  meeting_date: string | null;
  course: string | null;
  country: string | null;
  course_key: string | null;
  race_slug: string | null;
  race_name: string | null;
  off_time: string | null;
  status: string | null;
  race_type: string | null;
  going: string | null;
  distance: string | null;
  distance_f: number | null;
  race_class: string | null;
  age_band: string | null;
  pattern: string | null;
  field_size: number | null;
  is_abandoned: boolean | null;
}

/** A `runners` row as the race page projects it. Provider ids are NOT read. */
export interface NavigationRunnerRow {
  id: string;
  horse_name: string | null;
  draw: number | null;
  saddlecloth: number | null;
  age: number | null;
  official_rating: number | null;
  weight_lbs: number | null;
  trainer: string | null;
  jockey: string | null;
  runner_status: string | null;
}

/**
 * Columns the navigation selects from `races`.
 *
 * `provider_race_id` and `provider_course_id` are deliberately ABSENT: these
 * pages must not expose provider identifiers, and the cheapest way to
 * guarantee that is never to read them in the first place.
 */
export const NAVIGATION_RACE_COLUMNS =
  'id, meeting_date, course, country, course_key, race_slug, race_name, off_time, status, ' +
  'race_type, going, distance, distance_f, race_class, age_band, pattern, field_size, is_abandoned';

/**
 * Columns the navigation selects from `runners`.
 *
 * `provider_horse_id`, `trainer_id` and `jockey_id` are deliberately ABSENT
 * for the same reason.
 */
export const NAVIGATION_RUNNER_COLUMNS =
  'id, horse_name, draw, saddlecloth, age, official_rating, weight_lbs, trainer, jockey, runner_status';

/* -------------------------------------------------------------------------- */
/* Deterministic ordering                                                     */
/* -------------------------------------------------------------------------- */

/** Orders nulls last, then ascending, for a nullable text key. */
function compareNullableText(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * Total race ordering: off time, then course, then race name, then `id`.
 *
 * The `id` tie-break is what makes it TOTAL — without it two rows identical on
 * every visible field would order arbitrarily and the page would reshuffle
 * between renders. `id` is used for ordering only: it is never displayed and
 * never placed in a URL.
 */
export function compareRaces(a: NavigationRaceRow, b: NavigationRaceRow): number {
  return (
    compareNullableText(a.off_time, b.off_time) ||
    compareNullableText(a.course, b.course) ||
    compareNullableText(a.race_name, b.race_name) ||
    compareNullableText(a.id, b.id)
  );
}

/**
 * Total runner ordering: draw ascending (nulls last), then horse name, then id.
 *
 * Draw is meaningful on the flat and absent over jumps; treating a missing
 * draw as last keeps undrawn cards in a stable alphabetical order rather than
 * interleaving them with drawn runners.
 */
export function compareRunners(a: NavigationRunnerRow, b: NavigationRunnerRow): number {
  const aDraw = typeof a.draw === 'number' && Number.isFinite(a.draw) ? a.draw : null;
  const bDraw = typeof b.draw === 'number' && Number.isFinite(b.draw) ? b.draw : null;
  if (aDraw !== bDraw) {
    if (aDraw === null) return 1;
    if (bDraw === null) return -1;
    return aDraw - bDraw;
  }
  return compareNullableText(a.horse_name, b.horse_name) || compareNullableText(a.id, b.id);
}

/* -------------------------------------------------------------------------- */
/* Meeting grouping                                                           */
/* -------------------------------------------------------------------------- */

/** One meeting on a date page. `courseKey` null => not canonically linkable. */
export interface MeetingSummary {
  /** Stored `course_key`, or null for historical rows with no handle. */
  courseKey: string | null;
  /** Stored display label; falls back to the key only for heading text. */
  courseLabel: string;
  country: string | null;
  raceCount: number;
  /** Earliest / latest STORED scheduled off time (ISO), or null if unknown. */
  firstOffTime: string | null;
  lastOffTime: string | null;
  /** How many races in this meeting can be linked canonically. */
  linkableRaceCount: number;
  races: NavigationRaceRow[];
}

/**
 * INTERNAL Map-key prefix for rows carrying no stored `course_key`.
 *
 * It begins with a SPACE, which {@link isCanonicalHandle} rejects, so a
 * historical key can never equal a canonical one however the stored label is
 * spelled. It is a `Map` key and nothing else: every group it produces carries
 * `courseKey: null`, so the prefix cannot reach a URL, rendered markup,
 * metadata, a breadcrumb or any other public identifier.
 */
const HISTORICAL_GROUP_PREFIX = ' historical:';

/** Neutral label for rows that recorded no course at all. */
export const UNKNOWN_COURSE_LABEL = 'Course not recorded';

/**
 * Groups a date's races into meetings.
 *
 * CANONICAL rows group by their exact stored `course_key`, which IS identity:
 * two display spellings of one course ("Ascot" / "Royal Ascot") correctly stay
 * one meeting, and the group keeps its key so the meeting page stays linkable.
 *
 * HISTORICAL rows — pre-Programme-0 races with no stored `course_key` — group
 * by their exact trimmed stored course LABEL instead, and keep `courseKey:
 * null` so they are never linkable.
 *
 * The label is NOT a fallback identity. It is the only distinguishing value
 * those rows carry, and bucketing all of them together instead asserted that
 * Ascot, Ayr and Newmarket were ONE meeting with a combined race count and a
 * combined first-to-last window — a fabricated meeting, on the majority of
 * stored dates. Separating the cards states only what each row records, while
 * the absent handle still withholds every link.
 *
 * Nothing here derives, normalises or stores a handle, and no race is mutated.
 */
export function groupRacesByMeeting(races: readonly NavigationRaceRow[]): MeetingSummary[] {
  const byKey = new Map<string, NavigationRaceRow[]>();
  for (const race of races) {
    // Used VERBATIM (trimmed only) — never slugified, lower-cased or otherwise
    // normalised, so this can never produce a permanent-looking handle. Rows
    // recording no course at all share one neutral bucket rather than
    // fragmenting into a card per blank value.
    const storedLabel = typeof race.course === 'string' ? race.course.trim() : '';
    const key = isCanonicalHandle(race.course_key)
      ? race.course_key
      : `${HISTORICAL_GROUP_PREFIX}${storedLabel}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(race);
    else byKey.set(key, [race]);
  }

  const meetings: MeetingSummary[] = [];
  for (const [key, rows] of byKey) {
    const sorted = [...rows].sort(compareRaces);
    const offTimes = sorted
      .map((r) => r.off_time)
      .filter((t): t is string => typeof t === 'string' && t !== '');
    const courseKey = key.startsWith(HISTORICAL_GROUP_PREFIX) ? null : key;
    const label = sorted.find((r) => typeof r.course === 'string' && r.course.trim() !== '')?.course;
    meetings.push({
      courseKey,
      courseLabel: (label ?? courseKey ?? UNKNOWN_COURSE_LABEL).trim(),
      country:
        sorted.find((r) => typeof r.country === 'string' && r.country !== '')?.country ?? null,
      raceCount: sorted.length,
      firstOffTime: offTimes.length > 0 ? offTimes[0] : null,
      lastOffTime: offTimes.length > 0 ? offTimes[offTimes.length - 1] : null,
      linkableRaceCount: sorted.filter(
        (r) => canonicalRaceHref(r.meeting_date, r.course_key, r.race_slug) !== null,
      ).length,
      races: sorted,
    });
  }

  // Meetings order by first off time, then label, then key — a total order.
  meetings.sort(
    (a, b) =>
      compareNullableText(a.firstOffTime, b.firstOffTime) ||
      compareNullableText(a.courseLabel, b.courseLabel) ||
      compareNullableText(a.courseKey, b.courseKey),
  );
  return meetings;
}

/* -------------------------------------------------------------------------- */
/* Formatting — deterministic, timezone-explicit                              */
/* -------------------------------------------------------------------------- */

/**
 * The racing timezone for UK & Ireland.
 *
 * Explicit rather than implicit: these pages are SERVER-rendered, so a bare
 * `toLocaleTimeString()` would format in the host's zone (UTC in deployment)
 * and show a British-summer-time card an hour early. Ireland keeps the same
 * civil offset as the UK year-round, so one zone is correct for both.
 *
 * Note the stored `race_slug` embeds HHMM in UTC. It is an opaque handle, not
 * a display value, and is never parsed back to produce one.
 */
export const RACING_TIME_ZONE = 'Europe/London';

/** Placeholder for a field the card never recorded. Never a zero, never a dash. */
export const UNAVAILABLE_LABEL = 'Not recorded';

const OFF_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: RACING_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const MEETING_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** Scheduled off time as `HH:mm` in the racing timezone, or null if unusable. */
export function formatOffTime(iso: string | null | undefined): string | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return OFF_TIME_FORMAT.format(new Date(ms));
}

/** `2026-08-17` -> `17 August 2026`. Null for a non-canonical date. */
export function formatMeetingDate(date: string | null | undefined): string | null {
  if (!isCanonicalDate(date)) return null;
  return MEETING_DATE_FORMAT.format(new Date(`${date}T00:00:00.000Z`));
}

/**
 * Renders an optional stored field, distinguishing ABSENT from zero/false.
 *
 * `0` and `false` are real recorded values and render as themselves; only
 * `null`/`undefined` (and an empty string, which records nothing) become
 * {@link UNAVAILABLE_LABEL}. Conflating them would report a rating of 0 as
 * "unknown" and an unknown one as 0.
 */
export function displayValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return UNAVAILABLE_LABEL;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : UNAVAILABLE_LABEL;
  return value.trim() === '' ? UNAVAILABLE_LABEL : value;
}

/** Human distance: the stored text when present, else furlongs, else absent. */
export function displayDistance(row: {
  distance: string | null;
  distance_f: number | null;
}): string {
  if (typeof row.distance === 'string' && row.distance.trim() !== '') return row.distance.trim();
  if (typeof row.distance_f === 'number' && Number.isFinite(row.distance_f)) {
    return `${row.distance_f}f`;
  }
  return UNAVAILABLE_LABEL;
}

/* -------------------------------------------------------------------------- */
/* Status presentation — never colour alone                                   */
/* -------------------------------------------------------------------------- */

/** Status tones reused from the shared badge vocabulary. */
export type NavigationStatusTone = 'neutral' | 'positive' | 'warning' | 'official';

export interface NavigationStatus {
  label: string;
  tone: NavigationStatusTone;
}

/**
 * Maps a STORED race status (plus the stored abandonment flag) to a label and
 * tone. Abandonment wins because it is the operationally decisive fact.
 *
 * Never invents a "live" state: nothing here consults a clock, so a page can
 * only ever report what the row already says.
 */
export function describeRaceStatus(row: {
  status: string | null;
  is_abandoned: boolean | null;
}): NavigationStatus {
  if (row.is_abandoned === true) return { label: 'Abandoned', tone: 'warning' };
  const raw = typeof row.status === 'string' ? row.status.trim() : '';
  if (raw === '') return { label: UNAVAILABLE_LABEL, tone: 'neutral' };
  const status = raw.toLowerCase();
  if (status === 'result') return { label: 'Result recorded', tone: 'official' };
  if (status === 'scheduled' || status === 'upcoming') return { label: 'Scheduled', tone: 'neutral' };
  return { label: raw, tone: 'neutral' };
}

/**
 * Counts stored statuses for a set of races, for the honest status indicator.
 *
 * NOTE ON RECENCY. `races` carries no verified capture timestamp in this
 * repository — no migration declares one and no code reads one — so these
 * pages report STORED STATUS rather than claiming a freshness they cannot
 * evidence. This tranche deliberately adds no migration to create one.
 */
export function summariseStoredStatuses(
  races: readonly NavigationRaceRow[],
): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const race of races) {
    const { label } = describeRaceStatus(race);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1));
}

/* -------------------------------------------------------------------------- */
/* Adjacent-race navigation                                                   */
/* -------------------------------------------------------------------------- */

export interface AdjacentRaceLink {
  href: string;
  label: string;
}

export interface AdjacentRaces {
  previous: AdjacentRaceLink | null;
  next: AdjacentRaceLink | null;
}

/**
 * Previous/next race within the SAME stored meeting, in canonical order.
 *
 * Both links are built from stored slugs via {@link canonicalRaceHref}; a
 * neighbour without a stored handle yields no link rather than a guess.
 */
export function findAdjacentRaces(
  meetingRaces: readonly NavigationRaceRow[],
  currentRaceId: string,
): AdjacentRaces {
  const ordered = [...meetingRaces].sort(compareRaces);
  const index = ordered.findIndex((r) => r.id === currentRaceId);
  if (index < 0) return { previous: null, next: null };

  const toLink = (row: NavigationRaceRow | undefined): AdjacentRaceLink | null => {
    if (!row) return null;
    const href = canonicalRaceHref(row.meeting_date, row.course_key, row.race_slug);
    if (href === null) return null;
    const time = formatOffTime(row.off_time);
    const name =
      typeof row.race_name === 'string' && row.race_name.trim() !== ''
        ? row.race_name.trim()
        : 'Race';
    return { href, label: time ? `${time} ${name}` : name };
  };

  return { previous: toLink(ordered[index - 1]), next: toLink(ordered[index + 1]) };
}

/* -------------------------------------------------------------------------- */
/* Page titles (factual, derived from stored data only)                       */
/* -------------------------------------------------------------------------- */

/** e.g. `Racing on 17 August 2026`. Null when the date is not canonical. */
export function datePageTitle(date: string): string | null {
  const long = formatMeetingDate(date);
  return long === null ? null : `Racing on ${long}`;
}

/** e.g. `Ascot, 17 August 2026`. */
export function meetingPageTitle(courseLabel: string, date: string): string | null {
  const long = formatMeetingDate(date);
  return long === null ? null : `${courseLabel}, ${long}`;
}

/** e.g. `14:30 Example Race, Ascot`. Falls back cleanly when a field is absent. */
export function racePageTitle(race: {
  off_time: string | null;
  race_name: string | null;
}, courseLabel: string): string {
  const time = formatOffTime(race.off_time);
  const name =
    typeof race.race_name === 'string' && race.race_name.trim() !== ''
      ? race.race_name.trim()
      : 'Race';
  return `${time ? `${time} ` : ''}${name}, ${courseLabel}`;
}
