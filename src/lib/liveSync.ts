/**
 * Live-pipeline DB orchestration: turns Racing API / Betfair responses into
 * idempotent writes to races / runners / market_snapshots / runner_quotes, and
 * applies results + re-runs the model.
 *
 * Pure transforms live in `raceSync.ts`; this module is the I/O layer used by
 * the three cron routes. Every value persisted comes from an API response —
 * missing data is stored as NULL, never invented.
 *
 * IMPORTANT: this pipeline does NOT populate `tipster_selections`. The model
 * therefore runs MARKET-ONLY (no tipster weighting) until tips are supplied
 * separately (e.g. the loader / a future tipster feed). `runModelForRace`
 * handles empty tipster data gracefully.
 */

import { randomUUID } from 'node:crypto';

import { supabaseAdmin } from './supabaseAdmin';
import { runModelForRace } from './runModelForRace';
import {
  createRacingApiClient,
  isStandardPlanRequiredError,
  resolveRacecardsTier,
  type RacingApiClient,
  type RacecardsTier,
  type ResultRace,
  type StandardRacecard,
} from './racingApi';
import {
  settleTodayResults,
  shouldUseTodayFallback,
} from './todayResultsSettlement';
import type { ResultSource } from './autoResults';
import {
  createBetfairExchangeClient,
  extractBackPrice,
  toMatchableMarket,
  type BetfairExchangeClient,
} from './betfairExchange';
import {
  PIPELINE_SOURCE,
  BETFAIR_QUOTE_TYPE,
  indexRunnersByName,
  matchMarketToRace,
  normalizeHorseName,
  racecardOffTimeSource,
  racecardRunnerToUpsert,
  racecardToRaceUpsert,
  resolveOffTime,
  resultRunnerToUpdate,
  type RaceUpsert,
} from './raceSync';
import { resolveCronMeetingDate } from './cronDate';
import {
  OFF_TIME_OBSERVER_RACECARDS,
  emptyOffTimeObservationSummary,
  recordOffTimeObservations,
  type ObservedOffTime,
} from './offTimeObservation';

/** UK + Irish region codes for The Racing API. */
const DEFAULT_REGIONS = ['gb', 'ire'];

/** YYYY-MM-DD for `now` in UTC. */
function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Finds an existing race by (course, off_time ISO); returns its id or null. */
async function findRaceId(course: string, offTimeIso: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('races')
    .select('id')
    .eq('course', course)
    .eq('off_time', offTimeIso)
    .limit(1);
  if (error) throw new Error(`races lookup failed: ${error.message}`);
  const row = (data ?? [])[0] as { id: string } | undefined;
  return row ? String(row.id) : null;
}

/* -------------------------------------------------------------------------- */
/* Provider-id-first race resolution                                          */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when a provider race id resolves to MORE THAN ONE stored race.
 *
 * The `races_provider_race_id_idx` index is partial and deliberately NON-unique
 * — uniqueness is a claim about data the first enriched cohort (25 races) is
 * far too small to justify asserting in the schema. So duplication is possible
 * in principle, and when it happens canonical resolution is genuinely
 * ambiguous: picking a row arbitrarily would attach a whole runner cohort to
 * the wrong race. This fails closed instead, and asks for a human.
 *
 * The message deliberately carries NO provider id value.
 */
export class AmbiguousProviderRaceError extends Error {
  constructor() {
    super(
      'races provider-id resolution is AMBIGUOUS: more than one stored race carries this ' +
        'provider race id. Refusing to insert, update, or fall back to (course, off_time) — ' +
        'canonical identity cannot be decided automatically and needs operator investigation.',
    );
    this.name = 'AmbiguousProviderRaceError';
    Object.setPrototypeOf(this, AmbiguousProviderRaceError.prototype);
  }
}

/**
 * The two lookups race resolution needs, injected so the DECISION is unit
 * testable with no database. The live implementations are wired below.
 */
export interface RaceResolutionLookups {
  /** Every stored race id carrying this provider race id (capped at 2 by the caller). */
  findIdsByProviderRaceId(providerRaceId: string): Promise<string[]>;
  /** The pre-existing (course, off_time) lookup, semantics unchanged. */
  findIdByCourseAndOffTime(course: string, offTimeIso: string): Promise<string | null>;
}

/** The minimal projection of a mapped race row resolution reads. */
export type ResolvableRace = Pick<RaceUpsert, 'provider_race_id' | 'course' | 'off_time'>;

/**
 * Resolves a mapped racecard to an EXISTING race id, provider identity first.
 *
 *   1. a non-null `provider_race_id` is looked up first. Exactly one match
 *      returns that row's internal uuid and the fallback is NOT consulted;
 *      more than one match throws {@link AmbiguousProviderRaceError};
 *   2. a null provider id, or zero provider-id matches, falls through to the
 *      UNCHANGED raw (course, off_time) lookup — which is what still resolves
 *      the 719 historical rows that predate capture;
 *   3. null means neither found anything, and the caller inserts.
 *
 * RESOLUTION ONLY. This function reads; it never writes. In particular a
 * historical row matched by the fallback keeps its null `provider_race_id`:
 * stamping an external identity onto a row matched only by a collision-prone
 * natural key would be a guess, and a wrong guess is unrecoverable. Backfill,
 * if it ever happens, is a separate evidenced decision.
 *
 * Course-key resolution is deliberately NOT used here — that would be a second
 * behavioural change in one tranche.
 */
export async function resolveExistingRaceId(
  raceRow: ResolvableRace,
  lookups: RaceResolutionLookups,
): Promise<string | null> {
  const providerRaceId = raceRow.provider_race_id;
  // The mapper already maps blank provider strings to null; the empty check is
  // defensive so a future mapper change cannot turn '' into a wildcard lookup.
  if (typeof providerRaceId === 'string' && providerRaceId !== '') {
    const ids = await lookups.findIdsByProviderRaceId(providerRaceId);
    if (ids.length > 1) throw new AmbiguousProviderRaceError();
    if (ids.length === 1) return ids[0];
  }
  return lookups.findIdByCourseAndOffTime(raceRow.course, raceRow.off_time);
}

/**
 * Removes a provider id value from a driver error string.
 *
 * PostgREST can echo a filter value back in its message, and this is the one
 * lookup whose filter value is an external identifier we have promised not to
 * print. Plain string replacement, so no regex escaping is involved. Pure.
 */
export function scrubProviderId(message: string, providerRaceId: string): string {
  if (providerRaceId === '') return message;
  return message.split(providerRaceId).join('[provider-id]');
}

/** The live, Supabase-backed lookups. SELECT-only; neither method writes. */
const supabaseRaceResolutionLookups: RaceResolutionLookups = {
  async findIdsByProviderRaceId(providerRaceId: string): Promise<string[]> {
    // limit(2) is enough to tell "none" from "exactly one" from "more than
    // one", without fetching a whole duplicate set we would refuse anyway.
    const { data, error } = await supabaseAdmin
      .from('races')
      .select('id')
      .eq('provider_race_id', providerRaceId)
      .limit(2);
    if (error) {
      throw new Error(
        `races provider-id lookup failed: ${scrubProviderId(error.message, providerRaceId)}`,
      );
    }
    return ((data ?? []) as { id: string }[]).map((r) => String(r.id));
  },
  findIdByCourseAndOffTime: (course, offTimeIso) => findRaceId(course, offTimeIso),
};

export interface RacecardsSyncSummary {
  cardsFetched: number;
  racesInserted: number;
  racesExisting: number;
  runnersInserted: number;
  skipped: number;
  /** Which racecards endpoint actually produced the cards ('standard'|'basic'). */
  tier: RacecardsTier;
  /**
   * Off-time integrity counters. A resolved race whose provider off time has
   * moved was previously indistinguishable from an unchanged one — it was just
   * `racesExisting++`. These make the divergence visible in the route response
   * and in the `cron_runs` heartbeat, which is where an operator can alarm on
   * it. Recording never affects ingestion: it fails open to zero.
   */
  offTimeDivergencesObserved: number;
  offTimeTighteningObservations: number;
  offTimeObservationsRecorded: number;
  offTimeObservationErrors: number;
}

/**
 * Fetches racecards honouring the configured tier, with a SAFE fallback:
 *  - `basic`: calls the basic/free endpoint directly (works on any plan; no odds).
 *  - `standard` (default): calls `/racecards/standard`; if the plan lacks it
 *    ("Standard Plan required"), logs a hint and falls back to the basic
 *    endpoint. Any OTHER error (bad credentials, rate limit, network) is
 *    rethrown — never masked.
 *
 * Returns the cards plus which tier actually produced them. Basic cards have NO
 * bundled odds, which does not affect racecard ingestion (it writes only races +
 * runners; odds are sourced separately by the Betfair odds pipeline).
 */
async function fetchRacecards(
  client: RacingApiClient,
  params: { day: 'today' | 'tomorrow'; regionCodes: string[] },
  tier: RacecardsTier,
): Promise<{ cards: StandardRacecard[]; usedTier: RacecardsTier }> {
  if (tier === 'basic') {
    console.info(
      '[racecards] Using BASIC racecards endpoint (/racecards/free) — no odds ' +
        '(RACING_API_RACECARDS_TIER=basic).',
    );
    const res = await client.getBasicRacecards(params);
    return { cards: res.racecards ?? [], usedTier: 'basic' };
  }

  try {
    const res = await client.getStandardRacecards(params);
    return { cards: res.racecards ?? [], usedTier: 'standard' };
  } catch (err) {
    if (!isStandardPlanRequiredError(err)) throw err;
    console.warn(
      '[racecards] /racecards/standard requires the Standard plan; falling back ' +
        'to the basic endpoint (/racecards/free). Basic cards carry NO odds — the ' +
        'model still prices from the Betfair odds pipeline. Set ' +
        'RACING_API_RACECARDS_TIER=basic to skip this attempt.',
    );
    const res = await client.getBasicRacecards(params);
    return { cards: res.racecards ?? [], usedTier: 'basic' };
  }
}

/**
 * Pulls today's standard racecards and upserts races (status='scheduled') +
 * their runners. Idempotent: a race already present (course+off_time) is reused
 * and its status is NOT downgraded; only runners missing by normalised name are
 * inserted, so re-running mid-day never duplicates.
 *
 * Endpoint tier follows `options.tier` ?? `RACING_API_RACECARDS_TIER` ??
 * 'standard'. On the standard tier, a "Standard Plan required" response falls
 * back to the basic endpoint automatically (see {@link fetchRacecards}).
 */
export async function syncRacecards(
  options: {
    day?: 'today' | 'tomorrow';
    regionCodes?: string[];
    tier?: RacecardsTier;
    /**
     * The race date the CALLING producer actually owns, as the route already
     * resolves it for the ownership guard. A card outside this scope is
     * recorded `out_of_scope_meeting_date` and can never tighten anything —
     * without it the observation write would sit in a loop with no date filter,
     * widening the ownership boundary this design declares inviolable.
     */
    meetingDate?: string;
  } = {},
  client: RacingApiClient = createRacingApiClient(),
): Promise<RacecardsSyncSummary> {
  const day = options.day ?? 'today';
  const regionCodes = options.regionCodes ?? DEFAULT_REGIONS;
  const tier =
    options.tier ?? resolveRacecardsTier(process.env.RACING_API_RACECARDS_TIER);
  const summary: RacecardsSyncSummary = {
    cardsFetched: 0,
    racesInserted: 0,
    racesExisting: 0,
    runnersInserted: 0,
    skipped: 0,
    tier,
    ...emptyOffTimeObservationSummary(),
  };
  /**
   * Observations collected during the existing card loop, for RESOLVED races
   * only — a newly inserted race cannot diverge from itself. Zero extra I/O
   * here: every value is already in hand.
   */
  const offTimeObservations: ObservedOffTime[] = [];

  const { cards, usedTier } = await fetchRacecards(
    client,
    { day, regionCodes },
    tier,
  );
  summary.tier = usedTier;
  summary.cardsFetched = cards.length;

  for (const card of cards) {
    const raceRow = racecardToRaceUpsert(card);
    if (!raceRow) {
      summary.skipped++;
      continue;
    }

    // Provider identity first, (course, off_time) as the historical fallback.
    let raceId = await resolveExistingRaceId(raceRow, supabaseRaceResolutionLookups);
    if (raceId) {
      summary.racesExisting++;
      // The resolved row keeps its stored off_time; the freshly mapped one is
      // evidence, never a write. Recorded after the loop, in one batch.
      const offTimeSource = racecardOffTimeSource(card);
      if (offTimeSource !== null) {
        offTimeObservations.push({
          race_id: raceId,
          provider_race_id: raceRow.provider_race_id,
          off_time_iso: raceRow.off_time,
          meeting_date: raceRow.meeting_date,
          source_field: offTimeSource,
        });
      }
    } else {
      raceId = randomUUID();
      const { error } = await supabaseAdmin.from('races').insert({ id: raceId, ...raceRow });
      if (error) throw new Error(`races insert failed: ${error.message}`);
      summary.racesInserted++;
    }

    // Existing runners for this race, to insert only the missing ones.
    const { data: existing, error: exErr } = await supabaseAdmin
      .from('runners')
      .select('id, horse_name')
      .eq('race_id', raceId);
    if (exErr) throw new Error(`runners lookup failed: ${exErr.message}`);
    const present = new Set(
      ((existing ?? []) as { horse_name: string }[]).map((r) =>
        normalizeHorseName(r.horse_name),
      ),
    );

    const toInsert = (card.runners ?? [])
      .map(racecardRunnerToUpsert)
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .filter((r) => !present.has(normalizeHorseName(r.horse_name)))
      .map((r) => ({ id: randomUUID(), race_id: raceId, ...r }));

    if (toInsert.length > 0) {
      const { error } = await supabaseAdmin.from('runners').insert(toInsert);
      if (error) throw new Error(`runners insert failed: ${error.message}`);
      summary.runnersInserted += toInsert.length;
    }
  }

  // Off-time integrity: record any divergence between the stored off and the
  // provider's current one, as immutable evidence. This NEVER writes `races`
  // and NEVER throws — a failure degrades to exactly today's behaviour. The
  // loop's own throws above are unchanged and can still abort a card.
  const scopeMeetingDate =
    options.meetingDate ?? resolveCronMeetingDate({ day }).meetingDate;
  Object.assign(
    summary,
    await recordOffTimeObservations(
      offTimeObservations,
      scopeMeetingDate,
      new Date().toISOString(),
      OFF_TIME_OBSERVER_RACECARDS,
    ),
  );

  return summary;
}

export interface OddsSyncSummary {
  /** The meeting date (YYYY-MM-DD, UTC) whose races were considered. */
  meetingDate: string;
  racesConsidered: number;
  marketsMatched: number;
  snapshotsWritten: number;
  quotesWritten: number;
  unmatchedRaces: number;
}

/**
 * Polls Betfair Exchange for a meeting day's UK/IRE win markets and writes a
 * fresh market_snapshot + runner_quotes for each of that day's not-yet-settled
 * races it can match. Snapshots are intentionally append-only time-series (the
 * model reads the latest), so each 5-min run adds one snapshot per matched race;
 * re-running within a run never double-writes a race.
 *
 * The target meeting day defaults to today (UTC); pass `options.meetingDate`
 * (YYYY-MM-DD) to target another day (e.g. tomorrow / a specific date). The
 * meeting date drives BOTH the race query and the Betfair market time window;
 * `now` remains the real poll time stamped on each snapshot, so targeting a
 * future day still records when the odds were actually captured.
 *
 * Matching is fuzzy by design (course + off-time for the market, normalised
 * horse name for the runner); unmatched races/runners are SKIPPED, never guessed.
 */
export async function syncOddsFromBetfair(
  now: Date = new Date(),
  client: BetfairExchangeClient = createBetfairExchangeClient(),
  options: { meetingDate?: string } = {},
): Promise<OddsSyncSummary> {
  const meetingDate = options.meetingDate ?? todayUtc(now);
  const summary: OddsSyncSummary = {
    meetingDate,
    racesConsidered: 0,
    marketsMatched: 0,
    snapshotsWritten: 0,
    quotesWritten: 0,
    unmatchedRaces: 0,
  };

  // The target day's not-yet-settled races.
  const { data: raceData, error: raceErr } = await supabaseAdmin
    .from('races')
    .select('id, course, off_time, status')
    .eq('meeting_date', meetingDate)
    .neq('status', 'result');
  if (raceErr) throw new Error(`races fetch failed: ${raceErr.message}`);
  const races = (raceData ?? []) as {
    id: string;
    course: string;
    off_time: string;
    status: string;
  }[];
  summary.racesConsidered = races.length;
  if (races.length === 0) return summary;

  // Betfair's win markets across the target meeting day (UTC bounds).
  const fromIso = `${meetingDate}T00:00:00Z`;
  const toIso = `${meetingDate}T23:59:59Z`;
  const catalogues = (
    await client.listTodaysWinMarkets({ fromIso, toIso })
  ).map(toMatchableMarket);

  // Match each race to a market, collect the markets we need a book for.
  const matched: {
    race: (typeof races)[number];
    market: ReturnType<typeof toMatchableMarket>;
  }[] = [];
  for (const race of races) {
    const market = matchMarketToRace(
      { course: race.course, offTimeIso: new Date(race.off_time).toISOString() },
      catalogues,
    );
    if (market && market.marketId) matched.push({ race, market });
    else summary.unmatchedRaces++;
  }
  summary.marketsMatched = matched.length;
  if (matched.length === 0) return summary;

  const books = await client.listMarketBooks(matched.map((m) => m.market.marketId));
  const bookById = new Map(books.map((b) => [b.marketId ?? '', b]));

  for (const { race, market } of matched) {
    const book = bookById.get(market.marketId);
    if (!book) continue;

    // selectionId -> price, and our runners indexed by normalised name.
    const priceBySelection = new Map<number, number>();
    for (const r of book.runners ?? []) {
      const price = extractBackPrice(r);
      if (r.selectionId != null && price != null) priceBySelection.set(r.selectionId, price);
    }

    const { data: runnerData, error: runnersErr } = await supabaseAdmin
      .from('runners')
      .select('id, horse_name')
      .eq('race_id', race.id);
    if (runnersErr) throw new Error(`runners fetch failed: ${runnersErr.message}`);
    const runnerIdByName = indexRunnersByName(
      (runnerData ?? []) as { id: string; horse_name: string }[],
    );

    // Build quotes: catalogue runner name -> our runner; selectionId -> price.
    const snapshotId = randomUUID();
    const quotes: {
      id: string;
      snapshot_id: string;
      runner_id: string;
      quote_type: string;
      odds_decimal: number;
    }[] = [];
    for (const catRunner of market.runners) {
      if (catRunner.selectionId == null) continue;
      const price = priceBySelection.get(catRunner.selectionId);
      if (price == null) continue;
      const runnerId = runnerIdByName.get(normalizeHorseName(catRunner.runnerName));
      if (!runnerId) continue;
      quotes.push({
        id: randomUUID(),
        snapshot_id: snapshotId,
        runner_id: runnerId,
        quote_type: BETFAIR_QUOTE_TYPE,
        odds_decimal: price,
      });
    }
    if (quotes.length === 0) continue;

    const { error: snapErr } = await supabaseAdmin.from('market_snapshots').insert({
      id: snapshotId,
      race_id: race.id,
      snapshot_time: now.toISOString(),
      source_label: BETFAIR_QUOTE_TYPE,
    });
    if (snapErr) throw new Error(`market_snapshots insert failed: ${snapErr.message}`);
    const { error: quotesErr } = await supabaseAdmin.from('runner_quotes').insert(quotes);
    if (quotesErr) throw new Error(`runner_quotes insert failed: ${quotesErr.message}`);
    summary.snapshotsWritten++;
    summary.quotesWritten += quotes.length;
  }

  return summary;
}

export interface ResultsSyncSummary {
  resultsFetched: number;
  racesSettled: number;
  runnersUpdated: number;
  unmatchedRaces: number;
  modelRerun: number;
  /**
   * Which results source produced this settlement: the Standard `/v1/results`
   * primary, or a same-day today fallback (`today_basic` / `today_free`) used when
   * the primary is plan-blocked for today. Optional/additive.
   */
  resultSource?: ResultSource;
}

/**
 * Pulls today's settled results, writes finish_pos + bsp_decimal + sp_decimal to
 * the matching runners, marks each matched race status='result', then re-runs
 * the model for ALL remaining unsettled races today so the next-race pick
 * refreshes. Idempotent: re-running rewrites the same result values.
 *
 * SAME-DAY FALLBACK: if the Standard `/v1/results` endpoint is plan-blocked AND
 * the meeting is today, it falls back to the Basic `/v1/results/today` endpoint,
 * then the Free `/v1/results/today/free`, settling via the shared idempotent,
 * conflict-gated, finish_pos-only writer (those tiers carry NO SP/BSP, so prices
 * are left null and never fabricated). Any other error is rethrown unchanged, so
 * the Standard-plan behaviour and real failures are preserved.
 */
export async function syncResults(
  now: Date = new Date(),
  client: RacingApiClient = createRacingApiClient(),
): Promise<ResultsSyncSummary> {
  const summary: ResultsSyncSummary = {
    resultsFetched: 0,
    racesSettled: 0,
    runnersUpdated: 0,
    unmatchedRaces: 0,
    modelRerun: 0,
  };
  const meetingDate = todayUtc(now);

  let results: ResultRace[];
  try {
    const res = await client.getResults({
      startDate: meetingDate,
      endDate: meetingDate,
      regionCodes: DEFAULT_REGIONS,
    });
    results = res.results ?? [];
  } catch (err) {
    // Only fall back when `/v1/results` is plan-blocked AND the meeting is today
    // (the today endpoints are today-only). Any other error is a real failure and
    // is rethrown so existing Standard-plan behaviour is preserved.
    if (!shouldUseTodayFallback(err, meetingDate, now)) throw err;
    // Settle from the same-day today endpoints (Basic `/v1/results/today` first,
    // then Free `/v1/results/today/free`) via the shared idempotent, conflict-
    // gated, finish_pos-only writer (never SP/BSP). Throws when BOTH are
    // unavailable, so the cron route surfaces a clear diagnostic.
    const settled = await settleTodayResults({ date: meetingDate, commit: true, client });
    summary.resultSource = settled.source;
    summary.resultsFetched = settled.freeResultsFound;
    summary.racesSettled = settled.committed.races;
    summary.runnersUpdated = settled.committed.runners;
    summary.unmatchedRaces = settled.pending.length;
    const refreshFallback = await refreshModelForMeeting(meetingDate);
    summary.modelRerun += refreshFallback.modelReran;
    return summary;
  }
  summary.resultSource = 'primary_standard';
  summary.resultsFetched = results.length;

  for (const race of results) {
    const course = (race.course ?? '').trim();
    const resolved = resolveOffTime(race.off_dt, race.date, race.off);
    if (course === '' || !resolved) {
      summary.unmatchedRaces++;
      continue;
    }
    const raceId = await findRaceId(course, resolved.offTimeIso);
    if (!raceId) {
      summary.unmatchedRaces++;
      continue;
    }

    // Our runners for this race, indexed by normalised name.
    const { data: runnerData, error: runnersErr } = await supabaseAdmin
      .from('runners')
      .select('id, horse_name')
      .eq('race_id', raceId);
    if (runnersErr) throw new Error(`runners fetch failed: ${runnersErr.message}`);
    const runnerIdByName = indexRunnersByName(
      (runnerData ?? []) as { id: string; horse_name: string }[],
    );

    for (const r of race.runners ?? []) {
      const update = resultRunnerToUpdate(r);
      if (!update) continue;
      const runnerId = runnerIdByName.get(update.matchKey);
      if (!runnerId) continue;
      const patch: Record<string, number | null> = {};
      if (update.finishPos !== null) patch.finish_pos = update.finishPos;
      if (update.bspDecimal !== null) patch.bsp_decimal = update.bspDecimal;
      if (update.spDecimal !== null) patch.sp_decimal = update.spDecimal;
      if (Object.keys(patch).length === 0) continue;
      const { error } = await supabaseAdmin.from('runners').update(patch).eq('id', runnerId);
      if (error) throw new Error(`runner result update failed: ${error.message}`);
      summary.runnersUpdated++;
    }

    const { error: statusErr } = await supabaseAdmin
      .from('races')
      .update({ status: 'result', official_result_time: now.toISOString() })
      .eq('id', raceId);
    if (statusErr) throw new Error(`race status update failed: ${statusErr.message}`);
    summary.racesSettled++;
  }

  // Re-run the model for today's remaining unsettled races so the next-race
  // pick refreshes off the latest odds. Market-only (no tipster_selections).
  const refresh = await refreshModelForMeeting(meetingDate);
  summary.modelRerun += refresh.modelReran;

  return summary;
}

/** Summary of a market-only model refresh across a meeting's unsettled races. */
export interface ModelRefreshSummary {
  meetingDate: string;
  /** Unsettled races considered (status != 'result'). */
  racesConsidered: number;
  /** Races whose model run was (re)written. */
  modelReran: number;
  /** Per-race model failures (isolated; the batch continues). */
  failures: number;
}

/**
 * Re-runs the model for a meeting's NOT-YET-SETTLED races so the dashboard pick
 * refreshes off the latest odds. Market-only (never writes `tipster_selections`)
 * and per-race isolated (one failure does not sink the batch). This is the SAME
 * refresh the results cron performs, extracted so a DEDICATED model cron can keep
 * the model fresh INDEPENDENTLY of result settlement (so a results-feed outage
 * never also freezes the model). Decision-support only — it never places a bet.
 *
 * @throws only if the initial races lookup fails.
 */
export async function refreshModelForMeeting(meetingDate: string): Promise<ModelRefreshSummary> {
  const { data: remaining, error } = await supabaseAdmin
    .from('races')
    .select('id')
    .eq('meeting_date', meetingDate)
    .neq('status', 'result');
  if (error) throw new Error(`remaining races fetch failed: ${error.message}`);

  const rows = (remaining ?? []) as { id: string }[];
  let modelReran = 0;
  let failures = 0;
  for (const row of rows) {
    try {
      const result = await runModelForRace(String(row.id));
      if (result) modelReran++;
    } catch (err) {
      failures++;
      console.warn(
        `[refreshModelForMeeting] runModelForRace(${row.id}) failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  return { meetingDate, racesConsidered: rows.length, modelReran, failures };
}
