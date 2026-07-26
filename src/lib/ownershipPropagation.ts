/**
 * Ownership-context propagation — builds the `x-producer-ownership` header value
 * from a claim-holding orchestrator's live state (Phase 7A route-hardening, B/C
 * Slice 3).
 *
 * WHAT THIS DOES: projects the minimal structural {@link OwnershipContextSource}
 * — satisfied by BOTH the selected-course `OwnershipState` and the
 * `NationwideOwnershipState` — into a serialized ownership context, so an
 * orchestrator can attach its own ownership proof to the protected racecards /
 * odds route calls it makes through `createCallCron`.
 *
 * FAIL-CLOSED CONTRACT: a supplied source that is not believed, or is missing /
 * malformed in any required field, yields a discriminated FAILURE — never a
 * silent "omit the header" and never a throw. The caller
 * ({@link createCallCron}) turns that failure into a local pre-fetch refusal so
 * an invalid supplied source can NEVER be downgraded to an anonymous
 * (context-less) request. The distinct "no source at all" case is handled ONE
 * level up (a caller that opts out of ownership passes no source callback).
 *
 * REUSE: the wire format, field validation, and scope/date rules all come from
 * the committed Slice 1 library ({@link ./ownershipContext}) — no second wire
 * format, no second scope/date rule, no `mode` field. This module performs NO
 * I/O, reads NO environment, logs NOTHING, and exposes NO secret (the context
 * carries none). It never throws for malformed input — failure is a value.
 *
 * Decision-support only — nothing here places a bet.
 */

import {
  isPositiveInteger,
  isValidContextDate,
  isWellFormedScope,
  serializeOwnershipContext,
  type OwnershipContext,
} from './ownershipContext';

/**
 * The minimal structural subset of an in-memory ownership belief needed to
 * build a context. BOTH `OwnershipState` (selected-course) and
 * `NationwideOwnershipState` satisfy it structurally — no `mode`, no cast. */
export interface OwnershipContextSource {
  raceDate: string;
  ownerId: string;
  generation: number;
  scope: string;
  believed: boolean;
}

/** Closed set of reasons a believed-or-not source could not become a header. */
export type PropagationFailureReason =
  | 'not_believed'
  | 'invalid_date'
  | 'invalid_owner'
  | 'invalid_generation'
  | 'invalid_scope'
  | 'serialize_failed';

/** Discriminated result — distinguishes success from a typed, safe failure. */
export type PropagationResult =
  | { ok: true; header: string }
  | { ok: false; reason: PropagationFailureReason };

/** Re-export the single canonical header name so callers never restate it. */
export { OWNERSHIP_CONTEXT_HEADER } from './ownershipContext';

/**
 * Builds the serialized `x-producer-ownership` value from a source. Pure and
 * total: it NEVER throws — every failure mode is a `{ ok: false; reason }`. It
 * reuses the Slice 1 validators + serializer, so the output is exactly
 * `{v,date,owner,generation,scope}` and is never a malformed/oversized header.
 * A `null`/`undefined` source is treated as `not_believed` (a defensive
 * failure); the "no source supplied at all" case is the CALLER's to represent.
 */
export function buildOwnershipHeader(source: OwnershipContextSource | null | undefined): PropagationResult {
  if (!source || typeof source !== 'object') return { ok: false, reason: 'not_believed' };
  if (source.believed !== true) return { ok: false, reason: 'not_believed' };
  if (!isValidContextDate(source.raceDate)) return { ok: false, reason: 'invalid_date' };
  if (typeof source.ownerId !== 'string' || source.ownerId.trim() === '') {
    return { ok: false, reason: 'invalid_owner' };
  }
  if (!isPositiveInteger(source.generation)) return { ok: false, reason: 'invalid_generation' };
  if (!isWellFormedScope(source.scope)) return { ok: false, reason: 'invalid_scope' };

  const context: OwnershipContext = {
    v: 1,
    date: source.raceDate,
    owner: source.ownerId,
    generation: source.generation,
    scope: source.scope,
  };
  try {
    return { ok: true, header: serializeOwnershipContext(context) };
  } catch {
    // serializeOwnershipContext only throws on an invalid/oversized context,
    // which the validations above already preclude — this is pure defense.
    return { ok: false, reason: 'serialize_failed' };
  }
}

/**
 * Thrown by {@link createCallCron} BEFORE any fetch when a propagation SOURCE
 * was supplied (via the ownership-source callback) but could not yield a valid
 * header — including the callback returning `undefined`. Carries only a closed
 * reason code and a fixed, safe message: never the raw source, the full owner
 * id, or the serialized context.
 */
export class OwnershipPropagationError extends Error {
  readonly reason: PropagationFailureReason | 'source_unavailable';

  constructor(reason: PropagationFailureReason | 'source_unavailable') {
    super(`ownership propagation failed before request: ${reason}`);
    this.name = 'OwnershipPropagationError';
    this.reason = reason;
  }
}
