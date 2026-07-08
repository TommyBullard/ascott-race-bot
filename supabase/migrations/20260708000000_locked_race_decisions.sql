-- Migration: locked_race_decisions — immutable T-minus official race-day
-- decisions (Newmarket rebuild, Phase 1).
--
-- ADDITIVE ONLY + RUNTIME-UNUSED. This migration creates the append-only table
-- that will become the OFFICIAL source of truth for race-day decisions and
-- performance evaluation: one immutable snapshot per race per capture horizon,
-- taken at T-minus-N before the off (minutes_before = 5 is the official
-- horizon). NOTHING in the app reads or writes this table yet (Phase 1 is the
-- schema foundation only); no model maths, recommendation selection, dashboard,
-- or settlement behaviour changes. Decision-support only — this table records
-- decisions for research and evaluation; it never places bets and has no
-- betting/order semantics.
--
-- WHY: the current "final pre-off run" rule is a fallback that re-derives the
-- decision at read time. A locked row is written once, pre-off, and can never
-- be changed by a post-off rerun — so accuracy/ROI are always evaluated against
-- what the operator actually saw before the race.
--
-- DECISION STATES (decision_status):
--   locked_pick      : the captured run had a rank-1 recommendation (the pick
--                      columns record it; the full snapshot lives in locked_state).
--   locked_no_bet    : the captured run existed but made no rank-1 recommendation
--                      (no_bet_reason is REQUIRED — the profit/no-bet gate verdict).
--   no_run_available : no model run existed at or before the capture target when
--                      the lock window closed. model_run_id and all pick columns
--                      are null. This is an honest "we could not decide" record —
--                      it is NOT a no-bet and NOT a loss.
--
-- NEVER FABRICATES: every pick/observability column is nullable (or defaults to
-- an empty array); null means "not recorded at lock time", never an invented
-- value. locked_state preserves the full capture JSON verbatim.
--
-- IMMUTABILITY: a BEFORE UPDATE OR DELETE trigger raises on every UPDATE, and on
-- DELETE unless the session has explicitly opted in via
--   set local app.locked_decisions_admin = 'on';
-- The application NEVER sets that GUC — it exists solely so a human operator can
-- perform test cleanup or a documented pre-off recovery in the SQL editor. A
-- trigger (not grants/RLS) is used because service_role BYPASSES RLS, so this is
-- the only enforcement that also binds the app's own key.
--
-- IDEMPOTENT + GUARDED: create table/index use IF NOT EXISTS; the function uses
-- CREATE OR REPLACE; the trigger is dropped-if-exists then recreated; the
-- revoke/RLS statements are safely re-runnable. Safe to apply more than once.
--
-- Run in the Supabase SQL editor (or via operator-run `supabase db push`).

create table if not exists public.locked_race_decisions (
  id                  uuid primary key default gen_random_uuid(),
  race_id             uuid not null references public.races (id),
  -- Nullable: a no_run_available record has no source run. Default NO ACTION
  -- (restrict-like) on both FKs: purging a race/run under a lock fails loudly.
  model_run_id        uuid references public.model_runs (id),
  lock_time           timestamptz not null default now(),
  minutes_before      integer not null default 5 check (minutes_before > 0),
  -- races.off_time AS KNOWN AT LOCK TIME (auditable if the off later moves).
  off_time_at_lock    timestamptz not null,
  -- off_time_at_lock - minutes_before, stored for proof/reporting; the CHECK
  -- below guarantees it can never drift from the recomputation.
  capture_target_time timestamptz not null,

  decision_status     text not null check (decision_status in
                        ('locked_pick', 'locked_no_bet', 'no_run_available')),
  no_bet_reason       text,

  -- Promoted pick columns (locked_pick only). Null = not recorded, never invented.
  pick_runner_id        uuid references public.runners (id),
  pick_horse_name       text,
  pick_odds             numeric,
  pick_ev               numeric,
  pick_model_prob       numeric,
  pick_market_prob      numeric,
  pick_stake            numeric,
  pick_confidence_label text,

  -- Promoted observability columns (also preserved verbatim in locked_state).
  run_quality                text,
  data_quality_flags         jsonb not null default '[]'::jsonb,
  data_quality_short_summary text,
  tipster_short_summary      text,
  tipster_alignment_label    text,

  -- Canonical full snapshot (the T-minus capture JSON for the race).
  locked_state                jsonb not null,
  locked_state_schema_version integer not null default 1,
  created_at                  timestamptz not null default now(),

  -- One lock per race PER CAPTURE HORIZON. minutes_before = 5 is the official
  -- decision; other horizons (e.g. 10, 2) are research captures.
  constraint locked_race_decisions_one_per_horizon unique (race_id, minutes_before),

  -- SAFETY: a lock row can never be created post-off.
  constraint locked_pre_off check (lock_time <= off_time_at_lock),

  -- The stored capture window is internally consistent, always.
  constraint capture_target_consistent check (
    capture_target_time = off_time_at_lock - make_interval(mins => minutes_before)
  ),

  -- A real lock references its source run; a missing-run record must not.
  constraint run_matches_status check (
    (decision_status = 'no_run_available' and model_run_id is null)
    or (decision_status in ('locked_pick', 'locked_no_bet') and model_run_id is not null)
  ),

  -- Pick columns only on locked_pick.
  constraint pick_matches_status check (
    decision_status = 'locked_pick' or pick_runner_id is null
  ),

  -- no_bet_reason REQUIRED on locked_no_bet, forbidden otherwise.
  constraint reason_matches_status check (
    (decision_status = 'locked_no_bet' and no_bet_reason is not null)
    or (decision_status <> 'locked_no_bet' and no_bet_reason is null)
  ),

  -- Flags are a JSON array (matches the model_runs convention), never null.
  constraint data_quality_flags_is_array check (
    jsonb_typeof(data_quality_flags) = 'array'
  )
);

-- Day/proof queries: locks in a time window by status. The official per-race
-- lookup (race_id, minutes_before) is covered by the unique constraint's index.
create index if not exists idx_locked_race_decisions_lock_time
  on public.locked_race_decisions (lock_time, decision_status);

-- ---------------------------------------------------------------------------
-- Append-only guard: UPDATE always blocked; DELETE operator-escape-hatch only.
-- ---------------------------------------------------------------------------
-- UPDATE has NO escape hatch: there is no legitimate edit to an official
-- decision — corrections are "flag it in evaluation", never "rewrite history".
-- DELETE requires `set local app.locked_decisions_admin = 'on'` in the same
-- transaction (set local cannot leak past it). The app never sets this GUC; it
-- is a manual SQL-editor action documented in the launch schema runbook.

create or replace function public.locked_race_decisions_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if TG_OP = 'UPDATE' then
    raise exception
      'locked_race_decisions is append-only: UPDATE is never allowed (official locked decisions are immutable)';
  end if;
  if current_setting('app.locked_decisions_admin', true) is distinct from 'on' then
    raise exception
      'locked_race_decisions is append-only: DELETE requires set local app.locked_decisions_admin = ''on'' (operator escape hatch)';
  end if;
  return old;
end;
$$;

drop trigger if exists locked_race_decisions_no_mutate on public.locked_race_decisions;
create trigger locked_race_decisions_no_mutate
  before update or delete on public.locked_race_decisions
  for each row execute function public.locked_race_decisions_guard();

-- ---------------------------------------------------------------------------
-- Access: service-role only (same posture as 20260618060000_rls_harden_...).
-- ---------------------------------------------------------------------------
-- Remove the Supabase default grants from the public-facing API roles, then
-- enable RLS with NO policies: anon/authenticated get deny-all; service_role
-- bypasses RLS, so server-side operation is unaffected. The dashboard reads
-- only via server-side API routes and never gets a write path to this table.

revoke all on table public.locked_race_decisions from anon, authenticated;
alter table public.locked_race_decisions enable row level security;
