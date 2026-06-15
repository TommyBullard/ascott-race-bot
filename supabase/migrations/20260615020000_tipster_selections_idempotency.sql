-- Migration: tipster_selections idempotency + provenance (Batch K1a)
--
-- ADDITIVE ONLY. Supports the manual CSV importer
-- (scripts/importTipsterSelections.ts) without altering existing columns/rows:
--
--   1. source_label (text, nullable): which import batch a row came from, for
--      provenance and safe rollback-by-source
--      (DELETE ... WHERE source_label = '<batch>'). Legacy rows stay NULL.
--   2. A UNIQUE index on (race_id, runner_id, raw_tipster_name) so re-importing
--      the same operator-curated pick is idempotent: the importer inserts with
--      upsert + ignoreDuplicates, so the same tipster pick is never
--      double-counted in tipster consensus.
--
-- All three index columns are NOT NULL on the table, so the unique index has no
-- NULL-handling caveats. Guarded with IF NOT EXISTS, so this is safe to run more
-- than once.
--
-- NOTE: creating the unique index will fail if duplicate
-- (race_id, runner_id, raw_tipster_name) rows already exist. In production
-- tipster_selections is empty (tipster consensus is empty until ingestion), so
-- this is safe; if you have pre-existing duplicates, de-duplicate them first.
--
-- Run in the Supabase SQL editor (or via `supabase db push`).

alter table public.tipster_selections
  add column if not exists source_label text;

create unique index if not exists tipster_selections_dedupe_idx
  on public.tipster_selections (race_id, runner_id, raw_tipster_name);
