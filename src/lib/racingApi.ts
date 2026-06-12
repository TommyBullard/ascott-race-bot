/**
 * The Racing API adapter — turns REAL trainer/jockey performance into tipster
 * "signals" for the discovery pipeline.
 *
 * This is the first (and only) configured external data source for tipster
 * discovery. It is deliberately ToS-compliant: it uses the official, paid
 * Racing API (https://www.theracingapi.com) over its documented HTTP endpoints.
 * It does NOT scrape paywalled proofing sites.
 *
 * INTEGRITY CONTRACT — NEVER FABRICATE:
 * Every number a signal carries comes verbatim from an API response. We only
 * ever SUM additive quantities the API already reported (runs/rides, wins, and
 * 1pt profit/loss) and divide to express ROI / strike rate. Fields the analysis
 * endpoints do not provide (e.g. a true overall A/E, or a losing streak) are
 * NOT invented: streak is reported as 0 (a neutral needle signal) and A/E is
 * omitted. An entity with no SP-settled runs in the long window yields NO
 * signal at all rather than a guessed one.
 *
 * AUTH (matches the SUPABASE pattern in supabaseAdmin.ts — read from process):
 *   RACING_API_USER  -> HTTP Basic username
 *   RACING_API_KEY   -> HTTP Basic password
 * Credentials are validated lazily, at request time, so importing this module
 * never throws and `next build` can statically analyse routes that import it.
 *
 * SHAPE (verified against the OpenAPI spec at api.theracingapi.com, 2026-06):
 *   GET /v1/racecards/free?day=today|tomorrow&region_codes=gb&region_codes=ire
 *     -> { racecards: [{ runners: [{ trainer, trainer_id, jockey, jockey_id }] }] }
 *   GET /v1/trainers/{id}/analysis/courses?start_date=&end_date=
 *     -> { trainer, total_runners, courses: [{ runners, "1st", "a/e", "win_%", "1_pl" }] }
 *   GET /v1/jockeys/{id}/analysis/courses?start_date=&end_date=
 *     -> { jockey, total_rides, courses: [{ rides, "1st", "a/e", "win_%", "1_pl" }] }
 * Every run happens at a course, so summing the per-course rows over a date
 * window covers all SP-settled runs in that window.
 *
 * RATE LIMITS: 5 req/s on paid plans, with a Cloudflare cooling-off if you
 * exceed ~100 requests / 10s. All requests go through a serial throttle that
 * keeps us comfortably under that.
 */

import type { TipsterSource, TipsterWindowedStats } from './discoverTipsters';

/** Base URL for the v1 API. */
const BASE_URL = 'https://api.theracingapi.com/v1';

/** The `source` label stamped on every signal this adapter produces. */
export const RACING_API_SOURCE = 'The Racing API';

/** Min gap between requests: < 4 req/s, safely under the 5 req/s cap. */
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 260;

// --- API response shapes (only the fields we read) -------------------------

/**
 * One row of a trainer/jockey analysis breakdown. Trainers report `runners`;
 * jockeys report `rides` — both mean "number of runs in this group". Quoted
 * keys mirror the API verbatim (`"1st"`, `"a/e"`, `"win_%"`, `"1_pl"`).
 */
export interface AnalysisCourseRow {
  course?: string;
  course_id?: string;
  region?: string;
  /** Trainer runs in this group. */
  runners?: number;
  /** Jockey rides in this group. */
  rides?: number;
  '1st'?: number;
  '2nd'?: number;
  '3rd'?: number;
  '4th'?: number;
  /** Actual/expected wins (not summable across groups; we never aggregate it). */
  'a/e'?: number;
  /** Win fraction for this group (0.18 = 18%). */
  'win_%'?: number;
  /** 1pt level-stakes profit/loss at SP for this group's runs. */
  '1_pl'?: number;
}

/** Response of `GET /v1/trainers/{id}/analysis/courses`. */
export interface TrainerAnalysisResponse {
  id?: string;
  trainer?: string;
  total_runners?: number;
  courses?: AnalysisCourseRow[];
}

/** Response of `GET /v1/jockeys/{id}/analysis/courses`. */
export interface JockeyAnalysisResponse {
  id?: string;
  jockey?: string;
  total_rides?: number;
  courses?: AnalysisCourseRow[];
}

/** A runner on a racecard (only the connections we enumerate IDs from). */
export interface RacecardRunner {
  trainer?: string;
  trainer_id?: string;
  jockey?: string;
  jockey_id?: string;
}

/** A racecard (one race). */
export interface Racecard {
  runners?: RacecardRunner[];
}

/** Response of `GET /v1/racecards/free`. */
export interface RacecardsResponse {
  racecards?: Racecard[];
}

// --- Standard racecards + results (live-pipeline shapes) -------------------
// Verified against the OpenAPI spec (RacecardOdds / ResultStandard), 2026-06.

/** One bookmaker price on a standard-racecard runner. Quoted decimal price. */
export interface RacecardOddsEntry {
  bookmaker?: string;
  /** Decimal price as a string, e.g. "6.5". */
  decimal?: string;
  fractional?: string;
}

/** A runner on a `/racecards/standard` card (only the fields we persist). */
export interface StandardRacecardRunner {
  horse_id?: string;
  horse?: string;
  /** Saddlecloth number (string in the API). */
  number?: string;
  draw?: string;
  /** Weight carried in lbs (string in the API). */
  lbs?: string;
  /** Official rating (string in the API). */
  ofr?: string;
  age?: string;
  trainer?: string;
  trainer_id?: string;
  jockey?: string;
  jockey_id?: string;
  /** Per-bookmaker prices; INCLUDES a "Betfair Exchange" entry for UK/IRE. */
  odds?: RacecardOddsEntry[];
}

/** A race on `/racecards/standard`. `off_dt` is a full ISO timestamp w/ offset. */
export interface StandardRacecard {
  race_id?: string;
  course?: string;
  course_id?: string;
  /** Calendar date, YYYY-MM-DD. */
  date?: string;
  /** Local off time, e.g. "13:50". */
  off_time?: string;
  /** Full ISO off datetime, e.g. "2026-06-12T13:50:00+01:00". */
  off_dt?: string;
  race_name?: string;
  region?: string;
  race_class?: string;
  type?: string;
  age_band?: string;
  going?: string;
  distance_f?: string;
  distance_round?: string;
  field_size?: string;
  pattern?: string;
  is_abandoned?: boolean;
  runners?: StandardRacecardRunner[];
}

/** Response of `GET /v1/racecards/standard`. */
export interface RacecardsStandardResponse {
  racecards?: StandardRacecard[];
  total?: number;
}

/** A runner on a `/results` race (RunnerStandard). Carries BSP + finishing pos. */
export interface ResultRunner {
  horse_id?: string;
  horse?: string;
  /** Finishing position as a string, e.g. "1". Non-numeric for non-finishers. */
  position?: string;
  /** Industry SP as a decimal string, e.g. "8.50". */
  sp_dec?: string;
  /** Betfair SP as a decimal string, e.g. "11.26" (may be empty/absent). */
  bsp?: string;
  number?: string;
  draw?: string;
  jockey?: string;
  jockey_id?: string;
  trainer?: string;
  trainer_id?: string;
}

/** A settled race on `/results` (ResultStandard). */
export interface ResultRace {
  race_id?: string;
  date?: string;
  region?: string;
  course?: string;
  course_id?: string;
  /** Local off time, e.g. "8:25". */
  off?: string;
  /** Full ISO off datetime. */
  off_dt?: string;
  race_name?: string;
  runners?: ResultRunner[];
}

/** Response of `GET /v1/results` (ResultsStandardPage). */
export interface ResultsResponse {
  results?: ResultRace[] | null;
  total?: number;
}

/** Query for `/racecards/standard`. */
export interface RacecardsQuery {
  day?: 'today' | 'tomorrow';
  regionCodes?: string[];
}

/** Query for `/results`. */
export interface ResultsQuery {
  startDate?: string;
  endDate?: string;
  regionCodes?: string[];
  limit?: number;
  skip?: number;
}

/** Shared query for the analysis endpoints. */
export interface AnalysisQuery {
  startDate?: string;
  endDate?: string;
  region?: string;
}

/**
 * The minimal client surface the adapter depends on. Kept as an interface so
 * tests can inject a fake (no network) and the adapter logic is exercised on
 * fixtures.
 */
export interface RacingApiClient {
  getFreeRacecards(params: {
    day: 'today' | 'tomorrow';
    regionCodes?: string[];
  }): Promise<RacecardsResponse>;
  getTrainerCourseAnalysis(
    trainerId: string,
    params: AnalysisQuery,
  ): Promise<TrainerAnalysisResponse>;
  getJockeyCourseAnalysis(
    jockeyId: string,
    params: AnalysisQuery,
  ): Promise<JockeyAnalysisResponse>;
  /** `/racecards/standard` — today's/tomorrow's cards incl. runner odds (Standard plan). */
  getStandardRacecards(params: RacecardsQuery): Promise<RacecardsStandardResponse>;
  /** `/results` — settled races incl. finishing position, SP and BSP (Standard plan). */
  getResults(params: ResultsQuery): Promise<ResultsResponse>;
}

// --- Credentials + low-level transport -------------------------------------

/** Reads + validates the Racing API credentials at call time (lazy). */
function getCredentials(): { username: string; password: string } {
  const username = process.env.RACING_API_USER;
  const password = process.env.RACING_API_KEY;
  if (!username) {
    throw new Error('Missing environment variable: RACING_API_USER');
  }
  if (!password) {
    throw new Error('Missing environment variable: RACING_API_KEY');
  }
  return { username, password };
}

/** Builds the HTTP Basic `Authorization` header value. */
function basicAuthHeader(username: string, password: string): string {
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  return `Basic ${token}`;
}

// Serial throttle: requests are awaited one at a time in the adapter, so a
// single module-level timestamp is enough to space them out.
let lastRequestAt = 0;
async function throttle(minIntervalMs: number): Promise<void> {
  const wait = Math.max(0, lastRequestAt + minIntervalMs - Date.now());
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestAt = Date.now();
}

/**
 * Low-level GET against the API. Throws a descriptive error on any non-2xx so
 * an unexpected shape/auth/plan problem surfaces loudly (this repo has lost
 * hours to silent empty reads — we never want a quiet 0-row failure here).
 */
async function racingApiGet<T>(
  path: string,
  query: Record<string, string | string[] | number | undefined>,
  fetchImpl: typeof fetch,
  minIntervalMs: number,
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  const { username, password } = getCredentials();
  await throttle(minIntervalMs);

  const res = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: basicAuthHeader(username, password),
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const snippet = body.slice(0, 300);
    if (res.status === 401) {
      throw new Error(
        `Racing API 401 Unauthorized for ${path} — check RACING_API_USER / ` +
          `RACING_API_KEY and that your plan includes this endpoint ` +
          `(analysis endpoints require at least the Standard plan). ${snippet}`,
      );
    }
    if (res.status === 429) {
      throw new Error(
        `Racing API 429 rate-limited for ${path} — slow down; a cooling-off ` +
          `may apply if you exceeded ~100 requests / 10s. ${snippet}`,
      );
    }
    throw new Error(`Racing API ${res.status} for ${path}: ${snippet}`);
  }

  return (await res.json()) as T;
}

/**
 * Builds the default, network-backed client. Inject a custom `fetchImpl` (or a
 * whole fake `RacingApiClient`) in tests to run the adapter offline.
 */
export function createRacingApiClient(
  fetchImpl: typeof fetch = fetch,
  minIntervalMs: number = DEFAULT_MIN_REQUEST_INTERVAL_MS,
): RacingApiClient {
  return {
    getFreeRacecards: ({ day, regionCodes }) =>
      racingApiGet<RacecardsResponse>(
        '/racecards/free',
        { day, region_codes: regionCodes },
        fetchImpl,
        minIntervalMs,
      ),
    getTrainerCourseAnalysis: (trainerId, { startDate, endDate, region }) =>
      racingApiGet<TrainerAnalysisResponse>(
        `/trainers/${encodeURIComponent(trainerId)}/analysis/courses`,
        { start_date: startDate, end_date: endDate, region },
        fetchImpl,
        minIntervalMs,
      ),
    getJockeyCourseAnalysis: (jockeyId, { startDate, endDate, region }) =>
      racingApiGet<JockeyAnalysisResponse>(
        `/jockeys/${encodeURIComponent(jockeyId)}/analysis/courses`,
        { start_date: startDate, end_date: endDate, region },
        fetchImpl,
        minIntervalMs,
      ),
    getStandardRacecards: ({ day, regionCodes }) =>
      racingApiGet<RacecardsStandardResponse>(
        '/racecards/standard',
        { day, region_codes: regionCodes },
        fetchImpl,
        minIntervalMs,
      ),
    getResults: ({ startDate, endDate, regionCodes, limit, skip }) =>
      racingApiGet<ResultsResponse>(
        '/results',
        {
          start_date: startDate,
          end_date: endDate,
          region: regionCodes,
          limit,
          skip,
        },
        fetchImpl,
        minIntervalMs,
      ),
  };
}

// --- Pure helpers (aggregation + mapping; unit-tested on fixtures) ----------

/** Coerces an unknown numeric field to a finite number, else 0. */
function toFiniteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** A trainer/jockey's summed performance over a date window. */
export interface AnalysisAggregate {
  /** Total runs/rides (the REAL sample size N that drives reliability). */
  runs: number;
  /** Total wins (sum of "1st"). */
  wins: number;
  /** Total 1pt level-stakes profit/loss at SP (sum of "1_pl"). */
  profitLoss: number;
}

/**
 * Sums the additive quantities across a breakdown. `runners` (trainer) and
 * `rides` (jockey) both count runs, so we read whichever is present. Nothing is
 * invented — non-numeric/missing fields contribute 0.
 */
export function aggregateAnalysisRows(
  rows: AnalysisCourseRow[] | undefined,
): AnalysisAggregate {
  let runs = 0;
  let wins = 0;
  let profitLoss = 0;
  for (const row of rows ?? []) {
    runs += toFiniteNumber(row.runners ?? row.rides);
    wins += toFiniteNumber(row['1st']);
    profitLoss += toFiniteNumber(row['1_pl']);
  }
  return { runs, wins, profitLoss };
}

/** 1pt P/L per bet as a decimal ROI (Σ1_pl / Σruns). 0 when there are no runs. */
export function roiFromAggregate(agg: AnalysisAggregate): number {
  return agg.runs > 0 ? agg.profitLoss / agg.runs : 0;
}

/** Win fraction in [0, 1] (Σ1st / Σruns). 0 when there are no runs. */
export function strikeRateFromAggregate(agg: AnalysisAggregate): number {
  return agg.runs > 0 ? agg.wins / agg.runs : 0;
}

/** Whether this signal is for a trainer or a jockey. */
export type EntityKind = 'trainer' | 'jockey';

/**
 * Maps a set of windowed aggregates to one `TipsterWindowedStats` signal.
 *
 * - `longRunRoi`   <- long-window ROI (the long-run signal)
 * - `recentRoi30d` <- recent-window ROI (the momentum signal)
 * - `recentRoi7d`  <- short-window ROI, only when that window had runs
 * - `strikeRate`   <- long-window strike rate
 * - `betsCount`    <- long-window runs/rides (the REAL N)
 * - `winsCount`    <- long-window wins
 * - `longestLosingStreak` is 0: the analysis endpoints don't expose a streak,
 *   so we report a neutral value rather than inventing one. A/E is intentionally
 *   omitted (not cleanly summable across groups).
 */
export function mapAggregatesToSignal(params: {
  name: string;
  kind: EntityKind;
  longRun: AnalysisAggregate;
  recent30: AnalysisAggregate;
  recent7?: AnalysisAggregate;
}): TipsterWindowedStats {
  const { name, kind, longRun, recent30, recent7 } = params;
  const recentRoi7d =
    recent7 && recent7.runs > 0 ? roiFromAggregate(recent7) : undefined;
  return {
    name: `${name.trim()} (${kind})`,
    source: RACING_API_SOURCE,
    affiliation: kind,
    longRunRoi: roiFromAggregate(longRun),
    recentRoi30d: roiFromAggregate(recent30),
    recentRoi7d,
    strikeRate: strikeRateFromAggregate(longRun),
    longestLosingStreak: 0,
    betsCount: longRun.runs,
    winsCount: longRun.wins,
  };
}

/** A distinct trainer/jockey discovered on a racecard, ranked by runner count. */
export interface EntityRef {
  id: string;
  name: string;
  runnerCount: number;
}

/**
 * Collects distinct trainers + jockeys from racecard pages, counting how many
 * runners each connects today (a proxy for "most relevant right now"). Pure.
 */
export function collectEntitiesFromRacecards(pages: RacecardsResponse[]): {
  trainers: EntityRef[];
  jockeys: EntityRef[];
} {
  const trainers = new Map<string, EntityRef>();
  const jockeys = new Map<string, EntityRef>();

  const bump = (map: Map<string, EntityRef>, id?: string, name?: string) => {
    if (!id) return;
    const existing = map.get(id);
    if (existing) {
      existing.runnerCount += 1;
      if (existing.name === existing.id && name) existing.name = name;
    } else {
      map.set(id, { id, name: name ?? id, runnerCount: 1 });
    }
  };

  for (const page of pages) {
    for (const card of page.racecards ?? []) {
      for (const runner of card.runners ?? []) {
        bump(trainers, runner.trainer_id, runner.trainer);
        bump(jockeys, runner.jockey_id, runner.jockey);
      }
    }
  }

  const sortDesc = (map: Map<string, EntityRef>) =>
    [...map.values()].sort(
      (a, b) => b.runnerCount - a.runnerCount || a.id.localeCompare(b.id),
    );

  return { trainers: sortDesc(trainers), jockeys: sortDesc(jockeys) };
}

// --- Adapter ---------------------------------------------------------------

/** Options controlling enumeration scope and the analysis windows. */
export interface FetchSignalsOptions {
  /** Racecard days to enumerate entities from (default both). */
  days?: ('today' | 'tomorrow')[];
  /** Region codes to scope racecards to (default GB + IRE). */
  regionCodes?: string[];
  /** Cap on trainers fetched, by runner count (default 80). */
  maxTrainers?: number;
  /** Cap on jockeys fetched, by runner count (default 80). */
  maxJockeys?: number;
  /** Long-run window length in days (default 365). */
  longWindowDays?: number;
  /** Recent (momentum) window length in days (default 30). */
  recentWindowDays?: number;
  /** Short window in days for the 7d/today signal; null disables it (default 7). */
  shortWindowDays?: number | null;
  /** "Now" for window math; injectable for deterministic tests. */
  now?: Date;
  /** Optional progress logger. */
  onProgress?: (message: string) => void;
}

/** Formats a UTC date as YYYY-MM-DD. */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Computes a `[start, end]` window of `days` length ending today (UTC),
 * returned as YYYY-MM-DD strings the analysis endpoints accept.
 */
export function windowDates(
  now: Date,
  days: number,
): { startDate: string; endDate: string } {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { startDate: formatDate(start), endDate: formatDate(end) };
}

/**
 * Fetches REAL tipster signals from The Racing API:
 *   1. enumerate the trainers/jockeys with runners on today's/tomorrow's cards,
 *   2. for each (capped, ranked by runner count) pull windowed course-analysis,
 *   3. aggregate the per-course rows and map to a `TipsterWindowedStats`.
 *
 * Entities with no SP-settled runs in the long window are skipped (no signal),
 * never fabricated. Returns the signal rows; feed them to `discoverTipsters`.
 */
export async function fetchRacingApiSignals(
  options: FetchSignalsOptions = {},
  client: RacingApiClient = createRacingApiClient(),
): Promise<TipsterWindowedStats[]> {
  const days = options.days ?? ['today', 'tomorrow'];
  const regionCodes = options.regionCodes ?? ['gb', 'ire'];
  const maxTrainers = options.maxTrainers ?? 80;
  const maxJockeys = options.maxJockeys ?? 80;
  const longWindowDays = options.longWindowDays ?? 365;
  const recentWindowDays = options.recentWindowDays ?? 30;
  const shortWindowDays =
    options.shortWindowDays === undefined ? 7 : options.shortWindowDays;
  const now = options.now ?? new Date();
  const log = options.onProgress ?? (() => {});

  // 1. Enumerate active entities from racecards.
  const pages: RacecardsResponse[] = [];
  for (const day of days) {
    pages.push(await client.getFreeRacecards({ day, regionCodes }));
  }
  const { trainers, jockeys } = collectEntitiesFromRacecards(pages);
  const pickedTrainers = trainers.slice(0, maxTrainers);
  const pickedJockeys = jockeys.slice(0, maxJockeys);
  log(
    `enumerated ${trainers.length} trainers / ${jockeys.length} jockeys; ` +
      `using top ${pickedTrainers.length} / ${pickedJockeys.length}`,
  );

  const longW = windowDates(now, longWindowDays);
  const recentW = windowDates(now, recentWindowDays);
  const shortW = shortWindowDays != null ? windowDates(now, shortWindowDays) : null;

  const signals: TipsterWindowedStats[] = [];

  // 2. Trainers.
  for (const trainer of pickedTrainers) {
    const longRes = await client.getTrainerCourseAnalysis(trainer.id, {
      startDate: longW.startDate,
      endDate: longW.endDate,
    });
    const longRun = aggregateAnalysisRows(longRes.courses);
    if (longRun.runs <= 0) continue; // no SP-settled data -> no signal

    const recent30 = aggregateAnalysisRows(
      (
        await client.getTrainerCourseAnalysis(trainer.id, {
          startDate: recentW.startDate,
          endDate: recentW.endDate,
        })
      ).courses,
    );
    const recent7 = shortW
      ? aggregateAnalysisRows(
          (
            await client.getTrainerCourseAnalysis(trainer.id, {
              startDate: shortW.startDate,
              endDate: shortW.endDate,
            })
          ).courses,
        )
      : undefined;

    signals.push(
      mapAggregatesToSignal({
        name: longRes.trainer ?? trainer.name,
        kind: 'trainer',
        longRun,
        recent30,
        recent7,
      }),
    );
  }

  // 3. Jockeys.
  for (const jockey of pickedJockeys) {
    const longRes = await client.getJockeyCourseAnalysis(jockey.id, {
      startDate: longW.startDate,
      endDate: longW.endDate,
    });
    const longRun = aggregateAnalysisRows(longRes.courses);
    if (longRun.runs <= 0) continue;

    const recent30 = aggregateAnalysisRows(
      (
        await client.getJockeyCourseAnalysis(jockey.id, {
          startDate: recentW.startDate,
          endDate: recentW.endDate,
        })
      ).courses,
    );
    const recent7 = shortW
      ? aggregateAnalysisRows(
          (
            await client.getJockeyCourseAnalysis(jockey.id, {
              startDate: shortW.startDate,
              endDate: shortW.endDate,
            })
          ).courses,
        )
      : undefined;

    signals.push(
      mapAggregatesToSignal({
        name: longRes.jockey ?? jockey.name,
        kind: 'jockey',
        longRun,
        recent30,
        recent7,
      }),
    );
  }

  log(`built ${signals.length} signals`);
  return signals;
}

/**
 * Wraps the adapter as a {@link TipsterSource} so it can run through the same
 * `discoverFromSources` path as any other (future) source.
 */
export function racingApiTipsterSource(
  options: FetchSignalsOptions = {},
  client?: RacingApiClient,
): TipsterSource {
  return {
    key: 'the_racing_api',
    name: RACING_API_SOURCE,
    fetchLeaderboard: () =>
      fetchRacingApiSignals(options, client ?? createRacingApiClient()),
  };
}
