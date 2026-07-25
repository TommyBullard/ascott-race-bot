/**
 * FAIL-CLOSED Bearer-token authorization for write-capable operational
 * endpoints (Phase 7A route-hardening, Step A).
 *
 * PREVIOUS BEHAVIOUR (removed): the cron routes and `POST /api/run-model` each
 * gated on `if (CRON_SECRET) { …check… }`, and the old `isAuthorized` helper
 * returned true when the secret was unset. An environment that lost its
 * `CRON_SECRET` therefore turned every provider-calling, database-writing route
 * into an open, unauthenticated write API. That convention is gone: an absent
 * or blank secret now REFUSES the request instead of opening it.
 *
 * Rules:
 *   - secret missing, empty, or whitespace-only -> `not_configured` (refuse).
 *     This is an operator misconfiguration, not a caller error.
 *   - header not exactly `Bearer <secret>` -> `unauthorized` (refuse).
 *     The comparison is exact and case-sensitive, with no partial or prefix
 *     matching.
 *   - otherwise -> `authorized`.
 *
 * This module is PURE: it reads no environment variable itself, performs no
 * I/O, and never logs, echoes, or returns the secret — callers pass the value
 * in and only ever receive an enum back. Refusal bodies are deliberately
 * generic so they disclose no key, environment value, command, owner id, or
 * implementation detail.
 *
 * Decision-support only — nothing here places a bet.
 */

/** The three possible outcomes of a fail-closed cron-secret check. */
export type CronAuthResult = 'authorized' | 'unauthorized' | 'not_configured';

/** A refusal outcome (everything except `authorized`). */
export type CronAuthRefusal = Exclude<CronAuthResult, 'authorized'>;

/**
 * Fail-closed authorization check. Returns `authorized` ONLY when a non-blank
 * secret is configured AND the header matches it exactly. Pure.
 */
export function requireCronSecret(
  authorizationHeader: string | null | undefined,
  secret: string | undefined | null,
): CronAuthResult {
  // A missing / empty / whitespace-only secret can never authorize anything.
  if (typeof secret !== 'string' || secret.trim() === '') {
    return 'not_configured';
  }
  return authorizationHeader === `Bearer ${secret}` ? 'authorized' : 'unauthorized';
}

/** What a route should return (and log) for a refusal. */
export interface CronAuthRefusalResponse {
  status: 401 | 503;
  body: { error: string };
  /** Server-side log line, or null when nothing should be logged. */
  logLine: string | null;
}

/**
 * Maps a refusal to a generic response plus an optional server-side log line.
 *
 * The bodies carry NO detail: a caller cannot distinguish a wrong token from a
 * malformed one, and cannot learn any environment value. A misconfiguration is
 * surfaced to the OPERATOR through the server log only — that line names the
 * variable, never its value. Pure.
 */
export function describeCronAuthFailure(result: CronAuthRefusal): CronAuthRefusalResponse {
  if (result === 'not_configured') {
    return {
      status: 503,
      body: { error: 'Endpoint unavailable' },
      logLine:
        'CRON_AUTH_NOT_CONFIGURED: CRON_SECRET is not set for this deployment; ' +
        'refusing the request (fail-closed). Set it in the environment to enable this endpoint.',
    };
  }
  return { status: 401, body: { error: 'Unauthorized' }, logLine: null };
}
