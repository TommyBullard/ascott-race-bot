/**
 * Pure Bearer-token authorization for operational endpoints.
 *
 * Centralises the `CRON_SECRET` gating convention already used by the cron
 * routes so it can be shared (e.g. by the manual, DB-mutating
 * `POST /api/run-model`) and unit-tested without a route runtime.
 *
 * Convention (matches the cron routes' `if (CRON_SECRET) { ... }` check):
 *   - When `secret` is falsy (unset/empty), authorization is OPEN. This
 *     preserves local/dev behaviour where `CRON_SECRET` is not configured.
 *   - When `secret` is set, the caller MUST present exactly
 *     `Authorization: Bearer <secret>`.
 *
 * The function is pure and side-effect free: it does not read the environment
 * and it never logs or echoes the secret, so callers cannot accidentally leak
 * it. Comparison is intentionally a plain equality check to match the existing
 * cron-route convention (see the doc note in the route handler for the
 * constant-time-comparison trade-off).
 */
export function isAuthorized(
  authorizationHeader: string | null | undefined,
  secret: string | undefined,
): boolean {
  // No secret configured -> open (local/dev convention, as in the cron routes).
  if (!secret) {
    return true;
  }
  return authorizationHeader === `Bearer ${secret}`;
}
