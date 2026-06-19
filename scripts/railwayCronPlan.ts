/**
 * `railway:cron-plan` — READ-ONLY planner.
 *
 * Prints the recommended Railway cron commands, schedules, the public dashboard
 * URL, and the safety warnings for race-day automation. It performs NO database
 * writes, makes no network calls, spawns no process, and places no bets — it
 * only renders text from the pure planner in src/lib/railwayCronPlan.ts.
 *
 * Usage:
 *   npm run railway:cron-plan -- --date YYYY-MM-DD --course Ascot
 *   npm run railway:cron-plan -- --course Ascot           (date defaults to today, UTC)
 */

import {
  parseCronPlanArgs,
  buildRailwayCronPlan,
  renderRailwayCronPlanText,
} from '../src/lib/railwayCronPlan';

function main(): void {
  const args = parseCronPlanArgs(process.argv.slice(2));
  const plan = buildRailwayCronPlan({
    date: args.date,
    course: args.course,
    baseUrl: args.baseUrl,
    minutesBefore: args.minutesBefore,
  });
  console.log(renderRailwayCronPlanText(plan));
}

main();
