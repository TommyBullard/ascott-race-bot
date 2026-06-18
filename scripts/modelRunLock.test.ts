/**
 * Unit tests for the per-race model-run TTL lease lock (src/lib/modelRunLock.ts).
 *
 * No DB: the SQL semantics are mirrored by the PURE claimLease/canRelease (the
 * functions the migration implements identically), and the orchestrator is driven
 * by injected fakes. Covers the required cases: concurrent run attempts, crash
 * recovery, lease expiry, and release ownership protection. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  claimLease,
  canRelease,
  withModelRunLock,
  tryAcquireModelLock,
  releaseModelLock,
  type Lease,
  type ModelLockDeps,
  type ModelLockEvent,
  type ModelLockRpcClient,
  type LockAcquireResult,
} from '../src/lib/modelRunLock';

const TTL = 120_000;

/* ----------------------------- pure semantics ----------------------------- */

test('claimLease: no existing lease -> acquired, not stolen', () => {
  const r = claimLease(null, 'A', 1000, TTL);
  assert.equal(r.acquired, true);
  assert.equal(r.stoleExpired, false);
  assert.equal(r.lease?.owner, 'A');
  assert.equal(r.lease?.expiresAtMs, 1000 + TTL);
});

test('concurrent attempt: a LIVE lease held by another owner is refused', () => {
  const live: Lease = { owner: 'A', acquiredAtMs: 1000, expiresAtMs: 1000 + TTL };
  const r = claimLease(live, 'B', 2000, TTL); // B attempts while A's lease is live
  assert.equal(r.acquired, false);
  assert.equal(r.stoleExpired, false);
  assert.equal(r.lease, live); // unchanged — A keeps it
});

test('lease expiry / crash recovery: an EXPIRED lease is stolen', () => {
  const expired: Lease = { owner: 'A', acquiredAtMs: 0, expiresAtMs: 1000 };
  const r = claimLease(expired, 'B', 1000, TTL); // now == expiresAt -> expired
  assert.equal(r.acquired, true);
  assert.equal(r.stoleExpired, true);
  assert.equal(r.lease?.owner, 'B');
});

test('claimLease: ttl is clamped to >= 1ms', () => {
  const r = claimLease(null, 'A', 5000, 0);
  assert.equal(r.lease?.expiresAtMs, 5001);
});

test('release ownership protection: only the current owner may release', () => {
  const lease: Lease = { owner: 'A', acquiredAtMs: 1000, expiresAtMs: 1000 + TTL };
  assert.equal(canRelease(lease, 'A'), true);
  assert.equal(canRelease(lease, 'B'), false); // a stealer/old owner cannot release A's lease
  assert.equal(canRelease(null, 'A'), false);
});

/* ----------------------------- orchestrator ------------------------------- */

/** Deps backed by fixed acquire/release results + an event capture. */
function fakeDeps(
  owner: string,
  acquire: LockAcquireResult | null,
  events: string[],
  spies?: { onRelease?: () => void; onFn?: () => void },
): ModelLockDeps {
  return {
    acquire: async () => acquire,
    release: async () => spies?.onRelease?.(),
    log: (e: ModelLockEvent) => events.push(e),
    newOwner: () => owner,
  };
}

test('withModelRunLock: acquired -> runs fn, logs ACQUIRED then RELEASED', async () => {
  const events: string[] = [];
  let released = false;
  let ran = false;
  const out = await withModelRunLock(
    'R',
    async () => { ran = true; return 'result'; },
    fakeDeps('o', { acquired: true, stoleExpired: false }, events, { onRelease: () => { released = true; } }),
  );
  assert.equal(out, 'result');
  assert.equal(ran, true);
  assert.equal(released, true);
  assert.deepEqual(events, ['MODEL_LOCK_ACQUIRED', 'MODEL_LOCK_RELEASED']);
});

test('withModelRunLock: held by another -> SKIPPED, fn NOT run, returns null, no release', async () => {
  const events: string[] = [];
  let ran = false;
  let released = false;
  const out = await withModelRunLock(
    'R',
    async () => { ran = true; return 'x'; },
    fakeDeps('o', { acquired: false, stoleExpired: false }, events, { onRelease: () => { released = true; } }),
  );
  assert.equal(out, null);
  assert.equal(ran, false);
  assert.equal(released, false);
  assert.deepEqual(events, ['MODEL_LOCK_SKIPPED']);
});

test('withModelRunLock: stolen expired lease logs EXPIRED (crash recovery)', async () => {
  const events: string[] = [];
  const out = await withModelRunLock(
    'R',
    async () => 'ok',
    fakeDeps('o', { acquired: true, stoleExpired: true }, events),
  );
  assert.equal(out, 'ok');
  assert.deepEqual(events, ['MODEL_LOCK_EXPIRED', 'MODEL_LOCK_RELEASED']);
});

test('withModelRunLock: FAIL-OPEN when lock unavailable -> runs fn, no events, no release', async () => {
  const events: string[] = [];
  let released = false;
  const out = await withModelRunLock(
    'R',
    async () => 'ran-anyway',
    fakeDeps('o', null, events, { onRelease: () => { released = true; } }),
  );
  assert.equal(out, 'ran-anyway');
  assert.equal(released, false);
  assert.deepEqual(events, []);
});

test('withModelRunLock: fn throwing still releases (finally) then rethrows', async () => {
  const events: string[] = [];
  let released = false;
  await assert.rejects(
    () =>
      withModelRunLock(
        'R',
        async () => { throw new Error('boom'); },
        fakeDeps('o', { acquired: true, stoleExpired: false }, events, { onRelease: () => { released = true; } }),
      ),
    /boom/,
  );
  assert.equal(released, true);
  assert.deepEqual(events, ['MODEL_LOCK_ACQUIRED', 'MODEL_LOCK_RELEASED']);
});

/* ------------------- concurrency via an in-memory lease ------------------- */

/** An in-memory lease store backed by the PURE claimLease/canRelease. */
function inMemoryLock() {
  let lease: Lease | null = null;
  return {
    acquire: async (_raceId: string, owner: string): Promise<LockAcquireResult> => {
      const r = claimLease(lease, owner, Date.now(), TTL);
      if (r.acquired) lease = r.lease;
      return { acquired: r.acquired, stoleExpired: r.stoleExpired };
    },
    release: async (_raceId: string, owner: string): Promise<void> => {
      if (canRelease(lease, owner)) lease = null;
    },
    peek: () => lease,
  };
}

function depsFor(owner: string, store: ReturnType<typeof inMemoryLock>, events: string[]): ModelLockDeps {
  return {
    acquire: store.acquire,
    release: store.release,
    log: (e) => events.push(`${e}:${owner}`),
    newOwner: () => owner,
  };
}

test('two concurrent runs on one race: exactly one proceeds; the other is skipped', async () => {
  const store = inMemoryLock();
  const events: string[] = [];

  // A acquires and HOLDS the lease while its fn awaits a gate.
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  const aPromise = withModelRunLock(
    'R',
    async () => { await gate; return 'A'; },
    depsFor('ownerA', store, events),
  );
  // Let A's acquire settle before B attempts.
  await Promise.resolve();
  await Promise.resolve();

  // B attempts WHILE A holds the lease -> skipped.
  const bResult = await withModelRunLock('R', async () => 'B', depsFor('ownerB', store, events));
  assert.equal(bResult, null);

  // Release A; it completes and frees the lease.
  openGate();
  const aResult = await aPromise;
  assert.equal(aResult, 'A');
  assert.equal(store.peek(), null); // A released — lease is free again

  assert.ok(events.includes('MODEL_LOCK_ACQUIRED:ownerA'));
  assert.ok(events.includes('MODEL_LOCK_SKIPPED:ownerB'));
  assert.ok(events.includes('MODEL_LOCK_RELEASED:ownerA'));
});

/* --------------------------- RPC wrapper mapping --------------------------- */

function fakeRpc(
  result: { data: unknown; error: { message: string } | null },
  capture?: { calls: Array<{ fn: string; args: Record<string, unknown> }> },
): ModelLockRpcClient {
  return {
    rpc: async (fn, args) => {
      capture?.calls.push({ fn, args });
      return result;
    },
  };
}

test('tryAcquireModelLock: maps jsonb; error -> null (fail-open)', async () => {
  const acq = await tryAcquireModelLock('R', 'o', fakeRpc({ data: { acquired: true, stole_expired: false }, error: null }));
  assert.deepEqual(acq, { acquired: true, stoleExpired: false });

  const stole = await tryAcquireModelLock('R', 'o', fakeRpc({ data: { acquired: true, stole_expired: true }, error: null }));
  assert.deepEqual(stole, { acquired: true, stoleExpired: true });

  const held = await tryAcquireModelLock('R', 'o', fakeRpc({ data: { acquired: false, stole_expired: false }, error: null }));
  assert.deepEqual(held, { acquired: false, stoleExpired: false });

  const missing = await tryAcquireModelLock('R', 'o', fakeRpc({ data: null, error: { message: 'function does not exist' } }));
  assert.equal(missing, null); // FAIL-OPEN
});

test('releaseModelLock: calls release_model_lock with owner-scoped args; never throws', async () => {
  const capture = { calls: [] as Array<{ fn: string; args: Record<string, unknown> }> };
  await releaseModelLock('R', 'o', fakeRpc({ data: true, error: null }, capture));
  assert.deepEqual(capture.calls[0], { fn: 'release_model_lock', args: { p_race_id: 'R', p_owner: 'o' } });

  // A failing release is swallowed (lease will TTL-expire).
  await releaseModelLock('R', 'o', fakeRpc({ data: null, error: { message: 'down' } }));
});
