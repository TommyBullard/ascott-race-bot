# Nationwide write-boundary comparison — 2026-07-25

Generated: 2026-07-25T16:48:29.710Z

**READ ONLY.** This comparison read two local evidence files only.

## Verdict: PASS

## Forbidden persistence (zero delta required)

| Verdict | Category | Table | Before | After | Delta | Explanation |
| --- | --- | --- | --- | --- | --- | --- |
| PASS | persisted model runs | `model_runs` | 0 | 0 | 0 | zero delta (0 -> 0) — no forbidden persistence occurred |
| PASS | persisted model runner scores | `model_runner_scores` | 0 | 0 | 0 | zero delta (0 -> 0) — no forbidden persistence occurred |
| PASS | persisted recommendations | `recommendations` | 0 | 0 | 0 | zero delta (0 -> 0) — no forbidden persistence occurred |
| PASS | locked decision rows | `locked_race_decisions` | 0 | 0 | 0 | zero delta (0 -> 0) — no forbidden persistence occurred |
| PASS | settled races | `races` | 0 | 0 | 0 | zero delta (0 -> 0) — no forbidden persistence occurred |
| PASS | runners with a finish position | `runners` | 0 | 0 | 0 | zero delta (0 -> 0) — no forbidden persistence occurred |
| PASS | persisted training capture rows | `ml_training_examples` | 0 | 0 | 0 | zero delta (0 -> 0) — no forbidden persistence occurred |
| PASS | persisted GenAI commentary rows | `genai_commentary` | 0 | 0 | 0 | zero delta (0 -> 0) — no forbidden persistence occurred |

## Allowed ingestion (increases expected)

| Verdict | Category | Table | Before | After | Delta |
| --- | --- | --- | --- | --- | --- |
| PASS | stored races | `races` | 0 | 51 | 51 |
| PASS | stored runners | `runners` | 0 | 527 | 527 |
| PASS | market snapshots | `market_snapshots` | 0 | 14 | 14 |
| PASS | runner quotes | `runner_quotes` | 0 | 88 | 88 |
| PASS | cron/provider telemetry | `cron_runs` | 0 | 2 | 2 |

## Warnings

- cron_runs has no race_id/meeting_date in this schema; its count is scoped to the UTC calendar day of the date, which is a different semantic from a race meeting date
- genai_commentary.race_id is nullable; rows with no race link cannot be date-scoped and are not counted

---

This comparison read two local evidence files only. It performed no database query, no provider call, no model execution and no claim operation.

Decision-support only — no betting, no bet placement.
