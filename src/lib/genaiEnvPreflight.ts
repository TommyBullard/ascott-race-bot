/**
 * GenAI (OpenAI) environment preflight — PURE, presence-only, secret-safe.
 *
 * The future OpenAI-powered shadow commentary (docs/GENAI_SHADOW_COMMENTARY.md)
 * will read ONE optional key, OPENAI_API_KEY. This module reports its presence
 * for the developer preflight (scripts/checkEnv.ts) and gives GenAI tooling a
 * safe accessor that fails CLOSED when the key is missing.
 *
 * HARD SAFETY INVARIANTS (mirrored by scripts/genaiEnvPreflight.test.ts):
 *   - OPTIONAL. The app, racecards, odds, the model, staking, ranking, EV,
 *     recommendations and the no-bet logic NEVER need this key. `check:env`
 *     stays green without it and normal app operation is unaffected.
 *   - SHADOW-ONLY. The key is read ONLY when a GenAI command is explicitly run.
 *     GenAI is never model-active and never becomes betting logic.
 *   - SECRET-SAFE. Nothing here returns, copies into a report, or logs the
 *     secret VALUE. `summarizeGenAiEnv` deals only in the variable NAME plus a
 *     presence boolean, and the missing-key error message is value-free.
 *
 * It performs no I/O: callers pass the environment record in (the script passes
 * the process environment; tests pass a fake record), so the module is pure and
 * cannot leak credentials.
 */

import { isEnvValuePresent } from './envPreflight';

/** The single optional env var the GenAI shadow commentary will read. */
export const OPENAI_API_KEY_VAR = 'OPENAI_API_KEY';

/**
 * Operator-facing reassurance about the GenAI key's posture (NO value). Shared
 * by the CLI and the tests so the wording cannot drift.
 */
export const GENAI_SHADOW_NOTE =
  'OPENAI_API_KEY is optional and shadow-only: it is read only when you ' +
  'explicitly run a GenAI command, and is never used by the app, the model, ' +
  'staking, ranking, EV, recommendations or the no-bet logic.';

/** Presence verdict label for the GenAI key. */
export type GenAiKeyStatus = 'present' | 'missing';

/** Presence summary for the GenAI key — NAME + booleans only, never a value. */
export interface GenAiEnvStatus {
  /** Variable NAME only (never the value). */
  key: typeof OPENAI_API_KEY_VAR;
  present: boolean;
  status: GenAiKeyStatus;
  /** Always false — the app never needs the key to run. */
  requiredForApp: false;
  /** Always false — the key is not read unless a GenAI command is explicitly run. */
  usedByDefault: false;
  note: string;
}

/**
 * True when OPENAI_API_KEY is a non-empty string in `env`. Inspects the value
 * only to test emptiness; never returns, copies, or logs it.
 */
export function isOpenAiKeyPresent(
  env: Record<string, string | undefined>,
): boolean {
  return isEnvValuePresent(env[OPENAI_API_KEY_VAR]);
}

/**
 * Presence-only GenAI env summary for the preflight report. Reads `env` solely
 * to compute a presence boolean; it never copies or returns the secret value.
 */
export function summarizeGenAiEnv(
  env: Record<string, string | undefined>,
): GenAiEnvStatus {
  const present = isOpenAiKeyPresent(env);
  return {
    key: OPENAI_API_KEY_VAR,
    present,
    status: present ? 'present' : 'missing',
    requiredForApp: false,
    usedByDefault: false,
    note: GENAI_SHADOW_NOTE,
  };
}

/**
 * Thrown when a GenAI command runs without OPENAI_API_KEY. The message names the
 * variable and points at `.env.local`, but NEVER contains a secret value.
 */
export class GenAiKeyMissingError extends Error {
  constructor() {
    super(
      `${OPENAI_API_KEY_VAR} is not set. It is required ONLY to run the optional, ` +
        'shadow-only GenAI commentary tooling. Add it to .env.local (never commit ' +
        'it); the rest of the app runs without it.',
    );
    this.name = 'GenAiKeyMissingError';
  }
}

/**
 * Returns the configured OPENAI_API_KEY for a GenAI command that is EXPLICITLY
 * run, or throws `GenAiKeyMissingError` (a safe, value-free message) so GenAI
 * tooling FAILS CLOSED when the key is absent.
 *
 * The returned value must be used only to authenticate the GenAI request; it
 * MUST NEVER be logged, printed, or surfaced. This function performs no I/O and
 * no logging itself.
 */
export function requireOpenAiApiKey(
  env: Record<string, string | undefined>,
): string {
  const value = env[OPENAI_API_KEY_VAR];
  if (!isEnvValuePresent(value)) {
    throw new GenAiKeyMissingError();
  }
  return (value as string).trim();
}
