# Confidence decomposition audit — 2026-06-18

Course: Ascot  
Generated: 2026-06-19T04:16:20.756Z  
Races: 7

> Diagnostic / display-only. This decomposes WHY each run is Low/Medium/High
> confidence from stored metadata. It does NOT change the model probability,
> staking, ranking, recommendation, or the persisted confidence, and it never
> rescales a LOW confidence upward. Unknown components are shown honestly.
> Decision-support only — not betting advice.

## Summary

- Original confidence labels: low 6 · medium 0 · high 0 · unknown 1

Component breakdown:
- data_confidence: low 0 · medium 1 · high 6 · unknown 0
- market_confidence: low 6 · medium 1 · high 0 · unknown 0
- tipster_confidence: low 0 · medium 0 · high 0 · unknown 7
- contextual_confidence: low 0 · medium 0 · high 0 · unknown 7
- race_type_confidence: low 3 · medium 0 · high 4 · unknown 0
- execution_confidence: low 1 · medium 0 · high 6 · unknown 0

- Repeated low-confidence causes: market (6), race_type (3), execution (1)
- Races where original was LOW but data quality was OK: 5
- Races where original was LOW with DIVERGENT / no-consensus tipsters: 6
- Races where original was LOW and data quality was degraded: 1

## 13:30 — Chesham Stakes (Listed Race)

- Model pick: Nola Soul
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

## 14:05 — King George V Stakes (Heritage Handicap) (GBBPlus Race)

- Model pick: Cannes
- Original confidence (unchanged): low

- data_confidence: high — run quality OK, no material flags
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: low — large-field handicap (19 runners)
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by market, race_type (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 14:40 — Ribblesdale Stakes (Group 2) (Fillies)

- Model pick: Composing
- Original confidence (unchanged): low

- data_confidence: high — run quality OK, no material flags
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: high — non-handicap, 12 runners
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by market (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 15:15 — Gold Cup (Group 1)

- Model pick: —
- Original confidence (unchanged): —

- data_confidence: high — run quality OK, no material flags
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: high — non-handicap, 11 runners
- execution_confidence: low — no pre-off odds recorded for the pick
- overall diagnostic: low — weakest-link diagnostic, limited by market, execution (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 15:50 — Britannia Stakes (Heritage Handicap) (Colts & Geldings)

- Model pick: Organise
- Original confidence (unchanged): low

- data_confidence: medium — DEGRADED data quality
- market_confidence: medium — prices available; limited or unknown model-vs-market separation
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: low — large-field handicap (31 runners)
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by race_type (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 16:35 — Hampton Court Stakes (Group 3)

- Model pick: Morshdi
- Original confidence (unchanged): low

- data_confidence: high — run quality OK, no material flags
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: high — non-handicap, 10 runners
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by market (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)

## 17:10 — Buckingham Palace Stakes (Handicap)

- Model pick: Blue Brother
- Original confidence (unchanged): low

- data_confidence: high — run quality OK, no material flags
- market_confidence: low — many runners share a near-identical EV (little model-vs-market separation)
- tipster_confidence: unknown — no tipster consensus (market-only signal, not a negative)
- contextual_confidence: unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
- race_type_confidence: low — large-field handicap (29 runners)
- execution_confidence: high — pre-off odds present and fresh (display only; not a live executable price)
- overall diagnostic: low — weakest-link diagnostic, limited by market, race_type (display-only; does not change the model's confidence, ranking, or stake)

### Warnings
- ⚠️ tipster_confidence is unknown — no tipster consensus (market-only signal, not a negative)
- ⚠️ contextual_confidence is unknown — no reviewed contextual/GenAI features (shadow layer is not model-active)
