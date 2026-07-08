/**
 * Unit tests for the pure launch schema spec (src/lib/launchSchemaSpec.ts) and
 * read-only guards for the checker (scripts/schemaLaunchCheck.ts).
 *
 * No DB, no network: synthetic table/function/RLS verdicts exercise the PASS/FAIL
 * logic, the migration mapping, and the function-probe classifier. Source scans
 * prove the checker performs NO DB writes, uses only EMPTY-arg RPC probes, and
 * never reads the anon key. Run:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  REQUIRED_TABLES,
  EXPECTED_FUNCTIONS,
  RLS_REQUIRED_TABLES,
  LOCKED_DECISIONS_GUARD,
  classifyFunctionProbe,
  detectRlsGaps,
  migrationsForGaps,
  summarizeLaunchCheck,
  renderLaunchReport,
  buildLaunchVerificationSql,
  type FunctionHealth,
  type TableHealth,
} from '../src/lib/launchSchemaSpec';

function healthyTables(): TableHealth[] {
  return REQUIRED_TABLES.map((t) => ({
    table: t.name,
    status: 'present' as const,
    rowCount: 0,
    missingColumns: [],
    indeterminateColumns: [],
  }));
}

function healthyFunctions(): FunctionHealth[] {
  return EXPECTED_FUNCTIONS.map((f) => ({ name: f.name, status: 'present' as const }));
}

/* ------------------------------- healthy pass ----------------------------- */

test('healthy schema passes with no missing objects and no migrations needed', () => {
  const s = summarizeLaunchCheck({ tableHealth: healthyTables(), functionHealth: healthyFunctions() });
  assert.equal(s.pass, true);
  assert.deepEqual(s.missingTables, []);
  assert.deepEqual(s.missingColumns, []);
  assert.deepEqual(s.missingFunctions, []);
  assert.deepEqual(s.migrationsNeeded, []);
  assert.equal(s.rlsEvaluated, false); // RLS not supplied -> reported MANUAL, not failed
});

/* --------------------------- missing table/column ------------------------- */

test('missing operational table -> FAIL + names the exact migration', () => {
  const tables = healthyTables().map((t) =>
    t.table === 'cron_runs' ? { ...t, status: 'missing' as const, rowCount: null } : t,
  );
  const s = summarizeLaunchCheck({ tableHealth: tables, functionHealth: healthyFunctions() });
  assert.equal(s.pass, false);
  assert.deepEqual(s.missingTables, ['cron_runs']);
  assert.ok(s.migrationsNeeded.includes('20260618030000_cron_runs.sql'));
});

test('missing required column -> FAIL', () => {
  const tables = healthyTables().map((t) =>
    t.table === 'cron_runs' ? { ...t, missingColumns: ['ok'] } : t,
  );
  const s = summarizeLaunchCheck({ tableHealth: tables, functionHealth: healthyFunctions() });
  assert.equal(s.pass, false);
  assert.deepEqual(s.missingColumns, [{ table: 'cron_runs', column: 'ok' }]);
});

test('a missing BASE table (no repo migration) FAILs but maps to no migration file', () => {
  const tables = healthyTables().map((t) =>
    t.table === 'races' ? { ...t, status: 'missing' as const, rowCount: null } : t,
  );
  const s = summarizeLaunchCheck({ tableHealth: tables, functionHealth: healthyFunctions() });
  assert.equal(s.pass, false);
  assert.deepEqual(s.missingTables, ['races']);
  assert.deepEqual(s.migrationsNeeded, []); // base tables come from the schema baseline
});

/* ------------------------------ missing function -------------------------- */

test('missing RPC function -> FAIL + names the model-lock migration', () => {
  const fns: FunctionHealth[] = [
    { name: 'try_acquire_model_lock', status: 'missing' },
    { name: 'release_model_lock', status: 'missing' },
  ];
  const s = summarizeLaunchCheck({ tableHealth: healthyTables(), functionHealth: fns });
  assert.equal(s.pass, false);
  assert.deepEqual(s.missingFunctions.slice().sort(), ['release_model_lock', 'try_acquire_model_lock']);
  assert.deepEqual(s.migrationsNeeded, ['20260618050000_model_run_locks.sql']);
});

test('classifyFunctionProbe: present vs missing vs indeterminate (read-only probe)', () => {
  // truly absent: PGRST202, message names the fn but with NO signature paren.
  assert.equal(
    classifyFunctionProbe(
      { code: 'PGRST202', message: 'Could not find the function public.try_acquire_model_lock without parameters in the schema cache' },
      'try_acquire_model_lock',
    ),
    'missing',
  );
  // present: the empty-arg probe fails, but the hint surfaces the real signature.
  assert.equal(
    classifyFunctionProbe(
      {
        code: 'PGRST202',
        message: 'Could not find the function public.try_acquire_model_lock without parameters in the schema cache',
        hint: 'Perhaps you meant to call the function public.try_acquire_model_lock(p_owner, p_race_id, p_ttl_seconds)',
      },
      'try_acquire_model_lock',
    ),
    'present',
  );
  assert.equal(classifyFunctionProbe(null, 'release_model_lock'), 'present');
  assert.equal(
    classifyFunctionProbe({ code: '42501', message: 'permission denied for function' }, 'release_model_lock'),
    'indeterminate',
  );
});

/* -------------------------------- missing RLS ----------------------------- */

test('detectRlsGaps + summarizeLaunchCheck: RLS OFF on a required table is a gap', () => {
  const rls: Record<string, boolean> = {};
  for (const t of RLS_REQUIRED_TABLES) rls[t] = true;
  rls['cron_runs'] = false; // RLS disabled -> gap
  assert.deepEqual(detectRlsGaps(rls), ['cron_runs']);

  const s = summarizeLaunchCheck({
    tableHealth: healthyTables(),
    functionHealth: healthyFunctions(),
    rlsEnabledByTable: rls,
  });
  assert.equal(s.pass, false);
  assert.equal(s.rlsEvaluated, true);
  assert.deepEqual(s.rlsGaps, ['cron_runs']);
  assert.ok(s.migrationsNeeded.includes('20260618060000_rls_harden_recent_tables.sql'));
});

test('detectRlsGaps: a table absent from the map is UNKNOWN, not a gap', () => {
  assert.deepEqual(detectRlsGaps({}), []);
});

/* ------------------- locked_race_decisions (Newmarket Phase 1) ------------ */

test('missing locked_race_decisions -> FAIL + names its own migration', () => {
  const tables = healthyTables().map((t) =>
    t.table === 'locked_race_decisions'
      ? { ...t, status: 'missing' as const, rowCount: null }
      : t,
  );
  const s = summarizeLaunchCheck({ tableHealth: tables, functionHealth: healthyFunctions() });
  assert.equal(s.pass, false);
  assert.deepEqual(s.missingTables, ['locked_race_decisions']);
  assert.ok(s.migrationsNeeded.includes('20260708000000_locked_race_decisions.sql'));
});

test('RLS gap on locked_race_decisions maps to ITS migration, not the shared harden file', () => {
  const rls: Record<string, boolean> = {};
  for (const t of RLS_REQUIRED_TABLES) rls[t] = true;
  rls['locked_race_decisions'] = false;
  const m = migrationsForGaps({
    missingTables: [],
    missingFunctions: [],
    rlsGaps: detectRlsGaps(rls),
  });
  assert.deepEqual(m, ['20260708000000_locked_race_decisions.sql']);
});

test('the append-only guard is verified via the MANUAL SQL (not RPC-probed)', () => {
  // A trigger function cannot be probed through PostgREST RPC, so it must NOT
  // be in EXPECTED_FUNCTIONS (that would false-FAIL a healthy schema)...
  assert.equal(
    EXPECTED_FUNCTIONS.some((f) => f.name === LOCKED_DECISIONS_GUARD.functionName),
    false,
  );
  // ...and instead the verification SQL names both the trigger and the function.
  const sql = buildLaunchVerificationSql().join('\n');
  assert.ok(sql.includes(LOCKED_DECISIONS_GUARD.triggerName));
  assert.ok(sql.includes(LOCKED_DECISIONS_GUARD.functionName));
  // locked_race_decisions is in the RLS deny-all set.
  assert.ok((RLS_REQUIRED_TABLES as readonly string[]).includes('locked_race_decisions'));
});

/* ----------------------- migration mapping + determinism ------------------ */

test('migrationsForGaps: deduped + sorted into apply order', () => {
  const m = migrationsForGaps({
    missingTables: ['ml_training_examples', 'cron_runs'],
    missingFunctions: ['try_acquire_model_lock'],
    rlsGaps: ['cron_runs'],
  });
  assert.deepEqual(m, [
    '20260618030000_cron_runs.sql',
    '20260618040000_ml_training_examples.sql',
    '20260618050000_model_run_locks.sql',
    '20260618060000_rls_harden_recent_tables.sql',
  ]);
});

test('renderLaunchReport + buildLaunchVerificationSql are deterministic', () => {
  const s = summarizeLaunchCheck({ tableHealth: healthyTables(), functionHealth: healthyFunctions() });
  assert.deepEqual(renderLaunchReport(s), renderLaunchReport(s));
  assert.deepEqual(buildLaunchVerificationSql(), buildLaunchVerificationSql());
  const out = renderLaunchReport(s).join('\n');
  assert.match(out, /^PASS /);
  assert.match(out, /field_coverage/); // unresolved object surfaced, never dropped
  // the verification SQL is read-only (SELECTs only — no DDL/DML).
  const sql = buildLaunchVerificationSql().join('\n').toLowerCase();
  assert.equal(/\b(insert|update|delete|drop|alter|create|truncate)\b/.test(sql), false);
});

/* ----------------------- read-only / purity source scans ------------------ */

test('the launch checker is read-only: no DB writes, empty-arg RPC probe, no anon key', () => {
  const src = readFileSync('scripts/schemaLaunchCheck.ts', 'utf8');
  assert.equal(/\.insert\s*\(/.test(src), false);
  assert.equal(/\.update\s*\(/.test(src), false);
  assert.equal(/\.upsert\s*\(/.test(src), false);
  assert.equal(/\.delete\s*\(/.test(src), false);
  // RPC is used ONLY as an empty-arg existence probe (never executes a function).
  assert.match(src, /rpc\(name, \{\}\)/);
  // SELECT/head reads exist.
  assert.ok(/\.select\(/.test(src));
  // never reads the anon / publishable key; uses the service-role key.
  assert.equal(/SUPABASE_ANON_KEY|NEXT_PUBLIC_SUPABASE_ANON_KEY|ANON_KEY/.test(src), false);
  assert.match(src, /SUPABASE_SERVICE_ROLE_KEY/);
  // never spawns a migration / db push (checks for execution, not the doc words).
  assert.equal(/child_process|spawnSync|\bspawn\s*\(|\bexecSync\b|\bexec\s*\(/.test(src), false);
});

test('the launch spec module is pure (no DB / fs / net / env / mutations)', () => {
  const src = readFileSync('src/lib/launchSchemaSpec.ts', 'utf8');
  assert.equal(/supabaseAdmin|node:fs|process\.env|\bfetch\s*\(/.test(src), false);
  assert.equal(/\.(insert|update|upsert|delete)\s*\(/.test(src), false);
});
