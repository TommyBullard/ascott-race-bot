-- Migration: dynamic tipster weighting snapshots (Phase 4D)
--
-- ADDITIVE ONLY + DECISION-SUPPORT ONLY. Creates an as-of history of explainable
-- dynamic tipster weights. NOTHING here touches the model, staking, or the
-- `tipster_priors` row the betting path reads. The live model weight
-- (modelProbabilities.ts) is UNCHANGED; this table is an advisory, auditable
-- record the dashboard + audit read. Guarded with IF NOT EXISTS so it is safe to
-- run more than once.
--
-- The weight is produced by the pure src/lib/tipsterDynamicWeight.ts from seven
-- factors (ROI, strike rate, Ascot performance, festival performance, recent
-- form, confidence calibration, sample size) with sample-size shrinkage toward
-- neutral. `effective_weight` is gated by a gradual ramp `ramp_alpha` that
-- defaults to 0 (no betting influence) — see the design doc.
--
-- Run in the Supabase SQL editor (or via `supabase db push`).
--
-- Columns:
--   id                      : surrogate PK.
--   tipster_id              : the canonical tipster this snapshot scores (FK).
--   as_of_date              : snapshot date (YYYY-MM-DD); one row per day/tipster.
--   bets_count              : global settled-bet count N (the shrinkage driver).
--   dynamic_weight          : 0..1 advisory weight after shrinkage (0.5 neutral).
--   raw_skill               : 0..1 composite BEFORE global shrinkage.
--   reliability             : N/(N+K) sample reliability used.
--   coverage                : share of factor weight that was present (0..1).
--   ramp_alpha              : gradual-ramp factor used (0 = no influence).
--   effective_weight        : 0.5 + ramp_alpha*(dynamic_weight-0.5); advisory.
--   roi / strike_rate / recent_roi          : whole-record factor inputs.
--   ascot_roi / ascot_sample_size           : Ascot segment input + its N.
--   festival_roi / festival_sample_size     : festival segment input + its N.
--   calibration_score / calibration_sample_size : calibration input + its N.
--   factors                 : JSON per-factor breakdown (skill, weight, contribution).
--   reasons                 : JSON array of human-readable explanation lines.
--   created_at              : snapshot write timestamp.

create table if not exists public.tipster_dynamic_weights (
  id uuid primary key default gen_random_uuid(),
  tipster_id uuid not null references public.tipsters (id) on delete cascade,
  as_of_date date not null,
  bets_count integer,
  dynamic_weight numeric,
  raw_skill numeric,
  reliability numeric,
  coverage numeric,
  ramp_alpha numeric,
  effective_weight numeric,
  roi numeric,
  strike_rate numeric,
  recent_roi numeric,
  ascot_roi numeric,
  ascot_sample_size integer,
  festival_roi numeric,
  festival_sample_size integer,
  calibration_score numeric,
  calibration_sample_size integer,
  factors jsonb,
  reasons jsonb,
  created_at timestamptz not null default now()
);

-- One snapshot per tipster per day; a re-run REFRESHES rather than duplicates.
create unique index if not exists tipster_dynamic_weights_tipster_date_uidx
  on public.tipster_dynamic_weights (tipster_id, as_of_date);

-- Latest-snapshot lookups for the dashboard/audit.
create index if not exists tipster_dynamic_weights_as_of_idx
  on public.tipster_dynamic_weights (as_of_date);
