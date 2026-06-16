# Race-day runbook

Step-by-step operational guide for a local race day: ingest racecards, refresh
odds, optionally import tipster picks, run the model, and read the dashboard.

> **Responsible use — read first.** This is a personal research / decision-support
> tool. It does **not** predict winners and offers **no guaranteed profit, no
> "sure things", and no risk-free bets**. All betting involves risk and you can
> lose money. Only ever stake what you can afford to lose, obey the laws and
> licensing in your jurisdiction, and treat every output as one input to your own
> judgement. If gambling stops being fun, seek support (e.g. GamCare /
> BeGambleAware).

Prerequisites: complete [LOCAL_SETUP.md](LOCAL_SETUP.md) first (env vars,
`npm install`, fresh-schema check). Commands assume PowerShell in the repo root;
use `npm.cmd` if `npm` is blocked. If `CRON_SECRET` is set, add
`-H "Authorization: Bearer <CRON_SECRET>"` to the `curl` calls below (never paste
the secret into shared output).

---

## 0. Quick map

| Step | Command / route | Writes to |
| --- | --- | --- |
| Start app | `npm run dev` | — |
| Racecards | `GET /api/cron/racecards` | `races`, `runners` |
| Odds | `GET /api/cron/odds` | `market_snapshots`, `runner_quotes` |
| Import tips (dry-run) | `npm run import:tipster-selections -- --file <csv>` | nothing (preview) |
| Import tips (commit) | `… --commit` | `tipster_selections` |
| Run model | `npm run run:model -- <race_id>` | `model_runs`, `model_runner_scores`, `recommendations` |
| Dashboard | <http://localhost:3000> | — |
| Import results (dry-run) | `npm run import:results -- --file <csv>` | nothing (preview) |
| Import results (commit) | `… --commit` | `runners`, `races` |

No-Betfair option: skip steps 4–5 and seed a synthetic race with local odds via
`npm run seed:demo -- --confirm-demo` (see step 4b).

---

## 1. Start the app

```powershell
npm run dev
```

Open <http://localhost:3000>. Note the actual port from the banner if 3000 is
busy.

---

## 2. Ingest racecards

Pulls today's UK & Irish cards from the Racing API and upserts `races`
(status `scheduled`) + `runners`. Idempotent (matched on course + off_time).

```powershell
# CRON_SECRET unset (open local/dev):
curl http://localhost:3000/api/cron/racecards

# PowerShell-native:
Invoke-WebRequest -Uri "http://localhost:3000/api/cron/racecards" -UseBasicParsing | Select-Object -ExpandProperty Content
```

Expected: `{ "ok": true, "day": "today", "cardsFetched": N, "racesInserted": …, "runnersInserted": … }`.
Use `?day=tomorrow` for the next day.

### Verify races / runners (read-only SQL, Supabase SQL editor)

```sql
select count(*) from public.races where meeting_date = (now() at time zone 'utc')::date;
select count(*) from public.runners;

select id, course, off_time, race_name, status
from public.races
where meeting_date = (now() at time zone 'utc')::date
order by off_time;
```

---

## 3. Refresh odds (Betfair) — optional, currently paused

Polls Betfair for today's win markets and writes a fresh `market_snapshot` +
`runner_quotes` per matched race. **Requires Betfair credentials**, which are
**paused** (see LOCAL_SETUP). If you have not configured Betfair, **skip to
step 4b** and use the demo seed for synthetic odds.

```powershell
curl http://localhost:3000/api/cron/odds
```

Expected: `{ "ok": true, "snapshotsWritten": …, "quotesWritten": … }`.

### Verify snapshots / quotes (read-only SQL)

```sql
select race_id, snapshot_time, source_label
from public.market_snapshots
order by snapshot_time desc
limit 10;

select q.snapshot_id, q.runner_id, q.quote_type, q.odds_decimal
from public.runner_quotes q
join public.market_snapshots s on s.id = q.snapshot_id
order by s.snapshot_time desc
limit 20;
```

---

## 4. Tipster selections (optional)

The model runs **market-only** when no tipster selections exist. To add picks,
use the manual CSV importer. **Only use operator-curated, ToS-compliant sources;
never scrape, and never assume a tipster selected a horse unless the source says
so.**

First, list candidate races so your CSV's `course` / `off_time` match exactly
(**read-only**):

```powershell
npm run import:tipster-selections -- --list-races --date 2026-06-15
npm run import:tipster-selections -- --list-races --date 2026-06-15 --course Ascot
```

CSV columns: `meeting_date,course,off_time,horse_name,tipster_name` (required) +
`raw_affiliation,source_label` (optional). Template:
[data/tipster-selections.example.csv](../data/tipster-selections.example.csv).
Set a clear `source_label` (e.g. `manual-2026-06-15`) so you can roll back later.

### 4a. Dry-run (writes nothing)

```powershell
npm run import:tipster-selections -- --file data/tipster-selections.csv
```

Review the audit summary and diagnostics: rows read/validated/insertable, the
`skipped_*` counts, available runner names for unmatched horses, nearby races for
unmatched races, and the **"Fix your CSV"** section. Matching is exact +
normalised only — unmatched/ambiguous rows are skipped, never guessed.

### 4b. No-Betfair alternative — synthetic demo race

To exercise the full path locally **without** Racing API/Betfair, seed one
clearly-synthetic race (all names contain `DEMO`/`SYNTHETIC`, source label
`demo-seed`):

```powershell
npm run seed:demo -- --confirm-demo
```

It prints the new `race_id` and the exact `npm run run:model -- <race_id>` to run
next. It is local-only, requires the explicit `--confirm-demo` flag, and refuses
to run against a production environment without `--force`.

### 4c. Commit the import (writes `tipster_selections`)

Only after a clean dry-run. The importer is idempotent (upsert + ignore on
`race_id, runner_id, raw_tipster_name`), so re-running does not double-count.

```powershell
npm run import:tipster-selections -- --file data/tipster-selections.csv --commit
```

`--commit` is refused while any field still contains placeholder `EXAMPLE` text.

---

## 5. Run the model

For one race (local; needs only Supabase):

```powershell
npm run run:model -- <race_id>
```

Or over HTTP (the dev server):

```powershell
curl -X POST "http://localhost:3000/api/run-model?race_id=<race_id>"
# add  -H "Authorization: Bearer <CRON_SECRET>"  if CRON_SECRET is set
```

This writes a new `model_runs` row (+ `model_runner_scores`, and a
`recommendations` row when a bet is selected). History is append-only: prior runs
for the race are marked superseded, not deleted.

> The model run reads whatever `tipster_selections` exist at run time. Import
> tips **before** running the model (or re-run the model afterwards) for the
> consensus/alignment to reflect them.

> **Post-off guard.** Once a race has gone off (`now > off_time`) or is settled
> (`status = result`), a model run for it is **skipped by default** — the final
> pre-off run stays the race-day decision record and is never superseded by a
> post-off rerun on stale odds. Any explicitly-allowed post-off run is written
> **non-current** (diagnostic only). It is therefore safe to **stop
> `pipeline:watch` once the last race has gone off**; if you leave it running it
> will simply skip post-off / resulted races (reported as `skipped_post_off` /
> `skipped_resulted` in the summary) rather than overwrite their pre-off picks.

---

## 6. Check the dashboard

Open <http://localhost:3000>. Each race card shows the market favourite, the
model's pick (with a "Why" rationale), up to two alternatives, and a **Model
explanation** panel sourced read-only from the run's stored observability.

### Interpreting the output

- **Model recommendation** — the rank-1 pick the model would back. It is a
  suggestion, not a prediction of the result.
- **No bet / empty pick** — the model selected nothing worth staking (e.g. no
  positive-value runner). This is a normal, deliberate outcome, **not** an error.
- **Stake suppressed** (amber badge) — a selection exists but its stake was
  zeroed because data quality was insufficient. Treat as "not actionable on this
  data", not as a weak tip.
- **Degraded / reduced confidence** — the run-level confidence was scaled down
  (e.g. stale or incomplete odds). The shown adjusted confidence reflects that.
- **Data-quality warnings** — e.g. low market completeness, stale odds, missing
  prices. Lower data quality → lower trust in that card.
- **No tipster consensus** — no usable tipster selections for the race; the model
  ran market-only. Not a negative signal in itself.

None of these are guarantees. Always apply your own judgement and risk limits.

---

## 7. Settle results (manual fallback)

After the races are run, record official finishing positions so the dashboard's
accuracy tracker updates. The automated `/api/cron/results` route needs the
Racing API **Standard** plan; if your plan lacks it, settle from an
operator-curated CSV instead. Confirm your plan first (read-only, no writes):

```powershell
npm run probe:results -- --date 2026-06-16
```

If that reports `status: standard_plan_required`, use the manual importer below.

CSV columns: `date,course,off_time,horse_name,finish_pos` (required) +
`sp_decimal,bsp_decimal,runner_status` (optional). Template:
[data/results.example.csv](../data/results.example.csv).

> **Off time is UTC.** `off_time` must match the race's **stored** off time,
> which is UTC — e.g. a 2:30pm BST Royal Ascot race is stored as `13:30`. Use the
> time shown by `npm run import:tipster-selections -- --list-races --date <date>`
> (or the dashboard), not the local wall-clock time, or the race will not match.

### 7a. Dry-run (writes nothing)

```powershell
npm run import:results -- --file data/results.csv
```

Review the audit summary: `rows_read`, `races_matched`, `runners_matched`,
`runners_updated`, `unmatched_races`, `unmatched_runners`, `ambiguous_rows`,
`skipped_rows`. Matching is exact + normalised only (race by date + course +
off_time; runner by exact horse name) — unmatched/ambiguous rows are skipped,
never guessed. A race with duplicate runner rows or more than one
`finish_pos = 1` is **refused** (reported, not written); the rest still proceed.

### 7b. Commit (writes `runners` + settles `races`)

Only after a clean dry-run:

```powershell
npm run import:results -- --file data/results.csv --commit
```

It updates `finish_pos` (and any supplied `sp_decimal` / `bsp_decimal` /
`runner_status`) on the matched runners, and marks a race `status = 'result'`
(with `official_result_time = now`) only when at least one of its runners has
`finish_pos = 1`. `--commit` is refused while any field still contains
placeholder `EXAMPLE` text. The import never overwrites an existing non-null
result with a blank, so re-running is safe; to correct a mistake, re-import a CSV
that includes the corrected positions for **every** affected runner in the race.

Once results are written, the dashboard accuracy tracker (`/api/accuracy`)
reflects them on its next poll — there is no separate recompute step. Performance
is evaluated **as-of off time**: each race is scored on its latest model run with
`run_time <= off_time`, so post-off reruns never change the race-day decision
record (see the post-off guard note in step 5).

---

## 8. Rollback (remove a bad import by `source_label`)

Tipster rows you imported carry the `source_label` you set, so a specific batch
is cleanly removable (**read this before running; it deletes only that batch**):

```sql
-- Preview first:
select count(*) from public.tipster_selections where source_label = 'manual-2026-06-15';

-- Then delete that batch:
delete from public.tipster_selections where source_label = 'manual-2026-06-15';
```

To remove the synthetic demo data (`source_label = 'demo-seed'` / `DEMO`/
`SYNTHETIC` names), see the rollback SQL block in the demo-seed section of the
project notes — delete `tipster_selections`, `runner_quotes` (via their
snapshot), `market_snapshots`, then the demo `runners`/`races` and `tipsters`,
all filtered to the synthetic markers.

> Re-running the model after a rollback refreshes the affected race's pick from
> the remaining data (append-only history keeps the older runs).

---

## Reminders

- Keep secrets in `.env.local` only; never commit or print them.
- The importer never fabricates data — missing/unmatched rows are skipped and
  reported.
- This tool informs decisions; it does not make or place bets, and it makes no
  profit guarantees.
