-- Migration: cron heartbeat / run log (Phase 5 monitoring)
--
-- ADDITIVE ONLY + DECISION-SUPPORT. Records one row per automated cron run so the
-- health dashboard can show whether each job (racecards / odds / model / results /
-- tipster-discovery) is alive, on cadence, and succeeding. NOTHING here affects
-- the model, staking, or any recommendation; it is a monitoring/audit log only.
-- The recorder is best-effort (a failed insert never breaks a cron). Guarded with
-- IF NOT EXISTS so it is safe to run more than once.
--
-- SECURITY: `error` stores only the error MESSAGE (job name + provider response
-- text, never secret values), matching the cron diagnostics policy.
--
-- Run in the Supabase SQL editor (or via `supabase db push`).
--
-- Columns:
--   id           : surrogate PK.
--   job          : the cron job name (e.g. 'odds', 'model', 'results').
--   started_at   : when the run began.
--   finished_at  : when the run ended (success or failure).
--   duration_ms  : wall-clock duration (>= 0).
--   ok           : true on success, false on failure.
--   http_status  : the HTTP status the route returned, when known.
--   counts       : JSON of the run's numeric outputs (rows written, etc.).
--   error        : error message on failure (secret-safe), else NULL.
--   created_at   : insert timestamp.

create table if not exists public.cron_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  duration_ms integer,
  ok boolean not null,
  http_status integer,
  counts jsonb,
  error text,
  created_at timestamptz not null default now()
);

-- Latest run per job (the health summary reads newest-first per job).
create index if not exists cron_runs_job_finished_idx
  on public.cron_runs (job, finished_at desc);

-- Recent-window scans across all jobs.
create index if not exists cron_runs_finished_idx
  on public.cron_runs (finished_at desc);
