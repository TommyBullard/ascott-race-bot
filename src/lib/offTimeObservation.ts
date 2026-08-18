/**
 * Off-time integrity — OBSERVE AND TIGHTEN. `races.off_time` is never written.
 *
 * WHY THIS EXISTS. Commit a9ee1cd moved race resolution onto provider identity.
 * A card returning the SAME `provider_race_id` with a CORRECTED off time now
 * reuses the existing `races.id` and writes nothing, so the stored off can go
 * stale SILENTLY: the sync summary counts it as `racesExisting`, which is
 * indistinguishable from an unchanged race. That one field anchors the model
 * pre-off guard, the T-minus-5 lock window, Betfair matching (±90s), results
 * matching (exact equality) and every pre-off evaluation selector.
 *
 * THE INVARIANT, IN ONE LINE: the off time every WRITE-SIDE safety guard uses
 * is a monotone-DECREASING function of accumulated evidence. It starts at
 * `races.off_time` and can only ever move EARLIER. No observation, from any
 * direction, at any time, in any order, can manufacture a pre-off state.
 *
 * WHY ONLY ONE DIRECTION. Lowering an off is provably safe for every guard —
 * `modelRunGuard` skips MORE, `selectPreOffRun` admits FEWER, the capture
 * target cuts EARLIER, lock coverage reports `lock_missing` more readily.
 * RAISING one is the fabrication vector: it would let a post-race run be
 * written as `is_current`, let an immutable T-minus-5 lock be built from
 * post-race output, and leak permanently into training data and lifetime
 * accuracy. So a published DELAY is recorded and never applied; the stored,
 * earlier off stays in force, which is today's behaviour and the conservative
 * one.
 *
 * WHAT THIS MODULE NEVER DOES: it never updates, upserts or deletes any row,
 * and it never writes `races` at all. Its only write is a single append-only
 * INSERT into {@link OFF_TIME_OBSERVATIONS_TABLE} — and a single INSERT is
 * already atomic, so no transactional RPC is required.
 *
 * FAIL-OPEN, DELIBERATELY. A missing table (pre-migration), an RLS denial or
 * any read error degrades to exactly today's behaviour and logs once. A new
 * dependency must never halt a race day. That is the same reasoning the repo
 * applies to `model_run_locks` (fail-open, bounded risk) rather than
 * `producer_run_claims` (fail-closed, unbounded risk): here, failing open
 * yields today's behaviour, which for the common delay case is the safe one.
 *
 * HONEST LIMIT: the most common real delay — a stewards' hold at the track —
 * changes no provider field at all, so it produces no observation and no
 * counter. `races.off_time` tracks PUBLISHED schedule changes only and is never
 * evidence that a race has or has not started.
 *
 * Decision-support only. Nothing here places, recommends or settles a bet.
 */

import { supabaseAdmin } from './supabaseAdmin';

/** The append-only evidence table. */
export const OFF_TIME_OBSERVATIONS_TABLE = 'race_off_time_observations';

/**
 * Smallest instant difference treated as real.
 *
 * `resolveOffTime` returns `new Date(ms).toISOString()` while PostgREST returns
 * the `+00:00` form — different strings, the same instant. Comparison is
 * ALWAYS epoch-ms, never text. The provider's `off_dt` carries second precision
 * at best, so a sub-second delta can only be representational noise.
 */
export const MIN_OBSERVED_DELTA_MS = 1_000;

/**
 * How many eligible observations must agree before the effective off tightens.
 *
 * Two, so one transient bad card cannot suppress a model run or forfeit an
 * official lock. The cost is at most one ingestion cycle (~5 minutes) of delay
 * before tightening — bounded, and strictly better than never tightening.
 */
export const MIN_CORROBORATING_OBSERVATIONS = 2;

/** The only observer in this phase. Text, so a future observer is additive. */
export const OFF_TIME_OBSERVER_RACECARDS = 'racecards_ingest';

/** Which raw provider field produced an observed off time. */
export type OffTimeSourceField = 'off_dt' | 'date_off_time';

/**
 * What an observation was. An UNCHANGED off is never recorded and has no
 * classification — that is the overwhelmingly common path and must cost
 * nothing.
 */
export type OffTimeObservationClassification =
  | 'earlier_than_stored'
  | 'later_than_stored'
  | 'stored_off_unknown'
  | 'ambiguous_source'
  | 'meeting_date_differs'
  | 'out_of_scope_meeting_date';

/** The stored race row, reduced to what classification reads. */
export interface StoredRaceOffTime {
  race_id: string;
  off_time: string | null;
  meeting_date: string | null;
  status: string | null;
  provider_race_id: string | null;
}

/** One observation taken from a freshly mapped card. */
export interface ObservedOffTime {
  race_id: string;
  provider_race_id: string | null;
  off_time_iso: string;
  meeting_date: string;
  source_field: OffTimeSourceField;
}

/** The classification decision. `classification: null` means UNCHANGED. */
export interface OffTimeObservationDecision {
  classification: OffTimeObservationClassification | null;
  tightening_eligible: boolean;
  delta_seconds: number | null;
}

/** The exact append-only row shape. Nulls mean "not recorded", never a value. */
export interface OffTimeObservationInsertRow {
  race_id: string;
  provider_race_id: string | null;
  stored_off_time: string | null;
  observed_off_time: string;
  delta_seconds: number | null;
  source_field: OffTimeSourceField;
  classification: OffTimeObservationClassification;
  tightening_eligible: boolean;
  observed_at: string;
  observer: string;
  scope_meeting_date: string;
  stored_meeting_date: string | null;
  observed_meeting_date: string;
  race_status_at_observation: string | null;
  had_official_lock: boolean;
}

/* ========================================================================== *
 * Pure classification
 * ========================================================================== */

/** Epoch ms, or NaN. Never throws. */
function instantMs(value: string | null | undefined): number {
  if (typeof value !== 'string' || value.trim() === '') return NaN;
  return Date.parse(value);
}

/**
 * The canonical ISO instant for a stored value, or null when it is absent or
 * unparseable. Never throws, never guesses.
 */
function instantIsoOrNull(value: string | null | undefined): string | null {
  const ms = instantMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The two error codes that PROVE a write was rejected BEFORE it executed.
 *
 *   42703  Postgres `undefined_column`, raised during parse/analyse — the
 *          statement never runs, so no row can have been written.
 *   PGRST204  PostgREST validating the payload against its schema cache, before
 *          any SQL is issued at all.
 *
 * Mirrors `COLUMN_MISSING_CODES` in `dbHealthSpec.ts`, which the repository
 * already uses for exactly this classification.
 */
const MISSING_COLUMN_CODES: ReadonlySet<string> = new Set(['42703', 'PGRST204']);

/**
 * True ONLY for a deterministic, pre-execution missing-column rejection.
 *
 * CODE-BASED ONLY, deliberately. This predicate authorises a RETRY, and a retry
 * is safe only where the database provably rejected the payload before writing
 * anything — otherwise a lost response after a committed insert would produce a
 * second `model_runs` row. Both codes above carry that proof; a message is an
 * unbounded, provider-formatted string that carries none, so an earlier
 * text-matching arm ("could not find" + "column") has been removed rather than
 * kept as a fallback. An error with no recognised code is treated as
 * potentially ambiguous and is never retried.
 */
export function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && MISSING_COLUMN_CODES.has(code);
}

/**
 * Classifies one observation against the stored row.
 *
 * Precedence is fail-closed first: ownership scope, then day change, then
 * unknown stored value, then the unchanged short-circuit, then source
 * ambiguity, and only then direction. Only an unambiguous, same-day, strictly
 * EARLIER observation is ever eligible to tighten.
 *
 * DELIBERATELY NOT COMPARED: the UTC date-part of `observed_off_time` against
 * `meeting_date`. `resolveOffTime` derives those independently (meeting date
 * prefers the provider's explicit `date`), so a 00:05 Irish race legitimately
 * stores an off of 23:05Z with the NEXT day's meeting date. Comparing them
 * would permanently and wrongly refuse that whole class of race.
 *
 * Pure, total and order-independent. Never throws.
 */
export function classifyOffTimeObservation(
  stored: StoredRaceOffTime,
  observed: ObservedOffTime,
  scopeMeetingDate: string,
): OffTimeObservationDecision {
  // The delta is computed FIRST, so every classification that CAN carry one
  // does. Two of them are date-scoped and return before any direction test, but
  // their rows still need a delta: the `delta_matches` CHECK ties the delta to
  // the presence of a stored off, and `zero_delta_is_scoped` deliberately
  // permits a ZERO delta for exactly these two. Returning null here produced a
  // row that satisfied neither arm of `delta_matches`, and because the insert
  // is one batched statement, a single day-moved card destroyed the whole
  // cycle's evidence.
  const storedMs = instantMs(stored.off_time);
  const observedMs = instantMs(observed.off_time_iso);
  const bothParse = Number.isFinite(storedMs) && Number.isFinite(observedMs);
  const deltaSecondsOrNull = bothParse ? Math.trunc((observedMs - storedMs) / 1000) : null;

  const none = (
    classification: OffTimeObservationClassification,
    delta_seconds: number | null = deltaSecondsOrNull,
  ): OffTimeObservationDecision => ({ classification, tightening_eligible: false, delta_seconds });

  // 1. Ownership wins over everything: a producer owning date D has no
  //    authority over D+1.
  if (observed.meeting_date !== scopeMeetingDate) return none('out_of_scope_meeting_date');

  // 2. A race that moved DAY is not a race that has already run.
  if (stored.meeting_date != null && observed.meeting_date !== stored.meeting_date) {
    return none('meeting_date_differs');
  }

  // 3/4. Nothing to compare — an off is never invented for a row that never
  //      had one, and never guessed for an unparseable observation.
  if (!bothParse) return none('stored_off_unknown', null);

  const deltaMs = observedMs - storedMs;
  // 5. UNCHANGED — the common path on every cycle. Nothing is recorded.
  if (Math.abs(deltaMs) < MIN_OBSERVED_DELTA_MS) {
    return { classification: null, tightening_eligible: false, delta_seconds: 0 };
  }

  const deltaSeconds = Math.trunc(deltaMs / 1000);

  // 6. The date + off_time branch forces a documented LOCAL time to UTC — a
  //    one-hour error under British Summer Time. Recorded, never trusted.
  if (observed.source_field !== 'off_dt') return none('ambiguous_source', deltaSeconds);

  // 7/8. Direction. Only EARLIER may tighten.
  if (deltaMs < 0) {
    return { classification: 'earlier_than_stored', tightening_eligible: true, delta_seconds: deltaSeconds };
  }
  return none('later_than_stored', deltaSeconds);
}

/**
 * Builds the append-only row, or null when the observation was UNCHANGED.
 * Copies values verbatim; nulls are preserved, never replaced. Pure.
 */
export function buildOffTimeObservationRow(
  stored: StoredRaceOffTime,
  observed: ObservedOffTime,
  decision: OffTimeObservationDecision,
  context: {
    observedAtIso: string;
    observer: string;
    scopeMeetingDate: string;
    hadOfficialLock: boolean;
  },
): OffTimeObservationInsertRow | null {
  if (decision.classification === null) return null;

  // M-1. `observed_off_time` is `timestamptz NOT NULL`. An unparseable value
  // would be rejected by the column TYPE — and because the insert is one
  // batched statement, that would destroy the whole cycle's evidence, which is
  // exactly the failure mode this programme already fixed once. There is also
  // nothing worth recording: an observation whose instant cannot be read says
  // nothing about timing. So no row is emitted.
  //
  // Deliberately NOT `stored_off_unknown` (that classification describes an
  // unusable STORED value, not an unusable observation), and deliberately not
  // backfilled with `now()` — inventing a timestamp is the fabrication this
  // repository forbids everywhere.
  const observedInstant = instantIsoOrNull(observed.off_time_iso);
  if (observedInstant === null) return null;

  // NORMALISED, not copied. A stored value that is present but unparseable
  // ('', 'not-a-time') is recorded as null: it is not an instant, the column is
  // timestamptz, and recording it as a value would produce a row with a stored
  // off but no delta — which the `delta_matches` biconditional rejects.
  // Normalising both sides here makes "a delta exists exactly when a stored
  // instant exists" structural rather than assumed.
  const storedInstant = instantIsoOrNull(stored.off_time);
  return {
    race_id: stored.race_id,
    provider_race_id: observed.provider_race_id,
    stored_off_time: storedInstant,
    observed_off_time: observedInstant,
    delta_seconds: storedInstant === null ? null : decision.delta_seconds,
    source_field: observed.source_field,
    classification: decision.classification,
    tightening_eligible: decision.tightening_eligible,
    observed_at: context.observedAtIso,
    observer: context.observer,
    scope_meeting_date: context.scopeMeetingDate,
    stored_meeting_date: stored.meeting_date,
    observed_meeting_date: observed.meeting_date,
    race_status_at_observation: stored.status,
    had_official_lock: context.hadOfficialLock,
  };
}

/* ========================================================================== *
 * The effective off — the core primitive
 * ========================================================================== */

/** The minimal projection the effective-off calculation reads. */
export interface EffectiveOffObservation {
  observed_off_time: string | null;
  tightening_eligible: boolean;
}

/** The result. `effectiveOffTime` is NEVER later than `storedOffTime`. */
export interface EffectiveOffTime {
  storedOffTime: string | null;
  /** What every WRITE-SIDE safety guard must use. */
  effectiveOffTime: string | null;
  tightened: boolean;
  corroboratingCount: number;
}

/**
 * The strictest known off: `min(stored, k-th earliest corroborated evidence)`.
 *
 * WHY THE k-th SMALLEST, NOT THE MINIMUM. Support for the claim "this race goes
 * off at instant X" is the number of eligible observations at or before X.
 * Taking the minimum would let one outlier set the effective off on a single
 * sighting. The k-th smallest is exactly "the earliest instant supported by at
 * least k observations", which is the conservative reading:
 *   [14:00, 14:00]        -> 14:00
 *   [13:00, 14:00]        -> 14:00   (one sighting is not enough)
 *   [13:00, 13:00, 14:00] -> 13:00
 *
 * PROPERTIES, each asserted by test: MONOTONICITY (adding an observation can
 * only lower or preserve the result, never raise it); CEILING (never later than
 * stored); ORDER-INDEPENDENCE; and IDENTITY (with no eligible observations the
 * result is byte-identical to the stored value, so the guard behaves exactly as
 * today).
 *
 * Pure. Never throws.
 */
export function resolveEffectiveOffTime(
  storedOffTime: string | null | undefined,
  observations: readonly EffectiveOffObservation[],
  minCorroborating: number = MIN_CORROBORATING_OBSERVATIONS,
): EffectiveOffTime {
  const stored = storedOffTime ?? null;
  const storedMs = instantMs(stored);
  if (!Number.isFinite(storedMs)) {
    // Nothing to tighten against. Unchanged from today.
    return { storedOffTime: stored, effectiveOffTime: stored, tightened: false, corroboratingCount: 0 };
  }

  const eligible = observations
    .filter((o) => o.tightening_eligible === true)
    .map((o) => instantMs(o.observed_off_time))
    .filter((ms) => Number.isFinite(ms) && ms <= storedMs - MIN_OBSERVED_DELTA_MS)
    .sort((a, b) => a - b);

  if (eligible.length < minCorroborating || minCorroborating < 1) {
    return { storedOffTime: stored, effectiveOffTime: stored, tightened: false, corroboratingCount: 0 };
  }

  const candidateMs = eligible[minCorroborating - 1];
  const effectiveMs = Math.min(storedMs, candidateMs);
  return {
    storedOffTime: stored,
    effectiveOffTime: new Date(effectiveMs).toISOString(),
    tightened: effectiveMs < storedMs,
    corroboratingCount: eligible.filter((ms) => ms <= candidateMs).length,
  };
}

/* ========================================================================== *
 * Injected I/O seams — the ONLY database touch points
 * ========================================================================== */

/**
 * Recording seam. There is deliberately no update/upsert/delete/rpc member:
 * a caller cannot mutate through this interface because the type offers no way
 * to express a mutation.
 */
export interface OffTimeObservationLookups {
  /** Batched SELECT of the stored rows for these resolved race ids. */
  fetchStoredRaces(raceIds: readonly string[]): Promise<StoredRaceOffTime[]>;
  /** Batched SELECT: which of these races already carry a minutes_before=5 lock. */
  fetchOfficialLockRaceIds(raceIds: readonly string[]): Promise<Set<string>>;
  /** The ONLY write in this module — one append-only insert. */
  insertObservations(rows: readonly OffTimeObservationInsertRow[]): Promise<void>;
}

/** Read seam for the effective off. SELECT-only; no write member exists. */
export interface EffectiveOffTimeLookups {
  fetchTighteningObservations(raceId: string): Promise<EffectiveOffObservation[]>;
}

/** Live, Supabase-backed recording seam. */
export const supabaseOffTimeObservationLookups: OffTimeObservationLookups = {
  async fetchStoredRaces(raceIds: readonly string[]): Promise<StoredRaceOffTime[]> {
    const { data, error } = await supabaseAdmin
      .from('races')
      .select('id, off_time, meeting_date, status, provider_race_id')
      .in('id', raceIds as string[]);
    if (error) throw new Error(`off-time observation races read failed: ${error.message}`);
    return ((data ?? []) as {
      id: string | number;
      off_time: string | null;
      meeting_date: string | null;
      status: string | null;
      provider_race_id: string | null;
    }[]).map((r) => ({
      race_id: String(r.id),
      off_time: r.off_time ?? null,
      meeting_date: r.meeting_date ?? null,
      status: r.status ?? null,
      provider_race_id: r.provider_race_id ?? null,
    }));
  },

  async fetchOfficialLockRaceIds(raceIds: readonly string[]): Promise<Set<string>> {
    const { data, error } = await supabaseAdmin
      .from('locked_race_decisions')
      .select('race_id')
      .eq('minutes_before', 5)
      .in('race_id', raceIds as string[]);
    if (error) throw new Error(`off-time observation lock read failed: ${error.message}`);
    return new Set(((data ?? []) as { race_id: string | number }[]).map((r) => String(r.race_id)));
  },

  async insertObservations(rows: readonly OffTimeObservationInsertRow[]): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await supabaseAdmin
      .from(OFF_TIME_OBSERVATIONS_TABLE)
      .insert(rows as OffTimeObservationInsertRow[]);
    if (error) throw new Error(`off-time observation insert failed: ${error.message}`);
  },
};

/** Live, Supabase-backed effective-off read seam. */
export const supabaseEffectiveOffTimeLookups: EffectiveOffTimeLookups = {
  async fetchTighteningObservations(raceId: string): Promise<EffectiveOffObservation[]> {
    const { data, error } = await supabaseAdmin
      .from(OFF_TIME_OBSERVATIONS_TABLE)
      .select('observed_off_time, tightening_eligible')
      .eq('race_id', raceId)
      .eq('tightening_eligible', true);
    if (error) throw new Error(`effective off-time read failed: ${error.message}`);
    return ((data ?? []) as {
      observed_off_time: string | null;
      tightening_eligible: boolean | null;
    }[]).map((r) => ({
      observed_off_time: r.observed_off_time ?? null,
      tightening_eligible: r.tightening_eligible === true,
    }));
  },
};

/* ========================================================================== *
 * Orchestrators — thin, fail-open, never throw
 * ========================================================================== */

/** Counters folded into the racecards sync summary, so the heartbeat sees them. */
export interface OffTimeObservationSummary {
  offTimeDivergencesObserved: number;
  offTimeTighteningObservations: number;
  offTimeObservationsRecorded: number;
  offTimeObservationErrors: number;
}

/** A zeroed summary. */
export function emptyOffTimeObservationSummary(): OffTimeObservationSummary {
  return {
    offTimeDivergencesObserved: 0,
    offTimeTighteningObservations: 0,
    offTimeObservationsRecorded: 0,
    offTimeObservationErrors: 0,
  };
}

/** De-duplicates observations by race id, LAST-WINS. Pure. */
export function dedupeObservations(observed: readonly ObservedOffTime[]): ObservedOffTime[] {
  const byRace = new Map<string, ObservedOffTime>();
  for (const o of observed) byRace.set(o.race_id, o);
  return [...byRace.values()];
}

/**
 * Records every divergent observation for one sync.
 *
 * Steady-state cost is ONE extra SELECT per sync, not per race: the unchanged
 * short-circuit means the lock read and the insert only happen when something
 * actually diverged.
 *
 * NEVER THROWS. Any failure increments `offTimeObservationErrors`, logs once,
 * and returns — racecard ingestion is never affected, because there is no write
 * here to protect. There is no retry loop: the ~5-minute ingestion cadence IS
 * the retry.
 */
export async function recordOffTimeObservations(
  observed: readonly ObservedOffTime[],
  scopeMeetingDate: string,
  observedAtIso: string,
  observer: string,
  lookups: OffTimeObservationLookups = supabaseOffTimeObservationLookups,
): Promise<OffTimeObservationSummary> {
  const summary = emptyOffTimeObservationSummary();
  const unique = dedupeObservations(observed);
  if (unique.length === 0) return summary;

  try {
    const storedRows = await lookups.fetchStoredRaces(unique.map((o) => o.race_id));
    const storedById = new Map(storedRows.map((r) => [r.race_id, r]));

    const diverged: { stored: StoredRaceOffTime; observed: ObservedOffTime; decision: OffTimeObservationDecision }[] = [];
    for (const o of unique) {
      const stored = storedById.get(o.race_id);
      if (!stored) continue; // the race vanished between resolve and read
      const decision = classifyOffTimeObservation(stored, o, scopeMeetingDate);
      if (decision.classification === null) continue;
      diverged.push({ stored, observed: o, decision });
    }

    summary.offTimeDivergencesObserved = diverged.length;
    summary.offTimeTighteningObservations = diverged.filter((d) => d.decision.tightening_eligible).length;
    if (diverged.length === 0) return summary;

    const lockedIds = await lookups.fetchOfficialLockRaceIds(diverged.map((d) => d.stored.race_id));

    const rows = diverged
      .map((d) =>
        buildOffTimeObservationRow(d.stored, d.observed, d.decision, {
          observedAtIso,
          observer,
          scopeMeetingDate,
          hadOfficialLock: lockedIds.has(d.stored.race_id),
        }),
      )
      .filter((r): r is OffTimeObservationInsertRow => r !== null);

    await lookups.insertObservations(rows);
    summary.offTimeObservationsRecorded = rows.length;
  } catch (err) {
    summary.offTimeObservationErrors += 1;
    // Message only, never the error object: a driver message can echo a filter
    // value, and one of ours is an external provider identifier.
    console.warn(
      `[offTimeObservation] recording failed (ingestion unaffected): ${
        err instanceof Error ? err.message.slice(0, 200) : 'unknown error'
      }`,
    );
  }
  return summary;
}

/**
 * The effective off for one race, for the WRITE-SIDE guards only.
 *
 * FAIL-OPEN: a missing table (pre-migration), an RLS denial or any read error
 * returns the stored value unchanged and logs once. That degrades to exactly
 * today's behaviour.
 *
 * DEPLOY ORDER IS FREE, and that claim covers all THREE new dependencies, not
 * just this one: the observations table is fail-open on read (here) and on
 * write (`recordOffTimeObservations`), and `model_runs.off_time_at_run` is
 * attached optimistically and dropped on a column-missing error
 * ({@link isMissingColumnError}). Applying the migration is a separately
 * reversible switch in either direction.
 */
export async function fetchEffectiveOffTime(
  raceId: string,
  storedOffTime: string | null,
  lookups: EffectiveOffTimeLookups = supabaseEffectiveOffTimeLookups,
  minCorroborating: number = MIN_CORROBORATING_OBSERVATIONS,
): Promise<EffectiveOffTime> {
  try {
    const observations = await lookups.fetchTighteningObservations(raceId);
    return resolveEffectiveOffTime(storedOffTime, observations, minCorroborating);
  } catch (err) {
    console.warn(
      `[offTimeObservation] effective-off read failed, using stored off: ${
        err instanceof Error ? err.message.slice(0, 200) : 'unknown error'
      }`,
    );
    return {
      storedOffTime: storedOffTime ?? null,
      effectiveOffTime: storedOffTime ?? null,
      tightened: false,
      corroboratingCount: 0,
    };
  }
}
