/**
 * PURE contract for racing search: validation, matching, ranking, shaping.
 *
 * No Supabase, no React, no environment access, no I/O and no clock reads.
 * Everything here is a total function over its inputs, so the API route and the
 * tests exercise exactly the same logic.
 *
 * IDENTITY. Result links are built ONLY from stored canonical handles, through
 * `canonicalMeetingHref` / `canonicalRaceHref`. Nothing here derives, repairs
 * or slugifies a handle: a row that never stored one is returned as
 * non-linkable, exactly as the date page treats it.
 *
 * PRIVACY. The result shapes carry no internal uuid, no provider identifier and
 * no model, odds or operational field. They cannot: those columns are not part
 * of the projection this module accepts.
 *
 * Decision-support only. Nothing here places, recommends or settles a bet.
 */

import {
  canonicalMeetingHref,
  canonicalRaceHref,
  isCanonicalDate,
  isCanonicalHandle,
} from './racingNavigation';

/* -------------------------------------------------------------------------- */
/* Bounds — fixed by the server, never by the caller                          */
/* -------------------------------------------------------------------------- */

/** Below this a query matches too much to be useful, so it is refused. */
export const SEARCH_MIN_QUERY_LENGTH = 2;

/** Above this the input is not a search term. Bounded so a URL cannot bloat. */
export const SEARCH_MAX_QUERY_LENGTH = 64;

/** Maximum results returned to a caller. NOT caller-controllable. */
export const SEARCH_RESULT_LIMIT = 20;

/**
 * Rows each database probe may return.
 *
 * Deliberately larger than {@link SEARCH_RESULT_LIMIT} so ranking has material
 * to work with, and deliberately finite so no query can degenerate into a
 * full-table scan.
 */
export const SEARCH_PROBE_LIMIT = 40;

/* -------------------------------------------------------------------------- */
/* Scope                                                                      */
/* -------------------------------------------------------------------------- */

/** The only scopes that exist. Anything else is refused, never coerced. */
export const SEARCH_SCOPES = ['all', 'meetings', 'races'] as const;

export type SearchScope = (typeof SEARCH_SCOPES)[number];

/** The scope used when the caller supplies none. */
export const DEFAULT_SEARCH_SCOPE: SearchScope = 'all';

/**
 * Parses the scope parameter.
 *
 * Absent means the default. Anything present but unrecognised is REFUSED
 * rather than silently falling back, so a typo cannot quietly change what a
 * caller believes they searched. Scope is a closed set and is never used to
 * name a table, a column or an operator.
 */
export function parseSearchScope(
  raw: string | null | undefined,
): { ok: true; scope: SearchScope } | { ok: false; reason: 'unsupported_scope' } {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, scope: DEFAULT_SEARCH_SCOPE };
  }
  const match = SEARCH_SCOPES.find((scope) => scope === raw);
  return match ? { ok: true, scope: match } : { ok: false, reason: 'unsupported_scope' };
}

/* -------------------------------------------------------------------------- */
/* Query validation                                                           */
/* -------------------------------------------------------------------------- */

export type QueryRejection =
  | 'missing'
  | 'too_short'
  | 'too_long'
  | 'invalid_characters'
  | 'wildcard';

export type QueryValidation =
  | { ok: true; query: string }
  | { ok: false; reason: QueryRejection };

/**
 * Control characters, including DEL and the C1 range.
 *
 * These cannot occur in a course or race name and are a common probe, so they
 * are refused outright rather than stripped — stripping would search for
 * something the caller did not type.
 */
const CONTROL_CHARACTERS = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + '-' + String.fromCharCode(159) + ']');

/**
 * Validates and trims a raw query.
 *
 * Surrounding whitespace is trimmed (a trailing space from a paste or a mobile
 * keyboard is not a different search); interior text is otherwise untouched.
 * Length is measured AFTER trimming, so " a " cannot pass a minimum it does not
 * meet.
 */
export function normaliseSearchQuery(raw: string | null | undefined): QueryValidation {
  if (typeof raw !== 'string') return { ok: false, reason: 'missing' };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'missing' };
  if (CONTROL_CHARACTERS.test(trimmed)) return { ok: false, reason: 'invalid_characters' };
  /*
   * `*` is REFUSED, not escaped.
   *
   * PostgREST accepts `*` as an alias for `%` inside a like/ilike value and
   * rewrites it before Postgres sees it, so `Asc*t` would match "Ascendant
   * Trophy" — text the caller never typed. It cannot be escaped away either:
   * `*` is rewritten to `%`, which then matches a literal percent sign, so
   * escaping would silently search for something different again. Refusing is
   * the only option that keeps "we search for exactly what you typed" true.
   */
  if (trimmed.includes('*')) return { ok: false, reason: 'wildcard' };
  if (trimmed.length < SEARCH_MIN_QUERY_LENGTH) return { ok: false, reason: 'too_short' };
  if (trimmed.length > SEARCH_MAX_QUERY_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true, query: trimmed };
}

/* -------------------------------------------------------------------------- */
/* Safe matching                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Escapes the LIKE metacharacters so user input is matched LITERALLY.
 *
 * Without this a query of `%` matches every row and `_` matches any character,
 * turning a bounded search into a full scan with attacker-chosen selectivity.
 * Mirrors the escaping already used for tipster alias lookups in
 * `raceData.ts`; kept here because this module must stay free of that
 * module's database dependencies.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

/**
 * The `ilike` pattern for a validated query: contained match, literal text.
 *
 * The caller supplies only this VALUE. It never becomes part of a filter
 * expression, a column name or an operator — the column and operator are fixed
 * in `racingSearchRead.ts`, so there is no PostgREST filter to inject into.
 */
export function buildContainsPattern(query: string): string {
  return `%${escapeLikePattern(query)}%`;
}

/**
 * The exact meeting date a query names, or null.
 *
 * Lets `2026-08-17` find that day's racing without a second input, and returns
 * null for anything that is not an exact canonical date — so no partial or
 * impossible date ever reaches an equality filter.
 */
export function queryAsMeetingDate(query: string): string | null {
  return isCanonicalDate(query) ? query : null;
}

/* -------------------------------------------------------------------------- */
/* Row + result shapes                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The ONLY columns search reads.
 *
 * No `id`, so an internal uuid cannot reach a response even by accident; no
 * provider column, no model, odds, ownership or operational field.
 */
export interface SearchRaceRow {
  meeting_date: string | null;
  course: string | null;
  course_key: string | null;
  race_slug: string | null;
  race_name: string | null;
  off_time: string | null;
}

/** Column list for the SELECT. Exported so a test can pin it exactly. */
export const SEARCH_RACE_COLUMNS =
  'meeting_date, course, course_key, race_slug, race_name, off_time';

/** Neutral label when no course was recorded. */
export const UNKNOWN_COURSE_LABEL = 'Course not recorded';

/** Neutral label when no race name was recorded. */
export const UNKNOWN_RACE_LABEL = 'Race name not recorded';

/**
 * Label for a race whose canonical address matches more than one stored row.
 *
 * Deliberately names NEITHER row: showing one of two conflicting records as
 * the answer would be an arbitrary pick with a disclaimer attached.
 */
export const AMBIGUOUS_RACE_LABEL = 'Race cannot be identified';

/** Why a result carries no link. `ambiguous` never names the rows involved. */
export type SearchAvailability = 'canonical' | 'historical' | 'ambiguous';

export interface SearchMeetingResult {
  kind: 'meeting';
  meetingDate: string;
  courseLabel: string;
  /**
   * How many MATCHED rows this meeting contributed — bounded by the probe
   * window, so it is not the size of the race card and is never labelled as
   * one. See the note on `buildMeetingResults`.
   */
  matchingRaceCount: number;
  availability: SearchAvailability;
  /** Canonical href, or null when the meeting stored no handle. */
  href: string | null;
}

export interface SearchRaceResult {
  kind: 'race';
  meetingDate: string;
  courseLabel: string;
  raceName: string;
  /** ISO instant; the client formats it in the racing timezone. */
  offTime: string | null;
  availability: SearchAvailability;
  href: string | null;
}

export type SearchResult = SearchMeetingResult | SearchRaceResult;

export interface RacingSearchSuccess {
  query: string;
  scope: SearchScope;
  results: SearchResult[];
  /** True when ranking discarded results beyond {@link SEARCH_RESULT_LIMIT}. */
  truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Ranking                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Match tiers, best first. Deliberately simple and explainable — this is
 * substring matching with sensible precedence, not relevance scoring, and it
 * is described that way in the UI.
 */
export const MATCH_TIER = {
  exactHandle: 0,
  exactLabel: 1,
  prefix: 2,
  contains: 3,
  none: 4,
} as const;

export type MatchTier = (typeof MATCH_TIER)[keyof typeof MATCH_TIER];

const lower = (value: string | null): string => (value ?? '').trim().toLowerCase();

/** Best tier across the fields a result is matched on. Pure. */
export function matchTier(query: string, fields: { handles: (string | null)[]; labels: (string | null)[] }): MatchTier {
  const needle = query.trim().toLowerCase();
  if (needle === '') return MATCH_TIER.none;

  for (const handle of fields.handles) {
    if (lower(handle) === needle) return MATCH_TIER.exactHandle;
  }
  for (const label of fields.labels) {
    if (lower(label) === needle) return MATCH_TIER.exactLabel;
  }
  const all = [...fields.handles, ...fields.labels];
  for (const value of all) {
    if (lower(value).startsWith(needle)) return MATCH_TIER.prefix;
  }
  for (const value of all) {
    if (lower(value).includes(needle)) return MATCH_TIER.contains;
  }
  return MATCH_TIER.none;
}

/** Orders nulls last, then ascending, for a nullable text key. */
function compareNullableText(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/* -------------------------------------------------------------------------- */
/* Result building                                                            */
/* -------------------------------------------------------------------------- */

/** Sentinel prefix for a historical meeting bucket. Never leaves this module. */
const HISTORICAL_MEETING_PREFIX = ' historical:';

/** The canonical tuple key a race is deduplicated and disambiguated by. */
function raceTupleKey(row: SearchRaceRow): string | null {
  if (!isCanonicalDate(row.meeting_date)) return null;
  if (!isCanonicalHandle(row.course_key) || !isCanonicalHandle(row.race_slug)) return null;
  return `${row.meeting_date}|${row.course_key}|${row.race_slug}`;
}

/**
 * A result plus the keys it is ordered by. All three are server-internal and
 * none is serialised.
 */
interface Ranked<T> {
  tier: MatchTier;
  /** Meeting date, ordered DESCENDING so the newest racing leads. */
  meetingDate: string;
  /** Within one date, ordered ASCENDING: off time, then label. */
  tieKey: string;
  /** Meetings lead races at the same tier: a meeting is the broader answer. */
  kindRank: number;
  value: T;
}

/**
 * Total, deterministic ordering.
 *
 * Each component is compared SEPARATELY and in its own direction. Negating a
 * single concatenated key would have reversed every component together, so a
 * card would read 17:45, 17:15, 16:45 and courses would run Z-A — the date
 * would be right and everything under it backwards.
 */
function orderRanked<T>(items: Ranked<T>[]): T[] {
  return [...items]
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        a.kindRank - b.kindRank ||
        // Most recent meeting first: a search for a course usually means the
        // racing about to happen, not the oldest stored card.
        compareNullableText(b.meetingDate, a.meetingDate) ||
        // Everything within a date reads forwards.
        compareNullableText(a.tieKey, b.tieKey),
    )
    .map((item) => item.value);
}

/** Meetings lead races when tiers are equal. */
const KIND_RANK = { meeting: 0, race: 1 } as const;

/**
 * Groups matching rows into MEETING results.
 *
 * Canonical meetings are keyed by the exact stored tuple (`meeting_date`,
 * `course_key`) — never by display name, which is mutable text. Rows with no
 * stored key are grouped by date plus the exact trimmed stored label, so two
 * historical courses never merge into one fabricated meeting, and every such
 * group is returned unlinked.
 *
 * The label and the match tier are computed over the WHOLE group, not its first
 * row: one row storing a null course must not label the meeting with its raw
 * handle while a sibling holds the real name, and a sibling that matches more
 * exactly must not be ignored.
 *
 * `matchingRaceCount` is named for what it is — the number of MATCHED rows,
 * bounded by the probe window. It is NOT the size of the race card, and calling
 * it a race count would state a number this query cannot evidence.
 */
export function rankMeetingResults(
  rows: readonly SearchRaceRow[],
  query: string,
): Ranked<SearchMeetingResult>[] {
  const groups = new Map<
    string,
    { rows: SearchRaceRow[]; canonical: boolean; meetingDate: string; courseKey: string | null }
  >();

  for (const row of rows) {
    if (!isCanonicalDate(row.meeting_date)) continue;
    const canonical = isCanonicalHandle(row.course_key);
    const key = canonical
      ? `${row.meeting_date}|${row.course_key}`
      : `${row.meeting_date}|${HISTORICAL_MEETING_PREFIX}${(row.course ?? '').trim()}`;
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(key, {
        rows: [row],
        canonical,
        meetingDate: row.meeting_date,
        courseKey: canonical ? (row.course_key as string) : null,
      });
    }
  }

  const ranked: Ranked<SearchMeetingResult>[] = [];
  for (const group of groups.values()) {
    const { rows: groupRows, canonical, meetingDate, courseKey } = group;

    // Best label anywhere in the group, then the handle, then a neutral phrase.
    const storedLabel = groupRows
      .map((r) => (r.course ?? '').trim())
      .find((label) => label !== '');
    const courseLabel = storedLabel ?? courseKey ?? UNKNOWN_COURSE_LABEL;

    // Best tier anywhere in the group.
    let tier: MatchTier = MATCH_TIER.none;
    for (const r of groupRows) {
      const rowTier = matchTier(query, {
        handles: [r.course_key, meetingDate],
        labels: [r.course],
      });
      if (rowTier < tier) tier = rowTier;
    }
    if (tier === MATCH_TIER.none) continue;

    ranked.push({
      tier,
      meetingDate,
      tieKey: courseLabel.toLowerCase(),
      kindRank: KIND_RANK.meeting,
      value: {
        kind: 'meeting',
        meetingDate,
        courseLabel,
        matchingRaceCount: groupRows.length,
        availability: canonical ? 'canonical' : 'historical',
        href: canonical ? canonicalMeetingHref(meetingDate, courseKey) : null,
      },
    });
  }
  return ranked;
}

/** Ordered meeting results. Thin wrapper over {@link rankMeetingResults}. */
export function buildMeetingResults(
  rows: readonly SearchRaceRow[],
  query: string,
): SearchMeetingResult[] {
  return orderRanked(rankMeetingResults(rows, query));
}

/**
 * Builds RACE results.
 *
 * FAIL CLOSED ON AMBIGUITY. The database does not enforce uniqueness on
 * (`meeting_date`, `course_key`, `race_slug`), so two rows can share one
 * canonical tuple. Such a tuple yields ONE result with no href AND NO STORED
 * RACE NAME — presenting one of two conflicting records as *the* record would
 * be an arbitrary pick wearing a disclaimer. Only what both rows agree on (the
 * date, the course, the fact of the clash) is shown, and no identifier is named.
 *
 * Detection is bounded by what the probe returned: a duplicate whose twin fell
 * outside the probe window is not visible here. That degrades safely rather
 * than silently — the race page resolves the same tuple and fails closed, so
 * such a link reaches a refusal, never an arbitrary race.
 */
export function rankRaceResults(
  rows: readonly SearchRaceRow[],
  query: string,
): Ranked<SearchRaceResult>[] {
  const tupleCounts = new Map<string, number>();
  for (const row of rows) {
    const key = raceTupleKey(row);
    if (key !== null) tupleCounts.set(key, (tupleCounts.get(key) ?? 0) + 1);
  }

  const ranked: Ranked<SearchRaceResult>[] = [];
  const emittedTuples = new Set<string>();

  for (const row of rows) {
    if (!isCanonicalDate(row.meeting_date)) continue;
    const meetingDate = row.meeting_date;
    const tier = matchTier(query, {
      handles: [row.course_key, row.race_slug, meetingDate],
      labels: [row.course, row.race_name],
    });
    if (tier === MATCH_TIER.none) continue;

    const tuple = raceTupleKey(row);
    const ambiguous = tuple !== null && (tupleCounts.get(tuple) ?? 0) > 1;
    if (ambiguous && tuple !== null) {
      // One entry per clashing tuple, so a duplicate never doubles the list.
      if (emittedTuples.has(tuple)) continue;
      emittedTuples.add(tuple);
    }

    const courseLabel = (row.course ?? '').trim() || UNKNOWN_COURSE_LABEL;
    const storedName = (row.race_name ?? '').trim();
    const availability: SearchAvailability = ambiguous
      ? 'ambiguous'
      : tuple === null
        ? 'historical'
        : 'canonical';

    ranked.push({
      tier,
      meetingDate,
      // An ambiguous tuple orders by date and course only: keying on one
      // clashing row’s off time would smuggle the arbitrary pick back in.
      tieKey: ambiguous ? '' : `${row.off_time ?? ''}|${storedName.toLowerCase()}`,
      kindRank: KIND_RANK.race,
      value: {
        kind: 'race',
        meetingDate,
        courseLabel,
        // An ambiguous tuple shows NO stored name or time: naming one of the
        // clashing rows is exactly the arbitrary pick this branch avoids.
        raceName: ambiguous ? AMBIGUOUS_RACE_LABEL : storedName || UNKNOWN_RACE_LABEL,
        offTime: ambiguous ? null : row.off_time,
        availability,
        href:
          availability === 'canonical'
            ? canonicalRaceHref(meetingDate, row.course_key, row.race_slug)
            : null,
      },
    });
  }
  return ranked;
}

/** Ordered race results. Thin wrapper over {@link rankRaceResults}. */
export function buildRaceResults(
  rows: readonly SearchRaceRow[],
  query: string,
): SearchRaceResult[] {
  return orderRanked(rankRaceResults(rows, query));
}

/**
 * Assembles the response body from matched rows.
 *
 * Meetings and races are ranked TOGETHER so relevance decides what survives the
 * cap. Concatenating every meeting ahead of every race would let a weak meeting
 * match push out an exact race match purely because of its kind.
 */
export function buildSearchResults(input: {
  rows: readonly SearchRaceRow[];
  query: string;
  scope: SearchScope;
  /** True when a database probe hit its row cap, so matches may be missing. */
  probeTruncated?: boolean;
}): RacingSearchSuccess {
  const { rows, query, scope } = input;

  /*
   * Both kinds are ranked with their REAL match tier and merged through the
   * one total order, so relevance decides what survives the cap. An earlier
   * version concatenated the two ordered lists and re-keyed them by position,
   * which let a weak meeting match evict an exact race match purely because
   * meetings were listed first.
   */
  const ranked: Ranked<SearchResult>[] = [
    ...(scope === 'races' ? [] : rankMeetingResults(rows, query)),
    ...(scope === 'meetings' ? [] : rankRaceResults(rows, query)),
  ] as Ranked<SearchResult>[];

  const combined = orderRanked(ranked);

  return {
    query,
    scope,
    results: combined.slice(0, SEARCH_RESULT_LIMIT),
    // Truncated when ranking dropped results OR a database probe hit its cap:
    // either way the caller must not read this as a complete answer.
    truncated: combined.length > SEARCH_RESULT_LIMIT || input.probeTruncated === true,
  };
}
