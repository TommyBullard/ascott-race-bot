-- Migration: tipster candidate evidence fields (Phase 4B)
--
-- ADDITIVE ONLY. Extends `tipster_selection_candidates` (created in Phase 4A) so
-- the manual "hot tipster" CSV importer (scripts/importTipsterCandidatesCsv.ts)
-- can capture the EVIDENCE behind a pick alongside the pick itself. Nothing here
-- touches the model, staking, or the `tipster_selections` table the model reads —
-- these columns live only on the review-queue candidate rows. Guarded with
-- IF NOT EXISTS so it is safe to run more than once.
--
-- Run in the Supabase SQL editor (or via `supabase db push`) BEFORE importing
-- candidates with `--commit` (a dry-run needs none of this).
--
-- New columns (all nullable; a candidate is still just a pending review item):
--   race_name           : optional human-readable race name, as captured.
--   proof_url           : optional link to the tipster's proofing / results
--                         record (evidence the pick/source is genuine).
--   confidence_text     : optional tipster's own wording, e.g. "NAP", "nb".
--   evidence_confidence : optional operator assessment of evidence strength.
--                         The importer accepts only 'high' | 'medium' | 'low'
--                         (validated app-side; stored as text, never fabricated).
--   notes               : optional free-text operator notes for review.

alter table public.tipster_selection_candidates
  add column if not exists race_name text,
  add column if not exists proof_url text,
  add column if not exists confidence_text text,
  add column if not exists evidence_confidence text,
  add column if not exists notes text;
