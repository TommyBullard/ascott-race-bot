# Local Race-Day Supervisor (Windows)

One local command starts the whole race-day producer stack in visible windows,
so the Railway dashboard stays a **web dashboard only** (no Railway changes,
no cron/worker conversion, start command untouched). Everything runs through
the existing safe npm scripts — this supervisor adds **no** new database
access, **no** betting, and changes **no** model/staking/confidence logic.

Decision-support only — no auto-betting, no bet placement, anywhere.

---

## 1. What to run before leaving (~11am)

Open a terminal in the repo root and run **one command**:

```bat
race-day-local\start-race-day.bat
```

Defaults are `2026-07-11` / `Newmarket`. For another day/course:

```bat
race-day-local\start-race-day.bat 2026-07-12 "Newmarket"
```

It will:

1. Run the initial `pipeline:day --commit` load in the launcher window
   (racecards, odds, tipsters, model runs for the day).
2. Open **three watcher windows** that stay up all day:

| Window title      | What it does | Cycle |
| ----------------- | ------------ | ----- |
| `PIPELINE WATCH…` | `pipeline:watch --interval-minutes 5 --commit` (odds refresh + model reruns, stops itself at each off — post-off guard). Auto-restarts if the process exits. | 5 min (internal) |
| `LOCK WATCH…`     | `lock:t-minus --minutes-before 5 --commit` — the official T-minus-5 locks. Idempotent: reruns report `already_locked`; too-early/post-off races are never persisted. | every 120 s |
| `RESULTS WATCH…`  | `results:auto` **dry-run first**, then `results:auto --commit` only when the dry-run exited cleanly. All gates live inside the script. | every 10 min |

**Leave all three windows open.** The launcher window can be closed once it
says the watchers are up.

## 2. Phone URL at the course

<https://ascott-race-bot-production.up.railway.app/?day=today&course=Newmarket>

Also useful: `/results-audit?day=today&course=Newmarket` for the prediction
audit view after races settle.

## 3. What good output looks like

- **Launcher:** `pipeline:day` summary with races found and runs written, no
  `[WARN]` line.
- **PIPELINE WATCH:** a cycle summary every ~5 minutes; races that have gone
  off are reported as skipped (`skipped_post_off`) — that is correct, never an
  error.
- **LOCK WATCH:** every 2 minutes a summary line; before a race's window you
  see `too_early_not_locked`, in the window one `locked_pick` / `locked_no_bet`
  per race, afterwards `already_locked`. By end of day: locked count ≈ race
  count.
- **RESULTS WATCH:** `dry-run clean — running results:auto --commit`, then
  `commit cycle finished cleanly.` As races finish, settled counts rise on the
  dashboard. `Nothing committed` early in the day is normal (no results yet).
- **Dashboard (phone):** Proof-of-Update panel shows locks accumulating
  (`Official T-minus-5 locks` row), no `LOCK MISSING` while racing is live,
  and the performance block labelled OFFICIAL/MIXED.

## 4. What bad output looks like (and what to do)

- Repeated `[WARN] pipeline:watch exited — restarting` every minute →
  check `logs\race-day-<date>-<course>\pipeline-watch.log` (env vars? network?).
- `LOCK MISSING` on the dashboard for a race whose off has passed → that
  race's lock window was missed (a fact, never backfilled); check the lock
  window's log for what happened. Official figures treat it as a separate
  bucket, never a loss.
- `Refusing to commit — … safety gate(s) failed` in results-watch.log →
  results source was blocked/partial/ambiguous. Nothing was written. Settle
  later via the manual CSV importer (`docs/MANUAL_RESULTS_IMPORT.md`).
- Same-day note: the free/basic results endpoints work **today only**. If any
  race is still unsettled after midnight, use the manual CSV importer.

## 5. How to stop everything

Close the three watcher windows (or press `Ctrl+C` in each, twice if the
`timeout` countdown is running). There is no background service, no scheduled
task, and nothing on Railway to stop — Railway keeps serving the read-only
dashboard regardless.

## 6. Logs

Everything is appended under:

```text
logs\race-day-<date>-<course-slug>\
  pipeline-day.log     (initial load)
  pipeline-watch.log
  lock-watch.log
  results-watch.log
```

The `logs/` folder is gitignored — local operator artefacts only.

## 7. What writes to Supabase (and what never does)

| Command | Writes? | Gate |
| ------- | ------- | ---- |
| `pipeline:day` / `pipeline:watch` | Yes, with `--commit` | racecards/odds/model runs only; post-off guard skips started races |
| `lock:t-minus --commit` | Yes | insert-only into `locked_race_decisions`; commit window enforced; `already_locked` on rerun; UPDATE blocked by trigger |
| `results:auto` (no flag) | **Never** | dry-run/audit only |
| `results:auto --commit` | Only when every safety gate passes | same-day sources only, per-race gate, loud refusal otherwise; SP/BSP never fabricated |
| The `.bat` supervisor files | **Never** | they only sequence the npm scripts above |

No script anywhere places bets. Locked decisions are only ever written by
`lock:t-minus` and are immutable once written.
