-- Migration: per-race model-run TTL lease lock (Phase 5 concurrency)
--
-- ADDITIVE ONLY. Serialises model execution per race so the model cron, results
-- cron, manual /api/run-model, and the operator pipeline cannot insert+supersede
-- `model_runs` for the SAME race simultaneously — the non-atomic, multi-statement
-- supersession that caused the Ascot Day-1 `is_current` corruption.
--
-- It is a TTL LEASE in a table (NOT a session/advisory lock): a session advisory
-- lock cannot survive PostgREST's stateless, pooled connections, whereas a lease
-- row works through the REST API and self-heals when a holder crashes (the lease
-- expires and the next run steals it).
--
-- FAIL-OPEN by design: the application proceeds normally if this table/functions
-- are absent, so a missing migration degrades to today's (unprotected) behaviour
-- rather than an outage. Nothing here changes model maths, recommendations, or
-- staking. Guarded with IF NOT EXISTS / CREATE OR REPLACE so it is safe to re-run.
--
-- Run in the Supabase SQL editor (or via `supabase db push`).
--
-- Columns:
--   race_id     : the race being scored (PK — one lease per race serialises it).
--   owner       : opaque per-invocation id (a UUID) that acquired the lease.
--   acquired_at : when the current holder took the lease.
--   expires_at  : lease deadline; a lease at/after this is STALE and stealable.

create table if not exists public.model_run_locks (
  race_id     uuid primary key,
  owner       text        not null,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- ---------------------------------------------------------------------------
-- try_acquire_model_lock: atomic, NON-BLOCKING claim.
-- ---------------------------------------------------------------------------
-- Inserts a fresh lease, OR (on conflict) steals an EXPIRED lease only. The PK
-- row-lock serialises competing claimers inside this single statement, so no
-- advisory lock or multi-statement transaction is needed. Returns a jsonb:
--   { "acquired": bool, "stole_expired": bool }
-- `stole_expired` is true when the acquisition reclaimed a crashed holder's
-- expired lease (drives the MODEL_LOCK_EXPIRED log). When a LIVE lease is held by
-- someone else, the conflict's WHERE is false → no row is updated → acquired=false.

create or replace function public.try_acquire_model_lock(
  p_race_id uuid,
  p_owner text,
  p_ttl_seconds integer default 120
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now        timestamptz := now();
  v_got        boolean;
  v_was_update boolean;
begin
  insert into public.model_run_locks as l (race_id, owner, acquired_at, expires_at)
  values (
    p_race_id, p_owner, v_now,
    v_now + make_interval(secs => greatest(p_ttl_seconds, 1))
  )
  on conflict (race_id) do update
    set owner = excluded.owner,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
    where l.expires_at <= v_now              -- steal ONLY an expired lease
  returning (acquired_at = v_now), (xmax::text::bigint <> 0)
  into v_got, v_was_update;                  -- xmax<>0 ⇒ the conflict/UPDATE path ran

  return jsonb_build_object(
    'acquired', coalesce(v_got, false),
    'stole_expired', coalesce(v_got, false) and coalesce(v_was_update, false)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- release_model_lock: OWNER-SCOPED release.
-- ---------------------------------------------------------------------------
-- Deletes the lease only when the caller still owns it (a lease since stolen by
-- another owner after TTL expiry is NOT released by the old owner). Returns true
-- when a row was deleted (we owned it), false otherwise.

create or replace function public.release_model_lock(
  p_race_id uuid,
  p_owner text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.model_run_locks
  where race_id = p_race_id and owner = p_owner;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

-- The app calls these via the service-role key (server-side only).
grant execute on function public.try_acquire_model_lock(uuid, text, integer) to service_role;
grant execute on function public.release_model_lock(uuid, text) to service_role;
