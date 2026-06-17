/**
 * CLI: one-command race-day AUTOPILOT MVP. Phase 8 of the autonomous race-day
 * workflow.
 *
 * Default is PLAN-ONLY: it prints a deterministic race-day plan and runs nothing,
 * writes nothing, and spawns nothing. With `--run-readonly` it executes ONLY the
 * whitelisted read-only / reporting commands (each gated by assertReadonlyCommand),
 * stopping at the first failure and printing a per-command status. It never passes
 * a commit flag, never writes the database, never runs the model / pipeline / odds /
 * racecards, and never places a bet. It makes no direct external API call (the
 * read-only child commands it may spawn are existing, already-built tools).
 *
 * Usage:
 *   npm run race-day:autopilot -- --date 2026-06-16 --course Ascot
 *   npm run race-day:autopilot -- --date 2026-06-16 --course Ascot --run-readonly
 */

import { spawnSync } from 'node:child_process';

import {
  parseAutopilotArgs,
  buildAutopilotPlan,
  renderAutopilotPlanMarkdown,
  runReadonlyPlan,
  buildSpawnArgs,
  quoteSpawnArg,
  type PlannedCommand,
  type CommandResult,
} from '../src/lib/raceDayAutopilot';

function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * Real child-process runner used only in --run-readonly mode. Spawns
 * `npm run <script> -- <args>` for the (already safety-gated) read-only command
 * and streams its output. Never adds flags; never spawns anything else.
 *
 * `shell: true` is required so Windows can launch the `npm.cmd` shim with
 * arguments (Node refuses to spawn a `.cmd` directly — EINVAL — since the
 * CVE-2024-27980 fix). Each argument is quoted via quoteSpawnArg so a multi-word
 * course (e.g. "Royal Ascot") or any shell metacharacter stays a single literal
 * token and cannot be interpreted by the shell.
 */
function spawnRunner(command: PlannedCommand): CommandResult {
  const args = buildSpawnArgs(command).map(quoteSpawnArg);
  const result = spawnSync(npmExecutable(), args, { stdio: 'inherit', shell: true });
  const exitCode = typeof result.status === 'number' ? result.status : null;
  return { id: command.id, ok: !result.error && exitCode === 0, exitCode };
}

function main(): void {
  const args = parseAutopilotArgs(process.argv.slice(2));

  if (args.errors.length > 0 || !args.date) {
    console.error('race-day:autopilot — plan (and optionally run) the SAFE read-only race-day workflow.\n');
    for (const error of args.errors) console.error(`  - ${error}`);
    console.error(
      '\nUsage: npm run race-day:autopilot -- --date YYYY-MM-DD [--course <name>] [--minutes-before N] [--run-readonly]',
    );
    console.error('Default: plan-only (prints the plan; runs nothing; writes nothing).');
    process.exitCode = 1;
    return;
  }

  const plan = buildAutopilotPlan({
    date: args.date,
    course: args.course,
    mode: args.mode,
    minutesBefore: args.minutesBefore,
  });

  console.log(renderAutopilotPlanMarkdown(plan));

  if (plan.mode === 'plan-only') {
    console.log(
      '\nPlan-only mode: no commands were run and nothing was written. ' +
        'Re-run with --run-readonly to execute the read-only commands above.',
    );
    return;
  }

  // --run-readonly: execute ONLY the whitelisted read-only commands.
  console.log('\nRunning read-only commands (read-only only; no DB writes; stops on first failure):\n');
  const outcome = runReadonlyPlan(plan, spawnRunner);
  console.log('');
  for (const result of outcome.results) {
    const status = result.ok ? 'OK  ' : 'FAIL';
    const code = result.exitCode != null ? ` (exit ${result.exitCode})` : '';
    console.log(`  [${status}] ${result.id}${code}`);
  }
  if (!outcome.ok) {
    console.error(`\nStopped: "${outcome.stoppedAt}" failed; the remaining commands were skipped.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll read-only commands completed. No database writes were performed by the autopilot.');
  }
}

main();
