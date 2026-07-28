# Pre-off decision-support validation

`validate:pre-off` builds a reproducible, **read-only** scorecard of the
production model's pre-off decision support from **already-persisted evidence**.
It answers: over a settled date range, is the model's pre-off decision support
*useful and trustworthy* — is its probability well-calibrated, does it add value
over the market, do the recommendations and confidence bands hold up?

It is **decision-support evidence, not a winner-prediction claim and not a
profit promise.** It places and enables no bet.

---

## What it does (and never does)

- **Reads only.** It issues `select` queries via the service-role client and
  joins the FINAL PRE-OFF run (`run_time <= off_time`, via the shared
  `selectPreOffRun`) to stored `model_runner_scores` (`model_prob` /
  `market_prob`), the stored rank-1 `recommendations` (odds / stake / EV /
  confidence), and recorded `runners.finish_pos`.
- **Never runs or re-scores the model.** No `scoreRaceRunners`,
  `runModelForRace`, `refreshModelForMeeting`, or `runModelForMeetingRaces`.
- **Never** fetches odds, imports/settles results, creates recommendations or
  locks, mutates the database, acquires a producer claim, or places a bet.
- The **only** writes are the optional local report files.

It reuses the committed maths: `calibrateBinary` / `reliabilityBins` /
`brierScore` / `logLoss` / `expectedCalibrationError` (`src/lib/mlCalibration.ts`)
and `summarizeModelPerformance` (`src/lib/modelPerformance.ts`).

---

## Usage

```
npm run validate:pre-off -- --from YYYY-MM-DD --to YYYY-MM-DD [--course <name>] [--report] [--json]
```

- `--from`, `--to` — **mandatory**. There is **no implicit window**.
- `--course` — optional; filtered with the canonical `normalizeCourse` rule.
- `--report` — write a deterministic Markdown report.
- `--json` — write / print a deterministic machine-readable report.

Invalid input (missing/malformed/impossible dates, `--from` later than `--to`,
blank course, unknown flags, `--commit`) is rejected by the pure parser **before
any database, filesystem, provider, or model access**.

Report paths (never overwrite another scope):

```
reports/pre-off-validation-<from>-to-<to>-all-courses.md
reports/pre-off-validation-<from>-to-<to>-<course-slug>.md   (+ .json)
```

Exit codes: `0` PASS · `3` REVIEW or INSUFFICIENT_EVIDENCE · `1` usage · `2` a
primary read failure.

---

## What it measures (DIAGNOSTIC layer)

| Dimension | Method |
| --- | --- |
| **Coverage** | Races in scope, with a pre-off run, settled vs pending, no-pre-off-run, and read errors. |
| **Ranking** | Winner top-1/2/3 accuracy for **model** and **market**, plus a top-1 agreement matrix (both / model-only / market-only / neither). Score ties resolved deterministically by runner id. |
| **Decision performance** | `summarizeModelPerformance` on the **diagnostic** stored pre-off rank-1 recommendations (NOT official locked decisions): strike, ROI, P/L, no-bet, avg EV — at **stored** odds/stake only. |
| **Model calibration** | `calibrateBinary(model_prob → won)`: Brier, log-loss, ECE, MCE, reliability bins. |
| **Market baseline** | The same calibration on `market_prob`, plus market-favourite strike rate. Market ROI is **NOT MEASURED** (no tradeable stored price). |
| **Segments** | Strike/ROI by confidence, course, odds band, and stored-EV sign. Small segments stay visible, flagged `(insufficient)`, never dropped. |

Explicitly **NOT MEASURED** (schema cannot support / separate layer): the
**official locked-decision layer** (evaluated separately by `report:locked`,
never merged here), **handicap / field-size / country** segmentation (fetching
those reliable stored fields is the fix; they are never inferred from strings),
**each-way** validation (terms not stored), **chronological drawdown**, and
**market ROI**.

### Verdict — evidence quality, NOT profitability

The verdict is an **evidence-quality** judgement. It **never** depends on the
model beating the market, on ROI, on any profitability threshold, or on a
promotion decision — those are **descriptive** findings only.

- **FAIL** — an invariant violation, or a proven **pre-off leakage** (a
  post-off run was selected).
- **REVIEW** — scoped races could not be read (evidence incomplete), without a
  fatal boundary failure.
- **INSUFFICIENT_EVIDENCE** — valid evidence but the settled sample is below
  `MIN_SETTLED_DECISIONS` (50) or the calibration sample is below
  `MIN_CALIBRATION_SAMPLES` (100). The honest default for a young dataset —
  never a manufactured PASS.
- **PASS** — required reads succeeded, the strict pre-off/as-of boundary is
  proven, required evidence is complete, the sample thresholds are met, no
  invariant is violated, and output is deterministic.

**Descriptive signals** (`favourable` / `unfavourable` / `not_measured`) —
calibration quality, model-vs-market, decision ROI sign, confidence ordering,
EV honesty — are reported for interpretation but **do not change the verdict**.
Executable **invariants** (non-negative counts; settled ≤ scoped; winners ≤
settled; top-2 ≥ top-1, top-3 ≥ top-2; calibration bins reconcile;
probabilities in [0,1]; winner-label validity; the pre-off boundary; diagnostic/
official separation) are checked in the aggregator; any violation forces FAIL.

---

## Honest limitations (baked into every report)

- Calibration/ROI use **stored** per-runner scores and **stored** odds/stake
  only — no re-scoring — so results describe the model **as it actually ran**,
  not a counterfactual.
- **Market-baseline ROI is NOT computed.** `market_prob` is an implied
  probability, not a tradeable price, so the market comparison is calibration +
  favourite strike only — market ROI is listed under NOT MEASURED. No claim of
  statistical superiority is made.
- The **official locked-decision layer is separate** — this command evaluates
  only the diagnostic pre-off layer and never merges official history into these
  figures (see `report:locked`).
- Thin samples cannot support a verdict — the report says so rather than
  guessing; small segments stay visible but are flagged `(insufficient)`.
- The verdict is evidence quality only — **no ROI threshold, no profitability
  threshold, no "model beats market" requirement, no production-promotion
  conclusion.**
- The model is an explanatory EV/value engine, **not a winner predictor**; ROI
  at stored SP/BSP is historical, not a promise; nothing here places or enables
  a bet.

---

## Verification

Offline (no DB): `npm run typecheck && npm run lint && npm run test` — the pure
parser, aggregator, verdict, and rendering are unit-tested with injected
fixtures, and source scans confirm the CLI is strictly SELECT-only and never
touches a scoring function.

Then one read-only run against stored data is the attended check — it only
`select`s and writes a local report:

```
npm run validate:pre-off -- --from 2026-06-01 --to 2026-07-31 --report
```

If the settled sample is thin, expect **INSUFFICIENT_EVIDENCE**, not a
manufactured PASS.
