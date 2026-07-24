# Nationwide write-boundary evidence pack

**Status:** current operational guidance for the Nationwide rebuild
(Phase 7A.2b evidence work). SELECT-only.

**Purpose:** prove — with numbers, not assertion — that a nationwide
`live-provider` dry-run wrote **only** provider ingestion rows (races, runners,
market snapshots, runner quotes) and **zero** forbidden persistence rows (model
runs, runner scores, recommendations, locked decisions, settled races, finish
positions, training captures, GenAI artifacts).

This pack does not run the dry-run, does not enable nationwide execution, and
does not place bets. It is evidence tooling only.

---

## 1. Commands

| Command | What it does | Writes? |
| --- | --- | --- |
| `npm run audit:nationwide-write-boundary -- --date YYYY-MM-DD --label before\|after [--report] [--json]` | SELECT-only snapshot of every category for the date, plus one read-only `producer_claim_status` RPC | only the optional local report files |
| `npm run audit:nationwide-write-boundary:compare -- --before <path> --after <path> [--report] [--json]` | compares two local evidence JSON files | only the optional local report file |

Neither command has a `--commit` flag. Neither calls a provider route, runs the
model, creates a lock or a result, or acquires/renews/releases/steals a producer
claim. The comparison command opens no database connection at all.

Exit codes: `0` = OK/PASS, `3` = REVIEW, `2` = FAIL, `1` = usage error.

Report paths are deterministic:

- `reports/nationwide-write-boundary-<date>-before.md` / `.json`
- `reports/nationwide-write-boundary-<date>-after.md` / `.json`
- `reports/nationwide-write-boundary-<date>-comparison.md`

---

## 2. What is measured, and how it is date-scoped

Every relationship below was verified against the actual schema. `races.meeting_date`
is the only direct race-date column; everything else is scoped through `race_id`
or through a further parent.

### Allowed operational ingestion (increases are EXPECTED, never a failure)

| Category | Table | Date scoping |
| --- | --- | --- |
| stored courses | `races` | distinct `course` where `meeting_date = <date>` |
| stored races | `races` | `meeting_date = <date>` |
| stored runners | `runners` | `race_id` → `races.meeting_date` |
| market snapshots | `market_snapshots` | `race_id` → `races.meeting_date` |
| runner quotes | `runner_quotes` | `snapshot_id` → `market_snapshots.race_id` → `races.meeting_date` |
| cron/provider telemetry | `cron_runs` | `finished_at` within the UTC calendar day — **not** a race relationship |

### Forbidden persistence (must be a ZERO delta)

| Category | Table | Date scoping | Mandatory |
| --- | --- | --- | --- |
| persisted model runs | `model_runs` | `race_id` → `races.meeting_date` | yes |
| persisted model runner scores | `model_runner_scores` | `model_run_id` → `model_runs.race_id` → `races.meeting_date` | yes |
| persisted recommendations | `recommendations` | `race_id` → `races.meeting_date` | yes |
| locked decision rows | `locked_race_decisions` | `race_id` → `races.meeting_date`, **all horizons** | yes |
| settled races | `races` | `meeting_date = <date>` and `status = 'result'` | yes |
| runners with a finish position | `runners` | `race_id` → `races.meeting_date`, `finish_pos is not null` | yes |
| persisted training capture rows | `ml_training_examples` | `race_id` → `races.meeting_date` | optional |
| persisted GenAI commentary rows | `genai_commentary` | `race_id` → `races.meeting_date` | optional |

`model_runner_scores` and `runner_quotes` are two-hop: the parent id list is read
first, chunked, then the child rows are counted against it.

---

## 3. Honesty rules (why a zero is never invented)

- A **missing table**, a **permission failure**, a **failed query** and an
  **unscopable table** are four distinct statuses. None of them is reported as
  `0`, and none can support a `PASS`.
- If the `races` query itself fails, every race-scoped category is reported
  unavailable — the snapshot degrades to `FAIL` rather than showing zeros.
- A **decrease** in a forbidden category is `FAIL`, not a quiet pass: a
  read-only dry-run must not delete those rows either.
- `cron_runs` has no `race_id` or `meeting_date` in this schema. Its count is
  scoped to the UTC calendar day, which is a **different semantic** from a race
  meeting date, and every report says so.
- `genai_commentary.race_id` is nullable; rows with no race link cannot be
  date-scoped and are not counted.
- `ml_training_examples` exists in this schema. If it is ever empty that is
  reported as a counted zero — "table exists, zero rows" — never as "missing".

## 4. Secrets

Reports and console output never contain a service-role key, `CRON_SECRET`,
provider credentials, an authorization header, an environment value, a
connection URL, or a full producer owner id. Database errors are reduced to a
short `code: message` string with credential-shaped fragments replaced by
`[redacted]`; owner ids appear only as an 8-character prefix.

---

## 5. Second-date attended dry-run procedure (14 steps)

This is the procedure for a **future** attended nationwide `live-provider`
dry-run. Running it is a separate, gated decision — this document does not
authorise it.

1. **Pick the date and confirm it is not a live production race day** you are
   operating with the selected-course pipeline. The nationwide claim is
   day-level: it conflicts with every other scope for that date.
2. **Confirm the working tree is clean** and matches the reviewed commit
   (`git status`, `git rev-parse HEAD`). Evidence from modified tooling is not
   evidence.
3. **Run the nationwide preflight**:
   `npm run nationwide:preflight -- --date <date> --target-mode live-provider --report`.
   Do not continue on `BLOCKED`. On `REVIEW`, resolve or explicitly accept each
   reason in writing.
4. **Confirm the date is unclaimed**:
   `npm run producer:claim-check -- --date <date> --op status`. A live claim of
   any scope means someone else owns the date — stop.
5. **Capture the BEFORE snapshot**:
   `npm run audit:nationwide-write-boundary -- --date <date> --label before --report`.
   Require verdict `OK`. A `FAIL` here means the evidence baseline itself is not
   trustworthy — fix that before running anything.
6. **Record the before file hashes** (`Get-FileHash` on the `.json` and `.md`)
   so the baseline cannot be silently edited later.
7. **Run the attended dry-run**:
   `npm run nationwide:dry-run -- --date <date> --mode live-provider`.
   Stay at the console for the whole run. It has no `--commit` flag; it holds a
   real `all-uk-ire` producer claim and stops on any racecard/odds failure.
8. **Watch for the claim lifecycle events** in the console:
   `PRODUCER_CLAIM_ACQUIRED` at the start and `PRODUCER_CLAIM_RELEASED` at the
   end. A missing release means the claim is left to its TTL — note it.
9. **Confirm the date is unclaimed again** with `producer:claim-check --op status`
   before taking the after snapshot, so the after numbers are not read
   mid-run.
10. **Capture the AFTER snapshot**:
    `npm run audit:nationwide-write-boundary -- --date <date> --label after --report`.
11. **Compare**:
    `npm run audit:nationwide-write-boundary:compare -- --before reports/nationwide-write-boundary-<date>-before.json --after reports/nationwide-write-boundary-<date>-after.json --report`.
12. **Read the verdict honestly.**
    - `PASS` — every forbidden category had a conclusive zero delta.
    - `REVIEW` — at least one category could not be conclusively compared. This
      is **not** a pass; record exactly which category and why.
    - `FAIL` — forbidden persistence changed. Stop, do not repeat the run, and
      investigate which code path wrote the rows before anything else.
13. **Record the ingestion deltas too.** Growth in races/runners/snapshots/quotes
    is the expected evidence that `live-provider` genuinely ingested; a
    live-provider run with zero ingestion delta means the run did not do what
    it claimed.
14. **Archive the three reports** with the run's console log, and note the
    outcome against the nationwide gate. Nothing here enables nationwide
    execution — that remains a separate, explicit decision.

---

## 6. Interpreting a REVIEW verdict

`REVIEW` means the evidence is incomplete, not that the boundary held. The
common causes:

| Cause | Meaning | Action |
| --- | --- | --- |
| optional table missing (`ml_training_examples`, `genai_commentary`) | this deployment does not have the table | record it; the boundary for that category is unproven, not proven |
| permission denied | the role cannot read the table | fix grants, then re-snapshot; do not assume zero |
| query failed | transient or timeout | re-run the snapshot before the state moves |
| allowed ingestion decreased | rows disappeared during the window | investigate separately; it is not a write-boundary breach but it is unexplained |

---

## 7. What this pack deliberately does not do

- It does not run, schedule or enable a nationwide pipeline, watcher or
  supervisor.
- It does not add nationwide persistence, a migration, or an optional table.
- It does not change Railway, Vercel, or any cron configuration.
- It does not settle results, create locks, or run the model.
- It does not place bets. Nothing in this repository does.

Decision-support only — outputs are research suggestions, never guarantees.
