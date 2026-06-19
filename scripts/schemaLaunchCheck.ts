/**
 * READ-ONLY launch schema check  (npm run schema:launch-check).
 *
 * Verifies the database is launch-ready WITHOUT mutating anything. It performs
 * only read-only probes through the service-role PostgREST client:
 *
 *   - table existence + exact row count:  select('*', { head: true, count: 'exact' })
 *   - column existence:                   select('<col>', { head: true })  per column
 *   - RPC function presence:              rpc('<fn>', {})  with EMPTY args
 *
 * `head: true` returns NO rows and writes nothing. The function probe uses EMPTY
 * args, which can never satisfy the lock functions' required parameters, so it is
 * side-effect-free (no lock is ever acquired). Index existence, RLS status, and
 * grants are NOT exposed by the data API, so the script PRINTS read-only SQL for
 * you to run in the Supabase SQL editor (it never executes it) and never claims a
 * verdict it cannot read.
 *
 * It uses ONLY the SERVICE-ROLE key (src/lib/supabaseAdmin.ts) — never the anon /
 * publishable key — and prints NO secrets. It does not call the Racing API or
 * Betfair, runs no migration, and never executes `supabase db push`.
 *
 * Usage:   npm run schema:launch-check
 * Exit:    0 when PASS (all required tables/columns/functions present); 1 on FAIL.
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env.local` (or `.env`).
 */

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { classifyTableProbe, classifyColumnProbe } from '../src/lib/dbHealthSpec';
import {
  REQUIRED_TABLES,
  EXPECTED_FUNCTIONS,
  UNRESOLVED_OBJECTS,
  classifyFunctionProbe,
  summarizeLaunchCheck,
  buildLaunchVerificationSql,
  renderLaunchReport,
  type FunctionHealth,
  type FunctionProbeError,
  type ProbeOutcome,
  type TableHealth,
} from '../src/lib/launchSchemaSpec';

/** Loads env from .env.local then .env (first found wins). */
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Try the next; fall back to the shell environment.
    }
  }
}

/** Probes a table's existence + exact row count (head: no rows returned). */
async function probeTable(table: string): Promise<{ status: ProbeOutcome; rowCount: number | null }> {
  const { count, error } = await supabaseAdmin.from(table).select('*', { head: true, count: 'exact' });
  const status = classifyTableProbe(error);
  return { status, rowCount: status === 'present' ? count ?? 0 : null };
}

/** Probes a single column's existence (head: no rows returned). */
async function probeColumn(table: string, column: string): Promise<ProbeOutcome> {
  const { error } = await supabaseAdmin.from(table).select(column, { head: true }).limit(1);
  return classifyColumnProbe(error);
}

/**
 * Probes an RPC function's presence with EMPTY args. The lock functions require
 * arguments, so an empty call matches no overload and is never executed — this is
 * a read-only existence probe, not an invocation.
 */
async function probeFunction(name: string): Promise<ProbeOutcome> {
  const rpc = supabaseAdmin.rpc as unknown as (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ error: FunctionProbeError | null }>;
  const { error } = await rpc(name, {});
  return classifyFunctionProbe(error, name);
}

async function main(): Promise<void> {
  loadEnv();

  // Service-role only — never the anon/publishable key.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    console.error('This check uses ONLY the service-role key; it never uses the anon key.');
    process.exitCode = 1;
    return;
  }

  console.log('Launch schema check — READ ONLY (no writes, no secrets, service-role only).\n');

  // --- Tables + columns ---------------------------------------------------
  console.log('Tables:');
  const tableHealth: TableHealth[] = [];
  for (const spec of REQUIRED_TABLES) {
    const { status, rowCount } = await probeTable(spec.name);
    const missingColumns: string[] = [];
    const indeterminateColumns: string[] = [];
    if (status === 'present') {
      for (const column of spec.columns) {
        const outcome = await probeColumn(spec.name, column);
        if (outcome === 'missing') missingColumns.push(column);
        else if (outcome === 'indeterminate') indeterminateColumns.push(column);
      }
    }
    tableHealth.push({ table: spec.name, status, rowCount, missingColumns, indeterminateColumns });

    const countText = rowCount === null ? '' : `  (${rowCount} row(s))`;
    const mark = status === 'present' ? 'OK  ' : status === 'missing' ? 'MISS' : '????';
    console.log(`  [${mark}] ${spec.name}${countText}`);
    if (missingColumns.length > 0) console.log(`         missing columns: ${missingColumns.join(', ')}`);
    if (indeterminateColumns.length > 0) console.log(`         could not verify columns: ${indeterminateColumns.join(', ')}`);
  }

  // --- RPC functions ------------------------------------------------------
  console.log('\nRPC functions:');
  const functionHealth: FunctionHealth[] = [];
  for (const fn of EXPECTED_FUNCTIONS) {
    const status = await probeFunction(fn.name);
    functionHealth.push({ name: fn.name, status });
    const mark = status === 'present' ? 'OK  ' : status === 'missing' ? 'MISS' : '????';
    console.log(`  [${mark}] ${fn.name}${fn.signature}`);
  }

  // --- Summary (RLS left MANUAL — not readable via the data API) -----------
  const summary = summarizeLaunchCheck({ tableHealth, functionHealth });

  console.log('\n──────────────────────────────────────────');
  for (const line of renderLaunchReport(summary)) console.log(line);

  console.log('\nManual verification SQL (run in the Supabase SQL editor — read-only; NOT executed here):');
  for (const line of buildLaunchVerificationSql()) console.log(`  ${line}`);

  console.log('\nSafe next action:');
  if (summary.pass) {
    console.log('  Schema looks launch-ready for the parts the data API can read. Confirm indexes /');
    console.log('  RLS / grants with the SQL above before go-live. No migration is required.');
  } else {
    console.log('  Apply the migrations listed under "Migrations likely needed" IN ORDER, in a');
    console.log('  maintenance window, per docs/LAUNCH_SCHEMA_SYNC_RUNBOOK.md (backup first; verify');
    console.log('  after each batch). This tool applies nothing.');
  }
  if (UNRESOLVED_OBJECTS.length > 0) {
    console.log('  Note the unresolved object(s) above — they have no migration in this repo.');
  }

  process.exitCode = summary.pass ? 0 : 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
