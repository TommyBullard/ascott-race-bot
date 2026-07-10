# End-of-day race report — 2026-07-10

Course: Newmarket  
Generated: 2026-07-10T21:57:46.178Z  
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
- Winners: 4
- Losers: 2
- Strike rate: +66.7%
- Total staked: 10.75
- Profit/Loss: +30.24pt
- ROI: +281.2%
- Average EV: +10.8%
- No-bet races: 1
- Evaluation mode: pre_off

## Pattern analysis

- Low confidence picks: 6
- DEGRADED data-quality races: 3
- OK data-quality races: 4
- DIVERGENT tipster races: 0
- NO_TIPSTER_CONSENSUS races: 7
- Model picks against the market favourite: 5
- Races where the market favourite won: 1
- Races where the model pick placed but did not win: 1
- Races where a model alternative won: 3
- Races where a model alternative placed: 1
- LOW confidence + DIVERGENT: 0
- LOW confidence + DEGRADED: 3
- LOW confidence + NO_TIPSTER_CONSENSUS: 6
- DEGRADED + DIVERGENT: 0

## Interpretation

- Using pre-off evaluation (the latest model run with `run_time <= off_time`), the model's settled record was 4/6 (+66.7% strike) across 7 race(s), for +30.24pt at the stored stakes and odds (ROI +281.2%).
- The selections found some contenders in the stored results: a model alternative won in 3 race(s) and placed (top 3) in 1 race(s); the rank-1 pick placed without winning in 1 race(s).
- Repeated LOW confidence alongside tipster divergence or degraded data are candidates for FUTURE no-bet gate research (LOW+DIVERGENT: 0, LOW+DEGRADED: 3, LOW+NO_TIPSTER_CONSENSUS: 6, DEGRADED+DIVERGENT: 0). Any such gate would require backtesting before activation.
- This is a factual end-of-day summary for research and audit only. It is not betting advice and makes no claim or prediction about future performance.

## Races

### 12:50 — Oddschecker Handicap (Heritage Handicap) (GBBPlus Race)

- Course: Newmarket
- Off time (UTC): 2026-07-10T12:50:00+00:00
- Selected pre-off run: fa0a8409-dfe5-4f43-8291-13af64020ed2
- Run time: 2026-07-10T12:45:24.844+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Heraldry
- Model pick result: No bet

#### Model pick
- No bet (the selected pre-off run made no rank-1 recommendation).

#### Market favourite
- Princling — odds 3.85 · EV −1.4% · finish 6

#### Alternatives
- Heraldry — odds 5.30 · EV −1.4% · finish 1
- Evanesco — odds 4.90 · EV −1.4% · finish 5

#### Model explanation
- Data quality: OK
- Data quality flags: NO_TIPSTER_SELECTIONS
- Data quality summary: OK — No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 13:25 — Duchess Of Cambridge Stakes (Sponsored By Ultimate Provence) (Fillies' Group 2)

- Course: Newmarket
- Off time (UTC): 2026-07-10T13:25:00+00:00
- Selected pre-off run: 4468721a-667a-4b84-89b0-39d7e0dccab5
- Run time: 2026-07-10T13:22:08.003+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Senorita Bonita
- Model pick result: Won

#### Model pick
- Pick: Senorita Bonita
- Finish position: 1
- Odds: 4.10
- EV: +14.4%
- Stake: 3.47
- P/L: +10.77pt
- Confidence: low

#### Market favourite
- Libertango — odds 1.96 · EV −8.5% · finish 2

#### Alternatives
- Troublesome Guest — odds 140.00 · EV −2.7% · finish 8
- Acclamation Star — odds 90.00 · EV −2.7% · finish 6

#### Model explanation
- Data quality: OK
- Data quality flags: NO_TIPSTER_SELECTIONS
- Data quality summary: OK — No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 14:00 — Betway Trophy (Heritage Handicap) (GBBPlus Race)

- Course: Newmarket
- Off time (UTC): 2026-07-10T14:00:00+00:00
- Selected pre-off run: 6ab22196-c14f-4e8b-94c8-bbe49ace9e6b
- Run time: 2026-07-10T13:58:44.534+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Valedictory
- Model pick result: Lost

#### Model pick
- Pick: Goblet Of Fire
- Finish position: 3
- Odds: 11.50
- EV: +17.9%
- Stake: 1.37
- P/L: −1.37pt
- Confidence: low

#### Market favourite
- Wine Dark Sea — odds 1.99 · EV −5.7% · finish 5

#### Alternatives
- Valedictory — odds 5.60 · EV +17.9% · finish 1
- Beylerbeyi — odds 23.00 · EV +0.2% · finish 4

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS, NO_TIPSTER_SELECTIONS
- Data quality summary: DEGRADED — Missing runner odds (9/10 priced), No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 14:35 — Tattersalls Sceptre Sessions Falmouth Stakes (Fillies' & Mares' Group 1)

- Course: Newmarket
- Off time (UTC): 2026-07-10T14:35:00+00:00
- Selected pre-off run: 581e990a-e6a8-4b5e-86f0-932733fabb54
- Run time: 2026-07-10T14:30:03.865+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Blue Bolt
- Model pick result: Won

#### Model pick
- Pick: Blue Bolt
- Finish position: 1
- Odds: 3.90
- EV: +12.7%
- Stake: 2.91
- P/L: +8.44pt
- Confidence: low

#### Market favourite
- Precise — odds 1.89 · EV −9.8% · finish 2

#### Alternatives
- Jancis — odds 9.40 · EV +12.7% · finish 5
- Balantina — odds 22.00 · EV −4.2% · finish 3

#### Model explanation
- Data quality: OK
- Data quality flags: NO_TIPSTER_SELECTIONS
- Data quality summary: OK — No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 15:10 — Weatherbys Banking Group British EBF Maiden Fillies' Stakes (GBB Race)

- Course: Newmarket
- Off time (UTC): 2026-07-10T15:10:00+00:00
- Selected pre-off run: 399fe572-92fa-491c-bf2c-04b3e4c93a9b
- Run time: 2026-07-10T15:06:31.726+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Acting Lady
- Model pick result: Won

#### Model pick
- Pick: Acting Lady
- Finish position: 1
- Odds: 3.40
- EV: +2.2%
- Stake: 1.00
- P/L: +2.40pt
- Confidence: low

#### Market favourite
- Acting Lady — odds 3.40 · EV +2.2% · finish 1

#### Alternatives
- Desert Sands — odds 10.00 · EV +2.2% · finish 9
- Desert Smoke — odds 6.20 · EV +2.2% · finish 6

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS, NO_TIPSTER_SELECTIONS
- Data quality summary: DEGRADED — Missing runner odds (10/11 priced), No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 15:45 — Debenhams Handicap

- Course: Newmarket
- Off time (UTC): 2026-07-10T15:45:00+00:00
- Selected pre-off run: aa81cbc7-26d9-44f0-b139-542afd4fa2bf
- Run time: 2026-07-10T15:42:57.835+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Twilight Calls
- Model pick result: Lost

#### Model pick
- Pick: Tatterstall
- Finish position: 5
- Odds: 11.00
- EV: +15.1%
- Stake: 1.00
- P/L: −1.00pt
- Confidence: low

#### Market favourite
- Emperor Spirit — odds 6.40 · EV +15.1% · finish 3

#### Alternatives
- Rosario — odds 11.00 · EV +15.1% · finish 4
- Twilight Calls — odds 11.00 · EV +15.1% · finish 1

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS, NO_TIPSTER_SELECTIONS
- Data quality summary: DEGRADED — Missing runner odds (11/12 priced), No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 16:20 — Jockey Club Estates Handicap

- Course: Newmarket
- Off time (UTC): 2026-07-10T16:20:00+00:00
- Selected pre-off run: 450f8d8a-8b55-4a64-8374-0f867ae4863d
- Run time: 2026-07-10T16:19:09.972+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Sierra Sands
- Model pick result: Won

#### Model pick
- Pick: Sierra Sands
- Finish position: 1
- Odds: 12.00
- EV: +2.4%
- Stake: 1.00
- P/L: +11.00pt
- Confidence: low

#### Market favourite
- Toastmaster — odds 2.70 · EV +2.4% · finish 5

#### Alternatives
- Aqua Bear — odds 7.20 · EV +2.4% · finish 11
- Toastmaster — odds 2.70 · EV +2.4% · finish 5

#### Model explanation
- Data quality: OK
- Data quality flags: NO_TIPSTER_SELECTIONS
- Data quality summary: OK — No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS
