-- Migration: race_off_time_observations — immutable evidence for every observed
-- divergence between a stored race off time and the provider's current one
-- (Off-Time Integrity, Phase 1).
--
-- ADDITIVE ONLY. One new table, two new indexes, one guard function + trigger,
-- and ONE new nullable column on model_runs. Nothing is dropped, renamed,
-- backfilled, defaulted or rewritten; no historical row is touched. Applying
-- this migration changes no existing value and no application behaviour on its
-- own.
--
-- WHY. Commit a9ee1cd moved race resolution onto provider identity
-- (src/lib/liveSync.ts:132-147). A card returning the SAME provider_race_id
-- with a CORRECTED off time now reuses the existing races.id and writes nothing
-- (liveSync.ts:282-290), so races.off_time can go stale SILENTLY: the sync
-- summary (liveSync.ts:183-191) counts it as racesExisting++ (:284),
-- indistinguishable from an unchanged race, and that summary is what the route
-- spreads into cron_runs. There is nothing to alarm on today. That one field
-- anchors the model pre-off guard (runModelForRace.ts:303-321 ->
-- modelRunGuard.ts:78-82), the T-minus-5 lock window (lockTMinus.ts:117-138),
-- Betfair matching at +/-90s (liveSync.ts:389-396), results matching by EXACT
-- equality (liveSync.ts:62-72, :541) and every pre-off evaluation selector.
--
-- WHAT THIS DELIBERATELY DOES NOT DO: it does not, and no code shipped with it
-- does, UPDATE races.off_time. Rewriting that column is the dangerous half of
-- the problem, not the fix. Raising a stored off (applying a published delay)
-- would make evaluateModelRunGuard return null on post-race odds, let
-- runModelForRace write an is_current run (runModelForRace.ts:333) that
-- supersedes the genuine pre-off run (:706-713), let classifyLockWindow return
-- in_window so an OFFICIAL IMMUTABLE lock could be built from post-race output
-- (both DB CHECKs at 20260708000000:92-97 compare a lock row only against its
-- own copied off_time_at_lock, so neither can detect that the number is wrong),
-- let selectPreOffRun admit that run (modelPerformance.ts:171-178), and leak it
-- permanently into ml_training_examples via the one-shot watermark
-- (mlCapture.ts:101-106) and into lifetime accuracy via .eq('is_current', true)
-- (raceData.ts:1296-1300).
--
-- SO THE POLICY HAS ONLY ONE DIRECTION. This table stores EVIDENCE. The
-- application derives, per race, an EFFECTIVE off time =
--   min(races.off_time, the k-th earliest corroborated credible observation)
-- and uses it ONLY in the WRITE-SIDE safety guards (the model run guard and the
-- lock window). Read-side evaluation keeps reading races.off_time, which never
-- moves, so no published figure can drift. The effective off is a
-- monotone-DECREASING function of accumulated evidence: it can only ever move
-- EARLIER, so no observation, in any order, at any time, can manufacture a
-- pre-off state. Lowering an off is provably safe for every guard
-- (modelRunGuard.ts:78-82 skips MORE; modelPerformance.ts:171-178 admits FEWER;
-- tMinusCapture.ts:139-154 cuts EARLIER; lockCoverage.ts:83-85 reports
-- lock_missing MORE readily). Raising one is not, and is never performed.
--
-- CLASSIFICATIONS (classification) — an unchanged off is NEVER recorded:
--   earlier_than_stored      : the provider's off is EARLIER than the stored
--                              one. The only classification that may be
--                              tightening_eligible.
--   later_than_stored        : a published delay. RECORDED, never eligible.
--                              The stored earlier off stays in force, which is
--                              today's behaviour and the conservative one.
--   stored_off_unknown       : the stored off is null/unparseable, so there is
--                              nothing to compare. Never eligible - an off is
--                              never invented for a row that never had one.
--   ambiguous_source         : the observed off came from the date + off_time
--                              branch of resolveOffTime (raceSync.ts:195-200),
--                              which forces a documented LOCAL time
--                              (racingApi.ts: 'Local off time, e.g. "13:50"')
--                              to UTC - a one-hour error under British Summer
--                              Time. RECORDED, never eligible.
--   meeting_date_differs     : the card's meeting date differs from the stored
--                              row's. A race that moved DAY is not a race that
--                              has already run. Never eligible.
--   out_of_scope_meeting_date: the card's meeting date differs from the date
--                              the calling route/producer actually owns
--                              (producer_run_claims is keyed race_date PRIMARY
--                              KEY, 20260711000000:112). Never eligible.
--
-- STRUCTURAL, NOT CONVENTIONAL: race_off_time_observations_tightening_is_earlier
-- constrains the ROW AGAINST ITS OWN FIELDS ONLY, so it is a genuine invariant
-- and not a time-of-check window: a row can be tightening_eligible only when it
-- is classified earlier_than_stored, came from off_dt, and its observed instant
-- is strictly earlier than the stored one. A direct SQL writer cannot mark a
-- LATER or an AMBIGUOUS observation as eligible.
--
-- NEVER FABRICATES: stored_off_time is the value actually read back from the
-- row; observed_off_time is resolveOffTime's normalisation of what the provider
-- said. Null means "not recorded". No row is ever written for an unchanged off.
--
-- NO RPC IS REQUIRED, AND ONE IS DELIBERATELY NOT ADDED. This repository does
-- have multi-statement transactional RPCs available (20260711000000:184-195,
-- :215, :239, granted to service_role at :416-425 and called from
-- src/lib/producerClaim.ts:547). One WOULD be mandatory if the application
-- read, decided and then UPDATEd races.off_time - that read-decide-write
-- sequence has no atomicity across PostgREST calls. This design performs a
-- single INSERT and no update at all, and a single INSERT is already atomic, so
-- an RPC would add SECURITY DEFINER surface for no safety gain.
--
-- IMMUTABILITY: same posture as locked_race_decisions. A BEFORE UPDATE OR
-- DELETE trigger raises on every UPDATE, and on DELETE unless the session has
-- opted in via `set local app.off_time_observations_admin = 'on'`. The
-- application NEVER sets that GUC. A trigger (not grants/RLS) because
-- service_role BYPASSES RLS, so this is the only enforcement that also binds
-- the app's own key. Contrast producer_run_claims, which is explicitly "MUTABLE
-- BY DESIGN ... live operational state, not an immutable audit record"
-- (20260711000000:82-83). This IS an audit record.
--
-- IDEMPOTENT + GUARDED: create table/index use IF NOT EXISTS; the function uses
-- CREATE OR REPLACE; the trigger is dropped-if-exists then recreated; the
-- revoke/RLS statements are safely re-runnable. Safe to apply more than once.
--
-- Run in the Supabase SQL editor (or via operator-run `supabase db push`).
-- Decision-support only. Nothing here places, recommends or settles a bet.

create table if not exists public.race_off_time_observations (
  id                        uuid primary key default gen_random_uuid(),
  race_id                   uuid not null references public.races (id),

  -- Provider identity of the card carrying this observation. Text, nullable,
  -- no FK: an external string, never a key (same posture as
  -- races.provider_race_id, 20260816000000:61).
  provider_race_id          text,

  -- races.off_time as READ at observation time. Null only when the stored
  -- column itself was null ("never recorded"). NEVER written back to races.
  stored_off_time           timestamptz,
  -- The provider's off time for this observation, normalised by resolveOffTime.
  observed_off_time         timestamptz not null,
  -- Signed (observed - stored) in whole seconds, stored so no report recomputes
  -- it from two columns. Populated EXACTLY when stored_off_time is populated
  -- (see the delta_matches CHECK). NEGATIVE means the observed off is EARLIER
  -- than the stored one — the only direction that may ever tighten a guard.
  delta_seconds             bigint,

  -- Which raw provider field produced observed_off_time.
  source_field              text not null
                              check (source_field in ('off_dt', 'date_off_time')),

  classification            text not null check (classification in (
                              'earlier_than_stored',
                              'later_than_stored',
                              'stored_off_unknown',
                              'ambiguous_source',
                              'meeting_date_differs',
                              'out_of_scope_meeting_date'
                            )),

  -- May this observation TIGHTEN the effective off used by the write-side
  -- guards? Only ever true for an unambiguous, same-day, strictly EARLIER off.
  tightening_eligible       boolean not null,

  observed_at               timestamptz not null default now(),
  -- Which code path observed it ('racecards_ingest' today). Text so a future
  -- observer is additive rather than a constraint change.
  observer                  text not null check (length(observer) between 1 and 120),

  -- Ownership/scope evidence: the race date the calling producer actually owns.
  scope_meeting_date        date not null,
  -- As-of context, so the row is self-describing without re-reading races.
  stored_meeting_date       date,
  observed_meeting_date     date not null,
  race_status_at_observation text,
  -- Whether a minutes_before = 5 lock existed at observation time. Context for
  -- the audit; it gates nothing, because nothing is ever applied.
  had_official_lock         boolean not null,

  created_at                timestamptz not null default now(),

  -- delta_seconds is populated EXACTLY when stored_off_time is populated.
  --
  -- A biconditional, deliberately: it is the strongest correct invariant. The
  -- application refuses to build a row whose OBSERVED instant is unparseable
  -- (there is nothing to record), and normalises an unparseable STORED value to
  -- null, so the only two shapes that can ever reach this table are "both
  -- present" and "both absent". Anything else is a defect, and this constraint
  -- is where it stops.
  constraint race_off_time_observations_delta_matches check (
    (stored_off_time is null and delta_seconds is null)
    or (stored_off_time is not null and delta_seconds is not null)
  ),

  -- A zero delta is only meaningful for the two DATE-scoped classifications;
  -- every other row is recorded because the instant genuinely differs.
  constraint race_off_time_observations_zero_delta_is_scoped check (
    delta_seconds is null
    or delta_seconds <> 0
    or classification in ('meeting_date_differs', 'out_of_scope_meeting_date')
  ),

  -- STRUCTURAL, and row-local so it is a true invariant: eligibility to tighten
  -- requires an unambiguous, strictly EARLIER observation.
  constraint race_off_time_observations_tightening_is_earlier check (
    tightening_eligible = false
    or (
      classification = 'earlier_than_stored'
      and source_field = 'off_dt'
      and stored_off_time is not null
      and observed_off_time < stored_off_time
    )
  )
);

-- Per-race trail; also the exact shape the effective-off read filters on
-- (race_id, newest first).
create index if not exists race_off_time_observations_race_id_idx
  on public.race_off_time_observations (race_id, observed_at desc);

-- Day/proof queries: observations in a time window by classification (mirrors
-- idx_locked_race_decisions_lock_time, 20260708000000:124-125).
create index if not exists idx_race_off_time_observations_observed_at
  on public.race_off_time_observations (observed_at, classification);

-- ---------------------------------------------------------------------------
-- Append-only guard: UPDATE always blocked; DELETE operator-escape-hatch only.
-- ---------------------------------------------------------------------------
-- UPDATE has NO escape hatch: a mutable provenance record proves nothing.
-- DELETE requires `set local app.off_time_observations_admin = 'on'` in the
-- same transaction (set local cannot leak past it). The app never sets this
-- GUC; it is a manual SQL-editor action documented in the launch schema
-- runbook, mirroring app.locked_decisions_admin.

create or replace function public.race_off_time_observations_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if TG_OP = 'UPDATE' then
    raise exception
      'race_off_time_observations is append-only: UPDATE is never allowed (a mutable provenance record proves nothing)';
  end if;
  if current_setting('app.off_time_observations_admin', true) is distinct from 'on' then
    raise exception
      'race_off_time_observations is append-only: DELETE requires set local app.off_time_observations_admin = ''on'' (operator escape hatch)';
  end if;
  return old;
end;
$$;

drop trigger if exists race_off_time_observations_no_mutate on public.race_off_time_observations;
create trigger race_off_time_observations_no_mutate
  before update or delete on public.race_off_time_observations
  for each row execute function public.race_off_time_observations_guard();

-- ---------------------------------------------------------------------------
-- model_runs: the off time this run was actually JUDGED AGAINST.
-- ---------------------------------------------------------------------------
-- The pre-off guard already SELECTs races.off_time immediately before writing
-- (runModelForRace.ts:303-308) and then discards it; model_runs carries no
-- off-time column at all today (confirmed against
-- 20260615000000_add_model_run_audit_fields.sql, which adds five columns, none
-- of them a time). So it is impossible after the fact to tell what off a run
-- was judged against.
--
-- This column stores the EFFECTIVE off the guard evaluated (races.off_time,
-- tightened by corroborated evidence when any exists) - i.e. the value that
-- actually determined whether the run was written. That makes the pre-off
-- leakage check in src/lib/preOffValidation.ts:405-419 non-tautological for the
-- first time: today it compares the selected run against the SAME
-- races.off_time that scripts/preOffValidation.ts:109 selected with, so it can
-- never fire.
--
-- Nullable, no default, NO backfill: null means "predates capture", never a
-- value. Read-only evidence in this phase - no selector changes behaviour on it.
alter table public.model_runs add column if not exists off_time_at_run timestamptz;

-- ---------------------------------------------------------------------------
-- Access: service-role only (strictest form, per producer_run_claims:438-439).
-- ---------------------------------------------------------------------------
-- Remove default grants from PUBLIC and the public-facing API roles, then
-- enable RLS with NO policies: PUBLIC/anon/authenticated get deny-all (both via
-- the revoked grant AND via RLS with no policy); service_role bypasses RLS, so
-- server-side operation is unaffected. There is no client/browser read path to
-- this table, and this migration creates no policy and no public API route.

revoke all on table public.race_off_time_observations from public, anon, authenticated;
alter table public.race_off_time_observations enable row level security;

comment on column public.race_off_time_observations.stored_off_time is
  'races.off_time as read at observation time. Null only when the stored column was null. This programme never writes races.off_time back.';
comment on column public.race_off_time_observations.observed_off_time is
  'Provider off time for this observation, normalised by resolveOffTime. Recorded as evidence, never applied to races.';
comment on column public.race_off_time_observations.classification is
  'What the observation was. Only earlier_than_stored may tighten the effective off; a published delay (later_than_stored) is recorded and never applied.';
comment on column public.race_off_time_observations.tightening_eligible is
  'May this row lower the effective off used by the write-side guards? True only for an unambiguous, same-day, strictly earlier off_dt observation (enforced by CHECK).';
comment on column public.race_off_time_observations.source_field is
  'Which provider field produced observed_off_time. date_off_time is the ambiguous local-forced-to-UTC branch (raceSync.ts:195-200) and is never eligible.';
comment on column public.race_off_time_observations.scope_meeting_date is
  'The race date the calling producer actually owns (producer_run_claims is keyed race_date). A card outside it is recorded out_of_scope_meeting_date and never eligible.';
comment on column public.race_off_time_observations.had_official_lock is
  'Whether a minutes_before = 5 locked_race_decisions row existed at observation time. Audit context only; it gates nothing, because nothing is ever applied.';
comment on column public.model_runs.off_time_at_run is
  'The effective off time this run was judged against by the pre-off guard, for as-of reconstruction and leakage checking. Null on runs predating capture; never backfilled.';

-- ---------------------------------------------------------------------------
-- ROLLBACK (documented, NOT executed - the function is dropped before the
-- table, since the trigger depends on it):
--   drop trigger if exists race_off_time_observations_no_mutate on public.race_off_time_observations;
--   drop function if exists public.race_off_time_observations_guard();
--   drop table if exists public.race_off_time_observations;
--   alter table public.model_runs drop column if exists off_time_at_run;
-- ---------------------------------------------------------------------------
