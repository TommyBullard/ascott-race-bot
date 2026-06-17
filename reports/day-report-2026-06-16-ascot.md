# End-of-day race report — 2026-06-16

Course: Ascot  
Generated: 2026-06-17T09:15:22.968Z  
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
- Winners: 0
- Losers: 7
- Strike rate: 0.0%
- Total staked: 20.48
- Profit/Loss: −20.48pt
- ROI: −100.0%
- Average EV: +14.9%
- No-bet races: 0
- Evaluation mode: pre_off

## Pattern analysis

- Low confidence picks: 7
- DEGRADED data-quality races: 5
- OK data-quality races: 2
- DIVERGENT tipster races: 5
- NO_TIPSTER_CONSENSUS races: 2
- Model picks against the market favourite: 5
- Races where the market favourite won: 1
- Races where the model pick placed but did not win: 1
- Races where a model alternative won: 1
- Races where a model alternative placed: 5
- LOW confidence + DIVERGENT: 5
- LOW confidence + DEGRADED: 5
- LOW confidence + NO_TIPSTER_CONSENSUS: 2
- DEGRADED + DIVERGENT: 3

## Interpretation

- Using pre-off evaluation (the latest model run with `run_time <= off_time`), the model's settled record was 0/7 (0.0% strike) across 7 race(s), for −20.48pt at the stored stakes and odds (ROI −100.0%).
- The selections found some contenders in the stored results: a model alternative won in 1 race(s) and placed (top 3) in 5 race(s); the rank-1 pick placed without winning in 1 race(s).
- Repeated LOW confidence alongside tipster divergence or degraded data are candidates for FUTURE no-bet gate research (LOW+DIVERGENT: 5, LOW+DEGRADED: 5, LOW+NO_TIPSTER_CONSENSUS: 2, DEGRADED+DIVERGENT: 3). Any such gate would require backtesting before activation.
- This is a factual end-of-day summary for research and audit only. It is not betting advice and makes no claim or prediction about future performance.

## Races

### 13:30 — Queen Anne Stakes (Group 1)

- Course: Ascot
- Off time (UTC): 2026-06-16T13:30:00+00:00
- Selected pre-off run: 313bf767-aa2c-4f7f-b0c3-3cede6e30b23
- Run time: 2026-06-16T13:24:06.238+00:00
- Selected run status: superseded
- Post-off runs ignored: 54
- Winner: Ten Bob Tony
- Model pick result: Lost

#### Model pick
- Pick: Docklands
- Finish position: 7
- Odds: 7.60
- EV: +1.9%
- Stake: 1.00
- P/L: −1.00pt
- Confidence: low

#### Market favourite
- Notable Speech — odds 3.50 · EV +1.9% · finish 6

#### Alternatives
- Opera Ballo — odds 4.60 · EV +1.9% · finish 3
- Zeus Olympios — odds 11.50 · EV +1.9% · finish 4

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS, NO_TIPSTER_SELECTIONS
- Data quality summary: DEGRADED — Missing runner odds (8/9 priced), No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

#### Warnings
- ⚠️ 54 post-off run(s) exist but were ignored (report uses run_time <= off_time).

### 14:05 — Coventry Stakes (Group 2)

- Course: Ascot
- Off time (UTC): 2026-06-16T14:05:00+00:00
- Selected pre-off run: c9a6f861-7bd0-4d4e-a3cd-8ab5c9d94a67
- Run time: 2026-06-16T14:02:17.279+00:00
- Selected run status: superseded
- Post-off runs ignored: 48
- Winner: Great Barrier Reef
- Model pick result: Lost

#### Model pick
- Pick: Confucius
- Finish position: 6
- Odds: 3.45
- EV: +24.3%
- Stake: 9.59
- P/L: −9.59pt
- Confidence: low

#### Market favourite
- Confucius — odds 3.45 · EV +24.3% · finish 6

#### Alternatives
- Night In Vegas — odds 11.50 · EV +24.3% · finish 5
- Bull Shark — odds 120.00 · EV +5.6% · finish 20

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS
- Data quality summary: DEGRADED — Missing runner odds (20/22 priced)
- Tipster consensus: Tipsters divergent from recommendation
- Tipster alignment: DIVERGENT

#### Warnings
- ⚠️ 48 post-off run(s) exist but were ignored (report uses run_time <= off_time).

### 14:40 — King Charles III Stakes (Group 1)

- Course: Ascot
- Off time (UTC): 2026-06-16T14:40:00+00:00
- Selected pre-off run: fec39952-bd7d-467f-82f5-61fc7d32e15d
- Run time: 2026-06-16T14:33:22.595+00:00
- Selected run status: superseded
- Post-off runs ignored: 46
- Winner: Mission Central
- Model pick result: Lost

#### Model pick
- Pick: Night Raider
- Finish position: 10
- Odds: 8.00
- EV: +14.8%
- Stake: 1.48
- P/L: −1.48pt
- Confidence: low

#### Market favourite
- Overpass — odds 4.30 · EV −13.9% · finish 3

#### Alternatives
- Rayevka — odds 11.50 · EV +14.8% · finish 2
- Cover Up — odds 32.00 · EV −2.4% · finish 13

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS
- Data quality summary: DEGRADED — Missing runner odds (25/26 priced)
- Tipster consensus: Tipsters divergent from recommendation
- Tipster alignment: DIVERGENT

#### Warnings
- ⚠️ 46 post-off run(s) exist but were ignored (report uses run_time <= off_time).

### 15:20 — St James's Palace Stakes (Group 1) (Colts)

- Course: Ascot
- Off time (UTC): 2026-06-16T15:20:00+00:00
- Selected pre-off run: ffbae3ba-d2eb-434b-b216-9613b19f4c7e
- Run time: 2026-06-16T15:13:46.537+00:00
- Selected run status: superseded
- Post-off runs ignored: 44
- Winner: Bow Echo
- Model pick result: Lost

#### Model pick
- Pick: Talk Of New York
- Finish position: 3
- Odds: 6.40
- EV: +25.7%
- Stake: 4.71
- P/L: −4.71pt
- Confidence: low

#### Market favourite
- Bow Echo — odds 1.97 · EV −24.6% · finish 1

#### Alternatives
- Gstaad — odds 3.65 · EV +25.7% · finish 2
- Power Blue — odds 75.00 · EV +6.8% · finish 4

#### Model explanation
- Data quality: OK
- Data quality flags: —
- Data quality summary: OK
- Tipster consensus: Tipsters divergent from recommendation
- Tipster alignment: DIVERGENT

#### Warnings
- ⚠️ 44 post-off run(s) exist but were ignored (report uses run_time <= off_time).

### 16:00 — Ascot Stakes (Heritage Handicap) (GBBPlus Race)

- Course: Ascot
- Off time (UTC): 2026-06-16T16:00:00+00:00
- Selected pre-off run: c678a017-21bd-4dd2-bff1-feea6fceb33b
- Run time: 2026-06-16T15:55:21.509+00:00
- Selected run status: superseded
- Post-off runs ignored: 39
- Winner: Kizlyar
- Model pick result: Lost

#### Model pick
- Pick: Puturhandstogether
- Finish position: 16
- Odds: 9.60
- EV: +16.6%
- Stake: 1.48
- P/L: −1.48pt
- Confidence: low

#### Market favourite
- Reaching High — odds 3.15 · EV −12.5% · finish 20

#### Alternatives
- Tim Toe — odds 11.50 · EV +16.6% · finish 3
- Barnso — odds 75.00 · EV −0.9% · finish 4

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS
- Data quality summary: DEGRADED — Missing runner odds (19/20 priced)
- Tipster consensus: Tipsters divergent from recommendation
- Tipster alignment: DIVERGENT

#### Warnings
- ⚠️ 39 post-off run(s) exist but were ignored (report uses run_time <= off_time).

### 16:35 — Wolferton Stakes (Listed Race)

- Course: Ascot
- Off time (UTC): 2026-06-16T16:35:00+00:00
- Selected pre-off run: 73194ccf-fb12-4bbc-a98e-5c4eb080d59d
- Run time: 2026-06-16T16:31:25.986+00:00
- Selected run status: superseded
- Post-off runs ignored: 32
- Winner: Map Of Stars
- Model pick result: Lost

#### Model pick
- Pick: Haatem
- Finish position: —
- Odds: 8.00
- EV: +13.8%
- Stake: 1.22
- P/L: −1.22pt
- Confidence: low

#### Market favourite
- Haatem — odds 8.00 · EV +13.8% · finish —

#### Alternatives
- Map Of Stars — odds 8.40 · EV +13.8% · finish 1
- Nahraan — odds 8.20 · EV +13.8% · finish —

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS, NO_TIPSTER_SELECTIONS
- Data quality summary: DEGRADED — Missing runner odds (15/16 priced), No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

#### Warnings
- ⚠️ 32 post-off run(s) exist but were ignored (report uses run_time <= off_time).

### 17:10 — Copper Horse Stakes (Handicap) (GBBPlus Race)

- Course: Ascot
- Off time (UTC): 2026-06-16T17:10:00+00:00
- Selected pre-off run: e4179c79-df0a-4914-89d9-4cb98a6f8d75
- Run time: 2026-06-16T17:07:24.915+00:00
- Selected run status: superseded
- Post-off runs ignored: 25
- Winner: Daiquiri Bay
- Model pick result: Lost

#### Model pick
- Pick: Sing Us A Song
- Finish position: 5
- Odds: 7.80
- EV: +7.1%
- Stake: 1.00
- P/L: −1.00pt
- Confidence: low

#### Market favourite
- Valiancy — odds 3.80 · EV +7.1% · finish 6

#### Alternatives
- Gamrai — odds 6.60 · EV +7.1% · finish 2
- Valiancy — odds 3.80 · EV +7.1% · finish 6

#### Model explanation
- Data quality: OK
- Data quality flags: —
- Data quality summary: OK
- Tipster consensus: Tipsters divergent from recommendation
- Tipster alignment: DIVERGENT

#### Warnings
- ⚠️ 25 post-off run(s) exist but were ignored (report uses run_time <= off_time).
