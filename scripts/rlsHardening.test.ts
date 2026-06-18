/**
 * Guard test for the RLS hardening migration
 * (supabase/migrations/20260618060000_rls_harden_recent_tables.sql).
 *
 * SECURITY REGRESSION GUARD — not application logic. It reads the migration SQL
 * and asserts that every recently-added internal/system table is locked down
 * (grants revoked from anon/authenticated + RLS enabled), that the model-lock
 * RPCs are revoked from the public roles, and that nothing re-opens these tables
 * to anon/authenticated or strips the service role. If someone adds a new
 * internal table, add it here and to the migration. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MIGRATION = 'supabase/migrations/20260618060000_rls_harden_recent_tables.sql';

/** Every recently-added table that must be server-only (service_role-only). */
const INTERNAL_TABLES = [
  'tipster_source_registry',
  'tipster_selection_candidates',
  'tipster_discovery_runs',
  'tipster_discovery_candidates',
  'tipster_dynamic_weights',
  'genai_commentary',
  'cron_runs',
  'ml_training_examples',
  'model_run_locks',
] as const;

const sql = readFileSync(MIGRATION, 'utf8');
const lower = sql.toLowerCase();

test('hardening migration: lists every internal table', () => {
  for (const t of INTERNAL_TABLES) {
    assert.ok(lower.includes(`'${t}'`), `migration is missing internal table ${t}`);
  }
});

test('hardening migration: enables RLS and revokes the anon/authenticated grants', () => {
  assert.match(lower, /alter table public\.%i enable row level security/);
  assert.match(lower, /revoke all on table public\.%i from anon, authenticated/);
});

test('hardening migration: never re-opens a table with a policy', () => {
  // No CREATE POLICY at all — these tables are service_role-only by design.
  assert.equal(/create\s+policy/i.test(sql), false);
});

test('hardening migration: never revokes from or drops the service role', () => {
  assert.equal(/revoke[\s\S]*?from[^;]*\bservice_role\b/i.test(sql), false);
});

test('hardening migration: locks the model-lock RPCs to service_role only', () => {
  for (const fn of ['try_acquire_model_lock', 'release_model_lock']) {
    assert.ok(
      new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`, 'i').test(sql),
      `migration must revoke ${fn} from public/anon/authenticated`,
    );
    assert.ok(
      new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`, 'i').test(sql),
      `migration must keep ${fn} executable by service_role`,
    );
  }
});

test('hardening migration: is guarded so it is safe to re-run / partially apply', () => {
  assert.match(lower, /to_regclass/);
  assert.match(lower, /to_regprocedure/);
});
