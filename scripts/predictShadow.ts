/**
 * CLI (OFFLINE, LOCAL): produce SHADOW-ONLY ML picks for a meeting's runners.
 *
 * Reads a trained shadow model JSON + the leakage-safe features CSV for the date
 * (the `export:training-data` output; unsettled races carry features with blank
 * labels), scores every runner, ranks them per race, and writes the picks JSON
 * the dashboard's read-only ML endpoint can overlay.
 *
 * STRICTLY SHADOW / RESEARCH ONLY. It activates no ML (`model_active` stays
 * false), changes no live recommendation, EV, staking, confidence, or no-bet
 * gate, calls no external API, uses no ML library, and makes no database access.
 * The only write is the local picks JSON.
 *
 * Usage:
 *   npm run ml:predict-shadow -- --date 2026-06-19 --course Ascot \
 *     --model data/models/ml-shadow-ascot-2026-06-16-to-2026-06-18.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { buildTrainingExportPath } from '../src/lib/trainingExport';
import { parseCsv } from '../src/lib/mlShadowEvaluation';
import { parseModel } from '../src/lib/mlShadowModel';
import {
  buildMlShadowPicksReport,
  buildMlShadowPicksPath,
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
      'Usage: npm run ml:predict-shadow -- --date <YYYY-MM-DD> [--course <name>] --model <model.json> [--input <features.csv>] [--output <picks.json>]\n' +
        '(offline shadow prediction; reads a local model + features CSV, writes a picks JSON, activates no ML).',
    );
    process.exitCode = 1;
    return;
  }

  let model;
  try {
    model = parseModel(readFileSync(args.model, 'utf8'));
  } catch (err) {
    console.error(`Failed to read model "${args.model}": ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  if (!model) {
    console.error('Model JSON is invalid or not a shadow logistic-regression model (model_active must be false).');
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
    console.error('Features CSV is empty or has no header. Nothing to predict.');
    process.exitCode = 1;
    return;
  }

  const report = buildMlShadowPicksReport(model, parsed, args.date, args.course ?? null, new Date().toISOString());
  const outPath = args.output || buildMlShadowPicksPath(args.date, args.course ?? null);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log('ML SHADOW prediction (offline; not model-active; research only)');
  console.log('===============================================================');
  console.log(`${report.disclaimer}`);
  console.log(`Races scored: ${report.races.length}${report.model.small_sample ? '  (SMALL SAMPLE — low confidence)' : ''}`);
  for (const r of report.races) {
    const ml = r.ml_pick ? `${r.ml_pick.runner_name ?? '—'} (${(r.ml_pick.ml_prob * 100).toFixed(1)}%)` : '—';
    console.log(`  ${r.off_time ?? '—'}  ${r.race_name ?? r.race_id}: ML=${ml} | regular=${r.regular_model_pick_name ?? '—'} | fav=${r.market_favourite_name ?? '—'} | ${r.agreement.badge_label}`);
  }
  console.log(`\nPicks JSON written -> ${outPath}`);
  console.log('(shadow only) No staking/EV/recommendation changed; no bet placed or suggested.');
}

main();
