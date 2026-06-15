/**
 * CLI (READ-ONLY): inspect the persisted data-quality + tipster-consensus
 * observability outputs on recent `model_runs`, for debugging.
 *
 * Usage:
 *   npm run inspect:model-observability                 # most recent runs
 *   npm run inspect:model-observability -- --limit 20   # cap the rows
 *   npm run inspect:model-observability -- --race <id>  # one race's runs
 *
 * Loads credentials from `.env.local` / `.env` (or the shell env). Uses the
 * service-role client, but issues ONLY `select` queries — it never writes, never
 * runs the model, and never mutates anything. Older runs that predate the
 * observability keys are handled safely (the config_json readers fall back to
 * nulls / empty arrays rather than throwing).
 */

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import {
  getDataQualityOutputsFromConfig,
  getTipsterModelAlignmentFromConfig,
  getTipsterConsensusSummaryFromConfig,
} from '../src/lib/modelRunConfigReaders';

const MODEL_RUNS_TABLE = 'model_runs';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 200;

interface Args {
  raceId?: string;
  limit: number;
}

/** Parses `--race <id>` and `--limit <n>` (clamped to [1, MAX_LIMIT]). */
function parseArgs(argv: string[]): Args {
  const args: Args = { limit: DEFAULT_LIMIT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--race' || a === '--race_id') {
      args.raceId = argv[++i];
    } else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) {
        args.limit = Math.min(Math.floor(n), MAX_LIMIT);
      }
    }
  }
  return args;
}

/** Loads env from `.env.local`, then `.env`; falls back to the shell env. */
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

interface ModelRunRow {
  race_id: string | number | null;
  run_time: string | null;
  input_mode: string | null;
  data_quality_flags: unknown;
  config_json: unknown;
}

/** Formats a value for compact one-line console output. */
function fmt(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.length === 0 ? '[]' : JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function main(): Promise<void> {
  loadEnv();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.');
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));

  // Read-only: newest current runs first; optionally scoped to one race.
  let query = supabaseAdmin
    .from(MODEL_RUNS_TABLE)
    .select('race_id, run_time, input_mode, data_quality_flags, config_json')
    .order('run_time', { ascending: false })
    .limit(args.limit);
  if (args.raceId) {
    query = query.eq('race_id', args.raceId);
  }

  const { data, error } = await query;
  if (error) {
    console.error(`Failed to read ${MODEL_RUNS_TABLE}: ${error.message}`);
    process.exit(1);
  }

  const rows = (data ?? []) as ModelRunRow[];
  console.log('');
  console.log(
    `=== model_runs observability (${rows.length} row${rows.length === 1 ? '' : 's'}${
      args.raceId ? `, race ${args.raceId}` : ''
    }) ===`,
  );

  if (rows.length === 0) {
    console.log('(no rows)');
    return;
  }

  for (const row of rows) {
    // Safe readers: older runs without these keys yield nulls / empty arrays.
    const dq = getDataQualityOutputsFromConfig(row.config_json);
    const consensusSummary = getTipsterConsensusSummaryFromConfig(row.config_json);
    const alignment = getTipsterModelAlignmentFromConfig(row.config_json);
    const alignmentLabel = alignment ? fmt(alignment.alignment_label) : '—';

    console.log('');
    console.log(`race_id:                  ${fmt(row.race_id)}`);
    console.log(`run_time:                 ${fmt(row.run_time)}`);
    console.log(`input_mode:               ${fmt(row.input_mode)}`);
    console.log(`data_quality_flags:       ${fmt(row.data_quality_flags)}`);
    console.log(`run_quality:              ${fmt(dq.run_quality)}`);
    console.log(`dq_short_summary:         ${fmt(dq.data_quality_short_summary)}`);
    console.log(`model_adjustments:        ${fmt(dq.model_adjustments)}`);
    console.log(`tipster_short_summary:    ${fmt(consensusSummary.short_summary)}`);
    console.log(`tipster_alignment_label:  ${alignmentLabel}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
