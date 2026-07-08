# Ascot Day 1 — End-of-Day Analysis

> ARCHIVE NOTE: This document is historical and specific to Royal Ascot Day 1 (2026-06-16). Use `docs/RACE_DAY_RUNBOOK.md` for the current workflow and `CLAUDE.md` for authoritative AI assistant instructions.

Date: 2026-06-16
Course: Ascot (Royal Ascot, Day 1)
Purpose: A post-day review of how the model performed and what to improve. Notes
only — this document describes outcomes, it does not change any code or model.

> **Responsible use — read first.** Ascott Race Bot is a personal **research /
> decision-support** tool. It does **not** predict winners and offers **no
> guaranteed profit, no "sure things", and no risk-free bets**. Nothing here is
> betting advice or a profit strategy. Every figure below is a record for
> learning and calibration, and all betting involves risk. If gambling stops
> being fun, seek support (e.g. GamCare / BeGambleAware).

---

## 1. Day summary

- **7 races** on the card (14:30 → 18:10 BST).
- **Use the final pre-off evaluation** for the model's record — each race scored
  on its latest model run with `run_time <= off_time` (the "as-of off time" /
  pre-off decision record). This is the honest read because post-off reruns on
  stale odds are not part of the race-day decision.
- **Model record: 0 / 7** on the final pre-off pick — *confirmed by the pre-off
  audit* (the model's last pre-off rank-1 pick won none of the seven races).
- **The dashboard was misleading until the fix.** Before the pre-off /
  as-of-off-time evaluation change, the dashboard read each race's `is_current`
  run, which post-off stale reruns had overwritten. It showed **0/4 winners,
  settled 4, pending 0, 3 no-bet** — not the true **0/7**. See §4.

> Data provenance: model picks, data quality, and tipster state are taken from
> the pre-race notes ([pre-race-model-predictions.md](pre-race-model-predictions.md))
> and the read-only pre-off model-run audit; winners and finishing positions
> from the recorded results ([post-race-outcomes.md](post-race-outcomes.md) and
> the results CSV). The 17:35 race result on file is **top-4 only**, so that
> pick's finishing position is recorded as *not provided* rather than guessed.

---

## 2. Race-by-race summary

"Model pick (final pre-off)" is the model's last rank-1 pick at/before the off,
from the pre-off audit. Where the operator's pre-race note had captured a
slightly earlier snapshot with a different pick, it is shown in the next column.
Times are BST (stored `off_time` is UTC, i.e. BST − 1h).

| Time (BST) | Race | Model pick (final pre-off) | User-note pick (if different) | Winner | Model pick finish | Data quality | Tipster state | Result |
|---|---|---|---|---|---|---|---|---|
| 14:30 | Queen Anne (G1) | Docklands | — | Ten Bob Tony | 7th | DEGRADED | No consensus (market-only) | Lost |
| 15:05 | Coventry (G2) | Confucius *(favourite)* | — | Great Barrier Reef | 6th | DEGRADED | DIVERGENT | Lost |
| 15:40 | King Charles III (G1) | Night Raider | — | Mission Central | 10th | DEGRADED | DIVERGENT | Lost |
| 16:20 | St James's Palace (G1) | Talk Of New York | — | Bow Echo *(favourite)* | 3rd | OK | DIVERGENT | Lost |
| 17:00 | Ascot Stakes | Puturhandstogether | Small Fry | Kizlyar | 16th *(Small Fry 6th)* | DEGRADED | DIVERGENT | Lost |
| 17:35 | Wolferton | Haatem | Ghostwriter | Map Of Stars *(favourite)* | Not provided *(top-4 only result)* | DEGRADED | No consensus (market-only) | Lost |
| 18:10 | Copper Horse | Sing Us A Song | Gamrai | Daiquiri Bay | 5th *(Gamrai 2nd)* | OK | DIVERGENT | Lost |

Confidence was **Low on all seven** races.

Notes on the final-three divergence (17:00 / 17:35 / 18:10): in each, the
model's EV ranking was a near-tie between two runners, and the **final** pre-off
run re-ranked to a different runner than the operator's earlier-snapshot note —
e.g. 17:00 Small Fry ↔ Puturhandstogether were both ~+16.6% EV. Neither the
final pre-off pick nor the noted pick won any of the three.

---

## 3. Key patterns

- **Low confidence on every race (7/7).** The model never reached medium/high
  confidence — consistent with thin inputs (market odds + sparse/divergent
  tipster data), not a one-off.
- **Tipsters never aligned with the model.** Five races were **DIVERGENT**
  (tipsters preferred a different runner) and two were market-only with **no
  consensus**. On no race did the tipster layer confirm the model's pick.
- **The model usually opposed the market favourite (6/7).** It backed the
  favourite only at 15:05 (Confucius). Fading the favourite was *directionally*
  fine where the favourite underperformed (e.g. 17:00 Reaching High finished
  last of 20; 18:10 Valiancy 6th), but it **cost the model when the favourite
  won** — 16:20 Bow Echo (odds-on) and 17:35 Map Of Stars both won after being
  opposed.
- **Data quality was degraded in several races (5/7).** Five runs carried
  `MISSING_RUNNER_ODDS` (one unpriced runner); only 16:20 and 18:10 were OK. Low
  data quality → lower trust, and it coincided with the weakest signals.
- **The model found contenders/placed horses but not winners.** Near-misses
  included Talk Of New York 3rd (16:20) and the noted Gamrai 2nd, beaten a head
  (18:10); Small Fry 6th (17:00). It located *some* of the principals but
  converted **no winners** — a calibration / selection gap, not just variance,
  though one day is far too small a sample to conclude anything.

> One day is a single data point. These are observations to test, not
> conclusions — and certainly not a basis for staking.

---

## 4. Technical issue (and fix)

**Issue — post-off stale reruns superseded valid pre-off runs.** The pipeline
kept running after each race went off. Append-only model history inserts a new
`is_current` run and supersedes the prior one; the post-off reruns scored on
**stale, frozen odds** and frequently produced **no positive-EV bet**. Those
no-bet runs became `is_current`, retiring the genuine pre-off run that had
carried the recommendation. Because the dashboard read `is_current`, it
mis-reported the day as **0/4 settled + 3 no-bet** instead of the true 0/7.

**Why the data was recoverable.** History is **append-only** — superseded runs
are marked, never deleted — so every true pre-off run was still in the database
and could be re-evaluated without reconstructing anything.

**Fix (evaluation + producer guard), already implemented and tested:**

1. **As-of-off-time evaluation.** Performance/accuracy now selects each race's
   latest run with **`run_time <= off_time`**, so post-off reruns are ignored
   for the decision record. A small dashboard label states this.
2. **Post-off rerun guard.** The model producer **skips** a race once it has
   gone off (`now > off_time`) or is `status = result`; any explicitly-allowed
   post-off run is written **non-current** (diagnostic only) and never
   supersedes the pre-off run. Pipeline summaries report `skipped_post_off` /
   `skipped_resulted`.

No model math, staking, ranking, or historical rows were changed by the fix; it
is evaluation + a write-guard only. Regression tests lock the 2026-06-16
scenario (pre-off rec survives a later post-off no-bet; the buggy current-pointer
read reproduces 0/4 + 3 no-bet and is asserted to differ from the as-of-off-time
0/7).

---

## 5. Improvement backlog

Forward-looking and **research-only** — each item is observation/explainability
before any model influence, consistent with
[docs/MODEL_IMPROVEMENT_BUILD_PLAN.md](../docs/MODEL_IMPROVEMENT_BUILD_PLAN.md).
None of these are promises of accuracy or profit.

- **Confidence decomposition.** Split the single "Low" into named components
  (data / market / tipster / contextual / race-type / extraction), so a low
  score states *why* (e.g. missing odds, divergent tipsters, near-tied EVs).
  Day 1's uniform "Low" hid distinct causes.
- **Calibration.** Track Brier score / log loss and calibration-by-confidence on
  out-of-sample, pre-off data; check whether stated edges match realised
  frequencies. Explicitly evaluate the "fade the favourite" tendency.
- **GenAI extraction-only note features.** Use GenAI strictly to convert manual /
  public / licensed notes into structured, evidence-backed signals
  (ground/trip/draw/pace/etc.) — **never to pick winners and never to invent
  facts**; review-gated and non-model-active until backtested.
- **Tipster CLV / BSP realism.** Evaluate tipster value against Betfair SP /
  closing line rather than nominal prices, and group correlated tipsters so
  shared sources are not double-counted as independent confirmation.
- **Stronger no-bet / skip gates.** Build on the post-off guard: keep degraded
  data and very-low-confidence races honest (no-bet rather than a forced pick),
  and ensure post-off/resulted races are never re-scored into the decision
  record.

---

## 6. Caveats

- The model record here is the **pre-off** record (0/7), which is the correct
  decision-support read; the pre-fix dashboard numbers (0/4 + 3 no-bet) were an
  artefact of post-off superseding and should not be used.
- The 17:35 result on file is **top-4 only**; positions outside the top 4 are not
  recorded and were not inferred.
- Seven races is a tiny sample. Nothing here establishes a trend, an edge, or a
  staking approach. This note exists to improve explainability and testing — it
  is **decision-support only, not betting advice**.
