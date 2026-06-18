-- Migration: Tipster Discovery Engine (Phase 4C)
--
-- ADDITIVE ONLY. Creates the auditable foundation for DISCOVERING publicly
-- available racing tipsters (profiles, not per-race picks) into review tables.
-- Nothing here touches the model, staking, or the `tipster_selections` table the
-- model reads. Discovered profiles land in their OWN review table and only ever
-- become canonical tipsters through an explicit, operator-driven approval step —
-- and even then they are created INACTIVE (is_active stays false). Discovery
-- NEVER flips a tipster to model-active. Guarded with IF NOT EXISTS so it is safe
-- to run more than once.
--
-- Relationship to the existing Phase 4A/4B tables:
--   - tipster_source_registry        : the SAME allow-list governs discovery
--                                      sources; two additive columns below mark
--                                      which sources support discovery + when
--                                      they were last crawled.
--   - tipster_selection_candidates   : per-PICK review queue (one horse in one
--                                      race). UNCHANGED.
--   - tipster_discovery_candidates   : per-PROFILE review queue (a tipster and
--                                      their track record). NEW, created here.
--
-- Run in the Supabase SQL editor (or via `supabase db push`).
--
-- ---------------------------------------------------------------------------
-- 1. tipster_source_registry — additive discovery metadata.
-- ---------------------------------------------------------------------------
-- supports_discovery : operator opt-in flag; a source is only crawled by the
--                      discovery engine when this is true AND is_approved is true
--                      (approval still gates everything). Defaults false.
-- last_discovered_at : bookkeeping timestamp of the last discovery run for the
--                      source (NULL until first crawled). Provenance only.

alter table public.tipster_source_registry
  add column if not exists supports_discovery boolean not null default false,
  add column if not exists last_discovered_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. tipster_discovery_runs — provenance of each discovery execution.
-- ---------------------------------------------------------------------------
-- One row per run of the discovery engine, so every captured candidate can be
-- traced back to exactly when/how it was found and with which analysis windows.
-- Nothing here is consumed by the model; it is an audit trail.
--
-- Columns:
--   id                 : surrogate PK.
--   source_label       : which registered source was crawled (provenance).
--   started_at         : run start timestamp.
--   finished_at        : run end timestamp (NULL while in progress / on failure).
--   long_window_days   : long-run analysis window used (e.g. 365), for audit.
--   recent_window_days : recent (momentum) window used (e.g. 30), for audit.
--   profiles_found     : raw profiles returned by the source this run.
--   candidates_new     : discovery candidates inserted this run.
--   candidates_updated : existing candidates refreshed this run.
--   dry_run            : true when the run computed but wrote no candidate rows.
--   notes              : optional free-text run notes.

create table if not exists public.tipster_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  source_label text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  long_window_days integer,
  recent_window_days integer,
  profiles_found integer not null default 0,
  candidates_new integer not null default 0,
  candidates_updated integer not null default 0,
  dry_run boolean not null default true,
  notes text
);

create index if not exists tipster_discovery_runs_source_idx
  on public.tipster_discovery_runs (source_label);

-- ---------------------------------------------------------------------------
-- 3. tipster_discovery_candidates — discovered PROFILES awaiting review.
-- ---------------------------------------------------------------------------
-- A discovered tipster and their (verbatim, never-fabricated) track record. The
-- row is captured in REVIEW state only; an operator later promotes it to a real
-- `tipsters` row (created INACTIVE) and/or rejects/watchlists it. There is
-- deliberately NO foreign key on source_label -> registry (the queue captures
-- everything; the approval step enforces the source is registered + approved).
--
-- Metrics are ALL nullable: a source contributes only the figures it actually
-- published. Missing figures stay NULL — they are never invented. The advisory
-- confidence columns are triage aids ONLY and are NOT read by the model.
--
-- Columns:
--   id                  : surrogate PK.
--   discovery_run_id    : the run that captured/last-updated this candidate.
--   source_label        : which source surfaced the profile (provenance).
--   source_url          : provenance URL for the listing/leaderboard.
--   discovered_name     : tipster name exactly as published (verbatim, audit).
--   normalized_name     : lower/trimmed/space-collapsed name for dedup only.
--   raw_affiliation     : tipster affiliation as published, if any.
--   profile_url         : link to the tipster's profile/proofing page, if any.
--   tipster_id          : canonical tipster this profile resolves to, when it
--                         already exists (link only; does NOT make it active).
--   status              : 'pending'|'approved'|'rejected'|'watchlist'
--                         (defaults to pending; nothing is approved automatically).
--   sample_size         : settled bets/selections N behind the record.
--   strike_rate         : win strike rate (wins / bets), 0..1.
--   roi                 : long-run ROI fraction (0.12 = +12%).
--   roi_recent          : recent-window ROI fraction (momentum).
--   winner_rate         : winners / bets, 0..1 (often equals strike_rate).
--   placed_rate         : placed / bets, 0..1.
--   last_seen_date      : date of the most recent recorded selection (recency).
--   recency_days        : days between last_seen_date and capture (derived).
--   discovery_confidence: advisory 0..100 triage score (NOT a model input).
--   confidence_tier     : 'tier_1_candidate'|'watchlist'|'reject_or_research_more'.
--   confidence_reasons  : JSON array explaining the score (audit/triage).
--   first_seen_at       : when this profile was first captured.
--   last_seen_at        : when this profile was last refreshed by a run.
--   reviewed_at         : when an operator approved/rejected/watchlisted it.
--   review_notes        : optional operator note recorded at review time.

create table if not exists public.tipster_discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  discovery_run_id uuid references public.tipster_discovery_runs (id) on delete set null,
  source_label text,
  source_url text,
  discovered_name text not null,
  normalized_name text not null,
  raw_affiliation text,
  profile_url text,
  tipster_id uuid references public.tipsters (id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'watchlist')),
  sample_size integer,
  strike_rate numeric,
  roi numeric,
  roi_recent numeric,
  winner_rate numeric,
  placed_rate numeric,
  last_seen_date date,
  recency_days integer,
  discovery_confidence numeric,
  confidence_tier text,
  confidence_reasons jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  reviewed_at timestamptz,
  review_notes text
);

-- Idempotency + dedup: one candidate row per (source, normalised name). A
-- re-run REFRESHES the existing row (metrics/confidence) instead of duplicating.
create unique index if not exists tipster_discovery_candidates_source_name_uidx
  on public.tipster_discovery_candidates (source_label, normalized_name);

-- Fast triage of the queue by review state.
create index if not exists tipster_discovery_candidates_status_idx
  on public.tipster_discovery_candidates (status);

-- Lookups of an already-canonical tipster's discovered profiles.
create index if not exists tipster_discovery_candidates_tipster_idx
  on public.tipster_discovery_candidates (tipster_id);
