# Confidence decomposition audit — 2026-06-16

Course: Ascot  
Generated: 2026-06-17T12:44:06.933Z  
Races: 7

> Diagnostic / display-only. This decomposes WHY each run is Low/Medium/High
> confidence from stored metadata. It does NOT change the model probability,
> staking, ranking, recommendation, or the persisted confidence, and it never
> rescales a LOW confidence upward. Unknown components are shown honestly.
> Decision-support only — not betting advice.

## Summary

- Original confidence labels: low 7 · medium 0 · high 0 · unknown 0

Component breakdown:
- data_confidence: low 0 · medium 5 · high 2 · unknown 0
- market_confidence: low 3 · medium 4 · high 0 · unknown 0
- tipster_confidence: low 5 · medium 0 · high 0 · unknown 2
- contextual_confidence: low 0 · medium 0 · high 0 · unknown 7
- race_type_confidence: low 2 · medium 3 · high 2 · unknown 0
- execution_confidence: low 0 · medium 0 · high 7 · unknown 0

- Repeated low-confidence causes: tipster (5), market (3), race_type (2)
- Races where original was LOW but data quality was OK: 2
- Races where original was LOW with DIVERGENT / no-consensus tipsters: 7
- Races where original was LOW and data quality was degraded: 5

## 13:30 — Queen Anne Stakes (Group 1)

- Model pick: Docklands
- Original confidence (unchanged): low

- data_confidence: medium — DEGRADED data quality
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: high — non-handicap, 9 runners
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by market (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 14:05 — Coventry Stakes (Group 2)

- Model pick: Confucius
- Original confidence (unchanged): low

- data_confidence: medium — DEGRADED data quality
- market_confidence: medium — prices available; limited or unknown model-vs-market separation
- tipster_confidence: low — tipsters DIVERGENT from the model pick
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: medium — large field (22 runners)
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by tipster (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 14:40 — King Charles III Stakes (Group 1)

- Model pick: Night Raider
- Original confidence (unchanged): low

- data_confidence: medium — DEGRADED data quality
- market_confidence: medium — prices available; limited or unknown model-vs-market separation
- tipster_confidence: low — tipsters DIVERGENT from the model pick
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: medium — large field (26 runners)
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by tipster (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 15:20 — St James's Palace Stakes (Group 1) (Colts)

- Model pick: Talk Of New York
- Original confidence (unchanged): low

- data_confidence: high — run quality OK, no material flags
- market_confidence: medium — prices available; limited or unknown model-vs-market separation
- tipster_confidence: low — tipsters DIVERGENT from the model pick
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: high — non-handicap, 6 runners
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by tipster (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 16:00 — Ascot Stakes (Heritage Handicap) (GBBPlus Race)

- Model pick: Puturhandstogether
- Original confidence (unchanged): low

- data_confidence: medium — DEGRADED data quality
- market_confidence: medium — prices available; limited or unknown model-vs-market separation
- tipster_confidence: low — tipsters DIVERGENT from the model pick
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: low — large-field handicap (20 runners)
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by tipster, race_type (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 16:35 — Wolferton Stakes (Listed Race)

- Model pick: Haatem
- Original confidence (unchanged): low

- data_confidence: medium — DEGRADED data quality
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: medium — large field (16 runners)
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by market (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 17:10 — Copper Horse Stakes (Handicap) (GBBPlus Race)

- Model pick: Sing Us A Song
- Original confidence (unchanged): low

- data_confidence: high — run quality OK, no material flags
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: low — tipsters DIVERGENT from the model pick
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: low — large-field handicap (16 runners)
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by market, tipster, race_type (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
