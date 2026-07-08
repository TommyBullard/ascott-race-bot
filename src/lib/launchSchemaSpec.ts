/**
 * Pure spec + classifiers for the read-only LAUNCH schema check
 * (scripts/schemaLaunchCheck.ts).
 *
 * This is the launch-readiness superset of {@link dbHealthSpec}: it REUSES that
 * module's required tables / columns / indexes + probe classifiers, and adds the
 * launch-only concerns — the expected RPC functions, the tables that MUST have
 * Row Level Security enabled, the expected grants, and a mapping from each schema
 * object to the migration that creates it (so the report can name the exact
 * migrations to apply).
 *
 * Everything here is PURE (no I/O, no DB, no mutation) so the verdict logic is
 * unit-testable without a database. As with dbHealthSpec, tables/columns/functions
 * are reliably classifiable from a read-only PostgREST probe, but indexes, RLS
 * status, and grants live in pg_catalog (not exposed by the data API) — so those
 * are reported as MANUAL with read-only SQL the operator runs themselves.
 *
 * NOTE on `field_coverage`: it is intentionally ABSENT here. The launch brief
 * listed a `field_coverage` table, but the repository has NO migration and NO
 * code that references it. It is surfaced as an UNRESOLVED object (below) rather
 * than invented, so the report flags it without fabricating a schema.
 */

import {
  REQUIRED_TABLES,
  REQUIRED_INDEXES,
  summarizeHealth,
  type HealthSummary,
  type IndexSpec,
  type ProbeOutcome,
  type TableHealth,
  type TableSpec,
} from './dbHealthSpec';

export {
  REQUIRED_TABLES,
  REQUIRED_INDEXES,
  type IndexSpec,
  type ProbeOutcome,
  type TableHealth,
  type TableSpec,
};

/* -------------------------------------------------------------------------- */
/* Expected RPC functions                                                     */
/* -------------------------------------------------------------------------- */

/** A SECURITY DEFINER RPC the app relies on, plus the migration that creates it. */
export interface FunctionSpec {
  name: string;
  /** The argument signature, e.g. `(uuid, text, integer)`. */
  signature: string;
  /** Migration file that creates the function. */
  migration: string;
  /** Role the function's EXECUTE is granted to (others revoked). */
  grantedTo: string;
}

/** The model-run lock RPCs (per 20260618050000_model_run_locks.sql). */
export const EXPECTED_FUNCTIONS: readonly FunctionSpec[] = [
  {
    name: 'try_acquire_model_lock',
    signature: '(uuid, text, integer)',
    migration: '20260618050000_model_run_locks.sql',
    grantedTo: 'service_role',
  },
  {
    name: 'release_model_lock',
    signature: '(uuid, text)',
    migration: '20260618050000_model_run_locks.sql',
    grantedTo: 'service_role',
  },
] as const;

/* -------------------------------------------------------------------------- */
/* RLS-required tables + migration mapping                                    */
/* -------------------------------------------------------------------------- */

/** The migration that enables RLS + locks grants on the internal tables. */
export const RLS_HARDEN_MIGRATION = '20260618060000_rls_harden_recent_tables.sql';

/**
 * Internal/system tables that MUST have Row Level Security ENABLED (anon /
 * authenticated revoked; service_role bypasses RLS). From the RLS-hardening
 * migration. Service-role-only access — never reachable by the public anon key.
 */
export const RLS_REQUIRED_TABLES = [
  'tipster_source_registry',
  'tipster_selection_candidates',
  'tipster_discovery_runs',
  'tipster_discovery_candidates',
  'tipster_dynamic_weights',
  'genai_commentary',
  'cron_runs',
  'ml_training_examples',
  'model_run_locks',
  'locked_race_decisions',
] as const;

/**
 * Tables whose RLS enable/grant lock-down lives in their OWN migration rather
 * than the shared RLS-hardening one. An RLS gap on these maps to that file.
 */
export const RLS_MIGRATION_BY_TABLE: Readonly<Record<string, string>> = {
  locked_race_decisions: '20260708000000_locked_race_decisions.sql',
};

/**
 * Which migration file creates each table that HAS one in the repo. Base tables
 * (races, runners, model_runs, …) have no CREATE TABLE migration — they come from
 * the schema baseline — so they are intentionally absent and reported as
 * "restore from baseline" when missing.
 */
export const MIGRATION_BY_TABLE: Readonly<Record<string, string>> = {
  tipster_selections: '20260612000000_create_tipster_selections.sql',
  tipster_source_registry: '20260616000000_tipster_source_registry_and_candidates.sql',
  tipster_selection_candidates: '20260616000000_tipster_source_registry_and_candidates.sql',
  tipster_discovery_runs: '20260618000000_tipster_discovery_engine.sql',
  tipster_discovery_candidates: '20260618000000_tipster_discovery_engine.sql',
  tipster_dynamic_weights: '20260618010000_tipster_dynamic_weights.sql',
  genai_commentary: '20260618020000_genai_commentary.sql',
  cron_runs: '20260618030000_cron_runs.sql',
  ml_training_examples: '20260618040000_ml_training_examples.sql',
  model_run_locks: '20260618050000_model_run_locks.sql',
  locked_race_decisions: '20260708000000_locked_race_decisions.sql',
};

/**
 * The append-only guard on `locked_race_decisions` (Newmarket Phase 1). It is
 * a TRIGGER function (`returns trigger`), so PostgREST cannot RPC-probe it —
 * putting it in {@link EXPECTED_FUNCTIONS} would false-FAIL the check. It is
 * verified MANUALLY via the SQL this module prints (pg_proc / pg_trigger).
 */
export const LOCKED_DECISIONS_GUARD = {
  functionName: 'locked_race_decisions_guard',
  triggerName: 'locked_race_decisions_no_mutate',
  table: 'locked_race_decisions',
  migration: '20260708000000_locked_race_decisions.sql',
} as const;

/** An object named for launch that the repo neither migrates nor references. */
export interface UnresolvedObject {
  name: string;
  kind: 'table' | 'function' | 'index';
  note: string;
}

/** Objects mentioned for launch that have NO migration and NO code in the repo. */
export const UNRESOLVED_OBJECTS: readonly UnresolvedObject[] = [
  {
    name: 'field_coverage',
    kind: 'table',
    note:
      'No migration and no code reference exist in the repo. It cannot be synced ' +
      'from this codebase — confirm whether it is actually required, then author a ' +
      'migration (or drop it from the launch list).',
  },
] as const;

/* -------------------------------------------------------------------------- */
/* Function-presence classifier (read-only probe)                             */
/* -------------------------------------------------------------------------- */

/** The subset of a PostgREST RPC error the function classifier reasons about. */
export interface FunctionProbeError {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
}

/**
 * Classifies a read-only `rpc(name, {})` probe (empty args — never executes a
 * function that requires arguments, so it is side-effect-free):
 *
 *  - no error            -> present (the function resolved/was callable);
 *  - the error message/hint surfaces the real `name(` signature -> present
 *    (PostgREST returns the candidate signature when the function EXISTS but the
 *    empty-arg probe matched no overload — proof of presence);
 *  - a "could not find the function" / PGRST202 with no such signature -> missing;
 *  - anything else       -> indeterminate (verify via the SQL the checker prints).
 *
 * Pure.
 */
export function classifyFunctionProbe(
  error: FunctionProbeError | null | undefined,
  fnName: string,
): ProbeOutcome {
  if (!error) return 'present';
  const haystack = `${error.message ?? ''} ${error.hint ?? ''}`.toLowerCase();
  if (haystack.includes(`${fnName.toLowerCase()}(`)) return 'present';
  const code = (error.code ?? '').toUpperCase();
  if (
    code === 'PGRST202' ||
    haystack.includes('could not find the function') ||
    haystack.includes('schema cache')
  ) {
    return 'missing';
  }
  return 'indeterminate';
}

/* -------------------------------------------------------------------------- */
/* RLS gap detection                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Given a map of table -> `relrowsecurity` (RLS enabled?), returns the required
 * tables whose RLS is explicitly OFF. A table absent from the map is treated as
 * UNKNOWN (not a gap) — the checker cannot read RLS through the data API, so it
 * normally passes no map and reports RLS as MANUAL. Pure.
 */
export function detectRlsGaps(rlsEnabledByTable: Readonly<Record<string, boolean>>): string[] {
  return RLS_REQUIRED_TABLES.filter((t) => rlsEnabledByTable[t] === false);
}

/* -------------------------------------------------------------------------- */
/* Launch summary                                                             */
/* -------------------------------------------------------------------------- */

/** Per-function presence verdict, assembled by the script from probe results. */
export interface FunctionHealth {
  name: string;
  status: ProbeOutcome;
}

/** The aggregate launch verdict + every gap that explains it. */
export interface LaunchSummary {
  pass: boolean;
  missingTables: string[];
  indeterminateTables: string[];
  missingColumns: { table: string; column: string }[];
  missingFunctions: string[];
  indeterminateFunctions: string[];
  /** RLS gaps — only populated when the caller supplies an RLS status map. */
  rlsGaps: string[];
  /** Whether RLS was actually evaluated (vs left for MANUAL verification). */
  rlsEvaluated: boolean;
  presentTables: number;
  totalTables: number;
  /** Exact migration files needed to close the gaps, in apply order. */
  migrationsNeeded: string[];
}

/** Maps the missing objects to the migration files that create them (sorted). */
export function migrationsForGaps(input: {
  missingTables: readonly string[];
  missingFunctions: readonly string[];
  rlsGaps: readonly string[];
}): string[] {
  const set = new Set<string>();
  for (const t of input.missingTables) {
    const m = MIGRATION_BY_TABLE[t];
    if (m) set.add(m);
  }
  for (const f of input.missingFunctions) {
    const spec = EXPECTED_FUNCTIONS.find((x) => x.name === f);
    if (spec) set.add(spec.migration);
  }
  for (const t of input.rlsGaps) {
    set.add(RLS_MIGRATION_BY_TABLE[t] ?? RLS_HARDEN_MIGRATION);
  }
  // Timestamp-prefixed filenames sort lexicographically into apply order.
  return [...set].sort();
}

/**
 * Reduces the table/column/function probe results (and an optional RLS map) into
 * a single PASS/FAIL launch verdict plus the migrations needed. FAIL when any
 * required table, column, or function is missing, or any supplied RLS gap exists.
 * INDETERMINATE probes never fail the run (they are surfaced for manual
 * verification) — a launch check must not cry wolf on an unreadable probe. Pure.
 */
export function summarizeLaunchCheck(input: {
  tableHealth: readonly TableHealth[];
  functionHealth: readonly FunctionHealth[];
  rlsEnabledByTable?: Readonly<Record<string, boolean>>;
}): LaunchSummary {
  const health: HealthSummary = summarizeHealth(input.tableHealth);
  const missingFunctions = input.functionHealth.filter((f) => f.status === 'missing').map((f) => f.name);
  const indeterminateFunctions = input.functionHealth
    .filter((f) => f.status === 'indeterminate')
    .map((f) => f.name);

  const rlsEvaluated = input.rlsEnabledByTable !== undefined;
  const rlsGaps = rlsEvaluated ? detectRlsGaps(input.rlsEnabledByTable as Record<string, boolean>) : [];

  const migrationsNeeded = migrationsForGaps({
    missingTables: health.missingTables,
    missingFunctions,
    rlsGaps,
  });

  const pass =
    health.missingTables.length === 0 &&
    health.missingColumns.length === 0 &&
    missingFunctions.length === 0 &&
    rlsGaps.length === 0;

  return {
    pass,
    missingTables: health.missingTables,
    indeterminateTables: health.indeterminateTables,
    missingColumns: health.missingColumns,
    missingFunctions,
    indeterminateFunctions,
    rlsGaps,
    rlsEvaluated,
    presentTables: health.presentTables,
    totalTables: health.totalTables,
    migrationsNeeded,
  };
}

/* -------------------------------------------------------------------------- */
/* Read-only manual verification SQL                                          */
/* -------------------------------------------------------------------------- */

/**
 * Read-only SQL the operator runs in the Supabase SQL editor to verify the
 * things PostgREST cannot introspect: index existence, RPC function presence,
 * RLS status, and the anon/authenticated/service_role grants. Pure string
 * builder — the checker NEVER executes it. Every statement is a SELECT.
 */
export function buildLaunchVerificationSql(): string[] {
  const indexNames = REQUIRED_INDEXES.map((i) => `'${i.name}'`).join(', ');
  const rlsTables = RLS_REQUIRED_TABLES.map((t) => `'${t}'`).join(', ');
  const fnNames = EXPECTED_FUNCTIONS.map((f) => `'${f.name}'`).join(', ');
  return [
    '-- 1. Indexes (expect one row per required index):',
    'select indexname, tablename from pg_indexes',
    `where schemaname = 'public' and indexname in (${indexNames})`,
    'order by indexname;',
    '',
    '-- 2. RPC functions (expect try_acquire_model_lock + release_model_lock):',
    'select p.proname, pg_get_function_identity_arguments(p.oid) as args',
    'from pg_proc p join pg_namespace n on n.oid = p.pronamespace',
    `where n.nspname = 'public' and p.proname in (${fnNames})`,
    'order by p.proname;',
    '',
    '-- 3. RLS enabled per internal table (relrowsecurity = true when RLS is ON):',
    'select c.relname as table, c.relrowsecurity as rls_enabled',
    'from pg_class c join pg_namespace n on n.oid = c.relnamespace',
    `where n.nspname = 'public' and c.relname in (${rlsTables})`,
    'order by c.relname;',
    '',
    '-- 4. Grants: anon/authenticated should have NO privileges on the internal tables.',
    'select table_name, grantee, privilege_type',
    'from information_schema.role_table_grants',
    `where table_schema = 'public' and table_name in (${rlsTables})`,
    "  and grantee in ('anon', 'authenticated')",
    'order by table_name, grantee;',
    '',
    '-- 5. Function grants: service_role should have EXECUTE; anon/authenticated should NOT.',
    "select 'try_acquire_model_lock' as fn,",
    "  has_function_privilege('service_role', 'public.try_acquire_model_lock(uuid, text, integer)', 'EXECUTE') as service_role,",
    "  has_function_privilege('anon', 'public.try_acquire_model_lock(uuid, text, integer)', 'EXECUTE') as anon;",
    '',
    '-- 6. Append-only guard on locked_race_decisions (trigger functions are not',
    '--    RPC-probeable, so this is the only way to verify them). Expect one row each:',
    'select t.tgname, c.relname as table',
    'from pg_trigger t join pg_class c on c.oid = t.tgrelid',
    `where t.tgname = '${LOCKED_DECISIONS_GUARD.triggerName}' and c.relname = '${LOCKED_DECISIONS_GUARD.table}';`,
    'select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace',
    `where n.nspname = 'public' and p.proname = '${LOCKED_DECISIONS_GUARD.functionName}';`,
  ];
}

/* -------------------------------------------------------------------------- */
/* Deterministic report rendering                                             */
/* -------------------------------------------------------------------------- */

const DASH = '\u2014';

/**
 * Renders the deterministic launch-check report: the PASS/FAIL headline, missing
 * tables/columns/functions, the RLS posture, the exact migrations needed, and the
 * unresolved objects (e.g. `field_coverage`). Pure; no I/O. Given the same
 * summary it always returns the same lines.
 */
export function renderLaunchReport(summary: LaunchSummary): string[] {
  const lines: string[] = [];
  lines.push(
    `${summary.pass ? 'PASS' : 'FAIL'} ${DASH} ${summary.presentTables}/${summary.totalTables} required tables present, ` +
      `${EXPECTED_FUNCTIONS.length - summary.missingFunctions.length}/${EXPECTED_FUNCTIONS.length} RPC functions present.`,
  );

  lines.push(`Missing tables: ${summary.missingTables.length === 0 ? 'none' : summary.missingTables.join(', ')}`);
  if (summary.missingColumns.length > 0) {
    lines.push('Missing columns:');
    for (const { table, column } of summary.missingColumns) lines.push(`  - ${table}.${column}`);
  } else {
    lines.push('Missing columns: none');
  }
  lines.push(`Missing functions: ${summary.missingFunctions.length === 0 ? 'none' : summary.missingFunctions.join(', ')}`);

  if (summary.rlsEvaluated) {
    lines.push(`RLS gaps: ${summary.rlsGaps.length === 0 ? 'none' : summary.rlsGaps.join(', ')}`);
  } else {
    lines.push('RLS gaps: MANUAL — not readable via the data API; run verification SQL section 3 + 4.');
  }

  if (summary.indeterminateTables.length > 0) {
    lines.push(`Could not verify tables: ${summary.indeterminateTables.join(', ')}`);
  }
  if (summary.indeterminateFunctions.length > 0) {
    lines.push(`Could not verify functions: ${summary.indeterminateFunctions.join(', ')} (confirm via SQL section 2)`);
  }

  lines.push(
    `Migrations likely needed: ${summary.migrationsNeeded.length === 0 ? 'none' : summary.migrationsNeeded.join(', ')}`,
  );

  for (const obj of UNRESOLVED_OBJECTS) {
    lines.push(`Unresolved ${obj.kind} "${obj.name}": ${obj.note}`);
  }

  return lines;
}
