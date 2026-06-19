# ML shadow comparison — 2026-06-19 · Ascot

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
| 2026-06-19T13:30:00+00:00 | Albany Stakes (Group 3) (Fillies) | Sun Goddess | Sun Goddess (60.9%) | Sun Goddess | All three agree (ML, model, market) |
| 2026-06-19T14:05:00+00:00 | Commonwealth Cup (Group 1) (No Geldings) | Venetian Sun | Venetian Sun (54.3%) | Venetian Sun | All three agree (ML, model, market) |
| 2026-06-19T14:40:00+00:00 | Duke Of Edinburgh Stakes (Handicap) (GBBPlus Race) | Hopewell Rock | Hopewell Rock (30.1%) | Hopewell Rock | All three agree (ML, model, market) |
| 2026-06-19T15:20:00+00:00 | Coronation Stakes (Group 1) (Fillies) | Precise | Precise (80.5%) | Precise | All three agree (ML, model, market) |
| 2026-06-19T16:00:00+00:00 | Sandringham Stakes (Handicap) (Fillies) | Glyfada | Glyfada (26.1%) | Glyfada | All three agree (ML, model, market) |
| 2026-06-19T16:35:00+00:00 | King Edward VII Stakes (Group 2) (Colts & Geldings) | Causeway | Causeway (61.5%) | Causeway | All three agree (ML, model, market) |
| 2026-06-19T17:10:00+00:00 | Palace Of Holyroodhouse (Handicap) | Bacio | Bacio (19.0%) | Bacio | All three agree (ML, model, market) |

## Warnings

- Small training sample (21 settled races < 100); treat the ML shadow pick as low-confidence research only.

---

The ML shadow pick is research/decision-support only. It is NOT model-active and does not change production probabilities, EV, staking, confidence, the no-bet gate, or any recommendation. No bet is placed or suggested. The regular model pick remains the only recommendation.
