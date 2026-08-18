/**
 * READ-ONLY Supabase access for canonical racing navigation.
 *
 * The ONLY database operations in this module are `select`. There is no
 * insert, update, upsert, delete, rpc, storage write, cron call, provider call
 * or producer claim anywhere in it, and rendering a page can never start a
 * model run, an odds capture, a lock or a settlement. That is asserted by
 * source scan in `scripts/racingNavigation.test.ts`.
 *
 * SERVER ONLY. It imports `supabaseAdmin` (service role), so every consumer
 * must be a server component. Nothing here returns a client, a key, an
 * environment value or a raw PostgREST error to a caller — a failed read
 * becomes a typed, message-free outcome and the detail is logged server-side.
 *
 * ONE QUERY LAYER. All three routes read through these functions so the
 * canonical tuple lookup exists in exactly one place. The `NavigationReadSeam`
 * exists so tests can drive every branch — including the duplicate-handle
 * branch the database does not yet prevent — with fixtures and no database.
 *
 * Decision-support only. Nothing here places, recommends or settles a bet.
 */

import { supabaseAdmin } from './supabaseAdmin';
import {
  NAVIGATION_RACE_COLUMNS,
  NAVIGATION_RUNNER_COLUMNS,
  compareRaces,
  compareRunners,
  isCanonicalDate,
  isCanonicalHandle,
  type NavigationRaceRow,
  type NavigationRunnerRow,
} from './racingNavigation';

/** Tables this module may read. Exported so the source scan can pin them. */
export const NAVIGATION_READ_TABLES = ['races', 'runners'] as const;

/** A read that either produced rows or failed. Errors carry NO message. */
export type NavigationReadResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; rows: null };

/**
 * The narrow surface the reads need, injectable for tests.
 *
 * Deliberately four SELECT-shaped methods rather than a Supabase client: a
 * seam that cannot express a write cannot accidentally acquire one, and a test
 * never needs credentials.
 */
export interface NavigationReadSeam {
  racesForDate(date: string): Promise<NavigationReadResult<NavigationRaceRow>>;
  racesForMeeting(date: string, courseKey: string): Promise<NavigationReadResult<NavigationRaceRow>>;
  racesForCanonicalHandle(
    date: string,
    courseKey: string,
    raceSlug: string,
  ): Promise<NavigationReadResult<NavigationRaceRow>>;
  runnersForRace(raceId: string): Promise<NavigationReadResult<NavigationRunnerRow>>;
}

/**
 * Logs a read failure with SAFE context only.
 *
 * Deliberately never logs the PostgREST message, hint or details: those can
 * quote a column list, a filter value or connection text. The operator gets
 * the stage and the shape of the request; the user gets neither.
 */
function logReadFailure(stage: string, context: Record<string, string | number>): void {
  const safe = Object.entries(context)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? v : String(v).slice(0, 64)}`)
    .join(' ');
  console.error(`NAVIGATION_READ_FAILED stage=${stage} ${safe}`);
}

/** The live seam. Every method is a single `select` and nothing else. */
export const supabaseNavigationReadSeam: NavigationReadSeam = {
  async racesForDate(date) {
    const { data, error } = await supabaseAdmin
      .from('races')
      .select(NAVIGATION_RACE_COLUMNS)
      .eq('meeting_date', date);
    if (error) {
      logReadFailure('races_for_date', { date });
      return { ok: false, rows: null };
    }
    return { ok: true, rows: (data ?? []) as unknown as NavigationRaceRow[] };
  },

  async racesForMeeting(date, courseKey) {
    const { data, error } = await supabaseAdmin
      .from('races')
      .select(NAVIGATION_RACE_COLUMNS)
      .eq('meeting_date', date)
      .eq('course_key', courseKey);
    if (error) {
      logReadFailure('races_for_meeting', { date, courseKey });
      return { ok: false, rows: null };
    }
    return { ok: true, rows: (data ?? []) as unknown as NavigationRaceRow[] };
  },

  async racesForCanonicalHandle(date, courseKey, raceSlug) {
    // Deliberately NOT `.single()` / `.maybeSingle()` / `.limit(1)`: each of
    // those either throws on a duplicate or silently returns one arbitrary
    // row. The navigation must be able to SEE a duplicate in order to fail
    // closed on it, so it fetches the matching set and counts.
    const { data, error } = await supabaseAdmin
      .from('races')
      .select(NAVIGATION_RACE_COLUMNS)
      .eq('meeting_date', date)
      .eq('course_key', courseKey)
      .eq('race_slug', raceSlug);
    if (error) {
      logReadFailure('race_for_handle', { date, courseKey, raceSlug });
      return { ok: false, rows: null };
    }
    return { ok: true, rows: (data ?? []) as unknown as NavigationRaceRow[] };
  },

  async runnersForRace(raceId) {
    const { data, error } = await supabaseAdmin
      .from('runners')
      .select(NAVIGATION_RUNNER_COLUMNS)
      .eq('race_id', raceId);
    if (error) {
      // The internal uuid is NOT logged; only that the stage failed.
      logReadFailure('runners_for_race', { raceIdLength: raceId.length });
      return { ok: false, rows: null };
    }
    return { ok: true, rows: (data ?? []) as unknown as NavigationRunnerRow[] };
  },
};

/* -------------------------------------------------------------------------- */
/* Date page                                                                  */
/* -------------------------------------------------------------------------- */

/** A date's races, or a read failure. An EMPTY date is a success, not an error. */
export type DateRacesOutcome =
  | { kind: 'ok'; races: NavigationRaceRow[] }
  | { kind: 'read_failed' };

/** Loads and deterministically orders every stored race on a meeting date. */
export async function loadRacesForDate(
  date: string,
  seam: NavigationReadSeam = supabaseNavigationReadSeam,
): Promise<DateRacesOutcome> {
  if (!isCanonicalDate(date)) return { kind: 'ok', races: [] };
  const result = await seam.racesForDate(date);
  if (!result.ok) return { kind: 'read_failed' };
  return { kind: 'ok', races: [...result.rows].sort(compareRaces) };
}

/* -------------------------------------------------------------------------- */
/* Meeting page                                                               */
/* -------------------------------------------------------------------------- */

/** A meeting's races. `not_found` means no stored row matched the tuple. */
export type MeetingOutcome =
  | { kind: 'ok'; races: NavigationRaceRow[] }
  | { kind: 'not_found' }
  | { kind: 'read_failed' };

/**
 * Loads a meeting by the exact stored tuple (`meeting_date`, `course_key`).
 *
 * A meeting is NEVER resolved by course display name: the display label is
 * mutable text, while `course_key` is the canonical handle ingestion stored.
 */
export async function loadMeeting(
  date: string,
  courseKey: string,
  seam: NavigationReadSeam = supabaseNavigationReadSeam,
): Promise<MeetingOutcome> {
  if (!isCanonicalDate(date) || !isCanonicalHandle(courseKey)) return { kind: 'not_found' };
  const result = await seam.racesForMeeting(date, courseKey);
  if (!result.ok) return { kind: 'read_failed' };
  if (result.rows.length === 0) return { kind: 'not_found' };
  return { kind: 'ok', races: [...result.rows].sort(compareRaces) };
}

/* -------------------------------------------------------------------------- */
/* Race page                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of resolving one canonical race handle.
 *
 * `ambiguous` exists because the database does not yet enforce uniqueness on
 * (`meeting_date`, `course_key`, `race_slug`). Rendering an arbitrary one of
 * two rows would silently show the wrong race, so the resolver reports the
 * ambiguity and the page fails closed.
 */
export type RaceResolution =
  | { kind: 'ok'; race: NavigationRaceRow }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; matchCount: number }
  | { kind: 'read_failed' };

/**
 * Resolves a race by the exact stored tuple.
 *
 * Zero rows -> `not_found`. Exactly one -> `ok`. More than one -> `ambiguous`,
 * NEVER a pick. The internal `races.id` is used only to load runners; it never
 * enters a URL, a title or the rendered page.
 */
export async function resolveCanonicalRace(
  date: string,
  courseKey: string,
  raceSlug: string,
  seam: NavigationReadSeam = supabaseNavigationReadSeam,
): Promise<RaceResolution> {
  if (!isCanonicalDate(date) || !isCanonicalHandle(courseKey) || !isCanonicalHandle(raceSlug)) {
    return { kind: 'not_found' };
  }
  const result = await seam.racesForCanonicalHandle(date, courseKey, raceSlug);
  if (!result.ok) return { kind: 'read_failed' };
  if (result.rows.length === 0) return { kind: 'not_found' };
  if (result.rows.length > 1) {
    // Aggregate context only — no uuid, no slug, no course label.
    console.error(
      `NAVIGATION_AMBIGUOUS_RACE_HANDLE matches=${result.rows.length} date_present=true`,
    );
    return { kind: 'ambiguous', matchCount: result.rows.length };
  }
  return { kind: 'ok', race: result.rows[0] };
}

/** Runners for a resolved race, ordered deterministically. */
export type RunnersOutcome =
  | { kind: 'ok'; runners: NavigationRunnerRow[] }
  | { kind: 'read_failed' };

/**
 * Loads a race's runners by the RESOLVED INTERNAL uuid.
 *
 * The uuid is the correct join key and is deliberately kept internal: it is
 * never part of the public path, so a stable public URL and a stable internal
 * foreign key stay separate concerns.
 */
export async function loadRunnersForRace(
  raceId: string,
  seam: NavigationReadSeam = supabaseNavigationReadSeam,
): Promise<RunnersOutcome> {
  if (typeof raceId !== 'string' || raceId === '') return { kind: 'ok', runners: [] };
  const result = await seam.runnersForRace(raceId);
  if (!result.ok) return { kind: 'read_failed' };
  return { kind: 'ok', runners: [...result.rows].sort(compareRunners) };
}
