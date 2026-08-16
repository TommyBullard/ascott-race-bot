/**
 * Racecards-only COMMIT runner — the narrow, operator-controlled write path for
 * one Programme 0 racecard ingestion.
 *
 * WHY THIS EXISTS. The controlled-ingestion preflight found a gap with no safe
 * option in it: `/api/cron/racecards` has exactly the right write boundary
 * (races, runners, cron_runs) but refuses a context-less call, while the only
 * caller that supplies ownership context — `pipeline:day --commit` — also runs
 * odds and the model, writing six further tables. This runner closes that gap by
 * supplying real ownership context to exactly ONE route and then stopping.
 *
 * WHAT IT DOES, IN ORDER:
 *   1. validates arguments (no defaults, two independent safety latches);
 *   2. re-checks first-capture suitability with a FRESH, SELECT-only count —
 *      before any claim and before any route call;
 *   3. acquires the date-level producer claim through the established mechanism;
 *   4. verifies ownership one last time, then calls
 *      `/api/cron/racecards?day=<today|tomorrow>` ONCE;
 *   5. releases the claim in a `finally`, on every path.
 *
 * WHAT IT NEVER DOES: it calls no odds, model, run-model, results, settle,
 * training-capture, tipster, ML, lock or recommendation route — there is exactly
 * one URL builder in this module and it can only produce the racecards path. It
 * writes NO application table directly: the only rows it can cause are the ones
 * the racecards route itself writes, plus its own claim row through the existing
 * claim abstraction. It never retries. It never proceeds to a second stage.
 *
 * SCOPE IS NATIONWIDE ON PURPOSE. `/api/cron/racecards` is course-blind — it
 * fetches every GB + IRE card — so the honest claim scope is `all-uk-ire`, not a
 * course scope. That is the NARROWEST scope that actually covers the write; a
 * `course:<x>` claim would understate what is about to happen. Because the
 * `producer_run_claims` primary key is the race date alone, this still conflicts
 * with every other producer for that date, which is exactly the protection
 * wanted.
 *
 * Decision-support only. This ingests racecards; it places no bet, runs no
 * model, and creates no recommendation.
 */

import {
  ALL_UK_IRE_SCOPE,
  isValidRaceDate,
  PRODUCER_CLAIM_DEFAULT_TTL_SECONDS,
  type AcquireOutcome,
  type HeartbeatOutcome,
} from './producerClaim';
import {
  PRODUCER_HEARTBEAT_INTERVAL_MS,
  describeAcquireFailure,
  describeStopReason,
  ownerPrefix,
  type AcquireOwnershipOutcome,
  type OwnershipStopReason,
  type ProducerOwnershipDeps,
  type ProducerOwnershipEvent,
} from './producerOwnership';
import { OwnershipPropagationError, type OwnershipContextSource } from './ownershipPropagation';
import { resolveCronMeetingDate } from './cronDate';
import { buildUrl } from './raceDayPipeline';
import { redactPreviewDetail } from './racecardsDryRun';

/* ========================================================================== *
 * Fixed contract
 * ========================================================================== */

/** The only day scopes the Racing API serves; reused from the dry-run contract. */
export type CommitDay = 'today' | 'tomorrow';

/** True only for an exact, lower-case `today` / `tomorrow`. */
export function isCommitDay(value: unknown): value is CommitDay {
  return value === 'today' || value === 'tomorrow';
}

/**
 * The ONE route path this runner may ever request. Declared as a constant so a
 * second path cannot appear anywhere in the module without changing this line,
 * and asserted by test.
 */
export const RACECARDS_ROUTE_PATH = '/api/cron/racecards';

/** Every route path this runner is forbidden from touching. Reported and tested. */
export const PROHIBITED_ROUTE_PATHS: readonly string[] = [
  '/api/cron/odds',
  '/api/cron/model',
  '/api/cron/results',
  '/api/cron/training-capture',
  '/api/cron/tipster-discovery',
  '/api/run-model',
  '/api/settle',
];

/** The tables the invoked route is permitted to write. The runner writes none. */
export const ROUTE_ALLOWED_WRITE_TABLES: readonly string[] = ['races', 'runners', 'cron_runs'];

/** Stages this command explicitly does not perform. Printed before the write. */
export const PROHIBITED_STAGES: readonly string[] = [
  'no odds',
  'no model',
  'no recommendation',
  'no lock',
  'no result',
  'no settlement',
  'no training capture',
];

/** Claim metadata recorded on the `producer_run_claims` row for this runner. */
export type RacecardsCommitMode = 'racecards-only-commit';
export const RACECARDS_COMMIT_MODE: RacecardsCommitMode = 'racecards-only-commit';

/**
 * Exit codes, distinct so an operator (or a wrapper) can tell the safe stops
 * apart from the dangerous one.
 *   0 committed · 1 usage/configuration · 2 mechanism unavailable / uncertain /
 *   unclassified · 3 stopped safely before any write · 4 route invoked and
 *   failed · 5 AMBIGUOUS (the request may have been accepted).
 */
export const COMMIT_EXIT = {
  committed: 0,
  usage: 1,
  mechanism: 2,
  stopped_safely: 3,
  route_failed: 4,
  ambiguous: 5,
} as const;

/**
 * Builds the ONLY URL this runner may request. There is no path parameter: the
 * path is fixed and the sole variable is the already-validated day.
 */
export function buildRacecardsRouteUrl(baseOrigin: string, day: CommitDay): string {
  return buildUrl(baseOrigin.replace(/\/+$/, ''), RACECARDS_ROUTE_PATH, { day });
}

/** Resolves the UTC date a day scope means, by the SAME rule the route uses. */
export function resolveCommitDate(day: CommitDay, now: Date): string {
  return resolveCronMeetingDate({ day }, now).meetingDate;
}

/* ========================================================================== *
 * SELECT-only read seam for the fresh suitability gate
 * ========================================================================== */

/**
 * The entire database surface this runner may touch directly: ONE count.
 *
 * Deliberately narrower than the dry-run's three-method seam — this command
 * needs a single fact, so its interface exposes a single method and no mutation
 * can be expressed through it. A test pins the method list.
 */
export interface RacecardsCommitReadSeam {
  /** `select count(*) from races where meeting_date = <date>`. */
  countRacesForDate(date: string): Promise<number>;
}

/* ========================================================================== *
 * Ownership adapter — retyped, NOT reimplemented semantics
 * ========================================================================== */

/**
 * This runner's ownership belief.
 *
 * Structurally identical to `producerOwnership.ts`'s `OwnershipState` and
 * `nationwideOwnership.ts`'s `NationwideOwnershipState` except for `mode`, which
 * is `RacecardsCommitMode`. It follows the precedent `nationwideOwnership.ts`
 * set explicitly: those modules narrow `mode` to their own producer families on
 * purpose, so a new family is added by RETYPING here rather than by widening a
 * union another module deliberately closed. No ownership SEMANTIC differs — the
 * acquire, heartbeat and release contracts below mirror their counterparts
 * exactly, and every generic piece (deps, events, owner redaction, failure
 * description) is imported rather than restated.
 */
export interface RacecardsCommitOwnershipState {
  raceDate: string;
  scope: string;
  ownerId: string;
  generation: number;
  mode: RacecardsCommitMode;
  believed: boolean;
  stopReason: OwnershipStopReason | null;
}

/**
 * Acquires the date-level producer claim with the FIXED `all-uk-ire` scope.
 * FAIL-CLOSED: anything other than a DB-confirmed `acquired: true` is a typed
 * refusal and the caller must not call the route. A transient acquire error is
 * retried exactly once; never more. There is no course parameter, so this can
 * never be misused to take a course scope.
 */
export async function acquireRacecardsCommitOwnership(
  params: { raceDate: string; ttlSeconds?: number },
  deps: ProducerOwnershipDeps,
): Promise<
  { ok: true; state: RacecardsCommitOwnershipState } | Exclude<AcquireOwnershipOutcome, { ok: true }>
> {
  if (!isValidRaceDate(params.raceDate)) {
    return { ok: false, reason: 'invalid_input', message: `invalid race date: ${params.raceDate}` };
  }

  const ownerId = deps.newOwner();
  if (!ownerId || ownerId.trim() === '') {
    return { ok: false, reason: 'unavailable', message: 'owner identity could not be generated' };
  }

  const attempt = () =>
    deps.acquire({
      raceDate: params.raceDate,
      scope: ALL_UK_IRE_SCOPE,
      ownerId,
      ttlSeconds: params.ttlSeconds,
      hostname: deps.hostname(),
      pid: deps.pid(),
      appVersion: null,
      mode: RACECARDS_COMMIT_MODE,
    });

  let outcome: AcquireOutcome = await attempt();
  if (!outcome.ok && outcome.failure.kind === 'transient_uncertain') {
    outcome = await attempt(); // bounded: exactly one retry, then stop.
  }

  if (!outcome.ok) {
    if (outcome.failure.kind === 'invalid_input') {
      return { ok: false, reason: 'invalid_input', message: outcome.failure.message };
    }
    if (outcome.failure.kind === 'mechanism_unavailable') {
      deps.log('PRODUCER_CLAIM_UNAVAILABLE', {
        race_date: params.raceDate,
        scope: ALL_UK_IRE_SCOPE,
        mode: RACECARDS_COMMIT_MODE,
        classification: 'mechanism_unavailable',
      });
      return { ok: false, reason: 'unavailable', message: outcome.failure.message };
    }
    deps.log('PRODUCER_OWNERSHIP_UNCERTAIN', {
      race_date: params.raceDate,
      scope: ALL_UK_IRE_SCOPE,
      mode: RACECARDS_COMMIT_MODE,
      classification: 'acquire_uncertain',
    });
    return { ok: false, reason: 'uncertain', message: outcome.failure.message };
  }

  if (!outcome.acquired) {
    deps.log('PRODUCER_CLAIM_REFUSED', {
      race_date: params.raceDate,
      scope: ALL_UK_IRE_SCOPE,
      mode: RACECARDS_COMMIT_MODE,
      owner_prefix: ownerPrefix(outcome.currentOwnerId),
      generation: outcome.generation,
      expires_at: outcome.currentExpiresAt,
      classification: 'live_claim_held_elsewhere',
    });
    return {
      ok: false,
      reason: 'refused',
      holderOwnerPrefix: ownerPrefix(outcome.currentOwnerId),
      holderScope: outcome.currentScope,
      holderExpiresAt: outcome.currentExpiresAt,
    };
  }

  const state: RacecardsCommitOwnershipState = {
    raceDate: params.raceDate,
    scope: ALL_UK_IRE_SCOPE,
    ownerId,
    generation: outcome.generation,
    mode: RACECARDS_COMMIT_MODE,
    believed: true,
    stopReason: null,
  };
  deps.log(outcome.stoleExpired ? 'PRODUCER_CLAIM_STOLEN' : 'PRODUCER_CLAIM_ACQUIRED', {
    race_date: params.raceDate,
    scope: ALL_UK_IRE_SCOPE,
    mode: RACECARDS_COMMIT_MODE,
    owner_prefix: ownerPrefix(ownerId),
    generation: outcome.generation,
    expires_at: outcome.currentExpiresAt,
    classification: outcome.stoleExpired ? 'stole_expired' : 'acquired',
  });
  return { ok: true, state };
}

/** Same shape as the other two heartbeat controllers, retyped. */
export interface RacecardsCommitHeartbeatController {
  start(): void;
  stop(): void;
  beatNow(): Promise<boolean>;
}

function markStopped(
  state: RacecardsCommitOwnershipState,
  reason: OwnershipStopReason,
  event: ProducerOwnershipEvent,
  classification: string,
  deps: ProducerOwnershipDeps,
  stopTimer: () => void,
): void {
  state.believed = false;
  if (state.stopReason === null) state.stopReason = reason;
  deps.log(event, {
    race_date: state.raceDate,
    scope: state.scope,
    mode: state.mode,
    owner_prefix: ownerPrefix(state.ownerId),
    generation: state.generation,
    classification,
  });
  stopTimer();
}

/**
 * The 60-second heartbeat for the acquired claim. Identical contract to both
 * existing controllers: every beat proves BOTH owner and GENERATION;
 * `renewed:false` or a generation mismatch is CONFIRMED loss; a transient error
 * is retried exactly once then treated as uncertainty; a missing table/RPC/
 * permission is mechanism-unavailable. All three permanently stop belief — no
 * reclaim, ever. Beats cannot overlap.
 *
 * A one-shot run needs this because the route's `maxDuration` (300s) exceeds the
 * default claim TTL (240s): without a beat the claim could expire while the
 * route is still writing, letting another producer steal the date mid-write.
 */
export function createRacecardsCommitHeartbeatController(
  state: RacecardsCommitOwnershipState,
  deps: ProducerOwnershipDeps,
  ttlSeconds: number,
): RacecardsCommitHeartbeatController {
  let handle: unknown = null;
  let pending: Promise<boolean> | null = null;

  const stopTimer = (): void => {
    if (handle !== null) {
      deps.stopTimer(handle);
      handle = null;
    }
  };

  const runBeat = async (): Promise<boolean> => {
    if (state.stopReason !== null) return false;

    const attempt = () => deps.heartbeat({ raceDate: state.raceDate, ownerId: state.ownerId, ttlSeconds });

    let outcome: HeartbeatOutcome = await attempt();
    if (!outcome.ok && outcome.failure.kind === 'transient_uncertain') {
      outcome = await attempt(); // bounded: exactly one retry.
    }

    if (!outcome.ok) {
      if (outcome.failure.kind === 'mechanism_unavailable') {
        markStopped(state, 'unavailable', 'PRODUCER_CLAIM_UNAVAILABLE', 'heartbeat_mechanism_unavailable', deps, stopTimer);
      } else {
        markStopped(state, 'uncertain', 'PRODUCER_OWNERSHIP_UNCERTAIN', 'heartbeat_uncertain_after_retry', deps, stopTimer);
      }
      return false;
    }
    if (!outcome.renewed) {
      markStopped(state, 'lost', 'PRODUCER_OWNERSHIP_LOST', 'heartbeat_not_renewed', deps, stopTimer);
      return false;
    }
    if (outcome.generation !== state.generation) {
      markStopped(state, 'lost', 'PRODUCER_OWNERSHIP_LOST', 'generation_mismatch', deps, stopTimer);
      return false;
    }

    state.believed = true;
    deps.log('PRODUCER_HEARTBEAT_RENEWED', {
      race_date: state.raceDate,
      scope: state.scope,
      mode: state.mode,
      owner_prefix: ownerPrefix(state.ownerId),
      generation: state.generation,
      expires_at: outcome.expiresAt,
      classification: 'renewed',
    });
    return true;
  };

  const beatNow = (): Promise<boolean> => {
    if (pending) return pending; // share the in-flight beat — never overlap
    pending = runBeat().finally(() => {
      pending = null;
    });
    return pending;
  };

  return {
    start(): void {
      if (handle !== null || state.stopReason !== null) return;
      handle = deps.startTimer(() => {
        void beatNow().catch(() => {
          // runBeat never throws by construction; belt-and-braces only.
        });
      }, PRODUCER_HEARTBEAT_INTERVAL_MS);
    },
    stop(): void {
      stopTimer();
    },
    beatNow,
  };
}

/**
 * Graceful release: stops the heartbeat FIRST, then attempts the owner-scoped
 * release. A failed release is logged and left to TTL expiry — it never restarts
 * work and never throws. Identical contract to both existing releases.
 */
export async function releaseRacecardsCommitOwnership(
  state: RacecardsCommitOwnershipState,
  controller: RacecardsCommitHeartbeatController | null,
  deps: ProducerOwnershipDeps,
): Promise<void> {
  controller?.stop();
  try {
    const outcome = await deps.release({ raceDate: state.raceDate, ownerId: state.ownerId });
    deps.log(outcome.ok ? 'PRODUCER_CLAIM_RELEASED' : 'PRODUCER_CLAIM_RELEASE_FAILED', {
      race_date: state.raceDate,
      scope: state.scope,
      mode: state.mode,
      owner_prefix: ownerPrefix(state.ownerId),
      generation: state.generation,
      classification: outcome.ok ? (outcome.released ? 'released' : 'not_held') : outcome.failure.kind,
    });
  } catch {
    deps.log('PRODUCER_CLAIM_RELEASE_FAILED', {
      race_date: state.raceDate,
      scope: state.scope,
      mode: state.mode,
      owner_prefix: ownerPrefix(state.ownerId),
      generation: state.generation,
      classification: 'release_threw',
    });
  }
}

/* ========================================================================== *
 * Route response projection — safe aggregates only
 * ========================================================================== */

/** The racecards route's own counters, projected as numbers. No identifiers. */
export interface RacecardsRouteSummary {
  cardsFetched: number | null;
  racesInserted: number | null;
  racesExisting: number | null;
  runnersInserted: number | null;
  skipped: number | null;
  /** 'standard' | 'basic' as reported; any other value is dropped to null. */
  tier: string | null;
}

const TIER_VALUES: readonly string[] = ['standard', 'basic'];

/**
 * Projects ONLY the known numeric counters out of the route body. The body
 * itself is never retained, echoed or logged: an unexpected field cannot reach
 * the output because nothing but this allowlist is read. Pure.
 */
export function projectRacecardsSummary(body: unknown): RacecardsRouteSummary {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const tier = typeof o.tier === 'string' && TIER_VALUES.includes(o.tier) ? o.tier : null;
  return {
    cardsFetched: num(o.cardsFetched),
    racesInserted: num(o.racesInserted),
    racesExisting: num(o.racesExisting),
    runnersInserted: num(o.runnersInserted),
    skipped: num(o.skipped),
    tier,
  };
}

/* ========================================================================== *
 * Outcome
 * ========================================================================== */

/**
 * A SAFE classification of an ownership change observed during the request.
 *
 * Deliberately the existing closed {@link OwnershipStopReason} union — three
 * fixed words and nothing else. It carries no owner id, no ownership token, no
 * generation, no database detail, no raw error and no environment value,
 * because there is no room in the type for one.
 */
export type OwnershipWarning = OwnershipStopReason;

export type RacecardsCommitOutcome =
  | {
      kind: 'committed';
      date: string;
      summary: RacecardsRouteSummary;
      /**
       * Non-null when the heartbeat recorded a loss, uncertainty or mechanism
       * failure WHILE the request was in flight (review finding M-1). The
       * outcome stays `committed` — the route did return success — but the
       * operator must not be left believing ownership was held throughout.
       */
      ownershipWarning: OwnershipWarning | null;
    }
  | { kind: 'not_suitable'; date: string; existingRaces: number }
  | { kind: 'suitability_read_failed'; date: string; detail: string }
  | { kind: 'ownership_refused'; date: string; message: string; exitCode: number }
  | { kind: 'ownership_lost'; date: string; message: string; exitCode: number }
  | { kind: 'route_failed'; date: string; detail: string }
  | { kind: 'route_malformed'; date: string; detail: string }
  | { kind: 'ambiguous'; date: string; detail: string }
  | { kind: 'unclassified'; date: string; detail: string };

/** Whether any route call was actually issued. Drives the ambiguity language. */
export function routeWasInvoked(outcome: RacecardsCommitOutcome): boolean {
  return (
    outcome.kind === 'committed' ||
    outcome.kind === 'route_failed' ||
    outcome.kind === 'route_malformed' ||
    outcome.kind === 'ambiguous'
  );
}

/** Maps an outcome to its documented exit code. Pure. */
export function commitExitCode(outcome: RacecardsCommitOutcome): number {
  switch (outcome.kind) {
    case 'committed':
      return COMMIT_EXIT.committed;
    case 'not_suitable':
      return COMMIT_EXIT.stopped_safely;
    case 'suitability_read_failed':
      return COMMIT_EXIT.mechanism;
    case 'ownership_refused':
    case 'ownership_lost':
      return outcome.exitCode;
    case 'route_failed':
    case 'route_malformed':
      return COMMIT_EXIT.route_failed;
    case 'ambiguous':
      return COMMIT_EXIT.ambiguous;
    default:
      return COMMIT_EXIT.mechanism;
  }
}

/* ========================================================================== *
 * Orchestration
 * ========================================================================== */

/** Minimal structural result of a cron call (matches `createCallCron`'s). */
export interface CronCallOutcome {
  ok: boolean;
  body: unknown;
}

export interface RacecardsCommitDeps {
  reads: RacecardsCommitReadSeam;
  ownership: ProducerOwnershipDeps;
  /**
   * Factory for the route caller. The CLI passes the REAL `createCallCron`, so
   * the CRON_SECRET bearer and the `x-producer-ownership` header are attached by
   * the established helper — this module never hand-builds either.
   */
  makeCallCron: (
    getSource: () => OwnershipContextSource | undefined,
  ) => (url: string) => Promise<CronCallOutcome>;
  now: Date;
  /** Operator-facing output sink. Receives only safe, aggregate text. */
  log: (line: string) => void;
  ttlSeconds?: number;
}

/**
 * Runs the whole commit: fresh gate -> claim -> one route call -> release.
 *
 * NO RETRY, ANYWHERE. The route is called exactly once. If the call throws
 * AFTER the request may have left the machine, the outcome is reported as
 * AMBIGUOUS and the runner stops — a retry could double-write or blur the
 * evidence a later read-only verification depends on. The one exception is not
 * a retry at all: an {@link OwnershipPropagationError} is raised by
 * `createCallCron` BEFORE any fetch, so nothing was sent and it is classified as
 * an ownership stop rather than an ambiguity.
 */
export async function runRacecardsCommit(
  day: CommitDay,
  baseOrigin: string,
  deps: RacecardsCommitDeps,
): Promise<RacecardsCommitOutcome> {
  const date = resolveCommitDate(day, deps.now);
  const ttl = deps.ttlSeconds ?? PRODUCER_CLAIM_DEFAULT_TTL_SECONDS;

  // ---- 1. FRESH suitability gate: before any claim, before any route --------
  let existing: number;
  try {
    existing = await deps.reads.countRacesForDate(date);
  } catch (err) {
    return { kind: 'suitability_read_failed', date, detail: redactPreviewDetail(err) };
  }
  if (existing !== 0) {
    return { kind: 'not_suitable', date, existingRaces: existing };
  }

  // ---- 2. Claim ------------------------------------------------------------
  const acquired = await acquireRacecardsCommitOwnership({ raceDate: date, ttlSeconds: ttl }, deps.ownership);
  if (!acquired.ok) {
    const described = describeAcquireFailure(acquired);
    return { kind: 'ownership_refused', date, message: described.message, exitCode: described.exitCode };
  }
  const state = acquired.state;
  const heartbeat = createRacecardsCommitHeartbeatController(state, deps.ownership, ttl);
  heartbeat.start();

  try {
    // ---- 3. Verify ownership immediately before the single route call ------
    await heartbeat.beatNow();
    if (!state.believed) {
      const d = describeStopReason(state.stopReason ?? 'uncertain');
      return { kind: 'ownership_lost', date, message: d.message, exitCode: d.exitCode };
    }

    // ---- 4. The one and only route call -----------------------------------
    const callCron = deps.makeCallCron(() => state);
    const url = buildRacecardsRouteUrl(baseOrigin, day);
    deps.log(`Invoking the racecards route once: ${RACECARDS_ROUTE_PATH}?day=${day}`);

    let result: CronCallOutcome;
    try {
      result = await callCron(url);
    } catch (err) {
      if (err instanceof OwnershipPropagationError) {
        // Raised BEFORE fetch: nothing was sent, so this is NOT ambiguous.
        return {
          kind: 'ownership_lost',
          date,
          message:
            'Ownership context could not be attached, so the request was refused locally before it ' +
            'was sent. No route call was made and nothing was written.',
          exitCode: COMMIT_EXIT.stopped_safely,
        };
      }
      // The request may already have been accepted by the server.
      return { kind: 'ambiguous', date, detail: redactPreviewDetail(err) };
    }

    if (!result.ok) {
      return { kind: 'route_failed', date, detail: 'the racecards route reported failure' };
    }
    if (!result.body || typeof result.body !== 'object') {
      return { kind: 'route_malformed', date, detail: 'the racecards route returned a non-object body' };
    }
    // Success terminates here. There is deliberately no next stage.
    //
    // M-1: the heartbeat keeps beating WHILE the request is in flight, so it
    // can record a loss after the pre-call verification passed. The route had
    // already cleared its own guard, so such a loss cannot undo the write and
    // must not change the outcome — but it must not be hidden either. Read the
    // state once, here, and carry it as a safe classification. Nothing is
    // retried and no claim is reacquired on this path.
    return {
      kind: 'committed',
      date,
      summary: projectRacecardsSummary(result.body),
      ownershipWarning: state.stopReason,
    };
  } catch (err) {
    return { kind: 'unclassified', date, detail: redactPreviewDetail(err) };
  } finally {
    // Released on EVERY path: success, refusal, failure, ambiguity, throw.
    await releaseRacecardsCommitOwnership(state, heartbeat, deps.ownership);
  }
}

/* ========================================================================== *
 * Rendering — aggregates and fixed text only
 * ========================================================================== */

/**
 * The scope declaration printed BEFORE any claim or route call, so the operator
 * sees exactly what is about to happen and what cannot happen.
 */
export function renderCommitScope(params: {
  day: CommitDay;
  date: string;
  origin: string;
}): string[] {
  return [
    'RACECARDS-ONLY COMMIT',
    'THIS WRITES RACECARD DATA',
    '',
    `  Day scope            : ${params.day}`,
    `  Resolved date (UTC)  : ${params.date}`,
    `  Target origin        : ${params.origin}`,
    `  Route (exactly one)  : ${RACECARDS_ROUTE_PATH}?day=${params.day}`,
    `  Producer claim scope : ${ALL_UK_IRE_SCOPE} (the racecards route is course-blind)`,
    '',
    `  Route may write      : ${ROUTE_ALLOWED_WRITE_TABLES.join(', ')}`,
    '  This CLI writes      : nothing directly (only the producer claim row, via the claim abstraction)',
    '',
    `  Prohibited stages    : ${PROHIBITED_STAGES.join(', ')}`,
    '',
    '  Next action          : a SELECT-only count of stored races for the resolved date. The',
    '                         producer claim and the single route call happen ONLY if that count',
    '                         is zero. The count describes this instant only — it cannot',
    '                         guarantee the date is still empty when the route runs.',
    '',
    '  The previous dry run passed first-capture suitability, but the provider payload can still',
    '  change and the route remains authoritative for what is actually written. Post-write',
    '  verification must confirm every inserted row landed on the intended date.',
    '',
  ];
}

/** The operator-facing result block. Counts, fixed text and redacted detail only. */
export function renderCommitOutcome(outcome: RacecardsCommitOutcome): string[] {
  const lines: string[] = [];
  switch (outcome.kind) {
    case 'committed': {
      const s = outcome.summary;
      const show = (v: number | null) => (v === null ? 'not reported' : String(v));
      lines.push('RACECARDS COMMIT COMPLETE');
      lines.push('');
      lines.push(`  Date                 : ${outcome.date}`);
      lines.push(`  Endpoint tier        : ${s.tier ?? 'not reported'}`);
      lines.push(`  Cards fetched        : ${show(s.cardsFetched)}`);
      lines.push(`  Races inserted       : ${show(s.racesInserted)}`);
      lines.push(`  Races already present: ${show(s.racesExisting)}`);
      lines.push(`  Runners inserted     : ${show(s.runnersInserted)}`);
      lines.push(`  Cards skipped        : ${show(s.skipped)}`);
      lines.push('');
      lines.push('  No further stage was run. Odds, model, recommendations, locks, results and');
      lines.push('  settlement were not invoked and remain untouched.');
      lines.push('  Verify with SELECT-only queries that every inserted row carries the intended');
      lines.push('  meeting date before treating this run as evidence.');
      if (outcome.ownershipWarning !== null) {
        lines.push('');
        lines.push(`  OWNERSHIP WARNING: ownership became ${outcome.ownershipWarning} DURING the request.`);
        lines.push('  The racecards route returned success, so the write was performed and the route');
        lines.push('  had verified ownership at the moment it accepted the request. Nothing was');
        lines.push('  retried and no claim was reacquired.');
        lines.push('  Exclusive ownership was NOT held for the whole request: verify that no');
        lines.push('  concurrent producer also wrote to this date.');
      }
      break;
    }
    case 'not_suitable':
      lines.push('STOPPED — DATE NO LONGER SUITABLE');
      lines.push('');
      lines.push(`  Date                 : ${outcome.date}`);
      lines.push(`  Races already stored : ${outcome.existingRaces}`);
      lines.push('');
      lines.push('  No producer claim was acquired and no route was invoked. Nothing was written.');
      lines.push('  Ingestion never updates an existing race row, so stored rows would not gain');
      lines.push('  Programme 0 fields from a run against this date.');
      break;
    case 'suitability_read_failed':
      lines.push('STOPPED — SUITABILITY CHECK FAILED');
      lines.push('');
      lines.push(`  Detail : ${outcome.detail}`);
      lines.push('  No claim was acquired and no route was invoked. Nothing was written.');
      break;
    case 'ownership_refused':
      lines.push('STOPPED — PRODUCER OWNERSHIP NOT ESTABLISHED');
      lines.push('');
      lines.push(`  ${outcome.message}`);
      lines.push('  No route was invoked. Nothing was written.');
      break;
    case 'ownership_lost':
      lines.push('STOPPED — PRODUCER OWNERSHIP NOT HELD');
      lines.push('');
      lines.push(`  ${outcome.message}`);
      lines.push('  The route was not invoked. Nothing was written.');
      break;
    case 'route_failed':
    case 'route_malformed':
      lines.push('RACECARDS ROUTE FAILED');
      lines.push('');
      lines.push(`  Date   : ${outcome.date}`);
      lines.push(`  Detail : ${outcome.detail}`);
      lines.push('');
      lines.push('  The route was invoked once and did not report success. It may have written');
      lines.push('  some rows before failing. NOTHING WAS RETRIED. Verify with SELECT-only queries');
      lines.push('  before any further action.');
      break;
    case 'ambiguous':
      lines.push('AMBIGUOUS OUTCOME — VERIFY BEFORE DOING ANYTHING ELSE');
      lines.push('');
      lines.push(`  Date   : ${outcome.date}`);
      lines.push(`  Detail : ${outcome.detail}`);
      lines.push('');
      lines.push('  The request may or may not have reached the server, and the server may or may');
      lines.push('  not have completed the write. THIS WAS NOT RETRIED, deliberately: a second');
      lines.push('  attempt could duplicate work or destroy the evidence needed to tell what');
      lines.push('  happened. Confirm the actual state with SELECT-only queries before re-running.');
      break;
    default:
      lines.push('STOPPED — UNCLASSIFIED FAILURE');
      lines.push('');
      lines.push(`  Detail : ${outcome.detail}`);
      lines.push('  Treat the outcome as unverified and confirm with SELECT-only queries.');
      break;
  }
  return lines;
}
