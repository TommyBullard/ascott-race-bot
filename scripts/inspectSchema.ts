/**
 * Schema introspection helper (read-only).
 *
 * Discovers the REAL column names of the tipster/race tables by selecting a
 * single row from each via `supabaseAdmin` (the same client/auth path the app
 * uses), so the constants in `src/lib/raceData.ts` can be aligned to the actual
 * database instead of assumed names.
 *
 * Read-only (SELECT ... LIMIT 1). Makes no writes. Run with:
 *   npm run inspect:schema
 *
 * Caveat: a column list can only be derived from a table that has at least one
 * row. Empty tables are reported as such (their columns can't be inferred this
 * way).
 */

import { supabaseAdmin } from '../src/lib/supabaseAdmin';

const TABLES_OF_INTEREST = [
  'races',
  'runners',
  'runner_quotes',
  'tipster_selections',
  'tipster_priors',
  'tipsters',
  'tipster_aliases',
  'tipster_review_queue',
  'recommendations',
];

function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Not present; try next, then fall back to shell env.
    }
  }
}

async function main(): Promise<void> {
  loadEnv();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.');
    process.exit(1);
  }

  console.log('');
  console.log('=== Real schema (columns inferred from one row per table) ===');
  console.log('');

  for (const table of TABLES_OF_INTEREST) {
    const { data, error } = await supabaseAdmin.from(table).select('*').limit(1);

    console.log(`--- ${table} ---`);
    if (error) {
      console.log(`  ERROR: ${error.message}`);
    } else if (!data || data.length === 0) {
      console.log('  (no rows — cannot infer columns from data)');
    } else {
      for (const col of Object.keys(data[0])) {
        console.log(`  ${col}`);
      }
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error('Schema introspection failed:', err);
  process.exit(1);
});
