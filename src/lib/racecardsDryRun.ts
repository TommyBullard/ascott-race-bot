/**
 * Racecard mapping DRY RUN — preview what Programme 0 ingestion WOULD capture,
 * without writing anything.
 *
 * WHY THIS EXISTS. The controlled-ingestion preflight established that this
 * repository had no genuine racecard dry-run: `pipeline:day --dry-run` prints
 * URLs and contacts nothing, so it cannot show whether the Programme 0 columns
 * would actually be populated by a real card. The only way to find that out was
 * to perform the write. This module closes that gap: it fetches the SAME
 * racecards endpoint real ingestion uses, runs the SAME mapping functions, and
 * reports aggregate counts — then stops.
 *
 * WHAT THIS PERFORMS:
 *   - one racecards fetch (`/racecards/standard`, or `/racecards/free` on the
 *     basic tier / a Standard-plan fallback), through the SAME
 *     {@link RacingApiClient} used by `liveSync.syncRacecards`;
 *   - the real mappers `racecardToRaceUpsert` / `racecardRunnerToUpsert` from
 *     `raceSync.ts` — no mapping rule is restated here;
 *   - SELECT-only reads through {@link RacecardsDryRunReadSeam}, purely to tell
 *     a planned insert apart from a row that already exists.
 *
 * WHAT THIS NEVER PERFORMS: no insert, update, upsert, delete, rpc or storage
 * call; no `cron_runs` heartbeat; no producer claim acquire/heartbeat/release;
 * no API route invocation; no odds, results, tipster or model call; no lock and
 * no settlement. There is no `--commit` flag anywhere in this feature, and the
 * read seam below declares no method that could mutate anything.
 *
 * WHAT THE NUMBERS MEAN. Everything reported is a PLANNED action measured
 * against database state at read time. It is not a promise: rows may be
 * inserted by another process between this preview and any later authorised
 * commit, and the provider may reissue a card with corrected details.
 *
 * IDENTITY CAVEAT (inherited, not introduced). Race resolution still matches on
 * (course, off_time) and runner resolution on a normalised horse name, exactly
 * as `liveSync` does. `provider_race_id` is CAPTURED by Programme 0 but is read
 * by no lookup, so the same provider race arriving with a corrected off time
 * still counts as NEW here — because it would in fact insert a second row. This
 * preview reproduces current behaviour; it does not improve on it.
 *
 * OUTPUT IS IDENTIFIER-FREE. Every field of {@link RacecardsDryRunReport} is a
 * count, a fixed label, a day/date scope or warning prose built only from
 * counts. No course, race, horse or provider identifier — and no provider-
 * supplied date — is carried, so neither the console nor `--json` can leak one.
 * Failure output is redacted separately; see {@link redactPreviewDetail}.
 *
 * Decision-support only. Nothing here places, recommends or settles a bet.
 */

import {
  isStandardPlanRequiredError,
  type RacecardsQuery,
  type RacecardsTier,
  type RacingApiClient,
  type StandardRacecard,
} from './racingApi';
import {
  normalizeHorseName,
  racecardRunnerToUpsert,
  racecardToRaceUpsert,
  type RaceUpsert,
  type RunnerUpsert,
} from './raceSync';
import { resolveCronMeetingDate } from './cronDate';
import { redactErrorDetail } from './nationwideWriteBoundaryAudit';

/** Bumped only when the report shape changes in a way a consumer would notice. */
export const RACECARDS_DRY_RUN_SCHEMA_VERSION = 2;

/**
 * The region scope previewed. Mirrors `liveSync`'s `DEFAULT_REGIONS` (which is
 * module-private there and cannot be imported) so the preview covers exactly the
 * cards real ingestion would fetch. Behaviour parity is asserted by test.
 */
export const RACECARDS_DRY_RUN_REGIONS: readonly string[] = ['gb', 'ire'];

/**
 * The only day scopes that exist. The Racing API serves today's and tomorrow's
 * racecards and nothing else, so an arbitrary calendar date is not a thing this
 * command can honestly offer — it is rejected rather than silently coerced.
 */
export type PreviewDay = 'today' | 'tomorrow';

/** True only for an exact, lower-case `today` / `tomorrow`. */
export function isPreviewDay(value: unknown): value is PreviewDay {
  return value === 'today' || value === 'tomorrow';
}

/* ========================================================================== *
 * Failure redaction (review finding M-1)
 * ========================================================================== */

/**
 * Provider handle shapes used by The Racing API (`rac_`, `crs_`, `hrs_`,
 * `trn_`, `jck_`). These are the identifiers an error BODY can carry, and the
 * shared {@link redactErrorDetail} deliberately does not know about them — it
 * was written for database errors. Scrubbing them here ADDS one pattern rather
 * than restating the shared credential logic.
 */
const PROVIDER_HANDLE_RE = /\b(?:rac|crs|hrs|trn|jck|hor)_[A-Za-z0-9_-]*/gi;

/** Hard ceiling on any printed failure detail, tighter than the shared helper's. */
export const MAX_PREVIEW_DETAIL_LENGTH = 120;

/** Pulls `{ code, message }` out of an Error, a string, or a PostgREST object. */
function errorParts(error: unknown): { code: string | null; message: string } {
  if (error instanceof Error) return { code: null, message: error.message };
  if (typeof error === 'string') return { code: null, message: error };
  if (error && typeof error === 'object') {
    const e = error as { code?: unknown; message?: unknown };
    return {
      code: typeof e.code === 'string' ? e.code : null,
      message: typeof e.message === 'string' ? e.message : '',
    };
  }
  return { code: null, message: '' };
}

/**
 * Turns any thrown value into a SHORT, SECRET-FREE, IDENTIFIER-FREE fragment.
 *
 * Layered deliberately, and in this order:
 *   1. provider handles (`rac_…`, `hrs_…`, …) -> `[id]`, before any truncation
 *      can split one in half;
 *   2. the shared, dependency-free {@link redactErrorDetail} — credential
 *      keywords and their values, JWT-shaped values, ANY url, Supabase key
 *      prefixes, whitespace collapse, and its own length cap;
 *   3. a tighter {@link MAX_PREVIEW_DETAIL_LENGTH} ceiling, because a Racing API
 *      failure appends up to 300 characters of provider-controlled response
 *      body and a bounded fragment is the only honest thing to print.
 *
 * RESIDUAL, STATED PLAINLY: free-text inside a provider error body — a race or
 * course name, say — is not pattern-detectable and cannot be scrubbed by rule.
 * The mitigations are the tight length ceiling above and the design decision
 * that operational CONTEXT comes from {@link PreviewFailureStage}, never from
 * this fragment. Never print a raw `err.message` in its place.
 *
 * Pure: no I/O, no throwing, deterministic.
 */
export function redactPreviewDetail(error: unknown): string {
  const { code, message } = errorParts(error);
  const scrubbed = message.replace(PROVIDER_HANDLE_RE, '[id]');
  const scrubbedCode = code === null ? null : code.replace(PROVIDER_HANDLE_RE, '[id]');
  let detail = redactErrorDetail({ code: scrubbedCode, message: scrubbed });
  if (detail.length > MAX_PREVIEW_DETAIL_LENGTH) {
    detail = `${detail.slice(0, MAX_PREVIEW_DETAIL_LENGTH)}…`;
  }
  return detail === '' ? 'unknown error' : detail;
}

/** Which step failed. This — not the redacted detail — carries the context. */
export type PreviewFailureStage =
  | 'provider_racecards_fetch'
  | 'existing_race_date_count'
  | 'existing_race_lookup'
  | 'existing_runner_lookup'
  | 'unclassified';

const STAGE_LABELS: Record<PreviewFailureStage, string> = {
  provider_racecards_fetch: 'provider racecards fetch',
  existing_race_date_count: 'existing-race count for the selected date',
  existing_race_lookup: 'existing-race lookup',
  existing_runner_lookup: 'existing-runner lookup',
  unclassified: 'unclassified',
};

/** Human label for a stage. */
export function previewStageLabel(stage: PreviewFailureStage): string {
  return STAGE_LABELS[stage];
}

/**
 * A preview failure carrying a stage and an ALREADY-REDACTED detail.
 *
 * `message` is itself built from the redacted detail, so even a caller that
 * ignores this class and prints `err.message` cannot emit raw provider or
 * PostgREST text. The original error is deliberately NOT attached as `cause`:
 * an unredacted payload hanging off the object is exactly what finding M-1 was
 * about, and nothing downstream needs it.
 */
export class RacecardsDryRunFailure extends Error {
  readonly stage: PreviewFailureStage;
  readonly detail: string;

  constructor(stage: PreviewFailureStage, detail: string) {
    super(`${STAGE_LABELS[stage]} failed: ${detail}`);
    this.name = 'RacecardsDryRunFailure';
    this.stage = stage;
    this.detail = detail;
    // Keeps `instanceof` reliable regardless of the compiled target.
    Object.setPrototypeOf(this, RacecardsDryRunFailure.prototype);
  }

  /** Wraps any thrown value, redacting it once, at the boundary. */
  static from(stage: PreviewFailureStage, error: unknown): RacecardsDryRunFailure {
    if (error instanceof RacecardsDryRunFailure) return error;
    return new RacecardsDryRunFailure(stage, redactPreviewDetail(error));
  }
}

/** Classifies any thrown value into a stage + redacted detail. Never throws. */
export function describePreviewFailure(error: unknown): {
  stage: PreviewFailureStage;
  detail: string;
} {
  if (error instanceof RacecardsDryRunFailure) {
    return { stage: error.stage, detail: error.detail };
  }
  return { stage: 'unclassified', detail: redactPreviewDetail(error) };
}

/**
 * The operator-facing failure block. Counts and fixed text only; the single
 * variable fragment has already been through {@link redactPreviewDetail}.
 */
export function renderPreviewFailure(error: unknown): string[] {
  const { stage, detail } = describePreviewFailure(error);
  return [
    'RACECARDS DRY RUN FAILED',
    'NO DATABASE WRITES OCCURRED',
    '',
    `  Stage  : ${previewStageLabel(stage)}`,
    `  Detail : ${detail}`,
    '',
    'The failure detail is redacted: credentials, URLs, tokens and provider identifiers',
    'are removed and the text is truncated. Nothing was read beyond the stage above, and',
    'nothing was written anywhere.',
  ];
}

/* ========================================================================== *
 * SELECT-only read seam
 * ========================================================================== */

/** An existing `races` row, reduced to the columns the current lookup uses. */
export interface ExistingRaceRow {
  id: string;
  course: string | null;
  /** Whatever the database rendered; compared as an INSTANT, never as text. */
  off_time: string | null;
}

/** An existing `runners` row, reduced to the columns the current lookup uses. */
export interface ExistingRunnerRow {
  race_id: string;
  horse_name: string | null;
}

/**
 * The database surface this preview is allowed to touch.
 *
 * READ-ONLY BY CONSTRUCTION: every method returns rows or a count, and there is
 * deliberately no insert/update/upsert/delete/rpc member for an implementation
 * to supply. A caller cannot mutate through this interface because the type
 * offers no way to express a mutation — the guarantee is structural, not a
 * matter of operator discipline. A test asserts the method list, so a future
 * write method cannot be added quietly.
 */
export interface RacecardsDryRunReadSeam {
  /** `select count(*) from races where meeting_date = <date>`. */
  countRacesForDate(date: string): Promise<number>;
  /** Races whose `off_time` matches any of these instants (course filtered in memory). */
  findRacesByOffTimes(offTimes: readonly string[]): Promise<ExistingRaceRow[]>;
  /** Runners belonging to the given race ids. */
  findRunnersForRaces(raceIds: readonly string[]): Promise<ExistingRunnerRow[]>;
}

/** Everything the preview needs, injected so tests run offline. */
export interface RacecardsDryRunDeps {
  client: RacingApiClient;
  reads: RacecardsDryRunReadSeam;
  /** Which racecards endpoint to request; resolved from config by the CLI. */
  tier: RacecardsTier;
  /** "Now", for resolving the selected UTC date. Injected for determinism. */
  now: Date;
  /** Optional progress logger; never receives a secret or an identifier. */
  onProgress?: (message: string) => void;
}

/* ========================================================================== *
 * Report shape — AGGREGATES ONLY
 * ========================================================================== */

/**
 * Populated-field counts for the mapped race rows. Keys are the real
 * {@link RaceUpsert} field names, so renaming a mapped column breaks typecheck
 * here rather than silently reporting a stale field.
 */
export type RaceFieldCoverage = Record<(typeof RACE_COVERAGE_FIELDS)[number], number>;

/** Populated-field counts for the mapped runner rows. */
export type RunnerFieldCoverage = Record<(typeof RUNNER_COVERAGE_FIELDS)[number], number>;

/**
 * The Programme 0 race columns worth measuring. Every entry is a key of
 * {@link RaceUpsert}; the `satisfies` clause below makes that a compile error if
 * one is misspelled or removed from the mapper.
 */
export const RACE_COVERAGE_FIELDS = [
  'provider_race_id',
  'provider_course_id',
  'course_key',
  'race_slug',
  'race_type',
  'going',
  'distance',
  'distance_f',
  'race_class',
  'age_band',
  'pattern',
  'field_size',
  'is_abandoned',
] as const satisfies readonly (keyof RaceUpsert)[];

/** The Programme 0 runner columns worth measuring. Keys of {@link RunnerUpsert}. */
export const RUNNER_COVERAGE_FIELDS = [
  'provider_horse_id',
  'trainer_id',
  'jockey_id',
  'age',
  'draw',
  'official_rating',
  'weight_lbs',
  'trainer',
  'jockey',
] as const satisfies readonly (keyof RunnerUpsert)[];

/**
 * The whole preview result. Counts, percentages, a day/date scope and warning
 * text — and nothing else.
 */
export interface RacecardsDryRunReport {
  schema_version: number;
  day: PreviewDay;
  /** The UTC calendar date `day` resolves to, by the SAME rule the route uses. */
  selected_date: string;
  regions: readonly string[];
  tier_requested: RacecardsTier;
  tier_used: RacecardsTier;

  /** Empty-date gate. */
  existing_races_for_selected_date: number;
  first_capture_suitable: boolean;

  /**
   * Where the mapped rows would actually land (review finding M-2). The
   * database count above is scoped to `selected_date`; each planned insert
   * stores the MAPPER's `meeting_date`. These four aggregates make any
   * divergence visible WITHOUT printing a provider-supplied date.
   */
  mapped_dates_matching_selected: number;
  mapped_date_mismatch_count: number;
  mapped_date_missing_count: number;
  /** How many distinct destination dates the mapped rows target. Never the dates. */
  mapped_destination_date_count: number;

  /** Provider + mapping counts. */
  cards_returned: number;
  cards_skipped_abandoned: number;
  cards_skipped_invalid: number;
  races_mapped: number;

  /** Planned race actions, under current (course + off_time) matching. */
  races_planned_insert: number;
  races_existing: number;
  /**
   * Mapped cards suppressed from the planned-insert total because an EARLIER
   * card in the same response already planned that resolution key as new
   * (review finding L-1). Kept strictly distinct from `races_existing`, which
   * means "already stored in the database".
   */
  duplicate_cards_in_provider_response: number;

  /** Provider + mapping counts for runners (review finding L-2). */
  runner_records_returned: number;
  runner_records_on_mapped_races: number;
  runner_records_on_skipped_cards: number;
  runners_mapped: number;
  runners_skipped_invalid: number;

  /** Planned runner actions, under current normalised-horse-name matching. */
  runners_planned_insert: number;
  runners_existing: number;
  /**
   * Runners that would be matched against rows an EARLIER card in this same
   * response already planned to insert — not stored rows. Distinct from
   * `runners_existing` for the same reason as the race-level counter.
   */
  runners_matched_within_provider_response: number;

  race_field_coverage: RaceFieldCoverage;
  runner_field_coverage: RunnerFieldCoverage;

  warnings: readonly string[];
}

/* ========================================================================== *
 * Provider fetch — mirrors liveSync.fetchRacecards
 * ========================================================================== */

/**
 * Fetches racecards exactly as `liveSync.fetchRacecards` does: the basic tier
 * calls `/racecards/free` directly; the standard tier calls
 * `/racecards/standard` and falls back to the basic endpoint ONLY on a
 * "Standard Plan required" response, rethrowing every other error so a genuine
 * failure is never masked as an empty card list.
 *
 * This mirrors rather than imports because `liveSync`'s copy is module-private
 * and `liveSync` is deliberately not modified by this tranche. It duplicates no
 * response PARSING — both paths go through the same {@link RacingApiClient}
 * methods — and behaviour parity with the four branches above is asserted by
 * test.
 *
 * Errors propagate UNCHANGED from here; redaction happens once, at the
 * orchestration boundary in {@link runRacecardsDryRun}, so internal propagation
 * is never weakened.
 */
export async function fetchPreviewRacecards(
  client: RacingApiClient,
  params: RacecardsQuery,
  tier: RacecardsTier,
): Promise<{ cards: StandardRacecard[]; usedTier: RacecardsTier }> {
  if (tier === 'basic') {
    const res = await client.getBasicRacecards(params);
    return { cards: res.racecards ?? [], usedTier: 'basic' };
  }
  try {
    const res = await client.getStandardRacecards(params);
    return { cards: res.racecards ?? [], usedTier: 'standard' };
  } catch (err) {
    if (!isStandardPlanRequiredError(err)) throw err;
    const res = await client.getBasicRacecards(params);
    return { cards: res.racecards ?? [], usedTier: 'basic' };
  }
}

/* ========================================================================== *
 * Pure mapping pass
 * ========================================================================== */

/** One provider card after the real mapper ran on it. */
export interface MappedCard {
  card: StandardRacecard;
  race: RaceUpsert;
  runners: RunnerUpsert[];
  /** Runner records on this card the mapper could not map (blank horse name). */
  runnersSkipped: number;
}

/** The outcome of running the real mappers across every returned card. */
export interface MappingPass {
  mapped: MappedCard[];
  skippedAbandoned: number;
  skippedInvalid: number;
  runnerRecordsReturned: number;
  runnerRecordsOnMappedRaces: number;
  /** Runner records attached to cards the mapper skipped (review finding L-2). */
  runnerRecordsOnSkippedCards: number;
}

/**
 * Runs the REAL mappers over every card and classifies the skips.
 *
 * The skip DECISION is entirely the mapper's: a card is skipped precisely when
 * `racecardToRaceUpsert` returns null. Only the LABEL is decided here, by
 * reading the card's own `is_abandoned` flag — reporting why a skip happened is
 * not a mapping rule, and no mapping condition is restated in this function.
 *
 * Pure: no I/O, deterministic for a given card list.
 */
export function mapPreviewCards(cards: readonly StandardRacecard[]): MappingPass {
  const pass: MappingPass = {
    mapped: [],
    skippedAbandoned: 0,
    skippedInvalid: 0,
    runnerRecordsReturned: 0,
    runnerRecordsOnMappedRaces: 0,
    runnerRecordsOnSkippedCards: 0,
  };

  for (const card of cards) {
    const records = (card.runners ?? []).length;
    pass.runnerRecordsReturned += records;

    const race = racecardToRaceUpsert(card);
    if (!race) {
      // Runner records here belong to a card that would never be stored. They
      // stay in `runnerRecordsReturned` but must NOT enter the mapped-race
      // denominator, so they are counted separately rather than dropped.
      pass.runnerRecordsOnSkippedCards += records;
      if (card.is_abandoned === true) pass.skippedAbandoned += 1;
      else pass.skippedInvalid += 1;
      continue;
    }

    pass.runnerRecordsOnMappedRaces += records;

    const runners: RunnerUpsert[] = [];
    let runnersSkipped = 0;
    for (const runner of card.runners ?? []) {
      const mapped = racecardRunnerToUpsert(runner);
      if (mapped) runners.push(mapped);
      else runnersSkipped += 1;
    }

    pass.mapped.push({ card, race, runners, runnersSkipped });
  }

  return pass;
}

/** Populated = "not null and not undefined". `false` and `0` ARE populated. */
function isPopulated(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/** Counts populated Programme 0 fields across the mapped race rows. Pure. */
export function raceFieldCoverage(races: readonly RaceUpsert[]): RaceFieldCoverage {
  const out = {} as RaceFieldCoverage;
  for (const field of RACE_COVERAGE_FIELDS) {
    out[field] = races.reduce((n, race) => (isPopulated(race[field]) ? n + 1 : n), 0);
  }
  return out;
}

/** Counts populated Programme 0 fields across the mapped runner rows. Pure. */
export function runnerFieldCoverage(runners: readonly RunnerUpsert[]): RunnerFieldCoverage {
  const out = {} as RunnerFieldCoverage;
  for (const field of RUNNER_COVERAGE_FIELDS) {
    out[field] = runners.reduce((n, runner) => (isPopulated(runner[field]) ? n + 1 : n), 0);
  }
  return out;
}

/* ========================================================================== *
 * Destination-date accounting (review finding M-2)
 * ========================================================================== */

const MEETING_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Aggregate-only view of where the mapped rows would land. No date is carried. */
export interface DestinationDateSummary {
  matching: number;
  mismatched: number;
  missing: number;
  distinctDates: number;
}

/**
 * Compares each mapped row's `meeting_date` against the selected date.
 *
 * `existing_races_for_selected_date` counts `races.meeting_date =
 * selected_date`, but a planned insert stores the MAPPER's `meeting_date`
 * (derived from the card's own `date`, else the UTC date of the resolved
 * instant). If those diverge, the emptiness check covers a different date from
 * the one being written, and the suitability verdict would be wrong for the
 * diverging rows.
 *
 * `missing` is defensive: the current mapper always produces a well-formed
 * date, so it is structurally unreachable today. It exists so the invariant is
 * explicit rather than assumed, and so a future mapper change surfaces here
 * instead of being silently counted as a match.
 *
 * Returns COUNTS ONLY — the differing dates are deliberately not returned, so
 * no provider-supplied value can reach the report. Pure.
 */
export function summariseDestinationDates(
  races: readonly RaceUpsert[],
  selectedDate: string,
): DestinationDateSummary {
  const distinct = new Set<string>();
  let matching = 0;
  let mismatched = 0;
  let missing = 0;

  for (const race of races) {
    const date = race.meeting_date;
    if (typeof date !== 'string' || !MEETING_DATE_RE.test(date)) {
      missing += 1;
      continue;
    }
    distinct.add(date);
    if (date === selectedDate) matching += 1;
    else mismatched += 1;
  }

  return { matching, mismatched, missing, distinctDates: distinct.size };
}

/* ========================================================================== *
 * Existing-row matching — reproduces the CURRENT lookup, exactly
 * ========================================================================== */

/**
 * The match key for a race: raw `course` string plus the off time AS AN INSTANT.
 *
 * `liveSync.findRaceId` issues `.eq('course', course).eq('off_time', iso)`, and
 * Postgres compares `off_time` as a `timestamptz` — so `...T13:50:00+00:00` from
 * the database and `...T13:50:00.000Z` from the mapper are the SAME value there.
 * Comparing the two as strings in memory would wrongly report every existing
 * race as new, so the instant is reduced to epoch milliseconds. `course` is
 * compared verbatim, because that is what the SQL does.
 *
 * Returns null when the off time is unparseable — such a row can match nothing.
 */
export function raceMatchKey(
  course: string | null | undefined,
  offTime: string | null | undefined,
): string | null {
  if (typeof course !== 'string') return null;
  const ms = offTime ? Date.parse(offTime) : NaN;
  if (!Number.isFinite(ms)) return null;
  return `${course} ${ms}`;
}

/** Indexes existing race rows by {@link raceMatchKey}; first row wins, as `limit(1)` does. */
export function indexExistingRaces(rows: readonly ExistingRaceRow[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const row of rows) {
    const key = raceMatchKey(row.course, row.off_time);
    if (key !== null && !index.has(key)) index.set(key, String(row.id));
  }
  return index;
}

/** Groups existing runners into a per-race set of normalised horse names. */
export function indexExistingRunners(
  rows: readonly ExistingRunnerRow[],
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const row of rows) {
    const raceId = String(row.race_id);
    let set = index.get(raceId);
    if (!set) {
      set = new Set<string>();
      index.set(raceId, set);
    }
    set.add(normalizeHorseName(row.horse_name));
  }
  return index;
}

/* ========================================================================== *
 * Orchestration
 * ========================================================================== */

/** Wraps one awaited step so any failure carries its stage and is redacted once. */
async function atStage<T>(
  stage: PreviewFailureStage,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw RacecardsDryRunFailure.from(stage, err);
  }
}

/**
 * Runs the preview: fetch -> map -> read -> plan -> count.
 *
 * Throws a {@link RacecardsDryRunFailure} on a provider or database-read
 * failure — carrying the stage and an already-redacted detail — and never
 * swallows one into a misleading zero.
 *
 * DUPLICATE-CARD MODELLING (review finding L-1). Production resolves each race
 * INSIDE its card loop, so if two cards share a resolution key and the race is
 * absent, the first inserts and the second then FINDS it. This preview reads
 * the database once, so it tracks keys already planned as new in memory and
 * classifies the second card as a provider duplicate rather than a second
 * planned insert. No extra read, no write, no uuid.
 */
export async function runRacecardsDryRun(
  day: PreviewDay,
  deps: RacecardsDryRunDeps,
): Promise<RacecardsDryRunReport> {
  const log = deps.onProgress ?? (() => {});
  const selectedDate = resolveCronMeetingDate({ day }, deps.now).meetingDate;

  const { cards, usedTier } = await atStage('provider_racecards_fetch', () =>
    fetchPreviewRacecards(
      deps.client,
      { day, regionCodes: [...RACECARDS_DRY_RUN_REGIONS] },
      deps.tier,
    ),
  );
  log(`provider returned ${cards.length} cards`);

  const pass = mapPreviewCards(cards);
  log(`mapped ${pass.mapped.length} races`);

  const existingForDate = await atStage('existing_race_date_count', () =>
    deps.reads.countRacesForDate(selectedDate),
  );

  // Existing-race lookup, reproducing (course + off_time) matching.
  const offTimes = [...new Set(pass.mapped.map((m) => m.race.off_time))];
  const existingRaceRows =
    offTimes.length > 0
      ? await atStage('existing_race_lookup', () => deps.reads.findRacesByOffTimes(offTimes))
      : [];
  const raceIndex = indexExistingRaces(existingRaceRows);

  const matchedRaceIds = new Set<string>();
  for (const entry of pass.mapped) {
    const key = raceMatchKey(entry.race.course, entry.race.off_time);
    const id = key === null ? undefined : raceIndex.get(key);
    if (id !== undefined) matchedRaceIds.add(id);
  }

  // Existing-runner lookup, reproducing normalised-horse-name matching.
  const runnerRows =
    matchedRaceIds.size > 0
      ? await atStage('existing_runner_lookup', () =>
          deps.reads.findRunnersForRaces([...matchedRaceIds]),
        )
      : [];
  const storedRunnerNames = indexExistingRunners(runnerRows);

  // ---- Planning pass, in provider order (duplicate handling depends on it) ----
  let racesPlannedInsert = 0;
  let racesExisting = 0;
  let duplicateCards = 0;
  let runnersPlannedInsert = 0;
  let runnersExisting = 0;
  let runnersMatchedInResponse = 0;
  const allRunners: RunnerUpsert[] = [];

  /** Resolution keys an earlier card in THIS response already planned as new. */
  const plannedNewKeys = new Set<string>();
  /**
   * Names this preview has already planned to insert, per resolution key —
   * i.e. rows a later duplicate card would find, because production would by
   * then have inserted them. Seeded empty; stored names live separately.
   */
  const previewAddedNames = new Map<string, Set<string>>();

  for (const entry of pass.mapped) {
    const key = raceMatchKey(entry.race.course, entry.race.off_time);
    const storedId = key === null ? undefined : raceIndex.get(key);

    let stored: Set<string> | undefined;
    let added: Set<string>;

    if (storedId !== undefined) {
      // Already in the database. A second card for the same stored race is also
      // counted here, exactly as production would (both lookups find it).
      racesExisting += 1;
      stored = storedRunnerNames.get(storedId);
      added = previewAddedNames.get(storedId) ?? new Set<string>();
      previewAddedNames.set(storedId, added);
    } else if (key !== null && plannedNewKeys.has(key)) {
      duplicateCards += 1;
      added = previewAddedNames.get(key) ?? new Set<string>();
      previewAddedNames.set(key, added);
    } else {
      racesPlannedInsert += 1;
      if (key !== null) plannedNewKeys.add(key);
      added = new Set<string>();
      if (key !== null) previewAddedNames.set(key, added);
    }

    // Production reads the existing runner names ONCE, before inserting this
    // card's runners, so two identically-named runners on the SAME card are
    // both inserted. Reproduce that by collecting this card's additions and
    // merging them only after the card is finished.
    const addedByThisCard: string[] = [];
    for (const runner of entry.runners) {
      allRunners.push(runner);
      const name = normalizeHorseName(runner.horse_name);
      if (stored?.has(name)) runnersExisting += 1;
      else if (added.has(name)) runnersMatchedInResponse += 1;
      else {
        runnersPlannedInsert += 1;
        addedByThisCard.push(name);
      }
    }
    for (const name of addedByThisCard) added.add(name);
  }

  const dates = summariseDestinationDates(
    pass.mapped.map((m) => m.race),
    selectedDate,
  );

  const report: RacecardsDryRunReport = {
    schema_version: RACECARDS_DRY_RUN_SCHEMA_VERSION,
    day,
    selected_date: selectedDate,
    regions: [...RACECARDS_DRY_RUN_REGIONS],
    tier_requested: deps.tier,
    tier_used: usedTier,

    existing_races_for_selected_date: existingForDate,
    // Emptiness alone is NOT enough: every mapped row must also be destined for
    // the date that emptiness was measured on.
    first_capture_suitable:
      existingForDate === 0 && dates.mismatched === 0 && dates.missing === 0,

    mapped_dates_matching_selected: dates.matching,
    mapped_date_mismatch_count: dates.mismatched,
    mapped_date_missing_count: dates.missing,
    mapped_destination_date_count: dates.distinctDates,

    cards_returned: cards.length,
    cards_skipped_abandoned: pass.skippedAbandoned,
    cards_skipped_invalid: pass.skippedInvalid,
    races_mapped: pass.mapped.length,

    races_planned_insert: racesPlannedInsert,
    races_existing: racesExisting,
    duplicate_cards_in_provider_response: duplicateCards,

    runner_records_returned: pass.runnerRecordsReturned,
    runner_records_on_mapped_races: pass.runnerRecordsOnMappedRaces,
    runner_records_on_skipped_cards: pass.runnerRecordsOnSkippedCards,
    runners_mapped: allRunners.length,
    runners_skipped_invalid: pass.mapped.reduce((n, m) => n + m.runnersSkipped, 0),

    runners_planned_insert: runnersPlannedInsert,
    runners_existing: runnersExisting,
    runners_matched_within_provider_response: runnersMatchedInResponse,

    race_field_coverage: raceFieldCoverage(pass.mapped.map((m) => m.race)),
    runner_field_coverage: runnerFieldCoverage(allRunners),

    warnings: [],
  };

  return { ...report, warnings: buildWarnings(report) };
}

/**
 * Operator-facing warnings, derived only from the counts already in the report.
 * Pure, and free of identifiers — and of provider-supplied dates — by
 * construction.
 */
export function buildWarnings(report: RacecardsDryRunReport): string[] {
  const warnings: string[] = [];

  if (report.cards_returned === 0) {
    warnings.push('The provider returned no cards for this day. Nothing would be captured.');
  }
  if (report.tier_used !== report.tier_requested) {
    warnings.push(
      `Requested the ${report.tier_requested} racecards endpoint but the ${report.tier_used} ` +
        'endpoint served the cards. Programme 0 fields are unaffected (they come from the card, ' +
        'not the bundled odds), but the plan tier is not what was configured.',
    );
  }
  if (report.cards_skipped_invalid > 0) {
    warnings.push(
      `${report.cards_skipped_invalid} card(s) could not be mapped (blank course or unresolvable ` +
        'off time) and would be skipped by ingestion, not stored.',
    );
  }
  if (report.runners_skipped_invalid > 0) {
    warnings.push(
      `${report.runners_skipped_invalid} runner record(s) had no usable horse name and would be skipped.`,
    );
  }

  // --- destination-date divergence (M-2) --------------------------------------
  if (report.mapped_date_mismatch_count > 0) {
    warnings.push(
      `${report.mapped_date_mismatch_count} mapped race(s) would be stored under a meeting date ` +
        'OTHER than the selected date. The existing-race count above covers the selected date ' +
        'ONLY, so it does not tell you whether those destination dates are empty. This preview ' +
        'reads no further dates; the cards are still counted and nothing about them is discarded.',
    );
  }
  if (report.mapped_date_missing_count > 0) {
    warnings.push(
      `${report.mapped_date_missing_count} mapped race(s) produced no well-formed meeting date, ` +
        'so their destination cannot be checked against the selected date at all.',
    );
  }
  if (report.mapped_destination_date_count > 1) {
    warnings.push(
      `Mapped races target ${report.mapped_destination_date_count} distinct destination dates. ` +
        'First-capture verification assumes a single empty destination date.',
    );
  }

  if (!report.first_capture_suitable) {
    if (report.existing_races_for_selected_date > 0) {
      warnings.push(
        `${report.existing_races_for_selected_date} race(s) already exist for the selected date. ` +
          'Ingestion never UPDATES an existing race row, so those rows would NOT gain Programme 0 fields.',
      );
    }
  }
  if (report.races_existing > 0) {
    warnings.push(
      `${report.races_existing} mapped race(s) already exist under (course + off_time) matching and ` +
        'would be reused unchanged — their Programme 0 columns would stay as they are.',
    );
  }

  // --- provider duplicates (L-1) ---------------------------------------------
  if (report.duplicate_cards_in_provider_response > 0) {
    warnings.push(
      `${report.duplicate_cards_in_provider_response} card(s) in this response resolve to a key an ` +
        'earlier card already planned as new. They are NOT counted as additional planned inserts, ' +
        'matching ingestion, which would find the row it had just created.',
    );
  }

  const identity: readonly (keyof RaceFieldCoverage)[] = [
    'provider_race_id',
    'course_key',
    'race_slug',
  ];
  for (const field of identity) {
    const populated = report.race_field_coverage[field];
    if (report.races_mapped > 0 && populated < report.races_mapped) {
      warnings.push(
        `${report.races_mapped - populated} mapped race(s) would store a null ${field}. ` +
          'Null means "never recorded" and is never backfilled.',
      );
    }
  }

  return warnings;
}

/* ========================================================================== *
 * Rendering
 * ========================================================================== */

/** `n/total (xx.x%)`, or `n/0 (n/a)` when there is nothing to divide by. */
export function coverageLine(label: string, populated: number, total: number): string {
  const pct = total > 0 ? `${((populated / total) * 100).toFixed(1)}%` : 'n/a';
  return `    ${label.padEnd(22)} ${String(populated).padStart(5)} / ${total} (${pct})`;
}

/**
 * Human-readable console output. Counts, percentages and fixed text only — no
 * course, horse, race or provider identifier, and no provider-supplied date, is
 * available to this function, because the report does not carry one.
 */
export function renderRacecardsDryRunConsole(report: RacecardsDryRunReport): string[] {
  const lines: string[] = [];

  lines.push('RACECARDS DRY RUN');
  lines.push('NO DATABASE WRITES');
  lines.push('NO PRODUCER CLAIM');
  lines.push('NO ODDS, MODEL, LOCK OR RESULT ACTION');
  lines.push('');

  lines.push(`Day scope            : ${report.day}`);
  lines.push(`Selected date (UTC)  : ${report.selected_date}`);
  lines.push(`Regions              : ${report.regions.join(', ')}`);
  lines.push(
    `Racecards endpoint   : requested ${report.tier_requested}, served by ${report.tier_used}`,
  );
  lines.push('');

  lines.push('FIRST-CAPTURE SUITABILITY');
  lines.push(`  Existing races stored for the selected date : ${report.existing_races_for_selected_date}`);
  lines.push(`  Mapped races destined for the selected date : ${report.mapped_dates_matching_selected}`);
  lines.push(`  Mapped races destined for another date      : ${report.mapped_date_mismatch_count}`);
  lines.push(`  Mapped races with no usable meeting date    : ${report.mapped_date_missing_count}`);
  lines.push(`  Distinct destination dates                  : ${report.mapped_destination_date_count}`);
  lines.push(
    report.first_capture_suitable
      ? '  Status : SUITABLE FOR FIRST-CAPTURE VERIFICATION (selected date empty; every mapped race targets it)'
      : '  Status : NOT SUITABLE FOR FIRST-CAPTURE VERIFICATION',
  );
  if (!report.first_capture_suitable) {
    lines.push(
      '  Ingestion inserts a race only when the lookup misses; it never updates an existing',
    );
    lines.push(
      '  row. Races already stored would NOT gain Programme 0 fields from a run, and the count',
    );
    lines.push(
      '  above covers the selected date only — not any other destination date shown here.',
    );
  }
  lines.push('');

  lines.push('PROVIDER AND MAPPING');
  lines.push(`  Cards returned                        : ${report.cards_returned}`);
  lines.push(`  Skipped, abandoned                    : ${report.cards_skipped_abandoned}`);
  lines.push(`  Skipped, unmappable                   : ${report.cards_skipped_invalid}`);
  lines.push(`  Valid mapped races                    : ${report.races_mapped}`);
  lines.push('');

  lines.push('RUNNER RECORD ACCOUNTING');
  lines.push(`  All runner records returned           : ${report.runner_records_returned}`);
  lines.push(`  ...attached to skipped cards          : ${report.runner_records_on_skipped_cards}`);
  lines.push(`  ...on mapped races (the denominator)  : ${report.runner_records_on_mapped_races}`);
  lines.push(`  Valid mapped runners                  : ${report.runners_mapped}`);
  lines.push(`  Invalid runners skipped on mapped races: ${report.runners_skipped_invalid}`);
  lines.push('');

  lines.push('PLANNED RACE ACTIONS (course + off_time matching)');
  lines.push(`  Would appear NEW                      : ${report.races_planned_insert}`);
  lines.push(`  Already existing in the database      : ${report.races_existing}`);
  lines.push(`  Duplicate cards in this response      : ${report.duplicate_cards_in_provider_response}`);
  lines.push('');

  lines.push('PLANNED RUNNER ACTIONS (normalised horse-name matching)');
  lines.push(`  Would appear NEW                      : ${report.runners_planned_insert}`);
  lines.push(`  Already existing in the database      : ${report.runners_existing}`);
  lines.push(`  Matched a row planned earlier here    : ${report.runners_matched_within_provider_response}`);
  lines.push('');

  lines.push(`PROGRAMME 0 RACE FIELD COVERAGE (of ${report.races_mapped} mapped races)`);
  for (const field of RACE_COVERAGE_FIELDS) {
    lines.push(coverageLine(field, report.race_field_coverage[field], report.races_mapped));
  }
  lines.push('');

  lines.push(`PROGRAMME 0 RUNNER FIELD COVERAGE (of ${report.runners_mapped} mapped runners)`);
  for (const field of RUNNER_COVERAGE_FIELDS) {
    lines.push(coverageLine(field, report.runner_field_coverage[field], report.runners_mapped));
  }
  lines.push('');

  lines.push(`WARNINGS (${report.warnings.length})`);
  if (report.warnings.length === 0) lines.push('  none');
  for (const warning of report.warnings) lines.push(`  - ${warning}`);
  lines.push('');

  lines.push(
    'This is a preview. Database state and provider data may change before a separately',
  );
  lines.push('authorised commit run.');

  return lines;
}
