# GenAI note-extraction preview (SHADOW — not model-active)

> Shadow layer: these structured features come from manually-supplied or
> public/legal notes for REVIEW ONLY. They are NOT model-active, never
> predict winners, and never influence probability, staking, or ranking.
> Unknowns are preserved; missing values are not fabricated.

## Source document

- source_document_id: example-doc-001
- source_label: example-synthetic-notes
- source_url: https://example.com/synthetic-notes
- retrieved_at: 2026-06-16T09:00:00.000Z
- race_date: 2026-06-16
- course: Example Downs (SYNTHETIC)
- race_name: EXAMPLE Synthetic Handicap (Example Data Only)
- off_time: 2026-06-16T13:30:00.000Z
- features: 2

### Raw note text

> SYNTHETIC EXAMPLE NOTES — not real tipster content, for schema/preview testing only. Alpha should relish the ground and the step up in trip looks ideal, though a wide draw is a slight concern. Bravo comes from an in-form yard but today's trip looks on the sharp side.

## Extracted features (2)

### EXAMPLE Runner Alpha (SYNTHETIC)

- model_active: false
- review_status: pending
- extraction_confidence: 0.62

Signals:
- ground_signal: positive
- distance_signal: positive
- course_form_signal: unknown
- draw_signal: negative
- pace_setup_signal: unknown
- trainer_form_signal: unknown
- jockey_signal: unknown
- recent_run_signal: unknown
- class_move_signal: unknown
- market_support_signal: unknown

Risk / case strength:
- race_type_risk: medium
- volatility_risk: high
- value_case_strength: medium
- likely_winner_case_strength: weak
- each_way_case_strength: medium

- concern_flags: wide_draw, volatile_handicap
- evidence:
  - ground_signal: "Alpha should relish the ground"
  - distance_signal: "the step up in trip looks ideal"
  - draw_signal: "a wide draw is a slight concern"

### EXAMPLE Runner Bravo (SYNTHETIC)

- model_active: false
- review_status: pending
- extraction_confidence: 0.4

Signals:
- ground_signal: unknown
- distance_signal: negative
- course_form_signal: unknown
- draw_signal: unknown
- pace_setup_signal: unknown
- trainer_form_signal: positive
- jockey_signal: unknown
- recent_run_signal: unknown
- class_move_signal: unknown
- market_support_signal: unknown

Risk / case strength:
- race_type_risk: medium
- volatility_risk: medium
- value_case_strength: weak
- likely_winner_case_strength: none
- each_way_case_strength: weak

- concern_flags: —
- evidence:
  - distance_signal: "today's trip looks on the sharp side"
  - trainer_form_signal: "comes from an in-form yard"
