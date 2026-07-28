# Pre-off decision-support validation — 2026-07-09 to 2026-07-10 — Newmarket

Generated: 2026-07-28T11:19:51.411Z

**READ ONLY / AS-OF OFF.** Built from STORED evidence only (per-runner `model_prob`/`market_prob`,
stored rank-1 recommendations, recorded finishing positions). No model was run or re-scored; no odds
were fetched; no results were imported; no database row was mutated. This is the DIAGNOSTIC pre-off
layer; the official locked-decision history is evaluated separately (`report:locked`).

- Scope: Newmarket, 2026-07-09 → 2026-07-10
- Schema version: 2
- **Evidence-quality verdict: INSUFFICIENT_EVIDENCE**

## Coverage

| Metric | Value |
| --- | --- |
| Races in scope | 14 |
| With a pre-off run | 14 |
| Settled (with pre-off run) | 14 |
| Pending (with pre-off run) | 0 |
| No pre-off run | 0 |
| Read errors | 0 |

## Ranking (does the model rank the winner highly?)

| Series | n | Top-1 | Top-2 | Top-3 |
| --- | --- | --- | --- | --- |
| model_prob | 13 | 15.4% | 46.2% | 61.5% |
| market_prob | 13 | 15.4% | 46.2% | 61.5% |

Top-1 agreement (n=13): both 2, model-only 0, market-only 0, neither 11. Ties resolved deterministically by runner id.

## Diagnostic pre-off decision performance

_Stored diagnostic rank-1 recommendations (NOT official locked decisions — those come only from `locked_race_decisions` and are evaluated separately by `report:locked`)._

| Settled | Winners | Strike | ROI | P/L | No-bet | Avg EV |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 5 | 50.0% | 248.4% | 34.3632 | 4 | 0.2021 |

_Diagnostic P/L uses STORED recommendation odds/stake only; a win pays `stake*(odds-1)`, a loss `-stake`; pending races are never losses. Not betting advice._

## Probability calibration

| Series | n | Brier | logLoss | ECE | MCE | mean pred | mean obs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| model_prob | 114 | 0.097 | 0.3123 | 0.0477 | 0.6245 | 0.1228 | 0.114 |
| market_prob (baseline) | 114 | 0.1 | 0.3197 | 0.0759 | 0.6162 | 0.1228 | 0.114 |

Market favourite strike: 14.3% (2/14). **Market ROI: NOT MEASURED** (no tradeable stored price). Model-vs-market calibration (descriptive, non-gating): **model_better**.

### Model reliability diagram

| Bin | Range | Pred mean | Obs rate | n |
| --- | --- | --- | --- | --- |
| 0 | 0–0.1 | 0.042 | 0.0323 | 62 |
| 1 | 0.1–0.2 | 0.1343 | 0.129 | 31 |
| 2 | 0.2–0.3 | 0.2528 | 0.4545 | 11 |
| 3 | 0.3–0.4 | 0.3526 | 0.25 | 4 |
| 4 | 0.4–0.5 | 0.4782 | 0.25 | 4 |
| 5 | 0.5–0.6 | 0.5043 | 0 | 1 |
| 6 | 0.6–0.7 | 0.6245 | 0 | 1 |
| 7 | 0.7–0.8 | — | — | 0 |
| 8 | 0.8–0.9 | — | — | 0 |
| 9 | 0.9–1 | — | — | 0 |

## Segments

### By confidence

| Band | Settled | Strike | ROI | Avg EV |
| --- | --- | --- | --- | --- |
| LOW _(insufficient)_ | 10 | 50.0% | 248.4% | 0.2021 |

### By course

| Band | Settled | Strike | ROI | Avg EV |
| --- | --- | --- | --- | --- |
| Newmarket _(insufficient)_ | 10 | 50.0% | 248.4% | 0.2021 |

### By odds band

| Band | Settled | Strike | ROI | Avg EV |
| --- | --- | --- | --- | --- |
| 3.0-8.0 _(insufficient)_ | 6 | 66.7% | 285.7% | 0.2555 |
| >8.0 _(insufficient)_ | 4 | 25.0% | 169.8% | 0.122 |

### By stored-EV sign

| Band | Settled | Strike | ROI | Avg EV |
| --- | --- | --- | --- | --- |
| EV_POSITIVE _(insufficient)_ | 10 | 50.0% | 248.4% | 0.2021 |

_Small segments are shown and flagged `(insufficient)`, never silently dropped._

## Layers / dimensions NOT MEASURED

_Each logical limitation appears exactly once (the JSON `not_measured` array remains complete)._

- **Official locked-decision layer** — official locked_race_decisions are evaluated by report:locked; this diagnostic scorecard keeps the layers separate.
- **Each-way** — each-way terms (place count/fraction/price/dead-heat/non-runner) are not stored.
- **Chronological drawdown** — reliable per-bet chronological ordering is not established here.
- **Segmentation by handicap** — handicap flag not fetched by the SELECT (never inferred from strings).
- **Segmentation by field size** — field-size band not derived in this slice.
- **Segmentation by country** — country not fetched by the SELECT (never inferred from strings).
- market-baseline ROI (stored market_prob is an implied probability, not a tradeable price)
- decision-quality description (only 10 settled decisions; need >= 50)

## Descriptive signals (NOT part of the verdict)

| Signal | Finding |
| --- | --- |
| model_calibration_quality | favourable |
| market_comparison | favourable |
| decision_roi_sign | not_measured |
| confidence_ordering | not_measured |
| ev_honesty | not_measured |

_These describe the model; the PASS/REVIEW/INSUFFICIENT/FAIL verdict does NOT depend on them, on ROI, or on the model beating the market._

## Notes & honesty

- Verdict is an EVIDENCE-QUALITY judgement (completeness / boundary / thresholds / invariants) — NOT profitability and NOT a model-beats-market test. Model-vs-market and all quality signals are descriptive only.
- Diagnostic pre-off layer only; the official locked-decision history is separate (report:locked). Decision-support usefulness only — no bet is placed and no betting capability exists here.

Decision-support only — no bet was placed and no betting capability exists here.
