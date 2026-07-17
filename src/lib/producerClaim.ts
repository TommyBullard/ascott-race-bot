/**
 * Day-level, FAIL-CLOSED producer ownership claim — Nationwide rebuild
 * Phase 7A.2b Step 1 (hardened per the independent Producer Ownership Safety
 * Review).
 *
 * Gives a future producer (pipeline:day / pipeline:watch / a nationwide
 * supervisor) a way to PROVE exclusive ownership of one race date's entire
 * provider/model domain before making any Racing API / Betfair call or model
 * run. This is deliberately a SEPARATE mechanism from the per-race
 * `model_run_locks` ({@link ../lib/modelRunLock}), which is FAIL-OPEN by
 * design (a bounded, single-race risk). A day-level producer collision is
 * unbounded — duplicate nationwide provider calls across every race, duplicate
 * 5-minute cycles — so every function here refuses to proceed rather than
 * degrading to unprotected operation when ownership cannot be established.
 *
 * OWNERSHIP DOMAIN: one row PER RACE DATE (see the migration
 * 20260711000000_producer_run_claims.sql). The requested scope
 * (`'all-uk-ire'` or `'course:<normalizeCourse output>'`) is stored as
 * metadata on that row; the PRIMARY KEY (race_date alone) is what actually
 * enforces the conservative rule that EVERY scope conflicts with every other
 * scope for one date (every producer invocation still calls the nationwide
 * racecard/odds routes regardless of its visible model scope).
 *
 * `normalizeCourse` ({@link ../lib/raceSync}) is reused verbatim for course
 * scopes — no second course-normalisation rule is invented here.
 *
 * GENERATION (fencing token): every lease carries a `generation` that
 * increments ONLY when a different owner steals an expired claim — never on
 * same-owner renewal or heartbeat. This lets a future caller detect "someone
 * else took over while I was stalled" even in cases owner_id alone cannot
 * distinguish (e.g. an operator accidentally reusing an owner id — see the
 * PC/laptop runbook in the Producer Ownership Safety Review). ENFORCEMENT
 * (a writer verifying its generation before a persistence-sensitive stage) is
 * DEFERRED to the future supervisor-wiring phase; this module only tracks,
 * validates, and returns the token.
 *
 * PURE LEASE MODEL: {@link decideClaim}/{@link canHeartbeat}/{@link canRelease}
 * mirror the migration's SQL exactly (mirrors the `modelRunLock.ts` pattern),
 * so the rules are unit-testable without a database.
 *
 * NOT WIRED YET: nothing in the producer calls these functions. This module
 * is schema-adjacent plumbing + a diagnostic CLI foundation only. No model
 * maths, staking, confidence, recommendation, lock, or settlement behaviour
 * changes. Decision-support only — this records producer ownership, never a
 * bet or an order.
 *
 * COOPERATIVE ONLY: this claim protects nothing by itself — it only records
 * who SAYS they own a date. Enforcement requires every producer entry point
 * to actually call it and refuse to proceed when refused/uncertain, which is
 * NOT yet the case for any of them. Known entry points that make provider
 * calls today and do NOT (yet) consult this claim: the Railway cron jobs
 * (`/api/cron/racecards`, `/api/cron/odds`, `/api/cron/model`,
 * `/api/cron/results`, `/api/cron/tipster-discovery` — see
 * docs/RAILWAY_RACE_DAY_AUTOMATION.md), any manual `CRON_SECRET`-authenticated
 * call to those routes, `npm run run:model` / `model:day`, `pipeline:day` /
 * `pipeline:watch` (until a future wiring phase), and `results:auto`. Future
 * wiring phase: `lock:t-minus` is expected to stay OUTSIDE this claim (no
 * provider calls; insert-only; unique-constrained; commit-windowed — a
 * duplicate run is harmless, while a claim-induced miss of an official lock
 * would be worse); `results:auto` is expected to stay unwired until the
 * nationwide settlement phase; read-only audits/reports/timing commands are
 * exempt unconditionally (they make no provider calls and hold no lease).
 */

import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from './supabaseAdmin';
import { normalizeCourse } from './raceSync';
import { classifyTableProbe, type PostgrestErrorLike } from './dbHealthSpec';

/** Default lease TTL: 4 minutes against a 5-minute (300s) operating cadence. */
export const PRODUCER_CLAIM_DEFAULT_TTL_SECONDS = 240;

/** Server-side TTL clamp bounds (mirrors `least(greatest(p_ttl_seconds, 30), 900)` in SQL). */
export const PRODUCER_CLAIM_MIN_TTL_SECONDS = 30;
export const PRODUCER_CLAIM_MAX_TTL_SECONDS = 900;

/** The nationwide (all UK & Ireland) ownership scope. */
export const ALL_UK_IRE_SCOPE = 'all-uk-ire';

const COURSE_SCOPE_PREFIX = 'course:';
/** Matches `normalizeCourse`'s output charset exactly: lowercase alnum + single spaces. */
const COURSE_SCOPE_RE = /^course:[a-z0-9]+( [a-z0-9]+)*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* -------------------------------------------------------------------------- */
/* Scope / date validation (pure) — reuses normalizeCourse, no second rule    */
/* -------------------------------------------------------------------------- */

/** Builds a course scope string from a raw course name via `normalizeCourse`. Pure. */
export function buildCourseScope(courseName: string): string {
  return `${COURSE_SCOPE_PREFIX}${normalizeCourse(courseName)}`;
}

/** True for `'all-uk-ire'` or a well-formed `'course:<normalised>'` scope. Pure. */
export function isValidScope(scope: string): boolean {
  return scope === ALL_UK_IRE_SCOPE || COURSE_SCOPE_RE.test(scope);
}

/**
 * Normalises OPERATOR-TYPED scope input (e.g. a CLI `--scope` value) into the
 * canonical stored form: `'all-uk-ire'` passes through verbatim; a
 * `'course:<raw name>'` prefix is re-normalised through {@link buildCourseScope}
 * (so `course:Newmarket` / `course:Royal Ascot` become `course:newmarket` /
 * `course:ascot`, matching the same `normalizeCourse` rule used everywhere
 * else). Anything else is returned unchanged so {@link isValidScope} can
 * reject it explicitly — this function never silently invents a valid scope
 * from garbage input. Pure.
 */
export function normalizeScopeInput(raw: string): string {
  if (raw === ALL_UK_IRE_SCOPE) return raw;
  if (raw.startsWith(COURSE_SCOPE_PREFIX)) {
    return buildCourseScope(raw.slice(COURSE_SCOPE_PREFIX.length));
  }
  return raw;
}

/**
 * Strict `YYYY-MM-DD` calendar-date validation (round-trips, so it rejects
 * `2026-13-01` / `2026-02-30` / wrong formats). Pure.
 */
export function isValidRaceDate(date: string | null | undefined): boolean {
  if (!date || !ISO_DATE_RE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/**
 * Clamps a TTL (seconds) to [30, 900], mirroring the SQL clamp
 * `least(greatest(p_ttl_seconds, 30), 900)` client-side. Non-finite input
 * (NaN, +/-Infinity) falls back to the default TTL rather than propagating a
 * broken value — the SQL layer is the authoritative enforcement point; this
 * is defense-in-depth so a bad value never even leaves the client looking
 * unclamped. Pure.
 */
export function clampTtlSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return PRODUCER_CLAIM_DEFAULT_TTL_SECONDS;
  return Math.min(Math.max(seconds, PRODUCER_CLAIM_MIN_TTL_SECONDS), PRODUCER_CLAIM_MAX_TTL_SECONDS);
}

/* -------------------------------------------------------------------------- */
/* Pure lease semantics (mirror the SQL exactly; unit-testable)               */
/* -------------------------------------------------------------------------- */

/** A producer claim, in epoch-ms (the pure model of `producer_run_claims`). */
export interface ProducerLease {
  owner: string;
  scope: string;
  generation: number;
  claimedAtMs: number;
  heartbeatAtMs: number;
  expiresAtMs: number;
}

/** The pure decision of one acquisition attempt. */
export interface ProducerClaimDecision {
  acquired: boolean;
  stoleExpired: boolean;
  /** The resulting lease (the new/renewed one when acquired, else the unchanged existing). */
  lease: ProducerLease;
}

const MIN_TTL_MS = PRODUCER_CLAIM_MIN_TTL_SECONDS * 1000;
const MAX_TTL_MS = PRODUCER_CLAIM_MAX_TTL_SECONDS * 1000;

/** Clamps a TTL in milliseconds to [30s, 900s], mirroring the SQL clamp. Pure. */
function clampTtlMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return PRODUCER_CLAIM_DEFAULT_TTL_SECONDS * 1000;
  return Math.min(Math.max(ttlMs, MIN_TTL_MS), MAX_TTL_MS);
}

/**
 * Pure model of `try_acquire_producer_claim`: claim when there is no lease;
 * IDEMPOTENTLY RENEW when the SAME owner already holds it (identical to a
 * heartbeat — generation UNCHANGED); steal an EXPIRED lease held by a
 * different owner (generation + 1 — this IS a takeover); refuse a LIVE lease
 * held by a different owner. TTL is clamped to [30s, 900s], mirroring the
 * migration's SQL exactly. Deterministic.
 */
export function decideClaim(
  existing: ProducerLease | null,
  owner: string,
  scope: string,
  nowMs: number,
  ttlMs: number,
): ProducerClaimDecision {
  const ttl = clampTtlMs(ttlMs);
  if (existing === null) {
    return {
      acquired: true,
      stoleExpired: false,
      lease: { owner, scope, generation: 1, claimedAtMs: nowMs, heartbeatAtMs: nowMs, expiresAtMs: nowMs + ttl },
    };
  }
  if (existing.owner === owner) {
    // Same owner re-claiming: idempotent renewal, identical to a heartbeat.
    // Generation is UNCHANGED — this is not a takeover.
    return {
      acquired: true,
      stoleExpired: false,
      lease: { ...existing, scope, heartbeatAtMs: nowMs, expiresAtMs: nowMs + ttl },
    };
  }
  if (existing.expiresAtMs <= nowMs) {
    // A different owner's claim has EXPIRED: steal it. Generation increments.
    return {
      acquired: true,
      stoleExpired: true,
      lease: {
        owner,
        scope,
        generation: existing.generation + 1,
        claimedAtMs: nowMs,
        heartbeatAtMs: nowMs,
        expiresAtMs: nowMs + ttl,
      },
    };
  }
  return { acquired: false, stoleExpired: false, lease: existing }; // live lease held elsewhere
}

/** Pure model of `heartbeat_producer_claim`'s owner check. */
export function canHeartbeat(existing: ProducerLease | null, owner: string): boolean {
  return existing !== null && existing.owner === owner;
}

/** Pure model of `release_producer_claim`'s owner check. */
export function canRelease(existing: ProducerLease | null, owner: string): boolean {
  return existing !== null && existing.owner === owner;
}

/* -------------------------------------------------------------------------- */
/* Fail-closed error classification                                          */
/* -------------------------------------------------------------------------- */

/**
 * The three fail-closed cases, each requiring a DIFFERENT safest response
 * (never a silent "proceed"):
 *   - `mechanism_unavailable` : table/RPC missing, permission denied (grants/
 *     RLS misconfigured — retrying cannot fix this), or a response with an
 *     unrecognisable shape — the claim mechanism itself cannot be trusted.
 *   - `transient_uncertain`   : an error that is neither "missing" nor a
 *     clean, parseable response — genuinely ambiguous; retry once, then
 *     escalate to `mechanism_unavailable`. Also covers the bounded
 *     "identity indeterminate" anomaly from the contended-path retry (see
 *     {@link parseAcquireResponse}) — a legitimate race, safe to retry.
 *   - `invalid_input`         : the caller passed a bad date/scope/owner —
 *     never sent to the database at all.
 */
export type ClaimFailureKind = 'mechanism_unavailable' | 'transient_uncertain' | 'invalid_input';

export interface ClaimFailure {
  kind: ClaimFailureKind;
  message: string;
}

const PERMISSION_DENIED_CODES = new Set(['42501']);

/**
 * Classifies a non-null RPC/query error into a fail-closed kind. Permission
 * denial (SQLSTATE 42501, or a "permission denied" message when no code is
 * available) is classified `mechanism_unavailable`, NOT `transient_uncertain`
 * — misconfigured grants/RLS will not resolve themselves on retry, so the
 * caller must stop and alert an operator rather than loop. Pure.
 */
export function classifyClaimError(error: PostgrestErrorLike): ClaimFailure {
  if (error.code && PERMISSION_DENIED_CODES.has(error.code)) {
    return { kind: 'mechanism_unavailable', message: error.message ?? 'permission denied' };
  }
  const lowerMsg = (error.message ?? '').toLowerCase();
  if (lowerMsg.includes('permission denied')) {
    return { kind: 'mechanism_unavailable', message: error.message ?? 'permission denied' };
  }
  const probe = classifyTableProbe(error);
  if (probe === 'missing') {
    return { kind: 'mechanism_unavailable', message: error.message ?? 'table/RPC not found' };
  }
  return { kind: 'transient_uncertain', message: error.message ?? 'unrecognised database error' };
}

/* -------------------------------------------------------------------------- */
/* Safe metadata sanitisation (defense-in-depth — never store secrets)        */
/* -------------------------------------------------------------------------- */

const MAX_METADATA_LEN = 120;
const CREDENTIAL_LIKE_RE = /key|secret|token|password|credential|bearer|authorization/i;

/**
 * Sanitises an optional metadata scalar (hostname / app version / mode)
 * before it is ever sent to the database: trims, redacts anything that LOOKS
 * credential-shaped (defense-in-depth against an accidental secret ending up
 * in an env-derived value), and truncates to a bounded length. Never throws.
 * Pure.
 */
export function sanitizeMetadataValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (CREDENTIAL_LIKE_RE.test(trimmed)) return '[redacted]';
  return trimmed.length > MAX_METADATA_LEN ? trimmed.slice(0, MAX_METADATA_LEN) : trimmed;
}

/** Generates a fresh, opaque owner id for one process invocation. */
export function newOwnerId(): string {
  return randomUUID();
}

/* -------------------------------------------------------------------------- */
/* RPC wrappers (injectable client for tests) — FAIL-CLOSED, never `| null`   */
/* -------------------------------------------------------------------------- */

/** The minimal Supabase RPC surface these wrappers need (injectable in tests). */
export interface ProducerClaimRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: PostgrestErrorLike | null }>;
}

const defaultRpcClient = supabaseAdmin as unknown as ProducerClaimRpcClient;

/** A read-only projection of the current claim row for a date. */
export interface ProducerClaimStatus {
  raceDate: string;
  scope: string;
  ownerId: string;
  generation: number;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  hostname: string | null;
  pid: number | null;
  appVersion: string | null;
  mode: string | null;
}

export type AcquireOutcome =
  | {
      ok: true;
      acquired: boolean;
      stoleExpired: boolean;
      generation: number;
      currentOwnerId: string;
      currentScope: string;
      currentExpiresAt: string;
    }
  | { ok: false; failure: ClaimFailure };

export type HeartbeatOutcome =
  | { ok: true; renewed: true; generation: number; expiresAt: string }
  | { ok: true; renewed: false } // CONFIRMED ownership loss — a clean, error-free response
  | { ok: false; failure: ClaimFailure };

export type ReleaseOutcome =
  | { ok: true; released: boolean }
  | { ok: false; failure: ClaimFailure };

/** Pure classification of a claim's liveness against a known server time. */
export type ClaimLivenessStatus = 'live' | 'expired' | 'absent' | 'unknown';

export interface ClaimLivenessResult {
  status: ClaimLivenessStatus;
  /** Seconds remaining until expiry; set only when `status === 'live'`. */
  remainingSeconds: number | null;
  /** Seconds since expiry; set only when `status === 'expired'`. */
  expiredSeconds: number | null;
}

export type StatusOutcome =
  | {
      ok: true;
      claim: ProducerClaimStatus | null;
      /** The database's own `now()` at read time, as an ISO string. */
      serverNowIso: string;
      liveness: ClaimLivenessResult;
    }
  | { ok: false; failure: ClaimFailure };

/**
 * Classifies a claim's liveness using a known SERVER time — never the
 * caller's local clock (a sleeping/skewed laptop must not decide this).
 * Never returns a negative duration: `remainingSeconds`/`expiredSeconds` are
 * derived from the branch condition that guarantees their sign. Pure.
 */
export function classifyClaimLiveness(
  claim: ProducerClaimStatus | null,
  serverNowMs: number,
): ClaimLivenessResult {
  if (!Number.isFinite(serverNowMs)) {
    return { status: 'unknown', remainingSeconds: null, expiredSeconds: null };
  }
  if (claim === null) {
    return { status: 'absent', remainingSeconds: null, expiredSeconds: null };
  }
  const expiresAtMs = Date.parse(claim.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return { status: 'unknown', remainingSeconds: null, expiredSeconds: null };
  }
  if (expiresAtMs > serverNowMs) {
    return { status: 'live', remainingSeconds: Math.floor((expiresAtMs - serverNowMs) / 1000), expiredSeconds: null };
  }
  return { status: 'expired', remainingSeconds: null, expiredSeconds: Math.floor((serverNowMs - expiresAtMs) / 1000) };
}

/**
 * The parsed acquire-response kinds, internal to this module. `identityUnknown`
 * is the bounded contended-path-retry anomaly (see the migration): a
 * legitimate, distinguishable race — never conflated with a normal refusal
 * (which always carries a real owner id) or a malformed response.
 */
type ParsedAcquire =
  | { kind: 'ok'; outcome: Extract<AcquireOutcome, { ok: true }> }
  | { kind: 'identity_unknown' }
  | { kind: 'malformed' };

/** Narrow-and-validate the acquire RPC's jsonb response. Pure. */
function parseAcquireResponse(data: unknown): ParsedAcquire {
  if (typeof data !== 'object' || data === null) return { kind: 'malformed' };
  const d = data as Record<string, unknown>;
  if (typeof d.acquired !== 'boolean' || typeof d.stole_expired !== 'boolean') {
    return { kind: 'malformed' };
  }

  // The bounded contended-path-retry anomaly: acquired=false with every
  // current_* field explicitly null (never partially null — that would be
  // a malformed shape, not this specific anomaly).
  if (
    d.acquired === false &&
    d.current_owner_id === null &&
    d.current_scope === null &&
    d.current_expires_at === null &&
    (d.generation === null || d.generation === undefined)
  ) {
    return { kind: 'identity_unknown' };
  }

  if (
    typeof d.generation !== 'number' ||
    !Number.isFinite(d.generation) ||
    d.generation < 1 ||
    typeof d.current_owner_id !== 'string' ||
    typeof d.current_scope !== 'string' ||
    typeof d.current_expires_at !== 'string'
  ) {
    return { kind: 'malformed' };
  }

  return {
    kind: 'ok',
    outcome: {
      ok: true,
      acquired: d.acquired,
      stoleExpired: d.stole_expired,
      generation: d.generation,
      currentOwnerId: d.current_owner_id,
      currentScope: d.current_scope,
      currentExpiresAt: d.current_expires_at,
    },
  };
}

/** Narrow-and-validate the heartbeat RPC's jsonb response. Pure. */
function parseHeartbeatResponse(data: unknown): HeartbeatOutcome | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.renewed !== 'boolean') return null;
  if (d.renewed) {
    if (typeof d.expires_at !== 'string' || typeof d.generation !== 'number' || !Number.isFinite(d.generation) || d.generation < 1) {
      return null;
    }
    return { ok: true, renewed: true, generation: d.generation, expiresAt: d.expires_at };
  }
  return { ok: true, renewed: false };
}

/** Narrow-and-validate the `producer_claim_status` RPC's jsonb response. Pure. */
function parseStatusResponse(data: unknown): { serverNowIso: string; claim: ProducerClaimStatus | null } | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.server_now !== 'string') return null;
  if (d.claim === null || d.claim === undefined) {
    return { serverNowIso: d.server_now, claim: null };
  }
  if (typeof d.claim !== 'object') return null;
  const c = d.claim as Record<string, unknown>;
  if (
    typeof c.race_date !== 'string' ||
    typeof c.scope !== 'string' ||
    typeof c.owner_id !== 'string' ||
    typeof c.generation !== 'number' ||
    !Number.isFinite(c.generation) ||
    typeof c.claimed_at !== 'string' ||
    typeof c.heartbeat_at !== 'string' ||
    typeof c.expires_at !== 'string'
  ) {
    return null;
  }
  return {
    serverNowIso: d.server_now,
    claim: {
      raceDate: c.race_date,
      scope: c.scope,
      ownerId: c.owner_id,
      generation: c.generation,
      claimedAt: c.claimed_at,
      heartbeatAt: c.heartbeat_at,
      expiresAt: c.expires_at,
      hostname: typeof c.hostname === 'string' ? c.hostname : null,
      pid: typeof c.pid === 'number' ? c.pid : null,
      appVersion: typeof c.app_version === 'string' ? c.app_version : null,
      mode: typeof c.mode === 'string' ? c.mode : null,
    },
  };
}

/**
 * Attempts to acquire (or idempotently renew) the date-level producer claim.
 * FAIL-CLOSED: on any error, missing table/RPC, permission denial, malformed
 * response, or an unresolved contended-path anomaly, returns
 * `{ ok: false, failure }` — NEVER `null`-meaning-proceed. The caller must
 * treat anything other than `{ ok: true, acquired: true }` as "do not start
 * any provider/model/persistence stage." The TTL is clamped client-side
 * (defense-in-depth) as well as server-side (authoritative).
 */
export async function tryAcquireProducerClaim(
  params: {
    raceDate: string;
    scope: string;
    ownerId: string;
    ttlSeconds?: number;
    hostname?: string | null;
    pid?: number | null;
    appVersion?: string | null;
    mode?: string | null;
  },
  client: ProducerClaimRpcClient = defaultRpcClient,
): Promise<AcquireOutcome> {
  if (!isValidRaceDate(params.raceDate)) {
    return { ok: false, failure: { kind: 'invalid_input', message: `invalid race date: ${params.raceDate}` } };
  }
  if (!isValidScope(params.scope)) {
    return { ok: false, failure: { kind: 'invalid_input', message: `invalid scope: ${params.scope}` } };
  }
  if (!params.ownerId || params.ownerId.trim() === '') {
    return { ok: false, failure: { kind: 'invalid_input', message: 'owner id is required' } };
  }
  try {
    const { data, error } = await client.rpc('try_acquire_producer_claim', {
      p_race_date: params.raceDate,
      p_scope: params.scope,
      p_owner_id: params.ownerId,
      p_ttl_seconds: clampTtlSeconds(params.ttlSeconds ?? PRODUCER_CLAIM_DEFAULT_TTL_SECONDS),
      p_hostname: sanitizeMetadataValue(params.hostname),
      p_pid: typeof params.pid === 'number' && Number.isFinite(params.pid) ? params.pid : null,
      p_app_version: sanitizeMetadataValue(params.appVersion),
      p_mode: sanitizeMetadataValue(params.mode),
    });
    if (error) return { ok: false, failure: classifyClaimError(error) };
    const parsed = parseAcquireResponse(data);
    if (parsed.kind === 'malformed') {
      return { ok: false, failure: { kind: 'mechanism_unavailable', message: 'malformed acquire response shape' } };
    }
    if (parsed.kind === 'identity_unknown') {
      return {
        ok: false,
        failure: {
          kind: 'transient_uncertain',
          message:
            'claim row identity could not be established after a bounded contended-path retry ' +
            '(a concurrent release/insert race) — safe to retry the whole call',
        },
      };
    }
    return parsed.outcome;
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'transient_uncertain', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Owner-scoped heartbeat renewal. FAIL-CLOSED on RPC/table trouble. A CLEAN
 * `{ ok: true, renewed: false }` is a CONFIRMED ownership-loss signal, distinct
 * from `{ ok: false }` (mechanism unavailable / transient — uncertainty, not
 * confirmed loss). The caller must not conflate the two.
 */
export async function heartbeatProducerClaim(
  params: { raceDate: string; ownerId: string; ttlSeconds?: number },
  client: ProducerClaimRpcClient = defaultRpcClient,
): Promise<HeartbeatOutcome> {
  if (!isValidRaceDate(params.raceDate)) {
    return { ok: false, failure: { kind: 'invalid_input', message: `invalid race date: ${params.raceDate}` } };
  }
  if (!params.ownerId || params.ownerId.trim() === '') {
    return { ok: false, failure: { kind: 'invalid_input', message: 'owner id is required' } };
  }
  try {
    const { data, error } = await client.rpc('heartbeat_producer_claim', {
      p_race_date: params.raceDate,
      p_owner_id: params.ownerId,
      p_ttl_seconds: clampTtlSeconds(params.ttlSeconds ?? PRODUCER_CLAIM_DEFAULT_TTL_SECONDS),
    });
    if (error) return { ok: false, failure: classifyClaimError(error) };
    const parsed = parseHeartbeatResponse(data);
    if (!parsed) {
      return { ok: false, failure: { kind: 'mechanism_unavailable', message: 'malformed heartbeat response shape' } };
    }
    return parsed;
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'transient_uncertain', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Owner-scoped release (graceful shutdown only). FAIL-CLOSED on RPC/table
 * trouble; `{ ok: true, released: false }` just means we did not hold it
 * (harmless — never treated as an error).
 */
export async function releaseProducerClaim(
  params: { raceDate: string; ownerId: string },
  client: ProducerClaimRpcClient = defaultRpcClient,
): Promise<ReleaseOutcome> {
  if (!isValidRaceDate(params.raceDate)) {
    return { ok: false, failure: { kind: 'invalid_input', message: `invalid race date: ${params.raceDate}` } };
  }
  if (!params.ownerId || params.ownerId.trim() === '') {
    return { ok: false, failure: { kind: 'invalid_input', message: 'owner id is required' } };
  }
  try {
    const { data, error } = await client.rpc('release_producer_claim', {
      p_race_date: params.raceDate,
      p_owner_id: params.ownerId,
    });
    if (error) return { ok: false, failure: classifyClaimError(error) };
    if (typeof data !== 'boolean') {
      return { ok: false, failure: { kind: 'mechanism_unavailable', message: 'malformed release response shape' } };
    }
    return { ok: true, released: data };
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'transient_uncertain', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Read-only status probe: the current claim for a date (or null when
 * unclaimed) TOGETHER WITH a liveness classification computed from the
 * DATABASE's own `now()` — never the caller's local clock. SELECT-only; never
 * mutates. If server time cannot be established from a well-formed response,
 * this still returns `ok: true` with `liveness.status === 'unknown'` (a
 * genuinely malformed/unparseable response instead fails closed via
 * `ok: false`) — any caller using this for an ownership DECISION must treat
 * `'unknown'` the same as `ok: false` (never assume live or absent).
 */
export async function fetchProducerClaimStatus(
  raceDate: string,
  client: ProducerClaimRpcClient = defaultRpcClient,
): Promise<StatusOutcome> {
  if (!isValidRaceDate(raceDate)) {
    return { ok: false, failure: { kind: 'invalid_input', message: `invalid race date: ${raceDate}` } };
  }
  try {
    const { data, error } = await client.rpc('producer_claim_status', { p_race_date: raceDate });
    if (error) return { ok: false, failure: classifyClaimError(error) };
    const parsed = parseStatusResponse(data);
    if (!parsed) {
      return { ok: false, failure: { kind: 'mechanism_unavailable', message: 'malformed status response shape' } };
    }
    const serverNowMs = Date.parse(parsed.serverNowIso);
    return {
      ok: true,
      claim: parsed.claim,
      serverNowIso: parsed.serverNowIso,
      liveness: classifyClaimLiveness(parsed.claim, serverNowMs),
    };
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'transient_uncertain', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* CLI JSON builders (pure) — used by scripts/producerClaimCheck.ts --json    */
/* -------------------------------------------------------------------------- */

/**
 * These builders turn an already-computed outcome into a plain,
 * deterministic, secret-free JSON-serialisable object. They are pure so they
 * are directly unit-testable without spinning up the CLI or a fake DB client.
 * Every field is either an ISO timestamp, a small enum string, a number, a
 * caller-supplied date/scope/owner string, or an error kind+message that
 * already never carries secrets (see {@link classifyClaimError} /
 * {@link sanitizeMetadataValue}).
 */

function errorField(failure: ClaimFailure): { kind: ClaimFailureKind; message: string } {
  return { kind: failure.kind, message: failure.message };
}

export function buildStatusJson(raceDate: string, outcome: StatusOutcome): Record<string, unknown> {
  if (!outcome.ok) {
    return {
      operation: 'status',
      race_date: raceDate,
      ok: false,
      status: 'unavailable',
      server_now: null,
      owner_id: null,
      scope: null,
      generation: null,
      claimed_at: null,
      heartbeat_at: null,
      expires_at: null,
      remaining_seconds: null,
      expired_seconds: null,
      error: errorField(outcome.failure),
    };
  }
  const c = outcome.claim;
  return {
    operation: 'status',
    race_date: raceDate,
    ok: true,
    status: outcome.liveness.status,
    server_now: outcome.serverNowIso,
    owner_id: c?.ownerId ?? null,
    scope: c?.scope ?? null,
    generation: c?.generation ?? null,
    claimed_at: c?.claimedAt ?? null,
    heartbeat_at: c?.heartbeatAt ?? null,
    expires_at: c?.expiresAt ?? null,
    remaining_seconds: outcome.liveness.remainingSeconds,
    expired_seconds: outcome.liveness.expiredSeconds,
    error: null,
  };
}

/** Classification for a `claim` op response: derived, never fabricated beyond the RPC's own signal. */
export type ClaimOpClassification = 'acquired' | 'stole_expired' | 'refused' | 'error';

export function buildClaimJson(
  raceDate: string,
  requestedScope: string,
  ownerId: string,
  outcome: AcquireOutcome,
): Record<string, unknown> {
  if (!outcome.ok) {
    return {
      operation: 'claim',
      race_date: raceDate,
      requested_scope: requestedScope,
      owner_id: ownerId,
      ok: false,
      classification: 'error' satisfies ClaimOpClassification,
      acquired: null,
      stole_expired: null,
      generation: null,
      current_owner_id: null,
      current_scope: null,
      expires_at: null,
      error: errorField(outcome.failure),
    };
  }
  const classification: ClaimOpClassification = !outcome.acquired
    ? 'refused'
    : outcome.stoleExpired
      ? 'stole_expired'
      : 'acquired';
  return {
    operation: 'claim',
    race_date: raceDate,
    requested_scope: requestedScope,
    owner_id: ownerId,
    ok: true,
    classification,
    acquired: outcome.acquired,
    stole_expired: outcome.stoleExpired,
    generation: outcome.generation,
    current_owner_id: outcome.currentOwnerId,
    current_scope: outcome.currentScope,
    expires_at: outcome.currentExpiresAt,
    error: null,
  };
}

export function buildHeartbeatJson(raceDate: string, ownerId: string, outcome: HeartbeatOutcome): Record<string, unknown> {
  if (!outcome.ok) {
    return {
      operation: 'heartbeat',
      race_date: raceDate,
      owner_id: ownerId,
      ok: false,
      classification: 'error',
      renewed: null,
      generation: null,
      expires_at: null,
      error: errorField(outcome.failure),
    };
  }
  if (outcome.renewed) {
    return {
      operation: 'heartbeat',
      race_date: raceDate,
      owner_id: ownerId,
      ok: true,
      classification: 'renewed',
      renewed: true,
      generation: outcome.generation,
      expires_at: outcome.expiresAt,
      error: null,
    };
  }
  return {
    operation: 'heartbeat',
    race_date: raceDate,
    owner_id: ownerId,
    ok: true,
    classification: 'ownership_lost',
    renewed: false,
    generation: null,
    expires_at: null,
    error: null,
  };
}

export function buildReleaseJson(raceDate: string, ownerId: string, outcome: ReleaseOutcome): Record<string, unknown> {
  if (!outcome.ok) {
    return {
      operation: 'release',
      race_date: raceDate,
      owner_id: ownerId,
      ok: false,
      classification: 'error',
      released: null,
      error: errorField(outcome.failure),
    };
  }
  return {
    operation: 'release',
    race_date: raceDate,
    owner_id: ownerId,
    ok: true,
    classification: outcome.released ? 'released' : 'not_held',
    released: outcome.released,
    error: null,
  };
}
