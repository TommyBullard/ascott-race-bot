/**
 * CLI (OFFLINE, LOCAL): render the SHADOW-ONLY side-by-side comparison report.
 *
 * Reads a trained shadow model + the features CSV for the date and writes a
 * human-readable Markdown report comparing, per race, the regular model pick,
 * the ML shadow pick, and the market favourite, plus the agreement badge and
 * small-sample / data-mismatch warnings.
 *
 * STRICTLY SHADOW / RESEARCH ONLY. It activates no ML, changes no live
 * recommendation, EV, staking, confidence, or no-bet gate, calls no external
 * API, and makes no database access. The only write is the local Markdown report.
 *
 * Usage:
 *   npm run ml:compare-shadow -- --date 2026-06-19 --course Ascot \
 *     --model data/models/ml-shadow-ascot-2026-06-16-to-2026-06-18.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { buildTrainingExportPath } from '../src/lib/trainingExport';
import { parseCsv } from '../src/lib/mlShadowEvaluation';
import { parseModel } from '../src/lib/mlShadowModel';
import {
  buildMlShadowPicksReport,
  renderShadowComparisonMarkdown,
  buildMlShadowComparisonPath,
} from '../src/lib/mlShadowComparison';

interface Args {
  date?: string;
  course?: string;
  model?: string;
  input?: string;
  output?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = (argv[++i] ?? '').trim();
    else if (a === '--course') args.course = (argv[++i] ?? '').trim();
    else if (a === '--model') args.model = (argv[++i] ?? '').trim();
    else if (a === '--input') args.input = (argv[++i] ?? '').trim();
    else if (a === '--output') args.output = (argv[++i] ?? '').trim();
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.date || !args.model) {
    console.error(
      'Usage: npm run ml:compare-shadow -- --date <YYYY-MM-DD> [--course <name>] --model <model.json> [--input <features.csv>] [--output <report.md>]\n' +
        '(offline shadow comparison; reads a local model + features CSV, writes a Markdown report, activates no ML).',
    );
    process.exitCode = 1;
    return;
  }

  const model = (() => {
    try {
      return parseModel(readFileSync(args.model, 'utf8'));
    } catch {
      return null;
    }
  })();
  if (!model) {
    console.error(`Model JSON missing or invalid at "${args.model}" (model_active must be false).`);
    process.exitCode = 1;
    return;
  }

  const featuresPath = args.input || buildTrainingExportPath(args.date, args.date, args.course ?? null);
  let csvText: string;
  try {
    csvText = readFileSync(featuresPath, 'utf8');
  } catch {
    console.error(
      `Features CSV not found at "${featuresPath}".\n` +
        `Generate it first (read-only):\n` +
        `  npm run export:training-data -- --from ${args.date} --to ${args.date}${args.course ? ` --course ${args.course}` : ''}`,
    );
    process.exitCode = 1;
    return;
  }

  const parsed = parseCsv(csvText);
  if (parsed.header.length === 0) {
    console.error('Features CSV is empty or has no header. Nothing to compare.');
    process.exitCode = 1;
    return;
  }

  const report = buildMlShadowPicksReport(model, parsed, args.date, args.course ?? null, new Date().toISOString());
  const markdown = renderShadowComparisonMarkdown(report);
  const outPath = args.output || buildMlShadowComparisonPath(args.date, args.course ?? null);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, 'utf8');

  console.log('ML SHADOW comparison (offline; not model-active; research only)');
  console.log('===============================================================');
  console.log('race | regular pick | ML shadow pick | market favourite | agreement');
  for (const r of report.races) {
    const ml = r.ml_pick ? `${r.ml_pick.runner_name ?? '—'} (${(r.ml_pick.ml_prob * 100).toFixed(1)}%)` : '—';
    console.log(`  ${r.race_name ?? r.race_id} | ${r.regular_model_pick_name ?? '—'} | ${ml} | ${r.market_favourite_name ?? '—'} | ${r.agreement.badge_label}`);
  }
  console.log(`\nComparison report written -> ${outPath}`);
  console.log('(shadow only) The regular model pick remains the only recommendation; no staking/EV change; no bet placed.');
}

main();
