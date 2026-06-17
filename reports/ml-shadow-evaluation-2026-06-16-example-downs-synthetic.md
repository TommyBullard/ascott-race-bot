# ML shadow evaluation (offline baseline — no model trained)

Input: data/exports/training-data.example.csv  
Generated: 2026-06-17T11:50:12.398Z  
Races: 2 · runners: 6 · settled races: 2

> Offline / shadow evaluation only. This trains NO model, persists nothing,
> activates no ML, and changes no live recommendation or stake. It compares a
> market-only baseline with the current model signals and simple deterministic
> baselines over an EXPORTED dataset. No edge is claimed; this is not betting
> advice.

## 1. Executive summary

- Dataset: 2 race(s), 6 runner(s), 2 settled.
- Market favourite strike rate: +50.0%.
- Current model-rank strike rate: +100.0%; ROI: +250.0%.
- Leakage check: PASS.
- ⚠️ Sample is far too small (2 settled < 100); results are not evidence of anything.

## 2. Input file and leakage check

- Input: data/exports/training-data.example.csv
- Leakage check: **PASS**
- Label columns (used as labels only): finish_pos, won, placed, sp_decimal, bsp_decimal
- Feature columns: race_id, runner_id, race_date, course, off_time, race_name, race_type, is_handicap, field_size, runner_name, draw, age, weight, official_rating, trainer, jockey, pre_off_odds, market_rank_pre_off, model_prob_pre_off, model_rank_pre_off, ev_pre_off, confidence, data_quality, data_quality_flags, tipster_alignment, tipster_support_share
- No leakage columns are used as features.

## 3. Dataset summary

- Dates: 2026-06-16
- Courses: Example Downs (SYNTHETIC)
- Races: 2
- Runners: 6
- Settled races: 2

## 4. Baseline comparison

| Baseline | Rule | Races | Settled | Winners | Strike | ROI | P/L |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Market favourite | Pick the shortest-priced runner per race. | 2 | 2 | 1 | +50.0% | 0.0% | 0.00pt |
| Current model rank | Pick model_rank_pre_off = 1 (else highest model_prob). | 2 | 2 | 2 | +100.0% | +250.0% | +5.00pt |
| Highest EV | Pick the highest exported ev_pre_off per race. | 2 | 2 | 2 | +100.0% | +250.0% | +5.00pt |

_Flat 1-unit stakes at the exported pre-off odds; settled races only count toward strike/ROI._

## 5. Calibration / probability quality (market-implied)

- Brier score: 0.2185 (lower is better; null when no settled priced races)
- Log loss: 0.6124

| Prob bucket | Count | Mean predicted | Actual win rate |
| --- | --- | --- | --- |
| 0.00-0.20 | 2 | 0.125 | 0.000 |
| 0.20-0.40 | 2 | 0.261 | 0.500 |
| 0.40-0.60 | 1 | 0.571 | 1.000 |
| 0.60-0.80 | 1 | 0.656 | 0.000 |
| 0.80-1.00 | 0 | — | — |

## 6. Odds-band performance

_Market-favourite picks grouped by the pick’s odds band._

### Odds bands

| Band | Picks | Settled | Winners | Strike | ROI |
| --- | --- | --- | --- | --- | --- |
| <3.0 | 2 | 2 | 1 | +50.0% | 0.0% |

## 7. Confidence-band performance

_Model-rank picks grouped by the pick’s confidence score (low <0.34, medium <0.67, high otherwise)._

### Confidence bands

| Band | Picks | Settled | Winners | Strike | ROI |
| --- | --- | --- | --- | --- | --- |
| medium | 1 | 1 | 1 | +100.0% | +400.0% |
| high | 1 | 1 | 1 | +100.0% | +100.0% |

## 8. Warnings and limitations

- ⚠️ Sample far too small (2 settled races < 100); every figure above is anecdotal.
- No leakage detected in the feature set.
- Market-implied probabilities are normalised per race (overround removed); they are not a model.
- No model was trained, tuned, or persisted; these are fixed deterministic baselines.
- Do not optimise on a single day/meeting; that would be overfitting.

## 9. GO / NO-GO

- **NO-GO for promotion.** No ML model may be promoted to production (or made model-active) on this evaluation.
- Promotion requires large, out-of-sample, leakage-free evaluation across many meetings, with calibration and ROI that beat the market-only baseline — none of which a single dataset can show.
- This scaffold is decision-support / research only. It is not betting advice and claims no edge.
