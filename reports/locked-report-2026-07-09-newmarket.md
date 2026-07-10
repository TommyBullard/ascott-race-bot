# Locked-decision performance — 2026-07-09

Course: Newmarket  
Official horizon: T-minus-5  
Generated: 2026-07-10T09:47:49.583Z  
Races: 7

> OFFICIAL decision = `locked_race_decisions` at T-minus-5. The final
> pre-off model run is fallback/diagnostic only. Locked decisions are
> immutable — divergence below is analysis, never a reason to rewrite a
> lock. Pending races are never losses; `locked_no_bet`,
> `no_run_available`, and `lock_missing` are separate buckets, never
> losses. One day is research signal only. Decision-support only — not
> betting advice.

## Lock coverage

- Races considered: 7
- Locked (any official row): 5
- Lock missing: 2
- Coverage: 71.4% (target ≥ 95%)
- Missing races (remain lock_missing; NEVER backfilled):
  - 14:35 Princess Of Wales's Stakes (Sponsored By The Kingdom Of Bahrain) (Group 2)
  - 15:10 British Stallion Studs EBF Maiden Fillies' Stakes (GBB Race)

## Official locked performance (locked_pick only, stored odds/stake)

- Locked picks: 3 (settled 3, pending 0)
- Winners / losers: 0 / 3
- Strike rate: 0.0%
- P/L (stored locked odds/stake): -3.00 over 3.00 staked
- ROI: -100.0%
- Average locked EV: +3.3%
- Official no-bet decisions (locked_no_bet): 2
- No run available at lock (no_run_available): 0
- Unevaluable locked picks: 0

## Per-race detail

### 12:50 — Bahrain Trophy Stakes (Group 3)

- Official status: locked_no_bet
- Official no-bet reason: captured run produced no rank-1 recommendation; data quality: OK — No tipster selections
- Result: winner Point Of Law
- Official outcome: —
- Final pre-off diagnostic pick: no bet (diagnostic run made no rank-1 recommendation)
- Divergence: same_no_bet

### 13:25 — Kingdom Of Bahrain July Stakes (Group 2)

- Official status: locked_no_bet
- Official no-bet reason: captured run produced no rank-1 recommendation; run quality: DEGRADED; data quality: DEGRADED — Missing runner odds (3/4 priced), Low market completeness (0.75), No tipster selections
- Result: winner Inner City Blues
- Official outcome: —
- Final pre-off diagnostic pick: no bet (diagnostic run made no rank-1 recommendation)
- Divergence: same_no_bet

### 14:00 — Betway Handicap (Heritage Handicap)

- Official status: locked_pick
- Official locked pick: Ten Carat Harry — odds 12.00 · EV +2.4% · stake 1.00 · confidence low
- Result: winner Jazl
- Official outcome: LOST
- Final pre-off diagnostic pick: Man Of Vision — odds 7.80 — lost
- Divergence: different_pick

### 14:35 — Princess Of Wales's Stakes (Sponsored By The Kingdom Of Bahrain) (Group 2)

- Official status: lock_missing
- Result: winner Rebel's Romance
- Official outcome: —
- Final pre-off diagnostic pick: Almeric — odds 7.20 — lost
- Divergence: not_comparable

### 15:10 — British Stallion Studs EBF Maiden Fillies' Stakes (GBB Race)

- Official status: lock_missing
- Result: winner Scommessa Sicura
- Official outcome: —
- Final pre-off diagnostic pick: Madam Secretary — odds 8.80 — lost
- Divergence: not_comparable

### 15:45 — Edmondson Hall Solicitors Sir Henry Cecil Stakes (Listed)

- Official status: locked_pick
- Official locked pick: Morris Dancer — odds 2.46 · EV +0.4% · stake 1.00 · confidence low
- Result: winner Shayem
- Official outcome: LOST
- Final pre-off diagnostic pick: no bet (diagnostic run made no rank-1 recommendation)
- Divergence: official_pick_diagnostic_no_bet

### 16:20 — Debenhams Handicap

- Official status: locked_pick
- Official locked pick: Shipbourne — odds 4.10 · EV +7.1% · stake 1.00 · confidence low
- Result: winner Asmen Warrior
- Official outcome: LOST
- Final pre-off diagnostic pick: Asmen Warrior — odds 7.20 — WON
- Divergence: different_pick
- ⚠️ Outcome divergence: diagnostic_won_official_lost

## Divergence analysis (official vs final pre-off diagnostic)

### ⚠️ Diagnostic won but official lock lost / did not bet
- 16:20 Debenhams Handicap: official Shipbourne LOST vs diagnostic Asmen Warrior WON

### Other pick divergence (no settled outcome split)
- 14:00 Betway Handicap (Heritage Handicap): different_pick
- 15:45 Edmondson Hall Solicitors Sir Henry Cecil Stakes (Listed): official_pick_diagnostic_no_bet

## Fallback view — lock_missing races (pre-off rule; NOT official figures)

- 14:35 Princess Of Wales's Stakes (Sponsored By The Kingdom Of Bahrain) (Group 2): fallback pick Almeric — odds 7.20 — lost
- 15:10 British Stallion Studs EBF Maiden Fillies' Stakes (GBB Race): fallback pick Madam Secretary — odds 8.80 — lost
