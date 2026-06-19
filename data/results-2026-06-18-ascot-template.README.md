# Manual results template — Ascot 2026-06-18

> **Dry template only — fill finish_pos manually, then run import:results dry-run before --commit.**

This template has **127 runner row(s)** across **7 race(s)**, one row per stored runner. The identity columns are pre-filled from the database; fill the result columns by hand.

## Columns

| Column | Fill? | Notes |
| --- | --- | --- |
| `date` | pre-filled | Meeting date (YYYY-MM-DD). Do not change. |
| `course` | pre-filled | Stored course label. Do not change. |
| `off_time` | pre-filled | Stored off-time in **UTC** (HH:MM). Do not change — it is matched against the DB. |
| `horse_name` | pre-filled | Stored horse name. Do not change — it is matched exactly. |
| `finish_pos` | **YOU FILL** | Finishing position as a positive integer (1 = winner). Leave blank for non-finishers (or set `runner_status`). |
| `sp_decimal` | optional | Starting price as a decimal > 1.0 (e.g. 4.5). Leave blank if unknown. |
| `bsp_decimal` | optional | Betfair SP as a decimal > 1.0. Leave blank if unknown. |
| `runner_status` | optional | e.g. `PU`, `F`, `non-runner`. Leave blank for normal runners. |

## How to fill it

1. Open the CSV and enter `finish_pos` for each runner from the official result.
2. Exactly **one** runner per race should have `finish_pos` = 1 (the winner).
3. Optionally add `sp_decimal` / `bsp_decimal` / `runner_status`. Never invent values — leave blank if unknown.
4. Do not edit `date`, `course`, `off_time`, or `horse_name` (they are used to match stored rows).

## Import it (dry-run first, then commit)

```
npm run import:results -- --file data/results-2026-06-18-ascot-template.csv            # dry run (writes nothing)
npm run import:results -- --file data/results-2026-06-18-ascot-template.csv --commit   # writes finish_pos + marks settled
```

The importer is conservative: it never overwrites an existing result with a blank, skips unmatched/ambiguous rows, refuses races with duplicate or multiple winners, and only marks a race settled when a winner (finish_pos = 1) is present. Always read the dry-run output before running `--commit`.

---
Local operator helper. No database writes, no settlement, no betting — decision-support only.
