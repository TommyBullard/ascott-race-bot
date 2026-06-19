# End-of-day race report — 2026-06-18

Course: Ascot  
Generated: 2026-06-19T04:16:11.664Z  
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
- Settled races: 6
- Pending races: 0
- Recommendations total: 6
- Winners: 1
- Losers: 5
- Strike rate: +16.7%
- Total staked: 7.31
- Profit/Loss: −0.71pt
- ROI: −9.7%
- Average EV: +7.5%
- No-bet races: 1
- Evaluation mode: pre_off

## Pattern analysis

- Low confidence picks: 6
- DEGRADED data-quality races: 1
- OK data-quality races: 6
- DIVERGENT tipster races: 0
- NO_TIPSTER_CONSENSUS races: 7
- Model picks against the market favourite: 4
- Races where the market favourite won: 2
- Races where the model pick placed but did not win: 0
- Races where a model alternative won: 3
- Races where a model alternative placed: 4
- LOW confidence + DIVERGENT: 0
- LOW confidence + DEGRADED: 1
- LOW confidence + NO_TIPSTER_CONSENSUS: 6
- DEGRADED + DIVERGENT: 0

## Interpretation

- Using pre-off evaluation (the latest model run with `run_time <= off_time`), the model's settled record was 1/6 (+16.7% strike) across 7 race(s), for −0.71pt at the stored stakes and odds (ROI −9.7%).
- The selections found some contenders in the stored results: a model alternative won in 3 race(s) and placed (top 3) in 4 race(s); the rank-1 pick placed without winning in 0 race(s).
- Repeated LOW confidence alongside tipster divergence or degraded data are candidates for FUTURE no-bet gate research (LOW+DIVERGENT: 0, LOW+DEGRADED: 1, LOW+NO_TIPSTER_CONSENSUS: 6, DEGRADED+DIVERGENT: 0). Any such gate would require backtesting before activation.
- This is a factual end-of-day summary for research and audit only. It is not betting advice and makes no claim or prediction about future performance.

## Races

### 13:30 — Chesham Stakes (Listed Race)

- Course: Ascot
- Off time (UTC): 2026-06-18T13:30:00+00:00
- Selected pre-off run: 43051ff4-5f6d-4ba9-b8ea-fd18d17c42e6
- Run time: 2026-06-18T13:17:10.194+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Nola Soul
- Model pick result: Won

#### Model pick
- Pick: Nola Soul
- Finish position: 1
- Odds: 6.60
- EV: +3.6%
- Stake: 1.00
- P/L: +5.60pt
- Confidence: low

#### Market favourite
- Aix La Chapelle — odds 3.35 · EV +3.6% · finish —

#### Alternatives
- Sea Venture — odds 10.00 · EV +3.6% · finish —
- Aix La Chapelle — odds 3.35 · EV +3.6% · finish —

#### Model explanation
- Data quality: OK
- Data quality flags: NO_TIPSTER_SELECTIONS
- Data quality summary: OK — No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 14:05 — King George V Stakes (Heritage Handicap) (GBBPlus Race)

- Course: Ascot
- Off time (UTC): 2026-06-18T14:05:00+00:00
- Selected pre-off run: 9671594f-e874-4631-8ba5-5ab839e7afbb
- Run time: 2026-06-18T14:00:58.325+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Enceladus
- Model pick result: Lost

#### Model pick
- Pick: Cannes
- Finish position: —
- Odds: 5.50
- EV: +4.5%
- Stake: 1.00
- P/L: −1.00pt
- Confidence: low

#### Market favourite
- Cannes — odds 5.50 · EV +4.5% · finish —

#### Alternatives
- Enceladus — odds 10.00 · EV +4.5% · finish 1
- Into The Light — odds 6.40 · EV +4.5% · finish —

#### Model explanation
- Data quality: OK
- Data quality flags: NO_TIPSTER_SELECTIONS
- Data quality summary: OK — No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 14:40 — Ribblesdale Stakes (Group 2) (Fillies)

- Course: Ascot
- Off time (UTC): 2026-06-18T14:40:00+00:00
- Selected pre-off run: c8204791-17aa-47e1-bc67-185899681bba
- Run time: 2026-06-18T14:35:11.226+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Earth Shot
- Model pick result: Lost

#### Model pick
- Pick: Composing
- Finish position: —
- Odds: 9.00
- EV: +1.0%
- Stake: 1.00
- P/L: −1.00pt
- Confidence: low

#### Market favourite
- Legacy Link — odds 2.96 · EV +1.0% · finish —

#### Alternatives
- Earth Shot — odds 5.00 · EV +1.0% · finish 1
- Gilded Prize — odds 5.90 · EV +1.0% · finish 3

#### Model explanation
- Data quality: OK
- Data quality flags: NO_TIPSTER_SELECTIONS
- Data quality summary: OK — No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 15:15 — Gold Cup (Group 1)

- Course: Ascot
- Off time (UTC): 2026-06-18T15:15:00+00:00
- Selected pre-off run: d3b2a395-34b9-4c6f-aca1-b2b9b179065a
- Run time: 2026-06-18T15:08:45.824+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Scandinavia
- Model pick result: No bet

#### Model pick
- No bet (the selected pre-off run made no rank-1 recommendation).

#### Market favourite
- Scandinavia — odds 3.45 · EV −1.4% · finish 1

#### Alternatives
- Caballo De Mar — odds 7.20 · EV −1.4% · finish —
- Sweet William — odds 12.00 · EV −1.4% · finish 3

#### Model explanation
- Data quality: OK
- Data quality flags: NO_TIPSTER_SELECTIONS
- Data quality summary: OK — No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 15:50 — Britannia Stakes (Heritage Handicap) (Colts & Geldings)

- Course: Ascot
- Off time (UTC): 2026-06-18T15:50:00+00:00
- Selected pre-off run: 44a1d387-bd31-4152-9ee8-a2a8a1232f78
- Run time: 2026-06-18T15:08:46.802+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Moonfall
- Model pick result: Lost

#### Model pick
- Pick: Organise
- Finish position: —
- Odds: 11.00
- EV: +25.9%
- Stake: 2.31
- P/L: −2.31pt
- Confidence: low

#### Market favourite
- Organise — odds 11.00 · EV +25.9% · finish —

#### Alternatives
- Jamestown — odds 11.00 · EV +25.9% · finish 3
- Victory Tip — odds 75.00 · EV +7.1% · finish —

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS, NO_TIPSTER_SELECTIONS
- Data quality summary: DEGRADED — Missing runner odds (28/31 priced), No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 16:35 — Hampton Court Stakes (Group 3)

- Course: Ascot
- Off time (UTC): 2026-06-18T16:35:00+00:00
- Selected pre-off run: ff5f7ae5-ebe6-43d0-acf7-57c6c8f4ae36
- Run time: 2026-06-18T15:08:47.852+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Generic
- Model pick result: Lost

#### Model pick
- Pick: Morshdi
- Finish position: —
- Odds: 6.40
- EV: +1.3%
- Stake: 1.00
- P/L: −1.00pt
- Confidence: low

#### Market favourite
- Endorsement — odds 2.92 · EV +1.3% · finish 2

#### Alternatives
- Oxagon — odds 9.20 · EV +1.3% · finish —
- Endorsement — odds 2.92 · EV +1.3% · finish 2

#### Model explanation
- Data quality: OK
- Data quality flags: NO_TIPSTER_SELECTIONS
- Data quality summary: OK — No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 17:10 — Buckingham Palace Stakes (Handicap)

- Course: Ascot
- Off time (UTC): 2026-06-18T17:10:00+00:00
- Selected pre-off run: 3287a3e3-e715-45f3-ac66-8dd6a2a17ed1
- Run time: 2026-06-18T15:08:49.248+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Mezcala
- Model pick result: Lost

#### Model pick
- Pick: Blue Brother
- Finish position: 4
- Odds: 10.00
- EV: +8.9%
- Stake: 1.00
- P/L: −1.00pt
- Confidence: low

#### Market favourite
- Mezcala — odds 8.60 · EV +8.9% · finish 1

#### Alternatives
- Cosi Bello — odds 11.50 · EV +8.9% · finish —
- Mezcala — odds 8.60 · EV +8.9% · finish 1

#### Model explanation
- Data quality: OK
- Data quality flags: NO_TIPSTER_SELECTIONS
- Data quality summary: OK — No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS
