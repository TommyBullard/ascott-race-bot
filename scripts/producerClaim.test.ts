/**
 * Tests for the day-level producer ownership claim
 * (src/lib/producerClaim.ts + scripts/producerClaimCheck.ts) — Nationwide
 * rebuild Phase 7A.2b Step 1, hardened per the independent Producer
 * Ownership Safety Review.
 *
 * Proves scope/date validation reuses `normalizeCourse` (no second rule),
 * the pure lease-decision model (mirrors the migration's SQL exactly: first
 * claim, same-owner idempotent renewal, expired-claim theft, live-claim
 * refusal, GENERATION/fencing-token behaviour), owner-scoped
 * heartbeat/release, the conservative "every scope conflicts with every
 * scope" policy, TTL clamping ([30, 900]s, mirroring the SQL clamp),
 * FAIL-CLOSED classification (missing table / permission denied / malformed
 * response / transient error / the bounded contended-path-retry anomaly are
 * all DISTINCT outcomes, never a silent proceed), server-time-based claim
 * liveness classification, the pure --json CLI builders, metadata
 * sanitisation, and — by source scan — that nothing here ever calls a
 * provider, runs the model, or touches
 * lock:t-minus/results:auto/pipeline:day/pipeline:watch, and that no
 * --commit flag exists anywhere. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ALL_UK_IRE_SCOPE,
  PRODUCER_CLAIM_DEFAULT_TTL_SECONDS,
  PRODUCER_CLAIM_MAX_TTL_SECONDS,
  PRODUCER_CLAIM_MIN_TTL_SECONDS,
  buildClaimJson,
  buildCourseScope,
  buildHeartbeatJson,
  buildReleaseJson,
  buildStatusJson,
  canHeartbeat,
  canRelease,
  clampTtlSeconds,
  classifyClaimError,
  classifyClaimLiveness,
  decideClaim,
  fetchProducerClaimStatus,
  heartbeatProducerClaim,
  isValidRaceDate,
  isValidScope,
  newOwnerId,
  normalizeScopeInput,
  releaseProducerClaim,
  sanitizeMetadataValue,
  tryAcquireProducerClaim,
  type AcquireOutcome,
  type HeartbeatOutcome,
  type ProducerClaimRpcClient,
  type ProducerClaimStatus,
  type ProducerLease,
  type ReleaseOutcome,
  type StatusOutcome,
} from '../src/lib/producerClaim';

const NOW = Date.parse('2026-07-11T14:00:00.000Z');
const TTL_MS = PRODUCER_CLAIM_DEFAULT_TTL_SECONDS * 1000;

/* ------------------------------ scope / date -------------------------------- */

test('isValidRaceDate: strict round-tripping YYYY-MM-DD', () => {
  assert.equal(isValidRaceDate('2026-07-11'), true);
  assert.equal(isValidRaceDate('2026-13-01'), false);
  assert.equal(isValidRaceDate('2026-02-30'), false);
  assert.equal(isValidRaceDate('11-07-2026'), false);
  assert.equal(isValidRaceDate(''), false);
  assert.equal(isValidRaceDate(null), false);
});

test('buildCourseScope reuses normalizeCourse verbatim — no second normalisation rule', () => {
  assert.equal(buildCourseScope('Newmarket'), 'course:newmarket');
  assert.equal(buildCourseScope('Royal Ascot'), 'course:ascot'); // the SAME alias raceSync.ts defines
  assert.equal(buildCourseScope('Lingfield (AW)'), 'course:lingfield');
});

test('isValidScope: all-uk-ire and well-formed course scopes valid; garbage rejected', () => {
  assert.equal(isValidScope(ALL_UK_IRE_SCOPE), true);
  assert.equal(isValidScope('course:newmarket'), true);
  assert.equal(isValidScope('course:royal ascot'.replace(' ', ' ')), true); // multi-word, lowercase
  assert.equal(isValidScope('course:Newmarket'), false); // uppercase — not normalised
  assert.equal(isValidScope('course:'), false); // empty course
  assert.equal(isValidScope('newmarket'), false); // missing prefix
  assert.equal(isValidScope(''), false);
});

test('normalizeScopeInput: normalises operator-typed course input before validation', () => {
  assert.equal(normalizeScopeInput('all-uk-ire'), 'all-uk-ire');
  assert.equal(normalizeScopeInput('course:Newmarket'), 'course:newmarket');
  assert.equal(normalizeScopeInput('course:Royal Ascot'), 'course:ascot');
  // Garbage passes through unchanged so isValidScope can reject it explicitly.
  assert.equal(normalizeScopeInput('garbage'), 'garbage');
  assert.equal(isValidScope(normalizeScopeInput('garbage')), false);
});

/* --------------------------------- TTL clamp --------------------------------- */

test('clampTtlSeconds: below 30 clamps to 30, above 900 clamps to 900, normal unchanged', () => {
  assert.equal(clampTtlSeconds(5), PRODUCER_CLAIM_MIN_TTL_SECONDS);
  assert.equal(clampTtlSeconds(1), PRODUCER_CLAIM_MIN_TTL_SECONDS);
  assert.equal(clampTtlSeconds(0), PRODUCER_CLAIM_MIN_TTL_SECONDS);
  assert.equal(clampTtlSeconds(-100), PRODUCER_CLAIM_MIN_TTL_SECONDS);
  assert.equal(clampTtlSeconds(86_400), PRODUCER_CLAIM_MAX_TTL_SECONDS);
  assert.equal(clampTtlSeconds(901), PRODUCER_CLAIM_MAX_TTL_SECONDS);
  assert.equal(clampTtlSeconds(240), 240);
  assert.equal(clampTtlSeconds(30), 30);
  assert.equal(clampTtlSeconds(900), 900);
});

test('clampTtlSeconds: malformed input (NaN/Infinity) fails safe to the default TTL', () => {
  assert.equal(clampTtlSeconds(NaN), PRODUCER_CLAIM_DEFAULT_TTL_SECONDS);
  assert.equal(clampTtlSeconds(Infinity), PRODUCER_CLAIM_DEFAULT_TTL_SECONDS);
  assert.equal(clampTtlSeconds(-Infinity), PRODUCER_CLAIM_DEFAULT_TTL_SECONDS);
});

/* --------------------------- pure lease decisions --------------------------- */

function lease(over: Partial<ProducerLease> = {}): ProducerLease {
  return {
    owner: 'owner-a',
    scope: ALL_UK_IRE_SCOPE,
    generation: 1,
    claimedAtMs: NOW - 60_000,
    heartbeatAtMs: NOW - 30_000,
    expiresAtMs: NOW + 60_000, // still live
    ...over,
  };
}

test('decideClaim: no existing lease -> fresh acquire at generation 1', () => {
  const d = decideClaim(null, 'owner-a', ALL_UK_IRE_SCOPE, NOW, TTL_MS);
  assert.equal(d.acquired, true);
  assert.equal(d.stoleExpired, false);
  assert.deepEqual(d.lease, {
    owner: 'owner-a',
    scope: ALL_UK_IRE_SCOPE,
    generation: 1,
    claimedAtMs: NOW,
    heartbeatAtMs: NOW,
    expiresAtMs: NOW + TTL_MS,
  });
});

test('decideClaim: SAME owner re-claiming while live -> idempotent renewal (not a fresh claim); generation UNCHANGED', () => {
  const existing = lease({ claimedAtMs: NOW - 120_000, generation: 4 });
  const d = decideClaim(existing, 'owner-a', 'course:newmarket', NOW, TTL_MS);
  assert.equal(d.acquired, true);
  assert.equal(d.stoleExpired, false);
  assert.equal(d.lease.claimedAtMs, existing.claimedAtMs); // claimed_at NOT reset — this is a renewal
  assert.equal(d.lease.heartbeatAtMs, NOW);
  assert.equal(d.lease.expiresAtMs, NOW + TTL_MS);
  assert.equal(d.lease.scope, 'course:newmarket'); // scope can be updated on renewal
  assert.equal(d.lease.generation, 4); // renewal is NOT a takeover — generation unchanged
});

test('decideClaim: DIFFERENT owner, live lease -> refused, current lease (incl. generation) reported unchanged', () => {
  const existing = lease({ owner: 'owner-a', generation: 7 });
  const d = decideClaim(existing, 'owner-b', 'course:newmarket', NOW, TTL_MS);
  assert.equal(d.acquired, false);
  assert.equal(d.stoleExpired, false);
  assert.deepEqual(d.lease, existing);
  assert.equal(d.lease.generation, 7);
});

test('decideClaim: DIFFERENT owner, EXPIRED lease -> stolen atomically; generation increments EXACTLY ONCE', () => {
  const existing = lease({ owner: 'owner-a', expiresAtMs: NOW - 1, generation: 3 });
  const d = decideClaim(existing, 'owner-b', ALL_UK_IRE_SCOPE, NOW, TTL_MS);
  assert.equal(d.acquired, true);
  assert.equal(d.stoleExpired, true);
  assert.equal(d.lease.owner, 'owner-b');
  assert.equal(d.lease.claimedAtMs, NOW); // a fresh claim, not a renewal
  assert.equal(d.lease.generation, 4); // 3 + 1, exactly once
});

test('decideClaim: expiry is inclusive (expires_at === now counts as expired) — server-time boundary', () => {
  const existing = lease({ owner: 'owner-a', expiresAtMs: NOW, generation: 1 }); // exactly at boundary
  const d = decideClaim(existing, 'owner-b', ALL_UK_IRE_SCOPE, NOW, TTL_MS);
  assert.equal(d.acquired, true);
  assert.equal(d.stoleExpired, true);
  assert.equal(d.lease.generation, 2);
});

test('decideClaim: a live claim can NEVER be stolen, regardless of requested scope', () => {
  // all-uk-ire vs course:X conflict — same date, different owner, different scope, still refused.
  const nationwide = lease({ owner: 'owner-a', scope: ALL_UK_IRE_SCOPE });
  assert.equal(decideClaim(nationwide, 'owner-b', 'course:newmarket', NOW, TTL_MS).acquired, false);
  // course:X vs course:Y conflict — the conservative policy: ANY two scopes conflict for one date.
  const courseA = lease({ owner: 'owner-a', scope: 'course:ascot' });
  assert.equal(decideClaim(courseA, 'owner-b', 'course:newmarket', NOW, TTL_MS).acquired, false);
  // course:X vs course:X (same course, different owner) also conflicts.
  assert.equal(decideClaim(courseA, 'owner-b', 'course:ascot', NOW, TTL_MS).acquired, false);
});

test('decideClaim: TTL is clamped to [30s, 900s], mirroring the SQL clamp', () => {
  const tooShort = decideClaim(null, 'owner-a', ALL_UK_IRE_SCOPE, NOW, 5_000); // 5s requested
  assert.equal(tooShort.lease.expiresAtMs, NOW + PRODUCER_CLAIM_MIN_TTL_SECONDS * 1000);

  const tooLong = decideClaim(null, 'owner-a', ALL_UK_IRE_SCOPE, NOW, 86_400_000); // 1 day requested
  assert.equal(tooLong.lease.expiresAtMs, NOW + PRODUCER_CLAIM_MAX_TTL_SECONDS * 1000);

  const normal = decideClaim(null, 'owner-a', ALL_UK_IRE_SCOPE, NOW, 240_000); // 240s, unchanged
  assert.equal(normal.lease.expiresAtMs, NOW + 240_000);
});

test('canHeartbeat / canRelease: owner-scoped; wrong owner and no-existing-lease both refused', () => {
  const existing = lease({ owner: 'owner-a' });
  assert.equal(canHeartbeat(existing, 'owner-a'), true);
  assert.equal(canHeartbeat(existing, 'owner-b'), false);
  assert.equal(canHeartbeat(null, 'owner-a'), false);
  assert.equal(canRelease(existing, 'owner-a'), true);
  assert.equal(canRelease(existing, 'owner-b'), false);
  assert.equal(canRelease(null, 'owner-a'), false);
});

/* ------------------------------ metadata safety ------------------------------ */

test('sanitizeMetadataValue: trims, redacts credential-shaped values, truncates, never throws', () => {
  assert.equal(sanitizeMetadataValue('  my-laptop  '), 'my-laptop');
  assert.equal(sanitizeMetadataValue(''), null);
  assert.equal(sanitizeMetadataValue(null), null);
  assert.equal(sanitizeMetadataValue(undefined), null);
  assert.equal(sanitizeMetadataValue('SUPABASE_SERVICE_ROLE_KEY=abc123'), '[redacted]');
  assert.equal(sanitizeMetadataValue('Bearer eyJhbGciOi...'), '[redacted]');
  assert.equal(sanitizeMetadataValue('my_secret_token'), '[redacted]');
  const long = 'x'.repeat(500);
  assert.equal(sanitizeMetadataValue(long)!.length, 120);
});

test('newOwnerId: produces a non-empty, distinct id each call', () => {
  const a = newOwnerId();
  const b = newOwnerId();
  assert.ok(a.length > 0);
  assert.notEqual(a, b);
});

/* --------------------------- fail-closed classification --------------------- */

test('classifyClaimError: missing table -> mechanism_unavailable; other errors -> transient_uncertain', () => {
  assert.equal(classifyClaimError({ code: '42P01', message: 'relation does not exist' }).kind, 'mechanism_unavailable');
  assert.equal(classifyClaimError({ message: 'schema cache stale' }).kind, 'mechanism_unavailable');
  assert.equal(classifyClaimError({ code: '53300', message: 'too many connections' }).kind, 'transient_uncertain');
  assert.equal(classifyClaimError({ message: 'unexpected token' }).kind, 'transient_uncertain');
});

test('classifyClaimError: permission denied (42501, or message text) -> mechanism_unavailable, NEVER transient', () => {
  assert.equal(classifyClaimError({ code: '42501', message: 'permission denied for table producer_run_claims' }).kind, 'mechanism_unavailable');
  // Even without a code, a "permission denied" message is not treated as a retry-worthy transient blip.
  assert.equal(classifyClaimError({ message: 'permission denied for function try_acquire_producer_claim' }).kind, 'mechanism_unavailable');
  // Distinct from a genuinely transient error, which stays transient_uncertain.
  assert.equal(classifyClaimError({ code: '08006', message: 'connection failure' }).kind, 'transient_uncertain');
});

/* --------------------------- claim liveness (server time) ------------------- */

function statusClaim(over: Partial<ProducerClaimStatus> = {}): ProducerClaimStatus {
  return {
    raceDate: '2026-07-11',
    scope: ALL_UK_IRE_SCOPE,
    ownerId: 'owner-a',
    generation: 1,
    claimedAt: '2026-07-11T13:56:00.000Z',
    heartbeatAt: '2026-07-11T13:58:00.000Z',
    expiresAt: '2026-07-11T14:04:00.000Z',
    hostname: null,
    pid: null,
    appVersion: null,
    mode: null,
    ...over,
  };
}

test('classifyClaimLiveness: absent when no claim', () => {
  assert.deepEqual(classifyClaimLiveness(null, NOW), { status: 'absent', remainingSeconds: null, expiredSeconds: null });
});

test('classifyClaimLiveness: live claim reports non-negative remaining seconds', () => {
  const claim = statusClaim({ expiresAt: '2026-07-11T14:03:07.000Z' }); // 187s after NOW
  const result = classifyClaimLiveness(claim, NOW);
  assert.equal(result.status, 'live');
  assert.equal(result.remainingSeconds, 187);
  assert.equal(result.expiredSeconds, null);
  assert.ok(result.remainingSeconds! >= 0);
});

test('classifyClaimLiveness: expired claim reports non-negative elapsed seconds', () => {
  const claim = statusClaim({ expiresAt: '2026-07-11T13:54:48.000Z' }); // 312s before NOW
  const result = classifyClaimLiveness(claim, NOW);
  assert.equal(result.status, 'expired');
  assert.equal(result.expiredSeconds, 312);
  assert.equal(result.remainingSeconds, null);
  assert.ok(result.expiredSeconds! >= 0);
});

test('classifyClaimLiveness: exactly-at-boundary (expires_at === server now) counts as expired, never negative', () => {
  const claim = statusClaim({ expiresAt: new Date(NOW).toISOString() });
  const result = classifyClaimLiveness(claim, NOW);
  assert.equal(result.status, 'expired');
  assert.equal(result.expiredSeconds, 0);
});

test('classifyClaimLiveness: unavailable/unparseable server time or claim timestamp reports unknown, never fabricated', () => {
  assert.equal(classifyClaimLiveness(statusClaim(), NaN).status, 'unknown');
  assert.equal(classifyClaimLiveness(statusClaim({ expiresAt: 'not-a-timestamp' }), NOW).status, 'unknown');
});

/* --------------------------- RPC wrapper fail-closed shapes ------------------ */

function fakeRpcClient(
  impl: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { code?: string; message: string } | null },
): ProducerClaimRpcClient {
  return { rpc: async (fn, args) => impl(fn, args) };
}

test('tryAcquireProducerClaim: rejects invalid input WITHOUT calling the database', async () => {
  let called = false;
  const client = fakeRpcClient(() => {
    called = true;
    return { data: null, error: null };
  });
  const result = await tryAcquireProducerClaim(
    { raceDate: 'not-a-date', scope: ALL_UK_IRE_SCOPE, ownerId: 'x' },
    client,
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, 'invalid_input');
  assert.equal(called, false);

  const badScope = await tryAcquireProducerClaim(
    { raceDate: '2026-07-11', scope: 'nonsense', ownerId: 'x' },
    client,
  );
  assert.equal(badScope.ok, false);
  assert.equal(!badScope.ok && badScope.failure.kind, 'invalid_input');
  assert.equal(called, false);

  const noOwner = await tryAcquireProducerClaim(
    { raceDate: '2026-07-11', scope: ALL_UK_IRE_SCOPE, ownerId: '' },
    client,
  );
  assert.equal(noOwner.ok, false);
  assert.equal(!noOwner.ok && noOwner.failure.kind, 'invalid_input');
  assert.equal(called, false);
});

test('tryAcquireProducerClaim: missing table -> FAIL CLOSED (never a silent proceed)', async () => {
  const client = fakeRpcClient(() => ({
    data: null,
    error: { code: '42P01', message: 'relation "producer_run_claims" does not exist' },
  }));
  const result = await tryAcquireProducerClaim(
    { raceDate: '2026-07-11', scope: ALL_UK_IRE_SCOPE, ownerId: 'owner-a' },
    client,
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, 'mechanism_unavailable');
});

test('tryAcquireProducerClaim: permission denied -> FAIL CLOSED as mechanism_unavailable, not transient', async () => {
  const client = fakeRpcClient(() => ({
    data: null,
    error: { code: '42501', message: 'permission denied for function try_acquire_producer_claim' },
  }));
  const result = await tryAcquireProducerClaim(
    { raceDate: '2026-07-11', scope: ALL_UK_IRE_SCOPE, ownerId: 'owner-a' },
    client,
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, 'mechanism_unavailable');
});

test('tryAcquireProducerClaim: malformed response shape -> FAIL CLOSED, not treated as success', async () => {
  const client = fakeRpcClient(() => ({ data: { acquired: 'yes' }, error: null })); // wrong type
  const result = await tryAcquireProducerClaim(
    { raceDate: '2026-07-11', scope: ALL_UK_IRE_SCOPE, ownerId: 'owner-a' },
    client,
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, 'mechanism_unavailable');
  assert.match(!result.ok ? result.failure.message : '', /malformed/);
});

test('tryAcquireProducerClaim: acquired:true with missing/invalid generation -> FAIL CLOSED, never silently accepted', async () => {
  const client = fakeRpcClient(() => ({
    data: {
      acquired: true,
      stole_expired: false,
      current_owner_id: 'owner-a',
      current_scope: ALL_UK_IRE_SCOPE,
      current_expires_at: '2026-07-11T18:00:00.000Z',
      // generation deliberately omitted
    },
    error: null,
  }));
  const result = await tryAcquireProducerClaim(
    { raceDate: '2026-07-11', scope: ALL_UK_IRE_SCOPE, ownerId: 'owner-a' },
    client,
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, 'mechanism_unavailable');
});

test('tryAcquireProducerClaim: transient error classified distinctly from missing/malformed/permission', async () => {
  const client = fakeRpcClient(() => ({ data: null, error: { message: 'connection reset' } }));
  const result = await tryAcquireProducerClaim(
    { raceDate: '2026-07-11', scope: ALL_UK_IRE_SCOPE, ownerId: 'owner-a' },
    client,
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, 'transient_uncertain');
});

test('tryAcquireProducerClaim: the bounded contended-path-retry anomaly (identity indeterminate) fails closed as transient_uncertain, never as a silent success or a normal refusal', async () => {
  // This is the SQL's explicit "row vanished twice" anomaly response shape:
  // acquired=false with every current_* field null — distinguishable from
  // BOTH a normal refusal (always carries a real owner id) and a malformed
  // shape (this IS a well-formed, documented response).
  const client = fakeRpcClient(() => ({
    data: {
      acquired: false,
      stole_expired: false,
      generation: null,
      current_owner_id: null,
      current_scope: null,
      current_expires_at: null,
    },
    error: null,
  }));
  const result = await tryAcquireProducerClaim(
    { raceDate: '2026-07-11', scope: ALL_UK_IRE_SCOPE, ownerId: 'owner-a' },
    client,
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, 'transient_uncertain');
  assert.match(!result.ok ? result.failure.message : '', /retry/i);
});

test('tryAcquireProducerClaim: a well-formed response is parsed through cleanly, including generation', async () => {
  const client = fakeRpcClient(() => ({
    data: {
      acquired: true,
      stole_expired: false,
      generation: 3,
      current_owner_id: 'owner-a',
      current_scope: ALL_UK_IRE_SCOPE,
      current_expires_at: '2026-07-11T18:00:00.000Z',
    },
    error: null,
  }));
  const result = await tryAcquireProducerClaim(
    { raceDate: '2026-07-11', scope: ALL_UK_IRE_SCOPE, ownerId: 'owner-a' },
    client,
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.acquired, true);
  assert.equal(result.ok && result.generation, 3);
});

test('tryAcquireProducerClaim: TTL is clamped client-side before being sent to the RPC', async () => {
  let sentTtl: unknown;
  const client = fakeRpcClient((_fn, args) => {
    sentTtl = args.p_ttl_seconds;
    return {
      data: {
        acquired: true,
        stole_expired: false,
        generation: 1,
        current_owner_id: 'owner-a',
        current_scope: ALL_UK_IRE_SCOPE,
        current_expires_at: '2026-07-11T18:00:00.000Z',
      },
      error: null,
    };
  });
  await tryAcquireProducerClaim(
    { raceDate: '2026-07-11', scope: ALL_UK_IRE_SCOPE, ownerId: 'owner-a', ttlSeconds: 86_400 },
    client,
  );
  assert.equal(sentTtl, PRODUCER_CLAIM_MAX_TTL_SECONDS);

  await tryAcquireProducerClaim(
    { raceDate: '2026-07-11', scope: ALL_UK_IRE_SCOPE, ownerId: 'owner-a', ttlSeconds: 3 },
    client,
  );
  assert.equal(sentTtl, PRODUCER_CLAIM_MIN_TTL_SECONDS);
});

test('heartbeatProducerClaim: clean renewed:false is a CONFIRMED loss, distinct from a mechanism error', async () => {
  const cleanLoss = fakeRpcClient(() => ({ data: { renewed: false }, error: null }));
  const lossResult = await heartbeatProducerClaim({ raceDate: '2026-07-11', ownerId: 'owner-b' }, cleanLoss);
  assert.equal(lossResult.ok, true);
  assert.equal(lossResult.ok && lossResult.renewed, false); // confirmed loss, ok:true

  const brokenMechanism = fakeRpcClient(() => ({ data: null, error: { code: '42P01', message: 'missing' } }));
  const errResult = await heartbeatProducerClaim({ raceDate: '2026-07-11', ownerId: 'owner-b' }, brokenMechanism);
  assert.equal(errResult.ok, false); // mechanism unavailable, ok:false — NOT the same signal
  assert.equal(!errResult.ok && errResult.failure.kind, 'mechanism_unavailable');
});

test('heartbeatProducerClaim: owner renewal succeeds cleanly and carries generation, unchanged by the heartbeat itself', async () => {
  const client = fakeRpcClient(() => ({
    data: { renewed: true, generation: 5, expires_at: '2026-07-11T18:04:00.000Z' },
    error: null,
  }));
  const result = await heartbeatProducerClaim({ raceDate: '2026-07-11', ownerId: 'owner-a' }, client);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.renewed, true);
  assert.equal(result.ok && result.renewed && result.generation, 5);
});

test('heartbeatProducerClaim: renewed:true without a valid generation -> FAIL CLOSED', async () => {
  const client = fakeRpcClient(() => ({
    data: { renewed: true, expires_at: '2026-07-11T18:04:00.000Z' }, // generation omitted
    error: null,
  }));
  const result = await heartbeatProducerClaim({ raceDate: '2026-07-11', ownerId: 'owner-a' }, client);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, 'mechanism_unavailable');
});

test('heartbeatProducerClaim: TTL is clamped client-side', async () => {
  let sentTtl: unknown;
  const client = fakeRpcClient((_fn, args) => {
    sentTtl = args.p_ttl_seconds;
    return { data: { renewed: false }, error: null };
  });
  await heartbeatProducerClaim({ raceDate: '2026-07-11', ownerId: 'owner-a', ttlSeconds: 999_999 }, client);
  assert.equal(sentTtl, PRODUCER_CLAIM_MAX_TTL_SECONDS);
});

test('releaseProducerClaim: owner release succeeds; wrong-owner release cleanly returns released:false', async () => {
  const succeeds = fakeRpcClient(() => ({ data: true, error: null }));
  const ok1 = await releaseProducerClaim({ raceDate: '2026-07-11', ownerId: 'owner-a' }, succeeds);
  assert.equal(ok1.ok, true);
  assert.equal(ok1.ok && ok1.released, true);

  const noop = fakeRpcClient(() => ({ data: false, error: null }));
  const ok2 = await releaseProducerClaim({ raceDate: '2026-07-11', ownerId: 'owner-b' }, noop);
  assert.equal(ok2.ok, true);
  assert.equal(ok2.ok && ok2.released, false);
});

test('releaseProducerClaim: missing table -> FAIL CLOSED', async () => {
  const client = fakeRpcClient(() => ({ data: null, error: { code: '42P01', message: 'missing' } }));
  const result = await releaseProducerClaim({ raceDate: '2026-07-11', ownerId: 'owner-a' }, client);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, 'mechanism_unavailable');
});

/* --------------------------- status read (server-time RPC) ------------------ */

test('fetchProducerClaimStatus: unclaimed date returns claim:null, absent liveness, never an error', async () => {
  const client = fakeRpcClient(() => ({ data: { server_now: '2026-07-11T14:00:00.000Z', claim: null }, error: null }));
  const result = await fetchProducerClaimStatus('2026-07-11', client);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.claim, null);
  assert.equal(result.ok && result.liveness.status, 'absent');
});

test('fetchProducerClaimStatus: a claimed date is parsed through cleanly with generation and server-time liveness', async () => {
  const client = fakeRpcClient(() => ({
    data: {
      server_now: '2026-07-11T14:00:00.000Z',
      claim: {
        race_date: '2026-07-11',
        scope: ALL_UK_IRE_SCOPE,
        owner_id: 'owner-a',
        generation: 2,
        claimed_at: '2026-07-11T13:56:00.000Z',
        heartbeat_at: '2026-07-11T13:58:00.000Z',
        expires_at: '2026-07-11T14:03:00.000Z', // 180s after server_now
        hostname: 'my-laptop',
        pid: 1234,
        app_version: 'abc1234',
        mode: 'model_only',
      },
    },
    error: null,
  }));
  const result = await fetchProducerClaimStatus('2026-07-11', client);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.claim);
  assert.equal(result.ok && result.claim?.ownerId, 'owner-a');
  assert.equal(result.ok && result.claim?.generation, 2);
  assert.equal(result.ok && result.liveness.status, 'live');
  assert.equal(result.ok && result.liveness.remainingSeconds, 180);
});

test('fetchProducerClaimStatus: liveness is computed from SERVER time, not local time — a skewed local clock cannot change the classification', async () => {
  // server_now is far in the future relative to any plausible local clock at
  // test-run time; the classification must still be driven entirely by the
  // server_now/expires_at pair returned in the response.
  const client = fakeRpcClient(() => ({
    data: {
      server_now: '2099-01-01T00:00:00.000Z',
      claim: {
        race_date: '2026-07-11',
        scope: ALL_UK_IRE_SCOPE,
        owner_id: 'owner-a',
        generation: 1,
        claimed_at: '2026-07-11T13:56:00.000Z',
        heartbeat_at: '2026-07-11T13:58:00.000Z',
        expires_at: '2026-07-11T14:03:00.000Z', // long before the "server_now" above
        hostname: null,
        pid: null,
        app_version: null,
        mode: null,
      },
    },
    error: null,
  }));
  const result = await fetchProducerClaimStatus('2026-07-11', client);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.liveness.status, 'expired');
  assert.ok(result.ok && result.liveness.expiredSeconds! > 0);
});

test('fetchProducerClaimStatus: malformed row -> FAIL CLOSED', async () => {
  const client = fakeRpcClient(() => ({
    data: { server_now: '2026-07-11T14:00:00.000Z', claim: { race_date: '2026-07-11' } }, // missing fields
    error: null,
  }));
  const result = await fetchProducerClaimStatus('2026-07-11', client);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, 'mechanism_unavailable');
});

test('fetchProducerClaimStatus: missing server_now -> FAIL CLOSED (never fabricates liveness)', async () => {
  const client = fakeRpcClient(() => ({ data: { claim: null }, error: null })); // server_now omitted
  const result = await fetchProducerClaimStatus('2026-07-11', client);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, 'mechanism_unavailable');
});

test('fetchProducerClaimStatus: missing table -> FAIL CLOSED', async () => {
  const client = fakeRpcClient(() => ({ data: null, error: { code: 'PGRST205', message: 'missing' } }));
  const result = await fetchProducerClaimStatus('2026-07-11', client);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, 'mechanism_unavailable');
});

test('fetchProducerClaimStatus: permission denied -> FAIL CLOSED as mechanism_unavailable', async () => {
  const client = fakeRpcClient(() => ({ data: null, error: { code: '42501', message: 'permission denied' } }));
  const result = await fetchProducerClaimStatus('2026-07-11', client);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, 'mechanism_unavailable');
});

test('fetchProducerClaimStatus: invalid date rejected without a query', async () => {
  let called = false;
  const client = fakeRpcClient(() => {
    called = true;
    return { data: null, error: null };
  });
  const result = await fetchProducerClaimStatus('not-a-date', client);
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

/* --------------------------- CLI --json builders (pure) --------------------- */

test('buildStatusJson: absent, live, expired, and unavailable shapes are all valid and deterministic', () => {
  const absent = buildStatusJson('2026-07-11', {
    ok: true,
    claim: null,
    serverNowIso: '2026-07-11T14:00:00.000Z',
    liveness: { status: 'absent', remainingSeconds: null, expiredSeconds: null },
  });
  assert.equal(absent.status, 'absent');
  assert.equal(absent.ok, true);
  assert.equal(absent.owner_id, null);

  const live: StatusOutcome = {
    ok: true,
    claim: statusClaim({ generation: 2 }),
    serverNowIso: '2026-07-11T14:00:00.000Z',
    liveness: { status: 'live', remainingSeconds: 187, expiredSeconds: null },
  };
  const liveJson = buildStatusJson('2026-07-11', live);
  assert.equal(liveJson.status, 'live');
  assert.equal(liveJson.remaining_seconds, 187);
  assert.equal(liveJson.generation, 2);
  assert.equal(liveJson.owner_id, 'owner-a');
  assert.equal(JSON.stringify(liveJson).includes('SUPABASE'), false);

  const unavailable = buildStatusJson('2026-07-11', {
    ok: false,
    failure: { kind: 'mechanism_unavailable', message: 'relation does not exist' },
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.status, 'unavailable');
  assert.deepEqual(unavailable.error, { kind: 'mechanism_unavailable', message: 'relation does not exist' });

  // Determinism: same input -> structurally identical output.
  assert.deepEqual(buildStatusJson('2026-07-11', live), liveJson);
  // Valid JSON: round-trips cleanly.
  assert.deepEqual(JSON.parse(JSON.stringify(liveJson)), liveJson);
});

test('buildClaimJson: acquired, stole_expired, refused, and error classifications', () => {
  const acquired: AcquireOutcome = {
    ok: true,
    acquired: true,
    stoleExpired: false,
    generation: 1,
    currentOwnerId: 'owner-a',
    currentScope: ALL_UK_IRE_SCOPE,
    currentExpiresAt: '2026-07-11T18:00:00.000Z',
  };
  const acquiredJson = buildClaimJson('2026-07-11', ALL_UK_IRE_SCOPE, 'owner-a', acquired);
  assert.equal(acquiredJson.classification, 'acquired');
  assert.equal(acquiredJson.operation, 'claim');

  const stolen: AcquireOutcome = { ...acquired, stoleExpired: true, generation: 2 };
  assert.equal(buildClaimJson('2026-07-11', ALL_UK_IRE_SCOPE, 'owner-b', stolen).classification, 'stole_expired');

  const refused: AcquireOutcome = { ...acquired, acquired: false, currentOwnerId: 'owner-a' };
  const refusedJson = buildClaimJson('2026-07-11', 'course:newmarket', 'owner-b', refused);
  assert.equal(refusedJson.classification, 'refused');
  assert.equal(refusedJson.requested_scope, 'course:newmarket');

  const errored = buildClaimJson('2026-07-11', ALL_UK_IRE_SCOPE, 'owner-a', {
    ok: false,
    failure: { kind: 'invalid_input', message: 'bad scope' },
  });
  assert.equal(errored.ok, false);
  assert.equal(errored.classification, 'error');
  assert.equal(JSON.stringify(errored).includes('secret'), false);
});

test('buildHeartbeatJson: renewed, ownership_lost, and error classifications', () => {
  const renewed: HeartbeatOutcome = { ok: true, renewed: true, generation: 3, expiresAt: '2026-07-11T18:04:00.000Z' };
  const renewedJson = buildHeartbeatJson('2026-07-11', 'owner-a', renewed);
  assert.equal(renewedJson.classification, 'renewed');
  assert.equal(renewedJson.generation, 3);

  const lost: HeartbeatOutcome = { ok: true, renewed: false };
  assert.equal(buildHeartbeatJson('2026-07-11', 'owner-b', lost).classification, 'ownership_lost');

  const errored: HeartbeatOutcome = { ok: false, failure: { kind: 'transient_uncertain', message: 'timeout' } };
  const erroredJson = buildHeartbeatJson('2026-07-11', 'owner-a', errored);
  assert.equal(erroredJson.classification, 'error');
  assert.equal(erroredJson.ok, false);
});

test('buildReleaseJson: released, not_held, and error classifications', () => {
  const released: ReleaseOutcome = { ok: true, released: true };
  assert.equal(buildReleaseJson('2026-07-11', 'owner-a', released).classification, 'released');

  const notHeld: ReleaseOutcome = { ok: true, released: false };
  assert.equal(buildReleaseJson('2026-07-11', 'owner-b', notHeld).classification, 'not_held');

  const errored: ReleaseOutcome = { ok: false, failure: { kind: 'mechanism_unavailable', message: 'missing' } };
  assert.equal(buildReleaseJson('2026-07-11', 'owner-a', errored).classification, 'error');
});

test('CLI JSON builders never emit anything credential-shaped', () => {
  const outcomes: Array<Record<string, unknown>> = [
    buildStatusJson('2026-07-11', {
      ok: true,
      claim: statusClaim({ hostname: 'SUPABASE_SERVICE_ROLE_KEY should never appear' }),
      serverNowIso: '2026-07-11T14:00:00.000Z',
      liveness: { status: 'live', remainingSeconds: 10, expiredSeconds: null },
    }),
  ];
  for (const o of outcomes) {
    // hostname is sanitised BEFORE it ever reaches the database (sanitizeMetadataValue),
    // so by the time it flows back through status it is already safe; this asserts the
    // JSON builder itself introduces no additional leak path (e.g. does not echo raw env).
    assert.equal(JSON.stringify(o).includes(process.env.SUPABASE_SERVICE_ROLE_KEY ?? ' never '), false);
  }
});

/* --------------------------- safety source scans ----------------------------- */

// These scans detect actual IMPORTS/CALLS, not prose mentions — the docstrings
// legitimately name "Racing API", "Betfair", "lock:t-minus", etc. in plain
// English to explain what this module deliberately does NOT touch.
const FORBIDDEN_IMPORT_RE = /from\s+['"][^'"]*\/(racingApi|betfairExchange|lockTMinus|autoResults|runRaceDayPipeline\w*)['"]/;
const FORBIDDEN_CALL_RE = /\b(runModelForRace|scoreRaceRunners)\s*\(/;
const COMMIT_SUPPORT_RE = /args\.commit|commitRequested|===\s*'--commit'|case '--commit'|includes\('--commit'\)/;

test('producerClaim.ts is pure plumbing: no provider/model calls, no --commit', () => {
  const src = readFileSync('src/lib/producerClaim.ts', 'utf8');
  assert.equal(FORBIDDEN_IMPORT_RE.test(src), false);
  assert.equal(FORBIDDEN_CALL_RE.test(src), false);
  assert.equal(COMMIT_SUPPORT_RE.test(src), false);
  // The only DB surface is the RPC wrappers this file defines.
  assert.equal(/\.(insert|update|upsert|delete)\s*\(/.test(src), false);
});

test('producerClaimCheck.ts CLI never calls a provider, the model, or another producer script; no unbounded retry loop', () => {
  const src = readFileSync('scripts/producerClaimCheck.ts', 'utf8');
  assert.equal(FORBIDDEN_IMPORT_RE.test(src), false);
  assert.equal(FORBIDDEN_CALL_RE.test(src), false);
  // No commit-flag SUPPORT (parsing/branching) — the docstring may honestly
  // mention "--commit" in prose ("there is no --commit flag"); that's not support.
  assert.equal(COMMIT_SUPPORT_RE.test(src), false);
  // The op vocabulary is explicit and named, never a generic write flag.
  assert.match(src, /status.*claim.*heartbeat.*release/s);
  // A finite CLI: no while(true)/for(;;) retry loop anywhere in the file.
  assert.equal(/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/.test(src), false);
});

test('the migration adds the generation column with a positivity check', () => {
  const src = readFileSync('supabase/migrations/20260711000000_producer_run_claims.sql', 'utf8');
  assert.match(src, /generation\s+bigint\s+not\s+null\s+default\s+1/);
  assert.match(src, /generation\s*>=\s*1/); // positivity check
});

/* --------------------- TTL contract: SQL vs TypeScript agreement ------------ */

/**
 * A pure transliteration of the SQL clamp
 * `least(greatest(coalesce(p_ttl_seconds, 240), 30), 900)`, used ONLY to
 * prove the TypeScript and SQL TTL contracts agree exactly — never executed
 * against a real database.
 */
function sqlTtlFormula(pTtlSeconds: number | null): number {
  const coalesced = pTtlSeconds === null ? 240 : pTtlSeconds;
  return Math.min(Math.max(coalesced, 30), 900);
}

test('TTL contract: explicit SQL NULL and an omitted argument both resolve to the 240s default, matching coalesce(p_ttl_seconds, 240)', () => {
  assert.equal(sqlTtlFormula(null), 240);
  // What the TypeScript wrapper actually sends when ttlSeconds is omitted (params.ttlSeconds ?? DEFAULT, then clamped).
  assert.equal(clampTtlSeconds(PRODUCER_CLAIM_DEFAULT_TTL_SECONDS), 240);
});

test('TTL contract: below 30 clamps to 30, above 900 clamps to 900, in-range unchanged — the SQL formula and clampTtlSeconds agree on every case', () => {
  const cases: Array<number | null> = [null, 0, 5, 29, 30, 31, 240, 500, 899, 900, 901, 86_400, -50];
  for (const c of cases) {
    const sql = sqlTtlFormula(c);
    const ts = clampTtlSeconds(c === null ? PRODUCER_CLAIM_DEFAULT_TTL_SECONDS : c);
    assert.equal(ts, sql, `TS/SQL TTL mismatch for input ${c}`);
  }
});

test('the migration applies the coalesce-then-clamp TTL formula in BOTH try_acquire_producer_claim and heartbeat_producer_claim', () => {
  const src = readFileSync('supabase/migrations/20260711000000_producer_run_claims.sql', 'utf8');
  const occurrences =
    src.match(/least\(greatest\(coalesce\(p_ttl_seconds,\s*240\),\s*30\),\s*900\)/g) ?? [];
  assert.ok(occurrences.length >= 2, `expected the coalesce-then-clamp TTL formula in >=2 RPCs, found ${occurrences.length}`);
  // The stale pre-coalesce formula must be fully gone, not just superseded.
  assert.equal(/least\(greatest\(p_ttl_seconds,\s*30\),\s*900\)/.test(src), false);
});

/* --------------------- defensive database metadata limits ------------------- */

test('the migration adds database-level metadata size/shape constraints as defense-in-depth', () => {
  const src = readFileSync('supabase/migrations/20260711000000_producer_run_claims.sql', 'utf8');
  assert.match(src, /length\(owner_id\)\s*between\s*1\s*and\s*128/);
  assert.match(src, /hostname\s+is\s+null\s+or\s+length\(hostname\)\s*<=\s*120/);
  assert.match(src, /pid\s+is\s+null\s+or\s+pid\s*>\s*0/);
  assert.match(src, /app_version\s+is\s+null\s+or\s+length\(app_version\)\s*<=\s*120/);
  assert.match(src, /mode\s+is\s+null\s+or\s+length\(mode\)\s*<=\s*120/);
  // No SQL-side secret-content scanning was attempted — that stays a TypeScript concern.
  assert.equal(/credential|secret|bearer/i.test(src.split('NEVER STORES')[1]?.split('MUTABLE BY DESIGN')[0] ?? ''), true);
});

/* --------------------------- privilege posture (SQL source scan) ------------ */

const CLAIM_FUNCTION_SIGNATURES = [
  'try_acquire_producer_claim(date, text, text, integer, text, integer, text, text)',
  'heartbeat_producer_claim(date, text, integer)',
  'release_producer_claim(date, text)',
  'producer_claim_status(date)',
];

function escapeForRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('every SECURITY DEFINER function is created with security definer', () => {
  const src = readFileSync('supabase/migrations/20260711000000_producer_run_claims.sql', 'utf8');
  const occurrences = src.match(/security definer/g) ?? [];
  assert.equal(occurrences.length, 4, `expected exactly 4 SECURITY DEFINER functions, found ${occurrences.length}`);
});

test('every function explicitly revokes PUBLIC/anon/authenticated BEFORE granting service_role EXECUTE, and never grants to public/anon/authenticated', () => {
  const src = readFileSync('supabase/migrations/20260711000000_producer_run_claims.sql', 'utf8');
  for (const sig of CLAIM_FUNCTION_SIGNATURES) {
    const escapedSig = escapeForRegex(`public.${sig}`);
    const revokeRe = new RegExp(`revoke all on function ${escapedSig} from public, anon, authenticated;`);
    const grantRe = new RegExp(`grant execute on function ${escapedSig} to service_role;`);

    assert.match(src, revokeRe, `${sig}: missing explicit PUBLIC/anon/authenticated revoke`);
    assert.match(src, grantRe, `${sig}: missing explicit service_role grant`);

    const revokeIdx = src.search(revokeRe);
    const grantIdx = src.search(grantRe);
    assert.ok(revokeIdx >= 0 && grantIdx >= 0 && revokeIdx < grantIdx, `${sig}: revoke must precede grant so a re-run converges`);

    // No EXECUTE grant to public/anon/authenticated exists anywhere for this function.
    const badGrantRe = new RegExp(`grant execute on function ${escapedSig} to (public|anon|authenticated)`, 'i');
    assert.equal(badGrantRe.test(src), false, `${sig}: must never grant EXECUTE to public/anon/authenticated`);
  }
});

test('the read-only producer_claim_status function is ALSO service-role-only (it exposes owner_id/hostname/pid/app_version/mode)', () => {
  const src = readFileSync('supabase/migrations/20260711000000_producer_run_claims.sql', 'utf8');
  assert.match(
    src,
    /revoke all on function public\.producer_claim_status\(date\) from public, anon, authenticated;/,
  );
  assert.match(src, /grant execute on function public\.producer_claim_status\(date\) to service_role;/);
});

test('table privileges are revoked from PUBLIC/anon/authenticated, RLS is enabled, and no public/browser policy exists', () => {
  const src = readFileSync('supabase/migrations/20260711000000_producer_run_claims.sql', 'utf8');
  assert.match(src, /revoke all on table public\.producer_run_claims from public, anon, authenticated;/);
  assert.match(src, /alter table public\.producer_run_claims enable row level security;/);
  assert.equal(/create policy/i.test(src), false, 'no policy should ever be created for this service-role-only table');
});

test('the migration never exposes these functions through a client-facing grant, and revoke ordering makes CREATE OR REPLACE reruns converge', () => {
  const src = readFileSync('supabase/migrations/20260711000000_producer_run_claims.sql', 'utf8');
  // The revoke/grant privilege block sits AFTER all four `create or replace function` statements,
  // so a rerun of this migration always re-applies the intended posture regardless of prior state.
  const lastFunctionDefEnd = src.lastIndexOf('$$;');
  const firstRevokeFunctionIdx = src.indexOf('revoke all on function public.try_acquire_producer_claim');
  assert.ok(lastFunctionDefEnd >= 0 && firstRevokeFunctionIdx > lastFunctionDefEnd);
});

test('the migration bounds the contended-path retry (no unbounded SQL loop)', () => {
  const src = readFileSync('supabase/migrations/20260711000000_producer_run_claims.sql', 'utf8');
  assert.match(src, /try_acquire_producer_claim/);
  assert.match(src, /<<retry>>/);
  assert.match(src, /continue retry/);
  // The bound itself: a fixed attempt counter compared against a literal 2.
  assert.match(src, /v_attempt\s*<\s*2/);
  // Generation increments on steal, not on renewal.
  assert.match(src, /generation\s*=\s*v_existing\.generation\s*\+\s*1/);
});

test('the migration adds a read-only server-time status RPC that performs no writes', () => {
  const src = readFileSync('supabase/migrations/20260711000000_producer_run_claims.sql', 'utf8');
  assert.match(src, /create or replace function public\.producer_claim_status/);
  assert.match(src, /grant execute on function public\.producer_claim_status\(date\) to service_role/);
  // Extract just the status function body and confirm it contains no write verbs.
  const fnStart = src.indexOf('create or replace function public.producer_claim_status');
  const fnEnd = src.indexOf('$$;', fnStart);
  const fnBody = src.slice(fnStart, fnEnd);
  assert.equal(/\binsert\s+into|\bupdate\s+public\.|\bdelete\s+from/i.test(fnBody), false);
});

test('the migration rollback drops exactly the objects the forward migration creates, functions before the table', () => {
  const src = readFileSync('supabase/migrations/20260711000000_producer_run_claims.sql', 'utf8');
  assert.match(src, /ROLLBACK/);
  const dropAcquire = src.indexOf('drop function if exists public.try_acquire_producer_claim');
  const dropHeartbeat = src.indexOf('drop function if exists public.heartbeat_producer_claim');
  const dropRelease = src.indexOf('drop function if exists public.release_producer_claim');
  const dropStatus = src.indexOf('drop function if exists public.producer_claim_status');
  const dropTable = src.indexOf('drop table if exists public.producer_run_claims');
  for (const idx of [dropAcquire, dropHeartbeat, dropRelease, dropStatus, dropTable]) {
    assert.ok(idx >= 0, 'expected every rollback statement to be present');
  }
  // Functions before the table, in the documented rollback block.
  assert.ok(dropAcquire < dropTable);
  assert.ok(dropHeartbeat < dropTable);
  assert.ok(dropRelease < dropTable);
  assert.ok(dropStatus < dropTable);
  // Fail-closed posture + no immutability trigger (this table is intentionally mutable).
  assert.match(src, /FAIL-CLOSED/);
  assert.equal(/no_mutate|append-only guard/i.test(src), false);
  // Same access posture as locked_race_decisions: deny-all for PUBLIC/anon/authenticated.
  assert.match(src, /revoke all on table public\.producer_run_claims from public, anon, authenticated/);
  assert.match(src, /enable row level security/);
});

test('claim-domain boundary: lock:t-minus and results:auto remain OUTSIDE the producer claim (Step 2 policy)', () => {
  // Step 2 wired the claim into pipeline:day / pipeline:watch (see
  // producerOwnership.test.ts for those assertions). lock:t-minus (no provider
  // calls; insert-only; commit-windowed) and results:auto (unwired until the
  // nationwide settlement phase) must stay claim-free.
  for (const file of ['scripts/lockTMinus.ts', 'scripts/autoResults.ts']) {
    const src = readFileSync(file, 'utf8');
    assert.equal(
      /producer_run_claims|producerClaim|producerOwnership/i.test(src),
      false,
      `${file} must not reference the producer claim (exempt by policy)`,
    );
  }
});
