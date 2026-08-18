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

/**
 * Which raw provider field produced a resolved off time.
 *
 * `off_dt` is a full ISO instant with an offset and is trustworthy. The
 * `date_off_time` fallback composes `date` + a LOCAL `off_time` and forces it
 * to UTC, which is a one-hour error under British Summer Time — so anything
 * downstream that must not act on a wrong instant can refuse it by source.
 */
export type OffTimeSource = 'off_dt' | 'date_off_time';

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
 * A provider string trimmed to a real value, or null. Blank/whitespace-only and
 * absent both become null — an empty provider field is missing data, never the
 * empty string, so it must not be stored as one.
 */
export function trimmedOrNull(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t;
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

/**
 * ROUTE-SAFE course key — a thin DERIVATIVE of {@link normalizeCourse}, not a
 * second normaliser.
 *
 * `normalizeCourse` produces a space-separated matching name ("great yarmouth")
 * because that is what entity matching wants. A URL segment wants hyphens. This
 * takes the existing normalised value verbatim and only swaps the separator, so
 * the two can never disagree about aliases, "(AW)" stripping or punctuation —
 * change `normalizeCourse` and this follows automatically.
 *
 * Deterministic and pure. e.g. "Lingfield (AW)" -> "lingfield";
 * "Royal Ascot" -> "ascot"; "Great Yarmouth" -> "great-yarmouth".
 */
export function courseKey(name: string | undefined | null): string {
  return normalizeCourse(name).replace(/ /g, '-');
}

/** Fallback slug body when a race has no usable name. */
const UNKNOWN_RACE_SLUG = 'unknown-race';

/**
 * ROUTE-SAFE race slug: scheduled `HHMM` + slugified race name.
 *
 * WHAT THIS GUARANTEES — PER-ROW SLUG IMMUTABILITY, AND ONLY THAT.
 *
 * `liveSync.syncRacecards` looks a race up by (course, off_time) and INSERTS
 * only when it is absent; settlement updates just `status` and
 * `official_result_time`. So once a slug is stored on a row, no current write
 * path rewrites it. That is the whole of the guarantee, and it is asserted by
 * test so it cannot be lost silently.
 *
 * WHAT THIS DOES NOT GUARANTEE — AND HOW THAT CHANGED.
 *
 * Programme 0 captured `provider_race_id` without reading it, so a corrected
 * off time or course label missed the existing row and inserted a SECOND row
 * with its own uuid and its own slug. Commit a9ee1cd closed that: resolution is
 * now provider-identity-first, so the same provider race resolves to the same
 * `races.id` and the slug stays frozen on ONE row.
 *
 * The failure mode INVERTED rather than disappearing. A corrected card now
 * reuses the existing row and writes nothing, so `races.off_time` can go stale
 * instead. That is deliberate and is handled WITHOUT rewriting the column: see
 * `offTimeObservation.ts`, which records the divergence as immutable evidence
 * and lets the write-side safety guards use a strictest-known "effective" off
 * that can only ever move EARLIER. `races.off_time` itself is frozen at insert
 * by every write path in the repository.
 *
 * The `provider_race_id` index remains deliberately non-unique; duplicate
 * provider ids fail closed in application logic rather than at the schema.
 *
 * Deliberately NOT derived from a race number or array position: those depend
 * on how many races were fetched, which is not stable across calls.
 *
 * `offTimeIso` is the resolved ISO instant; HHMM is taken in UTC so the value
 * is identical on server and client. Returns '' when the instant is unusable —
 * the caller then stores null rather than an invented handle.
 */
export function raceSlug(
  offTimeIso: string | undefined | null,
  raceName: string | undefined | null,
): string {
  const ms = offTimeIso ? Date.parse(offTimeIso) : NaN;
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}${String(
    d.getUTCMinutes(),
  ).padStart(2, '0')}`;

  const body = (raceName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `${hhmm}-${body === '' ? UNKNOWN_RACE_SLUG : body}`;
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
): { offTimeIso: string; meetingDate: string; source: OffTimeSource } | null {
  const tryParse = (s: string | undefined): string | null => {
    if (!s || s.trim() === '') return null;
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  };

  let iso = tryParse(offDt);
  let source: OffTimeSource = 'off_dt';
  if (!iso && date && offTime) {
    source = 'date_off_time';
    // Compose "YYYY-MM-DDTHH:MM" — interpreted as UTC by Date.parse when 'Z'-less
    // is ambiguous, so append Z to make the instant explicit.
    const hhmm = offTime.trim().padStart(5, '0');
    iso = tryParse(`${date}T${hhmm}:00Z`);
  }
  if (!iso) return null;

  // meeting_date prefers the explicit `date`; else the UTC date of the instant.
  const meetingDate =
    date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : iso.slice(0, 10);
  return { offTimeIso: iso, meetingDate, source };
}

/**
 * A race row ready to insert into `races` (no id; caller assigns/looks up).
 *
 * PROGRAMME 0 widened this from 7 fields to 17. The original seven are
 * unchanged in name, type and meaning; the additions are provider identity,
 * route identity, and the card attributes ingestion previously discarded.
 *
 * FUTURE DATA ONLY: nothing backfills the 719 existing races. They keep their
 * uuid identity and carry null for every new field, and every consumer must
 * treat null as "never recorded" rather than as a value.
 *
 * `is_handicap` is deliberately absent: `handicap_flag` is the active column
 * (populated on all 719 rows) and `is_handicap` is a legacy field that is false
 * on every row. New logic must never read or write it.
 */
export interface RaceUpsert {
  meeting_date: string;
  course: string;
  country: string;
  race_name: string;
  off_time: string;
  handicap_flag: boolean;
  status: string;
  /** External Racing API race id. Null when the card omitted it. */
  provider_race_id: string | null;
  /** External Racing API course id. */
  provider_course_id: string | null;
  /** Route-safe course key derived from `course`. */
  course_key: string | null;
  /** Route-safe URL handle, frozen at first insert. */
  race_slug: string | null;
  /** Provider race-type vocabulary (Flat / Hurdle / Chase / ...). */
  race_type: string | null;
  /** Race distance in furlongs, numeric, for modelling. */
  distance_f: number | null;
  /** Human-readable distance, only when the provider supplies one. */
  distance: string | null;
  /** Going description as stated on the card. */
  going: string | null;
  /** Provider race class. */
  race_class: string | null;
  /** Provider age band (e.g. "3yo+"). */
  age_band: string | null;
  /** Provider pattern/grade (Group 1, Listed, ...). */
  pattern: string | null;
  /** Declared field size from the card (not a count of runner rows). */
  field_size: number | null;
  /** Provider abandonment flag; null when the card did not state one. */
  is_abandoned: boolean | null;
}

/**
 * A runner row ready to insert into `runners` (no id/race_id; caller wires).
 *
 * PROGRAMME 0 added provider identity plus the three columns that already
 * existed on the table but were never written (`trainer_id`, `jockey_id`,
 * `age`).
 *
 * The legacy/unused columns (`trainer_name`, `jockey_name`, `finish_position`,
 * `betfair_sp`, `official_sp`) are deliberately NOT written — they are
 * preserved in the database exactly as they are, and populating them would
 * create a second source of truth for data the active columns already hold.
 * Settlement fields (`finish_pos`, `sp_decimal`, `bsp_decimal`) are owned by
 * the results path and are untouched here.
 */
export interface RunnerUpsert {
  horse_name: string;
  trainer: string | null;
  jockey: string | null;
  draw: number | null;
  saddlecloth: number | null;
  official_rating: number | null;
  weight_lbs: number | null;
  runner_status: string;
  /** External Racing API horse id. */
  provider_horse_id: string | null;
  /** External Racing API trainer id (column already existed, unpopulated). */
  trainer_id: string | null;
  /** External Racing API jockey id (column already existed, unpopulated). */
  jockey_id: string | null;
  /** Runner age in years (column already existed, unpopulated). */
  age: number | null;
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

  const raceName =
    (card.race_name ?? '(unknown race)').trim() || '(unknown race)';
  const slug = raceSlug(resolved.offTimeIso, card.race_name);

  return {
    // --- unchanged since before Programme 0 ---
    meeting_date: resolved.meetingDate,
    course,
    country: (card.region ?? 'GB').trim() || 'GB',
    race_name: raceName,
    off_time: resolved.offTimeIso,
    handicap_flag: isHandicap(card.race_name, card.race_class),
    status: 'scheduled',

    // --- Programme 0: provider identity ---
    provider_race_id: trimmedOrNull(card.race_id),
    provider_course_id: trimmedOrNull(card.course_id),

    // --- Programme 0: route identity ---
    course_key: courseKey(course) || null,
    race_slug: slug === '' ? null : slug,

    // --- Programme 0: card attributes previously discarded ---
    race_type: trimmedOrNull(card.type),
    distance_f: toNumberOrNull(card.distance_f),
    // Only a genuine provider display string is stored. The numeric furlongs
    // value is NOT reformatted into prose here — inventing display wording in
    // ingestion is exactly the fabrication this pipeline forbids.
    distance: trimmedOrNull(card.distance_round),
    going: trimmedOrNull(card.going),
    race_class: trimmedOrNull(card.race_class),
    age_band: trimmedOrNull(card.age_band),
    pattern: trimmedOrNull(card.pattern),
    field_size: toNumberOrNull(card.field_size),
    // Reached only for a NON-abandoned card (abandoned cards return null
    // above), so this records the provider's explicit `false` and stays null
    // when the card said nothing at all.
    is_abandoned: typeof card.is_abandoned === 'boolean' ? card.is_abandoned : null,
  };
}

/**
 * Which provider field a card's off time came from, or null when it has none.
 *
 * Deliberately NOT a field on {@link RaceUpsert}: every key of that interface
 * becomes a column in the `races` insert, and there is no such column. This is
 * provenance for the off-time observer, not stored race data.
 */
export function racecardOffTimeSource(card: StandardRacecard): OffTimeSource | null {
  return resolveOffTime(card.off_dt, card.date, card.off_time)?.source ?? null;
}

/** Maps a standard-racecard runner to a `runners` upsert row. */
export function racecardRunnerToUpsert(
  runner: StandardRacecardRunner,
): RunnerUpsert | null {
  const horse = (runner.horse ?? '').trim();
  if (horse === '') return null;
  return {
    // --- unchanged since before Programme 0 ---
    horse_name: horse,
    trainer: (runner.trainer ?? '').trim() || null,
    jockey: (runner.jockey ?? '').trim() || null,
    draw: toNumberOrNull(runner.draw),
    saddlecloth: toNumberOrNull(runner.number),
    official_rating: toNumberOrNull(runner.ofr),
    weight_lbs: toNumberOrNull(runner.lbs),
    runner_status: 'declared',

    // --- Programme 0: provider identity + three existing empty columns ---
    provider_horse_id: trimmedOrNull(runner.horse_id),
    trainer_id: trimmedOrNull(runner.trainer_id),
    jockey_id: trimmedOrNull(runner.jockey_id),
    age: toNumberOrNull(runner.age),
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
