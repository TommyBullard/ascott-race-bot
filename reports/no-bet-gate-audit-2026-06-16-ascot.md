# No-bet gate research audit — 2026-06-16

Course: Ascot  
Generated: 2026-06-17T12:44:10.195Z  
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
- Winners skipped: 0 · losers skipped: 7
- Winners kept: 0 · losers kept: 0
- Total staked: 20.48 -> 0.00
- P/L: −20.48pt -> 0.00pt (delta +20.48pt)
- ROI: −100.0% -> 0.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### LOW + DIVERGENT tipsters

- Rule: Skip when LOW confidence and tipsters are DIVERGENT.
- Races skipped: 5 · races kept: 2
- Winners skipped: 0 · losers skipped: 5
- Winners kept: 0 · losers kept: 2
- Total staked: 20.48 -> 2.22
- P/L: −20.48pt -> −2.22pt (delta +18.25pt)
- ROI: −100.0% -> −100.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### LOW + NO_TIPSTER_CONSENSUS

- Rule: Skip when LOW confidence and there is no tipster consensus.
- Races skipped: 2 · races kept: 5
- Winners skipped: 0 · losers skipped: 2
- Winners kept: 0 · losers kept: 5
- Total staked: 20.48 -> 18.25
- P/L: −20.48pt -> −18.25pt (delta +2.22pt)
- ROI: −100.0% -> −100.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### LOW + DEGRADED data quality

- Rule: Skip when LOW confidence and data quality is DEGRADED.
- Races skipped: 5 · races kept: 2
- Winners skipped: 0 · losers skipped: 5
- Winners kept: 0 · losers kept: 2
- Total staked: 20.48 -> 5.71
- P/L: −20.48pt -> −5.71pt (delta +14.77pt)
- ROI: −100.0% -> −100.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### DEGRADED + DIVERGENT

- Rule: Skip when data quality is DEGRADED and tipsters are DIVERGENT.
- Races skipped: 3 · races kept: 4
- Winners skipped: 0 · losers skipped: 3
- Winners kept: 0 · losers kept: 4
- Total staked: 20.48 -> 7.93
- P/L: −20.48pt -> −7.93pt (delta +12.54pt)
- ROI: −100.0% -> −100.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### LOW + DIVERGENT/NO_TIPSTER_CONSENSUS

- Rule: Skip when LOW confidence and tipsters are DIVERGENT or have no consensus.
- Races skipped: 7 · races kept: 0
- Winners skipped: 0 · losers skipped: 7
- Winners kept: 0 · losers kept: 0
- Total staked: 20.48 -> 0.00
- P/L: −20.48pt -> 0.00pt (delta +20.48pt)
- ROI: −100.0% -> 0.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### LOW + large field

- Rule: Skip when LOW confidence and the field is large (>= 16 runners).
- Races skipped: 5 · races kept: 2
- Winners skipped: 0 · losers skipped: 5
- Winners kept: 0 · losers kept: 2
- Total staked: 20.48 -> 5.71
- P/L: −20.48pt -> −5.71pt (delta +14.77pt)
- ROI: −100.0% -> −100.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### LOW + similar-EV cluster

- Rule: Skip when LOW confidence and many runners share a near-identical EV.
- Races skipped: 3 · races kept: 4
- Winners skipped: 0 · losers skipped: 3
- Winners kept: 0 · losers kept: 4
- Total staked: 20.48 -> 17.25
- P/L: −20.48pt -> −17.25pt (delta +3.22pt)
- ROI: −100.0% -> −100.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### LOW + low race-type confidence

- Rule: Skip when LOW confidence and the diagnostic race-type confidence is low.
- Races skipped: 2 · races kept: 5
- Winners skipped: 0 · losers skipped: 2
- Winners kept: 0 · losers kept: 5
- Total staked: 20.48 -> 18.00
- P/L: −20.48pt -> −18.00pt (delta +2.48pt)
- ROI: −100.0% -> −100.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

### Strict caution

- Rule: Skip when LOW confidence AND (DIVERGENT OR NO_TIPSTER_CONSENSUS OR DEGRADED).
- Races skipped: 7 · races kept: 0
- Winners skipped: 0 · losers skipped: 7
- Winners kept: 0 · losers kept: 0
- Total staked: 20.48 -> 0.00
- P/L: −20.48pt -> 0.00pt (delta +20.48pt)
- ROI: −100.0% -> 0.0%
- On THIS sample only: improved — ⚠️ sample far too small to approve (research signal only)

## Per-race detail

| Off | Race | Pick | Winner | Outcome | Stake | P/L | Confidence | Data quality | Tipster | Field | Gates that would skip |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 13:30 | Queen Anne Stakes (Group 1) | Docklands | Ten Bob Tony | Lost | 1.00 | −1.00pt | low | DEGRADED | NO_TIPSTER_CONSENSUS | 9 | low_only, low_no_consensus, low_degraded, low_divergent_or_no_consensus, low_similar_ev, strict_caution |
| 14:05 | Coventry Stakes (Group 2) | Confucius | Great Barrier Reef | Lost | 9.59 | −9.59pt | low | DEGRADED | DIVERGENT | 22 | low_only, low_divergent, low_degraded, degraded_divergent, low_divergent_or_no_consensus, low_large_field, strict_caution |
| 14:40 | King Charles III Stakes (Group 1) | Night Raider | Mission Central | Lost | 1.48 | −1.48pt | low | DEGRADED | DIVERGENT | 26 | low_only, low_divergent, low_degraded, degraded_divergent, low_divergent_or_no_consensus, low_large_field, strict_caution |
| 15:20 | St James's Palace Stakes (Group 1) (Colts) | Talk Of New York | Bow Echo | Lost | 4.71 | −4.71pt | low | OK | DIVERGENT | 6 | low_only, low_divergent, low_divergent_or_no_consensus, strict_caution |
| 16:00 | Ascot Stakes (Heritage Handicap) (GBBPlus Race) | Puturhandstogether | Kizlyar | Lost | 1.48 | −1.48pt | low | DEGRADED | DIVERGENT | 20 | low_only, low_divergent, low_degraded, degraded_divergent, low_divergent_or_no_consensus, low_large_field, low_race_type_low, strict_caution |
| 16:35 | Wolferton Stakes (Listed Race) | Haatem | Map Of Stars | Lost | 1.22 | −1.22pt | low | DEGRADED | NO_TIPSTER_CONSENSUS | 16 | low_only, low_no_consensus, low_degraded, low_divergent_or_no_consensus, low_large_field, low_similar_ev, strict_caution |
| 17:10 | Copper Horse Stakes (Handicap) (GBBPlus Race) | Sing Us A Song | Daiquiri Bay | Lost | 1.00 | −1.00pt | low | OK | DIVERGENT | 16 | low_only, low_divergent, low_divergent_or_no_consensus, low_large_field, low_similar_ev, low_race_type_low, strict_caution |

## Interpretation

- Settled betting races in scope: 7 (need >= 100 settled bets before a gate could even be considered).
- Any "improved" verdict above reflects THIS tiny sample only and is not evidence of edge.
- No gate is active in production, and none should be promoted without large, out-of-sample, leakage-free backtesting.
- This is decision-support / research only — not betting advice, and no claim of improved future accuracy is made.
