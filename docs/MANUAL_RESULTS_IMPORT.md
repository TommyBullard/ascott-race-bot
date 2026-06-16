# Manual results import

How to settle race results by hand when The Racing API `/v1/results` endpoint is
not available on your plan. This drives the model's accuracy / ROI tracking
([Phase 5B](../README.md)) from an operator-curated CSV instead of the automated
`/api/cron/results` route.

> **Responsible use — read first.** This is a personal research / decision-support
> tool. It does **not** predict winners and offers **no guaranteed profit**. Only
> ever record **official, verified** race results here (see
> [Never fabricate results](#never-fabricate-official-results)). All betting
> involves risk; if gambling stops being fun, seek support (e.g. GamCare /
> BeGambleAware).

Prerequisites: [LOCAL_SETUP.md](LOCAL_SETUP.md) (env vars, `npm install`,
Supabase). Commands assume PowerShell in the repo root; use `npm.cmd` if `npm`
is blocked. The importer reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from
`.env.local`; credentials are never logged.

---

## Why a manual fallback exists

`/api/cron/results` settles races automatically by reading The Racing API
`/v1/results` (finishing positions + Betfair SP). That endpoint requires the
**Standard** plan. You can confirm whether your plan has it — read-only, no
writes:

```powershell
npm run probe:results -- --date 2026-06-16
```

If it reports `status: standard_plan_required`, the automated route cannot settle
results on your plan. This importer is the safe fallback: you supply the official
finishing positions in a CSV, and it writes them to the existing `runners` /
`races` rows using the same conservative matching as the rest of the pipeline.

It does **not** call the Racing API, run the model, change any model maths or
staking, or place bets. It only records results you provide.

---

## CSV format

A header row is required. One row per runner you want to record (you only need
the runners you care about — typically at least the winner of each race).

Template: [data/results.example.csv](../data/results.example.csv). Copy it to a
per-day working file, e.g. `data/results-2026-06-16-ascot.csv`, and replace the
example row(s) with real, official results.

### Required columns

| Column | Meaning | Example |
| --- | --- | --- |
| `date` | Meeting date, `YYYY-MM-DD`. | `2026-06-16` |
| `course` | Course name (normalised on match; "Royal Ascot" matches "Ascot"). | `Ascot` |
| `off_time` | Race off time, `HH:MM`, in **UTC** (see warning below). | `13:30` |
| `horse_name` | Runner's name, as on the racecard. | `Example Horse` |
| `finish_pos` | Finishing position, a **positive integer**. The winner is `1`. | `1` |

### Optional columns

| Column | Meaning | Notes |
| --- | --- | --- |
| `sp_decimal` | Industry starting price (decimal, > 1). | Omit/blank if unknown. |
| `bsp_decimal` | Betfair SP (decimal, > 1). | Improves ROI accuracy; omit if unknown. |
| `runner_status` | Free-text status, e.g. `won`, `placed`, `ran`. | Omit/blank to leave unchanged. |

Example file:

```csv
date,course,off_time,horse_name,finish_pos,sp_decimal,bsp_decimal,runner_status
2026-06-16,Ascot,13:30,Example Horse,1,3.5,3.62,won
```

> **`off_time` is UTC.** It must match the race's **stored** off time, which is
> UTC — e.g. a 2:30pm BST Royal Ascot race is stored as `13:30`. Use the time
> shown by `npm run import:tipster-selections -- --list-races --date <date>` (or
> the dashboard), **not** the local wall-clock time, or the race will not match.

> Non-finishers (pulled up, fell, refused, etc.) have **no** finishing position —
> leave them out of the CSV rather than inventing a `finish_pos`.

---

## How matching works

Matching is **exact + normalised only — never fuzzy and never guessed.** Rows
that do not resolve to exactly one race and one runner are skipped and reported,
not applied.

### Race matching

A CSV row resolves to a race when, among that day's races, exactly one has:

- the same `date` (`races.meeting_date`), **and**
- the same **normalised** course — lower-cased, punctuation collapsed, with the
  alias `Royal Ascot` → `Ascot` applied, **and**
- the same off-time instant (the CSV `date` + `off_time` parsed as UTC equals the
  race's stored `off_time`).

Zero matches → counted as `unmatched_races`. More than one match → counted as
ambiguous and skipped (never applied to a guessed race).

### Runner matching

Within the matched race, the `horse_name` is matched to exactly one runner by
**exact normalised name** (lower-cased, country suffix like "(IRE)" stripped,
punctuation collapsed). No partial or fuzzy matching — "Frank" never matches
"Frankel". No match → `unmatched_runners`; two runners normalising to the same
name → `ambiguous_rows`. Both are skipped.

---

## Dry-run (writes nothing)

Always dry-run first. This is the default — it writes **nothing** and just prints
the audit:

```powershell
npm run import:results -- --file data/results-2026-06-16-ascot.csv
```

Review the audit summary:

| Count | Meaning |
| --- | --- |
| `rows_read` | Data rows read from the CSV. |
| `races_matched` | Distinct races resolved. |
| `runners_matched` | Rows resolved to a unique runner. |
| `runners_updated` | Runner updates that would be applied. |
| `unmatched_races` | Rows whose race did not resolve. |
| `unmatched_runners` | Rows whose runner did not resolve. |
| `ambiguous_rows` | Rows skipped for ambiguity (incl. refused-race rows). |
| `skipped_rows` | Rows that failed validation. |

Fix any unmatched/ambiguous rows in the CSV and re-run the dry-run until it is
clean.

---

## Commit (writes results)

Only after a clean dry-run, add `--commit`:

```powershell
npm run import:results -- --file data/results-2026-06-16-ascot.csv --commit
```

On commit it:

- updates `finish_pos` (and any supplied `sp_decimal` / `bsp_decimal` /
  `runner_status`) on each matched runner, and
- marks a race `status = 'result'` with `official_result_time = now` **only** when
  at least one of its matched runners has `finish_pos = 1`.

---

## Safety rules

These are enforced by the importer:

- **Dry-run by default.** Nothing is written without `--commit`.
- **Placeholder guard.** `--commit` is refused while any field still contains the
  template's `EXAMPLE` text, so the example file can't be inserted by accident.
- **No null overwrites.** Only the fields you actually supply are written, so an
  existing non-null `finish_pos` / SP / BSP is never overwritten with a blank.
  Re-running is therefore safe.
- **Conflicts are refused per race.** If a race has duplicate rows for the same
  runner, or more than one runner marked `finish_pos = 1`, that whole race is
  refused (reported, not written) — the other races still import.
- **Settles only with a winner.** A race is marked settled only when a
  `finish_pos = 1` runner is present.
- **No fabrication.** Unmatched or ambiguous rows are skipped, never applied to a
  guessed race/runner.

To correct a mistake, re-import a CSV with the corrected positions for **every**
affected runner in the race (so the whole race is internally consistent), or use
the rollback below.

---

## Check accuracy afterwards

Results feed the model performance tracker live — there is no separate recompute
step. After a commit:

- Open the dashboard for that day/course, e.g.
  <http://localhost:3000/?date=2026-06-16&course=Ascot>, and read the
  **Recommendation performance** panel (settled vs pending, strike rate, P/L, ROI,
  average EV).
- Or query the API directly (read-only):

  ```powershell
  curl "http://localhost:3000/api/accuracy?date=2026-06-16&course=Ascot"
  ```

  The `performance` object reports `settled_count`, `pending_count`, `winners`,
  `losers`, `strike_rate`, `profit_loss`, `roi`, and `average_ev` for that scope.
  Races without a recorded result yet stay **pending** and are never counted as
  losses.

The lifetime `accuracy` object in the same response is global and unaffected by
the `date` / `course` filters.

---

## Rollback if needed

There is **no automatic rollback** — results are written straight to `runners` /
`races` and are not tagged with an import batch label. To undo a day's results,
run targeted SQL in the Supabase SQL editor. **Preview first**, then update.

> These statements clear result fields for **every** runner in the matched races,
> regardless of how they were set. Scope them tightly (date + exact stored course)
> and review the preview before running the updates.

Use the **exact stored course** string (check it with
`npm run import:tipster-selections -- --list-races --date 2026-06-16`).

```sql
-- 1. Preview the runners that would be cleared.
select ra.course, ra.off_time, r.horse_name,
       r.finish_pos, r.sp_decimal, r.bsp_decimal, r.runner_status
from public.runners r
join public.races ra on ra.id = r.race_id
where ra.meeting_date = '2026-06-16' and ra.course = 'Ascot'
order by ra.off_time, r.finish_pos;
```

```sql
-- 2. Clear the runner result fields for those races.
update public.runners r
set finish_pos = null, sp_decimal = null, bsp_decimal = null
from public.races ra
where r.race_id = ra.id
  and ra.meeting_date = '2026-06-16' and ra.course = 'Ascot';
```

```sql
-- 3. Revert the races to their pre-result state (racecard ingestion sets
--    status = 'scheduled'; results set it to 'result').
update public.races
set status = 'scheduled', official_result_time = null
where meeting_date = '2026-06-16' and course = 'Ascot';
```

If you also set `runner_status` on import and want it back to its ingested value,
add `runner_status = 'declared'` to statement 2 (that is what racecard ingestion
writes). Re-running the model after a rollback is not required — performance is
recomputed live from current data on the next dashboard poll.

---

## Never fabricate official results

Only ever enter **official, verified** finishing positions from an authoritative
source (the official racecourse result, Racing Post, or the settled Betfair
market). Do **not** estimate, guess, or back-fill a result you have not
confirmed — fabricated results corrupt the accuracy / ROI tracking and any
decisions made from it. If you are unsure of a result, leave it out; a race with
no recorded winner simply stays **pending** until you have the official outcome.
