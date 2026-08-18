/**
 * Unit tests for the pure launch schema spec (src/lib/launchSchemaSpec.ts) and
 * read-only guards for the checker (scripts/schemaLaunchCheck.ts).
 *
 * No DB, no network: synthetic table/function/RLS verdicts exercise the
 * PASS / REVIEW / FAIL logic, the exit-code contract, the migration mapping, and
 * the evidence classifier. Source scans prove the checker performs NO DB writes,
 * calls NO RPC at all, and never reads the anon key; SQL scans prove the printed
 * manual verification SQL is SELECT-only. Run:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  REQUIRED_TABLES,
  EXPECTED_FUNCTIONS,
  RLS_REQUIRED_TABLES,
  LOCKED_DECISIONS_GUARD,
  classifyFunctionEvidence,
  provesFunctionAbsent,
  deriveLaunchStatus,
  launchExitCode,
  LAUNCH_EXIT,
  UNRESOLVED_OBJECTS,
  detectRlsGaps,
  migrationsForGaps,
  summarizeLaunchCheck,
  renderLaunchReport,
  buildLaunchVerificationSql,
  type FunctionHealth,
  type FunctionPresence,
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

/* ------------------- function presence: evidence, not invocation ---------- */

test('classifyFunctionEvidence: only catalog evidence can prove absence', () => {
  // PROVEN present / absent — the ONLY authoritative source.
  assert.equal(classifyFunctionEvidence({ kind: 'catalog', exists: true }), 'present');
  assert.equal(classifyFunctionEvidence({ kind: 'catalog', exists: false }), 'missing');

  // Everything else is explicitly NOT absence.
  assert.equal(classifyFunctionEvidence({ kind: 'privilege_denied' }), 'inaccessible');
  assert.equal(classifyFunctionEvidence({ kind: 'transport_error' }), 'unknown');
  assert.equal(classifyFunctionEvidence({ kind: 'no_evidence' }), 'not_api_verifiable');
  assert.equal(classifyFunctionEvidence(null), 'not_api_verifiable');
  assert.equal(classifyFunctionEvidence(undefined), 'not_api_verifiable');

  // Only proven absence may recommend a migration.
  assert.equal(provesFunctionAbsent('missing'), true);
  for (const s of ['present', 'inaccessible', 'unknown', 'not_api_verifiable'] as const) {
    assert.equal(provesFunctionAbsent(s), false, s);
  }
});

test('REGRESSION: a live function is never reported missing, and recommends no migration', () => {
  // The exact defect. try_acquire_model_lock and release_model_lock EXIST, are
  // SECURITY DEFINER, and grant EXECUTE to service_role — proven by pg_proc.
  // The old checker called rpc(fn, {}); PostgREST answered "Could not find the
  // function public.try_acquire_model_lock without parameters in the schema
  // cache", which is only a statement about the ZERO-ARGUMENT overload, and the
  // checker read it as absence. The checker no longer calls anything.
  const health = EXPECTED_FUNCTIONS.map((fn) => ({
    name: fn.name,
    status: classifyFunctionEvidence({ kind: 'no_evidence' as const }),
  }));
  const s = summarizeLaunchCheck({ tableHealth: [], functionHealth: health });

  assert.deepEqual(s.missingFunctions, [], 'a live function must never be reported missing');
  assert.deepEqual(
    s.notApiVerifiableFunctions.slice().sort(),
    ['release_model_lock', 'try_acquire_model_lock'],
  );
  // Copied BEFORE the deepEqual: a strict-assert narrows the array to never[],
  // which would make the more specific check below unrepresentable.
  const recommended: string[] = [...s.migrationsNeeded];
  assert.equal(
    recommended.includes('20260618050000_model_run_locks.sql'),
    false,
    'the model-lock migration must NOT be recommended when the functions exist',
  );
  assert.deepEqual(recommended, [], 'no migration may be recommended for an unverifiable RPC');

  const report = renderLaunchReport(s).join('\n');
  assert.match(report, /Missing functions \(PROVEN absent\): none/);
  assert.match(report, /MANUAL VERIFICATION REQUIRED/);
  assert.match(report, /NOT evidence of absence/);
  assert.match(report, /0\/2 RPC functions API-verified/);
});

test('no non-proof status ever recommends the creating migration', () => {
  for (const status of ['inaccessible', 'unknown', 'not_api_verifiable'] as const) {
    const s = summarizeLaunchCheck({
      tableHealth: [],
      functionHealth: EXPECTED_FUNCTIONS.map((fn) => ({ name: fn.name, status })),
    });
    assert.deepEqual(s.missingFunctions, [], status);
    assert.deepEqual(s.migrationsNeeded, [], status);
  }
  // A privilege denial says so, and says what it is NOT.
  const denied = summarizeLaunchCheck({
    tableHealth: [],
    functionHealth: [{ name: 'release_model_lock', status: 'inaccessible' as const }],
  });
  const deniedReport = renderLaunchReport(denied).join('\n');
  assert.match(deniedReport, /NOT EXECUTABLE by this role/);
  assert.match(deniedReport, /a GRANT problem, not a missing object/);
  assert.match(deniedReport, /Do NOT reapply the creating migration/);

  // A transport failure is unknown, and says so.
  const unknown = summarizeLaunchCheck({
    tableHealth: [],
    functionHealth: [{ name: 'release_model_lock', status: 'unknown' as const }],
  });
  assert.match(renderLaunchReport(unknown).join('\n'), /UNKNOWN \(detection failed, NOT absence\)/);
});

test('PROVEN absence still recommends the migration', () => {
  const s = summarizeLaunchCheck({
    tableHealth: [],
    functionHealth: EXPECTED_FUNCTIONS.map((fn) => ({
      name: fn.name,
      status: classifyFunctionEvidence({ kind: 'catalog' as const, exists: false }),
    })),
  });
  assert.deepEqual(s.missingFunctions.slice().sort(), ['release_model_lock', 'try_acquire_model_lock']);
  assert.deepEqual(s.migrationsNeeded, ['20260618050000_model_run_locks.sql']);
  assert.equal(s.pass, false);
});

test('the launch check NEVER invokes an RPC, and prints authoritative catalog SQL', () => {
  const cli = readFileSync('scripts/schemaLaunchCheck.ts', 'utf8').replace(/\r\n/g, '\n');
  const exec = cli.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

  // No RPC call of any kind survives in executable code.
  assert.doesNotMatch(exec, /\.rpc\s*\(/, 'the checker must not call any RPC');
  assert.doesNotMatch(exec, /probeFunction/, 'the invoking probe must be gone');
  assert.doesNotMatch(exec, /try_acquire_model_lock\s*\(/, 'never invoke the lock acquirer');
  assert.doesNotMatch(exec, /release_model_lock\s*\(/, 'never invoke the lock releaser');
  assert.doesNotMatch(exec, /acquireModelLock|releaseModelLock|withModelRunLock/);

  // Writes remain absent: the read-only banner stays truthful.
  for (const forbidden of [/\.insert\s*\(/, /\.update\s*\(/, /\.upsert\s*\(/, /\.delete\s*\(/]) {
    assert.doesNotMatch(exec, forbidden);
  }
  assert.match(cli, /READ ONLY \(no writes, no secrets, service-role only\)/);

  // The authoritative catalog + privilege SQL is printed for BOTH functions.
  const sql = buildLaunchVerificationSql().join('\n');
  assert.match(sql, /THE AUTHORITATIVE CHECK/);
  assert.match(sql, /pg_get_function_identity_arguments/);
  for (const fn of EXPECTED_FUNCTIONS) {
    assert.ok(sql.includes(`--      ${fn.name}${fn.signature}`), `expected signature for ${fn.name}`);
    assert.ok(
      sql.includes(`has_function_privilege('service_role', 'public.${fn.name}${fn.signature}', 'EXECUTE')`),
      `service_role EXECUTE check for ${fn.name}`,
    );
    assert.ok(
      sql.includes(`has_function_privilege('anon', 'public.${fn.name}${fn.signature}', 'EXECUTE')`),
      `anon EXECUTE check for ${fn.name}`,
    );
    assert.ok(
      sql.includes(`has_function_privilege('authenticated', 'public.${fn.name}${fn.signature}', 'EXECUTE')`),
      `authenticated EXECUTE check for ${fn.name}`,
    );
  }
});

test('signature text is data, not a matcher: defaults and parameter names cannot mismatch', () => {
  // The old checker substring-matched PostgREST prose for "name(" — so wording,
  // parameter names and DEFAULT text all influenced detection. Nothing in the
  // new model reads a message at all: status comes only from evidence kind.
  for (const noisy of [
    { kind: 'no_evidence' as const },
    { kind: 'transport_error' as const },
    { kind: 'privilege_denied' as const },
  ]) {
    assert.notEqual(classifyFunctionEvidence(noisy), 'missing');
  }
  // Identity args stay EXACT in the spec, which is what the printed SQL compares.
  const spec = EXPECTED_FUNCTIONS.find((f) => f.name === 'try_acquire_model_lock');
  assert.ok(spec);
  assert.equal(spec.signature, '(uuid, text, integer)');
  const release = EXPECTED_FUNCTIONS.find((f) => f.name === 'release_model_lock');
  assert.ok(release);
  assert.equal(release.signature, '(uuid, text)');
  // Parameter NAMES are deliberately absent from the spec — pg_proc identity
  // arguments are types only, so a rename cannot cause a false mismatch.
  for (const fn of EXPECTED_FUNCTIONS) {
    assert.doesNotMatch(fn.signature, /p_race_id|p_owner|p_ttl_seconds|default/i);
  }
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

test('the launch checker is read-only: no DB writes, NO RPC AT ALL, no anon key', () => {
  const src = readFileSync('scripts/schemaLaunchCheck.ts', 'utf8');
  assert.equal(/\.insert\s*\(/.test(src), false);
  assert.equal(/\.update\s*\(/.test(src), false);
  assert.equal(/\.upsert\s*\(/.test(src), false);
  assert.equal(/\.delete\s*\(/.test(src), false);
  // STRENGTHENED. This previously required the empty-arg probe to be PRESENT.
  // That probe sent a request to a WRITE-CAPABLE lock function in order to
  // discover it, and read the zero-argument PGRST202 as proof of absence —
  // which is how two live, verified functions came to be reported MISSING.
  // There is now no RPC call of any kind.
  assert.equal(/\.rpc\s*\(/.test(src), false);
  assert.equal(/rpc\(name, \{\}\)/.test(src), false);
  assert.equal(/probeFunction/.test(src), false);
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

/* ============ M-1: explicit PASS / REVIEW / FAIL launch states ============ */

/** Every function reporting the same status, over the real EXPECTED_FUNCTIONS. */
function functionsAll(status: FunctionPresence): FunctionHealth[] {
  return EXPECTED_FUNCTIONS.map((f) => ({ name: f.name, status }));
}

test('M-1: all functions authoritatively present -> PASS, exit 0', () => {
  const s = summarizeLaunchCheck({
    tableHealth: healthyTables(),
    functionHealth: functionsAll('present'),
  });
  assert.equal(s.status, 'PASS');
  assert.equal(launchExitCode(s.status), 0);
  assert.equal(launchExitCode(s.status), LAUNCH_EXIT.pass);
  assert.equal(s.pass, true);
  const headline = renderLaunchReport(s)[0];
  assert.match(headline, /^PASS /);
  assert.match(headline, /2\/2 RPC functions API-verified/);
});

test('M-1: not_api_verifiable -> REVIEW, exit 3, never a plain PASS', () => {
  const s = summarizeLaunchCheck({
    tableHealth: healthyTables(),
    functionHealth: functionsAll('not_api_verifiable'),
  });
  assert.equal(s.status, 'REVIEW');
  assert.equal(launchExitCode(s.status), 3);
  assert.equal(launchExitCode(s.status), LAUNCH_EXIT.review);

  // The boolean must NOT collapse an unresolved manual gate into approval.
  assert.equal(s.pass, false, 'REVIEW must never set pass=true');

  // Nothing is broken: this is not a failure state either.
  assert.deepEqual(s.missingFunctions, []);
  assert.deepEqual(s.missingTables, []);
  assert.deepEqual(s.migrationsNeeded, []);
});

test('M-1: the REVIEW headline is never a bare unconditional PASS', () => {
  const s = summarizeLaunchCheck({
    tableHealth: healthyTables(),
    functionHealth: functionsAll('not_api_verifiable'),
  });
  const headline = renderLaunchReport(s)[0];

  // It must NOT read as a completed pass...
  assert.doesNotMatch(headline, /^PASS\b/, 'REVIEW must not open with a bare PASS');
  assert.equal(headline.startsWith('PASS'), false);

  // ...and it MUST carry the explicit manual label.
  assert.match(headline, /^REVIEW\b/);
  assert.match(headline, /PASS WITH MANUAL VERIFICATION REQUIRED/);

  // Requirement 13: exit 3 must be explained as "not proven absent, still not approval".
  const report = renderLaunchReport(s).join('\n');
  assert.match(report, /Exit 3/);
  assert.match(report, /NO absence was proven/);
  assert.match(report, /launch approval still REQUIRES manual evidence/);
  assert.match(report, /Exit 3 is NOT launch approval/);
});

test('M-1: a proven-missing function -> FAIL, exit 1, and DOES recommend the migration', () => {
  const s = summarizeLaunchCheck({
    tableHealth: healthyTables(),
    functionHealth: [
      { name: 'try_acquire_model_lock', status: 'present' },
      { name: 'release_model_lock', status: 'missing' },
    ],
  });
  assert.equal(s.status, 'FAIL');
  assert.equal(launchExitCode(s.status), 1);
  assert.equal(launchExitCode(s.status), LAUNCH_EXIT.fail);
  assert.equal(s.pass, false);
  assert.deepEqual(s.missingFunctions, ['release_model_lock']);
  assert.deepEqual(s.migrationsNeeded, ['20260618050000_model_run_locks.sql']);
  assert.match(renderLaunchReport(s)[0], /^FAIL /);
});

test('M-1: inaccessible -> FAIL, exit 1, but NO migration (it exists)', () => {
  const s = summarizeLaunchCheck({
    tableHealth: healthyTables(),
    functionHealth: functionsAll('inaccessible'),
  });
  assert.equal(s.status, 'FAIL', 'the app cannot execute a function it depends on');
  assert.equal(launchExitCode(s.status), 1);
  assert.equal(s.pass, false);
  assert.deepEqual(s.missingFunctions, [], 'inaccessible is NOT missing');
  assert.deepEqual(s.migrationsNeeded, [], 'a GRANT problem needs no migration');
  const report = renderLaunchReport(s).join('\n');
  assert.match(report, /a GRANT problem, not a missing object/);
  assert.match(report, /Do NOT reapply the creating migration/);
});

test('M-1: unknown -> FAIL, exit 1, but NO migration (detection failed)', () => {
  const s = summarizeLaunchCheck({
    tableHealth: healthyTables(),
    functionHealth: functionsAll('unknown'),
  });
  assert.equal(s.status, 'FAIL', 'a launch gate must not shrug at its own detection failure');
  assert.equal(launchExitCode(s.status), 1);
  assert.equal(s.pass, false);
  assert.deepEqual(s.missingFunctions, []);
  assert.deepEqual(s.migrationsNeeded, []);
  assert.match(renderLaunchReport(s).join('\n'), /UNKNOWN \(detection failed, NOT absence\)/);
});

test('M-1: table and column failures still FAIL at exit 1, regardless of functions', () => {
  const tables = healthyTables();
  tables[0] = { ...tables[0], status: 'missing', rowCount: null };
  const missingTable = summarizeLaunchCheck({ tableHealth: tables, functionHealth: functionsAll('present') });
  assert.equal(missingTable.status, 'FAIL');
  assert.equal(launchExitCode(missingTable.status), 1);

  // A missing COLUMN must fail even while every function is merely unverifiable,
  // i.e. a real failure must never be softened into REVIEW.
  const withColumnGap = healthyTables();
  withColumnGap[0] = { ...withColumnGap[0], missingColumns: [withColumnGap[0].missingColumns[0] ?? 'id'] };
  const missingColumn = summarizeLaunchCheck({
    tableHealth: withColumnGap,
    functionHealth: functionsAll('not_api_verifiable'),
  });
  assert.equal(missingColumn.status, 'FAIL', 'a hard failure outranks the manual gate');
  assert.equal(launchExitCode(missingColumn.status), 1);
});

test('M-1: an RLS gap FAILs and is not softened into REVIEW', () => {
  const rlsEnabledByTable = Object.fromEntries(RLS_REQUIRED_TABLES.map((t) => [t, true]));
  rlsEnabledByTable[RLS_REQUIRED_TABLES[0]] = false;
  const s = summarizeLaunchCheck({
    tableHealth: healthyTables(),
    functionHealth: functionsAll('not_api_verifiable'),
    rlsEnabledByTable,
  });
  assert.equal(s.status, 'FAIL');
  assert.equal(launchExitCode(s.status), 1);
});

test('M-1: deriveLaunchStatus is total and orders failure above review', () => {
  const none = {
    missingTables: [],
    missingColumns: [],
    missingFunctions: [],
    inaccessibleFunctions: [],
    indeterminateFunctions: [],
    notApiVerifiableFunctions: [],
    rlsGaps: [],
  };
  assert.equal(deriveLaunchStatus(none), 'PASS');
  assert.equal(deriveLaunchStatus({ ...none, notApiVerifiableFunctions: ['f'] }), 'REVIEW');

  // Every hard-failure input, each on its own, and each ALSO alongside a manual
  // gate — failure must always win.
  const failInputs = [
    { missingTables: ['t'] },
    { missingColumns: [{ table: 't', column: 'c' }] },
    { missingFunctions: ['f'] },
    { inaccessibleFunctions: ['f'] },
    { indeterminateFunctions: ['f'] },
    { rlsGaps: ['t'] },
  ];
  for (const extra of failInputs) {
    assert.equal(deriveLaunchStatus({ ...none, ...extra }), 'FAIL', JSON.stringify(extra));
    assert.equal(
      deriveLaunchStatus({ ...none, ...extra, notApiVerifiableFunctions: ['g'] }),
      'FAIL',
      'a manual gate must never mask a real failure: ' + JSON.stringify(extra),
    );
  }
});

test('M-1: the CLI exits via launchExitCode, not via the boolean', () => {
  const cli = readFileSync('scripts/schemaLaunchCheck.ts', 'utf8').replace(/\r\n/g, '\n');
  const exec = cli.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

  assert.match(exec, /process\.exitCode = launchExitCode\(summary\.status\)/);
  assert.doesNotMatch(exec, /process\.exitCode = summary\.pass/, 'the boolean must not drive the exit code');

  // The three-way next-action branch: REVIEW must NOT be told to apply migrations.
  assert.match(exec, /summary\.status === 'PASS'/);
  assert.match(exec, /summary\.status === 'REVIEW'/);
  const reviewBranch = exec.slice(
    exec.indexOf("summary.status === 'REVIEW'"),
    exec.indexOf('} else {', exec.indexOf("summary.status === 'REVIEW'")),
  );
  assert.ok(reviewBranch.length > 0, 'REVIEW branch must exist');
  assert.doesNotMatch(reviewBranch, /Apply the migrations/, 'REVIEW must never recommend applying a migration');
  assert.match(reviewBranch, /NO migration is indicated/);
});

test('M-1: manual verification SQL is printed for REVIEW (it cannot depend on status)', () => {
  // Structural proof: the builder takes NO arguments, so its output cannot vary
  // with the verdict — REVIEW gets byte-identical SQL to PASS and FAIL.
  assert.equal(buildLaunchVerificationSql.length, 0);
  const sql = buildLaunchVerificationSql().join('\n');
  assert.match(sql, /-- 2\. RPC functions/);

  // And the CLI prints it unconditionally, before the status-dependent advice.
  const cli = readFileSync('scripts/schemaLaunchCheck.ts', 'utf8').replace(/\r\n/g, '\n');
  const exec = cli.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const sqlPrint = exec.indexOf('buildLaunchVerificationSql()');
  const firstBranch = exec.indexOf("summary.status === 'PASS'");
  assert.ok(sqlPrint > 0, 'the CLI must print the verification SQL');
  assert.ok(firstBranch > 0);
  assert.ok(sqlPrint < firstBranch, 'the SQL must print before (and outside) the status branch');

  // The REVIEW report itself points at the sections that close the gate.
  const review = summarizeLaunchCheck({
    tableHealth: healthyTables(),
    functionHealth: functionsAll('not_api_verifiable'),
  });
  const report = renderLaunchReport(review).join('\n');
  assert.match(report, /verification SQL section 2/);
  assert.match(report, /section 5/);
});

test('M-1: field_coverage behaviour is unchanged and separately labelled', () => {
  // It must appear in EVERY verdict, worded identically, and must never become a
  // missing table, a migration recommendation, or a reason for the status.
  for (const status of ['present', 'not_api_verifiable', 'missing'] as const) {
    const s = summarizeLaunchCheck({ tableHealth: healthyTables(), functionHealth: functionsAll(status) });
    const report = renderLaunchReport(s).join('\n');
    assert.match(report, /Unresolved table "field_coverage"/, status);
    assert.match(report, /No migration and no code reference exist in the repo/, status);
    assert.equal(s.missingTables.includes('field_coverage'), false, status);
    assert.equal(s.migrationsNeeded.some((m) => m.includes('field_coverage')), false, status);
  }
  // field_coverage alone never moves the verdict off PASS.
  const pass = summarizeLaunchCheck({ tableHealth: healthyTables(), functionHealth: functionsAll('present') });
  assert.equal(pass.status, 'PASS');
  assert.ok(UNRESOLVED_OBJECTS.some((o) => o.name === 'field_coverage'));
});

/* ========== M-2: complete authoritative manual SQL (security posture) ===== */

test('M-2: catalog SQL exposes existence, signature, return type and security posture', () => {
  const sql = buildLaunchVerificationSql().join('\n');

  for (const needle of [
    'pg_get_function_identity_arguments',
    'pg_get_function_arguments',
    'pg_get_function_result',
    'prosecdef',
    'provolatile',
    'proconfig',
    'pg_get_functiondef',
  ]) {
    assert.ok(sql.includes(needle), 'catalog SQL must select ' + needle);
  }

  // Named output columns, so the operator can tell the five questions apart.
  for (const alias of [
    'as schema_name',
    'as function_name',
    'as identity_arguments',
    'as full_arguments',
    'as result_type',
    'as security_definer',
    'as volatility',
    'as function_config',
  ]) {
    assert.ok(sql.includes(alias), 'catalog SQL must alias ' + alias);
  }

  // Both functions, generated from EXPECTED_FUNCTIONS (never hardcoded).
  assert.equal(EXPECTED_FUNCTIONS.length, 2);
  for (const fn of EXPECTED_FUNCTIONS) {
    assert.ok(sql.includes("'" + fn.name + "'"), 'catalog SQL must cover ' + fn.name);
  }
});

test('M-2: the expected security posture is printed for BOTH functions', () => {
  const sql = buildLaunchVerificationSql().join('\n');
  for (const fn of EXPECTED_FUNCTIONS) {
    assert.ok(sql.includes('--      ' + fn.name + fn.signature), 'signature for ' + fn.name);
    assert.ok(sql.includes('result_type      ' + fn.resultType), 'result type for ' + fn.name);
    assert.ok(sql.includes('security_definer ' + String(fn.securityDefiner)), 'secdef for ' + fn.name);
    assert.ok(sql.includes('volatility       ' + fn.volatility), 'volatility for ' + fn.name);
    assert.ok(sql.includes('search_path      ' + fn.searchPath), 'search_path for ' + fn.name);
  }

  // The posture matches migration 20260618050000_model_run_locks.sql exactly.
  const acquire = EXPECTED_FUNCTIONS.find((f) => f.name === 'try_acquire_model_lock');
  const release = EXPECTED_FUNCTIONS.find((f) => f.name === 'release_model_lock');
  assert.ok(acquire && release);
  assert.equal(acquire.signature, '(uuid, text, integer)');
  assert.equal(acquire.resultType, 'jsonb');
  assert.equal(release.signature, '(uuid, text)');
  assert.equal(release.resultType, 'boolean');
  for (const fn of [acquire, release]) {
    assert.equal(fn.securityDefiner, true, fn.name + ' must be SECURITY DEFINER');
    assert.equal(fn.searchPath, 'public, pg_temp', fn.name + ' must pin search_path');
    assert.match(fn.volatility, /^v\b/, fn.name + ' is volatile (it writes)');
  }

  // Identity signatures stay TYPES ONLY: a parameter rename or a changed DEFAULT
  // must never be able to cause a false mismatch.
  for (const fn of EXPECTED_FUNCTIONS) {
    assert.doesNotMatch(fn.signature, /p_race_id|p_owner|p_ttl_seconds|default/i);
  }
});

test('M-2: privilege SQL covers all three roles for both functions', () => {
  const sql = buildLaunchVerificationSql().join('\n');
  for (const fn of EXPECTED_FUNCTIONS) {
    for (const role of ['service_role', 'anon', 'authenticated']) {
      assert.ok(
        sql.includes(
          "has_function_privilege('" + role + "', 'public." + fn.name + fn.signature + "', 'EXECUTE')",
        ),
        role + ' EXECUTE check for ' + fn.name,
      );
    }
    assert.equal(fn.grantedTo, 'service_role');
  }
});

test('M-2: the printed SQL is SELECT-only — no writes, no invocation, safe to paste', () => {
  const lines = buildLaunchVerificationSql();

  // Strip comment lines and blank out string literals, so the checks below look
  // only at real SQL and cannot be fooled by prose or by a quoted signature.
  const statements = lines
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .replace(/'[^']*'/g, "''");

  for (const verb of [
    'insert', 'update', 'delete', 'drop', 'alter', 'create',
    'grant', 'revoke', 'truncate', 'call', 'do', 'copy', 'merge',
  ]) {
    assert.doesNotMatch(
      statements,
      new RegExp('(^|\\n)\\s*' + verb + '\\b', 'i'),
      'no statement may begin with ' + verb,
    );
  }

  // Every statement that is not a comment starts a SELECT or continues one.
  for (const line of lines) {
    const t = line.trim();
    if (t === '' || t.startsWith('--')) continue;
    assert.doesNotMatch(t, /^(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i, t);
  }

  // NEITHER lock function is ever invoked: outside string literals, their names
  // never appear at all (in section 5 they occur only inside quoted arguments).
  for (const fn of EXPECTED_FUNCTIONS) {
    assert.equal(statements.includes(fn.name), false, fn.name + ' must never be called');
  }
  assert.doesNotMatch(statements, /select\s+\w*\s*try_acquire_model_lock/i);
});
