/**
 * Pure error-diagnostic helpers for the cron routes (Batch K1i).
 *
 * Turns a caught error into a structured, secret-safe diagnostic: the failing
 * job's name, the error message (unchanged from what the route already returned),
 * and an optional STATIC guidance hint chosen from the message text. It performs
 * no I/O and reads no environment values.
 *
 * SECURITY: hints are fixed strings that mention only env-var NAMES (never
 * values). The underlying error messages thrown by the pipeline already contain
 * only names + provider response text (e.g. "Missing environment variable:
 * RACING_API_USER", "Missing Betfair env var(s): BETFAIR_APP_KEY"), never the
 * secret values themselves, so surfacing them does not leak credentials.
 */

/** A structured, secret-safe view of a cron-route failure. */
export interface CronErrorDiagnostic {
  /** The failing job, e.g. 'cron/racecards'. */
  job: string;
  /** The error message (verbatim; same string the route returns as `error`). */
  message: string;
  /** Safe, static guidance, or null when no specific hint applies. */
  hint: string | null;
}

/**
 * Returns safe, static troubleshooting guidance for a cron error message, or
 * `null` when nothing specific applies. Matching is case-insensitive and ordered
 * most-specific-first. The returned strings are constants — they never include
 * any environment value.
 */
export function cronErrorHint(message: string): string | null {
  const m = (message ?? '').toLowerCase();

  if (m.includes('racing_api') || m.includes('racing api')) {
    return 'Check RACING_API_USER / RACING_API_KEY in .env.local, and that your Racing API plan includes this endpoint.';
  }
  if (m.includes('betfair')) {
    return 'Check the BETFAIR_* credentials (app key, username, password, and the cert/key PEM). The odds pipeline needs Betfair, and its certificate setup is a manual step.';
  }
  if (m.includes('supabase_url') || m.includes('supabase_service_role_key')) {
    return 'Check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local.';
  }
  if (m.includes('missing environment variable') || m.includes('env var')) {
    return 'A required environment variable is missing — see .env.example and set it in .env.local (run `npm run check:env` to see which are set).';
  }
  if (m.includes('does not exist') && m.includes('relation')) {
    return 'A required database table is missing — verify the schema with `npm run check:db`.';
  }
  return null;
}

/**
 * Builds a {@link CronErrorDiagnostic} from a job name + a caught error. The
 * message is extracted the same way the routes already do (`Error.message`, else
 * `String(error)`), so the route's `error` field is unchanged.
 */
export function buildCronErrorDiagnostic(
  job: string,
  error: unknown,
): CronErrorDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  return { job, message, hint: cronErrorHint(message) };
}

/**
 * Formats a diagnostic as a single-line server log string (job + message, plus
 * the hint when present). Secret-safe: only the diagnostic's own fields are used.
 */
export function formatCronErrorLog(diag: CronErrorDiagnostic): string {
  const base = `[${diag.job}] failed: ${diag.message}`;
  return diag.hint ? `${base} | hint: ${diag.hint}` : base;
}
