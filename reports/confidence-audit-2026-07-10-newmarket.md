# Confidence decomposition audit — 2026-07-10

Course: Newmarket  
Generated: 2026-07-10T21:58:02.822Z  
Races: 7

> Diagnostic / display-only. This decomposes WHY each run is Low/Medium/High
> confidence from stored metadata. It does NOT change the model probability,
> staking, ranking, recommendation, or the persisted confidence, and it never
> rescales a LOW confidence upward. Unknown components are shown honestly.
> Decision-support only — not betting advice.

## Summary

- Original confidence labels: low 6 · medium 0 · high 0 · unknown 1

Component breakdown:
- data_confidence: low 0 · medium 3 · high 4 · unknown 0
- market_confidence: low 4 · medium 3 · high 0 · unknown 0
- tipster_confidence: low 0 · medium 0 · high 0 · unknown 7
- contextual_confidence: low 0 · medium 0 · high 0 · unknown 7
- race_type_confidence: low 0 · medium 4 · high 3 · unknown 0
- execution_confidence: low 1 · medium 0 · high 6 · unknown 0

- Repeated low-confidence causes: market (4), execution (1)
- Races where original was LOW but data quality was OK: 3
- Races where original was LOW with DIVERGENT / no-consensus tipsters: 6
- Races where original was LOW and data quality was degraded: 3

## 12:50 — Oddschecker Handicap (Heritage Handicap) (GBBPlus Race)

- Model pick: —
- Original confidence (unchanged): —

- data_confidence: high — run quality OK, no material flags
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: medium — handicap (6 runners)
- execution_confidence: low — no pre-off odds recorded for the pick
- overall diagnostic: low — weakest-link diagnostic, limited by market, execution (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 13:25 — Duchess Of Cambridge Stakes (Sponsored By Ultimate Provence) (Fillies' Group 2)

- Model pick: Senorita Bonita
- Original confidence (unchanged): low

- data_confidence: high — run quality OK, no material flags
- market_confidence: medium — prices available; limited or unknown model-vs-market separation
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: high — non-handicap, 8 runners
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: medium — weakest-link diagnostic, limited by market (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 14:00 — Betway Trophy (Heritage Handicap) (GBBPlus Race)

- Model pick: Goblet Of Fire
- Original confidence (unchanged): low

- data_confidence: medium — DEGRADED data quality
- market_confidence: medium — prices available; limited or unknown model-vs-market separation
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: medium — handicap (10 runners)
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: medium — weakest-link diagnostic, limited by data, market, race_type (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 14:35 — Tattersalls Sceptre Sessions Falmouth Stakes (Fillies' & Mares' Group 1)

- Model pick: Blue Bolt
- Original confidence (unchanged): low

- data_confidence: high — run quality OK, no material flags
- market_confidence: medium — prices available; limited or unknown model-vs-market separation
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: high — non-handicap, 7 runners
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: medium — weakest-link diagnostic, limited by market (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 15:10 — Weatherbys Banking Group British EBF Maiden Fillies' Stakes (GBB Race)

- Model pick: Acting Lady
- Original confidence (unchanged): low

- data_confidence: medium — DEGRADED data quality
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: high — non-handicap, 11 runners
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by market (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 15:45 — Debenhams Handicap

- Model pick: Tatterstall
- Original confidence (unchanged): low

- data_confidence: medium — DEGRADED data quality
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: medium — handicap (12 runners)
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by market (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 16:20 — Jockey Club Estates Handicap

- Model pick: Sierra Sands
- Original confidence (unchanged): low

- data_confidence: high — run quality OK, no material flags
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: medium — handicap (11 runners)
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by market (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
