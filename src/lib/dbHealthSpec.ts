/**
 * Pure spec + classifiers for the read-only database health check
 * (scripts/checkDatabaseHealth.ts, Batch K1d).
 *
 * This module holds (a) the schema the app expects — tables, their columns, and
 * the indexes the migrations create — and (b) pure functions that turn a
 * PostgREST probe error into a present/missing/indeterminate verdict and build a
 * PASS/FAIL summary + additive SQL suggestions. No I/O, no DB, no mutation, so
 * the decision logic is unit-testable without a database.
 *
 * WHY PROBES (not information_schema): the Supabase JS client talks to PostgREST,
 * which by default does NOT expose `information_schema` / `pg_catalog`. Table,
 * column, and row-count existence ARE reliably detectable by a read-only
 * `select(head)` probe (the script does this). Index existence + RLS status live
 * in `pg_catalog` and cannot be read through the REST API without a SQL/RPC
 * capability (which would require a schema change), so the script reports those
 * as MANUAL and emits read-only SQL for the operator to run themselves.
 */

/** A table the app requires, plus the columns it reads/writes. */
export interface TableSpec {
  name: string;
  columns: readonly string[];
}

/** An index a migration creates (for the MANUAL verification SQL). */
export interface IndexSpec {
  name: string;
  table: string;
  columns: string;
}

/**
 * Required tables + columns, derived from the app's verified insert/select
 * payloads (src/lib/raceData.ts, runModelForRace.ts, liveSync.ts, discoverTipsters
 * .ts, and the importer). Columns the code never touches are intentionally omitted.
 */
export const REQUIRED_TABLES: readonly TableSpec[] = [
  {
    name: 'races',
    columns: [
      'id', 'meeting_date', 'course', 'country', 'race_name', 'off_time',
      'handicap_flag', 'status', 'official_result_time',
    ],
  },
  {
    name: 'runners',
    columns: [
      'id', 'race_id', 'horse_name', 'trainer', 'jockey', 'draw', 'saddlecloth',
      'official_rating', 'weight_lbs', 'runner_status', 'finish_pos',
      'bsp_decimal', 'sp_decimal',
    ],
  },
  {
    name: 'market_snapshots',
    columns: ['id', 'race_id', 'snapshot_time', 'source_label'],
  },
  {
    name: 'runner_quotes',
    columns: ['id', 'snapshot_id', 'runner_id', 'quote_type', 'odds_decimal'],
  },
  {
    name: 'model_runs',
    columns: [
      'id', 'race_id', 'run_time', 'market_snapshot_id', 'model_version',
      'probability_engine_version', 'staking_engine_version', 'input_mode',
      'config_json', 'data_quality_flags', 'bet_mode', 'base_kelly_fraction',
      'signal_kappa', 'is_current', 'superseded_at',
    ],
  },
  {
    name: 'model_runner_scores',
    columns: [
      'id', 'model_run_id', 'runner_id', 'market_prob', 'model_prob', 'edge',
      'ev_per_1', 'confidence_score', 'rank_in_race', 'is_current', 'superseded_at',
    ],
  },
  {
    name: 'recommendations',
    columns: [
      'id', 'model_run_id', 'race_id', 'runner_id', 'recommendation_rank',
      'confidence_label', 'stake_pct', 'stake_amount', 'kelly_fraction_used',
      'mandatory_floor_applied', 'daily_cap_restricted', 'rationale_json',
      'is_current', 'superseded_at',
    ],
  },
  {
    name: 'bankroll_ledger',
    columns: ['balance_after', 'entry_time'],
  },
  {
    name: 'tipsters',
    columns: [
      'id', 'canonical_name', 'display_name', 'affiliation', 'source_profile_url',
      'is_active', 'first_seen_at', 'last_seen_at', 'notes',
    ],
  },
  {
    name: 'tipster_aliases',
    columns: ['id', 'tipster_id', 'alias_name', 'alias_affiliation'],
  },
  {
    name: 'tipster_priors',
    columns: [
      'tipster_id', 'as_of_date', 'bets_count', 'wins_count', 'roi_bsp_gross',
      'roi_bsp_net', 'ae_bsp', 'strike_rate', 'reliability', 'prior_score',
      'prior_weight',
    ],
  },
  {
    name: 'tipster_review_queue',
    columns: ['id', 'raw_name', 'raw_affiliation', 'created_at'],
  },
  {
    name: 'tipster_selections',
    columns: [
      'id', 'race_id', 'runner_id', 'tipster_id', 'raw_tipster_name',
      'raw_affiliation', 'created_at', 'source_label',
    ],
  },
  {
    name: 'tipster_source_registry',
    columns: [
      'id', 'source_label', 'source_name', 'source_url', 'is_approved',
      'notes', 'created_at', 'approved_at', 'supports_discovery',
      'last_discovered_at',
    ],
  },
  {
    name: 'tipster_selection_candidates',
    columns: [
      'id', 'meeting_date', 'course', 'off_time', 'horse_name', 'tipster_name',
      'raw_affiliation', 'source_label', 'source_url', 'source_name', 'status',
      'race_id', 'runner_id', 'tipster_id', 'reviewed_at', 'review_notes',
      'created_at', 'race_name', 'proof_url', 'confidence_text',
      'evidence_confidence', 'notes',
    ],
  },
  {
    name: 'tipster_discovery_runs',
    columns: [
      'id', 'source_label', 'started_at', 'finished_at', 'long_window_days',
      'recent_window_days', 'profiles_found', 'candidates_new',
      'candidates_updated', 'dry_run', 'notes',
    ],
  },
  {
    name: 'tipster_discovery_candidates',
    columns: [
      'id', 'discovery_run_id', 'source_label', 'source_url', 'discovered_name',
      'normalized_name', 'raw_affiliation', 'profile_url', 'tipster_id', 'status',
      'sample_size', 'strike_rate', 'roi', 'roi_recent', 'winner_rate',
      'placed_rate', 'last_seen_date', 'recency_days', 'discovery_confidence',
      'confidence_tier', 'confidence_reasons', 'first_seen_at', 'last_seen_at',
      'reviewed_at', 'review_notes',
    ],
  },
  {
    name: 'tipster_dynamic_weights',
    columns: [
      'id', 'tipster_id', 'as_of_date', 'bets_count', 'dynamic_weight',
      'raw_skill', 'reliability', 'coverage', 'ramp_alpha', 'effective_weight',
      'roi', 'strike_rate', 'recent_roi', 'ascot_roi', 'ascot_sample_size',
      'festival_roi', 'festival_sample_size', 'calibration_score',
      'calibration_sample_size', 'factors', 'reasons', 'created_at',
    ],
  },
  {
    name: 'genai_commentary',
    columns: [
      'id', 'race_id', 'model_run_id', 'kind', 'commentary_text',
      'prompt_version', 'generator_name', 'generator_version', 'status',
      'model_active', 'review_status', 'problems', 'grounding', 'generated_at',
      'reviewed_at', 'review_notes',
    ],
  },
  {
    name: 'cron_runs',
    columns: [
      'id', 'job', 'started_at', 'finished_at', 'duration_ms', 'ok',
      'http_status', 'counts', 'error', 'created_at',
    ],
  },
  {
    name: 'ml_training_examples',
    columns: [
      'id', 'race_id', 'runner_id', 'model_run_id', 'meeting_date', 'course',
      'off_time', 'model_version', 'field_size', 'recommended',
      'recommendation_rank', 'model_prob', 'market_prob', 'edge', 'ev', 'odds',
      'confidence_score', 'confidence_label', 'is_favourite', 'finish_pos', 'won',
      'placed', 'favourite_won', 'favourite_placed', 'bsp_decimal', 'sp_decimal',
      'captured_at',
    ],
  },
  {
    name: 'model_run_locks',
    columns: ['race_id', 'owner', 'acquired_at', 'expires_at'],
  },
  {
    name: 'locked_race_decisions',
    columns: [
      'id', 'race_id', 'model_run_id', 'lock_time', 'minutes_before',
      'off_time_at_lock', 'capture_target_time', 'decision_status',
      'no_bet_reason', 'pick_runner_id', 'pick_horse_name', 'pick_odds',
      'pick_ev', 'pick_model_prob', 'pick_market_prob', 'pick_stake',
      'pick_confidence_label', 'run_quality', 'data_quality_flags',
      'data_quality_short_summary', 'tipster_short_summary',
      'tipster_alignment_label', 'locked_state', 'locked_state_schema_version',
      'created_at',
    ],
  },
];

/** Indexes the migrations create (verified MANUALLY — see header). */
export const REQUIRED_INDEXES: readonly IndexSpec[] = [
  { name: 'model_runs_race_current_idx', table: 'model_runs', columns: 'race_id, is_current' },
  { name: 'model_runner_scores_run_current_idx', table: 'model_runner_scores', columns: 'model_run_id, is_current' },
  { name: 'recommendations_race_current_idx', table: 'recommendations', columns: 'race_id, is_current' },
  { name: 'tipster_selections_race_id_idx', table: 'tipster_selections', columns: 'race_id' },
  { name: 'tipster_selections_tipster_id_idx', table: 'tipster_selections', columns: 'tipster_id' },
  { name: 'tipster_selections_dedupe_idx', table: 'tipster_selections', columns: 'race_id, runner_id, raw_tipster_name' },
  { name: 'tipster_selection_candidates_status_idx', table: 'tipster_selection_candidates', columns: 'status' },
  { name: 'tipster_selection_candidates_source_idx', table: 'tipster_selection_candidates', columns: 'source_label' },
  { name: 'tipster_discovery_candidates_source_name_uidx', table: 'tipster_discovery_candidates', columns: 'source_label, normalized_name' },
  { name: 'tipster_discovery_candidates_status_idx', table: 'tipster_discovery_candidates', columns: 'status' },
  { name: 'tipster_discovery_candidates_tipster_idx', table: 'tipster_discovery_candidates', columns: 'tipster_id' },
  { name: 'tipster_discovery_runs_source_idx', table: 'tipster_discovery_runs', columns: 'source_label' },
  { name: 'tipster_dynamic_weights_tipster_date_uidx', table: 'tipster_dynamic_weights', columns: 'tipster_id, as_of_date' },
  { name: 'tipster_dynamic_weights_as_of_idx', table: 'tipster_dynamic_weights', columns: 'as_of_date' },
  { name: 'genai_commentary_race_idx', table: 'genai_commentary', columns: 'race_id' },
  { name: 'genai_commentary_review_idx', table: 'genai_commentary', columns: 'review_status, status' },
  { name: 'cron_runs_job_finished_idx', table: 'cron_runs', columns: 'job, finished_at desc' },
  { name: 'cron_runs_finished_idx', table: 'cron_runs', columns: 'finished_at desc' },
  { name: 'ml_training_examples_race_runner_uidx', table: 'ml_training_examples', columns: 'race_id, runner_id' },
  { name: 'ml_training_examples_meeting_idx', table: 'ml_training_examples', columns: 'meeting_date' },
  // The unique constraint's backing index (official per-race lookup) + the
  // day/proof window index, per 20260708000000_locked_race_decisions.sql.
  { name: 'locked_race_decisions_one_per_horizon', table: 'locked_race_decisions', columns: 'race_id, minutes_before' },
  { name: 'idx_locked_race_decisions_lock_time', table: 'locked_race_decisions', columns: 'lock_time, decision_status' },
];

/** Tables whose `is_current` / `superseded_at` history columns are required. */
export const MODEL_HISTORY_TABLES = ['model_runs', 'model_runner_scores', 'recommendations'] as const;

export type ProbeOutcome = 'present' | 'missing' | 'indeterminate';

/** The subset of a PostgREST error this module reasons about. */
export interface PostgrestErrorLike {
  code?: string | null;
  message?: string | null;
}

const TABLE_MISSING_CODES = new Set(['42P01', 'PGRST205', 'PGRST106']);
const COLUMN_MISSING_CODES = new Set(['42703', 'PGRST204']);

/** Classifies a table-existence probe: null error = present. */
export function classifyTableProbe(error: PostgrestErrorLike | null | undefined): ProbeOutcome {
  if (!error) return 'present';
  if (error.code && TABLE_MISSING_CODES.has(error.code)) return 'missing';
  const msg = (error.message ?? '').toLowerCase();
  if (
    msg.includes('does not exist') ||
    msg.includes('could not find the table') ||
    msg.includes('schema cache')
  ) {
    return 'missing';
  }
  return 'indeterminate';
}

/** Classifies a single-column probe: null error = present. */
export function classifyColumnProbe(error: PostgrestErrorLike | null | undefined): ProbeOutcome {
  if (!error) return 'present';
  if (error.code && COLUMN_MISSING_CODES.has(error.code)) return 'missing';
  const msg = (error.message ?? '').toLowerCase();
  if (
    (msg.includes('column') && msg.includes('does not exist')) ||
    (msg.includes('could not find') && msg.includes('column'))
  ) {
    return 'missing';
  }
  return 'indeterminate';
}

/** Per-table health, assembled by the script from probe results. */
export interface TableHealth {
  table: string;
  status: ProbeOutcome;
  rowCount: number | null;
  missingColumns: string[];
  indeterminateColumns: string[];
}

/** Aggregate PASS/FAIL verdict + the gaps that explain it. */
export interface HealthSummary {
  pass: boolean;
  missingTables: string[];
  indeterminateTables: string[];
  missingColumns: { table: string; column: string }[];
  presentTables: number;
  totalTables: number;
}

/**
 * Reduces per-table health into a PASS/FAIL verdict. FAIL when any required
 * table or column is missing. Indeterminate results do NOT fail the run (they
 * are surfaced separately) — a health check should not cry wolf on an
 * unreadable probe.
 */
export function summarizeHealth(tables: readonly TableHealth[]): HealthSummary {
  const missingTables = tables.filter((t) => t.status === 'missing').map((t) => t.table);
  const indeterminateTables = tables
    .filter((t) => t.status === 'indeterminate')
    .map((t) => t.table);
  const missingColumns: { table: string; column: string }[] = [];
  for (const t of tables) {
    for (const column of t.missingColumns) {
      missingColumns.push({ table: t.table, column });
    }
  }
  const presentTables = tables.filter((t) => t.status === 'present').length;
  return {
    pass: missingTables.length === 0 && missingColumns.length === 0,
    missingTables,
    indeterminateTables,
    missingColumns,
    presentTables,
    totalTables: tables.length,
  };
}

/**
 * Builds additive, non-destructive SQL SUGGESTIONS for the gaps found — column
 * adds are concrete; missing tables point to the schema baseline (this tool does
 * not guess full CREATE TABLE DDL). Returns `[]` when nothing is missing. The
 * caller prints these; nothing is applied.
 */
export function buildSuggestedSql(summary: HealthSummary): string[] {
  const lines: string[] = [];
  if (summary.missingTables.length > 0) {
    lines.push(
      `-- ${summary.missingTables.length} table(s) missing: ` +
        `${summary.missingTables.join(', ')}.`,
    );
    lines.push(
      '--   These have no CREATE TABLE in the repo migrations; create them from ' +
        'your schema baseline before the app can use them.',
    );
  }
  for (const { table, column } of summary.missingColumns) {
    lines.push(
      `alter table public.${table} add column if not exists ${column} <TYPE>; ` +
        `-- set the correct type/nullability`,
    );
  }
  return lines;
}

/**
 * Read-only SQL the operator can run in the Supabase SQL editor to verify the
 * things PostgREST cannot introspect: index existence and RLS status. Pure
 * string builder — this tool never executes it.
 */
export function buildManualVerificationSql(): string[] {
  const indexNames = REQUIRED_INDEXES.map((i) => `'${i.name}'`).join(', ');
  const tableNames = REQUIRED_TABLES.map((t) => `'${t.name}'`).join(', ');
  return [
    '-- Indexes (expect one row per required index, incl. tipster_selections_dedupe_idx):',
    `select indexname, tablename from pg_indexes`,
    `where schemaname = 'public' and indexname in (${indexNames})`,
    `order by indexname;`,
    '',
    '-- RLS enabled status per required table (relrowsecurity = true when RLS is on):',
    `select c.relname as table, c.relrowsecurity as rls_enabled`,
    `from pg_class c join pg_namespace n on n.oid = c.relnamespace`,
    `where n.nspname = 'public' and c.relname in (${tableNames})`,
    `order by c.relname;`,
  ];
}
