/**
 * CLI: run the model for a single race and print whatever it returns.
 *
 * Usage:        npm run run:model -- <race_id>
 * Equivalent:   tsx scripts/runModel.ts <race_id>
 *
 * Loads credentials from `.env.local`. This uses the service-role client, which
 * BYPASSES RLS and WRITES to your database: it inserts a new model run and its
 * child rows, and deletes any older runs for the race.
 *
 * OWNERSHIP (Slice 4a): because this is an always-writing direct command, it
 * first resolves the race's meeting date (SELECT-only) and performs a READ-ONLY,
 * FAIL-CLOSED foreign-claim check. If a live producer owns that date — or
 * ownership cannot be verified — it REFUSES and exits non-zero WITHOUT running
 * the model. It never acquires, heartbeats, releases, or steals a claim.
 */

import { fileURLToPath } from 'node:url';

import { runModelForRace } from '../src/lib/runModelForRace';
import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import {
  assertDirectModelClaimClear,
  formatDirectModelRefusal,
  type DirectModelClaimDecision,
} from '../src/lib/directModelClaimCheck';

/** Read-only resolution of a race's meeting date. SELECT-only; null on any gap. */
export async function resolveRaceMeetingDate(
  raceId: string,
  client: { from: typeof supabaseAdmin.from } = supabaseAdmin,
): Promise<string | null> {
  const { data, error } = await client
    .from('races')
    .select('meeting_date')
    .eq('id', raceId)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const meetingDate = (data as { meeting_date?: string | null }).meeting_date;
  return meetingDate ? String(meetingDate).slice(0, 10) : null;
}

/** Injected side effects, so the CLI flow is unit-testable without I/O. */
export interface RunModelCliDeps {
  resolveMeetingDate: (raceId: string) => Promise<string | null>;
  assertClaimClear: (date: string) => Promise<DirectModelClaimDecision>;
  runModel: (raceId: string) => Promise<unknown>;
  log: (message: unknown) => void;
  errorLog: (message: string) => void;
}

/**
 * The pure CLI flow. Order is fixed and fail-closed:
 *   parse -> resolve meeting date -> foreign-claim check -> (only if allowed)
 *   run the model. Returns the process exit code; never calls process.exit.
 */
export async function runModelCli(argv: readonly string[], deps: RunModelCliDeps): Promise<number> {
  const raceId = argv[0];
  if (!raceId) {
    deps.errorLog('Usage: npm run run:model -- <race_id>');
    return 1;
  }

  // 1. Resolve the race's meeting date (SELECT-only). No model work yet.
  const meetingDate = await deps.resolveMeetingDate(raceId);
  if (!meetingDate) {
    deps.errorLog(
      `Refusing: could not resolve a meeting date for race ${raceId} ` +
        `(missing race, missing meeting_date, or lookup error). No model was run.`,
    );
    return 1;
  }

  // 2. Read-only, fail-closed foreign-claim check BEFORE any model work.
  const decision = await deps.assertClaimClear(meetingDate);
  if (!decision.allow) {
    deps.errorLog(formatDirectModelRefusal(meetingDate, decision));
    return 1;
  }

  // 3. Allowed: preserve the existing run:model behaviour exactly.
  const result = await deps.runModel(raceId);
  deps.log(result);
  return 0;
}

async function main(): Promise<void> {
  process.loadEnvFile('.env.local');
  const exitCode = await runModelCli(process.argv.slice(2), {
    resolveMeetingDate: (raceId) => resolveRaceMeetingDate(raceId),
    assertClaimClear: (date) => assertDirectModelClaimClear(date),
    runModel: (raceId) => runModelForRace(raceId),
    log: (message) => console.log(message),
    errorLog: (message) => console.error(message),
  });
  process.exit(exitCode);
}

// Run only when invoked directly (never when imported by a test).
const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
