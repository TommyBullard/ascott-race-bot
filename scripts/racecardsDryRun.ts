/**
 * CLI (DRY RUN ONLY): preview what Programme 0 racecard capture would store.
 *
 * Usage:
 *   npm run racecards:dry-run -- --day tomorrow [--json]
 *   npm run racecards:dry-run -- --day today    [--json]
 *
 * WHAT THIS COMMAND DOES: exactly one racecards fetch through the SAME
 * {@link RacingApiClient} real ingestion uses, the SAME `raceSync` mappers, and
 * SELECT-only database reads used purely to tell a planned insert apart from a
 * row that already exists. It then prints aggregate counts.
 *
 * WHAT IT NEVER DOES: there is NO `--commit` flag and no write path anywhere in
 * this feature. It never inserts, updates, upserts or deletes any row; never
 * calls an rpc or storage; never writes `cron_runs` or any other log table;
 * never acquires, renews, releases or steals a producer claim; never invokes an
 * API route; never calls the odds, results or tipster endpoints; never runs the
 * model, creates a locked decision, or settles a result. It writes no file.
 *
 * ARGUMENTS: `--day today|tomorrow` is REQUIRED. An arbitrary calendar date is
 * rejected rather than coerced, because The Racing API serves racecards for
 * today and tomorrow only — accepting `--date 2026-09-01` would promise a scope
 * the provider cannot deliver.
 *
 * EXIT CODES: 0 preview complete and the date is suitable for a first-capture
 * test; 3 preview complete but NOT SUITABLE (the date already holds races, or a
 * mapped race is destined for another date); 1 invalid arguments or missing
 * configuration; 2 provider or database failure.
 *
 * Credentials load from .env.local / .env and are NEVER printed — only their
 * presence is checked, and provider identifiers never reach the output.
 *
 * FAILURE OUTPUT IS REDACTED. A raw error is never printed: a Racing API
 * failure appends up to 300 characters of provider-controlled response body,
 * and a PostgREST failure carries request detail. Every printed fragment goes
 * through `redactPreviewDetail` (credentials, tokens, URLs, JWT-shaped values,
 * provider handles, hard length cap), and operational context comes from the
 * failure STAGE rather than from that fragment. No stack is ever printed.
 *
 * Decision-support only — not betting advice, and nothing here places a bet.
 */

import { fileURLToPath } from 'node:url';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { createRacingApiClient, resolveRacecardsTier } from '../src/lib/racingApi';
import {
  isPreviewDay,
  redactPreviewDetail,
  renderPreviewFailure,
  renderRacecardsDryRunConsole,
  runRacecardsDryRun,
  type ExistingProviderRaceRow,
  type ExistingRaceRow,
  type ExistingRunnerRow,
  type PreviewDay,
  type RacecardsDryRunReadSeam,
} from '../src/lib/racecardsDryRun';

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

export interface RacecardsDryRunArgs {
  day: PreviewDay | null;
  json: boolean;
  /** Set when an argument was present but invalid, so usage can be explicit. */
  error: string | null;
}

/**
 * Pure argument parsing. No day is defaulted: a preview of "today" that the
 * operator did not ask for is exactly the kind of implicit scope this programme
 * avoids. `--commit` and any unknown flag are hard errors, never ignored.
 */
export function parseRacecardsDryRunArgs(argv: readonly string[]): RacecardsDryRunArgs {
  const out: RacecardsDryRunArgs = { day: null, json: false, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--day') {
      const value = argv[i + 1] ?? '';
      i += 1;
      if (!isPreviewDay(value)) {
        out.error =
          `invalid --day "${value}" (expected exactly "today" or "tomorrow"; ` +
          'The Racing API serves racecards for those two days only)';
        continue;
      }
      out.day = value;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--commit') {
      out.error = 'this command is a DRY RUN and has no --commit flag';
    } else if (arg.startsWith('--')) {
      out.error = `unknown flag ${arg}`;
    } else {
      out.error = `unexpected argument "${arg}"`;
    }
  }
  return out;
}

/** Supabase `.in()` batch size, so a very large day cannot build an unbounded URL. */
const READ_CHUNK = 200;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The live SELECT-only seam.
 *
 * Every method issues a `select` and nothing else — there is no insert, update,
 * upsert, delete, rpc or storage call in this object, and the interface it
 * implements declares no method that could carry one. A read error is thrown so
 * the CLI exits non-zero; it is never degraded into a zero count, which would
 * misreport an unreadable database as an empty one.
 *
 * The PostgREST error is REDACTED before the Error is constructed, not merely
 * before printing. A raw driver message must not be able to travel inside an
 * Error object to some other caller that prints it less carefully.
 */
export const supabaseRacecardsReadSeam: RacecardsDryRunReadSeam = {
  async countRacesForDate(date: string): Promise<number> {
    const { count, error } = await supabaseAdmin
      .from('races')
      .select('*', { count: 'exact', head: true })
      .eq('meeting_date', date);
    if (error) throw new Error(`races count failed: ${redactPreviewDetail(error)}`);
    if (typeof count !== 'number') throw new Error('races count returned no value');
    return count;
  },

  async findRacesByProviderIds(
    providerRaceIds: readonly string[],
  ): Promise<ExistingProviderRaceRow[]> {
    const rows: ExistingProviderRaceRow[] = [];
    for (const batch of chunk(providerRaceIds, READ_CHUNK)) {
      const { data, error } = await supabaseAdmin
        .from('races')
        .select('id, provider_race_id')
        .in('provider_race_id', batch);
      // The filter values ARE provider ids, so the driver message is redacted
      // before it can carry one into an Error.
      if (error) throw new Error(`races provider-id lookup failed: ${redactPreviewDetail(error)}`);
      for (const row of (data ?? []) as {
        id: string | number;
        provider_race_id: string | null;
      }[]) {
        rows.push({ id: String(row.id), provider_race_id: row.provider_race_id ?? null });
      }
    }
    return rows;
  },

  async findRacesByOffTimes(offTimes: readonly string[]): Promise<ExistingRaceRow[]> {
    const rows: ExistingRaceRow[] = [];
    for (const batch of chunk(offTimes, READ_CHUNK)) {
      const { data, error } = await supabaseAdmin
        .from('races')
        .select('id, course, off_time')
        .in('off_time', batch);
      if (error) throw new Error(`races lookup failed: ${redactPreviewDetail(error)}`);
      for (const row of (data ?? []) as {
        id: string | number;
        course: string | null;
        off_time: string | null;
      }[]) {
        rows.push({ id: String(row.id), course: row.course ?? null, off_time: row.off_time ?? null });
      }
    }
    return rows;
  },

  async findRunnersForRaces(raceIds: readonly string[]): Promise<ExistingRunnerRow[]> {
    const rows: ExistingRunnerRow[] = [];
    for (const batch of chunk(raceIds, READ_CHUNK)) {
      const { data, error } = await supabaseAdmin
        .from('runners')
        .select('race_id, horse_name')
        .in('race_id', batch);
      if (error) throw new Error(`runners lookup failed: ${redactPreviewDetail(error)}`);
      for (const row of (data ?? []) as {
        race_id: string | number;
        horse_name: string | null;
      }[]) {
        rows.push({ race_id: String(row.race_id), horse_name: row.horse_name ?? null });
      }
    }
    return rows;
  },
};

const USAGE =
  'Usage: npm run racecards:dry-run -- --day today|tomorrow [--json]\n' +
  '(DRY RUN ONLY. There is no --commit flag: this command performs one racecards fetch,\n' +
  'runs the real mappers, reads the database SELECT-only, and writes nothing anywhere.\n' +
  'An arbitrary --date is not supported because the provider serves today/tomorrow only.)';

async function main(): Promise<void> {
  loadEnv();

  // Argument validation happens BEFORE any client is built, so an invalid
  // invocation reaches neither the provider nor the database.
  const args = parseRacecardsDryRunArgs(process.argv.slice(2));
  if (args.error || !args.day) {
    console.error(args.error ? `Error: ${args.error}\n\n${USAGE}` : USAGE);
    process.exitCode = 1;
    return;
  }

  // Presence only — no value is read into a variable or printed.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }
  if (!process.env.RACING_API_USER || !process.env.RACING_API_KEY) {
    console.error('Missing RACING_API_USER / RACING_API_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }

  const report = await runRacecardsDryRun(args.day, {
    client: createRacingApiClient(),
    reads: supabaseRacecardsReadSeam,
    tier: resolveRacecardsTier(process.env.RACING_API_RACECARDS_TIER),
    now: new Date(),
  });

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else for (const line of renderRacecardsDryRunConsole(report)) console.log(line);

  // A completed preview of an unsuitable date is not a failure, but it is not
  // evidence for the first-capture test either — surfaced as REVIEW (3),
  // matching the exit-code convention used by the other operator commands.
  // "Unsuitable" now covers both an already-populated selected date and any
  // mapped race destined for a different (or unusable) meeting date.
  if (!report.first_capture_suitable) process.exitCode = 3;
}

// Only run when this file is the invoked entrypoint, never merely when imported
// (the test file imports `parseRacecardsDryRunArgs` and the seam shape).
const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  // The raw value is never printed, never stringified into the output and never
  // rethrown: `renderPreviewFailure` emits a stage plus a redacted, truncated
  // detail. No stack, no error object, no response body.
  main().catch((err: unknown) => {
    for (const line of renderPreviewFailure(err)) console.error(line);
    process.exitCode = 2;
  });
}
