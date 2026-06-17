# GenAI / Manual Race-Note Review UI — Design Plan

> **Status: DESIGN DOCUMENT ONLY.** Nothing described here is implemented or
> model-active by this document. The review layer is **shadow-only /
> decision-support**: it never predicts a winner, never places a bet, and never
> feeds the production model until it has been reviewed *and* backtested over a
> large sample. This file changes no runtime code, scripts, tests, config, or
> packages.

## Overview

This plan describes a **review UI** that sits on top of the project's existing,
already-inert race-note building blocks and lets an operator turn manually
pasted / licensed / public race notes into **structured, evidence-backed
signals** — with an explicit human approval step and a hard `model_active=false`
default.

It deliberately **builds on what already exists** rather than introducing new
ingestion or extraction logic:

| Existing building block | Module / command | Role in this plan |
| --- | --- | --- |
| Local/manual source intake + licence/copyright policy | `src/lib/raceIntelligenceSources.ts` · `npm run intelligence:prepare` | Source policy gate (Section 2) + intake (Section 3) |
| Shadow GenAI note-extraction schema | `src/lib/noteFeatureExtraction.ts` · `npm run extract:notes` | Extracted-feature schema (Section 4) |
| Shadow Win / Value / Each-way panel | `src/components/RaceIntelligencePanel.tsx` | Dashboard display model (Section 5) |
| Companion design docs | `docs/GENAI_NOTE_EXTRACTION_SHADOW.md` · `docs/RACE_INTELLIGENCE_INGESTION_PLAN.md` | Background / prior decisions |

The review UI is the **missing human-in-the-loop step** between
`extract:notes` (which produces shadow features) and any future, gated decision
to surface or promote those features.

---

## 1. Purpose

Build a UI for **manually pasted / licensed / public** race notes to be reviewed
and converted into structured, **evidence-backed** signals.

- Give the operator one place to **paste or upload** a local note, **preview the
  source/licence policy**, **run a local extraction preview** (and, in a future
  phase, an optional configured GenAI extraction), **review** the resulting
  structured features, and **approve / reject / edit** each piece of evidence.
- Every surfaced feature must be **traceable to a short evidence quote** from the
  supplied note — never an invented fact.
- The output is a set of **shadow signals** (`model_active = false`) that can be
  displayed as research context and, separately, fed into shadow evaluation —
  *not* the live recommendation.
- Non-goal: this is **not** a content pipeline, a scraper, or a tipping engine.
  It does not generate predictions; it organises and audits operator-supplied
  evidence.

---

## 2. Source policy

Allowed sources (mirrors `SourceType` + `LicenceStatus` in
`raceIntelligenceSources.ts`):

- **Manual notes** — operator-typed/pasted text (`manual_note`, licence
  `manual`).
- **Operator observations** — the operator's own first-hand notes
  (`operator_observation`).
- **Licensed API notes** — text the operator is licensed to use
  (`licensed_api_note`, licence `licensed`).
- **Public / legal notes** — clearly public, reuse-permitted text
  (`public_note`, licence `public_allowed`).

Hard prohibitions (enforced at intake, not just by convention):

- **No restricted / paywalled / logged-in scraping** of any kind. The UI accepts
  only operator-supplied local input; it issues **no outbound fetches** to
  content sources.
- **No full copyrighted article storage.** Only **short excerpts/quotes** are
  retained as evidence. The existing intake already enforces caps —
  `EXCERPT_MAX_CHARS = 280`, `NOTE_REFERENCE_MAX_CHARS = 200` — and flags
  suspiciously long text via `LONG_NOTE_WARN_CHARS = 2000` and copyright-marker
  detection.
- **Licence gate.** Only `manual` / `public_allowed` / `licensed` are
  "ready for extraction"; `unknown` **fails safe** (flagged, not ready); anything
  else is `unsupported`.
- The UI **previews** the computed source/licence verdict (accepted / flagged /
  unsupported) **before** any extraction is offered.

---

## 3. User flow

1. **Select date / course / race** — scope the review to one race (reuses the
   existing `?date=…&course=…` scoping convention).
2. **Paste a note or upload a local JSON document** — free-text paste or a local
   `*.json` source document matching the `intelligence:prepare` shape. No remote
   upload; local file only.
3. **Preview source policy** — show the licence/copyright verdict, the detected
   `source_type`, the excerpt that *would* be stored, and any warnings, before
   anything else is enabled.
4. **Run extraction preview** — run the **local, deterministic** preview first
   (the human/`extract:notes` schema). A **future** configured GenAI extraction
   step is offered only when explicitly enabled and licensed; it is **off by
   default** and never auto-runs.
5. **Review extracted features** — display every signal/risk/strength field with
   its evidence quote and `unknown` markers.
6. **Approve / reject / edit evidence** — per-feature `review_status`
   (`pending` → `approved` / `rejected`), with the ability to correct a value or
   trim an evidence quote. Editing never invents data; it can only narrow,
   correct, or reject.
7. **Keep `model_active = false` until backtested** — approval makes a feature
   *reviewed*, not *active*. Promotion to model-active is a separate, gated
   decision (Section 7) requiring large-sample validation.

---

## 4. Extracted features

The review UI surfaces exactly the **existing** `noteFeatureExtraction.ts`
schema (so the UI and the shadow layer never diverge). Requested features map to
real fields:

| Requested feature | Schema field(s) | Allowed values |
| --- | --- | --- |
| Ground | `ground_signal` | positive / negative / unknown |
| Distance | `distance_signal` | positive / negative / unknown |
| Course form | `course_form_signal` | positive / negative / unknown |
| Draw | `draw_signal` | positive / negative / unknown |
| Pace | `pace_setup_signal` | positive / negative / unknown |
| Trainer | `trainer_form_signal` | positive / negative / unknown |
| Jockey | `jockey_signal` | positive / negative / unknown |
| Recent run | `recent_run_signal` | positive / negative / unknown |
| Market support | `market_support_signal` | positive / negative / unknown |
| Likely-winner case | `likely_winner_case_strength` | none / weak / medium / strong / unknown |
| Win-value case | `value_case_strength` | none / weak / medium / strong / unknown |
| Each-way case | `each_way_case_strength` | none / weak / medium / strong / unknown |
| Concern flags | `concern_flags` | free list of short flags |
| Evidence quotes | `evidence` | short quotes (capped excerpts) |

Supporting fields also shown: `class_move_signal`, `race_type_risk`,
`volatility_risk` (low/medium/high/unknown), `extraction_confidence`,
`runner_name`, `review_status`, and the always-`false` `model_active`.

**Honesty rule:** missing or ambiguous evidence is `unknown` / `null` / `[]` and
renders as an em dash — it is never guessed. Any winner / probability / staking
field is rejected by the schema, not displayed.

---

## 5. Dashboard integration

- **Show only reviewed or clearly-shadow features.** Unreviewed (`pending`)
  features are either hidden or rendered behind an explicit "unreviewed / shadow"
  label — never presented as fact.
- **Separate GenAI/note evidence from the model pick.** The note evidence lives
  in its own panel (alongside the existing shadow `RaceIntelligencePanel`),
  visually and semantically distinct from the stored model recommendation. The
  model pick remains the persisted recommendation; note evidence never overrides
  it.
- **Show unknowns explicitly** (em dash) so absence of evidence is visible, not
  silently dropped.
- **Show freshness / source label** — `source_label`, `retrieved_at`, and the
  licence verdict travel with the panel so the operator always knows provenance
  and age.
- **No winner prediction by GenAI.** The panel may show case strengths
  (likely-winner / value / each-way) as *research framings* with quotes, but it
  must never state "X will win" or attach a probability/edge.

---

## 6. Safety

- **No auto-betting and no bet placement** anywhere in this flow.
- **No order placement** of any kind.
- **No GenAI winner prediction** — the layer surfaces evidence and case framings,
  never a forecast or a price.
- **No fabricated facts** — every displayed signal must cite a supplied evidence
  quote; missing → `unknown`.
- **No model-active features without review *and* backtesting** —
  `model_active = false` is the default and may only change through the gated
  promotion in Section 7.
- **No scraping of restricted sources** — operator-supplied local input only; no
  outbound content fetches, no paywalled/logged-in access.
- **No GenAI API calls** are made by default; any future extraction provider is
  off unless explicitly configured, licensed, and enabled.
- This layer changes **no** model probability math, staking, ranking,
  recommendation logic, API clients, or DB mutation logic.

---

## 7. MVP phases

1. **Local manual source intake** — paste/upload + the source/licence/copyright
   policy preview (reusing `intelligence:prepare` / `raceIntelligenceSources.ts`).
2. **Extraction preview** — deterministic local extraction into the
   `extract:notes` schema (human-in-the-loop; no GenAI call yet).
3. **Review UI** — per-feature approve / reject / edit with evidence quotes and
   `review_status` tracking.
4. **Dashboard display** — read-only shadow panel of reviewed features, clearly
   separated from the model pick, with source/freshness labels.
5. **Shadow evaluation** — log reviewed signals alongside outcomes for offline,
   leakage-aware analysis (consistent with `docs/ML_NEURAL_NETWORK_PLAN.md`),
   still `model_active = false`.
6. **Possible model-active promotion — only after large validation.** A
   pre-registered, gated decision (default **NO-GO**) requiring a large,
   leakage-free sample showing the signals beat the market-only baseline. Until
   then, signals stay shadow-only.

Each phase is independently shippable and read-only/shadow by default; later
phases are gated on the earlier ones.

---

## 8. Open questions

- **Storage schema** — where reviewed features + evidence quotes live (new table
  vs. `config_json`-style blob vs. local files), and how excerpt caps + retention
  are enforced at rest.
- **Approval workflow** — single-operator approve/reject vs. a two-step review;
  how edits and rejections are audited; how re-extraction interacts with prior
  approvals.
- **Source licensing** — how `licensed_api_note` terms are recorded and verified,
  and how `unknown` licences are resolved before a note can be used.
- **UI placement** — standalone review route vs. inline in the race-day
  dashboard; how the review panel coexists with the existing
  `RaceIntelligencePanel`.
- **Evidence quote length** — confirming the right excerpt cap (currently
  280 chars) to stay clearly within fair-use/short-quote bounds.
- **How to evaluate each-way value** — defining a leakage-free, place-aware
  metric for the each-way case strength before any promotion (links to the
  read-only `place:audit` research).

---

## Non-goals / guardrails (recap)

- Documentation only — no runtime code, scripts, tests, config, or package
  changes are made by this plan.
- Shadow-only — `model_active = false` until reviewed **and** backtested at
  scale.
- No GenAI API calls, no scraping, no winner prediction, no betting, no DB
  mutation.
