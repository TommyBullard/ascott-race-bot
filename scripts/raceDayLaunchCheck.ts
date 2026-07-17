/**
 * CLI: race-day launch check — Nationwide rebuild Phase 7A.2b Step 4.
 *
 * The read-only validation front-door for the Windows launcher
 * (race-day-local/start-race-day.bat): strict date, Windows-safe SELECTED
 * course (reserved nationwide input rejected in every spelling), validated
 * local base URL, and the optional DISTINCT `PUBLIC_DASHBOARD_URL`
 * configuration for the public dashboard link (never guessed from
 * PIPELINE_BASE_URL, never a hardcoded host).
 *
 * OUTPUT CONTRACT (consumed by the batch): on success, stdout carries ONLY
 * KEY=VALUE lines —
 *   SLUG=<log-folder slug>
 *   LOCAL_URL=<scoped local dashboard URL>
 *   PROD_URL=<scoped public dashboard URL | not-configured>
 * — and the exit code is 0. On any invalid input the reason goes to stderr and
 * the exit code is 1 (the launcher then starts NOTHING).
 *
 * READ-ONLY BY CONSTRUCTION: no filesystem writes, no database access, no
 * network calls, no child processes, no provider/model work, no claim
 * operations. It only inspects its arguments and two non-secret environment
 * values (base/public URLs — never keys or credentials, never printed beyond
 * the URLs themselves). Decision-support only — never places a bet.
 */

import { evaluateLaunchCheck } from '../src/lib/raceDayLauncher';

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

interface Args {
  date: string | null;
  course: string | null;
  baseUrl: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { date: null, course: null, baseUrl: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case '--date':
        args.date = next() ?? null;
        break;
      case '--course':
        args.course = next() ?? null;
        break;
      case '--base-url':
        args.baseUrl = next() ?? null;
        break;
      default:
        break;
    }
  }
  return args;
}

function main(): void {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const result = evaluateLaunchCheck({
    date: args.date,
    course: args.course,
    baseUrl: args.baseUrl ?? undefined,
    publicDashboardUrl: process.env.PUBLIC_DASHBOARD_URL ?? null,
  });
  if (!result.ok) {
    console.error(`launch-check: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`SLUG=${result.slug}`);
  console.log(`LOCAL_URL=${result.localUrl}`);
  console.log(`PROD_URL=${result.prodUrl ?? 'not-configured'}`);
}

main();
