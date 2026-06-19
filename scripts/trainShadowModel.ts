/**
 * CLI (OFFLINE, LOCAL): train the SHADOW-ONLY candidate ML model.
 *
 * Reads the leakage-safe `export:training-data` CSV from a LOCAL path, runs the
 * MANDATORY leakage check, trains a small deterministic logistic-regression
 * model on the SETTLED rows, and writes the model JSON. If the leakage check
 * fails it writes NOTHING and exits non-zero.
 *
 * STRICTLY SHADOW / RESEARCH ONLY. It trains no production model, activates no
 * ML (`model_active` is always false), changes no live recommendation, EV,
 * staking, confidence, or no-bet gate, calls no external API, uses no ML library,
 * and makes no database access. The only write is the local model JSON.
 *
 * Usage:
 *   npm run ml:train-shadow -- --input data/exports/training-data-2026-06-16-to-2026-06-18-ascot.csv \
 *     --output data/models/ml-shadow-ascot-2026-06-16-to-2026-06-18.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { parseCsv } from '../src/lib/mlShadowEvaluation';
import {
  trainShadowModel,
  serializeModel,
  isSmallSample,
  MIN_SHADOW_TRAINING_RACES,
} from '../src/lib/mlShadowModel';

interface Args {
  input?: string;
  output?: string;
  from?: string;
  to?: string;
  course?: string;
  seed?: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') args.input = (argv[++i] ?? '').trim();
    else if (a === '--output') args.output = (argv[++i] ?? '').trim();
    else if (a === '--from') args.from = (argv[++i] ?? '').trim();
    else if (a === '--to') args.to = (argv[++i] ?? '').trim();
    else if (a === '--course') args.course = (argv[++i] ?? '').trim();
    else if (a === '--seed') args.seed = Number((argv[++i] ?? '').trim());
  }
  return args;
}

/** Infers --from/--to from a `training-data-<from>-to-<to>...` filename. */
function inferRange(path: string): { from?: string; to?: string } {
  const m = path.match(/training-data-(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})/);
  return m ? { from: m[1], to: m[2] } : {};
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error(
      'Usage: npm run ml:train-shadow -- --input <training-data.csv> [--output <model.json>] [--from] [--to] [--course] [--seed]\n' +
        '(offline shadow trainer; reads a local CSV, writes a model JSON, activates no ML).',
    );
    process.exitCode = 1;
    return;
  }

  let text: string;
  try {
    text = readFileSync(args.input, 'utf8');
  } catch (err) {
    console.error(`Failed to read input "${args.input}": ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const parsed = parseCsv(text);
  if (parsed.header.length === 0) {
    console.error('Input CSV is empty or has no header. Nothing to train.');
    process.exitCode = 1;
    return;
  }

  const inferred = inferRange(args.input);
  const result = trainShadowModel(parsed, {
    from: args.from ?? inferred.from ?? null,
    to: args.to ?? inferred.to ?? null,
    course: args.course ?? null,
    seed: Number.isFinite(args.seed) ? args.seed : undefined,
  });

  console.log('ML SHADOW trainer (offline; not model-active; research only)');
  console.log('============================================================');
  console.log(`Leakage check: ${result.leakage.passed ? 'PASS' : 'FAIL'}`);
  console.log(`  features checked: ${result.leakage.checkedFeatures.join(', ')}`);
  if (!result.leakage.passed) {
    console.log(`  FORBIDDEN (post-race/outcome) columns: ${result.leakage.forbidden.join(', ')}`);
  }

  if (!result.model) {
    console.error(`\nNot trained: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  const model = result.model;
  const outPath =
    args.output ??
    `data/models/ml-shadow-${(args.course ?? 'all').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${model.training_date_range.from ?? 'from'}-to-${model.training_date_range.to ?? 'to'}.json`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serializeModel(model), 'utf8');

  console.log(`\nTrained logistic-regression shadow model (model_active=false):`);
  console.log(`  rows: ${model.row_count} · races: ${model.race_count} · settled rows: ${model.settled_count} across ${model.settled_race_count} settled races`);
  console.log(`  features used: ${model.feature_columns.join(', ')}`);
  console.log(`  label: ${model.label}`);
  console.log(`  in-sample Brier: ${fmt(model.evaluation.in_sample_brier)} · log loss: ${fmt(model.evaluation.in_sample_log_loss)} · top-1 race hit: ${fmt(model.evaluation.in_sample_top1_race_hit_rate)}`);
  if (isSmallSample(model)) {
    console.log(`  WARNING: small sample (${model.settled_race_count} settled races < ${MIN_SHADOW_TRAINING_RACES}) — low-confidence research only.`);
  }
  console.log(`\nModel written -> ${outPath}`);
  console.log('(shadow only) Nothing was made model-active; no staking/EV/recommendation changed.');
}

function fmt(n: number | null): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(3) : '—';
}

main();
