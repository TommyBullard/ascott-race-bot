/**
 * Operator script: keep the dashboard fresh by re-running the race-day pipeline
 * on a fixed interval during race day. Each cycle reuses the SAME shared cycle
 * as `npm run pipeline:day` (refresh racecards + odds, run the day's models),
 * so behaviour is identical — this just loops it.
 *
 *   - DRY-RUN BY DEFAULT: prints what it would run + the schedule, writes nothing.
 *   - Writes only with `--commit`.
 *   - `--date YYYY-MM-DD` (required), `--course Ascot` (optional),
 *     `--interval-minutes N` (default 5), `--until HH:MM` (optional local stop
 *     time), `--max-cycles N` (optional, for testing), `--allow-stale`
 *     (run the model even if an odds refresh fails), `--base-url` (default
 *     http://localhost:3000).
 *   - Stops on --until, after --max-cycles, or on Ctrl+C (clean).
 *
 * Usage:
 *   npm run pipeline:watch -- --date 2026-06-16 --course Ascot --interval-minutes 5 --dry-run
 *   npm run pipeline:watch -- --date 2026-06-16 --course Ascot --interval-minutes 1 --max-cycles 1 --commit
 *
 * REQUIRES (commit mode): a running dev server at --base-url, plus CRON_SECRET +
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env.local`. The CRON_SECRET value
 * is NEVER printed. This script does not place bets.
 */

import { runModelForRace } from '../src/lib/runModelForRace';
import { buildPipelineUrls } from '../src/lib/raceDayPipeline';
import {
  runPipelineCommitCycle,
  createCallCron,
  createFetchRaceRows,
  type PipelineRunnerDeps,
} from '../src/lib/raceDayPipelineRunner';
import {
  parseWatchArgs,
  parseUntilTime,
  shouldStopWatching,
  formatCycleSummary,
  type TimeOfDay,
} from '../src/lib/raceDayWatch';

/** Loads env from .env.local then .env (first found wins). */
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Try the next; fall back to the shell environment.
    }
  }
}

async function main(): Promise<void> {
  const args = parseWatchArgs(process.argv.slice(2));

  if (!args.date) {
    console.error(
      'Usage: npm run pipeline:watch -- --date YYYY-MM-DD [--course <name>] ' +
        '[--interval-minutes N] [--until HH:MM] [--max-cycles N] [--allow-stale] ' +
        '[--base-url http://localhost:3000] [--commit]\n' +
        '(dry run by default; pass --commit to actually refresh + run models on a loop).',
    );
    process.exitCode = 1;
    return;
  }

  // Validate the schedule flags up front (helpful messages; applies to dry-run too).
  if (args.intervalMinutes == null) {
    console.error('--interval-minutes must be a positive number (minutes between cycles).');
    process.exitCode = 1;
    return;
  }
  let until: TimeOfDay | null = null;
  if (args.until !== undefined) {
    until = parseUntilTime(args.until);
    if (!until) {
      console.error('--until must be a local time as HH:MM (00:00–23:59).');
      process.exitCode = 1;
      return;
    }
  }
  if (args.maxCycles === null) {
    console.error('--max-cycles must be a positive integer.');
    process.exitCode = 1;
    return;
  }

  loadEnv();

  const now = new Date();
  const { racecardsUrl, oddsUrl, dashboardUrl: dashUrl } = buildPipelineUrls(
    args.baseUrl,
    args.date,
    args.course,
    now,
  );
  const scope = `${args.date}${args.course ? ` course~"${args.course}"` : ''}`;
  const schedule =
    `every ${args.intervalMinutes} min` +
    (until ? `, until ${args.until} local` : '') +
    (args.maxCycles != null ? `, max ${args.maxCycles} cycle(s)` : '');

  console.log(
    `Race-day watch — ${args.commit ? 'COMMIT' : 'DRY RUN'} — ${scope} — ${schedule}\n`,
  );

  // DRY RUN: print the plan + schedule, write nothing.
  if (!args.commit) {
    console.log('Would repeatedly run the pipeline:');
    console.log(
      `  racecards: ${racecardsUrl ?? `(skipped — ${args.date} is not today/tomorrow; Racing API only serves those)`}`,
    );
    console.log(`  odds:      ${oddsUrl}`);
    console.log(
      `  model:     run model in-process for ${scope} (reuses runModelForRace, like pipeline:day)`,
    );
    console.log(`  interval:  ${args.intervalMinutes} min`);
    if (until) console.log(`  until:     ${args.until} (local)`);
    if (args.maxCycles != null) console.log(`  max-cycles: ${args.maxCycles}`);
    console.log(`  CRON_SECRET: ${process.env.CRON_SECRET ? 'set' : 'MISSING (required for --commit)'}`);
    console.log(`\nDashboard: ${dashUrl}`);
    console.log('\n(dry run) Nothing called or written. Re-run with --commit.');
    return;
  }

  // COMMIT: validate the secrets we need (helpful messages; never printed).
  if (!process.env.CRON_SECRET) {
    console.error(
      'Missing CRON_SECRET. Add it to .env.local (it must match the value the dev ' +
        'server loaded). It is required to authenticate the /api/cron/* calls.',
    );
    process.exitCode = 1;
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }

  const deps: PipelineRunnerDeps = {
    callCron: createCallCron(),
    fetchRaceRows: createFetchRaceRows(),
    runOneRace: runModelForRace,
  };

  // Clean Ctrl+C handling: first SIGINT stops after the current wait/cycle; a
  // second one forces an exit.
  let stopRequested = false;
  let cancelWait: (() => void) | null = null;
  let sigintCount = 0;
  const onSigint = (): void => {
    sigintCount += 1;
    stopRequested = true;
    if (cancelWait) cancelWait();
    if (sigintCount >= 2) {
      console.log('\nForce stop.');
      process.exit(130);
    }
    console.log('\nStopping after the current cycle… (press Ctrl+C again to force)');
  };
  process.on('SIGINT', onSigint);

  /** Interruptible sleep: resolves after `ms`, or early when Ctrl+C cancels it. */
  const wait = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cancelWait = null;
        resolve();
      }, ms);
      cancelWait = () => {
        clearTimeout(timer);
        cancelWait = null;
        resolve();
      };
    });

  const intervalMs = args.intervalMinutes * 60_000;
  let completed = 0;

  for (;;) {
    const stopBefore = shouldStopWatching(completed, args.maxCycles, until, new Date());
    if (stopBefore) {
      console.log(`\nStopping watch: ${stopBefore}.`);
      break;
    }
    if (stopRequested) {
      console.log('\nStopping watch: interrupted.');
      break;
    }

    const startedAt = new Date().toISOString();
    console.log(`\n=== Cycle ${completed + 1} — started ${startedAt} ===`);
    const result = await runPipelineCommitCycle(deps, {
      date: args.date,
      course: args.course,
      baseUrl: args.baseUrl,
      allowStale: args.allowStale,
      now: new Date(),
    });
    const completedAt = new Date().toISOString();
    completed += 1;

    console.log('');
    for (const line of formatCycleSummary({
      cycle: completed,
      startedAt,
      completedAt,
      summary: result.summary,
      dashboardUrl: result.dashboardUrl,
    })) {
      console.log(line);
    }

    const stopAfter = shouldStopWatching(completed, args.maxCycles, until, new Date());
    if (stopAfter) {
      console.log(`\nStopping watch: ${stopAfter}.`);
      break;
    }
    if (stopRequested) {
      console.log('\nStopping watch: interrupted.');
      break;
    }

    console.log(`\nNext cycle in ${args.intervalMinutes} min… (Ctrl+C to stop)`);
    await wait(intervalMs);
    if (stopRequested) {
      console.log('\nStopping watch: interrupted.');
      break;
    }
  }

  process.removeListener('SIGINT', onSigint);
  console.log(`\nWatch finished after ${completed} cycle(s).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
