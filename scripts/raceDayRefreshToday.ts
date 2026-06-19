/**
 * `race-day:refresh-today` — date-safe, ONE-SHOT pipeline refresh for Railway.
 *
 * Resolves today's race-day meeting date (UTC) and runs the EXISTING
 * `pipeline:day` command for that date + course exactly once, then exits. This
 * removes the daily, hand-edited `--date` from the operator's workflow so a
 * Railway cron job can simply run `npm run race-day:refresh-today -- --course Ascot`
 * on a schedule.
 *
 *   - ONE-SHOT: it spawns a single command and returns. No loop, no timer —
 *     Railway does the scheduling.
 *   - COMMIT by default (this is a backend refresh job); pass `--dry-run` to
 *     preview the resolved date + command and spawn nothing.
 *   - It changes NO model, staking, or recommendation logic; it only orchestrates
 *     the already-tested pipeline. It never places bets and never auto-bets.
 *
 * Usage:
 *   npm run race-day:refresh-today -- --course Ascot
 *   npm run race-day:refresh-today -- --course Ascot --dry-run
 *   npm run race-day:refresh-today -- --course Ascot --base-url https://your-app.up.railway.app
 *
 * REQUIRES (commit mode): the deployed web service reachable at the base URL,
 * plus CRON_SECRET + SUPABASE creds in the environment. The CRON_SECRET value is
 * never printed.
 */

import { spawnSync } from 'node:child_process';
import { quoteSpawnArg } from '../src/lib/raceDayAutopilot';
import { dashboardUrl } from '../src/lib/raceDayPipeline';
import {
  parseRefreshTodayArgs,
  resolveRaceDayToday,
  buildRefreshTodayCommandArgs,
  runRefreshOnce,
  DEFAULT_BASE_URL,
} from '../src/lib/railwayCronPlan';

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

function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function main(): void {
  const parsed = parseRefreshTodayArgs(process.argv.slice(2));
  loadEnv();

  // Base URL precedence: explicit --base-url > PIPELINE_BASE_URL env > default.
  const baseUrl =
    parsed.baseUrl !== DEFAULT_BASE_URL
      ? parsed.baseUrl
      : (process.env.PIPELINE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  const now = new Date();
  const date = resolveRaceDayToday(now);

  console.log(`race-day:refresh-today \u2014 resolved meeting date ${date} (UTC), course ${parsed.course}`);
  console.log(`  mode      : ${parsed.dryRun ? 'DRY RUN (spawns nothing)' : 'COMMIT (refreshes today\u2019s card)'}`);
  console.log(`  base-url  : ${baseUrl}`);
  console.log(`  dashboard : ${dashboardUrl(baseUrl, date, parsed.course)}`);
  console.log(
    '  safety    : decision-support only \u2014 never places bets, never auto-bets; ' +
      'model/staking/recommendation logic unchanged.\n',
  );

  if (parsed.dryRun) {
    const args = buildRefreshTodayCommandArgs({ date, course: parsed.course, baseUrl, commit: true });
    console.log(`(dry run) Would run: npm run pipeline:day -- ${args.join(' ')}`);
    console.log('(dry run) Nothing spawned, nothing written. Re-run without --dry-run to refresh.');
    return;
  }

  const result = runRefreshOnce({
    now,
    course: parsed.course,
    baseUrl,
    commit: parsed.commit,
    spawn: (script, npmArgs) => {
      const spawnArgs = ['run', script, '--', ...npmArgs].map(quoteSpawnArg);
      const r = spawnSync(npmExecutable(), spawnArgs, { stdio: 'inherit', shell: true });
      return { status: typeof r.status === 'number' ? r.status : null, error: r.error };
    },
  });

  console.log(
    `\nrace-day:refresh-today complete \u2014 pipeline exit ${result.exitCode ?? 'unknown'} ` +
      `(ran ${result.ranCount} command, then exit).`,
  );
  if (!result.ok) {
    process.exitCode = result.exitCode && result.exitCode !== 0 ? result.exitCode : 1;
  }
}

main();
