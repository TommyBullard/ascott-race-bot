# Royal Ascot Saturday 2026-06-20 — Readiness Report

> Decision-support only. No auto-betting, no bet placement, no staking changes.
> Nothing in this session made ML or GenAI model-active. Engines (bettingEngine,
> modelProbabilities, runModelForRace, kellyStake) were not touched.

## What this session changed (code, this turn)

- NEW `src/lib/tipsterPublicConsensus.ts` — pure research-only consensus builder.
- NEW `scripts/tipsterPublicConsensus.ts` — CLI `tipster:public-consensus` (read-only).
- NEW `scripts/tipsterPublicConsensus.test.ts` — 9 tests (registered).
- `package.json` — added `tipster:public-consensus` script.
- Generated artifacts: `reports/tipster-public-consensus-2026-06-20-ascot.md` + `.json`.

Gates: **lint 0, typecheck 0, 1501 tests pass (+9), build OK** (BUILD_ID `D9pkg5jr7sRqohnnrIMsM`).
Nothing committed or pushed.

## Task-by-task status

| # | Task | Status |
| --- | --- | --- |
| 1 | Friday settlement + reports | OPERATOR — needs live DB + settle-ready gate (commands below) |
| 2 | Update training data + train shadow model | OPERATOR — gated on Friday settled; 16→19 model already exists |
| 3 | Saturday ML shadow comparison | OPERATOR — model run already populated; predict/compare below |
| 4 | Saturday GenAI commentary | OPERATOR — needs `--live` + `OPENAI_API_KEY`; stays pending/shadow |
| 5 | Saturday tipster dataset review | DONE (read-only) — no approved rows → NO_TIPSTER_CONSENSUS remains |
| 6 | Tipster public-consensus report | **DONE — new code, report generated** |
| 7 | Confidence explanation | ALREADY PRESENT — confidence ladder + explanation panel |
| 8 | Dashboard Saturday polish | VERIFY via URL (read-only); date-aware already |
| 9 | Safety/separation tests | ALREADY PRESENT + extended (source-scan tests in new suite) |
| 10 | Validation | **DONE — lint/typecheck/test/build all green** |
| 11 | This report | **DONE** |

## Task 6 result (delivered)

7 races, 133 public-source rows grouped by race → runner. Each race shows
`race | runner | # public-source mentions | sources | model pick | market favourite | agreement`.

- Syndication de-dup works: Jon Vine via **Freetips + RacingInsider** is counted
  once and flagged `⚠ syndicated`. PR-family rows are flagged `⚠ PR-family`.
- Example — **14:30 Norfolk Stakes**: model pick = market favourite = **Carry The
  Flag**, which is also the top public pick (9 mentions) → full agreement.
- Research-only: this converts **no** mention into a model-active selection.

## Tipster dataset review (Task 5)

`data/tipster-opinions-2026-06-20-ascot-manual-review.csv` is present: all rows
are `review_status=pending`, `model_active_eligible=false`, licence `public_allowed`.
Per the rules (no pending, no ineligible, no unknown-licence, no missing evidence,
no unmatched rows), **zero rows are eligible to import**. No
`data/tipster-opinions-2026-06-20-ascot-approved.csv` is created.

**Honest result: NO_TIPSTER_CONSENSUS remains for 2026-06-20.** It clears only
after an operator hand-verifies real public picks, sets them approved +
`model_active_eligible=true`, imports them, and re-runs the model.

## ML shadow model (Tasks 2–3)

- `data/models/ml-shadow-ascot-2026-06-16-to-2026-06-19.json` **already exists**
  (primary). Fallback `...-2026-06-16-to-2026-06-18.json` also present.
- The Saturday regular model has run (model pick populated in the consensus enrich),
  so once Saturday predictions are generated the panel will stop showing
  "ML shadow pick not available".

## Exact operator command loops (credential-gated, run locally)

These touch live Supabase/Betfair and the settle-ready safety gate, so they are
for the operator to run — none were executed with `--commit` in this session.

```text
# 1. Friday settlement (dry-run FIRST; only commit if gate says settle-ready)
npm run results:auto -- --date 2026-06-19 --course Ascot            # dry-run
npm run results:auto -- --date 2026-06-19 --course Ascot --commit   # ONLY if settle-ready

# 1b. Friday reports (after settled)
npm run report:day -- --date 2026-06-19 --course Ascot
npm run lessons:day -- --date 2026-06-19 --course Ascot
npm run place:audit -- --date 2026-06-19 --course Ascot --places 4
npm run confidence:audit -- --date 2026-06-19 --course Ascot
npm run gates:audit -- --date 2026-06-19 --course Ascot

# 2. Training export + evaluate + train (ONLY if Friday settled)
npm run export:training-data -- --from 2026-06-16 --to 2026-06-19 --course Ascot
npm run ml:evaluate -- --input data/exports/training-data-2026-06-16-to-2026-06-19-ascot.csv
npm run ml:train-shadow -- --input data/exports/training-data-2026-06-16-to-2026-06-19-ascot.csv --course Ascot --output data/models/ml-shadow-ascot-2026-06-16-to-2026-06-19.json

# 3. Saturday ML shadow comparison (fall back to 16→18 model if 16→19 missing)
npm run export:training-data -- --from 2026-06-20 --to 2026-06-20 --course Ascot
npm run ml:predict-shadow -- --date 2026-06-20 --course Ascot --model data/models/ml-shadow-ascot-2026-06-16-to-2026-06-19.json
npm run ml:compare-shadow -- --date 2026-06-20 --course Ascot --model data/models/ml-shadow-ascot-2026-06-16-to-2026-06-19.json

# 4. Saturday GenAI commentary (shadow, pending, model_active=false). Needs OPENAI_API_KEY.
npm run genai:commentary -- --date 2026-06-20 --course Ascot --live --commit
#   Approve ONLY the latest safe batch (operator SQL):
#   update genai_commentary set review_status='approved'
#   where meeting_date='2026-06-20' and course='Ascot'
#     and status='candidate' and model_active=false
#     and created_at=(select max(created_at) from genai_commentary
#                     where meeting_date='2026-06-20' and course='Ascot');

# 5. Tipster review (NO approved rows expected; do NOT import pending/ineligible)
npm run tipsters:review-opinions -- --file data/tipster-opinions-2026-06-20-ascot-manual-review.csv --registry data/tipster-source-registry-2026-06-19.csv
#   If (and only if) real approved rows exist -> approved CSV -> import -> verify -> pipeline:
#   npm run import:tipster-selections -- --file data/tipster-opinions-2026-06-20-ascot-approved.csv --commit
#   npm run verify:tipster-match -- --date 2026-06-20 --course Ascot
#   npm run pipeline:day -- --date 2026-06-20 --course Ascot --commit

# 6. Public-source consensus (research only — already generated this session)
npm run tipster:public-consensus -- --date 2026-06-20 --course Ascot

# 8. Dashboard
http://localhost:3000/?date=2026-06-20&course=Ascot
```

## Confirmations

- ✅ No model-active ML (shadow only; default NO-GO).
- ✅ No model-active GenAI (model_active=false, review-gated, generated pending only).
- ✅ No staking / recommendation / EV logic changes (engines byte-untouched).
- ✅ No auto-betting and no bet-placement controls added.
- ✅ No scraping / network in the manual tipster + consensus path (local files only).
- ✅ Read-only / no-auto-betting banners remain on the public dashboard.

## Outstanding (operator)

- Friday settlement status: **unknown from this session** — run `results:auto`
  dry-run to confirm settle-ready before any commit.
- Approve real Saturday tipster picks to clear NO_TIPSTER_CONSENSUS.
- Run Saturday GenAI `--live --commit` then approve the latest safe batch.
- Confirm the dashboard URL `?date=2026-06-20&course=Ascot` shows fresh Saturday
  labels, the ML shadow panel, and the GenAI empty/approved state.
