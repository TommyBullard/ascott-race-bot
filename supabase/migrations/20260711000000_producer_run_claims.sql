-- Migration: producer_run_claims — day-level, FAIL-CLOSED producer ownership
-- (Nationwide rebuild, Phase 7A.2b Step 1).
--
-- ADDITIVE ONLY + NOT YET WIRED. This migration creates the claim table and
-- three RPCs that will let a future producer (pipeline:day / pipeline:watch /
-- a nationwide supervisor) prove EXCLUSIVE ownership of one race date's ENTIRE
-- provider/model domain before making any Racing API / Betfair call or model
-- run. Nothing in the app calls these functions yet — this migration is schema
-- + RPC foundation only. No model maths, staking, confidence, recommendation,
-- lock, or settlement behaviour changes. Decision-support only; this table
-- records producer ownership, never a bet or an order.
--
-- WHY A SEPARATE MECHANISM FROM model_run_locks (20260618050000): that table
-- protects ONE race's model_runs insert and is deliberately FAIL-OPEN (a
-- missing table/RPC lets the run proceed unprotected — an acceptable, bounded
-- risk for a single race). A day-level producer collision is unbounded: two
-- processes both calling nationwide racecard/odds routes and running the model
-- for 50+ races. This table is therefore FAIL-CLOSED by design — the caller
-- (once wired, in a future phase) must refuse to proceed when ownership cannot
-- be proved, rather than degrading to unprotected operation.
--
-- OWNERSHIP DOMAIN: one row PER RACE DATE (not per scope). The requested scope
-- ('all-uk-ire' or 'course:<normalised-course>', using the app's existing
-- normalizeCourse rule — see src/lib/raceSync.ts) is stored as metadata on
-- that same row. This makes the conservative conflict policy — EVERY scope
-- conflicts with every other scope for one date, because every producer
-- invocation still calls the nationwide racecard/odds routes regardless of its
-- visible model scope — atomically trivial: a second claim of ANY scope for an
-- already-claimed date is just a second INSERT racing the same primary key.
--
-- LEASE MECHANICS mirror model_run_locks exactly (TTL lease row, not a
-- session/advisory lock, so it survives PostgREST's stateless pooled
-- connections and self-heals via TTL expiry after a crash):
--   - try_acquire_producer_claim : insert, OR steal an EXPIRED lease, OR
--     (same owner_id) idempotently RENEW its own still-live lease exactly like
--     a heartbeat. A live lease held by a DIFFERENT owner is refused; the
--     current holder's identity is always returned so the caller can log who
--     holds it.
--   - heartbeat_producer_claim   : owner-scoped renewal within a cycle.
--   - release_producer_claim     : owner-scoped delete (graceful shutdown).
--
-- NEVER STORES: secrets, provider credentials, environment-variable values,
-- full command lines, or personal information. hostname/pid/app_version/mode
-- are short, optional, operator-facing scalars only.
--
-- MUTABLE BY DESIGN (unlike locked_race_decisions): this is live operational
-- state, not an immutable audit record, so there is no append-only trigger.
--
-- IDEMPOTENT + GUARDED: create table/index use IF NOT EXISTS; functions use
-- CREATE OR REPLACE; revoke/RLS statements are safely re-runnable.
--
-- Run in the Supabase SQL editor (or via operator-run `supabase db push`).
-- This migration is DRAFTED ONLY as part of Phase 7A.2b Step 1 planning/build
-- and has not been applied to any database by the assistant.

create table if not exists public.producer_run_claims (
  race_date     date not null primary key,
  -- 'all-uk-ire' or 'course:<normalizeCourse output>' — descriptive metadata;
  -- the PRIMARY KEY (race_date alone) is what actually enforces exclusivity.
  scope         text not null,
  -- Opaque per-process id (e.g. a UUID) that currently holds this date.
  owner_id      text not null check (length(owner_id) > 0),
  claimed_at    timestamptz not null default now(),
  heartbeat_at  timestamptz not null default now(),
  expires_at    timestamptz not null,

  -- Safe, optional operator-facing metadata only — never a secret or command line.
  hostname      text,
  pid           integer,
  app_version   text,
  mode          text,

  constraint producer_run_claims_scope_valid check (
    scope = 'all-uk-ire' or scope ~ '^course:[a-z0-9]+( [a-z0-9]+)*$'
  ),
  constraint producer_run_claims_expiry_after_claim check (expires_at > claimed_at),
  constraint producer_run_claims_heartbeat_not_before_claim check (heartbeat_at >= claimed_at)
);

-- Cheap even at one row per historical date; supports a future manual cleanup
-- query and any status scan across dates.
create index if not exists idx_producer_run_claims_expires_at
  on public.producer_run_claims (expires_at);

-- ---------------------------------------------------------------------------
-- try_acquire_producer_claim: atomic, NON-BLOCKING, FAIL-CLOSED-BY-ABSENCE claim.
-- ---------------------------------------------------------------------------
-- Inserts a fresh claim, OR (on conflict) either:
--   (a) steals an EXPIRED claim (any owner), or
--   (b) RENEWS the caller's own still-live claim (same owner_id) — idempotent,
--       identical in effect to heartbeat_producer_claim.
-- A live claim held by a DIFFERENT owner is left untouched (conflict WHERE is
-- false -> no row updated -> acquired=false). The current row's identity is
-- ALWAYS returned (whether acquired or not) so a rejected caller can log
-- exactly who holds the date and under what scope.
--
-- Returns jsonb:
--   { "acquired": bool, "stole_expired": bool,
--     "current_owner_id": text, "current_scope": text,
--     "current_expires_at": timestamptz }

create or replace function public.try_acquire_producer_claim(
  p_race_date   date,
  p_scope       text,
  p_owner_id    text,
  p_ttl_seconds integer default 240,
  p_hostname    text default null,
  p_pid         integer default null,
  p_app_version text default null,
  p_mode        text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now      timestamptz := now();
  v_ttl      interval := make_interval(secs => greatest(p_ttl_seconds, 1));
  v_existing public.producer_run_claims;
  v_result   public.producer_run_claims;
  v_acquired boolean := false;
  v_stole    boolean := false;
begin
  -- Fast path: no row for this date yet -> plain insert. ON CONFLICT DO
  -- NOTHING closes the race where two callers both see "no row" at once; the
  -- loser falls through to the contended path below, which re-reads under a
  -- row lock so the decision is atomic per date.
  insert into public.producer_run_claims (
    race_date, scope, owner_id, claimed_at, heartbeat_at, expires_at,
    hostname, pid, app_version, mode
  ) values (
    p_race_date, p_scope, p_owner_id, v_now, v_now, v_now + v_ttl,
    p_hostname, p_pid, p_app_version, p_mode
  )
  on conflict (race_date) do nothing
  returning * into v_result;

  if v_result.race_date is not null then
    return jsonb_build_object(
      'acquired', true, 'stole_expired', false,
      'current_owner_id', v_result.owner_id,
      'current_scope', v_result.scope,
      'current_expires_at', v_result.expires_at
    );
  end if;

  -- Contended path: a row already exists. Lock it so concurrent callers for
  -- the SAME date serialise on this decision (the loser blocks here until the
  -- winner's transaction commits, then re-reads the fresh row).
  select * into v_existing
  from public.producer_run_claims
  where race_date = p_race_date
  for update;

  if v_existing.owner_id = p_owner_id then
    -- Same owner re-claiming: idempotent renewal, identical to a heartbeat.
    update public.producer_run_claims
      set scope = p_scope, heartbeat_at = v_now, expires_at = v_now + v_ttl,
          hostname = p_hostname, pid = p_pid, app_version = p_app_version, mode = p_mode
    where race_date = p_race_date
    returning * into v_result;
    v_acquired := true;

  elsif v_existing.expires_at <= v_now then
    -- A different owner's claim has EXPIRED: steal it atomically.
    update public.producer_run_claims
      set scope = p_scope, owner_id = p_owner_id,
          claimed_at = v_now, heartbeat_at = v_now, expires_at = v_now + v_ttl,
          hostname = p_hostname, pid = p_pid, app_version = p_app_version, mode = p_mode
    where race_date = p_race_date
    returning * into v_result;
    v_acquired := true;
    v_stole := true;

  else
    -- A different owner holds a LIVE claim: refuse. Report exactly who holds it.
    v_result := v_existing;
  end if;

  return jsonb_build_object(
    'acquired', v_acquired,
    'stole_expired', v_stole,
    'current_owner_id', v_result.owner_id,
    'current_scope', v_result.scope,
    'current_expires_at', v_result.expires_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- heartbeat_producer_claim: OWNER-SCOPED renewal within an active cycle.
-- ---------------------------------------------------------------------------
-- Renews expires_at only when the caller still owns the row. renewed=false
-- (with NO error) is a clean, CONFIRMED signal that this owner no longer holds
-- the date — distinct from an RPC-level error (mechanism unavailable).
--
-- Returns jsonb: { "renewed": bool, "expires_at": timestamptz | null }

create or replace function public.heartbeat_producer_claim(
  p_race_date   date,
  p_owner_id    text,
  p_ttl_seconds integer default 240
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now  timestamptz := now();
  v_row  public.producer_run_claims;
begin
  update public.producer_run_claims
    set heartbeat_at = v_now,
        expires_at = v_now + make_interval(secs => greatest(p_ttl_seconds, 1))
  where race_date = p_race_date and owner_id = p_owner_id
  returning * into v_row;

  if v_row.race_date is null then
    return jsonb_build_object('renewed', false, 'expires_at', null);
  end if;
  return jsonb_build_object('renewed', true, 'expires_at', v_row.expires_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- release_producer_claim: OWNER-SCOPED release (graceful shutdown only).
-- ---------------------------------------------------------------------------
-- Deletes the claim only when the caller still owns it — a claim already
-- stolen by another owner after TTL expiry is NOT released by the old owner.
-- Returns true iff a row was deleted (we owned it).

create or replace function public.release_producer_claim(
  p_race_date date,
  p_owner_id  text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.producer_run_claims
  where race_date = p_race_date and owner_id = p_owner_id;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

-- The app calls these via the service-role key (server-side only).
grant execute on function public.try_acquire_producer_claim(date, text, text, integer, text, integer, text, text) to service_role;
grant execute on function public.heartbeat_producer_claim(date, text, integer) to service_role;
grant execute on function public.release_producer_claim(date, text) to service_role;

-- ---------------------------------------------------------------------------
-- Access: service-role only (same posture as locked_race_decisions).
-- ---------------------------------------------------------------------------
-- Remove default grants from the public-facing API roles, then enable RLS
-- with NO policies: anon/authenticated get deny-all; service_role bypasses
-- RLS, so server-side operation (and the diagnostic CLI, which uses the
-- service-role key) is unaffected. There is no client/browser read path to
-- this table.

revoke all on table public.producer_run_claims from anon, authenticated;
alter table public.producer_run_claims enable row level security;

-- ---------------------------------------------------------------------------
-- Safe cleanup (documented, NEVER run automatically — no cron in this phase):
--   delete from public.producer_run_claims
--   where expires_at < now() - interval '30 days';
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- ROLLBACK (documented, not applied by this migration):
--   drop function if exists public.try_acquire_producer_claim(date, text, text, integer, text, integer, text, text);
--   drop function if exists public.heartbeat_producer_claim(date, text, integer);
--   drop function if exists public.release_producer_claim(date, text);
--   drop table if exists public.producer_run_claims;
-- ---------------------------------------------------------------------------
