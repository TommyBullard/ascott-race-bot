-- Migration: ML training-example capture store (Phase 6)
--
-- ADDITIVE ONLY + STRICTLY SHADOW. An append-only, queryable training dataset that
-- builds itself: one row per (race, runner) captured automatically once the race
-- settles, holding the pre-off model output (recommendation, model probability,
-- EV, odds, confidence, favourite flag) and the post-race outcome (finish, won,
-- placed, favourite result, BSP/SP).
--
-- HARD INVARIANTS:
--   - SHADOW: this table is NEVER read by the production model and never changes
--     probability, EV, staking, ranking, or any recommendation. It feeds future
--     ML experimentation, model + confidence calibration, and feature-importance
--     analysis only.
--   - LEAKAGE-SEGREGATED: the FEATURE columns are pre-off-known; the LABEL columns
--     (finish_pos, won, placed, favourite_*, bsp_decimal, sp_decimal) are
--     post-race. A trainer must use only the feature columns as inputs.
--   - NEVER FABRICATES: won/placed are NULL until a real finishing position exists.
--
-- Guarded with IF NOT EXISTS so it is safe to run more than once.
-- Run in the Supabase SQL editor (or via `supabase db push`).
--
-- Columns:
--   id                  : surrogate PK.
--   race_id / runner_id : the captured (race, runner) (FKs).
--   model_run_id        : the model run captured (provenance; NULL-safe).
--   meeting_date / course / off_time / model_version / field_size : context.
--   -- FEATURES (pre-off-known) --
--   recommended         : was this runner the staked recommendation (the bet)?
--   recommendation_rank : 1 for the bet, else NULL.
--   model_prob / market_prob / edge / ev / odds / confidence_score / confidence_label
--   is_favourite        : was this the market favourite (shortest price)?
--   -- LABELS (post-race) --
--   finish_pos / won / placed
--   favourite_won / favourite_placed : the race's FAVOURITE outcome (per-row stamp).
--   bsp_decimal / sp_decimal : settle prices — LABELS ONLY.
--   captured_at         : capture timestamp.

create table if not exists public.ml_training_examples (
  id uuid primary key default gen_random_uuid(),
  race_id uuid not null references public.races (id) on delete cascade,
  runner_id uuid not null references public.runners (id) on delete cascade,
  model_run_id uuid references public.model_runs (id) on delete set null,
  meeting_date date,
  course text,
  off_time timestamptz,
  model_version text,
  field_size integer,
  -- features
  recommended boolean not null default false,
  recommendation_rank integer,
  model_prob numeric,
  market_prob numeric,
  edge numeric,
  ev numeric,
  odds numeric,
  confidence_score numeric,
  confidence_label text,
  is_favourite boolean not null default false,
  -- labels
  finish_pos integer,
  won boolean,
  placed boolean,
  favourite_won boolean,
  favourite_placed boolean,
  bsp_decimal numeric,
  sp_decimal numeric,
  captured_at timestamptz not null default now()
);

-- One canonical example per (race, runner); a re-capture REFRESHES it.
create unique index if not exists ml_training_examples_race_runner_uidx
  on public.ml_training_examples (race_id, runner_id);

-- Windowed reads for calibration / importance dashboards.
create index if not exists ml_training_examples_meeting_idx
  on public.ml_training_examples (meeting_date);
