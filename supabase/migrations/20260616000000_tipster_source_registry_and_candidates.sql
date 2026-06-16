-- Migration: tipster source registry + candidate selections queue (Phase 4A)
--
-- ADDITIVE ONLY. Creates the auditable foundation for automated/semi-automated
-- tipster intelligence WITHOUT scraping and WITHOUT blindly trusting sources.
-- Nothing here touches the model, staking, or the existing `tipster_selections`
-- table that the model reads — candidates live in their OWN table and only ever
-- become live selections through an explicit, operator-driven approval step
-- (scripts/reviewTipsterCandidates.ts). Guarded with IF NOT EXISTS so it is safe
-- to run more than once.
--
-- Run in the Supabase SQL editor (or via `supabase db push`).
--
-- ---------------------------------------------------------------------------
-- 1. tipster_source_registry — the allow-list of tipster sources.
-- ---------------------------------------------------------------------------
-- A source is registered first and is NOT trusted until an operator approves it
-- (is_approved defaults to false — nothing is auto-approved). The approval step
-- for a candidate refuses unless the candidate's source is present here AND
-- approved, so picks can never enter `tipster_selections` from an unvetted feed.
--
-- Columns:
--   id           : surrogate PK.
--   source_label : stable machine label (e.g. 'racing-post-tips'); UNIQUE so it
--                  can be referenced by candidates and stored on selections.
--   source_name  : human-readable name (e.g. 'Racing Post — Tips').
--   source_url   : optional reference URL for provenance.
--   is_approved  : trust flag; FALSE until an operator approves (never auto).
--   notes        : optional operator notes (why approved/rejected, ToS, etc.).
--   created_at   : registration timestamp.
--   approved_at  : when is_approved was last set true (NULL while unapproved).

create table if not exists public.tipster_source_registry (
  id uuid primary key default gen_random_uuid(),
  source_label text not null unique,
  source_name text not null,
  source_url text,
  is_approved boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

-- ---------------------------------------------------------------------------
-- 2. tipster_selection_candidates — the review queue.
-- ---------------------------------------------------------------------------
-- Raw, as-captured tipster picks awaiting human review. The pick is stored in
-- RAW form (course/off_time/horse/tipster names) and resolved to real race /
-- runner rows at APPROVAL time, mirroring the conservative CSV importer — so a
-- candidate can be captured even before the racecard is ingested.
--
-- There is deliberately NO foreign key on source_label -> registry: the queue
-- captures everything (even from a not-yet-registered source), and the approval
-- step enforces that the source is registered AND approved. status defaults to
-- 'pending' and is constrained to the three review states; nothing is approved
-- automatically.
--
-- Columns:
--   id             : surrogate PK.
--   meeting_date   : race meeting date (YYYY-MM-DD), as captured.
--   course         : raw course name, as captured.
--   off_time       : raw off time 'HH:MM', as captured.
--   horse_name     : raw selected horse name, as captured.
--   tipster_name   : raw tipster name, as captured (verbatim, for audit).
--   raw_affiliation: raw tipster affiliation, if any.
--   source_label   : which registered source this pick came from (provenance).
--   source_url     : provenance URL for this specific pick, if available.
--   source_name    : human-readable source name captured with the pick.
--   status         : 'pending' | 'approved' | 'rejected' (defaults to pending).
--   race_id        : resolved race once approved (audit trail; NULL until then).
--   runner_id      : resolved runner once approved (audit trail).
--   tipster_id     : resolved canonical tipster once approved (may stay NULL).
--   reviewed_at    : when the candidate was approved/rejected.
--   review_notes   : optional operator note recorded at review time.
--   created_at     : capture timestamp.

create table if not exists public.tipster_selection_candidates (
  id uuid primary key default gen_random_uuid(),
  meeting_date date,
  course text,
  off_time text,
  horse_name text not null,
  tipster_name text not null,
  raw_affiliation text,
  source_label text,
  source_url text,
  source_name text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  race_id uuid references public.races (id) on delete set null,
  runner_id uuid references public.runners (id) on delete set null,
  tipster_id uuid references public.tipsters (id) on delete set null,
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz not null default now()
);

-- Fast triage of the queue by review state (the script lists by status).
create index if not exists tipster_selection_candidates_status_idx
  on public.tipster_selection_candidates (status);

-- Lookups of a source's candidates (and rollback by source).
create index if not exists tipster_selection_candidates_source_idx
  on public.tipster_selection_candidates (source_label);
