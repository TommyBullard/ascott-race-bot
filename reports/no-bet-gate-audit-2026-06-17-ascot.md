# No-bet gate research audit — 2026-06-17

Course: Ascot  
Generated: 2026-06-17T20:08:30.301Z  
Races: 7  
Betting races: 7

> RESEARCH ONLY. This SIMULATES candidate skip rules against historical
> pre-off recommendations; it does NOT change live recommendations, does NOT
> activate any gate, and suppresses no real model output. **One day / seven
> races is far too small to approve any gate.** No gate may be promoted
> without much larger OUT-OF-SAMPLE testing. No improved-accuracy claim is
> made and this is not betting advice.

## Candidate gate simulations

### LOW confidence only

- Rule: Skip when the original confidence label is LOW.
- Races skipped: 7 · races kept: 0
- Winners skipped: 2 · losers skipped: 5
- Winners kept: 0 · losers kept: 0
- Total staked: 7.43 -> 0.00
- P/L: +1.17pt -> 0.00pt (delta −1.17pt)
- ROI: +15.7% -> 0.0%
- On THIS sample only: worsened — ⚠️ sample far too small to approve (research signal only)

### LOW + DIVERGENT tipsters

- Rule: Skip when LOW confidence and tipsters are DIVERGENT.
- Races skipped: 0 · races kept: 7
- Winners skipped: 0 · losers skipped: 0
- Winners kept: 2 · losers kept: 5
- Total staked: 7.43 -> 7.43
- P/L: +1.17pt -> +1.17pt (delta 0.00pt)
- ROI: +15.7% -> +15.7%
- On THIS sample only: neutral — ⚠️ sample far too small to approve (research signal only)

### LOW + NO_TIPSTER_CONSENSUS

- Rule: Skip when LOW confidence and there is no tipster consensus.
- Races skipped: 7 · races kept: 0
- Winners skipped: 2 · losers skipped: 5
- Winners kept: 0 · losers kept: 0
- Total staked: 7.43 -> 0.00
- P/L: +1.17pt -> 0.00pt (delta −1.17pt)
- ROI: +15.7% -> 0.0%
- On THIS sample only: worsened — ⚠️ sample far too small to approve (research signal only)

### LOW + DEGRADED data quality

- Rule: Skip when LOW confidence and data quality is DEGRADED.
- Races skipped: 5 · races kept: 2
- Winners skipped: 0 · losers skipped: 5
- Winners kept: 2 · losers kept: 0
- Total staked: 7.43 -> 2.00
- P/L: +1.17pt -> +6.60pt (delta +5.43pt)
- ROI: +15.7% -> +330.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### DEGRADED + DIVERGENT

- Rule: Skip when data quality is DEGRADED and tipsters are DIVERGENT.
- Races skipped: 0 · races kept: 7
- Winners skipped: 0 · losers skipped: 0
- Winners kept: 2 · losers kept: 5
- Total staked: 7.43 -> 7.43
- P/L: +1.17pt -> +1.17pt (delta 0.00pt)
- ROI: +15.7% -> +15.7%
- On THIS sample only: neutral — ⚠️ sample far too small to approve (research signal only)

### LOW + DIVERGENT/NO_TIPSTER_CONSENSUS

- Rule: Skip when LOW confidence and tipsters are DIVERGENT or have no consensus.
- Races skipped: 7 · races kept: 0
- Winners skipped: 2 · losers skipped: 5
- Winners kept: 0 · losers kept: 0
- Total staked: 7.43 -> 0.00
- P/L: +1.17pt -> 0.00pt (delta −1.17pt)
- ROI: +15.7% -> 0.0%
- On THIS sample only: worsened — ⚠️ sample far too small to approve (research signal only)

### LOW + large field

- Rule: Skip when LOW confidence and the field is large (>= 16 runners).
- Races skipped: 4 · races kept: 3
- Winners skipped: 0 · losers skipped: 4
- Winners kept: 2 · losers kept: 1
- Total staked: 7.43 -> 3.00
- P/L: +1.17pt -> +5.60pt (delta +4.43pt)
- ROI: +15.7% -> +186.7%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### LOW + similar-EV cluster

- Rule: Skip when LOW confidence and many runners share a near-identical EV.
- Races skipped: 6 · races kept: 1
- Winners skipped: 2 · losers skipped: 4
- Winners kept: 0 · losers kept: 1
- Total staked: 7.43 -> 1.43
- P/L: +1.17pt -> −1.43pt (delta −2.60pt)
- ROI: +15.7% -> −100.0%
- On THIS sample only: worsened — ⚠️ sample far too small to approve (research signal only)

### LOW + low race-type confidence

- Rule: Skip when LOW confidence and the diagnostic race-type confidence is low.
- Races skipped: 2 · races kept: 5
- Winners skipped: 0 · losers skipped: 2
- Winners kept: 2 · losers kept: 3
- Total staked: 7.43 -> 5.00
- P/L: +1.17pt -> +3.60pt (delta +2.43pt)
- ROI: +15.7% -> +72.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### Strict caution

- Rule: Skip when LOW confidence AND (DIVERGENT OR NO_TIPSTER_CONSENSUS OR DEGRADED).
- Races skipped: 7 · races kept: 0
- Winners skipped: 2 · losers skipped: 5
- Winners kept: 0 · losers kept: 0
- Total staked: 7.43 -> 0.00
- P/L: +1.17pt -> 0.00pt (delta −1.17pt)
- ROI: +15.7% -> 0.0%
- On THIS sample only: worsened — ⚠️ sample far too small to approve (research signal only)

## Per-race detail

| Off | Race | Pick | Winner | Outcome | Stake | P/L | Confidence | Data quality | Tipster | Field | Gates that would skip |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 13:30 | Queen Mary Stakes (Group 2) (Fillies) | Alta Regina | Victorious | Lost | 1.00 | −1.00pt | low | DEGRADED | NO_TIPSTER_CONSENSUS | 28 | low_only, low_no_consensus, low_degraded, low_divergent_or_no_consensus, low_large_field, low_similar_ev, strict_caution |
| 14:05 | Queen's Vase (Group 2) | Limestone | Limestone | Won | 1.00 | +3.60pt | low | OK | NO_TIPSTER_CONSENSUS | 11 | low_only, low_no_consensus, low_divergent_or_no_consensus, low_similar_ev, strict_caution |
| 14:40 | Duke Of Cambridge Stakes (Group 2) (Fillies & Mares) | Blue Bolt | Blue Bolt | Won | 1.00 | +3.00pt | low | OK | NO_TIPSTER_CONSENSUS | 15 | low_only, low_no_consensus, low_divergent_or_no_consensus, low_similar_ev, strict_caution |
| 15:20 | Prince Of Wales's Stakes (Group 1) | Almaqam | Ombudsman | Lost | 1.00 | −1.00pt | low | DEGRADED | NO_TIPSTER_CONSENSUS | 8 | low_only, low_no_consensus, low_degraded, low_divergent_or_no_consensus, low_similar_ev, strict_caution |
| 16:00 | Royal Hunt Cup (Heritage Handicap) | Archivist | Rogue Diplomat | Lost | 1.43 | −1.43pt | low | DEGRADED | NO_TIPSTER_CONSENSUS | 30 | low_only, low_no_consensus, low_degraded, low_divergent_or_no_consensus, low_large_field, low_race_type_low, strict_caution |
| 16:35 | Kensington Palace Stakes (Fillies' Handicap) | Radiant Beauty | Alobayyah | Lost | 1.00 | −1.00pt | low | DEGRADED | NO_TIPSTER_CONSENSUS | 25 | low_only, low_no_consensus, low_degraded, low_divergent_or_no_consensus, low_large_field, low_similar_ev, low_race_type_low, strict_caution |
| 17:10 | Windsor Castle Stakes (Listed Race) | Sale Shark | King Of Cloughan | Lost | 1.00 | −1.00pt | low | DEGRADED | NO_TIPSTER_CONSENSUS | 25 | low_only, low_no_consensus, low_degraded, low_divergent_or_no_consensus, low_large_field, low_similar_ev, strict_caution |

## Interpretation

- Settled betting races in scope: 7 (need >= 100 settled bets before a gate could even be considered).
- Any "improved" verdict above reflects THIS tiny sample only and is not evidence of edge.
- No gate is active in production, and none should be promoted without large, out-of-sample, leakage-free backtesting.
- This is decision-support / research only — not betting advice, and no claim of improved future accuracy is made.
