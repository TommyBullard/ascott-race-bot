-- Migration: add audit/versioning fields to model_runs
--
-- Batch B (model-run auditability). Records WHICH model/config/input mode
-- produced each run, so runs are reproducible and auditable. Additive and
-- idempotent (IF NOT EXISTS), following the conventions of the existing schema.
--
-- Run in the Supabase SQL editor (or via `supabase db push` if you use the CLI).
--
-- Columns ADDED by this migration (not known to exist beforehand):
--   probability_engine_version : which probability model produced the scores.
--   staking_engine_version     : which staking model sized the stakes.
--   input_mode                 : 'market_only' | 'market_plus_tipsters' — what
--                                inputs the run actually used.
--   config_json                : per-run config snapshot (reserved; defaults {}).
--   data_quality_flags         : structured degradation flags, e.g.
--                                ['NO_TIPSTER_SELECTIONS']. Never fabricated.
--
-- NOTE on `model_version`:
--   - `model_version` ALREADY EXISTS in the live schema and is written
--     explicitly by the application (see src/lib/runModelForRace.ts, which sets
--     model_version = 'market-v1'). It is therefore intentionally NOT included
--     in the ADD COLUMN block below.
--   - This migration only adds the new audit fields that are not known to
--     exist: probability_engine_version, staking_engine_version, input_mode,
--     config_json, data_quality_flags.
--   - Fresh databases must already include `model_version` in their base schema
--     (or create it separately) — this migration does not create it.

alter table public.model_runs
  add column if not exists probability_engine_version text not null default 'market_implied_v1',
  add column if not exists staking_engine_version text not null default 'fractional_kelly_0_2_v1',
  add column if not exists input_mode text not null default 'market_only',
  add column if not exists config_json jsonb not null default '{}'::jsonb,
  add column if not exists data_quality_flags jsonb not null default '[]'::jsonb;

-- Rollback (manual, if ever needed):
-- alter table public.model_runs
--   drop column if exists probability_engine_version,
--   drop column if exists staking_engine_version,
--   drop column if exists input_mode,
--   drop column if exists config_json,
--   drop column if exists data_quality_flags;
-- (model_version is intentionally NOT dropped — it predates this migration.)
