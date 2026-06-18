-- Migration: shadow-only GenAI commentary store (Phase 4G)
--
-- ADDITIVE ONLY + STRICTLY SHADOW / DECISION-SUPPORT. Stores INFORMATIONAL,
-- human-review-gated natural-language commentary generated FROM already-computed
-- model output (race summaries, trainer notes, narrative risks, confidence
-- commentary, model-vs-market disagreement reasons).
--
-- HARD INVARIANTS (enforced here AND in src/lib/genaiShadowCommentary.ts):
--   - NEVER MODEL-ACTIVE. `model_active` is forced false by a CHECK constraint —
--     a true value cannot be inserted. Nothing the model reads lives here, and
--     the model never reads this table.
--   - REVIEW-GATED. `review_status` defaults to 'pending'; surfacing on the
--     dashboard requires an explicit human 'approved'.
--   - AUDITABLE. Each row records the prompt_version, the generator name/version,
--     the guardrail `problems`, and the exact `grounding` context the prose was
--     allowed to use (anti-fabrication provenance).
--
-- Nothing here touches the model, staking, recommendations, or any existing
-- table. Guarded with IF NOT EXISTS so it is safe to run more than once.
--
-- Run in the Supabase SQL editor (or via `supabase db push`).
--
-- Columns:
--   id                : surrogate PK.
--   race_id           : the race the commentary is about (FK).
--   model_run_id      : the model run whose output grounded the commentary (FK,
--                       NULL-safe — provenance only).
--   kind              : one of the five commentary kinds.
--   commentary_text   : the validated prose, or NULL when rejected.
--   prompt_version    : the prompt-contract version that produced it.
--   generator_name    : the configured generator's name (e.g. a model id).
--   generator_version : the generator's version tag.
--   status            : 'candidate' (passed guardrails) | 'rejected'.
--   model_active      : ALWAYS false (CHECK-enforced) — never a model input.
--   review_status     : 'pending' | 'approved' | 'rejected' (human review gate).
--   problems          : JSON array of guardrail problems (empty for candidates).
--   grounding         : JSON snapshot of the structured facts the prose may use.
--   generated_at      : generation timestamp.
--   reviewed_at       : when a human approved/rejected it (NULL until reviewed).
--   review_notes      : optional reviewer note.

create table if not exists public.genai_commentary (
  id uuid primary key default gen_random_uuid(),
  race_id uuid references public.races (id) on delete cascade,
  model_run_id uuid references public.model_runs (id) on delete set null,
  kind text not null
    check (kind in (
      'race_summary', 'trainer_note', 'narrative_risk',
      'confidence_commentary', 'disagreement_reason'
    )),
  commentary_text text,
  prompt_version text not null,
  generator_name text not null,
  generator_version text not null,
  status text not null default 'rejected'
    check (status in ('candidate', 'rejected')),
  -- Hard shadow guard: this layer can NEVER be model-active.
  model_active boolean not null default false
    check (model_active = false),
  review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'rejected')),
  problems jsonb,
  grounding jsonb,
  generated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  review_notes text
);

-- All commentary for a race (dashboard read).
create index if not exists genai_commentary_race_idx
  on public.genai_commentary (race_id);

-- Review triage by state, and only ever surface approved candidates.
create index if not exists genai_commentary_review_idx
  on public.genai_commentary (review_status, status);
