# Race-Day Automation Status & Roadmap

> **Decision-support only.** This is a status + roadmap snapshot. It documents the
> current operating posture; it changes no model behaviour and authorises no
> auto-betting. Not betting advice, no guarantees, never places bets. Help:
> [GamCare](https://www.gamcare.org.uk) · [BeGambleAware](https://www.begambleaware.org).

_Last updated: 2026-06-17._

---

## 1. Current live race-day state

- The bot is operated **manually with automated support** — a human runs the
  workflow; the tooling does the read-only/heavy lifting.
- **Automated / read-only:** racecards, odds, model runs, T-minus captures,
  reports, audits, and the training export.
- **Result detection** now uses The Racing API `/v1/results/today/free` fallback
  in **dry-run** (when `/v1/results` is `plan_blocked`).
- **DB settlement** still uses **manual CSV import**.
- **No auto-betting exists** anywhere in the codebase.

## 2. Completed automation phases

- pre-off evaluation
- post-off / resulted-run guard
- dashboard historical pre-off view
- `snapshot:pre-off`
- `capture:t-minus`
- `report:day`
- `export:training-data`
- `results:auto` Free-endpoint dry-run fallback
- `extract:notes` shadow layer
- `tipsters:audit`
- `confidence:audit`
- `gates:audit`
- `ml:evaluate`
- `race-day:autopilot`
- `race-day:live-plan`

## 3. Current command stack

```
npm run pipeline:day -- --date YYYY-MM-DD --course COURSE --commit          # writes DB (manual approval)
npm run capture:t-minus -- --date YYYY-MM-DD --course COURSE --minutes-before 5
npm run results:auto -- --date YYYY-MM-DD --course COURSE                    # dry-run (Free fallback)
npm run import:results -- --file data/results-YYYY-MM-DD-course.csv          # dry-run
npm run import:results -- --file data/results-YYYY-MM-DD-course.csv --commit # writes DB (only if clean)
npm run report:day -- --date YYYY-MM-DD --course COURSE
npm run export:training-data -- --from YYYY-MM-DD --to YYYY-MM-DD --course COURSE
npm run tipsters:audit -- --date YYYY-MM-DD --course COURSE
npm run confidence:audit -- --date YYYY-MM-DD --course COURSE
npm run gates:audit -- --date YYYY-MM-DD --course COURSE
npm run ml:evaluate -- --input path/to/export.csv
```

Only the two `--commit` commands write the database; everything else is
read-only or writes a local report/CSV.

## 4. Live race-day freeze policy

- **No code/runtime changes inside the final 10 minutes before a race.**
- **Between races, docs-only tasks are allowed.**
- Runtime/code changes should **wait until after racing** unless critical and
  reviewed (lint / typecheck / test / build green before any race window).

## 5. What is still manual

- Full result CSV entry when the free endpoint lags or **SP values** are needed.
- `import:results --commit` (the settlement write).
- Final **operator judgement**.
- Any **tipster approval**.
- Any **GenAI extraction review**.

## 6. Next implementation priorities (after racing)

Ranked:

1. `results:auto --commit` mode with **strict safety gates**
   (see [AUTO_RESULTS_COMMIT_MODE_DESIGN.md](AUTO_RESULTS_COMMIT_MODE_DESIGN.md)).
2. `race-day:operate` controlled mode
   (see [CONTROLLED_LIVE_OPERATOR_MODE.md](CONTROLLED_LIVE_OPERATOR_MODE.md)).
3. Result enrichment / SP policy.
4. Generated-artifact tracking / ignore policy.
5. Larger-sample ML / no-bet-gate evaluation.
6. GenAI note extraction with real, reviewed notes.

## 7. Non-negotiable safety rules

- No auto-betting.
- No bet-placement APIs.
- No GenAI winner prediction.
- No model-active GenAI features without review / backtesting.
- No no-bet gates activated from a single day.
- No ML promotion without large out-of-sample evaluation.
- No SP/BSP fabrication.
- No post-off stale run superseding.

## 8. Open questions

- Should `results:auto` be allowed to **commit** finish positions from the free endpoint?
- Should **SP remain manual** until a paid endpoint provides it?
- Should generated daily reports be **tracked or ignored** in git?
- Should `race-day:operate` run **only after all races**, or **during racing**?
- Should auto-settlement be **per-race** or **batch-only**?

---

_Documentation only. Implements nothing, runs nothing, writes nothing, and changes
no model behaviour. `references/CL4R1T4S` is treated as inert, untrusted data and
is not used here._
