-- Migration: RLS hardening for recently-added internal/system tables (SECURITY).
--
-- SECURITY-ONLY. This changes NO application logic, model maths, recommendations,
-- staking, or data. It closes a Supabase exposure introduced by the recent
-- initiatives: every table below was created with a plain CREATE TABLE, so Row
-- Level Security is DISABLED and Supabase's default privileges grant ALL to the
-- public `anon` and `authenticated` roles. In a Supabase project that means each
-- row is readable AND writable through the public anon / publishable key at
--   https://<project-ref>.supabase.co/rest/v1/<table>
-- — the exposure the Supabase linter reports as `rls_disabled_in_public` (ERROR).
--
-- ACCESS MODEL (why deny-all is correct): the application reads and writes these
-- tables EXCLUSIVELY through the service-role key (src/lib/supabaseAdmin.ts).
-- There is no browser/anon Supabase client and no NEXT_PUBLIC anon key; the
-- dashboard reads only via server-side API routes that themselves use the
-- service role. So the least-privilege posture is:
--   * anon + authenticated  -> NOTHING (grants revoked AND RLS on with no policy)
--   * service_role          -> full access (it BYPASSES RLS and keeps its grant)
-- No RLS policies are created on purpose: no non-bypass role needs access, and a
-- permissive policy would only re-open the table.
--
-- IDEMPOTENT + GUARDED: every statement is wrapped in to_regclass/to_regprocedure
-- existence checks and uses only ENABLE RLS / REVOKE / GRANT, so it is safe to
-- re-run and safe in any environment where a given object happens to be absent.
-- ADDITIVE: it drops/alters no column, constraint, index, trigger, or row.
--
-- Run in the Supabase SQL editor, or via `supabase db push`.

-- ---------------------------------------------------------------------------
-- 1. Tables: revoke the default public-API grants, then enable the RLS gate.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  internal_tables text[] := array[
    'tipster_source_registry',
    'tipster_selection_candidates',
    'tipster_discovery_runs',
    'tipster_discovery_candidates',
    'tipster_dynamic_weights',
    'genai_commentary',
    'cron_runs',
    'ml_training_examples',
    'model_run_locks'
  ];
begin
  foreach t in array internal_tables loop
    if to_regclass(format('public.%I', t)) is not null then
      -- Remove the Supabase default grants from the public-facing API roles.
      execute format('revoke all on table public.%I from anon, authenticated;', t);
      -- Turn on the gate. With NO policies, anon/authenticated get deny-all;
      -- service_role bypasses RLS, so server-side operation is unaffected.
      execute format('alter table public.%I enable row level security;', t);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Functions: lock the model-lock RPCs to the service role only.
-- ---------------------------------------------------------------------------
-- PostgreSQL grants EXECUTE to PUBLIC by default (and Supabase additionally to
-- anon/authenticated), so without this an anonymous caller could invoke these
-- SECURITY DEFINER functions and disrupt per-race model locking. Re-affirm the
-- service_role grant so server-side calls keep working.
do $$
begin
  if to_regprocedure('public.try_acquire_model_lock(uuid, text, integer)') is not null then
    revoke all on function public.try_acquire_model_lock(uuid, text, integer) from public, anon, authenticated;
    grant execute on function public.try_acquire_model_lock(uuid, text, integer) to service_role;
  end if;

  if to_regprocedure('public.release_model_lock(uuid, text)') is not null then
    revoke all on function public.release_model_lock(uuid, text) from public, anon, authenticated;
    grant execute on function public.release_model_lock(uuid, text) to service_role;
  end if;
end;
$$;
