# Nationwide write-boundary evidence — 2026-07-24 — after

Generated: 2026-07-24T13:06:11.211Z

**READ ONLY.** SELECT-only reads plus a read-only producer claim status check.
No provider route was called, no model was run, no recommendation, lock or
result was created, no producer claim was acquired/renewed/released/stolen,
and no database row was mutated.

- Scope: `all-uk-ire`
- Snapshot label: `after`
- Schema version: `1`
- Verdict: **OK**

## Allowed operational ingestion

These are written by racecard/odds ingestion. Increases across a dry-run are expected and are never failures.

| Category | Table | Date scoping | Value |
| --- | --- | --- | --- |
| stored courses | `races` | `distinct course where races.meeting_date = <date>` | 8 |
| stored races | `races` | `races.meeting_date = <date> (direct)` | 55 |
| stored runners | `runners` | `runners.race_id -> races.meeting_date = <date>` | 587 |
| market snapshots | `market_snapshots` | `market_snapshots.race_id -> races.meeting_date = <date>` | 110 |
| runner quotes | `runner_quotes` | `runner_quotes.snapshot_id -> market_snapshots.race_id -> races.meeting_date = <date>` | 1060 |
| cron/provider telemetry | `cron_runs` | `cron_runs.finished_at within the UTC calendar day of <date> — NOT a race relationship (cron_runs has no race_id/meeting_date)` | 7 |

## Forbidden persistence

A nationwide live-provider dry-run must produce a ZERO delta for every category below.

| Category | Table | Date scoping | Mandatory | Value |
| --- | --- | --- | --- | --- |
| persisted model runs | `model_runs` | `model_runs.race_id -> races.meeting_date = <date>` | yes | 0 |
| persisted model runner scores | `model_runner_scores` | `model_runner_scores.model_run_id -> model_runs.race_id -> races.meeting_date = <date>` | yes | 0 |
| persisted recommendations | `recommendations` | `recommendations.race_id -> races.meeting_date = <date> (direct hop; the table also carries model_run_id)` | yes | 0 |
| locked decision rows | `locked_race_decisions` | `locked_race_decisions.race_id -> races.meeting_date = <date> (ALL horizons, not just minutes_before = 5 — a research capture is still forbidden persistence)` | yes | 0 |
| settled races | `races` | `races.meeting_date = <date> AND lower(races.status) = 'result'` | yes | 0 |
| runners with a finish position | `runners` | `runners.race_id -> races.meeting_date = <date> AND runners.finish_pos IS NOT NULL` | yes | 0 |
| persisted training capture rows | `ml_training_examples` | `ml_training_examples.race_id -> races.meeting_date = <date>` | optional | 0 |
| persisted GenAI commentary rows | `genai_commentary` | `genai_commentary.race_id -> races.meeting_date = <date> (race_id is nullable; unlinked rows are unscopable)` | optional | 0 |

## Optional / unavailable categories

All categories were counted for this date.

## Producer claim (read-only status)

- status: `absent`
- scope: `n/a`
- generation: `n/a`
- owner prefix: `n/a` (the full owner id is never recorded)

## Warnings

- cron_runs has no race_id/meeting_date in this schema; its count is scoped to the UTC calendar day of the date, which is a different semantic from a race meeting date
- genai_commentary.race_id is nullable; rows with no race link cannot be date-scoped and are not counted

## Invariant violations

None.

## Limitations

- `cron_runs` has no race relationship in this schema; its count is scoped to the UTC
  calendar day of the requested date, which is a DIFFERENT semantic from a race meeting date.
- `genai_commentary.race_id` is nullable; rows with no race link cannot be date-scoped.
- A single snapshot proves state at one instant. Only a before/after pair can prove a zero delta.
- Categories reported as missing/failed are never treated as zero and cannot support a PASS.

---

This evidence command performed SELECT-only reads plus a read-only producer claim status check. It changed nothing: no database row was inserted, updated or deleted, no provider route was called, no model was run, no recommendation/lock/result was created, and no producer claim was acquired, renewed, released or stolen.

Decision-support only — no betting, no bet placement.
