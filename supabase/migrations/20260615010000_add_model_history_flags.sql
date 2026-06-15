-- Migration: append-only model history (is_current / superseded_at)
--
-- Batch C. Preserves historical model output instead of deleting/replacing it.
-- Adds a "current row" marker and a supersession timestamp to the three model
-- output tables, plus partial-friendly composite indexes so the common
-- "current rows for a race / run" reads stay fast as history accumulates.
--
-- Additive and idempotent (IF NOT EXISTS), following the existing schema
-- conventions. EXISTING ROWS: the `default true` backfills every current row to
-- is_current = true (superseded_at NULL), so reader behaviour is unchanged the
-- moment this is applied — they are, correctly, the current rows.
--
-- Run in the Supabase SQL editor (or via `supabase db push` if you use the CLI).

alter table public.model_runs
  add column if not exists is_current boolean not null default true,
  add column if not exists superseded_at timestamptz;

alter table public.model_runner_scores
  add column if not exists is_current boolean not null default true,
  add column if not exists superseded_at timestamptz;

alter table public.recommendations
  add column if not exists is_current boolean not null default true,
  add column if not exists superseded_at timestamptz;

-- Indexes for the "current output" read paths.
--   model_runs           : latest current run per race (fetchRaceRecommendations,
--                          fetchRaceCard, computeModelAccuracy).
--   model_runner_scores  : current scores for a run (joined by model_run_id;
--                          this table has no race_id of its own).
--   recommendations      : current recommendation(s) per race (has race_id).
create index if not exists model_runs_race_current_idx
  on public.model_runs (race_id, is_current);
create index if not exists model_runner_scores_run_current_idx
  on public.model_runner_scores (model_run_id, is_current);
create index if not exists recommendations_race_current_idx
  on public.recommendations (race_id, is_current);

-- Rollback (manual, if ever needed):
-- drop index if exists public.model_runs_race_current_idx;
-- drop index if exists public.model_runner_scores_run_current_idx;
-- drop index if exists public.recommendations_race_current_idx;
-- alter table public.model_runs
--   drop column if exists is_current, drop column if exists superseded_at;
-- alter table public.model_runner_scores
--   drop column if exists is_current, drop column if exists superseded_at;
-- alter table public.recommendations
--   drop column if exists is_current, drop column if exists superseded_at;
