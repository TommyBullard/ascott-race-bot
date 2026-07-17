-- Migration: producer_run_claims — day-level, FAIL-CLOSED producer ownership
-- (Nationwide rebuild, Phase 7A.2b Step 1, hardened per the independent
-- Producer Ownership Safety Review).
--
-- ADDITIVE ONLY + NOT YET WIRED. This migration creates the claim table and
-- four RPCs that will let a future producer (pipeline:day / pipeline:watch /
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
-- LEASE MECHANICS mirror model_run_locks (TTL lease row, not a session/
-- advisory lock, so it survives PostgREST's stateless pooled connections and
-- self-heals via TTL expiry after a crash), hardened with:
--   - GENERATION (fencing token): increments ONLY when an expired claim is
--     stolen by a different owner. Same-owner renewal and heartbeat do NOT
--     increment it. This lets a future caller detect "I resumed after someone
--     else took over" (stale generation) even though owner_id alone cannot
--     always distinguish that from a legitimate re-claim. Enforcement (writers
--     verifying their generation before a persistence-sensitive stage) is
--     DEFERRED to the future supervisor-wiring phase — this migration only
--     tracks and returns the token.
--   - TTL CLAMPING: every RPC accepting a TTL applies
--     `least(greatest(coalesce(p_ttl_seconds, 240), 30), 900)`, so an operator
--     typo (e.g. --ttl-seconds 86400) can never create a day-long,
--     effectively unstealable claim. An explicit SQL NULL or an omitted
--     argument both COALESCE to the 240s default BEFORE clamping — NOT the
--     30s floor — so a direct RPC call that never supplies a TTL behaves
--     identically to one that explicitly passes the default, and agrees
--     exactly with the TypeScript wrapper's own default-then-clamp order.
--   - BOUNDED CONTENDED-PATH RETRY: try_acquire_producer_claim retries its
--     insert-then-lock decision AT MOST ONCE if the row vanishes between the
--     failed INSERT and the SELECT ... FOR UPDATE (a concurrent release). If
--     the row still cannot be established after that one retry, the function
--     returns an explicit, distinguishable "identity indeterminate" result
--     (acquired=false, current_owner_id=null) rather than ever fabricating a
--     silent success or conflating the anomaly with an ordinary refusal
--     (which always carries a real owner_id).
--   - try_acquire_producer_claim : insert, OR steal an EXPIRED lease
--     (generation + 1), OR (same owner_id) idempotently RENEW its own
--     still-live lease exactly like a heartbeat (generation unchanged). A live
--     lease held by a DIFFERENT owner is refused; the current holder's
--     identity is always returned so the caller can log who holds it.
--   - heartbeat_producer_claim   : owner-scoped renewal within a cycle
--     (generation unchanged); returns the current generation.
--   - release_producer_claim     : owner-scoped delete (graceful shutdown).
--   - producer_claim_status      : READ-ONLY. Returns the current claim row
--     (or null) TOGETHER WITH the server's `now()` in one atomic statement, so
--     a diagnostic/dashboard caller can classify live/expired/absent using
--     DATABASE time, never the caller's local clock. Performs no writes.
--
-- NEVER STORES: secrets, provider credentials, environment-variable values,
-- full command lines, or personal information. hostname/pid/app_version/mode
-- are short, optional, operator-facing scalars only, bounded by explicit
-- table CHECK constraints (defense-in-depth alongside the TypeScript
-- sanitisation in src/lib/producerClaim.ts, which a direct RPC caller could
-- otherwise bypass): owner_id 1-128 chars; hostname/app_version/mode <=120
-- chars each (or null); pid null or a positive integer. SQL deliberately does
-- NOT attempt credential-content scanning — that stays a TypeScript concern;
-- these are size/shape bounds only.
--
-- MUTABLE BY DESIGN (unlike locked_race_decisions): this is live operational
-- state, not an immutable audit record, so there is no append-only trigger.
--
-- PRIVILEGES: all four functions are SECURITY DEFINER, which means they run
-- with the DEFINER's privileges regardless of the caller's own row-level
-- access — table RLS alone does NOT protect a SECURITY DEFINER function.
-- PostgreSQL grants EXECUTE on a newly created function to PUBLIC by default.
-- This migration therefore explicitly REVOKES all function privileges from
-- PUBLIC, anon, and authenticated BEFORE granting EXECUTE to service_role
-- only — for every one of the four functions, including the read-only
-- `producer_claim_status` (it exposes owner_id/hostname/pid/app_version/mode,
-- which must never reach a browser, an anon/authenticated Postgres role, or a
-- public application API route). The revoke-then-grant block runs every time
-- this migration is applied, so a re-run always CONVERGES to the intended
-- posture regardless of what a prior run (or Postgres's implicit default)
-- left in place — `CREATE OR REPLACE FUNCTION` does not by itself reset an
-- existing grant. The table itself gets the identical treatment: privileges
-- revoked from PUBLIC, anon, and authenticated, then RLS enabled with no
-- policies for either role (service_role bypasses RLS entirely). Nothing in
-- this migration creates a policy, a public API route, or any browser-side
-- ownership control.
--
-- IDEMPOTENT + GUARDED: create table/index use IF NOT EXISTS; functions use
-- CREATE OR REPLACE; revoke/grant/RLS statements are safely re-runnable.
--
-- Run in the Supabase SQL editor (or via operator-run `supabase db push`).
-- This migration is DRAFTED ONLY as part of Phase 7A.2b Step 1 and has NOT
-- been applied to any database by the assistant.

create table if not exists public.producer_run_claims (
  race_date     date not null primary key,
  -- 'all-uk-ire' or 'course:<normalizeCourse output>' — descriptive metadata;
  -- the PRIMARY KEY (race_date alone) is what actually enforces exclusivity.
  scope         text not null,
  -- Opaque per-process id (e.g. a UUID) that currently holds this date.
  owner_id      text not null,
  -- Fencing token. Starts at 1; increments ONLY on an expired-claim steal by
  -- a different owner. See the migration header for the enforcement-deferred
  -- rationale.
  generation    bigint not null default 1,
  claimed_at    timestamptz not null default now(),
  heartbeat_at  timestamptz not null default now(),
  expires_at    timestamptz not null,

  -- Safe, optional operator-facing metadata only — never a secret or command
  -- line. Size-bounded below as defense-in-depth alongside the TypeScript
  -- sanitisation a direct RPC caller could otherwise bypass.
  hostname      text,
  pid           integer,
  app_version   text,
  mode          text,

  constraint producer_run_claims_scope_valid check (
    scope = 'all-uk-ire' or scope ~ '^course:[a-z0-9]+( [a-z0-9]+)*$'
  ),
  constraint producer_run_claims_owner_id_length check (length(owner_id) between 1 and 128),
  constraint producer_run_claims_generation_positive check (generation >= 1),
  constraint producer_run_claims_expiry_after_claim check (expires_at > claimed_at),
  constraint producer_run_claims_heartbeat_not_before_claim check (heartbeat_at >= claimed_at),
  constraint producer_run_claims_hostname_length check (hostname is null or length(hostname) <= 120),
  constraint producer_run_claims_pid_positive check (pid is null or pid > 0),
  constraint producer_run_claims_app_version_length check (app_version is null or length(app_version) <= 120),
  constraint producer_run_claims_mode_length check (mode is null or length(mode) <= 120)
);

-- Cheap even at one row per historical date; supports a future manual cleanup
-- query and any status scan across dates.
create index if not exists idx_producer_run_claims_expires_at
  on public.producer_run_claims (expires_at);

-- ---------------------------------------------------------------------------
-- try_acquire_producer_claim: atomic, NON-BLOCKING, FAIL-CLOSED-BY-ABSENCE claim.
-- ---------------------------------------------------------------------------
-- Inserts a fresh claim (generation 1), OR (on conflict) either:
--   (a) steals an EXPIRED claim (any owner) — generation := generation + 1, or
--   (b) RENEWS the caller's own still-live claim (same owner_id) — idempotent,
--       identical in effect to heartbeat_producer_claim, generation unchanged.
-- A live claim held by a DIFFERENT owner is left untouched (conflict WHERE is
-- false -> no row updated -> acquired=false). The current row's identity is
-- ALWAYS returned when it can be established (whether acquired or not) so a
-- rejected caller can log exactly who holds the date and under what scope.
--
-- BOUNDED RETRY: if the contended path's `SELECT ... FOR UPDATE` finds no row
-- (the prior holder released concurrently between our failed INSERT and this
-- read), the function retries the whole insert-then-lock decision ONCE more.
-- This is a fixed, bounded loop (at most 2 attempts) — never unbounded. If the
-- row still cannot be established after the retry, the function returns an
-- explicit anomaly result distinguishable from BOTH a normal refusal (which
-- always carries a real current_owner_id) and a malformed response: acquired
-- = false with every current_* field NULL. The TypeScript layer classifies
-- this as `transient_uncertain` (safe to simply retry the whole call), never
-- as a silent success and never conflated with "mechanism unavailable".
--
-- TTL: an omitted argument OR an explicit SQL NULL both resolve to the 240s
-- default, then the result is clamped to [30, 900] seconds regardless of
-- caller input — see the migration header's TTL CLAMPING note.
--
-- Returns jsonb:
--   { "acquired": bool, "stole_expired": bool, "generation": bigint|null,
--     "current_owner_id": text|null, "current_scope": text|null,
--     "current_expires_at": timestamptz|null }

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
  v_ttl      interval := make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 240), 30), 900));
  v_existing public.producer_run_claims;
  v_result   public.producer_run_claims;
  v_acquired boolean := false;
  v_stole    boolean := false;
  v_attempt  integer := 0;
begin
  <<retry>>
  loop
    v_attempt := v_attempt + 1;

    -- Fast path: no row for this date yet -> plain insert. ON CONFLICT DO
    -- NOTHING closes the race where two callers both see "no row" at once; the
    -- loser falls through to the contended path below, which re-reads under a
    -- row lock so the decision is atomic per date.
    insert into public.producer_run_claims (
      race_date, scope, owner_id, generation, claimed_at, heartbeat_at, expires_at,
      hostname, pid, app_version, mode
    ) values (
      p_race_date, p_scope, p_owner_id, 1, v_now, v_now, v_now + v_ttl,
      p_hostname, p_pid, p_app_version, p_mode
    )
    on conflict (race_date) do nothing
    returning * into v_result;

    if v_result.race_date is not null then
      return jsonb_build_object(
        'acquired', true, 'stole_expired', false, 'generation', v_result.generation,
        'current_owner_id', v_result.owner_id,
        'current_scope', v_result.scope,
        'current_expires_at', v_result.expires_at
      );
    end if;

    -- Contended path: a row already exists (or existed a moment ago). Lock it
    -- so concurrent callers for the SAME date serialise on this decision.
    select * into v_existing
    from public.producer_run_claims
    where race_date = p_race_date
    for update;

    if v_existing.race_date is null then
      -- Row vanished between the failed insert and this read (the prior
      -- holder released concurrently). Retry the insert ONCE more; a second
      -- vanish is left as an explicit, honest anomaly rather than looping.
      if v_attempt < 2 then
        continue retry;
      end if;
      return jsonb_build_object(
        'acquired', false, 'stole_expired', false, 'generation', null,
        'current_owner_id', null, 'current_scope', null, 'current_expires_at', null
      );
    end if;

    if v_existing.owner_id = p_owner_id then
      -- Same owner re-claiming: idempotent renewal, identical to a heartbeat.
      -- Generation is UNCHANGED — this is not a takeover.
      update public.producer_run_claims
        set scope = p_scope, heartbeat_at = v_now, expires_at = v_now + v_ttl,
            hostname = p_hostname, pid = p_pid, app_version = p_app_version, mode = p_mode
      where race_date = p_race_date
      returning * into v_result;
      v_acquired := true;

    elsif v_existing.expires_at <= v_now then
      -- A different owner's claim has EXPIRED: steal it atomically.
      -- Generation increments — this IS a takeover, and the fencing token
      -- must change so a stale prior holder can eventually detect it.
      update public.producer_run_claims
        set scope = p_scope, owner_id = p_owner_id,
            generation = v_existing.generation + 1,
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
      'generation', v_result.generation,
      'current_owner_id', v_result.owner_id,
      'current_scope', v_result.scope,
      'current_expires_at', v_result.expires_at
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- heartbeat_producer_claim: OWNER-SCOPED renewal within an active cycle.
-- ---------------------------------------------------------------------------
-- Renews expires_at only when the caller still owns the row (generation is
-- NEVER changed by a heartbeat). renewed=false (with NO error) is a clean,
-- CONFIRMED signal that this owner no longer holds the date — distinct from
-- an RPC-level error (mechanism unavailable). TTL: an omitted argument OR an
-- explicit SQL NULL both resolve to the 240s default, then the result is
-- clamped to [30, 900] seconds regardless of caller input — identical
-- contract to try_acquire_producer_claim.
--
-- Returns jsonb: { "renewed": bool, "generation": bigint|null, "expires_at": timestamptz|null }

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
        expires_at = v_now + make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 240), 30), 900))
  where race_date = p_race_date and owner_id = p_owner_id
  returning * into v_row;

  if v_row.race_date is null then
    return jsonb_build_object('renewed', false, 'generation', null, 'expires_at', null);
  end if;
  return jsonb_build_object('renewed', true, 'generation', v_row.generation, 'expires_at', v_row.expires_at);
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

-- ---------------------------------------------------------------------------
-- producer_claim_status: READ-ONLY. The current claim for a date TOGETHER
-- WITH the database's own `now()`, read atomically in one statement, so a
-- caller can classify live/expired/absent using SERVER time rather than its
-- own (possibly skewed, possibly asleep) local clock. Performs no writes.
-- ---------------------------------------------------------------------------
-- Returns jsonb: { "server_now": timestamptz, "claim": {...} | null }

create or replace function public.producer_claim_status(
  p_race_date date
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_row public.producer_run_claims;
begin
  select * into v_row from public.producer_run_claims where race_date = p_race_date;

  if v_row.race_date is null then
    return jsonb_build_object('server_now', v_now, 'claim', null);
  end if;

  return jsonb_build_object(
    'server_now', v_now,
    'claim', jsonb_build_object(
      'race_date', v_row.race_date,
      'scope', v_row.scope,
      'owner_id', v_row.owner_id,
      'generation', v_row.generation,
      'claimed_at', v_row.claimed_at,
      'heartbeat_at', v_row.heartbeat_at,
      'expires_at', v_row.expires_at,
      'hostname', v_row.hostname,
      'pid', v_row.pid,
      'app_version', v_row.app_version,
      'mode', v_row.mode
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: SECURITY DEFINER functions default to PUBLIC EXECUTE unless
-- explicitly revoked — table RLS alone does NOT protect a SECURITY DEFINER
-- function, since it runs with the DEFINER's privileges regardless of the
-- caller's own row-level access. REVOKE FIRST, then GRANT only to
-- service_role, for every one of the four functions (including the
-- read-only producer_claim_status, which exposes owner_id/hostname/pid/
-- app_version/mode and must never be reachable by anon/authenticated or a
-- browser). This revoke-then-grant block is safely re-runnable and always
-- CONVERGES to the intended posture, even if a prior run — or Postgres's
-- implicit default grant on function creation — left a PUBLIC/anon/
-- authenticated privilege in place.

revoke all on function public.try_acquire_producer_claim(date, text, text, integer, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.heartbeat_producer_claim(date, text, integer) from public, anon, authenticated;
revoke all on function public.release_producer_claim(date, text) from public, anon, authenticated;
revoke all on function public.producer_claim_status(date) from public, anon, authenticated;

-- The app calls these via the service-role key (server-side only).
grant execute on function public.try_acquire_producer_claim(date, text, text, integer, text, integer, text, text) to service_role;
grant execute on function public.heartbeat_producer_claim(date, text, integer) to service_role;
grant execute on function public.release_producer_claim(date, text) to service_role;
grant execute on function public.producer_claim_status(date) to service_role;

-- ---------------------------------------------------------------------------
-- Table access: service-role only (same posture as locked_race_decisions).
-- ---------------------------------------------------------------------------
-- Remove default grants from PUBLIC and the public-facing API roles, then
-- enable RLS with NO policies: PUBLIC/anon/authenticated get deny-all (both
-- via the revoked grant AND via RLS with no policy); service_role bypasses
-- RLS, so server-side operation (and the diagnostic CLI, which uses the
-- service-role key) is unaffected. There is no client/browser read path to
-- this table, and this migration creates no policy, no public API route, and
-- no browser-side ownership control.

revoke all on table public.producer_run_claims from public, anon, authenticated;
alter table public.producer_run_claims enable row level security;

-- ---------------------------------------------------------------------------
-- Safe cleanup (documented, NEVER run automatically — no cron in this phase):
--   delete from public.producer_run_claims
--   where expires_at < now() - interval '30 days';
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- ROLLBACK (documented, not applied by this migration). Drop the RPC
-- functions FIRST, then the table — a function whose signature references
-- the table's rowtype (`public.producer_run_claims`) errors confusingly if
-- called after the table is gone:
--   drop function if exists public.try_acquire_producer_claim(date, text, text, integer, text, integer, text, text);
--   drop function if exists public.heartbeat_producer_claim(date, text, integer);
--   drop function if exists public.release_producer_claim(date, text);
--   drop function if exists public.producer_claim_status(date);
--   drop table if exists public.producer_run_claims;
-- ---------------------------------------------------------------------------
