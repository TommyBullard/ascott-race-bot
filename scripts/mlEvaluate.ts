/**
 * CLI (OFFLINE, LOCAL): ML shadow evaluation baseline. Phase 7 of the autonomous
 * race-day workflow.
 *
 * It reads the existing `export:training-data` CSV from a LOCAL path, runs a
 * leakage check, computes deterministic baselines (market favourite, current
 * model rank, highest EV) plus probability quality (Brier / log loss /
 * calibration) and odds/confidence-band breakdowns, and writes a Markdown report.
 *
 * STRICTLY OFFLINE + READ-ONLY-TO-EVERYTHING-ELSE. It TRAINS NO model, persists
 * nothing, activates no ML, changes no live recommendation or stake, calls NO
 * external API, uses NO ML library, and makes NO database access. The only write
 * is the local Markdown report.
 *
 * Usage:
 *   npm run ml:evaluate -- --input data/exports/training-data-2026-06-16-to-2026-06-16-ascot.csv
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  parseCsv,
  buildMlEvaluationReport,
  buildMlEvaluationPath,
  renderMlEvaluationMarkdown,
} from '../src/lib/mlShadowEvaluation';

/** Parses `--input <path>` (and optional `--output <path>`). Pure-ish (argv only). */
function parseArgs(argv: readonly string[]): { input?: string; output?: string } {
  const args: { input?: string; output?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') args.input = v;
    } else if (a === '--output') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') args.output = v;
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error(
      'Usage: npm run ml:evaluate -- --input <training-data.csv> [--output <report.md>]\n' +
        '(offline shadow evaluation; reads a local CSV, writes a Markdown report, trains no model).',
    );
    process.exitCode = 1;
    return;
  }

  let text: string;
  try {
    text = readFileSync(args.input, 'utf8');
  } catch (err) {
    console.error(`Failed to read input file "${args.input}": ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const parsed = parseCsv(text);
  if (parsed.header.length === 0) {
    console.error('Input CSV is empty or has no header. Nothing to evaluate.');
    process.exitCode = 1;
    return;
  }

  const report = buildMlEvaluationReport(parsed, args.input, new Date().toISOString());
  const markdown = renderMlEvaluationMarkdown(report);

  const outPath = args.output ?? buildMlEvaluationPath(report.dates, report.courses);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, 'utf8');

  console.log(`ML shadow evaluation written (offline; no model trained): ${outPath}`);
  console.log(
    `  leakage: ${report.leakage.status} · races: ${report.race_count} · runners: ${report.runner_count} · settled: ${report.settled_race_count}`,
  );
  if (report.leakage.status === 'FAIL') {
    console.error(`  ⛔ leakage violations: ${report.leakage.leakage_violations.join(', ')}`);
    process.exitCode = 1;
  }
}

main();
