# ML shadow comparison — 2026-06-20 · Ascot

> ML shadow pick — not model-active. Research only. Does not affect staking or recommendations.

## Candidate model

- Trained: 2026-06-19T08:10:49.914Z
- Training range: 2026-06-16 to 2026-06-18
- Settled training rows: 268 across 21 settled races (SMALL SAMPLE — low confidence)
- Features: model_prob_pre_off, market_rank_pre_off, model_rank_pre_off, ev_pre_off, confidence, pre_off_odds, field_size, is_handicap
- Label: won
- In-sample Brier: 0.062 · log loss: 0.226 · top-1 race hit: 42.9% (in-sample fit, not out-of-sample skill)

## Side-by-side

| Off | Race | Regular model pick | ML shadow pick (prob) | Market favourite | Agreement |
| --- | ---- | ------------------ | --------------------- | ---------------- | --------- |
| 2026-06-20T13:30:00+00:00 | Norfolk Stakes (Group 2) | Carry The Flag | Carry The Flag (23.9%) | Carry The Flag | All three agree (ML, model, market) |
| 2026-06-20T14:05:00+00:00 | Hardwicke Stakes (Group 2) | Kalpana | Kalpana (30.2%) | Kalpana | All three agree (ML, model, market) |
| 2026-06-20T14:40:00+00:00 | Queen Elizabeth II Jubilee Stakes (Group 1) | Joliestar | Joliestar (52.7%) | Joliestar | All three agree (ML, model, market) |
| 2026-06-20T15:20:00+00:00 | Jersey Stakes (Group 3) | Saber Strike | Saber Strike (51.4%) | Saber Strike | All three agree (ML, model, market) |
| 2026-06-20T16:00:00+00:00 | Wokingham Stakes (Heritage Handicap) | Binhareer | Binhareer (21.1%) | Binhareer | All three agree (ML, model, market) |
| 2026-06-20T16:35:00+00:00 | Golden Gates Stakes (Handicap) | Lost Boys | Lost Boys (32.6%) | Lost Boys | All three agree (ML, model, market) |
| 2026-06-20T17:10:00+00:00 | Queen Alexandra Stakes (Conditions Race) (GBBPlus Race) | Illinois | Illinois (42.6%) | Illinois | All three agree (ML, model, market) |

## Warnings

- Small training sample (21 settled races < 100); treat the ML shadow pick as low-confidence research only.

---

The ML shadow pick is research/decision-support only. It is NOT model-active and does not change production probabilities, EV, staking, confidence, the no-bet gate, or any recommendation. No bet is placed or suggested. The regular model pick remains the only recommendation.
