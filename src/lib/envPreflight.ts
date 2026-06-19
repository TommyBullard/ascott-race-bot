/**
 * Pure env-var PRESENCE summary for the developer preflight diagnostic
 * (scripts/checkEnv.ts).
 *
 * SECURITY: this module deals only in variable NAMES and booleans. It never
 * reads a secret VALUE into its output, never returns a value, and never logs.
 * `isEnvValuePresent` inspects a value solely to decide "non-empty?" and returns
 * a boolean — the value itself is never copied, transformed, or surfaced. Safe
 * to run in any environment; it cannot leak credentials.
 *
 * It is consumed by a thin, read-only script that prints which required/optional
 * variables are set, so an operator can spot a missing `.env.local` entry
 * without exposing any secret.
 */

/** A single environment variable the app may use. */
export interface EnvVarSpec {
  /** The variable name, e.g. 'SUPABASE_URL'. */
  name: string;
  /** Logical group for display, e.g. 'Supabase', 'Racing API', 'Betfair'. */
  group: string;
  /** Whether a core pipeline cannot run without it. */
  required: boolean;
  /** Short, non-secret note about what needs it (no values). */
  note?: string;
}

/** Presence verdict for one variable — NO value, only a boolean. */
export interface EnvPresenceResult {
  name: string;
  group: string;
  required: boolean;
  note?: string;
  present: boolean;
}

/** Aggregate presence summary across a set of specs. */
export interface EnvPreflightSummary {
  results: EnvPresenceResult[];
  /** Names of required vars that are missing/blank (names only). */
  missingRequired: string[];
  /** Names of optional vars that are missing/blank (names only). */
  missingOptional: string[];
  presentCount: number;
  /** True when every required var is present. */
  ok: boolean;
}

/**
 * True when an env value is a non-empty string (after trimming). Inspects the
 * value only to test emptiness; never returns or logs it.
 */
export function isEnvValuePresent(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The environment variables this app reads, grouped for the preflight report.
 * `required` marks the core racecards / results / model pipeline; Betfair is
 * optional (only the odds pipeline needs it), `CRON_SECRET` is optional (gates
 * cron/ops endpoints when set, open locally when unset), and `OPENAI_API_KEY` is
 * optional + shadow-only (read only when a GenAI command is explicitly run —
 * never by the app, model, staking, or recommendations).
 */
export const ENV_VAR_SPECS: readonly EnvVarSpec[] = [
  { name: 'SUPABASE_URL', group: 'Supabase', required: true },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', group: 'Supabase', required: true },
  { name: 'RACING_API_USER', group: 'Racing API', required: true },
  { name: 'RACING_API_KEY', group: 'Racing API', required: true },
  {
    name: 'CRON_SECRET',
    group: 'Auth',
    required: false,
    note: 'gates /api/cron/* + POST /api/run-model when set; open locally when unset',
  },
  { name: 'BETFAIR_APP_KEY', group: 'Betfair', required: false, note: 'odds pipeline only' },
  { name: 'BETFAIR_USERNAME', group: 'Betfair', required: false, note: 'odds pipeline only' },
  { name: 'BETFAIR_PASSWORD', group: 'Betfair', required: false, note: 'odds pipeline only' },
  { name: 'BETFAIR_CERT_PEM', group: 'Betfair', required: false, note: 'odds pipeline only' },
  { name: 'BETFAIR_KEY_PEM', group: 'Betfair', required: false, note: 'odds pipeline only' },
  {
    // Optional + shadow-only: read ONLY when a GenAI command is explicitly run,
    // never by the app/model/staking/recommendations. See src/lib/genaiEnvPreflight.ts.
    name: 'OPENAI_API_KEY',
    group: 'GenAI',
    required: false,
    note: 'optional, shadow-only commentary; read only when a GenAI command is explicitly run',
  },
];

/**
 * Summarises which variables in `specs` are present in `env`. Pure: it reads
 * `env` only to compute presence booleans, never copying or returning a value.
 * `env` defaults are provided by the caller (the script passes `process.env`;
 * tests pass a fake record), so this function performs no I/O itself.
 */
export function summarizeEnvPresence(
  env: Record<string, string | undefined>,
  specs: readonly EnvVarSpec[] = ENV_VAR_SPECS,
): EnvPreflightSummary {
  const results: EnvPresenceResult[] = specs.map((spec) => ({
    name: spec.name,
    group: spec.group,
    required: spec.required,
    note: spec.note,
    present: isEnvValuePresent(env[spec.name]),
  }));

  const missingRequired = results
    .filter((r) => r.required && !r.present)
    .map((r) => r.name);
  const missingOptional = results
    .filter((r) => !r.required && !r.present)
    .map((r) => r.name);
  const presentCount = results.filter((r) => r.present).length;

  return {
    results,
    missingRequired,
    missingOptional,
    presentCount,
    ok: missingRequired.length === 0,
  };
}
