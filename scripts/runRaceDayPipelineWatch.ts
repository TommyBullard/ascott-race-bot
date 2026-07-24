/**
 * Operator script: keep the dashboard fresh by re-running the race-day pipeline
 * on a fixed interval during race day. Each cycle reuses the SAME shared cycle
 * as `npm run pipeline:day` (refresh racecards + odds, run the day's models),
 * so behaviour is identical — this just loops it.
 *
 *   - DRY-RUN BY DEFAULT: prints what it would run + the schedule, writes nothing.
 *   - Writes only with `--commit`.
 *   - `--date YYYY-MM-DD` (required), `--course Ascot` (REQUIRED with --commit —
 *     the producer ownership claim needs a course scope; optional for dry runs),
 *     `--interval-minutes N` (default 5), `--until HH:MM` (optional local stop
 *     time), `--max-cycles N` (optional, for testing), `--allow-stale`
 *     (run the model even if an odds refresh fails), `--base-url` (default
 *     http://localhost:3000).
 *   - Stops on --until, after --max-cycles, or on Ctrl+C (clean).
 *
 * PRODUCER OWNERSHIP (Phase 7A.2b Step 2): in commit mode this process claims
 * the race date via `producer_run_claims` BEFORE any provider/model work — one
 * claim + one generated owner id for the whole process, renewed by a 60s
 * heartbeat (held through the inter-cycle waits, never released between
 * cycles), verified (owner + generation) before every cycle and before every
 * provider call / per-race model run, released on graceful shutdown. FAIL-
 * CLOSED: a refused claim, an unavailable claim mechanism, or confirmed
 * ownership loss stops this process with zero further provider/model work —
 * it NEVER reclaims mid-run. Crash recovery is by TTL expiry (240s).
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
import {
  COURSE_REQUIRED_MESSAGE,
  acquireProducerOwnership,
  createHeartbeatController,
  describeAcquireFailure,
  describeStopReason,
  guardPipelineDeps,
  releaseProducerOwnership,
} from '../src/lib/producerOwnership';

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

  // Producer ownership (Phase 7A.2b Step 2): commit mode requires a course —
  // the day-level claim needs a course scope, and nationwide scope is not
  // permitted in the production pipeline.
  if (!args.course) {
    console.error(COURSE_REQUIRED_MESSAGE);
    process.exitCode = 1;
    return;
  }

  // Acquire the date-level producer claim ONCE for the whole watch process,
  // BEFORE the loop and before any provider/model work. FAIL-CLOSED: a
  // refusal / unavailable mechanism / unresolved uncertainty exits here with
  // ZERO provider calls (the .bat restart loop will retry ~every 60s and keep
  // being refused while another producer legitimately owns the date).
  const ownership = await acquireProducerOwnership({
    raceDate: args.date,
    course: args.course,
    mode: 'pipeline-watch',
  });
  if (!ownership.ok) {
    const { message, exitCode } = describeAcquireFailure(ownership);
    console.error(message);
    process.exitCode = exitCode;
    return;
  }
  // One owner id + one claim for the process lifetime; the 60s heartbeat keeps
  // it alive through every cycle AND the inter-cycle waits (never released
  // between cycles). Started only after ownership is proven.
  const heartbeat = createHeartbeatController(ownership.state);
  heartbeat.start();

  const deps: PipelineRunnerDeps = guardPipelineDeps(
    {
      callCron: createCallCron(),
      fetchRaceRows: createFetchRaceRows(),
      runOneRace: runModelForRace,
    },
    ownership.state,
  );

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

  try {
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

      // Ownership reverify before every cycle: the first cycle relies on the
      // just-completed acquire; each later cycle gets an awaited, DB-confirmed
      // heartbeat (owner + generation) before any stage may start. Confirmed
      // loss / uncertainty / unavailable mechanism → stop the whole process
      // (never reclaim mid-run; the .bat restart applies the refusal path).
      if (completed > 0) await heartbeat.beatNow();
      if (ownership.state.stopReason) {
        const { message, exitCode } = describeStopReason(ownership.state.stopReason);
        console.error(`\n${message}`);
        process.exitCode = exitCode;
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

      // Ownership stopped mid-cycle: the guarded deps already blocked every
      // further provider call / model write inside the cycle; stop the process.
      if (ownership.state.stopReason) {
        const { message, exitCode } = describeStopReason(ownership.state.stopReason);
        console.error(`\n${message}`);
        process.exitCode = exitCode;
        break;
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
      // The claim is deliberately NOT released here — it is held (and renewed
      // by the 60s heartbeat) through the wait so no other producer can slip
      // in between cycles.
      await wait(intervalMs);
      if (stopRequested) {
        console.log('\nStopping watch: interrupted.');
        break;
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    // Graceful shutdown: stop the heartbeat FIRST, then owner-scoped release.
    // A failed release is logged and left to TTL expiry (never restarts work).
    await releaseProducerOwnership(ownership.state, heartbeat);
  }
  console.log(`\nWatch finished after ${completed} cycle(s).`);
  // Structured, greppable terminal marker: the watch loop stopped AND the
  // shutdown path (heartbeat stop + owner-scoped release) completed without an
  // error exit code being set. Emitted ONLY on a clean stop (Ctrl+C / --until /
  // --max-cycles); an ownership-loss or mechanism stop sets process.exitCode
  // first and is therefore never labelled graceful here.
  //
  // WHY: on Windows a single console Ctrl+C makes npm/cmd.exe report a non-zero
  // exit (observed: 1) even when this process shut down cleanly and released its
  // claim. The wrapper helper (race-day-local/run-pipeline-watch.js) uses THIS
  // marker — plus the absence of PRODUCER_CLAIM_RELEASE_FAILED and the fact that
  // only ONE interrupt was seen — as the evidence to normalise that shell exit
  // code to an effective 0. See docs/LOCAL_RACE_DAY_SUPERVISOR.md.
  if (!process.exitCode) {
    console.log('WATCH_STOPPED_GRACEFULLY');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
