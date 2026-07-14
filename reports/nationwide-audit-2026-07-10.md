# Nationwide UK & Ireland audit — 2026-07-10

**READ ONLY** — SELECT-only inspection of stored data.
Generated: 2026-07-12T19:37:31.843Z

> Official decision = `locked_race_decisions` at T-minus-5. Diagnostic
> (pre-off) output is comparison only. Pending races are never losses;
> `locked_no_bet` is a valid decision (never a loss); `no_run_available`
> and `lock_missing` are separate buckets (never losses, never
> backfilled). Decision-support only — not betting advice.
>
> **This report does not enable nationwide commit mode.**

## Overall summary

- Courses/meetings: 7
- Races: 49
- Runners: 558
- Races with odds: 49
- Priced runners / total runners: 468 / 558
- Races with pre-off model runs: 7
- Diagnostic picks: 6
- Diagnostic no-bets: 1
- Official locked rows: 7
- Locked picks: 6
- Locked no-bets: 1
- No run available at lock: 0
- Not locked yet: 0
- LOCK MISSING: 42
- Settled races: 7
- Pending races: 42 (never counted as losses)
- Result coverage: 14.3%
- Model coverage: 14.3%
- Lock coverage: 14.3%

## Per-course rollup

### ascot

- Source labels: Ascot
- Countries: GB
- Races: 6 · Runners: 53
- Odds coverage: 6/6 races · priced runners 48/53
- Model coverage: 0/6 pre-off runs · diagnostic picks 0 · diagnostic no-bets 0
- Official locks: 0/6 · picks 0 · no-bets 0 · no-run 0 · not yet 0 · MISSING 6
- Results: settled 0 · pending 6 · upcoming 0

### chester

- Source labels: Chester
- Countries: GB
- Races: 7 · Runners: 62
- Odds coverage: 7/7 races · priced runners 49/62
- Model coverage: 0/7 pre-off runs · diagnostic picks 0 · diagnostic no-bets 0
- Official locks: 0/7 · picks 0 · no-bets 0 · no-run 0 · not yet 0 · MISSING 7
- Results: settled 0 · pending 7 · upcoming 0

### cork

- Source labels: Cork
- Countries: IRE
- Races: 7 · Runners: 118
- Odds coverage: 7/7 races · priced runners 102/118
- Model coverage: 0/7 pre-off runs · diagnostic picks 0 · diagnostic no-bets 0
- Official locks: 0/7 · picks 0 · no-bets 0 · no-run 0 · not yet 0 · MISSING 7
- Results: settled 0 · pending 7 · upcoming 0

### kilbeggan

- Source labels: Kilbeggan
- Countries: IRE
- Races: 7 · Runners: 106
- Odds coverage: 7/7 races · priced runners 77/106
- Model coverage: 0/7 pre-off runs · diagnostic picks 0 · diagnostic no-bets 0
- Official locks: 0/7 · picks 0 · no-bets 0 · no-run 0 · not yet 0 · MISSING 7
- Results: settled 0 · pending 7 · upcoming 0

### newmarket

- Source labels: Newmarket
- Countries: GB
- Races: 7 · Runners: 65
- Odds coverage: 7/7 races · priced runners 62/65
- Model coverage: 7/7 pre-off runs · diagnostic picks 6 · diagnostic no-bets 1
- Official locks: 7/7 · picks 6 · no-bets 1 · no-run 0 · not yet 0 · MISSING 0
- Official outcomes (stored locked odds/stake): W4/L2 · pending 0 · no-bet 1
- Results: settled 7 · pending 0 · upcoming 0

### worcester

- Source labels: Worcester
- Countries: GB
- Races: 8 · Runners: 69
- Odds coverage: 8/8 races · priced runners 53/69
- Model coverage: 0/8 pre-off runs · diagnostic picks 0 · diagnostic no-bets 0
- Official locks: 0/8 · picks 0 · no-bets 0 · no-run 0 · not yet 0 · MISSING 8
- Results: settled 0 · pending 8 · upcoming 0

### york

- Source labels: York
- Countries: GB
- Races: 7 · Runners: 85
- Odds coverage: 7/7 races · priced runners 77/85
- Model coverage: 0/7 pre-off runs · diagnostic picks 0 · diagnostic no-bets 0
- Official locks: 0/7 · picks 0 · no-bets 0 · no-run 0 · not yet 0 · MISSING 7
- Results: settled 0 · pending 7 · upcoming 0

## Provider / course-label warnings

- ⚠️ 35 race(s) carry country "GB" — the ingest fallback default (provider region was absent; likely GB but unverified)

## Coverage gaps

- ascot: odds 6/6, model 0/6, lock missing 6, pending 6, read errors 0
- chester: odds 7/7, model 0/7, lock missing 7, pending 7, read errors 0
- cork: odds 7/7, model 0/7, lock missing 7, pending 7, read errors 0
- kilbeggan: odds 7/7, model 0/7, lock missing 7, pending 7, read errors 0
- worcester: odds 8/8, model 0/8, lock missing 8, pending 8, read errors 0
- york: odds 7/7, model 0/7, lock missing 7, pending 7, read errors 0

## Evidence-gate verdict: REVIEW

- 1 warning(s) require operator review

This report does not enable nationwide commit mode.
