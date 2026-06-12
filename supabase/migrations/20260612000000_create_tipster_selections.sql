-- Migration: create tipster_selections
--
-- The tipster ingestion flow (resolveCanonicalTipster + ingestTipsterSelections
-- in src/lib/raceData.ts) produces rows for this table, but it does not yet
-- exist in the database. This statement creates it to match what the code
-- writes, following the conventions of the existing schema (uuid PKs,
-- foreign keys, timestamptz).
--
-- Run in the Supabase SQL editor (or via `supabase db push` if you use the CLI).
--
-- Columns:
--   id                : surrogate PK.
--   race_id / runner_id: the selected runner in a race (FKs).
--   tipster_id        : resolved canonical tipster, NULL when unresolved/ambiguous
--                       (downstream review decides — see tipster_review_queue).
--   raw_tipster_name  : verbatim scraped name, preserved for audit.
--   raw_affiliation   : verbatim scraped affiliation, if any.
--   created_at        : ingestion timestamp.

create table if not exists public.tipster_selections (
  id uuid primary key default gen_random_uuid(),
  race_id uuid not null references public.races (id) on delete cascade,
  runner_id uuid not null references public.runners (id) on delete cascade,
  tipster_id uuid references public.tipsters (id) on delete set null,
  raw_tipster_name text not null,
  raw_affiliation text,
  created_at timestamptz not null default now()
);

-- Lookups by race (fetchTipsterSelections) and by tipster (joins/aggregates).
create index if not exists tipster_selections_race_id_idx
  on public.tipster_selections (race_id);
create index if not exists tipster_selections_tipster_id_idx
  on public.tipster_selections (tipster_id);

-- Optional: prevent exact duplicate ingests of the same scraped row per race.
-- Uncomment if your ingestion should be idempotent on (race, runner, raw name).
-- create unique index if not exists tipster_selections_dedupe_idx
--   on public.tipster_selections (race_id, runner_id, raw_tipster_name);
