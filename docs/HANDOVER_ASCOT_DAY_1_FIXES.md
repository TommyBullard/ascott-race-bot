# Handover — Ascot Day 1 pre-off evaluation & post-off guard fixes

> ARCHIVE NOTE: This document is historical and specific to Royal Ascot Day 1
> (2026-06-16). It is a closed-incident handover note, not the current
> operating runbook.

Date: 2026-06-16
Scope: explains the post-off superseding bug found on Royal Ascot Day 1, the fix
that shipped, why it is safe, and how to verify it. **Documentation only** — it
describes the change, it does not alter any code.

> **Responsible use.** Ascott Race Bot is a personal **research / decision-support**
> tool. It does **not** predict winners and offers **no guaranteed profit, no
> "sure things", and no risk-free bets**. Nothing here is betting advice. The
> figures below are a record for calibration and review only; all betting
> involves risk.

Related commit: `a1e2c74` — *"Fix pre-off evaluation and post-off model guards"*
(local only, **not pushed**). See also
[PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md), [RACE_DAY_RUNBOOK.md](RACE_DAY_RUNBOOK.md),
[MANUAL_RESULTS_IMPORT.md](MANUAL_RESULTS_IMPORT.md), and the day note
[../ascot-day-1/end-of-day-analysis.md](../ascot-day-1/end-of-day-analysis.md).

---

## 1. What bug was found

**Post-off stale reruns superseded valid pre-off model runs.**

On 2026-06-16 the pipeline kept running after each race had gone off. Model
history is append-only: a new run inserts as `is_current` and supersedes the
prior current run. The post-off reruns scored on **stale, frozen odds** and
usually produced **no positive-EV bet**, so those **no-bet** runs became
`is_current` and retired the genuine pre-off run that had carried the
recommendation.

Because the dashboard read `is_current`, it mis-reported the day as
**0/4 winners, settled 4, pending 0, 3 no-bet** — when the honest pre-off record
was **0/7**. The decision record shown was wrong; no bets or results were
affected.

---

## 2. What changed

Two complementary changes (evaluation + a write-time guard):

1. **Pre-off / as-of-off-time evaluation.** Performance/accuracy now selects, per
   race, the latest model run with **`run_time <= off_time`** (the final pre-off
   run), then scores that. Post-off reruns are ignored for the official record.
   `GET /api/accuracy` uses this by default; a small dashboard label states it.
   The legacy "current pointer" behaviour is still available as an explicit mode
   but is no longer the default.
2. **Post-off / resulted run guard.** The model producer **skips** a race once it
   has gone off (`now > off_time`) or is `status = result`. Any explicitly
   allowed post-off run is written **non-current** (diagnostic only) and never
   supersedes the pre-off run. The day/pipeline runners skip such races before
   doing any work, and the summaries report `skipped_post_off` /
   `skipped_resulted`.

Net effect: the final pre-off run is the race-day decision record, and a
post-race stale no-bet run can no longer overwrite it.

---

## 3. Why this is safer

- **No database history mutation.** The fix changes how runs are *selected for
  evaluation* and *whether a new post-off run is written as current* — it does
  **not** rewrite, re-point, or delete any existing `model_runs`,
  `recommendations`, or `model_runner_scores` rows.
- **Append-only history preserved.** Superseded runs remain in the database
  exactly as before. That is precisely why the true pre-off record was
  recoverable without reconstructing anything — the fix simply reads the run that
  was already there.
- **No model-math changes.** Probability estimation, EV, fractional-Kelly
  staking, ranking/selection, and tipster weighting are untouched. So are the
  Betfair client, the Racing API client, and the results importer. The change is
  evaluation + a write guard only.
- **Covered by tests.** Regression tests lock the 2026-06-16 scenario (a pre-off
  recommendation survives a later post-off no-bet run; the old current-pointer
  read reproduces the buggy 0/4 + 3 no-bet and is asserted to differ from the
  as-of-off-time 0/7), plus guard unit tests (resulted/post-off skipped, pre-off
  runs proceed, summaries report the skip reason).

---

## 4. How to verify

Run the gates from the repo root (use `npm.cmd` if `npm` is blocked):

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

Last known status on this branch: **lint clean · typecheck clean · 491 tests
pass · build succeeds**.

Then check the per-day performance via the read-only API (requires the dev
server running, `npm run dev`):

```powershell
curl "http://localhost:3000/api/accuracy?date=2026-06-16&course=Ascot"
```

In the JSON response, read the `performance` object: it is evaluated **as-of off
time**, so `settled_count` / `pending_count` / `no_bet_races` reflect each race's
final pre-off run, not any post-off rerun. (The `accuracy` object in the same
response is the global lifetime snapshot and ignores the date/course filters.)
Full response shape and the pre-off counting rules are documented in
[API.md](API.md).

> This command reads only; it places no bets and prints no secrets. Do **not** run
> live pipeline commands or `import:results --commit` as part of verification.

---

## 5. Expected Day 1 interpretation

With all seven result rows imported, the final pre-off evaluation for
`date=2026-06-16&course=Ascot` should show:

- **7 settled races**, **0 pending**, **0 no-bet** (every race had a valid pre-off
  recommendation; none are erased by post-off no-bet runs now).
- **True pre-off model record: 0 / 7** — the model's final pre-off rank-1 pick won
  none of the seven races.

If instead you still see "settled 4, 3 no-bet", that indicates an environment
evaluating the old `is_current` pointer rather than the pre-off run — re-check the
deployed/branch version includes commit `a1e2c74`.

> Caveat: if some result rows are not yet imported, those races stay **pending**
> (never counted as losses) and the settled count will be lower. The 17:35 result
> on file is top-4 only, which does not change the pick's settled/won status
> (its pick did not finish in the recorded top 4).

---

## 6. Remaining improvements (research-only backlog)

Forward-looking, **observation-before-influence**, and not promises of accuracy or
profit. See [MODEL_IMPROVEMENT_BUILD_PLAN.md](MODEL_IMPROVEMENT_BUILD_PLAN.md).

- **Confidence decomposition** — split the single "Low" into named components
  (data / market / tipster / contextual / race-type / extraction) so a low score
  states *why*.
- **Calibration** — track Brier score / log loss and calibration-by-confidence on
  out-of-sample, pre-off data; explicitly evaluate the "fade the favourite"
  tendency seen on Day 1.
- **GenAI extraction-only note features** — convert manual / public / licensed
  notes into structured, evidence-backed signals; never pick winners, never
  invent facts; review-gated and non-model-active until backtested.
- **Tipster CLV / BSP realism** — evaluate tipster value against Betfair SP /
  closing line, and group correlated tipsters so shared sources are not
  double-counted.
- **Stronger no-bet / skip gates** — build on the post-off guard: keep degraded
  data and very-low-confidence races honest (no-bet rather than a forced pick),
  and ensure post-off / resulted races are never re-scored into the decision
  record.

---

## 7. Notes for the next session

- The fix commit `a1e2c74` is **local only — not pushed**. Review the diff
  (especially `src/lib/runModelForRace.ts`, `src/lib/raceData.ts`,
  `src/lib/modelPerformance.ts`, `src/lib/modelRunGuard.ts`) before pushing.
- The operator race notes and the model-improvement plan were intentionally left
  out of that commit (separate concern); confirm how you want those tracked.
- This is **decision-support only, not betting advice**. No secrets are stored in
  docs or code; they live solely in git-ignored `.env.local`.
