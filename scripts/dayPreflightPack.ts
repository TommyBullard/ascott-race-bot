/**
 * CLI (READ-ONLY): generate a tomorrow race-day PREFLIGHT PACK.
 *
 * Given a date + course it writes a deterministic Markdown checklist/report: the
 * environment checks, the dashboard URL, the required operating commands (the
 * DB-writing ones flagged backend / manual-approval only), the end-of-day
 * reporting commands, a safety checklist, a data-freshness checklist, the known
 * result-data caveats, and the operator reminders.
 *
 * STRICTLY READ-ONLY. It performs NO database access (it does not even read the
 * DB), NO network, NO external API call, NO child-process spawning, and never
 * passes a commit flag of its own. The only write is the Markdown report file.
 *
 * Usage:
 *   npm run preflight:day -- --date 2026-06-18 --course Ascot
 *
 * Output (deterministic):
 *   reports/preflight-2026-06-18-ascot.md
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  parsePreflightArgs,
  buildPreflightPack,
  buildPreflightPath,
  renderPreflightMarkdown,
} from '../src/lib/dayPreflightPack';

function main(): void {
  const args = parsePreflightArgs(process.argv.slice(2));
  if (args.errors.length > 0 || !args.date) {
    console.error('preflight:day — write a READ-ONLY tomorrow race-day preflight checklist.\n');
    for (const error of args.errors) console.error(`  - ${error}`);
    console.error('\nUsage: npm run preflight:day -- --date YYYY-MM-DD [--course <name>]');
    console.error('Read-only: nothing is executed, no database access, no orders, no commit flag.');
    process.exitCode = 1;
    return;
  }

  const pack = buildPreflightPack({ date: args.date, course: args.course });
  const markdown = renderPreflightMarkdown(pack);

  const outPath = buildPreflightPath(args.date, args.course);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, 'utf8');

  console.log(`Preflight pack written (read-only; nothing executed): ${outPath}`);
  console.log(
    `  date: ${pack.date}${pack.course ? ` · course: ${pack.course}` : ''} · ` +
      `operating commands: ${pack.operatingCommands.length} · end-of-day: ${pack.endOfDayCommands.length}`,
  );
}

main();
