/**
 * Nationwide ownership adapter — Nationwide rebuild Phase 7A.2b Step 5.
 *
 * A SEPARATE, self-contained ownership module for the nationwide dry-run and
 * preflight commands, deliberately NOT built by widening
 * {@link ../lib/producerOwnership} (whose `OwnershipState.mode` /
 * `PipelineMode` type is intentionally narrow to `'pipeline-day'` /
 * `'pipeline-watch'` — the SELECTED-COURSE production pipeline only). This
 * module claims EXACTLY the reserved nationwide scope (`ALL_UK_IRE_SCOPE`,
 * i.e. `'all-uk-ire'`) and is used ONLY by `nationwide:dry-run` /
 * `nationwide:preflight`; it must never be imported by, and never weakens,
 * the selected-course integration.
 *
 * WHAT IS REUSED AS-IS (fully generic, no `PipelineMode` dependency, verified
 * by reading `producerOwnership.ts`): `ProducerOwnershipDeps` (every field is
 * typed against plain strings/unknowns), `defaultProducerOwnershipDeps`,
 * `ProducerOwnershipEvent`, `ProducerEventDetails`, `PRODUCER_EVENT_ALLOWED_FIELDS`,
 * `ownerPrefix`, `buildProducerEvent`, `logProducerOwnershipEvent`,
 * `PRODUCER_HEARTBEAT_INTERVAL_MS`, `OwnershipLostError`, `OwnershipStopReason`,
 * `AcquireOwnershipOutcome` (its `ok:false` branches carry no mode/course
 * field at all), `describeAcquireFailure`, `describeStopReason`.
 *
 * WHAT IS REIMPLEMENTED (because it is typed against the narrow
 * `OwnershipState`/`PipelineMode`, not because the LOGIC differs):
 * {@link NationwideOwnershipState} (mode is `NationwideMode`, not
 * `PipelineMode`), {@link acquireNationwideOwnership} (identical fail-closed
 * acquire contract, scope fixed to `all-uk-ire`, no course parameter),
 * {@link createNationwideHeartbeatController} (identical 60s non-overlapping,
 * owner+generation-verifying, permanent-stop-on-loss contract),
 * {@link releaseNationwideOwnership} (identical stop-then-release contract).
 * Every reimplementation mirrors its selected-course counterpart's behaviour
 * exactly — this file changes NO ownership semantics, it only retypes them
 * for a different `mode` union so `producerOwnership.ts` never has to widen
 * its own type for a use case it was explicitly designed to exclude.
 *
 * SCOPE POLICY: this module claims `all-uk-ire` and ONLY `all-uk-ire` — no
 * course parameter exists anywhere in its API, so it can never be misused to
 * claim a course scope (that remains `producerOwnership.ts`'s job). Because
 * the underlying `producer_run_claims` primary key is `race_date` alone, a
 * nationwide claim conflicts with EVERY course claim for the same date, and
 * vice versa — this is the existing Step 1 schema behaviour, unchanged.
 *
 * NOT IN SCOPE: no provider calls, no model execution, no persistence. This
 * module never imports a provider client or the model — it only manages the
 * claim lifecycle. Decision-support only — never places a bet.
 */

import {
  ALL_UK_IRE_SCOPE,
  isValidRaceDate,
  type AcquireOutcome,
  type HeartbeatOutcome,
} from './producerClaim';
import {
  PRODUCER_HEARTBEAT_INTERVAL_MS,
  ownerPrefix,
  defaultProducerOwnershipDeps,
  describeAcquireFailure,
  describeStopReason,
  logProducerOwnershipEvent,
  OwnershipLostError,
  type AcquireOwnershipOutcome,
  type OwnershipStopReason,
  type ProducerEventDetails,
  type ProducerOwnershipDeps,
  type ProducerOwnershipEvent,
} from './producerOwnership';

// Re-exported so callers of this module never need to reach into
// producerOwnership.ts directly for the fully generic pieces it already owns.
export {
  PRODUCER_HEARTBEAT_INTERVAL_MS,
  ownerPrefix,
  defaultProducerOwnershipDeps,
  describeAcquireFailure,
  describeStopReason,
  logProducerOwnershipEvent,
  OwnershipLostError,
};
export type { AcquireOwnershipOutcome, OwnershipStopReason, ProducerEventDetails, ProducerOwnershipDeps, ProducerOwnershipEvent };

/** The two nationwide dry-run modes, recorded as claim metadata. */
export type NationwideMode = 'nationwide-stored-dry-run' | 'nationwide-live-provider-dry-run';

/**
 * The nationwide claim's in-memory belief — structurally identical to
 * `producerOwnership.ts`'s `OwnershipState` except `mode: NationwideMode`
 * instead of `PipelineMode`. See the module docstring for why this is a
 * separate type rather than a widened import.
 */
export interface NationwideOwnershipState {
  raceDate: string;
  scope: string;
  ownerId: string;
  generation: number;
  mode: NationwideMode;
  believed: boolean;
  stopReason: OwnershipStopReason | null;
}

/**
 * Acquires the date-level producer claim with the FIXED nationwide scope
 * (`all-uk-ire`). FAIL-CLOSED: anything other than a DB-confirmed
 * `acquired: true` (with a well-formed generation) is a typed refusal — the
 * caller must not start any provider/scoring work. A transient acquire error
 * is retried exactly once; never more. Identical contract to
 * {@link ../lib/producerOwnership.acquireProducerOwnership}, retyped for
 * {@link NationwideOwnershipState}.
 */
export async function acquireNationwideOwnership(
  params: { raceDate: string; mode: NationwideMode; ttlSeconds?: number },
  deps: ProducerOwnershipDeps,
): Promise<{ ok: true; state: NationwideOwnershipState } | Exclude<AcquireOwnershipOutcome, { ok: true }>> {
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
      mode: params.mode,
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
        mode: params.mode,
        classification: 'mechanism_unavailable',
      });
      return { ok: false, reason: 'unavailable', message: outcome.failure.message };
    }
    deps.log('PRODUCER_OWNERSHIP_UNCERTAIN', {
      race_date: params.raceDate,
      scope: ALL_UK_IRE_SCOPE,
      mode: params.mode,
      classification: 'acquire_uncertain',
    });
    return { ok: false, reason: 'uncertain', message: outcome.failure.message };
  }

  if (!outcome.acquired) {
    deps.log('PRODUCER_CLAIM_REFUSED', {
      race_date: params.raceDate,
      scope: ALL_UK_IRE_SCOPE,
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

  const state: NationwideOwnershipState = {
    raceDate: params.raceDate,
    scope: ALL_UK_IRE_SCOPE,
    ownerId,
    generation: outcome.generation,
    mode: params.mode,
    believed: true,
    stopReason: null,
  };
  deps.log(outcome.stoleExpired ? 'PRODUCER_CLAIM_STOLEN' : 'PRODUCER_CLAIM_ACQUIRED', {
    race_date: params.raceDate,
    scope: ALL_UK_IRE_SCOPE,
    mode: params.mode,
    owner_prefix: ownerPrefix(ownerId),
    generation: outcome.generation,
    expires_at: outcome.currentExpiresAt,
    classification: outcome.stoleExpired ? 'stole_expired' : 'acquired',
  });
  return { ok: true, state };
}

/** Same shape as `producerOwnership.ts`'s `HeartbeatController`, retyped. */
export interface NationwideHeartbeatController {
  start(): void;
  stop(): void;
  beatNow(): Promise<boolean>;
}

function markNationwideStopped(
  state: NationwideOwnershipState,
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
 * Creates the 60-second heartbeat controller for an acquired nationwide
 * claim. Identical contract to
 * {@link ../lib/producerOwnership.createHeartbeatController}: every beat
 * proves BOTH owner and GENERATION; `renewed:false` or a generation mismatch
 * is CONFIRMED loss; a transient error is retried exactly once then treated
 * as uncertainty; a missing table/RPC/permission is mechanism-unavailable.
 * All three permanently stop belief — no mid-cycle reclaim, ever. Beats
 * cannot overlap (an in-flight beat is shared).
 */
export function createNationwideHeartbeatController(
  state: NationwideOwnershipState,
  deps: ProducerOwnershipDeps,
  ttlSeconds: number,
): NationwideHeartbeatController {
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
        markNationwideStopped(state, 'unavailable', 'PRODUCER_CLAIM_UNAVAILABLE', 'heartbeat_mechanism_unavailable', deps, stopTimer);
      } else {
        markNationwideStopped(state, 'uncertain', 'PRODUCER_OWNERSHIP_UNCERTAIN', 'heartbeat_uncertain_after_retry', deps, stopTimer);
      }
      return false;
    }

    if (!outcome.renewed) {
      markNationwideStopped(state, 'lost', 'PRODUCER_OWNERSHIP_LOST', 'heartbeat_not_renewed', deps, stopTimer);
      return false;
    }

    if (outcome.generation !== state.generation) {
      markNationwideStopped(state, 'lost', 'PRODUCER_OWNERSHIP_LOST', 'generation_mismatch', deps, stopTimer);
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
 * Graceful-shutdown release: stops the heartbeat FIRST, then attempts the
 * owner-scoped release. A failed release is logged and left to TTL expiry —
 * it never restarts work and never throws. Identical contract to
 * {@link ../lib/producerOwnership.releaseProducerOwnership}.
 */
export async function releaseNationwideOwnership(
  state: NationwideOwnershipState,
  controller: NationwideHeartbeatController | null,
  deps: ProducerOwnershipDeps,
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
