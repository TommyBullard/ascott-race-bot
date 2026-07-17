/**
 * Producer ownership controller — Nationwide rebuild Phase 7A.2b Step 2
 * (selected-course integration).
 *
 * Wires the day-level, FAIL-CLOSED `producer_run_claims` mechanism (Step 1 —
 * {@link ./producerClaim}) into the SELECTED-COURSE pipeline scripts
 * (`pipeline:day` / `pipeline:watch`) so that two producers can never overlap
 * on one race date: not two watchers, not a watcher plus a one-shot run, not
 * two machines, and not a future nationwide producer.
 *
 * DESIGN (per the approved Step 2 plan):
 *   - The two SCRIPTS acquire ownership BEFORE `runPipelineCommitCycle` is
 *     ever called; the shared cycle itself is UNTOUCHED. Stage-boundary
 *     enforcement rides the cycle's existing dependency-injection seam:
 *     {@link guardPipelineDeps} wraps `callCron` (checked before EVERY provider
 *     HTTP call — racecards and odds) and `runOneRace` (checked before EVERY
 *     per-race model score+persist unit).
 *   - ONE claim + ONE owner id per process: `pipeline:watch` holds the claim
 *     for its whole lifetime (heartbeat keeps it alive through the inter-cycle
 *     wait); `pipeline:day` holds it for its one-shot run and releases in a
 *     `finally`. Restart = new owner id; a crashed process's claim TTL-expires
 *     (240s) and is stolen by the next starter.
 *   - HEARTBEAT: 60s interval, started only after ownership is proven,
 *     re-entrancy-guarded so beats can never overlap, stopped before release
 *     and in every exit path. Every beat verifies BOTH owner and GENERATION:
 *     `renewed:false` OR a generation mismatch is CONFIRMED loss; a transient
 *     error is retried exactly once then treated as uncertainty; a missing
 *     table/RPC/permission is mechanism-unavailable. All three set a permanent
 *     `stopReason` — belief is NEVER resurrected and there is NO mid-cycle
 *     reclaim, ever.
 *   - HONEST COMPOSITION NOTE: `runPipelineCommitCycle` catches per-stage
 *     errors (marking the stage 'failed') and `runModelForMeetingRaces`
 *     catches per-race errors — both MEASURED. So an {@link OwnershipLostError}
 *     thrown by a wrapper does not unwind the cycle; instead it guarantees the
 *     gated call NEVER REACHES a provider or the model (zero calls, zero
 *     writes), the failed odds stage blocks the model stage via the existing
 *     `shouldRunModelAfterCron` gate, and the SCRIPT's post-cycle
 *     `state.stopReason` check is what stops the process (exit non-zero).
 *   - Residual bounded risk (documented, not hidden): ownership lost DURING
 *     one race's inseparable score+persist call lets that single race
 *     complete; it remains guarded by the per-race `model_run_locks` lease,
 *     the post-off guard, and supersession semantics.
 *
 * SCOPE POLICY: the production pipeline claims `course:<normalised>` scopes
 * ONLY (via the existing {@link buildCourseScope} — no second normalisation
 * rule). The nationwide scope is NEVER used here; commit mode without a course
 * is refused by the scripts rather than widening the claim.
 *
 * NOT IN SCOPE (unchanged): lock:t-minus, results:auto, settlement, cron
 * routes, Railway, model maths/staking/confidence/recommendations. This module
 * never imports a provider client or executes the model itself — it only
 * gates the injected dependencies the scripts already pass in.
 * Decision-support only — never places a bet.
 */

import os from 'node:os';
import {
  PRODUCER_CLAIM_DEFAULT_TTL_SECONDS,
  buildCourseScope,
  isValidRaceDate,
  isValidScope,
  newOwnerId,
  tryAcquireProducerClaim,
  heartbeatProducerClaim,
  releaseProducerClaim,
  type AcquireOutcome,
  type HeartbeatOutcome,
  type ReleaseOutcome,
} from './producerClaim';
import type { PipelineRunnerDeps } from './raceDayPipelineRunner';

/** Heartbeat cadence against the 240s claim TTL (4 missed beats to expiry). */
export const PRODUCER_HEARTBEAT_INTERVAL_MS = 60_000;

/* -------------------------------------------------------------------------- */
/* Structured, secret-free ownership events                                   */
/* -------------------------------------------------------------------------- */

export type ProducerOwnershipEvent =
  | 'PRODUCER_CLAIM_ACQUIRED'
  | 'PRODUCER_CLAIM_REFUSED'
  | 'PRODUCER_CLAIM_STOLEN'
  | 'PRODUCER_HEARTBEAT_RENEWED'
  | 'PRODUCER_OWNERSHIP_UNCERTAIN'
  | 'PRODUCER_OWNERSHIP_LOST'
  | 'PRODUCER_CLAIM_UNAVAILABLE'
  | 'PRODUCER_CLAIM_RELEASED'
  | 'PRODUCER_CLAIM_RELEASE_FAILED';

/**
 * The ONLY fields an ownership event may carry (plus `event` and `ts`, added
 * by the builder). Deliberately excludes: credentials, environment values,
 * full owner ids, full commands, provider responses, secrets, tokens, and
 * local paths. {@link buildProducerEvent} DROPS anything not in this list, so
 * a future call site cannot accidentally widen the surface.
 */
export const PRODUCER_EVENT_ALLOWED_FIELDS = [
  'race_date',
  'scope',
  'owner_prefix',
  'generation',
  'classification',
  'expires_at',
  'mode',
  'stage',
] as const;

export type ProducerEventDetails = Partial<
  Record<(typeof PRODUCER_EVENT_ALLOWED_FIELDS)[number], string | number | null>
>;

/** Short, log-safe owner prefix; the full id stays in the DB (service-role diagnostics). */
export function ownerPrefix(ownerId: string): string {
  return ownerId.slice(0, 8);
}

/** Builds one event object containing ONLY the allowed fields + event + ts. Pure. */
export function buildProducerEvent(
  event: ProducerOwnershipEvent,
  details: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { event };
  for (const key of PRODUCER_EVENT_ALLOWED_FIELDS) {
    if (key in details && details[key] !== undefined) out[key] = details[key];
  }
  out.ts = new Date().toISOString();
  return out;
}

/** Emits one structured, greppable ownership event line (mirrors logModelLockEvent). */
export function logProducerOwnershipEvent(
  event: ProducerOwnershipEvent,
  details: ProducerEventDetails,
): void {
  const line = JSON.stringify(buildProducerEvent(event, details));
  const isWarn =
    event === 'PRODUCER_CLAIM_REFUSED' ||
    event === 'PRODUCER_CLAIM_STOLEN' ||
    event === 'PRODUCER_OWNERSHIP_UNCERTAIN' ||
    event === 'PRODUCER_OWNERSHIP_LOST' ||
    event === 'PRODUCER_CLAIM_UNAVAILABLE' ||
    event === 'PRODUCER_CLAIM_RELEASE_FAILED';
  if (isWarn) console.warn(line);
  else console.log(line);
}

/* -------------------------------------------------------------------------- */
/* Ownership state (in-memory belief)                                         */
/* -------------------------------------------------------------------------- */

export type OwnershipStopReason = 'lost' | 'uncertain' | 'unavailable';
export type PipelineMode = 'pipeline-day' | 'pipeline-watch';

/**
 * The process's belief about its claim. Only DB-confirmed events (the acquire,
 * a renewed heartbeat with matching generation) set `believed = true`. Any
 * confirmed loss, repeated uncertainty, or mechanism failure sets `believed =
 * false` AND a permanent `stopReason` — after which nothing in this module
 * ever sets `believed` back to true (no mid-cycle reclaim).
 */
export interface OwnershipState {
  raceDate: string;
  scope: string;
  ownerId: string;
  generation: number;
  mode: PipelineMode;
  believed: boolean;
  stopReason: OwnershipStopReason | null;
}

/* -------------------------------------------------------------------------- */
/* Injectable dependencies                                                    */
/* -------------------------------------------------------------------------- */

/** Side effects, injectable for tests (mirrors the ModelLockDeps pattern). */
export interface ProducerOwnershipDeps {
  acquire: (params: {
    raceDate: string;
    scope: string;
    ownerId: string;
    ttlSeconds?: number;
    hostname?: string | null;
    pid?: number | null;
    appVersion?: string | null;
    mode?: string | null;
  }) => Promise<AcquireOutcome>;
  heartbeat: (params: { raceDate: string; ownerId: string; ttlSeconds?: number }) => Promise<HeartbeatOutcome>;
  release: (params: { raceDate: string; ownerId: string }) => Promise<ReleaseOutcome>;
  newOwner: () => string;
  hostname: () => string | null;
  pid: () => number | null;
  log: (event: ProducerOwnershipEvent, details: ProducerEventDetails) => void;
  startTimer: (cb: () => void, ms: number) => unknown;
  stopTimer: (handle: unknown) => void;
}

/** The real, Supabase-backed deps. */
export function defaultProducerOwnershipDeps(): ProducerOwnershipDeps {
  return {
    acquire: (params) => tryAcquireProducerClaim(params),
    heartbeat: (params) => heartbeatProducerClaim(params),
    release: (params) => releaseProducerClaim(params),
    newOwner: () => newOwnerId(),
    hostname: () => {
      try {
        return os.hostname();
      } catch {
        return null;
      }
    },
    pid: () => process.pid,
    log: logProducerOwnershipEvent,
    startTimer: (cb, ms) => setInterval(cb, ms),
    stopTimer: (handle) => clearInterval(handle as NodeJS.Timeout),
  };
}

/* -------------------------------------------------------------------------- */
/* Acquisition                                                                */
/* -------------------------------------------------------------------------- */

export type AcquireOwnershipOutcome =
  | { ok: true; state: OwnershipState }
  | { ok: false; reason: 'invalid_input'; message: string }
  | {
      ok: false;
      reason: 'refused';
      holderOwnerPrefix: string;
      holderScope: string;
      holderExpiresAt: string;
    }
  | { ok: false; reason: 'unavailable' | 'uncertain'; message: string };

/**
 * Acquires the date-level producer claim for a COURSE scope. FAIL-CLOSED:
 * anything other than a DB-confirmed `acquired: true` (with a well-formed
 * generation — Step 1's parser enforces that) is a typed refusal and the
 * caller must not start any provider/model/persistence work. A transient
 * acquire error is retried exactly once; never more.
 */
export async function acquireProducerOwnership(
  params: { raceDate: string; course: string; mode: PipelineMode; ttlSeconds?: number },
  deps: ProducerOwnershipDeps = defaultProducerOwnershipDeps(),
): Promise<AcquireOwnershipOutcome> {
  if (!isValidRaceDate(params.raceDate)) {
    return { ok: false, reason: 'invalid_input', message: `invalid race date: ${params.raceDate}` };
  }
  if (!params.course || params.course.trim() === '') {
    return { ok: false, reason: 'invalid_input', message: 'a course is required (the producer claim needs a course scope)' };
  }
  const scope = buildCourseScope(params.course);
  if (!isValidScope(scope)) {
    return { ok: false, reason: 'invalid_input', message: `course "${params.course}" does not normalise to a valid scope` };
  }

  const ownerId = deps.newOwner();
  if (!ownerId || ownerId.trim() === '') {
    return { ok: false, reason: 'unavailable', message: 'owner identity could not be generated' };
  }

  const attempt = () =>
    deps.acquire({
      raceDate: params.raceDate,
      scope,
      ownerId,
      ttlSeconds: params.ttlSeconds ?? PRODUCER_CLAIM_DEFAULT_TTL_SECONDS,
      hostname: deps.hostname(),
      pid: deps.pid(),
      appVersion: null,
      mode: params.mode,
    });

  let outcome = await attempt();
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
        scope,
        mode: params.mode,
        classification: 'mechanism_unavailable',
      });
      return { ok: false, reason: 'unavailable', message: outcome.failure.message };
    }
    deps.log('PRODUCER_OWNERSHIP_UNCERTAIN', {
      race_date: params.raceDate,
      scope,
      mode: params.mode,
      classification: 'acquire_uncertain',
    });
    return { ok: false, reason: 'uncertain', message: outcome.failure.message };
  }

  if (!outcome.acquired) {
    deps.log('PRODUCER_CLAIM_REFUSED', {
      race_date: params.raceDate,
      scope,
      mode: params.mode,
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

  const state: OwnershipState = {
    raceDate: params.raceDate,
    scope,
    ownerId,
    generation: outcome.generation,
    mode: params.mode,
    believed: true,
    stopReason: null,
  };
  deps.log(outcome.stoleExpired ? 'PRODUCER_CLAIM_STOLEN' : 'PRODUCER_CLAIM_ACQUIRED', {
    race_date: params.raceDate,
    scope,
    mode: params.mode,
    owner_prefix: ownerPrefix(ownerId),
    generation: outcome.generation,
    expires_at: outcome.currentExpiresAt,
    classification: outcome.stoleExpired ? 'stole_expired' : 'acquired',
  });
  return { ok: true, state };
}

/* -------------------------------------------------------------------------- */
/* Heartbeat controller                                                       */
/* -------------------------------------------------------------------------- */

export interface HeartbeatController {
  /** Starts the 60s interval. Call only after ownership is proven. Idempotent. */
  start(): void;
  /** Stops the interval. Safe to call repeatedly and from finally/signal paths. */
  stop(): void;
  /**
   * Awaited, DB-confirmed verification (used at stage/cycle boundaries).
   * Returns the post-beat belief. If a beat is already in flight, the SAME
   * in-flight beat is awaited — two heartbeat calls can never overlap.
   */
  beatNow(): Promise<boolean>;
}

/** Marks a permanent stop: belief false + reason + event + timer stopped. */
function markStopped(
  state: OwnershipState,
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
 * Creates the 60-second heartbeat controller for an acquired claim. Every beat
 * must prove BOTH the owner and the acquired GENERATION; anything else is
 * loss/uncertainty/unavailability and permanently stops the belief (no
 * mid-cycle reclaim). Beats cannot overlap (in-flight beat is shared).
 */
export function createHeartbeatController(
  state: OwnershipState,
  deps: ProducerOwnershipDeps = defaultProducerOwnershipDeps(),
  ttlSeconds: number = PRODUCER_CLAIM_DEFAULT_TTL_SECONDS,
): HeartbeatController {
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

    const attempt = () =>
      deps.heartbeat({ raceDate: state.raceDate, ownerId: state.ownerId, ttlSeconds });

    let outcome = await attempt();
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
      // Clean renewed:false — CONFIRMED loss (someone else owns the date now).
      markStopped(state, 'lost', 'PRODUCER_OWNERSHIP_LOST', 'heartbeat_not_renewed', deps, stopTimer);
      return false;
    }

    if (outcome.generation !== state.generation) {
      // Renewed under a DIFFERENT generation: the claim was stolen and (only
      // possible with a reused owner id) reclaimed — NOT our lease. Confirmed loss.
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
        // A tick that finds a beat in flight simply shares it (beatNow), so a
        // beat slower than the interval can never stack a second call.
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

/* -------------------------------------------------------------------------- */
/* Stage gating via the pipeline's existing dependency-injection seam         */
/* -------------------------------------------------------------------------- */

/** Thrown by a guarded dep when ownership is no longer believed held. */
export class OwnershipLostError extends Error {
  constructor(
    public readonly stage: string,
    public readonly stopReason: OwnershipStopReason | null,
  ) {
    super(
      `producer ownership not held at stage "${stage}"` +
        (stopReason ? ` (${stopReason})` : '') +
        ' — refusing to proceed (fail-closed)',
    );
    this.name = 'OwnershipLostError';
  }
}

/**
 * Wraps the pipeline cycle's injected deps with ownership gates:
 *   - `callCron` is checked before EVERY provider HTTP call (racecards, odds);
 *   - `runOneRace` is checked before EVERY per-race model score+persist unit;
 *   - `fetchRaceRows` passes through ungated (a read-only SELECT — harmless).
 * A failed check throws {@link OwnershipLostError} BEFORE the underlying dep
 * is invoked, so no provider call and no model write can happen after loss.
 * (`runPipelineCommitCycle` catches per-stage/per-race errors by design — the
 * SCRIPT's post-cycle `state.stopReason` check is what stops the process.)
 */
export function guardPipelineDeps(
  deps: PipelineRunnerDeps,
  state: OwnershipState,
): PipelineRunnerDeps {
  return {
    ...deps,
    callCron: async (url) => {
      if (!state.believed) throw new OwnershipLostError('provider', state.stopReason);
      return deps.callCron(url);
    },
    runOneRace: async (raceId) => {
      if (!state.believed) throw new OwnershipLostError('model', state.stopReason);
      return deps.runOneRace(raceId);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Release                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Graceful-shutdown release: stops the heartbeat FIRST, then attempts the
 * owner-scoped release. A failed release is logged and left to TTL expiry —
 * it never restarts work and never throws. Releasing a claim we no longer
 * hold is intrinsically safe (owner-scoped delete matches nothing).
 */
export async function releaseProducerOwnership(
  state: OwnershipState,
  controller: HeartbeatController | null,
  deps: ProducerOwnershipDeps = defaultProducerOwnershipDeps(),
): Promise<void> {
  controller?.stop();
  try {
    const outcome = await deps.release({ raceDate: state.raceDate, ownerId: state.ownerId });
    if (outcome.ok) {
      deps.log('PRODUCER_CLAIM_RELEASED', {
        race_date: state.raceDate,
        scope: state.scope,
        mode: state.mode,
        owner_prefix: ownerPrefix(state.ownerId),
        generation: state.generation,
        classification: outcome.released ? 'released' : 'not_held',
      });
    } else {
      deps.log('PRODUCER_CLAIM_RELEASE_FAILED', {
        race_date: state.raceDate,
        scope: state.scope,
        mode: state.mode,
        owner_prefix: ownerPrefix(state.ownerId),
        generation: state.generation,
        classification: outcome.failure.kind,
      });
    }
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

/* -------------------------------------------------------------------------- */
/* Script helpers                                                             */
/* -------------------------------------------------------------------------- */

/** The exact operator-facing refusal for commit mode without a course. */
export const COURSE_REQUIRED_MESSAGE =
  '--course is required with --commit: the producer ownership claim needs a course scope ' +
  '(course:<name>); nationwide operation is not permitted in the production pipeline.';

/**
 * Maps an acquisition failure to the operator message + exit code the scripts
 * share (1 = invalid input, 2 = mechanism unavailable / uncertainty,
 * 3 = refused by a live holder — matching the claim CLI's convention). Pure.
 */
export function describeAcquireFailure(outcome: Exclude<AcquireOwnershipOutcome, { ok: true }>): {
  message: string;
  exitCode: number;
} {
  if (outcome.reason === 'invalid_input') {
    return { message: `Producer ownership refused (invalid input): ${outcome.message}`, exitCode: 1 };
  }
  if (outcome.reason === 'refused') {
    return {
      message:
        `Producer ownership REFUSED — a live claim is held by owner ${outcome.holderOwnerPrefix}… ` +
        `scope=${outcome.holderScope} expires_at=${outcome.holderExpiresAt}. ` +
        'No provider or model work was started. Stop the other producer or wait for its TTL.',
      exitCode: 3,
    };
  }
  return {
    message:
      `Producer ownership could not be established (${outcome.reason}): ${outcome.message}. ` +
      'FAIL-CLOSED: no provider or model work was started.',
    exitCode: 2,
  };
}

/**
 * Maps a mid-run stop to the operator message + exit code (3 = confirmed loss,
 * 2 = uncertainty / mechanism unavailable). Pure.
 */
export function describeStopReason(stopReason: OwnershipStopReason): {
  message: string;
  exitCode: number;
} {
  if (stopReason === 'lost') {
    return {
      message:
        'Producer ownership LOST during the run (confirmed). No further provider/model work was ' +
        'performed after the loss; this process will not reclaim mid-cycle and is stopping.',
      exitCode: 3,
    };
  }
  return {
    message:
      `Producer ownership ${stopReason === 'unavailable' ? 'mechanism became unavailable' : 'became uncertain'} ` +
      'during the run. FAIL-CLOSED: no further provider/model work was performed; stopping.',
    exitCode: 2,
  };
}
