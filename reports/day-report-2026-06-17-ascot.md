# End-of-day race report — 2026-06-17

Course: Ascot  
Generated: 2026-06-17T18:01:45.184Z  
Evaluation mode: pre_off  
Races: 7

> Source of truth: stored database data only — the latest `model_runs` row
> with `run_time <= off_time` (the final pre-off run), official results from
> `runners.finish_pos`, and the stored recommendations / observability.
> Post-off runs are ignored and no manual notes are used. This report does
> not call the model, fetch live odds, import results, or write to the
> database. Decision-support only — not betting advice.

## Summary

- Total races: 7
- Settled races: 7
- Pending races: 0
- Recommendations total: 7
- Winners: 2
- Losers: 5
- Strike rate: +28.6%
- Total staked: 7.43
- Profit/Loss: +1.17pt
- ROI: +15.7%
- Average EV: +5.8%
- No-bet races: 0
- Evaluation mode: pre_off

## Pattern analysis

- Low confidence picks: 7
- DEGRADED data-quality races: 5
- OK data-quality races: 2
- DIVERGENT tipster races: 0
- NO_TIPSTER_CONSENSUS races: 7
- Model picks against the market favourite: 4
- Races where the market favourite won: 3
- Races where the model pick placed but did not win: 0
- Races where a model alternative won: 2
- Races where a model alternative placed: 2
- LOW confidence + DIVERGENT: 0
- LOW confidence + DEGRADED: 5
- LOW confidence + NO_TIPSTER_CONSENSUS: 7
- DEGRADED + DIVERGENT: 0

## Interpretation

- Using pre-off evaluation (the latest model run with `run_time <= off_time`), the model's settled record was 2/7 (+28.6% strike) across 7 race(s), for +1.17pt at the stored stakes and odds (ROI +15.7%).
- The selections found some contenders in the stored results: a model alternative won in 2 race(s) and placed (top 3) in 2 race(s); the rank-1 pick placed without winning in 0 race(s).
- Repeated LOW confidence alongside tipster divergence or degraded data are candidates for FUTURE no-bet gate research (LOW+DIVERGENT: 0, LOW+DEGRADED: 5, LOW+NO_TIPSTER_CONSENSUS: 7, DEGRADED+DIVERGENT: 0). Any such gate would require backtesting before activation.
- This is a factual end-of-day summary for research and audit only. It is not betting advice and makes no claim or prediction about future performance.

## Races

### 13:30 — Queen Mary Stakes (Group 2) (Fillies)

- Course: Ascot
- Off time (UTC): 2026-06-17T13:30:00+00:00
- Selected pre-off run: 48f6e1b9-5bbb-4333-bd19-53389f19e3a9
- Run time: 2026-06-17T13:22:30.886+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Victorious
- Model pick result: Lost

#### Model pick
- Pick: Alta Regina
- Finish position: 6
- Odds: 5.70
- EV: +5.8%
- Stake: 1.00
- P/L: −1.00pt
- Confidence: low

#### Market favourite
- Alta Regina — odds 5.70 · EV +5.8% · finish 6

#### Alternatives
- More Champagne — odds 11.50 · EV +5.8% · finish 19
- Senorita Bonita — odds 11.50 · EV +5.8% · finish 2

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS, NO_TIPSTER_SELECTIONS
- Data quality summary: DEGRADED — Missing runner odds (26/28 priced), No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 14:05 — Queen's Vase (Group 2)

- Course: Ascot
- Off time (UTC): 2026-06-17T14:05:00+00:00
- Selected pre-off run: cf9bac90-f694-4398-bcc6-34fba9c435cc
- Run time: 2026-06-17T14:00:15.576+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Limestone
- Model pick result: Won

#### Model pick
- Pick: Limestone
- Finish position: 1
- Odds: 4.60
- EV: +1.2%
- Stake: 1.00
- P/L: +3.60pt
- Confidence: low

#### Market favourite
- Galiyan — odds 3.50 · EV +1.2% · finish 6

#### Alternatives
- Point Of Law — odds 10.00 · EV +1.2% · finish 4
- Port Of Spain — odds 10.00 · EV +1.2% · finish 11

#### Model explanation
- Data quality: OK
- Data quality flags: NO_TIPSTER_SELECTIONS
- Data quality summary: OK — No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 14:40 — Duke Of Cambridge Stakes (Group 2) (Fillies & Mares)

- Course: Ascot
- Off time (UTC): 2026-06-17T14:40:00+00:00
- Selected pre-off run: a2ba48b0-ae88-4593-813a-8cef1833d81a
- Run time: 2026-06-17T14:32:43.477+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Blue Bolt
- Model pick result: Won

#### Model pick
- Pick: Blue Bolt
- Finish position: 1
- Odds: 4.00
- EV: +3.6%
- Stake: 1.00
- P/L: +3.00pt
- Confidence: low

#### Market favourite
- Blue Bolt — odds 4.00 · EV +3.6% · finish 1

#### Alternatives
- Catalina Delcarpio — odds 8.40 · EV +3.6% · finish 13
- Cathedral — odds 8.40 · EV +3.6% · finish 7

#### Model explanation
- Data quality: OK
- Data quality flags: NO_TIPSTER_SELECTIONS
- Data quality summary: OK — No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 15:20 — Prince Of Wales's Stakes (Group 1)

- Course: Ascot
- Off time (UTC): 2026-06-17T15:20:00+00:00
- Selected pre-off run: b3fe2642-27ab-4a47-ae27-d244bbcc0144
- Run time: 2026-06-17T15:14:38.654+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Ombudsman
- Model pick result: Lost

#### Model pick
- Pick: Almaqam
- Finish position: 4
- Odds: 9.80
- EV: +1.1%
- Stake: 1.00
- P/L: −1.00pt
- Confidence: low

#### Market favourite
- Ombudsman — odds 2.26 · EV +1.1% · finish 1

#### Alternatives
- Daryz — odds 3.40 · EV +1.1% · finish 3
- Ombudsman — odds 2.26 · EV +1.1% · finish 1

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS, NO_TIPSTER_SELECTIONS
- Data quality summary: DEGRADED — Missing runner odds (7/8 priced), No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 16:00 — Royal Hunt Cup (Heritage Handicap)

- Course: Ascot
- Off time (UTC): 2026-06-17T16:00:00+00:00
- Selected pre-off run: 0e5d0187-5c55-42a6-9f89-c997fad45c9b
- Run time: 2026-06-17T15:54:11.44+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Rogue Diplomat
- Model pick result: Lost

#### Model pick
- Pick: Archivist
- Finish position: 20
- Odds: 7.60
- EV: +14.3%
- Stake: 1.43
- P/L: −1.43pt
- Confidence: low

#### Market favourite
- Archivist — odds 7.60 · EV +14.3% · finish 20

#### Alternatives
- Jagged Edge — odds 10.50 · EV +14.3% · finish 12
- Swing Vote — odds 210.00 · EV −2.9% · finish 14

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS, NO_TIPSTER_SELECTIONS
- Data quality summary: DEGRADED — Missing runner odds (27/30 priced), No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 16:35 — Kensington Palace Stakes (Fillies' Handicap)

- Course: Ascot
- Off time (UTC): 2026-06-17T16:35:00+00:00
- Selected pre-off run: 2cb3b6d7-8613-4e37-af4e-436afca54d4e
- Run time: 2026-06-17T16:31:30.643+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Alobayyah
- Model pick result: Lost

#### Model pick
- Pick: Radiant Beauty
- Finish position: 13
- Odds: 9.20
- EV: +7.5%
- Stake: 1.00
- P/L: −1.00pt
- Confidence: low

#### Market favourite
- Alobayyah — odds 4.60 · EV +7.5% · finish 1

#### Alternatives
- Alobayyah — odds 4.60 · EV +7.5% · finish 1
- Stateira — odds 11.00 · EV +7.5% · finish 21

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS, NO_TIPSTER_SELECTIONS
- Data quality summary: DEGRADED — Missing runner odds (24/25 priced), No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 17:10 — Windsor Castle Stakes (Listed Race)

- Course: Ascot
- Off time (UTC): 2026-06-17T17:10:00+00:00
- Selected pre-off run: fb075674-5547-4785-a468-f8d0b89f2f48
- Run time: 2026-06-17T17:03:53.894+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: King Of Cloughan
- Model pick result: Lost

#### Model pick
- Pick: Sale Shark
- Finish position: 5
- Odds: 8.20
- EV: +7.4%
- Stake: 1.00
- P/L: −1.00pt
- Confidence: low

#### Market favourite
- Controlla — odds 4.50 · EV +7.4% · finish 14

#### Alternatives
- One Number — odds 10.00 · EV +7.4% · finish 18
- Sergei Diaghilev — odds 5.00 · EV +7.4% · finish 9

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS, NO_TIPSTER_SELECTIONS
- Data quality summary: DEGRADED — Missing runner odds (23/25 priced), No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS
