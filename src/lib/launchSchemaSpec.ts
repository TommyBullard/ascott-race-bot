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
  /**
   * The IDENTITY argument signature, e.g. `(uuid, text, integer)` — types only,
   * matching `pg_get_function_identity_arguments`. Parameter NAMES and DEFAULT
   * text are deliberately excluded: identity is what Postgres resolves an
   * overload by, so a rename or a changed default can never cause a false
   * mismatch. Defaults are inspected separately via `pg_get_function_arguments`.
   */
  signature: string;
  /** Migration file that creates the function. */
  migration: string;
  /** Role the function's EXECUTE is granted to (others revoked). */
  grantedTo: string;
  /** Expected `pg_get_function_result` output, e.g. `jsonb`. */
  resultType: string;
  /** Expected `pg_proc.prosecdef`. These run as owner, so this must be true. */
  securityDefiner: boolean;
  /**
   * Expected `pg_proc.provolatile`. Both lock functions write, so both are the
   * Postgres default VOLATILE ('v'); neither declares STABLE or IMMUTABLE.
   */
  volatility: string;
  /**
   * Expected `set search_path`, visible in `pg_proc.proconfig` as
   * `search_path=<value>`. A SECURITY DEFINER function without a pinned
   * search_path is a privilege-escalation surface, so this is the single most
   * important property to confirm manually.
   */
  searchPath: string;
}

/** The model-run lock RPCs (per 20260618050000_model_run_locks.sql). */
export const EXPECTED_FUNCTIONS: readonly FunctionSpec[] = [
  {
    name: 'try_acquire_model_lock',
    signature: '(uuid, text, integer)',
    migration: '20260618050000_model_run_locks.sql',
    grantedTo: 'service_role',
    resultType: 'jsonb',
    securityDefiner: true,
    volatility: 'v (volatile)',
    searchPath: 'public, pg_temp',
  },
  {
    name: 'release_model_lock',
    signature: '(uuid, text)',
    migration: '20260618050000_model_run_locks.sql',
    grantedTo: 'service_role',
    resultType: 'boolean',
    securityDefiner: true,
    volatility: 'v (volatile)',
    searchPath: 'public, pg_temp',
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
  'race_off_time_observations',
] as const;

/**
 * Tables whose RLS enable/grant lock-down lives in their OWN migration rather
 * than the shared RLS-hardening one. An RLS gap on these maps to that file.
 */
export const RLS_MIGRATION_BY_TABLE: Readonly<Record<string, string>> = {
  locked_race_decisions: '20260708000000_locked_race_decisions.sql',
  race_off_time_observations: '20260818000000_race_off_time_observations.sql',
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
  race_off_time_observations: '20260818000000_race_off_time_observations.sql',
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

/**
 * The append-only guard on `race_off_time_observations` (Off-Time Integrity).
 * Same reasoning as {@link LOCKED_DECISIONS_GUARD}: a trigger function is not
 * RPC-probeable, so it is verified manually through the printed SQL. For an
 * immutable audit table the trigger and the RLS posture are the two properties
 * that matter most, so neither may be left outside the launch check.
 */
export const OFF_TIME_OBSERVATIONS_GUARD = {
  functionName: 'race_off_time_observations_guard',
  triggerName: 'race_off_time_observations_no_mutate',
  table: 'race_off_time_observations',
  migration: '20260818000000_race_off_time_observations.sql',
} as const;

/** Every append-only guard the launch check must verify. */
export const APPEND_ONLY_GUARDS = [LOCKED_DECISIONS_GUARD, OFF_TIME_OBSERVATIONS_GUARD] as const;

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
/* Function presence — evidence model (NEVER an RPC invocation)               */
/* -------------------------------------------------------------------------- */

/**
 * What is actually known about a function's presence.
 *
 * Deliberately a SEPARATE union from {@link ProbeOutcome} (used for tables and
 * columns, which the data API really can probe): "the database does not have
 * it" and "this tool cannot see it" are different facts, and collapsing them is
 * what made the launch check report two live, verified functions as MISSING.
 *
 *  - `present`            authoritative evidence of existence (catalog metadata).
 *  - `missing`            authoritative evidence of ABSENCE. Only this may ever
 *                         recommend a migration.
 *  - `inaccessible`       it exists but the caller lacks EXECUTE. A privilege
 *                         problem, never a missing-object problem.
 *  - `not_api_verifiable` the data API cannot answer the question at all. The
 *                         normal state for these functions: PostgREST exposes
 *                         RPC invocation, not catalog inspection, and this
 *                         checker will not invoke a write-capable function to
 *                         find out.
 *  - `unknown`            the attempt itself failed (transport, auth, timeout).
 */
export type FunctionPresence =
  | 'present'
  | 'missing'
  | 'inaccessible'
  | 'not_api_verifiable'
  | 'unknown';

/** Evidence the classifier accepts. No variant carries an invocation result. */
export type FunctionEvidence =
  | { kind: 'catalog'; exists: boolean }
  | { kind: 'privilege_denied' }
  | { kind: 'transport_error' }
  | { kind: 'no_evidence' };

/**
 * Classifies EVIDENCE about a function. It never calls anything.
 *
 * SUPERSEDES the previous `classifyFunctionProbe`, which classified the error
 * from an `rpc(name, {})` call. That approach was wrong twice over. It sent a
 * request to a WRITE-CAPABLE endpoint for discovery — side-effect-free only by
 * the accident that both lock functions have required arguments, so one added
 * DEFAULT would have made the "read-only" launch check acquire a real lock. And
 * it read PostgREST's zero-argument PGRST202 ("Could not find the function
 * public.try_acquire_model_lock without parameters in the schema cache") as
 * proof of ABSENCE, when it is only proof that no ZERO-ARGUMENT overload
 * exists — which is true of every function that takes arguments.
 *
 * A generic or ambiguous error is NEVER absence. Absence must be positively
 * proven by catalog evidence, which the data API cannot supply — hence
 * `not_api_verifiable` as the honest default. Pure; never throws.
 */
export function classifyFunctionEvidence(
  evidence: FunctionEvidence | null | undefined,
): FunctionPresence {
  if (!evidence) return 'not_api_verifiable';
  switch (evidence.kind) {
    case 'catalog':
      return evidence.exists ? 'present' : 'missing';
    case 'privilege_denied':
      return 'inaccessible';
    case 'transport_error':
      return 'unknown';
    default:
      return 'not_api_verifiable';
  }
}

/** True ONLY for a status that justifies recommending the creating migration. */
export function provesFunctionAbsent(status: FunctionPresence): boolean {
  return status === 'missing';
}

/* ------------------------------------------------------------------------ */
/* Overall launch status                                                    */
/* ------------------------------------------------------------------------ */

/**
 * The overall verdict. Deliberately THREE states, not a boolean.
 *
 *  - `PASS`   everything the checker can verify is verified, and every required
 *             function is AUTHORITATIVELY present. Nothing is outstanding.
 *  - `REVIEW` nothing is broken and nothing was proven absent, but at least one
 *             required function could not be verified through the data API. The
 *             launch gate is NOT closed: it is waiting on manual evidence.
 *  - `FAIL`   a required object is proven missing, or a required function exists
 *             but cannot be executed, or detection itself failed.
 *
 * REVIEW exists because the honest normal state of this check is "I did not
 * invoke your write-capable lock functions to find out". Reporting that as a
 * plain PASS with exit 0 would let CI read an unresolved manual gate as complete
 * launch approval — the same class of error as the RPC probe it replaced, only
 * green instead of red.
 */
export type LaunchStatus = 'PASS' | 'REVIEW' | 'FAIL';

/**
 * Process exit codes. Mirrors the repository convention already used by
 * `producer:preflight` (0 READY / 3 REVIEW / 2 BLOCKED) and `racecards:commit`
 * (`COMMIT_EXIT.stopped_safely = 3`): 3 always means "stopped safely, needs a
 * human", never "broken".
 */
export const LAUNCH_EXIT = {
  pass: 0,
  fail: 1,
  review: 3,
} as const;

/** Maps the overall status to its process exit code. Pure, total. */
export function launchExitCode(status: LaunchStatus): number {
  switch (status) {
    case 'PASS':
      return LAUNCH_EXIT.pass;
    case 'REVIEW':
      return LAUNCH_EXIT.review;
    default:
      return LAUNCH_EXIT.fail;
  }
}

/**
 * Derives the overall status from the gaps. Pure, total.
 *
 * `inaccessible` and `unknown` FAIL deliberately. Inaccessible means the
 * application role cannot execute a function the pipeline depends on, so the
 * system is not launch-ready even though the object exists. Unknown means
 * detection itself broke, and a launch gate that shrugs at its own failure is
 * not a gate. Neither recommends a migration — see {@link migrationsForGaps}.
 *
 * Only `not_api_verifiable` — "the data API structurally cannot answer this" —
 * yields REVIEW, because it is expected on every healthy run.
 */
export function deriveLaunchStatus(input: {
  missingTables: readonly string[];
  missingColumns: readonly { table: string; column: string }[];
  missingFunctions: readonly string[];
  inaccessibleFunctions: readonly string[];
  indeterminateFunctions: readonly string[];
  notApiVerifiableFunctions: readonly string[];
  rlsGaps: readonly string[];
}): LaunchStatus {
  const failed =
    input.missingTables.length > 0 ||
    input.missingColumns.length > 0 ||
    input.missingFunctions.length > 0 ||
    input.inaccessibleFunctions.length > 0 ||
    input.indeterminateFunctions.length > 0 ||
    input.rlsGaps.length > 0;
  if (failed) return 'FAIL';
  if (input.notApiVerifiableFunctions.length > 0) return 'REVIEW';
  return 'PASS';
}

/** Operator-facing label for a function status. Pure. */
export function renderFunctionStatus(status: FunctionPresence): string {
  switch (status) {
    case 'present':
      return 'OK  ';
    case 'missing':
      return 'MISS';
    case 'inaccessible':
      return 'DENY';
    case 'unknown':
      return '????';
    default:
      return 'MAN ';
  }
}

/* -------------------------------------------------------------------------- */
/* SUPERSEDED: the RPC-invocation probe                                       */
/* -------------------------------------------------------------------------- */

/**
 * The shape of a PostgREST RPC error. RETAINED only so the removal is legible
 * to the next reader; nothing in this repository classifies one any more.
 *
 * The launch check no longer calls an RPC to discover whether a function
 * exists. See {@link classifyFunctionEvidence} for what replaced it and why.
 */
export interface FunctionProbeError {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
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
  status: FunctionPresence;
}

/** The aggregate launch verdict + every gap that explains it. */
export interface LaunchSummary {
  /** The authoritative three-state verdict. Prefer this over {@link pass}. */
  status: LaunchStatus;
  /**
   * True ONLY for a full `PASS`. REVIEW is deliberately false, so a caller that
   * still reads the boolean cannot silently collapse an unresolved manual gate
   * into approval. It is NOT the inverse of failure — check `status` for that.
   */
  pass: boolean;
  missingTables: string[];
  indeterminateTables: string[];
  missingColumns: { table: string; column: string }[];
  missingFunctions: string[];
  indeterminateFunctions: string[];
  /** Exists, but this caller lacks EXECUTE — a privilege gap, not a missing object. */
  inaccessibleFunctions: string[];
  /** The data API cannot answer; verify with the printed catalog SQL. */
  notApiVerifiableFunctions: string[];
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
 * a single PASS / REVIEW / FAIL launch verdict plus the migrations needed.
 *
 * FAIL when any required table, column or function is proven missing, a required
 * function is inaccessible or its status is unknown, or any supplied RLS gap
 * exists. REVIEW when nothing is broken but a required function is not verifiable
 * through the data API. PASS only when every function is authoritatively present.
 *
 * INDETERMINATE TABLE probes never fail the run (they are surfaced for manual
 * verification) — a launch check must not cry wolf on an unreadable table probe.
 * An indeterminate FUNCTION is different: it is a detection failure on an object
 * the pipeline cannot run without, so it fails. Pure.
 */
export function summarizeLaunchCheck(input: {
  tableHealth: readonly TableHealth[];
  functionHealth: readonly FunctionHealth[];
  rlsEnabledByTable?: Readonly<Record<string, boolean>>;
}): LaunchSummary {
  const health: HealthSummary = summarizeHealth(input.tableHealth);
  // ONLY proven absence counts as missing. "Cannot see it" and "not allowed to
  // call it" are separate facts with separate operator actions.
  const byStatus = (s: FunctionPresence): string[] =>
    input.functionHealth.filter((f) => f.status === s).map((f) => f.name);
  const missingFunctions = input.functionHealth.filter((f) => provesFunctionAbsent(f.status)).map((f) => f.name);
  const indeterminateFunctions = byStatus('unknown');
  const inaccessibleFunctions = byStatus('inaccessible');
  const notApiVerifiableFunctions = byStatus('not_api_verifiable');

  const rlsEvaluated = input.rlsEnabledByTable !== undefined;
  const rlsGaps = rlsEvaluated ? detectRlsGaps(input.rlsEnabledByTable as Record<string, boolean>) : [];

  const migrationsNeeded = migrationsForGaps({
    missingTables: health.missingTables,
    missingFunctions,
    rlsGaps,
  });

  const status = deriveLaunchStatus({
    missingTables: health.missingTables,
    missingColumns: health.missingColumns,
    missingFunctions,
    inaccessibleFunctions,
    indeterminateFunctions,
    notApiVerifiableFunctions,
    rlsGaps,
  });

  return {
    status,
    // Strictly full PASS: REVIEW is false, so a stale boolean consumer fails
    // closed onto the manual gate instead of reading it as approval.
    pass: status === 'PASS',
    missingTables: health.missingTables,
    indeterminateTables: health.indeterminateTables,
    missingColumns: health.missingColumns,
    missingFunctions,
    indeterminateFunctions,
    inaccessibleFunctions,
    notApiVerifiableFunctions,
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
    '-- 2. RPC functions — THE AUTHORITATIVE CHECK. The launch check cannot run',
    '--    this itself (the data API exposes RPC invocation, not catalog inspection)',
    '--    and will NEVER invoke a write-capable function to guess. A row here proves',
    '--    the function exists; no row proves it absent. SELECT-only.',
    '--',
    '--    Verify each column against the expected posture below. They answer five',
    '--    DIFFERENT questions: existence, signature, return type, security posture,',
    '--    and (with section 5) privileges.',
    '--',
    '--    identity_arguments  overload identity — TYPES ONLY. Parameter names and',
    '--                        DEFAULTs are excluded, so a rename cannot mismatch.',
    '--    full_arguments      the same signature WITH names and DEFAULTs, shown',
    '--                        separately. A default on every parameter is what would',
    '--                        have let the old empty-arg probe EXECUTE the function.',
    '--    result_type         return type.',
    '--    security_definer    must be true: these run as the owner.',
    '--    volatility          v = volatile, s = stable, i = immutable.',
    '--    function_config     must pin search_path. A SECURITY DEFINER function',
    '--                        WITHOUT a pinned search_path is a privilege-escalation',
    '--                        surface — this is the most important line here.',
    '--',
    '--    Expected:',
    ...EXPECTED_FUNCTIONS.flatMap((fn) => [
      `--      ${fn.name}${fn.signature}`,
      `--        result_type      ${fn.resultType}`,
      `--        security_definer ${String(fn.securityDefiner)}`,
      `--        volatility       ${fn.volatility}`,
      `--        search_path      ${fn.searchPath}   (function_config shows search_path=${fn.searchPath})`,
    ]),
    'select n.nspname as schema_name,',
    '       p.proname as function_name,',
    '       pg_get_function_identity_arguments(p.oid) as identity_arguments,',
    '       pg_get_function_arguments(p.oid) as full_arguments,',
    '       pg_get_function_result(p.oid) as result_type,',
    '       p.prosecdef as security_definer,',
    '       p.provolatile as volatility,',
    '       p.proconfig as function_config',
    'from pg_proc p join pg_namespace n on n.oid = p.pronamespace',
    `where n.nspname = 'public' and p.proname in (${fnNames})`,
    'order by p.proname;',
    '',
    '-- 2b. Full definition (optional). Use when function_config is hard to read or',
    '--     you want to confirm the body and header verbatim. SELECT-only; running',
    '--     this DISPLAYS the definition, it does not execute the function.',
    'select p.proname as function_name, pg_get_functiondef(p.oid) as definition',
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
    '--    EXECUTE denied is a GRANT problem, never a missing object.',
    ...EXPECTED_FUNCTIONS.flatMap((fn) => [
      `select '${fn.name}' as fn,`,
      `  has_function_privilege('service_role', 'public.${fn.name}${fn.signature}', 'EXECUTE') as service_role,`,
      `  has_function_privilege('anon', 'public.${fn.name}${fn.signature}', 'EXECUTE') as anon,`,
      `  has_function_privilege('authenticated', 'public.${fn.name}${fn.signature}', 'EXECUTE') as authenticated;`,
    ]),
    '',
    '-- 6. Append-only guards (trigger functions are not RPC-probeable, so this',
    '--    is the only way to verify them). Expect one row from each query:',
    ...APPEND_ONLY_GUARDS.flatMap((guard) => [
      `-- ${guard.table} (${guard.migration})`,
      'select t.tgname, c.relname as table',
      'from pg_trigger t join pg_class c on c.oid = t.tgrelid',
      `where t.tgname = '${guard.triggerName}' and c.relname = '${guard.table}';`,
      'select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace',
      `where n.nspname = 'public' and p.proname = '${guard.functionName}';`,
    ]),
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
  const verifiedFunctions = EXPECTED_FUNCTIONS.length
    - summary.missingFunctions.length
    - summary.indeterminateFunctions.length
    - summary.inaccessibleFunctions.length
    - summary.notApiVerifiableFunctions.length;
  // The REVIEW headline must never read as a bare unconditional PASS: the whole
  // point is that a human still owes this check evidence.
  const headline =
    summary.status === 'REVIEW'
      ? `REVIEW ${DASH} PASS WITH MANUAL VERIFICATION REQUIRED`
      : summary.status;
  lines.push(
    `${headline} ${DASH} ${summary.presentTables}/${summary.totalTables} required tables present, ` +
      `${verifiedFunctions}/${EXPECTED_FUNCTIONS.length} RPC functions API-verified.`,
  );
  if (summary.status === 'REVIEW') {
    // Requirement: exit 3 must never be mistaken for approval.
    lines.push(
      `  Exit ${LAUNCH_EXIT.review}: NO absence was proven and nothing is known to be broken ` +
        '— but launch approval still REQUIRES manual evidence.',
    );
    lines.push(
      '  Run verification SQL section 2 (existence, signature, return type, SECURITY DEFINER,' +
        ' search_path) and section 5 (EXECUTE grants) before approving go-live.',
    );
    lines.push('  Exit 3 is NOT launch approval. Do NOT treat it as a completed gate.');
  }

  lines.push(`Missing tables: ${summary.missingTables.length === 0 ? 'none' : summary.missingTables.join(', ')}`);
  if (summary.missingColumns.length > 0) {
    lines.push('Missing columns:');
    for (const { table, column } of summary.missingColumns) lines.push(`  - ${table}.${column}`);
  } else {
    lines.push('Missing columns: none');
  }
  lines.push(
    `Missing functions (PROVEN absent): ${summary.missingFunctions.length === 0 ? 'none' : summary.missingFunctions.join(', ')}`,
  );
  if (summary.inaccessibleFunctions.length > 0) {
    lines.push(
      `Functions present but NOT EXECUTABLE by this role: ${summary.inaccessibleFunctions.join(', ')} ` +
        `${DASH} a GRANT problem, not a missing object. Do NOT reapply the creating migration.`,
    );
  }
  if (summary.notApiVerifiableFunctions.length > 0) {
    lines.push(
      `Functions: MANUAL VERIFICATION REQUIRED ${DASH} ${summary.notApiVerifiableFunctions.join(', ')}. ` +
        'The data API exposes RPC invocation, not catalog inspection, and this check will not',
    );
    lines.push(
      `  invoke a write-capable function to discover it. This is NOT evidence of absence ${DASH} run ` +
        'verification SQL section 2.',
    );
  }

  if (summary.rlsEvaluated) {
    lines.push(`RLS gaps: ${summary.rlsGaps.length === 0 ? 'none' : summary.rlsGaps.join(', ')}`);
  } else {
    lines.push('RLS gaps: MANUAL — not readable via the data API; run verification SQL section 3 + 4.');
  }

  if (summary.indeterminateTables.length > 0) {
    lines.push(`Could not verify tables: ${summary.indeterminateTables.join(', ')}`);
  }
  if (summary.indeterminateFunctions.length > 0) {
    lines.push(
      `Function status UNKNOWN (detection failed, NOT absence): ${summary.indeterminateFunctions.join(', ')}` +
        ' — confirm via verification SQL section 2.',
    );
  }

  lines.push(
    `Migrations likely needed: ${summary.migrationsNeeded.length === 0 ? 'none' : summary.migrationsNeeded.join(', ')}`,
  );

  for (const obj of UNRESOLVED_OBJECTS) {
    lines.push(`Unresolved ${obj.kind} "${obj.name}": ${obj.note}`);
  }

  return lines;
}
