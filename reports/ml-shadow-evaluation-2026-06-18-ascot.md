# ML shadow evaluation (offline baseline — no model trained)

Input: data/exports/training-data-2026-06-18-to-2026-06-18-ascot.csv  
Generated: 2026-06-19T00:40:17.606Z  
Races: 7 · runners: 127 · settled races: 7

> Offline / shadow evaluation only. This trains NO model, persists nothing,
> activates no ML, and changes no live recommendation or stake. It compares a
> market-only baseline with the current model signals and simple deterministic
> baselines over an EXPORTED dataset. No edge is claimed; this is not betting
> advice.

## 1. Executive summary

- Dataset: 7 race(s), 127 runner(s), 7 settled.
- Market favourite strike rate: +66.7%.
- Model-rank baseline strike rate: +66.7%; ROI: +301.7% (shadow model-rank baseline — NOT the production recommendation).
- This is not the production recommendation record. Production recommendation performance is reported separately by /api/accuracy performance.
- Leakage check: PASS.
- ⚠️ Sample is far too small (7 settled < 100); results are not evidence of anything.

## 2. Input file and leakage check

- Input: data/exports/training-data-2026-06-18-to-2026-06-18-ascot.csv
- Leakage check: **PASS**
- Label columns (used as labels only): finish_pos, won, placed, sp_decimal, bsp_decimal
- Feature columns: race_id, runner_id, race_date, course, off_time, race_name, race_type, is_handicap, field_size, runner_name, draw, age, weight, official_rating, trainer, jockey, pre_off_odds, market_rank_pre_off, model_prob_pre_off, model_rank_pre_off, ev_pre_off, confidence, data_quality, data_quality_flags, tipster_alignment, tipster_support_share
- No leakage columns are used as features.

## 3. Dataset summary

- Dates: 2026-06-18
- Courses: Ascot
- Races: 7
- Runners: 127
- Settled races: 7

## 4. Baseline comparison

| Baseline | Rule | Races | Settled | Winners | Strike | ROI | P/L |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Market favourite | Pick the shortest-priced runner per race. | 7 | 3 | 2 | +66.7% | +301.7% | +9.05pt |
| Model-rank baseline (not production recommendation) | Pick model_rank_pre_off = 1 (else highest model_prob). Top model probability/rank only — NOT the persisted production recommendation. | 7 | 3 | 2 | +66.7% | +301.7% | +9.05pt |
| Highest EV | Pick the highest exported ev_pre_off per race. | 7 | 3 | 3 | +100.0% | +401.7% | +12.05pt |

_Flat 1-unit stakes at the exported pre-off odds; settled races only count toward strike/ROI._

> This is not the production recommendation record. Production recommendation performance is reported separately by /api/accuracy performance.
> The “Model-rank baseline” above is the top model probability/rank runner, which is NOT how the production recommendation is chosen (production recommendations are EV/stake driven and gated).

- Persisted recommendation baseline: unavailable in this export; use /api/accuracy performance or report:day.

## 5. Calibration / probability quality (market-implied)

- Brier score: 0.0484 (lower is better; null when no settled priced races)
- Log loss: 0.1733

| Prob bucket | Count | Mean predicted | Actual win rate |
| --- | --- | --- | --- |
| 0.00-0.20 | 119 | 0.046 | 0.050 |
| 0.20-0.40 | 5 | 0.297 | 0.200 |
| 0.40-0.60 | 0 | — | — |
| 0.60-0.80 | 0 | — | — |
| 0.80-1.00 | 0 | — | — |

## 6. Odds-band performance

_Market-favourite picks grouped by the pick’s odds band._

### Odds bands

| Band | Picks | Settled | Winners | Strike | ROI |
| --- | --- | --- | --- | --- | --- |
| <3.0 | 2 | 1 | 0 | 0.0% | −100.0% |
| 3.0-8.0 | 3 | 1 | 1 | +100.0% | +245.0% |
| >8.0 | 2 | 1 | 1 | +100.0% | +760.0% |

## 7. Confidence-band performance

_Model-rank picks grouped by the pick’s confidence score (low <0.34, medium <0.67, high otherwise)._

### Confidence bands

| Band | Picks | Settled | Winners | Strike | ROI |
| --- | --- | --- | --- | --- | --- |
| low | 6 | 3 | 2 | +66.7% | +301.7% |
| medium | 1 | 0 | 0 | 0.0% | 0.0% |

## 8. Warnings and limitations

- ⚠️ Sample far too small (7 settled races < 100); every figure above is anecdotal.
- No leakage detected in the feature set.
- Market-implied probabilities are normalised per race (overround removed); they are not a model.
- No model was trained, tuned, or persisted; these are fixed deterministic baselines.
- Do not optimise on a single day/meeting; that would be overfitting.

## 9. GO / NO-GO

- **NO-GO for promotion.** No ML model may be promoted to production (or made model-active) on this evaluation.
- Promotion requires large, out-of-sample, leakage-free evaluation across many meetings, with calibration and ROI that beat the market-only baseline — none of which a single dataset can show.
- This scaffold is decision-support / research only. It is not betting advice and claims no edge.
