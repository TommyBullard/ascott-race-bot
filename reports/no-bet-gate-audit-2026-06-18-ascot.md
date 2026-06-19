# No-bet gate research audit — 2026-06-18

Course: Ascot  
Generated: 2026-06-19T04:16:23.736Z  
Races: 7  
Betting races: 6

> RESEARCH ONLY. This SIMULATES candidate skip rules against historical
> pre-off recommendations; it does NOT change live recommendations, does NOT
> activate any gate, and suppresses no real model output. **One day / seven
> races is far too small to approve any gate.** No gate may be promoted
> without much larger OUT-OF-SAMPLE testing. No improved-accuracy claim is
> made and this is not betting advice.

## Candidate gate simulations

### LOW confidence only

- Rule: Skip when the original confidence label is LOW.
- Races skipped: 6 · races kept: 0
- Winners skipped: 1 · losers skipped: 5
- Winners kept: 0 · losers kept: 0
- Total staked: 7.31 -> 0.00
- P/L: −0.71pt -> 0.00pt (delta +0.71pt)
- ROI: −9.7% -> 0.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### LOW + DIVERGENT tipsters

- Rule: Skip when LOW confidence and tipsters are DIVERGENT.
- Races skipped: 0 · races kept: 6
- Winners skipped: 0 · losers skipped: 0
- Winners kept: 1 · losers kept: 5
- Total staked: 7.31 -> 7.31
- P/L: −0.71pt -> −0.71pt (delta 0.00pt)
- ROI: −9.7% -> −9.7%
- On THIS sample only: neutral — ⚠️ sample far too small to approve (research signal only)

### LOW + NO_TIPSTER_CONSENSUS

- Rule: Skip when LOW confidence and there is no tipster consensus.
- Races skipped: 6 · races kept: 0
- Winners skipped: 1 · losers skipped: 5
- Winners kept: 0 · losers kept: 0
- Total staked: 7.31 -> 0.00
- P/L: −0.71pt -> 0.00pt (delta +0.71pt)
- ROI: −9.7% -> 0.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### LOW + DEGRADED data quality

- Rule: Skip when LOW confidence and data quality is DEGRADED.
- Races skipped: 1 · races kept: 5
- Winners skipped: 0 · losers skipped: 1
- Winners kept: 1 · losers kept: 4
- Total staked: 7.31 -> 5.00
- P/L: −0.71pt -> +1.60pt (delta +2.31pt)
- ROI: −9.7% -> +32.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### DEGRADED + DIVERGENT

- Rule: Skip when data quality is DEGRADED and tipsters are DIVERGENT.
- Races skipped: 0 · races kept: 6
- Winners skipped: 0 · losers skipped: 0
- Winners kept: 1 · losers kept: 5
- Total staked: 7.31 -> 7.31
- P/L: −0.71pt -> −0.71pt (delta 0.00pt)
- ROI: −9.7% -> −9.7%
- On THIS sample only: neutral — ⚠️ sample far too small to approve (research signal only)

### LOW + DIVERGENT/NO_TIPSTER_CONSENSUS

- Rule: Skip when LOW confidence and tipsters are DIVERGENT or have no consensus.
- Races skipped: 6 · races kept: 0
- Winners skipped: 1 · losers skipped: 5
- Winners kept: 0 · losers kept: 0
- Total staked: 7.31 -> 0.00
- P/L: −0.71pt -> 0.00pt (delta +0.71pt)
- ROI: −9.7% -> 0.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### LOW + large field

- Rule: Skip when LOW confidence and the field is large (>= 16 runners).
- Races skipped: 3 · races kept: 3
- Winners skipped: 0 · losers skipped: 3
- Winners kept: 1 · losers kept: 2
- Total staked: 7.31 -> 3.00
- P/L: −0.71pt -> +3.60pt (delta +4.31pt)
- ROI: −9.7% -> +120.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### LOW + similar-EV cluster

- Rule: Skip when LOW confidence and many runners share a near-identical EV.
- Races skipped: 5 · races kept: 1
- Winners skipped: 1 · losers skipped: 4
- Winners kept: 0 · losers kept: 1
- Total staked: 7.31 -> 2.31
- P/L: −0.71pt -> −2.31pt (delta −1.60pt)
- ROI: −9.7% -> −100.0%
- On THIS sample only: worsened — ⚠️ sample far too small to approve (research signal only)

### LOW + low race-type confidence

- Rule: Skip when LOW confidence and the diagnostic race-type confidence is low.
- Races skipped: 3 · races kept: 3
- Winners skipped: 0 · losers skipped: 3
- Winners kept: 1 · losers kept: 2
- Total staked: 7.31 -> 3.00
- P/L: −0.71pt -> +3.60pt (delta +4.31pt)
- ROI: −9.7% -> +120.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### Strict caution

- Rule: Skip when LOW confidence AND (DIVERGENT OR NO_TIPSTER_CONSENSUS OR DEGRADED).
- Races skipped: 6 · races kept: 0
- Winners skipped: 1 · losers skipped: 5
- Winners kept: 0 · losers kept: 0
- Total staked: 7.31 -> 0.00
- P/L: −0.71pt -> 0.00pt (delta +0.71pt)
- ROI: −9.7% -> 0.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

## Per-race detail

| Off | Race | Pick | Winner | Outcome | Stake | P/L | Confidence | Data quality | Tipster | Field | Gates that would skip |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 13:30 | Chesham Stakes (Listed Race) | Nola Soul | Nola Soul | Won | 1.00 | +5.60pt | low | OK | NO_TIPSTER_CONSENSUS | 15 | low_only, low_no_consensus, low_divergent_or_no_consensus, low_similar_ev, strict_caution |
| 14:05 | King George V Stakes (Heritage Handicap) (GBBPlus Race) | Cannes | Enceladus | Lost | 1.00 | −1.00pt | low | OK | NO_TIPSTER_CONSENSUS | 19 | low_only, low_no_consensus, low_divergent_or_no_consensus, low_large_field, low_similar_ev, low_race_type_low, strict_caution |
| 14:40 | Ribblesdale Stakes (Group 2) (Fillies) | Composing | Earth Shot | Lost | 1.00 | −1.00pt | low | OK | NO_TIPSTER_CONSENSUS | 12 | low_only, low_no_consensus, low_divergent_or_no_consensus, low_similar_ev, strict_caution |
| 15:15 | Gold Cup (Group 1) | — | Scandinavia | No bet | — | — | — | OK | NO_TIPSTER_CONSENSUS | 11 | — |
| 15:50 | Britannia Stakes (Heritage Handicap) (Colts & Geldings) | Organise | Moonfall | Lost | 2.31 | −2.31pt | low | DEGRADED | NO_TIPSTER_CONSENSUS | 31 | low_only, low_no_consensus, low_degraded, low_divergent_or_no_consensus, low_large_field, low_race_type_low, strict_caution |
| 16:35 | Hampton Court Stakes (Group 3) | Morshdi | Generic | Lost | 1.00 | −1.00pt | low | OK | NO_TIPSTER_CONSENSUS | 10 | low_only, low_no_consensus, low_divergent_or_no_consensus, low_similar_ev, strict_caution |
| 17:10 | Buckingham Palace Stakes (Handicap) | Blue Brother | Mezcala | Lost | 1.00 | −1.00pt | low | OK | NO_TIPSTER_CONSENSUS | 29 | low_only, low_no_consensus, low_divergent_or_no_consensus, low_large_field, low_similar_ev, low_race_type_low, strict_caution |

## Interpretation

- Settled betting races in scope: 6 (need >= 100 settled bets before a gate could even be considered).
- Any "improved" verdict above reflects THIS tiny sample only and is not evidence of edge.
- No gate is active in production, and none should be promoted without large, out-of-sample, leakage-free backtesting.
- This is decision-support / research only — not betting advice, and no claim of improved future accuracy is made.
