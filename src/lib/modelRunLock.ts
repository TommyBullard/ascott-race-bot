/**
 * Per-race model-run TTL lease lock (Phase 5 concurrency protection).
 *
 * Serialises {@link runModelForRace} per race so the model cron, results cron,
 * manual /api/run-model, and the operator pipeline cannot insert+supersede
 * `model_runs` for the SAME race at once — the non-atomic supersession that
 * caused the Ascot Day-1 `is_current` corruption.
 *
 * Design (see the migration 20260618050000_model_run_locks.sql):
 *   - A LEASE ROW (not a session/advisory lock) so it works through PostgREST's
 *     stateless pooled connections and self-heals on crash via TTL expiry.
 *   - Acquisition + release are atomic SQL functions; this module exposes thin,
 *     injectable wrappers plus a PURE model of the lease semantics
 *     ({@link claimLease}/{@link canRelease}) that the SQL implements identically,
 *     so the rules are unit-testable without a database.
 *   - FAIL-OPEN: if the RPC/table is absent, acquisition returns `null` and the
 *     run proceeds exactly as before (no protection, but no outage).
 *
 * It changes NO model maths, recommendation, or staking — it only gates entry.
 * Structured events (MODEL_LOCK_ACQUIRED / _SKIPPED / _RELEASED / _EXPIRED) are
 * emitted for observability.
 */

import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from './supabaseAdmin';

/** Default lease TTL — far longer than a model run (seconds); bounds a crashed holder. */
export const MODEL_LOCK_TTL_SECONDS = 120;

/** The structured lock lifecycle events. */
export type ModelLockEvent =
  | 'MODEL_LOCK_ACQUIRED'
  | 'MODEL_LOCK_SKIPPED'
  | 'MODEL_LOCK_RELEASED'
  | 'MODEL_LOCK_EXPIRED';

/** Outcome of an acquisition attempt. */
export interface LockAcquireResult {
  /** True when this caller now holds the lease. */
  acquired: boolean;
  /** True when acquisition reclaimed a crashed holder's EXPIRED lease. */
  stoleExpired: boolean;
}

// --- Pure lease semantics (mirror the SQL exactly; unit-testable) -----------

/** A lease row, in epoch-ms (the pure model of `model_run_locks`). */
export interface Lease {
  owner: string;
  acquiredAtMs: number;
  expiresAtMs: number;
}

/** The pure decision of one acquisition attempt. */
export interface ClaimResult {
  acquired: boolean;
  stoleExpired: boolean;
  /** The resulting lease (the new one when acquired, else the unchanged existing). */
  lease: Lease | null;
}

/**
 * Pure model of `try_acquire_model_lock`: claim when there is no lease, OR steal
 * an EXPIRED lease; refuse a LIVE lease held by anyone (including a stale copy of
 * ourselves). TTL is clamped to ≥ 1ms. Deterministic; the SQL function encodes
 * the identical rule.
 */
export function claimLease(
  existing: Lease | null,
  owner: string,
  nowMs: number,
  ttlMs: number,
): ClaimResult {
  const newLease: Lease = {
    owner,
    acquiredAtMs: nowMs,
    expiresAtMs: nowMs + Math.max(ttlMs, 1),
  };
  if (existing === null) {
    return { acquired: true, stoleExpired: false, lease: newLease };
  }
  if (existing.expiresAtMs <= nowMs) {
    return { acquired: true, stoleExpired: true, lease: newLease }; // crashed holder reclaimed
  }
  return { acquired: false, stoleExpired: false, lease: existing }; // live lease held elsewhere
}

/**
 * Pure model of the owner-scoped release: a lease may be released only by its
 * current owner (so a lease stolen after TTL expiry is never released by the old
 * owner). The SQL `release_model_lock` encodes the identical rule.
 */
export function canRelease(existing: Lease | null, owner: string): boolean {
  return existing !== null && existing.owner === owner;
}

// --- Structured logging -----------------------------------------------------

/** Emits one structured, greppable lock event line. */
export function logModelLockEvent(event: ModelLockEvent, details: Record<string, unknown>): void {
  const line = JSON.stringify({ event, ...details, ts: new Date().toISOString() });
  // Contention + expiry (a prior holder vanished) are worth a warn; the rest log.
  if (event === 'MODEL_LOCK_SKIPPED' || event === 'MODEL_LOCK_EXPIRED') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// --- Real RPC wrappers (injectable client for tests) ------------------------

/** The minimal Supabase surface this module needs (injectable in tests). */
export interface ModelLockRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

const defaultClient = supabaseAdmin as unknown as ModelLockRpcClient;

/**
 * Attempts to acquire the per-race lease via the `try_acquire_model_lock` RPC.
 * Returns the outcome, or `null` when the RPC/table is unavailable (FAIL-OPEN —
 * the caller then proceeds without a lease). Never throws.
 */
export async function tryAcquireModelLock(
  raceId: string,
  owner: string,
  client: ModelLockRpcClient = defaultClient,
): Promise<LockAcquireResult | null> {
  try {
    const { data, error } = await client.rpc('try_acquire_model_lock', {
      p_race_id: raceId,
      p_owner: owner,
      p_ttl_seconds: MODEL_LOCK_TTL_SECONDS,
    });
    if (error) {
      console.warn(
        `[modelRunLock] try_acquire_model_lock unavailable (${error.message}); proceeding FAIL-OPEN for race ${raceId}`,
      );
      return null;
    }
    const obj = (data ?? {}) as { acquired?: unknown; stole_expired?: unknown };
    return { acquired: obj.acquired === true, stoleExpired: obj.stole_expired === true };
  } catch (err) {
    console.warn(
      `[modelRunLock] try_acquire_model_lock threw (${err instanceof Error ? err.message : String(err)}); proceeding FAIL-OPEN for race ${raceId}`,
    );
    return null;
  }
}

/**
 * Releases the per-race lease via the owner-scoped `release_model_lock` RPC.
 * Best-effort: never throws (a failed release simply lets the lease TTL-expire).
 */
export async function releaseModelLock(
  raceId: string,
  owner: string,
  client: ModelLockRpcClient = defaultClient,
): Promise<void> {
  try {
    const { error } = await client.rpc('release_model_lock', {
      p_race_id: raceId,
      p_owner: owner,
    });
    if (error) {
      console.warn(`[modelRunLock] release failed for race ${raceId} (${error.message}); lease will TTL-expire`);
    }
  } catch (err) {
    console.warn(
      `[modelRunLock] release threw for race ${raceId} (${err instanceof Error ? err.message : String(err)}); lease will TTL-expire`,
    );
  }
}

// --- Orchestrator -----------------------------------------------------------

/** Injected side effects for {@link withModelRunLock} (faked in tests). */
export interface ModelLockDeps {
  acquire: (raceId: string, owner: string) => Promise<LockAcquireResult | null>;
  release: (raceId: string, owner: string) => Promise<void>;
  log: (event: ModelLockEvent, details: Record<string, unknown>) => void;
  newOwner: () => string;
}

/** The real, Supabase-backed deps. */
export function defaultModelLockDeps(): ModelLockDeps {
  return {
    acquire: (raceId, owner) => tryAcquireModelLock(raceId, owner),
    release: (raceId, owner) => releaseModelLock(raceId, owner),
    log: logModelLockEvent,
    newOwner: () => randomUUID(),
  };
}

/**
 * Runs `fn` while holding the per-race lease. Behaviour:
 *   - acquired        → log MODEL_LOCK_ACQUIRED (or MODEL_LOCK_EXPIRED when it
 *                       reclaimed a crashed holder), run `fn`, then release +
 *                       log MODEL_LOCK_RELEASED (always, even if `fn` throws).
 *   - held by another → log MODEL_LOCK_SKIPPED, DO NOT run `fn`, return `null`.
 *   - lock unavailable (RPC/table missing) → FAIL-OPEN: run `fn` without a lease,
 *                       no acquire/release events.
 *
 * Deadlock-free: one lease per race, acquire-one/release-one; never hold two race
 * leases at once. Pure orchestration over injected deps — fully unit-testable.
 */
export async function withModelRunLock<T>(
  raceId: string,
  fn: () => Promise<T>,
  deps: ModelLockDeps = defaultModelLockDeps(),
): Promise<T | null> {
  const owner = deps.newOwner();
  const lock = await deps.acquire(raceId, owner);

  if (lock && !lock.acquired) {
    deps.log('MODEL_LOCK_SKIPPED', { race_id: raceId, owner });
    return null; // another run owns this race; the holder produces the run
  }

  const holdsLock = lock?.acquired === true;
  if (holdsLock) {
    deps.log(lock!.stoleExpired ? 'MODEL_LOCK_EXPIRED' : 'MODEL_LOCK_ACQUIRED', {
      race_id: raceId,
      owner,
    });
  }
  // lock === null → FAIL-OPEN: proceed without a lease (no events).

  try {
    return await fn();
  } finally {
    if (holdsLock) {
      await deps.release(raceId, owner);
      deps.log('MODEL_LOCK_RELEASED', { race_id: raceId, owner });
    }
  }
}
