# Nationwide UK & Ireland audit — 2026-07-09

**READ ONLY** — SELECT-only inspection of stored data.
Generated: 2026-07-12T19:37:15.724Z

> Official decision = `locked_race_decisions` at T-minus-5. Diagnostic
> (pre-off) output is comparison only. Pending races are never losses;
> `locked_no_bet` is a valid decision (never a loss); `no_run_available`
> and `lock_missing` are separate buckets (never losses, never
> backfilled). Decision-support only — not betting advice.
>
> **This report does not enable nationwide commit mode.**

## Overall summary

- Courses/meetings: 6
- Races: 40
- Runners: 374
- Races with odds: 34
- Priced runners / total runners: 302 / 374
- Races with pre-off model runs: 7
- Diagnostic picks: 4
- Diagnostic no-bets: 3
- Official locked rows: 5
- Locked picks: 3
- Locked no-bets: 2
- No run available at lock: 0
- Not locked yet: 0
- LOCK MISSING: 35
- Settled races: 7
- Pending races: 33 (never counted as losses)
- Result coverage: 17.5%
- Model coverage: 17.5%
- Lock coverage: 12.5%

## Per-course rollup

### carlisle

- Source labels: Carlisle
- Countries: GB
- Races: 6 · Runners: 49
- Odds coverage: 6/6 races · priced runners 45/49
- Model coverage: 0/6 pre-off runs · diagnostic picks 0 · diagnostic no-bets 0
- Official locks: 0/6 · picks 0 · no-bets 0 · no-run 0 · not yet 0 · MISSING 6
- Results: settled 0 · pending 6 · upcoming 0

### doncaster

- Source labels: Doncaster
- Countries: GB
- Races: 7 · Runners: 56
- Odds coverage: 7/7 races · priced runners 52/56
- Model coverage: 0/7 pre-off runs · diagnostic picks 0 · diagnostic no-bets 0
- Official locks: 0/7 · picks 0 · no-bets 0 · no-run 0 · not yet 0 · MISSING 7
- Results: settled 0 · pending 7 · upcoming 0

### epsom downs

- Source labels: Epsom Downs
- Countries: GB
- Races: 6 · Runners: 43
- Odds coverage: 0/6 races · priced runners 0/43
- Model coverage: 0/6 pre-off runs · diagnostic picks 0 · diagnostic no-bets 0
- Official locks: 0/6 · picks 0 · no-bets 0 · no-run 0 · not yet 0 · MISSING 6
- Results: settled 0 · pending 6 · upcoming 0

### leopardstown

- Source labels: Leopardstown
- Countries: IRE
- Races: 7 · Runners: 87
- Odds coverage: 7/7 races · priced runners 80/87
- Model coverage: 0/7 pre-off runs · diagnostic picks 0 · diagnostic no-bets 0
- Official locks: 0/7 · picks 0 · no-bets 0 · no-run 0 · not yet 0 · MISSING 7
- Results: settled 0 · pending 7 · upcoming 0

### newbury

- Source labels: Newbury
- Countries: GB
- Races: 7 · Runners: 79
- Odds coverage: 7/7 races · priced runners 73/79
- Model coverage: 0/7 pre-off runs · diagnostic picks 0 · diagnostic no-bets 0
- Official locks: 0/7 · picks 0 · no-bets 0 · no-run 0 · not yet 0 · MISSING 7
- Results: settled 0 · pending 7 · upcoming 0

### newmarket

- Source labels: Newmarket
- Countries: GB
- Races: 7 · Runners: 60
- Odds coverage: 7/7 races · priced runners 52/60
- Model coverage: 7/7 pre-off runs · diagnostic picks 4 · diagnostic no-bets 3
- Official locks: 5/7 · picks 3 · no-bets 2 · no-run 0 · not yet 0 · MISSING 2
- Official outcomes (stored locked odds/stake): W0/L3 · pending 0 · no-bet 2
- Results: settled 7 · pending 0 · upcoming 0

## Provider / course-label warnings

- ⚠️ 33 race(s) carry country "GB" — the ingest fallback default (provider region was absent; likely GB but unverified)

## Coverage gaps

- carlisle: odds 6/6, model 0/6, lock missing 6, pending 6, read errors 0
- doncaster: odds 7/7, model 0/7, lock missing 7, pending 7, read errors 0
- epsom downs: odds 0/6, model 0/6, lock missing 6, pending 6, read errors 0
- leopardstown: odds 7/7, model 0/7, lock missing 7, pending 7, read errors 0
- newbury: odds 7/7, model 0/7, lock missing 7, pending 7, read errors 0
- newmarket: odds 7/7, model 7/7, lock missing 2, pending 0, read errors 0

## Evidence-gate verdict: REVIEW

- 1 warning(s) require operator review

This report does not enable nationwide commit mode.
