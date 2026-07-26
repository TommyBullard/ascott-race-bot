/**
 * Direct-model-CLI foreign-claim check — Phase 7A route-hardening, B/C Slice 4a.
 *
 * The direct model CLIs (`run:model`, `model:day --commit`) write model runs
 * WITHOUT holding a producer claim. To stop them clobbering a date another
 * producer currently owns, they perform this READ-ONLY, FAIL-CLOSED check before
 * any model work: read the live claim status for the date and decide whether a
 * direct write is safe to begin.
 *
 * POLICY (approved):
 *   - no claim / expired claim -> ALLOW (never steals or modifies it);
 *   - a LIVE claim for the date -> REFUSE;
 *   - unknown liveness / mechanism unavailable / permission failure / transient
 *     uncertainty / invalid input / malformed status -> REFUSE.
 * There is NO retry and NO acquire-as-fallback.
 *
 * This module NEVER acquires, heartbeats, releases, or steals a claim; never
 * calls a provider; never runs a model; never writes telemetry or a database
 * row; never starts a child process; and never logs or returns a full owner id
 * or any secret. The classifier is pure (no I/O, never throws); the async
 * wrapper performs exactly one read via an injectable status reader.
 *
 * Decision-support only — nothing here places a bet.
 */

import { fetchProducerClaimStatus } from './producerClaim';

/** Why a direct model write was refused. */
export type DirectModelClaimRefusalReason =
  | 'live_claim'
  | 'liveness_unknown'
  | 'mechanism_unavailable'
  | 'transient_uncertain'
  | 'invalid_input'
  | 'status_malformed';

/** Closed decision — allow (with why) or refuse (with a safe reason + optional prefix). */
export type DirectModelClaimDecision =
  | { allow: true; reason: 'unclaimed' | 'expired' }
  | { allow: false; reason: DirectModelClaimRefusalReason; ownerPrefix?: string };

/**
 * A non-identifying owner prefix: at most the first eight safe characters, or
 * `undefined` for a short/blank/malformed owner id (never a full or partial-
 * but-identifying id, never a padded placeholder). Pure.
 */
function safeOwnerPrefix(ownerId: unknown): string | undefined {
  if (typeof ownerId !== 'string') return undefined;
  const trimmed = ownerId.trim();
  if (trimmed.length <= 8) return undefined; // too short to reveal safely
  const head = trimmed.slice(0, 8);
  return /^[A-Za-z0-9-]{8}$/.test(head) ? head : undefined;
}

/**
 * Classifies an already-fetched claim-status outcome into an allow/refuse
 * decision. Accepts `unknown` and narrows at runtime, so a malformed outcome
 * fails closed rather than throwing. PURE: no I/O, never throws.
 */
export function classifyDirectModelClaim(statusOutcome: unknown): DirectModelClaimDecision {
  if (!statusOutcome || typeof statusOutcome !== 'object') {
    return { allow: false, reason: 'status_malformed' };
  }
  const outcome = statusOutcome as Record<string, unknown>;
  if (typeof outcome.ok !== 'boolean') {
    return { allow: false, reason: 'status_malformed' };
  }

  // A failed read is indeterminate -> refuse, mapping the failure kind.
  if (outcome.ok === false) {
    const failure = outcome.failure as { kind?: unknown } | undefined;
    const kind = failure && typeof failure === 'object' ? failure.kind : undefined;
    if (kind === 'mechanism_unavailable') return { allow: false, reason: 'mechanism_unavailable' };
    if (kind === 'transient_uncertain') return { allow: false, reason: 'transient_uncertain' };
    if (kind === 'invalid_input') return { allow: false, reason: 'invalid_input' };
    return { allow: false, reason: 'status_malformed' };
  }

  // ok === true: decide from the server-time-derived liveness only.
  const liveness = outcome.liveness as { status?: unknown } | undefined;
  const status = liveness && typeof liveness === 'object' ? liveness.status : undefined;
  if (typeof status !== 'string') return { allow: false, reason: 'status_malformed' };

  if (status === 'absent') return { allow: true, reason: 'unclaimed' };
  if (status === 'expired') return { allow: true, reason: 'expired' };
  if (status === 'unknown') return { allow: false, reason: 'liveness_unknown' };
  if (status === 'live') {
    const claim = outcome.claim as { ownerId?: unknown } | null | undefined;
    const prefix = safeOwnerPrefix(claim && typeof claim === 'object' ? claim.ownerId : undefined);
    return prefix
      ? { allow: false, reason: 'live_claim', ownerPrefix: prefix }
      : { allow: false, reason: 'live_claim' };
  }
  return { allow: false, reason: 'status_malformed' };
}

/** Injectable read-only status reader (defaults to the real, read-only RPC). */
export interface DirectModelClaimDeps {
  fetchStatus: (date: string) => Promise<unknown>;
}

export const defaultDirectModelClaimDeps: DirectModelClaimDeps = {
  fetchStatus: (date: string) => fetchProducerClaimStatus(date),
};

/**
 * Reads the live claim status for a date EXACTLY ONCE (read-only) and classifies
 * it. Never acquires/heartbeats/releases/steals a claim, never runs a model,
 * never writes. A reader that throws fails CLOSED (refuse), never open.
 */
export async function assertDirectModelClaimClear(
  date: string,
  deps: DirectModelClaimDeps = defaultDirectModelClaimDeps,
): Promise<DirectModelClaimDecision> {
  try {
    const outcome = await deps.fetchStatus(date);
    return classifyDirectModelClaim(outcome);
  } catch {
    // The status read itself failed — fail closed rather than proceed.
    return { allow: false, reason: 'mechanism_unavailable' };
  }
}

/**
 * A safe, operator-facing refusal message. Contains only the date, the fixed
 * reason code, and (when available) an 8-char owner prefix — never a full owner
 * id, timestamp, secret, or database error. It never suggests stealing,
 * deleting, or manually releasing a live claim. Pure.
 */
export function formatDirectModelRefusal(date: string, decision: { reason: DirectModelClaimRefusalReason; ownerPrefix?: string }): string {
  const owned = decision.reason === 'live_claim';
  const who = decision.ownerPrefix ? ` (owner ${decision.ownerPrefix}…)` : '';
  const head = owned
    ? `Refusing direct model write for ${date}: a live producer claim owns this date${who}.`
    : `Refusing direct model write for ${date}: producer ownership could not be verified (${decision.reason}).`;
  return (
    `${head} No model was run. ` +
    `Run the model through the owning pipeline (pipeline:day / pipeline:watch) instead; ` +
    `do not steal, delete, or manually release a live claim.`
  );
}
