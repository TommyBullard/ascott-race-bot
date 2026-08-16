/**
 * CLI: ownership-aware, racecards-ONLY commit runner.
 *
 * Usage:
 *   npm run racecards:commit -- --day tomorrow --commit --confirm-racecards-only --base-url <url>
 *
 * WHAT THIS COMMAND DOES: performs a FRESH SELECT-only suitability count,
 * acquires the date-level producer claim through the established mechanism, and
 * invokes `/api/cron/racecards?day=<today|tomorrow>` EXACTLY ONCE with a real
 * ownership context, then releases the claim. That is all.
 *
 * WHAT IT NEVER DOES: it invokes no odds, model, run-model, results, settle,
 * training-capture, tipster, ML, lock or recommendation route — the library
 * exposes one URL builder and it can only produce the racecards path. It writes
 * no application table directly; the only rows it can cause are those the
 * racecards route itself writes (races, runners, cron_runs), plus its own claim
 * row through the existing claim abstraction. It never retries. It never
 * proceeds to a second stage. It writes no file.
 *
 * TWO INDEPENDENT SAFETY LATCHES: `--commit` AND `--confirm-racecards-only`.
 * Both are required, neither is defaulted, and there is no interactive prompt
 * (every operator command in this repository is non-interactive by design, so a
 * typed phrase would be unusable in the contexts these commands run in).
 *
 * EXIT CODES: 0 committed · 1 usage/configuration · 2 mechanism unavailable,
 * uncertain or unclassified · 3 stopped safely before any write (date no longer
 * suitable, or ownership refused/not held) · 4 route invoked and failed ·
 * 5 AMBIGUOUS — the request may have been accepted; verify before re-running.
 *
 * Credentials load from .env.local / .env and are NEVER printed — only their
 * presence is checked. Failure detail is redacted through the same helper the
 * dry-run uses; no raw error, stack, cause, response body or URL with
 * credentials can reach the output.
 *
 * Decision-support only — this ingests racecards; it places no bet, runs no
 * model, and creates no recommendation.
 */

import { fileURLToPath } from 'node:url';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { createCallCron } from '../src/lib/raceDayPipelineRunner';
import { defaultProducerOwnershipDeps } from '../src/lib/producerOwnership';
import { validateBaseUrl } from '../src/lib/producerPreflight';
import { redactPreviewDetail } from '../src/lib/racecardsDryRun';
import {
  COMMIT_EXIT,
  commitExitCode,
  isCommitDay,
  renderCommitOutcome,
  renderCommitScope,
  resolveCommitDate,
  runRacecardsCommit,
  type CommitDay,
  type RacecardsCommitReadSeam,
} from '../src/lib/racecardsCommitRunner';

function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Not present; try the next, then fall back to shell env.
    }
  }
}

export interface RacecardsCommitArgs {
  day: CommitDay | null;
  commit: boolean;
  confirmRacecardsOnly: boolean;
  baseUrl: string | null;
  error: string | null;
}

/**
 * Pure argument parsing. Nothing is defaulted — not the day, not the commit
 * latch, not the confirmation latch, not the base URL. A repeated flag with a
 * conflicting value is a hard error rather than last-one-wins, because silently
 * preferring one of two contradictory scopes is precisely the failure this
 * command must not have.
 */
export function parseRacecardsCommitArgs(argv: readonly string[]): RacecardsCommitArgs {
  const out: RacecardsCommitArgs = {
    day: null,
    commit: false,
    confirmRacecardsOnly: false,
    baseUrl: null,
    error: null,
  };
  const fail = (message: string): void => {
    if (out.error === null) out.error = message;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--day') {
      const value = argv[i + 1] ?? '';
      i += 1;
      if (!isCommitDay(value)) {
        fail(
          `invalid --day "${value}" (expected exactly "today" or "tomorrow"; ` +
            'The Racing API serves racecards for those two days only)',
        );
        continue;
      }
      if (out.day !== null && out.day !== value) {
        fail('--day was given twice with conflicting values');
        continue;
      }
      out.day = value;
    } else if (arg === '--base-url') {
      const value = argv[i + 1] ?? '';
      i += 1;
      const validation = validateBaseUrl(value);
      if (!validation.valid || validation.origin === null) {
        fail(`invalid --base-url: ${validation.reason ?? 'not usable'}`);
        continue;
      }
      if (out.baseUrl !== null && out.baseUrl !== validation.origin) {
        fail('--base-url was given twice with conflicting values');
        continue;
      }
      out.baseUrl = validation.origin;
    } else if (arg === '--commit') {
      out.commit = true;
    } else if (arg === '--confirm-racecards-only') {
      out.confirmRacecardsOnly = true;
    } else if (arg === '--dry-run') {
      fail('--dry-run is not supported here; use `npm run racecards:dry-run` for the preview');
    } else if (arg.startsWith('--')) {
      fail(`unknown flag ${arg}`);
    } else {
      fail(`unexpected argument "${arg}"`);
    }
  }
  return out;
}

/**
 * The live SELECT-only read seam: ONE count, and nothing else.
 *
 * Deliberately narrower than the dry-run's three-method seam — this command
 * needs a single fact, so the interface it implements declares a single read
 * method and no mutation can be expressed through it at all. A read error is
 * thrown so the runner stops before any claim; it is never degraded to a zero,
 * which would misreport an unreadable database as an empty date and let a write
 * proceed on a false premise.
 */
export const supabaseCommitReadSeam: RacecardsCommitReadSeam = {
  async countRacesForDate(date: string): Promise<number> {
    const { count, error } = await supabaseAdmin
      .from('races')
      .select('*', { count: 'exact', head: true })
      .eq('meeting_date', date);
    if (error) throw new Error(`races count failed: ${redactPreviewDetail(error)}`);
    if (typeof count !== 'number') throw new Error('races count returned no value');
    return count;
  },
};

const USAGE =
  'Usage: npm run racecards:commit -- --day today|tomorrow --commit --confirm-racecards-only --base-url <url>\n' +
  '\n' +
  'THIS COMMAND WRITES. It invokes /api/cron/racecards exactly once with a real producer-ownership\n' +
  'context, which may create races, runners and cron_runs rows. It runs no odds, model, lock,\n' +
  'result, settlement or training-capture stage, and it never retries.\n' +
  '\n' +
  'Both --commit AND --confirm-racecards-only are required; neither is defaulted.\n' +
  'An arbitrary --date is not supported because the provider serves today/tomorrow only.\n' +
  'Preview first with: npm run racecards:dry-run -- --day today|tomorrow';

async function main(): Promise<void> {
  loadEnv();

  // Argument validation happens BEFORE any client, claim or route, so an
  // invalid invocation reaches no provider, no database and no server.
  const args = parseRacecardsCommitArgs(process.argv.slice(2));
  const missing: string[] = [];
  if (!args.day) missing.push('--day today|tomorrow');
  if (!args.commit) missing.push('--commit');
  if (!args.confirmRacecardsOnly) missing.push('--confirm-racecards-only');
  if (!args.baseUrl) missing.push('--base-url <url>');

  if (args.error || missing.length > 0) {
    const reason = args.error ?? `missing required argument(s): ${missing.join(', ')}`;
    console.error(`Error: ${reason}\n\n${USAGE}`);
    process.exitCode = COMMIT_EXIT.usage;
    return;
  }
  const day = args.day as CommitDay;
  const origin = args.baseUrl as string;

  // Presence only — no value is read into a variable or printed.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = COMMIT_EXIT.usage;
    return;
  }
  if (!process.env.CRON_SECRET) {
    console.error('Missing CRON_SECRET in .env.local (or .env) — required to authenticate the racecards route.');
    process.exitCode = COMMIT_EXIT.usage;
    return;
  }

  const now = new Date();
  for (const line of renderCommitScope({ day, date: resolveCommitDate(day, now), origin })) {
    console.log(line);
  }

  const outcome = await runRacecardsCommit(day, origin, {
    reads: supabaseCommitReadSeam,
    ownership: defaultProducerOwnershipDeps(),
    // The REAL helper: it attaches the CRON_SECRET bearer and builds the
    // x-producer-ownership header from live state. Neither is hand-crafted here.
    makeCallCron: (getSource) => createCallCron(getSource),
    now,
    log: (line) => console.log(line),
  });

  for (const line of renderCommitOutcome(outcome)) console.log(line);
  process.exitCode = commitExitCode(outcome);
}

// Only run when this file is the invoked entrypoint, never merely when imported
// (the test file imports the parser and the seam shape).
const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  // The raw value is never printed: only a stage-free, redacted, truncated
  // fragment. No stack, no error object, no response body.
  main().catch((err: unknown) => {
    console.error('RACECARDS COMMIT FAILED (unclassified)');
    console.error(`  Detail : ${redactPreviewDetail(err)}`);
    console.error('  Treat the outcome as unverified and confirm with SELECT-only queries.');
    process.exitCode = COMMIT_EXIT.mechanism;
  });
}
