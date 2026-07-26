/**
 * Ownership context — pure, INERT library for route-level ownership enforcement
 * (Nationwide rebuild, Phase 7A route-hardening, B/C Slice 1).
 *
 * WHAT THIS IS: the wire contract and verification logic for a server-to-server
 * "ownership context" — a small, secret-free object an owning orchestrator will
 * (in a LATER slice) attach to its authenticated cron/model calls, and that a
 * protected route will (in a later slice) verify against the live producer
 * claim before doing any provider/model/write work.
 *
 * WHAT THIS IS NOT (Slice 1 scope): nothing here is wired to a route, an
 * orchestrator, `createCallCron`, an HTTP header, an enforcement mode, or the
 * database. No production file imports this module yet. It is deliberately
 * inert so it can be reviewed and unit-tested in complete isolation.
 *
 * PURITY GUARANTEES (asserted by the test suite):
 *   - no I/O of any kind (no network, no filesystem, no child process);
 *   - no database/provider/model/claim call — `verifyOwnershipContext` consumes
 *     an ALREADY-FETCHED status outcome and decides purely;
 *   - no environment-variable read;
 *   - no logging;
 *   - no local clock: it references neither the wall clock nor the Date
 *     constructor, and never derives claim liveness itself. Calendar-date
 *     validation is a pure arithmetic check, and claim liveness is taken ONLY
 *     from the server-time-derived `liveness.status` already present on the
 *     status outcome.
 *
 * SCOPE MATCHING IS FAIL-CLOSED: a context's scope must EXACTLY equal the live
 * claim's scope. A `course:ascot` context never verifies against an
 * `all-uk-ire` claim, and vice versa; two different course scopes never match.
 * Whether a given route is logically compatible with a given scope is a LATER
 * route-guard decision and is intentionally out of scope here.
 *
 * DATA MINIMISATION: the context carries ONLY the fields required to verify the
 * live claim — version, date, owner, generation, scope. Producer "mode"
 * (`pipeline-day` / `pipeline-watch` / `nationwide-*-dry-run`) is deliberately
 * NOT transmitted: it is not part of any allow/deny rule and projecting it onto
 * a `commit | dry-run` literal would be lossy and unnecessary.
 *
 * Decision-support only — nothing here places a bet.
 */

import type { OwnershipState } from './producerOwnership';

/** Wire-format version. Bumped only on an incompatible context shape change. */
export const OWNERSHIP_CONTEXT_VERSION = 1 as const;

/** The server-to-server header name (never browser-visible; sent by orchestrators only). */
export const OWNERSHIP_CONTEXT_HEADER = 'x-producer-ownership';

/**
 * Conservative maximum serialized size in UTF-8 bytes. A valid context is
 * ~150 bytes; this bounds a hostile/oversized header well below any request
 * limit and is checked BEFORE JSON parsing. Exported for tests.
 */
export const OWNERSHIP_CONTEXT_MAX_BYTES = 1024;

/** The strict, secret-free ownership context. Exactly these five fields. */
export interface OwnershipContext {
  v: typeof OWNERSHIP_CONTEXT_VERSION;
  date: string;
  owner: string;
  generation: number;
  scope: string;
}

/** The exact allowed key set — used to reject unknown/extra properties. */
const ALLOWED_KEYS: readonly string[] = ['v', 'date', 'owner', 'generation', 'scope'];

/* -------------------------------------------------------------------------- */
/* Pure format validators (mirror the authoritative rules VERBATIM — no new   */
/* course-normalisation rule is invented here)                                */
/* -------------------------------------------------------------------------- */

/**
 * Strict `YYYY-MM-DD` calendar validation with no Date constructor — pure
 * arithmetic (leap-year aware), so the module references no clock at all.
 */
export function isValidContextDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

const ALL_UK_IRE_SCOPE = 'all-uk-ire';
/** Mirrors producerClaim's `COURSE_SCOPE_RE` exactly: lowercase alnum + single spaces. */
const COURSE_SCOPE_RE = /^course:[a-z0-9]+( [a-z0-9]+)*$/;

/** True for `'all-uk-ire'` or a well-formed `'course:<normalised>'` scope. Pure. */
export function isWellFormedScope(value: unknown): value is string {
  return typeof value === 'string' && (value === ALL_UK_IRE_SCOPE || COURSE_SCOPE_RE.test(value));
}

/** True for a strictly positive integer (rejects 0, negatives, decimals, NaN, strings). */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/* -------------------------------------------------------------------------- */
/* Build                                                                      */
/* -------------------------------------------------------------------------- */

/** Thrown when {@link buildOwnershipContext} is given a state it must not project. */
export class InvalidOwnershipStateError extends Error {
  constructor(field: string) {
    // Field NAME only — never the value (owner ids etc. are never echoed).
    super(`invalid ownership state: ${field}`);
    this.name = 'InvalidOwnershipStateError';
  }
}

/**
 * Projects ONLY the five required fields from a valid, believed ownership
 * state. Fails closed (throws {@link InvalidOwnershipStateError}) on any
 * malformed field — it never silently repairs state. Deliberately does NOT read
 * `state.mode`: producer mode is not transmitted (see the module docstring).
 * Pure.
 */
export function buildOwnershipContext(state: OwnershipState): OwnershipContext {
  if (!state || typeof state !== 'object') throw new InvalidOwnershipStateError('state');
  if (state.believed !== true) throw new InvalidOwnershipStateError('believed');
  if (!isValidContextDate(state.raceDate)) throw new InvalidOwnershipStateError('date');
  if (typeof state.ownerId !== 'string' || state.ownerId.trim() === '') {
    throw new InvalidOwnershipStateError('owner');
  }
  if (!isPositiveInteger(state.generation)) throw new InvalidOwnershipStateError('generation');
  if (!isWellFormedScope(state.scope)) throw new InvalidOwnershipStateError('scope');
  return {
    v: OWNERSHIP_CONTEXT_VERSION,
    date: state.raceDate,
    owner: state.ownerId,
    generation: state.generation,
    scope: state.scope,
  };
}

/* -------------------------------------------------------------------------- */
/* Serialize                                                                  */
/* -------------------------------------------------------------------------- */

/** Thrown when a context cannot be safely serialized. Message carries no secret. */
export class OwnershipContextSerializeError extends Error {
  constructor(reason: string) {
    super(`cannot serialize ownership context: ${reason}`);
    this.name = 'OwnershipContextSerializeError';
  }
}

/** UTF-8 byte length without any I/O. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Deterministic serialization (fixed key order, no whitespace). Validates the
 * context first and refuses an oversized result. Never logs. Pure.
 */
export function serializeOwnershipContext(context: OwnershipContext): string {
  if (!isValidOwnershipContext(context)) {
    throw new OwnershipContextSerializeError('invalid context');
  }
  // Fixed insertion order → deterministic JSON.stringify output.
  const canonical = {
    v: context.v,
    date: context.date,
    owner: context.owner,
    generation: context.generation,
    scope: context.scope,
  };
  const serialized = JSON.stringify(canonical);
  if (byteLength(serialized) > OWNERSHIP_CONTEXT_MAX_BYTES) {
    throw new OwnershipContextSerializeError('oversized');
  }
  return serialized;
}

/** Structural + format validity of an in-memory context object. Pure. */
export function isValidOwnershipContext(value: unknown): value is OwnershipContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== ALLOWED_KEYS.length) return false;
  if (!keys.every((k) => ALLOWED_KEYS.includes(k))) return false;
  return (
    obj.v === OWNERSHIP_CONTEXT_VERSION &&
    isValidContextDate(obj.date) &&
    typeof obj.owner === 'string' &&
    obj.owner.trim() !== '' &&
    isPositiveInteger(obj.generation) &&
    isWellFormedScope(obj.scope)
  );
}

/* -------------------------------------------------------------------------- */
/* Parse                                                                      */
/* -------------------------------------------------------------------------- */

export type ParseResult =
  | { kind: 'valid'; context: OwnershipContext }
  | { kind: 'absent' }
  | { kind: 'malformed'; detail: string }
  | { kind: 'unsupported_version'; detail: string }
  | { kind: 'oversized'; detail: string };

/**
 * Strictly parses a header value into a typed result. NEVER coerces strings to
 * numbers, never trims malformed input into validity, and never echoes the raw
 * header back in any `detail` (details are fixed, non-identifying strings).
 * Pure.
 */
export function parseOwnershipContext(raw: string | null | undefined): ParseResult {
  if (raw === null || raw === undefined) return { kind: 'absent' };
  if (typeof raw !== 'string') return { kind: 'malformed', detail: 'not a string' };
  if (raw.trim() === '') return { kind: 'absent' };
  // Size gate BEFORE parsing, so a hostile giant header is cheap to reject.
  if (byteLength(raw) > OWNERSHIP_CONTEXT_MAX_BYTES) {
    return { kind: 'oversized', detail: 'exceeds maximum size' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'malformed', detail: 'not valid JSON' };
  }

  if (parsed === null) return { kind: 'malformed', detail: 'null' };
  if (Array.isArray(parsed)) return { kind: 'malformed', detail: 'array' };
  if (typeof parsed !== 'object') return { kind: 'malformed', detail: 'not an object' };

  const obj = parsed as Record<string, unknown>;

  // Version first, so a wrong version is distinguishable from other malformity.
  if (!('v' in obj)) return { kind: 'malformed', detail: 'missing version' };
  if (obj.v !== OWNERSHIP_CONTEXT_VERSION) {
    return { kind: 'unsupported_version', detail: 'unsupported version' };
  }

  const keys = Object.keys(obj);
  if (keys.length !== ALLOWED_KEYS.length || !keys.every((k) => ALLOWED_KEYS.includes(k))) {
    return { kind: 'malformed', detail: 'unexpected properties' };
  }

  if (!isValidContextDate(obj.date)) return { kind: 'malformed', detail: 'invalid date' };
  if (typeof obj.owner !== 'string' || obj.owner.trim() === '') {
    return { kind: 'malformed', detail: 'invalid owner' };
  }
  if (!isPositiveInteger(obj.generation)) return { kind: 'malformed', detail: 'invalid generation' };
  if (!isWellFormedScope(obj.scope)) return { kind: 'malformed', detail: 'invalid scope' };

  return {
    kind: 'valid',
    context: {
      v: OWNERSHIP_CONTEXT_VERSION,
      date: obj.date,
      owner: obj.owner,
      generation: obj.generation,
      scope: obj.scope,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Verify (pure; consumes an already-fetched status outcome)                  */
/* -------------------------------------------------------------------------- */

export type OwnershipDenyReason =
  // 403 — the caller-supplied context itself is the problem.
  | 'context_absent'
  | 'context_malformed'
  | 'context_unsupported_version'
  | 'context_oversized'
  // 409 — a concrete ownership-state conflict against a real, live claim.
  | 'date_mismatch'
  | 'no_claim'
  | 'claim_expired'
  | 'owner_mismatch'
  | 'generation_mismatch'
  | 'scope_mismatch'
  // 503 — verification is indeterminate; fail closed, never allow.
  | 'mechanism_unavailable'
  | 'transient_uncertain'
  | 'liveness_unknown'
  | 'status_malformed';

export type OwnershipDecision =
  | { allow: true }
  | { allow: false; status: 403 | 409 | 503; reason: OwnershipDenyReason };

const DENY_403: Record<string, OwnershipDenyReason> = {
  absent: 'context_absent',
  malformed: 'context_malformed',
  unsupported_version: 'context_unsupported_version',
  oversized: 'context_oversized',
};

function deny(status: 403 | 409 | 503, reason: OwnershipDenyReason): OwnershipDecision {
  return { allow: false, status, reason };
}

/**
 * The minimal, structurally-validated view of a status outcome this verifier
 * relies on. The public function accepts `unknown` and narrows at runtime, so a
 * malformed outcome fails closed rather than throwing.
 */
type NarrowedLiveClaim = { ownerId: string; generation: number; scope: string; raceDate: string };

/**
 * Decides whether a parsed context authorises work for `routeResolvedDate`,
 * given an ALREADY-FETCHED producer-claim status outcome. Makes NO database,
 * environment, network, or clock call — claim liveness is read ONLY from the
 * server-time-derived `liveness.status` on the outcome. Fail-closed: any
 * unknown/malformed/indeterminate state denies. Pure.
 */
export function verifyOwnershipContext(
  parsed: ParseResult,
  statusOutcome: unknown,
  routeResolvedDate: string,
): OwnershipDecision {
  // 1. The context must be well-formed. A bad context is a 403 (caller problem).
  if (parsed.kind !== 'valid') {
    return deny(403, DENY_403[parsed.kind] ?? 'context_malformed');
  }
  const context = parsed.context;

  // The route's own resolved date must itself be valid; if not we cannot verify.
  if (!isValidContextDate(routeResolvedDate)) return deny(503, 'status_malformed');

  // 2. Context date must equal the route's resolved date exactly (confused-deputy guard).
  if (context.date !== routeResolvedDate) return deny(409, 'date_mismatch');

  // 3. The status outcome must be a well-formed object with a boolean `ok`.
  if (!statusOutcome || typeof statusOutcome !== 'object') return deny(503, 'status_malformed');
  const outcome = statusOutcome as Record<string, unknown>;
  if (typeof outcome.ok !== 'boolean') return deny(503, 'status_malformed');

  // 4. A failed status is indeterminate → 503 (never allow).
  if (outcome.ok === false) {
    const failure = outcome.failure as { kind?: unknown } | undefined;
    const kind = failure && typeof failure === 'object' ? failure.kind : undefined;
    if (kind === 'mechanism_unavailable') return deny(503, 'mechanism_unavailable');
    if (kind === 'transient_uncertain') return deny(503, 'transient_uncertain');
    // invalid_input or anything unrecognised → treat as malformed/indeterminate.
    return deny(503, 'status_malformed');
  }

  // 5. Liveness must be present and taken from the server-time-derived status.
  const liveness = outcome.liveness as { status?: unknown } | undefined;
  const livenessStatus = liveness && typeof liveness === 'object' ? liveness.status : undefined;
  if (typeof livenessStatus !== 'string') return deny(503, 'status_malformed');

  if (livenessStatus === 'unknown') return deny(503, 'liveness_unknown');
  if (livenessStatus === 'absent') return deny(409, 'no_claim');
  if (livenessStatus === 'expired') return deny(409, 'claim_expired');
  if (livenessStatus !== 'live') return deny(503, 'status_malformed');

  // 6. Live: the claim row must be present and well-formed.
  const claim = narrowLiveClaim(outcome.claim);
  if (!claim) return deny(503, 'status_malformed');

  // Defensive consistency: the status was fetched for a date; it must be this one.
  if (claim.raceDate !== routeResolvedDate) return deny(503, 'status_malformed');

  // 7. Exact-match every ownership field. All fail-closed (409).
  if (context.owner !== claim.ownerId) return deny(409, 'owner_mismatch');
  if (context.generation !== claim.generation) return deny(409, 'generation_mismatch');
  if (context.scope !== claim.scope) return deny(409, 'scope_mismatch');

  return { allow: true };
}

/** Narrows and validates the live-claim fields the verifier needs. Pure. */
function narrowLiveClaim(value: unknown): NarrowedLiveClaim | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (typeof c.ownerId !== 'string' || c.ownerId.trim() === '') return null;
  if (!isPositiveInteger(c.generation)) return null;
  if (!isWellFormedScope(c.scope)) return null;
  if (!isValidContextDate(c.raceDate)) return null;
  return { ownerId: c.ownerId, generation: c.generation, scope: c.scope, raceDate: c.raceDate };
}

/* -------------------------------------------------------------------------- */
/* Owner redaction                                                            */
/* -------------------------------------------------------------------------- */

/** Safe, non-identifying placeholder for a missing/short/malformed owner id. */
export const REDACTED_OWNER = '(redacted)';

/**
 * Returns at most the first eight safe characters of an owner id, or a safe
 * placeholder for blank/malformed/short (<= 8 char) input — a full owner id is
 * never returned. Pure.
 */
export function redactOwner(owner: unknown): string {
  if (typeof owner !== 'string') return REDACTED_OWNER;
  const trimmed = owner.trim();
  // A short id could be fully identifying, so never echo it whole.
  if (trimmed.length <= 8) return REDACTED_OWNER;
  const head = trimmed.slice(0, 8);
  return /^[A-Za-z0-9-]{8}$/.test(head) ? head : REDACTED_OWNER;
}
