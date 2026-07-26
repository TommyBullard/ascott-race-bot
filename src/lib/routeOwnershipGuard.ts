/**
 * Route ownership guard — server-side verification of the producer-ownership
 * context on write-capable routes (Phase 7A route-hardening, B/C Slice 2).
 *
 * WHAT THIS DOES: a route calls {@link enforceRouteOwnership} AFTER its Step A
 * bearer check and BEFORE any provider call, model execution, or database
 * write. The guard reads the `x-producer-ownership` header, parses it with the
 * pure Slice 1 library, and — ONLY when the header parses as a VALID context —
 * reads the live producer claim via the read-only `fetchProducerClaimStatus`
 * RPC and verifies it with {@link verifyOwnershipContext}. It then returns a
 * safe allow/deny decision plus a redacted diagnostic event.
 *
 * WHAT THIS NEVER DOES: it never acquires / renews / releases / steals a claim,
 * never calls a provider, never runs a model, never writes telemetry or any
 * database row, never logs the raw header, and never puts an owner id, claim
 * generation, scope, timestamp, hostname, pid, app version, or the raw context
 * into an HTTP response. The ONLY I/O it can trigger is the read-only claim
 * status query, and only on the valid-context path.
 *
 * ENFORCEMENT MODE (`PRODUCER_OWNERSHIP_ENFORCEMENT`): `off` | `warn` |
 * `enforce`. Resolution is FAIL-CLOSED — missing / blank / unknown all resolve
 * to `enforce`. `warn` differs from `enforce` in EXACTLY ONE case: an ABSENT
 * context is permitted (with a structured compatibility warning) instead of
 * refused. Every malformed, unsupported, oversized, conflicting, expired, or
 * indeterminate context FAILS CLOSED in both `warn` and `enforce` — a supplied
 * but invalid/stale context is evidence of a broken caller, which `warn` must
 * not hide. `off` skips parsing and verification entirely (emergency
 * compatibility only) and permits after Step A.
 *
 * Decision-support only — nothing here places a bet.
 */

import { NextResponse } from 'next/server';

import {
  OWNERSHIP_CONTEXT_HEADER,
  parseOwnershipContext,
  redactOwner,
  verifyOwnershipContext,
  type OwnershipContext,
  type OwnershipDenyReason,
} from './ownershipContext';
import { fetchProducerClaimStatus } from './producerClaim';

/* -------------------------------------------------------------------------- */
/* Enforcement mode (fail-closed)                                             */
/* -------------------------------------------------------------------------- */

export type EnforcementMode = 'off' | 'warn' | 'enforce';

/** The environment variable that selects the enforcement mode. */
export const ENFORCEMENT_ENV_VAR = 'PRODUCER_OWNERSHIP_ENFORCEMENT';

export interface EnforcementModeResolution {
  mode: EnforcementMode;
  /** False when the raw value was missing/blank/unrecognised (still resolves to enforce). */
  recognized: boolean;
}

/**
 * Resolves the enforcement mode from a raw string. EXACT match only (no trim,
 * no case-folding); anything else — including missing or blank — is
 * FAIL-CLOSED to `enforce`. Pure.
 */
export function resolveEnforcementMode(raw: string | null | undefined): EnforcementModeResolution {
  if (raw === 'off') return { mode: 'off', recognized: true };
  if (raw === 'warn') return { mode: 'warn', recognized: true };
  if (raw === 'enforce') return { mode: 'enforce', recognized: true };
  return { mode: 'enforce', recognized: false };
}

/** Reads the enforcement mode from the environment (the only env read here). */
export function readEnforcementMode(): EnforcementModeResolution {
  return resolveEnforcementMode(process.env[ENFORCEMENT_ENV_VAR]);
}

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** A route's own resolved meeting date, or a signal that it could not resolve one. */
export type EffectiveDate = { ok: true; date: string } | { ok: false };

/** A generic, secret-free HTTP refusal. */
export interface SafeRefusal {
  status: 403 | 409 | 503;
  body: { error: string };
}

/**
 * A structured, redacted, server-side-only diagnostic event. It carries ONLY
 * safe fields: a fixed event name, the route id, the enforcement mode, a safe
 * reason code, the requested date, and — at most — the 8-char owner prefix. It
 * NEVER contains the raw header, a full owner id, claim scope, generation, or
 * any timestamp/host/pid metadata.
 */
export interface SafeOwnershipEvent {
  event:
    | 'OWNERSHIP_VERIFIED'
    | 'OWNERSHIP_REFUSED'
    | 'OWNERSHIP_ABSENT_COMPAT'
    | 'OWNERSHIP_ENFORCEMENT_OFF';
  route: string;
  mode: EnforcementMode;
  reason: OwnershipDenyReason | 'ok' | 'absent' | 'off' | 'route_date_unresolved';
  date: string | null;
  ownerPrefix: string | null;
}

export type RouteOwnershipDecision =
  | { proceed: true; event: SafeOwnershipEvent }
  | { proceed: false; refusal: SafeRefusal; event: SafeOwnershipEvent };

export interface RouteOwnershipGuardInput {
  /** Log label only, e.g. 'cron/racecards'. Never a secret. */
  route: string;
  /** The raw header value (`request.headers.get(OWNERSHIP_CONTEXT_HEADER)`). */
  headerValue: string | null;
  mode: EnforcementMode;
  /** Invoked ONLY when the context parses as valid (so absent/malformed do no work). */
  resolveEffectiveDate: () => Promise<EffectiveDate>;
}

/** Injectable side-effect surface (defaults to the real read-only RPC + logger). */
export interface GuardDeps {
  /** Reads the live claim status for a date (read-only; the valid path only). */
  fetchStatus: (date: string) => Promise<unknown>;
  /** Emits a structured, redacted diagnostic event. */
  log: (event: SafeOwnershipEvent) => void;
}

/* -------------------------------------------------------------------------- */
/* Safe body + event construction (pure)                                      */
/* -------------------------------------------------------------------------- */

/** Maps a refusal status to its fixed, non-disclosing body. Pure. */
export function ownershipRefusalBody(status: 403 | 409 | 503): { error: string } {
  if (status === 403) return { error: 'Ownership required' };
  if (status === 409) return { error: 'Ownership conflict' };
  return { error: 'Ownership verification unavailable' };
}

function event(
  name: SafeOwnershipEvent['event'],
  route: string,
  mode: EnforcementMode,
  reason: SafeOwnershipEvent['reason'],
  date: string | null,
  context: OwnershipContext | null,
): SafeOwnershipEvent {
  return {
    event: name,
    route,
    mode,
    reason,
    date,
    // At most the safe 8-char prefix, and only when a context was actually parsed.
    ownerPrefix: context ? redactOwner(context.owner) : null,
  };
}

function refuse(
  status: 403 | 409 | 503,
  reason: SafeOwnershipEvent['reason'],
  route: string,
  mode: EnforcementMode,
  date: string | null,
  context: OwnershipContext | null,
): RouteOwnershipDecision {
  return {
    proceed: false,
    refusal: { status, body: ownershipRefusalBody(status) },
    event: event('OWNERSHIP_REFUSED', route, mode, reason, date, context),
  };
}

/* -------------------------------------------------------------------------- */
/* The guard decision (async; queries claim status only on the valid path)    */
/* -------------------------------------------------------------------------- */

/** Emits a structured, redacted diagnostic line. Never logs a raw header/owner. */
export function logOwnershipEvent(evt: SafeOwnershipEvent): void {
  const line = JSON.stringify(evt);
  if (evt.event === 'OWNERSHIP_VERIFIED' || evt.event === 'OWNERSHIP_ENFORCEMENT_OFF') {
    console.log(line);
  } else {
    console.warn(line);
  }
}

export const defaultGuardDeps: GuardDeps = {
  fetchStatus: (date: string) => fetchProducerClaimStatus(date),
  log: logOwnershipEvent,
};

/**
 * Decides whether a request may proceed. Callers MUST have already passed Step
 * A authentication. Performs a claim-status query ONLY when the context parses
 * as valid; absent/malformed/unsupported/oversized are decided with zero I/O.
 */
export async function guardRouteOwnership(
  input: RouteOwnershipGuardInput,
  deps: GuardDeps = defaultGuardDeps,
): Promise<RouteOwnershipDecision> {
  const { route, headerValue, mode, resolveEffectiveDate } = input;

  // OFF: emergency compatibility. No parse, no query, no owner logged.
  if (mode === 'off') {
    return { proceed: true, event: event('OWNERSHIP_ENFORCEMENT_OFF', route, mode, 'off', null, null) };
  }

  const parsed = parseOwnershipContext(headerValue);

  // VALID: the only branch that performs I/O.
  if (parsed.kind === 'valid') {
    const resolved = await resolveEffectiveDate();
    if (!resolved.ok) {
      return refuse(503, 'route_date_unresolved', route, mode, null, parsed.context);
    }
    const status = await deps.fetchStatus(resolved.date);
    const decision = verifyOwnershipContext(parsed, status, resolved.date);
    if (decision.allow) {
      return { proceed: true, event: event('OWNERSHIP_VERIFIED', route, mode, 'ok', resolved.date, parsed.context) };
    }
    return refuse(decision.status, decision.reason, route, mode, resolved.date, parsed.context);
  }

  // ABSENT: the single warn-vs-enforce difference. No I/O either way.
  if (parsed.kind === 'absent') {
    if (mode === 'warn') {
      return { proceed: true, event: event('OWNERSHIP_ABSENT_COMPAT', route, mode, 'absent', null, null) };
    }
    return refuse(403, 'context_absent', route, mode, null, null);
  }

  // MALFORMED / UNSUPPORTED_VERSION / OVERSIZED: fail closed in BOTH modes, no I/O.
  // verifyOwnershipContext returns the 403 for a non-valid parse without reading
  // the (undefined) status or date.
  const decision = verifyOwnershipContext(parsed, undefined, '');
  const status = decision.allow ? 503 : decision.status;
  const reason: SafeOwnershipEvent['reason'] = decision.allow ? 'status_malformed' : decision.reason;
  return refuse(status, reason, route, mode, null, null);
}

/* -------------------------------------------------------------------------- */
/* Route-facing helper                                                        */
/* -------------------------------------------------------------------------- */

export type RouteOwnershipGate = { proceed: true } | { proceed: false; response: NextResponse };

/**
 * The single call a route makes after Step A auth: reads the mode from the
 * environment and the header from the request, runs the guard, logs the
 * (redacted) event, and returns either a proceed signal or a ready-to-return
 * generic refusal response. `resolveEffectiveDate` is invoked lazily by the
 * guard (valid-context path only). Deps are injectable for tests.
 */
export async function enforceRouteOwnership(
  request: Request,
  route: string,
  resolveEffectiveDate: () => Promise<EffectiveDate>,
  deps: GuardDeps = defaultGuardDeps,
  mode: EnforcementMode = readEnforcementMode().mode,
): Promise<RouteOwnershipGate> {
  const decision = await guardRouteOwnership(
    { route, headerValue: request.headers.get(OWNERSHIP_CONTEXT_HEADER), mode, resolveEffectiveDate },
    deps,
  );
  deps.log(decision.event);
  if (decision.proceed) return { proceed: true };
  return { proceed: false, response: NextResponse.json(decision.refusal.body, { status: decision.refusal.status }) };
}

/** Convenience: a resolver for a route that already knows its concrete date. */
export function staticEffectiveDate(date: string): () => Promise<EffectiveDate> {
  return () => Promise.resolve({ ok: true, date });
}
