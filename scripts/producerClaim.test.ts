/**
 * Tests for the day-level producer ownership claim
 * (src/lib/producerClaim.ts + scripts/producerClaimCheck.ts) — Nationwide
 * rebuild Phase 7A.2b Step 1.
 *
 * Proves scope/date validation reuses `normalizeCourse` (no second rule),
 * the pure lease-decision model (mirrors the migration's SQL exactly: first
 * claim, same-owner idempotent renewal, expired-claim theft, live-claim
 * refusal), owner-scoped heartbeat/release, the conservative "every scope
 * conflicts with every scope" policy, FAIL-CLOSED classification (missing
 * table / malformed response / transient error are three DISTINCT outcomes,
 * never a silent proceed), metadata sanitisation, and — by source scan —
 * that nothing here ever calls a provider, runs the model, or touches
 * lock:t-minus/results:auto/pipeline:day/pipeline:watch, and that no
 * --commit flag exists anywhere. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ALL_UK_IRE_SCOPE,
  PRODUCER_CLAIM_DEFAULT_TTL_SECONDS,
  buildCourseScope,
  canHeartbeat,
  canRelease,
  classifyClaimError,
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
  type ProducerClaimReadClient,
  type ProducerClaimRpcClient,
  type ProducerLease,
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

/* --------------------------- pure lease decisions --------------------------- */

function lease(over: Partial<ProducerLease> = {}): ProducerLease {
  return {
    owner: 'owner-a',
    scope: ALL_UK_IRE_SCOPE,
    claimedAtMs: NOW - 60_000,
    heartbeatAtMs: NOW - 30_000,
    expiresAtMs: NOW + 60_000, // still live
    ...over,
  };
}

test('decideClaim: no existing lease -> fresh acquire', () => {
  const d = decideClaim(null, 'owner-a', ALL_UK_IRE_SCOPE, NOW, TTL_MS);
  assert.equal(d.acquired, true);
  assert.equal(d.stoleExpired, false);
  assert.deepEqual(d.lease, {
    owner: 'owner-a',
    scope: ALL_UK_IRE_SCOPE,
    claimedAtMs: NOW,
    heartbeatAtMs: NOW,
    expiresAtMs: NOW + TTL_MS,
  });
});

test('decideClaim: SAME owner re-claiming while live -> idempotent renewal (not a fresh claim)', () => {
  const existing = lease({ claimedAtMs: NOW - 120_000 });
  const d = decideClaim(existing, 'owner-a', 'course:newmarket', NOW, TTL_MS);
  assert.equal(d.acquired, true);
  assert.equal(d.stoleExpired, false);
  assert.equal(d.lease.claimedAtMs, existing.claimedAtMs); // claimed_at NOT reset — this is a renewal
  assert.equal(d.lease.heartbeatAtMs, NOW);
  assert.equal(d.lease.expiresAtMs, NOW + TTL_MS);
  assert.equal(d.lease.scope, 'course:newmarket'); // scope can be updated on renewal
});

test('decideClaim: DIFFERENT owner, live lease -> refused, current lease reported unchanged', () => {
  const existing = lease({ owner: 'owner-a' });
  const d = decideClaim(existing, 'owner-b', 'course:newmarket', NOW, TTL_MS);
  assert.equal(d.acquired, false);
  assert.equal(d.stoleExpired, false);
  assert.deepEqual(d.lease, existing);
});

test('decideClaim: DIFFERENT owner, EXPIRED lease -> stolen atomically', () => {
  const existing = lease({ owner: 'owner-a', expiresAtMs: NOW - 1 });
  const d = decideClaim(existing, 'owner-b', ALL_UK_IRE_SCOPE, NOW, TTL_MS);
  assert.equal(d.acquired, true);
  assert.equal(d.stoleExpired, true);
  assert.equal(d.lease.owner, 'owner-b');
  assert.equal(d.lease.claimedAtMs, NOW); // a fresh claim, not a renewal
});

test('decideClaim: expiry is inclusive (expires_at === now counts as expired) — server-time boundary', () => {
  const existing = lease({ owner: 'owner-a', expiresAtMs: NOW }); // exactly at boundary
  const d = decideClaim(existing, 'owner-b', ALL_UK_IRE_SCOPE, NOW, TTL_MS);
  assert.equal(d.acquired, true);
  assert.equal(d.stoleExpired, true);
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

test('tryAcquireProducerClaim: transient error classified distinctly from missing/malformed', async () => {
  const client = fakeRpcClient(() => ({ data: null, error: { message: 'connection reset' } }));
  const result = await tryAcquireProducerClaim(
    { raceDate: '2026-07-11', scope: ALL_UK_IRE_SCOPE, ownerId: 'owner-a' },
    client,
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, 'transient_uncertain');
});

test('tryAcquireProducerClaim: a well-formed response is parsed through cleanly', async () => {
  const client = fakeRpcClient(() => ({
    data: {
      acquired: true,
      stole_expired: false,
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

test('heartbeatProducerClaim: owner renewal succeeds cleanly', async () => {
  const client = fakeRpcClient(() => ({
    data: { renewed: true, expires_at: '2026-07-11T18:04:00.000Z' },
    error: null,
  }));
  const result = await heartbeatProducerClaim({ raceDate: '2026-07-11', ownerId: 'owner-a' }, client);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.renewed, true);
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

/* --------------------------- status read (SELECT-only) ---------------------- */

function fakeReadClient(
  impl: () => { data: unknown; error: { code?: string; message: string } | null },
): ProducerClaimReadClient {
  return { selectClaim: async () => impl() };
}

test('fetchProducerClaimStatus: unclaimed date returns claim:null, never an error', async () => {
  const client = fakeReadClient(() => ({ data: null, error: null }));
  const result = await fetchProducerClaimStatus('2026-07-11', client);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.claim, null);
});

test('fetchProducerClaimStatus: a claimed date is parsed through cleanly', async () => {
  const client = fakeReadClient(() => ({
    data: {
      race_date: '2026-07-11',
      scope: ALL_UK_IRE_SCOPE,
      owner_id: 'owner-a',
      claimed_at: '2026-07-11T14:00:00.000Z',
      heartbeat_at: '2026-07-11T14:02:00.000Z',
      expires_at: '2026-07-11T14:04:00.000Z',
      hostname: 'my-laptop',
      pid: 1234,
      app_version: 'abc1234',
      mode: 'model_only',
    },
    error: null,
  }));
  const result = await fetchProducerClaimStatus('2026-07-11', client);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.claim);
  assert.equal(result.ok && result.claim?.ownerId, 'owner-a');
});

test('fetchProducerClaimStatus: malformed row -> FAIL CLOSED', async () => {
  const client = fakeReadClient(() => ({ data: { race_date: '2026-07-11' }, error: null })); // missing fields
  const result = await fetchProducerClaimStatus('2026-07-11', client);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, 'mechanism_unavailable');
});

test('fetchProducerClaimStatus: missing table -> FAIL CLOSED', async () => {
  const client = fakeReadClient(() => ({ data: null, error: { code: 'PGRST205', message: 'missing' } }));
  const result = await fetchProducerClaimStatus('2026-07-11', client);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, 'mechanism_unavailable');
});

test('fetchProducerClaimStatus: invalid date rejected without a query', async () => {
  let called = false;
  const client = fakeReadClient(() => {
    called = true;
    return { data: null, error: null };
  });
  const result = await fetchProducerClaimStatus('not-a-date', client);
  assert.equal(result.ok, false);
  assert.equal(called, false);
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
  // The only DB surface is the RPC/select wrappers this file defines.
  assert.equal(/\.(insert|update|upsert|delete)\s*\(/.test(src), false);
});

test('producerClaimCheck.ts CLI never calls a provider, the model, or another producer script', () => {
  const src = readFileSync('scripts/producerClaimCheck.ts', 'utf8');
  assert.equal(FORBIDDEN_IMPORT_RE.test(src), false);
  assert.equal(FORBIDDEN_CALL_RE.test(src), false);
  // No commit-flag SUPPORT (parsing/branching) — the docstring may honestly
  // mention "--commit" in prose ("there is no --commit flag"); that's not support.
  assert.equal(COMMIT_SUPPORT_RE.test(src), false);
  // The op vocabulary is explicit and named, never a generic write flag.
  assert.match(src, /status.*claim.*heartbeat.*release/s);
});

test('the migration rollback drops exactly the objects the forward migration creates', () => {
  const src = readFileSync('supabase/migrations/20260711000000_producer_run_claims.sql', 'utf8');
  assert.match(src, /ROLLBACK/);
  assert.match(src, /drop function if exists public\.try_acquire_producer_claim/);
  assert.match(src, /drop function if exists public\.heartbeat_producer_claim/);
  assert.match(src, /drop function if exists public\.release_producer_claim/);
  assert.match(src, /drop table if exists public\.producer_run_claims/);
  // Fail-closed posture + no immutability trigger (this table is intentionally mutable).
  assert.match(src, /FAIL-CLOSED/);
  assert.equal(/no_mutate|append-only guard/i.test(src), false);
  // Same access posture as locked_race_decisions: deny-all for anon/authenticated.
  assert.match(src, /revoke all on table public\.producer_run_claims from anon, authenticated/);
  assert.match(src, /enable row level security/);
});

test('the migration is NOT wired into any producer script yet (schema-only this phase)', () => {
  for (const file of [
    'scripts/runRaceDayPipeline.ts',
    'scripts/runRaceDayPipelineWatch.ts',
    'scripts/lockTMinus.ts',
    'scripts/autoResults.ts',
  ]) {
    const src = readFileSync(file, 'utf8');
    assert.equal(/producer_run_claims|producerClaim/i.test(src), false, `${file} should not reference the new claim yet`);
  }
});
