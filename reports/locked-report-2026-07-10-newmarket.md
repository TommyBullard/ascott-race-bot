# Locked-decision performance — 2026-07-10

Course: Newmarket  
Official horizon: T-minus-5  
Generated: 2026-07-10T21:57:49.337Z  
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
- Locked (any official row): 7
- Lock missing: 0
- Coverage: 100.0% (target ≥ 95%)

## Official locked performance (locked_pick only, stored odds/stake)

- Locked picks: 6 (settled 6, pending 0)
- Winners / losers: 4 / 2
- Strike rate: 66.7%
- P/L (stored locked odds/stake): 20.46 over 9.68 staked
- ROI: 211.3%
- Average locked EV: +7.7%
- Official no-bet decisions (locked_no_bet): 1
- No run available at lock (no_run_available): 0
- Unevaluable locked picks: 0

## Per-race detail

### 12:50 — Oddschecker Handicap (Heritage Handicap) (GBBPlus Race)

- Official status: locked_no_bet
- Official no-bet reason: captured run produced no rank-1 recommendation; data quality: OK — No tipster selections
- Result: winner Heraldry
- Official outcome: —
- Final pre-off diagnostic pick: no bet (diagnostic run made no rank-1 recommendation)
- Divergence: same_no_bet

### 13:25 — Duchess Of Cambridge Stakes (Sponsored By Ultimate Provence) (Fillies' Group 2)

- Official status: locked_pick
- Official locked pick: Libertango — odds 2.00 · EV +2.7% · stake 1.00 · confidence low
- Result: winner Senorita Bonita
- Official outcome: LOST
- Final pre-off diagnostic pick: Senorita Bonita — odds 4.10 — WON
- Divergence: different_pick
- ⚠️ Outcome divergence: diagnostic_won_official_lost

### 14:00 — Betway Trophy (Heritage Handicap) (GBBPlus Race)

- Official status: locked_pick
- Official locked pick: Valedictory — odds 5.10 · EV +5.3% · stake 1.00 · confidence low
- Result: winner Valedictory
- Official outcome: WON
- Final pre-off diagnostic pick: Goblet Of Fire — odds 11.50 — lost
- Divergence: different_pick
- ⚠️ Outcome divergence: official_won_diagnostic_lost

### 14:35 — Tattersalls Sceptre Sessions Falmouth Stakes (Fillies' & Mares' Group 1)

- Official status: locked_pick
- Official locked pick: Blue Bolt — odds 4.00 · EV +12.5% · stake 2.74 · confidence low
- Result: winner Blue Bolt
- Official outcome: WON
- Final pre-off diagnostic pick: Blue Bolt — odds 3.90 — WON
- Divergence: same_pick

### 15:10 — Weatherbys Banking Group British EBF Maiden Fillies' Stakes (GBB Race)

- Official status: locked_pick
- Official locked pick: Acting Lady — odds 3.60 · EV +2.6% · stake 1.00 · confidence low
- Result: winner Acting Lady
- Official outcome: WON
- Final pre-off diagnostic pick: Acting Lady — odds 3.40 — WON
- Divergence: same_pick

### 15:45 — Debenhams Handicap

- Official status: locked_pick
- Official locked pick: Rhythm N Hooves — odds 7.20 · EV +21.0% · stake 2.95 · confidence low
- Result: winner Twilight Calls
- Official outcome: LOST
- Final pre-off diagnostic pick: Tatterstall — odds 11.00 — lost
- Divergence: different_pick

### 16:20 — Jockey Club Estates Handicap

- Official status: locked_pick
- Official locked pick: Sierra Sands — odds 10.50 · EV +2.1% · stake 1.00 · confidence low
- Result: winner Sierra Sands
- Official outcome: WON
- Final pre-off diagnostic pick: Sierra Sands — odds 12.00 — WON
- Divergence: same_pick

## Divergence analysis (official vs final pre-off diagnostic)

### ⚠️ Diagnostic won but official lock lost / did not bet
- 13:25 Duchess Of Cambridge Stakes (Sponsored By Ultimate Provence) (Fillies' Group 2): official Libertango LOST vs diagnostic Senorita Bonita WON

### Official won where diagnostic lost / did not bet
- 14:00 Betway Trophy (Heritage Handicap) (GBBPlus Race): official Valedictory WON vs diagnostic Goblet Of Fire lost

### Other pick divergence (no settled outcome split)
- 15:45 Debenhams Handicap: different_pick
