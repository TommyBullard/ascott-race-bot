# End-of-day race report — 2026-07-09

Course: Newmarket  
Generated: 2026-07-10T09:20:57.448Z  
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
- Settled races: 4
- Pending races: 0
- Recommendations total: 4
- Winners: 1
- Losers: 3
- Strike rate: +25.0%
- Total staked: 3.08
- Profit/Loss: +4.12pt
- ROI: +133.8%
- Average EV: +34.3%
- No-bet races: 3
- Evaluation mode: pre_off

## Pattern analysis

- Low confidence picks: 4
- DEGRADED data-quality races: 5
- OK data-quality races: 2
- DIVERGENT tipster races: 0
- NO_TIPSTER_CONSENSUS races: 7
- Model picks against the market favourite: 4
- Races where the market favourite won: 1
- Races where the model pick placed but did not win: 2
- Races where a model alternative won: 2
- Races where a model alternative placed: 5
- LOW confidence + DIVERGENT: 0
- LOW confidence + DEGRADED: 4
- LOW confidence + NO_TIPSTER_CONSENSUS: 4
- DEGRADED + DIVERGENT: 0

## Interpretation

- Using pre-off evaluation (the latest model run with `run_time <= off_time`), the model's settled record was 1/4 (+25.0% strike) across 7 race(s), for +4.12pt at the stored stakes and odds (ROI +133.8%).
- The selections found some contenders in the stored results: a model alternative won in 2 race(s) and placed (top 3) in 5 race(s); the rank-1 pick placed without winning in 2 race(s).
- Repeated LOW confidence alongside tipster divergence or degraded data are candidates for FUTURE no-bet gate research (LOW+DIVERGENT: 0, LOW+DEGRADED: 4, LOW+NO_TIPSTER_CONSENSUS: 4, DEGRADED+DIVERGENT: 0). Any such gate would require backtesting before activation.
- This is a factual end-of-day summary for research and audit only. It is not betting advice and makes no claim or prediction about future performance.

## Races

### 12:50 — Bahrain Trophy Stakes (Group 3)

- Course: Newmarket
- Off time (UTC): 2026-07-09T12:50:00+00:00
- Selected pre-off run: 167f077d-1a59-4548-a990-af018e810b73
- Run time: 2026-07-09T12:47:56.881+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Point Of Law
- Model pick result: No bet

#### Model pick
- No bet (the selected pre-off run made no rank-1 recommendation).

#### Market favourite
- Del Maro — odds 3.40 · EV −1.2% · finish 3

#### Alternatives
- Galiyan — odds 4.10 · EV −1.2% · finish 2
- Nil Bua Gan Dua — odds 9.60 · EV −1.2% · finish 4

#### Model explanation
- Data quality: OK
- Data quality flags: NO_TIPSTER_SELECTIONS
- Data quality summary: OK — No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 13:25 — Kingdom Of Bahrain July Stakes (Group 2)

- Course: Newmarket
- Off time (UTC): 2026-07-09T13:25:00+00:00
- Selected pre-off run: 6caec12d-6bad-4870-b00a-ca5635b8302b
- Run time: 2026-07-09T13:22:11.841+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Inner City Blues
- Model pick result: No bet

#### Model pick
- No bet (the selected pre-off run made no rank-1 recommendation).

#### Market favourite
- Inner City Blues — odds 2.00 · EV −1.1% · finish 1

#### Alternatives
- Inner City Blues — odds 2.00 · EV −1.1% · finish 1
- Hickory Lad — odds 6.60 · EV −1.1% · finish 3

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS, LOW_MARKET_COMPLETENESS, NO_TIPSTER_SELECTIONS
- Data quality summary: DEGRADED — Missing runner odds (3/4 priced), Low market completeness (0.75), No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 14:00 — Betway Handicap (Heritage Handicap)

- Course: Newmarket
- Off time (UTC): 2026-07-09T14:00:00+00:00
- Selected pre-off run: de86c55a-6342-4bf0-8eca-f123855d6368
- Run time: 2026-07-09T13:59:13.591+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Jazl
- Model pick result: Lost

#### Model pick
- Pick: Man Of Vision
- Finish position: 13
- Odds: 7.80
- EV: +2.2%
- Stake: 1.00
- P/L: −1.00pt
- Confidence: low

#### Market favourite
- Thunder Call — odds 5.60 · EV +2.2% · finish 3

#### Alternatives
- Ten Carat Harry — odds 10.50 · EV +2.2% · finish 7
- Calico Blue — odds 11.50 · EV +2.2% · finish 2

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS, NO_TIPSTER_SELECTIONS
- Data quality summary: DEGRADED — Missing runner odds (13/14 priced), No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 14:35 — Princess Of Wales's Stakes (Sponsored By The Kingdom Of Bahrain) (Group 2)

- Course: Newmarket
- Off time (UTC): 2026-07-09T14:35:00+00:00
- Selected pre-off run: e6a712fb-19c9-4598-bdc4-149bc844810b
- Run time: 2026-07-09T14:25:27.172+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Rebel's Romance
- Model pick result: Lost

#### Model pick
- Pick: Almeric
- Finish position: 3
- Odds: 7.20
- EV: +115.4%
- Stake: 0.00
- P/L: 0.00pt
- Confidence: low

#### Market favourite
- Convergent — odds 3.45 · EV +115.4% · finish 4

#### Alternatives
- Convergent — odds 3.45 · EV +115.4% · finish 4
- Arabian Crown — odds 24.00 · EV +83.1% · finish 2

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS, LOW_MARKET_COMPLETENESS, NO_TIPSTER_SELECTIONS
- Data quality summary: DEGRADED — Missing runner odds (3/5 priced), Low market completeness (0.60), No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 15:10 — British Stallion Studs EBF Maiden Fillies' Stakes (GBB Race)

- Course: Newmarket
- Off time (UTC): 2026-07-09T15:10:00+00:00
- Selected pre-off run: 62616af3-23f7-453d-b90e-3b6c65623cbf
- Run time: 2026-07-09T14:25:28.145+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Scommessa Sicura
- Model pick result: Lost

#### Model pick
- Pick: Madam Secretary
- Finish position: 3
- Odds: 8.80
- EV: +13.5%
- Stake: 1.08
- P/L: −1.08pt
- Confidence: low

#### Market favourite
- Peaceful Charm — odds 1.80 · EV −9.2% · finish 4

#### Alternatives
- Scommessa Sicura — odds 4.90 · EV +13.5% · finish 1
- Tegernsee — odds 50.00 · EV −3.6% · finish 9

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS, NO_TIPSTER_SELECTIONS
- Data quality summary: DEGRADED — Missing runner odds (9/10 priced), No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 15:45 — Edmondson Hall Solicitors Sir Henry Cecil Stakes (Listed)

- Course: Newmarket
- Off time (UTC): 2026-07-09T15:45:00+00:00
- Selected pre-off run: 2bdd42d3-cdd9-4ab2-b40a-8bb50d775f43
- Run time: 2026-07-09T15:44:30.415+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Shayem
- Model pick result: No bet

#### Model pick
- No bet (the selected pre-off run made no rank-1 recommendation).

#### Market favourite
- Morris Dancer — odds 2.64 · EV −1.1% · finish 7

#### Alternatives
- Colori Forever — odds 8.00 · EV −1.1% · finish 2
- Wild Desert — odds 6.20 · EV −1.1% · finish 6

#### Model explanation
- Data quality: OK
- Data quality flags: NO_TIPSTER_SELECTIONS
- Data quality summary: OK — No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS

### 16:20 — Debenhams Handicap

- Course: Newmarket
- Off time (UTC): 2026-07-09T16:20:00+00:00
- Selected pre-off run: 4bbc1b66-2456-405c-be1e-d97b6ddaacea
- Run time: 2026-07-09T16:15:41.667+00:00
- Selected run status: current
- Post-off runs ignored: 0
- Winner: Asmen Warrior
- Model pick result: Won

#### Model pick
- Pick: Asmen Warrior
- Finish position: 1
- Odds: 7.20
- EV: +6.3%
- Stake: 1.00
- P/L: +6.20pt
- Confidence: low

#### Market favourite
- Shipbourne — odds 4.30 · EV +6.3% · finish 13

#### Alternatives
- Lion Of Alba — odds 5.50 · EV +6.3% · finish 7
- Spanish Voice — odds 6.00 · EV +6.3% · finish 5

#### Model explanation
- Data quality: DEGRADED
- Data quality flags: MISSING_RUNNER_ODDS, NO_TIPSTER_SELECTIONS
- Data quality summary: DEGRADED — Missing runner odds (12/15 priced), No tipster selections
- Tipster consensus: No tipster consensus
- Tipster alignment: NO_TIPSTER_CONSENSUS
