/**
 * READ-ONLY launch schema check  (npm run schema:launch-check).
 *
 * Verifies the database is launch-ready WITHOUT mutating anything. It performs
 * only read-only probes through the service-role PostgREST client:
 *
 *   - table existence + exact row count:  select('*', { head: true, count: 'exact' })
 *   - column existence:                   select('<col>', { head: true })  per column
 *   - RPC function presence:              NOT probed. No RPC is ever called;
 *                                        proven only by the printed pg_proc SQL.
 *
 * `head: true` returns NO rows and writes nothing. There is NO function probe at
 * all: the data API can only "discover" a function by CALLING it, and both lock
 * functions are write-capable, so this check refuses to. Function existence, index
 * existence, RLS status and grants are therefore not exposed to it, so the script
 * PRINTS read-only SQL for you to run in the Supabase SQL editor (it never executes
 * it) and never claims a verdict it cannot read.
 *
 * It uses ONLY the SERVICE-ROLE key (src/lib/supabaseAdmin.ts) — never the anon /
 * publishable key — and prints NO secrets. It does not call the Racing API or
 * Betfair, runs no migration, and never executes `supabase db push`.
 *
 * Usage:   npm run schema:launch-check
 * Exit:    0 PASS   — everything verifiable is verified, functions AUTHORITATIVELY
 *                     present. Nothing outstanding.
 *          3 REVIEW — nothing broken, nothing proven absent, but a required
 *                     function is not verifiable through the data API. This is the
 *                     NORMAL result. It is NOT launch approval: the printed SQL
 *                     must be run before go-live.
 *          1 FAIL   — a required object is proven missing, a required function is
 *                     not executable by this role, or detection itself failed.
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env.local` (or `.env`).
 */

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { classifyTableProbe, classifyColumnProbe } from '../src/lib/dbHealthSpec';
import {
  REQUIRED_TABLES,
  EXPECTED_FUNCTIONS,
  UNRESOLVED_OBJECTS,
  classifyFunctionEvidence,
  renderFunctionStatus,
  summarizeLaunchCheck,
  launchExitCode,
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
  // NO RPC IS CALLED HERE. PostgREST exposes function INVOCATION, not catalog
  // inspection, so the only way to "discover" a function through the data API is
  // to call it — and both of these are WRITE-CAPABLE lock functions. The previous
  // empty-args probe was side-effect-free only by the accident that both take
  // required arguments; one added DEFAULT would have made this "read-only" check
  // acquire a real model lock. It also read the zero-argument PGRST202 ("without
  // parameters ... in the schema cache") as proof of ABSENCE, which is how two
  // live, verified functions came to be reported MISSING. Status is therefore
  // NOT-API-VERIFIABLE by construction; the authoritative catalog SQL printed
  // below is the only thing that can prove existence either way.
  const functionHealth: FunctionHealth[] = EXPECTED_FUNCTIONS.map((fn) => ({
    name: fn.name,
    status: classifyFunctionEvidence({ kind: 'no_evidence' }),
  }));
  for (const health of functionHealth) {
    const spec = EXPECTED_FUNCTIONS.find((fn) => fn.name === health.name);
    console.log(`  [${renderFunctionStatus(health.status)}] ${health.name}${spec ? spec.signature : ''}`);
  }
  console.log('         MANUAL: existence is proven only by verification SQL section 2 (pg_proc);');
  console.log('         EXECUTE grants by section 5. Never invoked here, so never reported missing.');

  // --- Summary (RLS left MANUAL — not readable via the data API) -----------
  const summary = summarizeLaunchCheck({ tableHealth, functionHealth });

  console.log('\n──────────────────────────────────────────');
  for (const line of renderLaunchReport(summary)) console.log(line);

  console.log('\nManual verification SQL (run in the Supabase SQL editor — read-only; NOT executed here):');
  for (const line of buildLaunchVerificationSql()) console.log(`  ${line}`);

  console.log('\nSafe next action:');
  if (summary.status === 'PASS') {
    console.log('  Schema looks launch-ready for the parts the data API can read. Confirm indexes /');
    console.log('  RLS / grants with the SQL above before go-live. No migration is required.');
  } else if (summary.status === 'REVIEW') {
    // REVIEW is NOT a migration situation: nothing was proven missing. Telling the
    // operator to "apply the migrations" here is exactly the dangerous advice this
    // whole fix exists to remove.
    console.log('  Run verification SQL section 2 (and 2b if needed) to PROVE the RPC functions');
    console.log('  exist with the expected signature, return type, SECURITY DEFINER and pinned');
    console.log('  search_path, then section 5 for the EXECUTE grants. NO migration is indicated:');
    console.log('  nothing was proven absent. Do NOT reapply a migration to change this state.');
    console.log('  Record that SQL output as the manual evidence for launch approval.');
  } else {
    console.log('  Apply the migrations listed under \'Migrations likely needed\' IN ORDER, in a');
    console.log('  maintenance window, per docs/LAUNCH_SCHEMA_SYNC_RUNBOOK.md (backup first; verify');
    console.log('  after each batch). This tool applies nothing.');
    console.log('  If a function is DENY (present, not executable) or ???? (detection failed), no');
    console.log('  migration applies: fix the GRANT or the connection instead.');
  }
  if (UNRESOLVED_OBJECTS.length > 0) {
    console.log('  Note the unresolved object(s) above — they have no migration in this repo.');
  }

  process.exitCode = launchExitCode(summary.status);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
