/**
 * Day-level, FAIL-CLOSED producer ownership claim — Nationwide rebuild
 * Phase 7A.2b Step 1.
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
 * PURE LEASE MODEL: {@link decideClaim}/{@link canHeartbeat}/{@link canRelease}
 * mirror the migration's SQL exactly (mirrors the `modelRunLock.ts` pattern),
 * so the rules are unit-testable without a database.
 *
 * NOT WIRED YET: nothing in the producer calls these functions. This module
 * is schema-adjacent plumbing + a diagnostic CLI foundation only. No model
 * maths, staking, confidence, recommendation, lock, or settlement behaviour
 * changes. Decision-support only — this records producer ownership, never a
 * bet or an order.
 */

import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from './supabaseAdmin';
import { normalizeCourse } from './raceSync';
import { classifyTableProbe, type PostgrestErrorLike } from './dbHealthSpec';

/** Default lease TTL: 4 minutes against a 5-minute (300s) operating cadence. */
export const PRODUCER_CLAIM_DEFAULT_TTL_SECONDS = 240;

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

/* -------------------------------------------------------------------------- */
/* Pure lease semantics (mirror the SQL exactly; unit-testable)               */
/* -------------------------------------------------------------------------- */

/** A producer claim, in epoch-ms (the pure model of `producer_run_claims`). */
export interface ProducerLease {
  owner: string;
  scope: string;
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

/**
 * Pure model of `try_acquire_producer_claim`: claim when there is no lease;
 * IDEMPOTENTLY RENEW when the SAME owner already holds it (identical to a
 * heartbeat); steal an EXPIRED lease held by a different owner; refuse a LIVE
 * lease held by a different owner. TTL is clamped to >= 1ms. Deterministic;
 * the migration's SQL encodes the identical rule.
 */
export function decideClaim(
  existing: ProducerLease | null,
  owner: string,
  scope: string,
  nowMs: number,
  ttlMs: number,
): ProducerClaimDecision {
  const ttl = Math.max(ttlMs, 1);
  if (existing === null) {
    return {
      acquired: true,
      stoleExpired: false,
      lease: { owner, scope, claimedAtMs: nowMs, heartbeatAtMs: nowMs, expiresAtMs: nowMs + ttl },
    };
  }
  if (existing.owner === owner) {
    // Same owner re-claiming: idempotent renewal, identical to a heartbeat.
    return {
      acquired: true,
      stoleExpired: false,
      lease: { ...existing, scope, heartbeatAtMs: nowMs, expiresAtMs: nowMs + ttl },
    };
  }
  if (existing.expiresAtMs <= nowMs) {
    return {
      acquired: true,
      stoleExpired: true,
      lease: { owner, scope, claimedAtMs: nowMs, heartbeatAtMs: nowMs, expiresAtMs: nowMs + ttl },
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
 *   - `mechanism_unavailable` : table/RPC missing, or a response with an
 *     unrecognisable shape — the claim mechanism itself cannot be trusted.
 *   - `transient_uncertain`   : an error that is neither "missing" nor a
 *     clean, parseable response — genuinely ambiguous; retry once, then
 *     escalate to `mechanism_unavailable`.
 *   - `invalid_input`         : the caller passed a bad date/scope — never
 *     sent to the database at all.
 */
export type ClaimFailureKind = 'mechanism_unavailable' | 'transient_uncertain' | 'invalid_input';

export interface ClaimFailure {
  kind: ClaimFailureKind;
  message: string;
}

/** Classifies a non-null RPC/query error into a fail-closed kind. Pure. */
export function classifyClaimError(error: PostgrestErrorLike): ClaimFailure {
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

/** The minimal read surface for the status probe (injectable in tests). */
export interface ProducerClaimReadClient {
  selectClaim(
    raceDate: string,
  ): Promise<{ data: unknown; error: PostgrestErrorLike | null }>;
}

const defaultRpcClient = supabaseAdmin as unknown as ProducerClaimRpcClient;
const defaultReadClient: ProducerClaimReadClient = {
  async selectClaim(raceDate: string) {
    const { data, error } = await supabaseAdmin
      .from('producer_run_claims')
      .select('race_date, scope, owner_id, claimed_at, heartbeat_at, expires_at, hostname, pid, app_version, mode')
      .eq('race_date', raceDate)
      .limit(1);
    return { data: (data ?? [])[0] ?? null, error };
  },
};

/** A read-only projection of the current claim row for a date, or null when unclaimed. */
export interface ProducerClaimStatus {
  raceDate: string;
  scope: string;
  ownerId: string;
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
      currentOwnerId: string;
      currentScope: string;
      currentExpiresAt: string;
    }
  | { ok: false; failure: ClaimFailure };

export type HeartbeatOutcome =
  | { ok: true; renewed: true; expiresAt: string }
  | { ok: true; renewed: false } // CONFIRMED ownership loss — a clean, error-free response
  | { ok: false; failure: ClaimFailure };

export type ReleaseOutcome =
  | { ok: true; released: boolean }
  | { ok: false; failure: ClaimFailure };

export type StatusOutcome =
  | { ok: true; claim: ProducerClaimStatus | null }
  | { ok: false; failure: ClaimFailure };

/** Narrow-and-validate the acquire RPC's jsonb response. Pure. */
function parseAcquireResponse(data: unknown): AcquireOutcome | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (
    typeof d.acquired !== 'boolean' ||
    typeof d.stole_expired !== 'boolean' ||
    typeof d.current_owner_id !== 'string' ||
    typeof d.current_scope !== 'string' ||
    typeof d.current_expires_at !== 'string'
  ) {
    return null;
  }
  return {
    ok: true,
    acquired: d.acquired,
    stoleExpired: d.stole_expired,
    currentOwnerId: d.current_owner_id,
    currentScope: d.current_scope,
    currentExpiresAt: d.current_expires_at,
  };
}

/** Narrow-and-validate the heartbeat RPC's jsonb response. Pure. */
function parseHeartbeatResponse(data: unknown): HeartbeatOutcome | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.renewed !== 'boolean') return null;
  if (d.renewed) {
    if (typeof d.expires_at !== 'string') return null;
    return { ok: true, renewed: true, expiresAt: d.expires_at };
  }
  return { ok: true, renewed: false };
}

/**
 * Attempts to acquire (or idempotently renew) the date-level producer claim.
 * FAIL-CLOSED: on any error, missing table/RPC, or malformed response, returns
 * `{ ok: false, failure }` — NEVER `null`-meaning-proceed. The caller must
 * treat anything other than `{ ok: true, acquired: true }` as "do not start
 * any provider/model/persistence stage."
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
      p_ttl_seconds: params.ttlSeconds ?? PRODUCER_CLAIM_DEFAULT_TTL_SECONDS,
      p_hostname: sanitizeMetadataValue(params.hostname),
      p_pid: typeof params.pid === 'number' && Number.isFinite(params.pid) ? params.pid : null,
      p_app_version: sanitizeMetadataValue(params.appVersion),
      p_mode: sanitizeMetadataValue(params.mode),
    });
    if (error) return { ok: false, failure: classifyClaimError(error) };
    const parsed = parseAcquireResponse(data);
    if (!parsed) {
      return { ok: false, failure: { kind: 'mechanism_unavailable', message: 'malformed acquire response shape' } };
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
      p_ttl_seconds: params.ttlSeconds ?? PRODUCER_CLAIM_DEFAULT_TTL_SECONDS,
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

/** Read-only status probe: the current claim for a date, or null when unclaimed. SELECT-only. */
export async function fetchProducerClaimStatus(
  raceDate: string,
  client: ProducerClaimReadClient = defaultReadClient,
): Promise<StatusOutcome> {
  if (!isValidRaceDate(raceDate)) {
    return { ok: false, failure: { kind: 'invalid_input', message: `invalid race date: ${raceDate}` } };
  }
  try {
    const { data, error } = await client.selectClaim(raceDate);
    if (error) return { ok: false, failure: classifyClaimError(error) };
    if (data === null || data === undefined) return { ok: true, claim: null };
    const row = data as Record<string, unknown>;
    if (
      typeof row.race_date !== 'string' ||
      typeof row.scope !== 'string' ||
      typeof row.owner_id !== 'string' ||
      typeof row.claimed_at !== 'string' ||
      typeof row.heartbeat_at !== 'string' ||
      typeof row.expires_at !== 'string'
    ) {
      return { ok: false, failure: { kind: 'mechanism_unavailable', message: 'malformed claim row shape' } };
    }
    return {
      ok: true,
      claim: {
        raceDate: row.race_date,
        scope: row.scope,
        ownerId: row.owner_id,
        claimedAt: row.claimed_at,
        heartbeatAt: row.heartbeat_at,
        expiresAt: row.expires_at,
        hostname: typeof row.hostname === 'string' ? row.hostname : null,
        pid: typeof row.pid === 'number' ? row.pid : null,
        appVersion: typeof row.app_version === 'string' ? row.app_version : null,
        mode: typeof row.mode === 'string' ? row.mode : null,
      },
    };
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'transient_uncertain', message: err instanceof Error ? err.message : String(err) },
    };
  }
}
