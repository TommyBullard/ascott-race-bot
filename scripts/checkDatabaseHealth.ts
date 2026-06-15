/**
 * READ-ONLY database health check (Batch K1d).
 *
 * Verifies that the Supabase database has the tables, columns, and (manually)
 * the indexes + RLS the app needs. It performs ONLY read-only PostgREST probes:
 *
 *   - table existence + EXACT row count:  select('*', { head: true, count: 'exact' })
 *   - column existence:                   select('<col>', { head: true })  per column
 *
 * `head: true` returns NO rows (just headers/count), so this never pulls data
 * and never writes. It does not call the Racing API or Betfair, and prints no
 * secrets.
 *
 * Index existence + RLS status live in pg_catalog, which the REST API does not
 * expose. The script therefore prints exact read-only SQL for you to run in the
 * Supabase SQL editor (it never executes it) — including the
 * tipster_selections_dedupe_idx and per-table RLS checks.
 *
 * The model-history columns (is_current / superseded_at) and source_label are
 * ordinary columns, so they ARE checked directly by the column probes.
 *
 * Usage:
 *   npm run check:db
 *
 * Exit code: 0 when all required tables + columns are present; 1 otherwise.
 * REQUIRES SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env.local` (or `.env`).
 */

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import {
  REQUIRED_TABLES,
  MODEL_HISTORY_TABLES,
  classifyTableProbe,
  classifyColumnProbe,
  summarizeHealth,
  buildSuggestedSql,
  buildManualVerificationSql,
  type TableHealth,
  type ProbeOutcome,
} from '../src/lib/dbHealthSpec';

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
async function probeTable(
  table: string,
): Promise<{ status: ProbeOutcome; rowCount: number | null }> {
  const { count, error } = await supabaseAdmin
    .from(table)
    .select('*', { head: true, count: 'exact' });
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

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }

  console.log('Database health check — READ ONLY (no writes, no secrets).\n');

  const health: TableHealth[] = [];
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

    health.push({ table: spec.name, status, rowCount, missingColumns, indeterminateColumns });

    const countText = rowCount === null ? '' : `  (${rowCount} row(s))`;
    const mark = status === 'present' ? 'OK  ' : status === 'missing' ? 'MISS' : '????';
    console.log(`  [${mark}] ${spec.name}${countText}`);
    if (missingColumns.length > 0) {
      console.log(`         missing columns: ${missingColumns.join(', ')}`);
    }
    if (indeterminateColumns.length > 0) {
      console.log(`         could not verify columns: ${indeterminateColumns.join(', ')}`);
    }
  }

  const summary = summarizeHealth(health);

  // Targeted callouts the operator asked about.
  console.log('\nKey checks:');
  console.log(`  model history columns (is_current/superseded_at): ${historyColumnsVerdict(health)}`);
  console.log(`  tipster_selections.source_label: ${columnVerdict(health, 'tipster_selections', 'source_label')}`);
  console.log('  tipster_selections_dedupe_idx: MANUAL (see SQL below — index, not API-visible)');

  // Summary.
  console.log('\n──────────────────────────────────────────');
  console.log(
    `${summary.pass ? 'PASS' : 'FAIL'} — ${summary.presentTables}/${summary.totalTables} tables present` +
      `${summary.missingTables.length > 0 ? `, ${summary.missingTables.length} missing` : ''}` +
      `${summary.missingColumns.length > 0 ? `, ${summary.missingColumns.length} column(s) missing` : ''}.`,
  );
  if (summary.missingTables.length > 0) {
    console.log(`  Missing tables: ${summary.missingTables.join(', ')}`);
  }
  if (summary.indeterminateTables.length > 0) {
    console.log(`  Could not verify tables: ${summary.indeterminateTables.join(', ')}`);
  }
  if (summary.missingColumns.length > 0) {
    console.log('  Missing columns:');
    for (const { table, column } of summary.missingColumns) {
      console.log(`    - ${table}.${column}`);
    }
  }

  const suggestions = buildSuggestedSql(summary);
  if (suggestions.length > 0) {
    console.log('\nSuggested additive SQL (review + set types; NOT applied by this tool):');
    for (const line of suggestions) console.log(`  ${line}`);
  }

  console.log('\nManual checks (run in the Supabase SQL editor — read-only):');
  for (const line of buildManualVerificationSql()) console.log(`  ${line}`);

  process.exitCode = summary.pass ? 0 : 1;
}

/** Verdict string for a single column across the probed health. */
function columnVerdict(health: TableHealth[], table: string, column: string): string {
  const t = health.find((h) => h.table === table);
  if (!t) return 'unknown';
  if (t.status !== 'present') return `table ${t.status}`;
  if (t.missingColumns.includes(column)) return 'MISSING';
  if (t.indeterminateColumns.includes(column)) return 'could not verify';
  return 'present';
}

/** Combined verdict for the is_current/superseded_at history columns. */
function historyColumnsVerdict(health: TableHealth[]): string {
  const missing: string[] = [];
  for (const table of MODEL_HISTORY_TABLES) {
    for (const column of ['is_current', 'superseded_at']) {
      const v = columnVerdict(health, table, column);
      if (v !== 'present') missing.push(`${table}.${column} (${v})`);
    }
  }
  return missing.length === 0 ? 'present on all 3 tables' : `issues: ${missing.join(', ')}`;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
