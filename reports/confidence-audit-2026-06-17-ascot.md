# Confidence decomposition audit — 2026-06-17

Course: Ascot  
Generated: 2026-06-17T20:08:27.187Z  
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
- market_confidence: low 6 · medium 1 · high 0 · unknown 0
- tipster_confidence: low 0 · medium 0 · high 0 · unknown 7
- contextual_confidence: low 0 · medium 0 · high 0 · unknown 7
- race_type_confidence: low 2 · medium 2 · high 3 · unknown 0
- execution_confidence: low 0 · medium 0 · high 7 · unknown 0

- Repeated low-confidence causes: market (6), race_type (2)
- Races where original was LOW but data quality was OK: 2
- Races where original was LOW with DIVERGENT / no-consensus tipsters: 7
- Races where original was LOW and data quality was degraded: 5

## 13:30 — Queen Mary Stakes (Group 2) (Fillies)

- Model pick: Alta Regina
- Original confidence (unchanged): low

- data_confidence: medium — DEGRADED data quality
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: medium — large field (28 runners)
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by market (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 14:05 — Queen's Vase (Group 2)

- Model pick: Limestone
- Original confidence (unchanged): low

- data_confidence: high — run quality OK, no material flags
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: high — non-handicap, 11 runners
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by market (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 14:40 — Duke Of Cambridge Stakes (Group 2) (Fillies & Mares)

- Model pick: Blue Bolt
- Original confidence (unchanged): low

- data_confidence: high — run quality OK, no material flags
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: high — non-handicap, 15 runners
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by market (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 15:20 — Prince Of Wales's Stakes (Group 1)

- Model pick: Almaqam
- Original confidence (unchanged): low

- data_confidence: medium — DEGRADED data quality
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: high — non-handicap, 8 runners
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by market (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 16:00 — Royal Hunt Cup (Heritage Handicap)

- Model pick: Archivist
- Original confidence (unchanged): low

- data_confidence: medium — DEGRADED data quality
- market_confidence: medium — prices available; limited or unknown model-vs-market separation
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: low — large-field handicap (30 runners)
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by race_type (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 16:35 — Kensington Palace Stakes (Fillies' Handicap)

- Model pick: Radiant Beauty
- Original confidence (unchanged): low

- data_confidence: medium — DEGRADED data quality
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: low — large-field handicap (25 runners)
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by market, race_type (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 17:10 — Windsor Castle Stakes (Listed Race)

- Model pick: Sale Shark
- Original confidence (unchanged): low

- data_confidence: medium — DEGRADED data quality
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: medium — large field (25 runners)
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by market (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
