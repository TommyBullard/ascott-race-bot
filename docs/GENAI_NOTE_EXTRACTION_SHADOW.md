# GenAI note-extraction shadow layer

> **Status: SHADOW-ONLY / decision-support. Not model-active.**
>
> This is Phase 3 of the autonomous race-day workflow. It is a **local,
> offline** foundation for turning manually-supplied or public/legal race notes
> into structured, auditable runner features. It does **not** call a live GenAI
> API, does **not** touch the database, and does **not** influence the model.
> Every extracted feature is `model_active: false` and review-gated. Nothing here
> predicts winners or gives betting advice.

---

## What this phase ships

- A pure schema + validator + normaliser + Markdown renderer:
  [src/lib/noteFeatureExtraction.ts](../src/lib/noteFeatureExtraction.ts)
- A local CLI that validates/normalises an already-provided extraction JSON and
  renders a preview: [scripts/extractNotes.ts](../scripts/extractNotes.ts)
- A prompt template for a future, explicitly-configured extractor:
  [prompts/genai-note-extraction.md](../prompts/genai-note-extraction.md)
- A synthetic example fixture (example/synthetic runner names only):
  [data/note-extractions/example-notes.json](../data/note-extractions/example-notes.json)
- Tests: `scripts/noteFeatureExtraction.test.ts`

## Command

```bash
npm run extract:notes -- --input data/note-extractions/example-notes.json --output reports/note-extraction-preview.md
```

Optional normalised JSON sibling:

```bash
npm run extract:notes -- --input <in.json> --output <preview.md> --json <normalised.json>
```

The CLI:

- reads a **local** input file (no network, no database),
- validates the source document + extracted features,
- prints an operator summary (PASS/FAIL, errors, warnings),
- writes a deterministic Markdown preview (and optional normalised JSON),
- **calls no external API and writes nothing to the database.**

## Input shape

A local JSON file:

| Field | Notes |
| --- | --- |
| `source_document_id` | optional id |
| `source_label` | optional label |
| `source_url` | optional; **http(s) only** when provided |
| `retrieved_at` | optional ISO timestamp |
| `race_date` / `course` / `race_name` | optional context |
| `off_time` | optional ISO timestamp |
| `raw_note_text` | **required** verbatim note text |
| `extracted_features[]` | one record per runner (below) |

Each feature: `runner_name` (required), the ten tri-state signals
(`*_signal`: positive / negative / unknown), `race_type_risk` /
`volatility_risk` (low / medium / high / unknown), `value_case_strength` /
`likely_winner_case_strength` / `each_way_case_strength`
(none / weak / medium / strong / unknown), `concern_flags[]`, `evidence[]`
(`{ feature, quote_or_reference }`), `extraction_confidence` (0..1),
`model_active` (must be `false`), and `review_status`
(pending / approved / rejected, default `pending`).

## Validation + safety rules

- `model_active` **must be `false`** in this phase (any `true` is rejected).
- `review_status` **defaults to `pending`** when omitted.
- **Every non-unknown signal must carry evidence** (a `quote_or_reference`).
  Unknown signals need no evidence.
- `extraction_confidence` must be a **finite number in 0..1**.
- `runner_name` and `raw_note_text` are **required**.
- **Missing values normalise to `unknown` / `null` / `[]`** — never fabricated.
- `source_url`, when provided, must be **http(s)** (else rejected).
- **Any winner-prediction field is rejected** (`winner`, `winner_prediction`,
  `predicted_winner`, `will_win`, `forecast`, …).
- **Any probability or staking field is rejected** (`probability`, `model_prob`,
  `odds`, `stake`, `kelly`, `ev`, `expected_value`, …).
- Unexpected non-forbidden fields are ignored with a warning.

## Honesty + safety posture

- **Unknown over guessing.** Ambiguous or absent evidence stays `unknown`.
- **Evidence-anchored.** Each asserted signal points back to a quote/reference.
- **Shadow-only.** These features never enter probability, staking, or ranking.
  They are stored/reviewed out-of-band and only become useful after human review
  and (in a future phase) a backtest — never auto-promoted.
- **Untrusted note text.** When a live extractor is wired later, the
  `raw_note_text` must be treated as untrusted (prompt-injection aware); only the
  structured features are consumed, never instructions embedded in the note.

## What this phase deliberately does NOT do

- No live GenAI/API calls, no scraping of private/paywalled/logged-in/ToS-
  restricted sources.
- No database reads or writes, no migrations.
- No change to model probability math, staking, ranking, tipster weighting, the
  Betfair/Racing API clients, or the result importer.
- No winner prediction and no betting advice.

See [docs/MODEL_IMPROVEMENT_BUILD_PLAN.md](MODEL_IMPROVEMENT_BUILD_PLAN.md) §5 for
how this fits the wider (planning-only) GenAI extraction pipeline, and
[docs/ML_NEURAL_NETWORK_PLAN.md](ML_NEURAL_NETWORK_PLAN.md) for the leakage and
evaluation discipline any future promotion must clear.
