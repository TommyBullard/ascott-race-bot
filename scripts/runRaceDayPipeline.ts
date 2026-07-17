/**
 * Operator script: refresh racecards + odds and run the model for a whole race
 * day in ONE command, so you don't hand-call the cron endpoints or set
 * CRON_SECRET in the terminal.
 *
 * It loads `.env.local` (so CRON_SECRET / Supabase creds come from there), then:
 *   1. calls /api/cron/racecards (via `?day` — the Racing API only serves
 *      today/tomorrow racecards, so a date that is neither is SKIPPED here, not
 *      silently refreshed for the wrong day);
 *   2. calls /api/cron/odds?date=YYYY-MM-DD;
 *   3. runs the model for the selected date/course IN-PROCESS, reusing the same
 *      `runModelForRace` + shared `modelDayRun` helpers as `npm run model:day`.
 *
 *   - DRY-RUN BY DEFAULT: prints the URLs / operation it would run, writes nothing.
 *   - Writes only with `--commit`.
 *   - `--date YYYY-MM-DD` (required), `--course Ascot` (REQUIRED with --commit —
 *     the producer ownership claim needs a course scope; optional for dry runs),
 *     `--base-url http://localhost:3000` (optional; default shown).
 *   - SAFETY (commit mode): if the odds refresh fails, the model run is SKIPPED
 *     by default so it can't re-score against stale odds. Pass `--allow-stale`
 *     to run the model anyway. A failed racecards step alone does NOT skip the
 *     model (the cards may already be in the DB).
 *   - PRODUCER OWNERSHIP (Phase 7A.2b Step 2): commit mode claims the race date
 *     via `producer_run_claims` BEFORE any provider/model work (one claim + one
 *     generated owner id for this one-shot run, 60s heartbeat while it runs,
 *     released in a finally). FAIL-CLOSED: a refused claim / unavailable
 *     mechanism / confirmed loss means zero further provider/model work and a
 *     non-zero exit; it never waits for or reclaims ownership.
 *
 * Usage:
 *   npm run pipeline:day -- --date 2026-06-16 --course Ascot --dry-run
 *   npm run pipeline:day -- --date 2026-06-16 --course Ascot --commit
 *   npm run pipeline:day -- --date 2026-06-16 --course Ascot --commit --allow-stale
 *
 * REQUIRES (commit mode): a running dev server at --base-url, plus CRON_SECRET +
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env.local`. The CRON_SECRET value
 * is NEVER printed. This script does not place bets.
 */

import { runModelForRace } from '../src/lib/runModelForRace';
import {
  parsePipelineArgs,
  buildPipelineUrls,
  formatPipelineSummary,
} from '../src/lib/raceDayPipeline';
import {
  runPipelineCommitCycle,
  createCallCron,
  createFetchRaceRows,
  type PipelineRunnerDeps,
} from '../src/lib/raceDayPipelineRunner';
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
  const args = parsePipelineArgs(process.argv.slice(2));

  if (!args.date) {
    console.error(
      'Usage: npm run pipeline:day -- --date YYYY-MM-DD [--course <name>] ' +
        '[--base-url http://localhost:3000] [--commit] [--allow-stale]\n' +
        '(dry run by default; pass --commit to refresh racecards/odds and run models).',
    );
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

  console.log(
    `Race-day pipeline — ${args.commit ? 'COMMIT' : 'DRY RUN'} — ${scope}\n`,
  );

  // DRY RUN: print the plan, write nothing.
  if (!args.commit) {
    console.log('Would call:');
    console.log(
      `  racecards: ${racecardsUrl ?? `(skipped — ${args.date} is not today/tomorrow; Racing API only serves those)`}`,
    );
    console.log(`  odds:      ${oddsUrl}`);
    console.log(
      `  model:     run model in-process for ${scope} (reuses runModelForRace, like model:day)`,
    );
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

  // Acquire the date-level producer claim BEFORE any provider/model work.
  // FAIL-CLOSED: a refusal (someone else owns this date), an unavailable
  // mechanism, or unresolved uncertainty all exit here with ZERO provider calls.
  const ownership = await acquireProducerOwnership({
    raceDate: args.date,
    course: args.course,
    mode: 'pipeline-day',
  });
  if (!ownership.ok) {
    const { message, exitCode } = describeAcquireFailure(ownership);
    console.error(message);
    process.exitCode = exitCode;
    return;
  }
  const heartbeat = createHeartbeatController(ownership.state);
  heartbeat.start();

  try {
    // Run one pipeline cycle (racecards + odds + gated model run), reusing the
    // shared runner so this script and pipeline:watch behave identically. The
    // deps are wrapped so every provider HTTP call and every per-race model run
    // is gated on the ownership belief.
    const deps: PipelineRunnerDeps = guardPipelineDeps(
      {
        callCron: createCallCron(),
        fetchRaceRows: createFetchRaceRows(),
        runOneRace: runModelForRace,
      },
      ownership.state,
    );
    const result = await runPipelineCommitCycle(deps, {
      date: args.date,
      course: args.course,
      baseUrl: args.baseUrl,
      allowStale: args.allowStale,
      now,
    });

    console.log('\nSummary:');
    for (const line of formatPipelineSummary(result.summary, result.dashboardUrl)) console.log(line);

    if (result.racecards === 'failed' || result.odds === 'failed' || result.summary.failures > 0) {
      process.exitCode = 1;
    }
    // Ownership stopped mid-run: the guarded deps already blocked all further
    // provider/model work; report it and exit non-zero (overrides the generic 1).
    if (ownership.state.stopReason) {
      const { message, exitCode } = describeStopReason(ownership.state.stopReason);
      console.error(`\n${message}`);
      process.exitCode = exitCode;
    }
  } finally {
    await releaseProducerOwnership(ownership.state, heartbeat);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
