/**
 * Pure transforms + matching for the live data pipeline (no I/O, no DB).
 *
 * The cron routes fetch from The Racing API / Betfair and persist via Supabase;
 * this module holds the deterministic mapping + entity-matching logic so it can
 * be unit-tested on fixtures. It NEVER invents data — missing fields map to
 * null/undefined and are stored as such by the caller.
 *
 * ENTITY MATCHING (important): the `races`/`runners` tables have no column for
 * an external provider id (Racing API `rac_`/`hrs_` ids or a Betfair
 * selectionId), so we match API entities back to DB rows on a normalised
 * (course + off-time) for the race and a normalised horse name for the runner.
 * This is robust for same-day UK/IRE cards but is inherently fuzzy; abandoned or
 * renamed races may not match, in which case the caller SKIPS them rather than
 * writing to the wrong row.
 */

import type {
  ResultRunner,
  StandardRacecard,
  StandardRacecardRunner,
} from './racingApi';

/** Label stamped on this pipeline's writes. */
export const PIPELINE_SOURCE = 'racing_api';
/** runner_quotes.quote_type for a Betfair Exchange price. */
export const BETFAIR_QUOTE_TYPE = 'betfair_exchange';
/** The bookmaker key The Racing API uses for the exchange price. */
export const BETFAIR_BOOKMAKER = 'Betfair Exchange';

const HANDICAP_RE = /\bh'?cap\b|\bhandicap\b/i;

/** Coerces a numeric-ish value to a finite number, else null. Never throws. */
export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A decimal price coerced to a number only when it is a real price (> 1). */
export function toPriceOrNull(value: unknown): number | null {
  const n = toNumberOrNull(value);
  return n !== null && n > 1 ? n : null;
}

/**
 * Normalises a horse name for cross-source matching: lower-cased, trailing
 * country suffix like "(IRE)" stripped, punctuation removed, whitespace
 * collapsed. e.g. "Frankel (GB)" -> "frankel".
 */
export function normalizeHorseName(name: string | undefined | null): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\([a-z]{1,3}\)/g, ' ') // (gb) (ire) (fr) ...
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Exact, deterministic course/venue aliases, applied AFTER the base
 * normalisation below. Keys/values are already-normalised strings. This exists
 * because providers label the same physical course differently: The Racing API
 * calls it "Ascot", while Betfair labels the Royal Ascot meeting "Royal Ascot".
 * Only EXACT normalised matches are rewritten — this is not fuzzy matching, and
 * unrelated courses are untouched. Add a new line here per confirmed alias.
 */
const COURSE_ALIASES: Record<string, string> = {
  'royal ascot': 'ascot',
};

/**
 * Normalises a course/venue name for matching: lower-cased, an "(AW)" all-
 * weather marker stripped, punctuation removed, whitespace collapsed, then a
 * known exact alias applied ({@link COURSE_ALIASES}).
 * e.g. "Lingfield (AW)" -> "lingfield"; "Royal Ascot" -> "ascot".
 */
export function normalizeCourse(name: string | undefined | null): string {
  if (!name) return '';
  const base = name
    .toLowerCase()
    .replace(/\(aw\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return COURSE_ALIASES[base] ?? base;
}

/** True when a race name/class denotes a handicap. */
export function isHandicap(...texts: (string | undefined)[]): boolean {
  return texts.some((t) => typeof t === 'string' && HANDICAP_RE.test(t));
}

/**
 * Resolves a race's off time to an ISO string + UTC calendar date. Prefers the
 * full `off_dt` (carries a timezone offset); falls back to `date` + `off_time`.
 * Returns null when neither yields a parseable instant (caller skips the race).
 */
export function resolveOffTime(
  offDt: string | undefined,
  date: string | undefined,
  offTime: string | undefined,
): { offTimeIso: string; meetingDate: string } | null {
  const tryParse = (s: string | undefined): string | null => {
    if (!s || s.trim() === '') return null;
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  };

  let iso = tryParse(offDt);
  if (!iso && date && offTime) {
    // Compose "YYYY-MM-DDTHH:MM" — interpreted as UTC by Date.parse when 'Z'-less
    // is ambiguous, so append Z to make the instant explicit.
    const hhmm = offTime.trim().padStart(5, '0');
    iso = tryParse(`${date}T${hhmm}:00Z`);
  }
  if (!iso) return null;

  // meeting_date prefers the explicit `date`; else the UTC date of the instant.
  const meetingDate =
    date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : iso.slice(0, 10);
  return { offTimeIso: iso, meetingDate };
}

/** A race row ready to upsert into `races` (no id; caller assigns/looks up). */
export interface RaceUpsert {
  meeting_date: string;
  course: string;
  country: string;
  race_name: string;
  off_time: string;
  handicap_flag: boolean;
  status: string;
}

/** A runner row ready to upsert into `runners` (no id/race_id; caller wires). */
export interface RunnerUpsert {
  horse_name: string;
  trainer: string | null;
  jockey: string | null;
  draw: number | null;
  saddlecloth: number | null;
  official_rating: number | null;
  weight_lbs: number | null;
  runner_status: string;
}

/** The Betfair Exchange decimal price already bundled on a standard racecard. */
export function bundledBetfairPrice(
  runner: StandardRacecardRunner,
): number | null {
  const entry = (runner.odds ?? []).find(
    (o) => (o.bookmaker ?? '').toLowerCase() === BETFAIR_BOOKMAKER.toLowerCase(),
  );
  return entry ? toPriceOrNull(entry.decimal) : null;
}

/**
 * Maps a `/racecards/standard` race to a `races` upsert row, or null when the
 * race is abandoned or has no resolvable off time (caller skips it).
 */
export function racecardToRaceUpsert(card: StandardRacecard): RaceUpsert | null {
  if (card.is_abandoned) return null;
  const course = (card.course ?? '').trim();
  if (course === '') return null;
  const resolved = resolveOffTime(card.off_dt, card.date, card.off_time);
  if (!resolved) return null;

  return {
    meeting_date: resolved.meetingDate,
    course,
    country: (card.region ?? 'GB').trim() || 'GB',
    race_name: (card.race_name ?? '(unknown race)').trim() || '(unknown race)',
    off_time: resolved.offTimeIso,
    handicap_flag: isHandicap(card.race_name, card.race_class),
    status: 'scheduled',
  };
}

/** Maps a standard-racecard runner to a `runners` upsert row. */
export function racecardRunnerToUpsert(
  runner: StandardRacecardRunner,
): RunnerUpsert | null {
  const horse = (runner.horse ?? '').trim();
  if (horse === '') return null;
  return {
    horse_name: horse,
    trainer: (runner.trainer ?? '').trim() || null,
    jockey: (runner.jockey ?? '').trim() || null,
    draw: toNumberOrNull(runner.draw),
    saddlecloth: toNumberOrNull(runner.number),
    official_rating: toNumberOrNull(runner.ofr),
    weight_lbs: toNumberOrNull(runner.lbs),
    runner_status: 'declared',
  };
}

/** A per-runner result update derived from a `/results` runner. */
export interface ResultUpdate {
  /** Normalised horse name used to match the DB runner. */
  matchKey: string;
  horseName: string;
  finishPos: number | null;
  bspDecimal: number | null;
  spDecimal: number | null;
}

/**
 * Maps a `/results` runner to a result update. `position` is parsed to a finish
 * position only when it is a positive integer (non-finishers like "PU"/"F" stay
 * null — never invented). bsp/sp are real prices or null.
 */
export function resultRunnerToUpdate(runner: ResultRunner): ResultUpdate | null {
  const horse = (runner.horse ?? '').trim();
  if (horse === '') return null;
  const posNum = toNumberOrNull(runner.position);
  const finishPos =
    posNum !== null && Number.isInteger(posNum) && posNum >= 1 ? posNum : null;
  return {
    matchKey: normalizeHorseName(horse),
    horseName: horse,
    finishPos,
    bspDecimal: toPriceOrNull(runner.bsp),
    spDecimal: toPriceOrNull(runner.sp_dec),
  };
}

/**
 * Picks the best Betfair market for one of our races from a candidate list,
 * matching on normalised venue/course AND off time within `toleranceMs`
 * (default 90s — exchange start times can differ slightly from the card). Pure.
 */
export function matchMarketToRace<
  T extends { venue?: string; marketStartIso?: string },
>(
  race: { course: string; offTimeIso: string },
  markets: T[],
  toleranceMs = 90_000,
): T | null {
  const wantCourse = normalizeCourse(race.course);
  const wantMs = Date.parse(race.offTimeIso);
  let best: T | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const m of markets) {
    if (normalizeCourse(m.venue) !== wantCourse) continue;
    const ms = m.marketStartIso ? Date.parse(m.marketStartIso) : NaN;
    if (Number.isNaN(ms)) continue;
    const delta = Math.abs(ms - wantMs);
    if (delta <= toleranceMs && delta < bestDelta) {
      best = m;
      bestDelta = delta;
    }
  }
  return best;
}

/** Builds a normalised-horse-name -> id index for the runners of one race. */
export function indexRunnersByName(
  runners: { id: string; horse_name: string }[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const r of runners) {
    const key = normalizeHorseName(r.horse_name);
    if (key && !index.has(key)) index.set(key, r.id);
  }
  return index;
}
