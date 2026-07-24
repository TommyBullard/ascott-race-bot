# Nationwide dry-run — 2026-07-24 — live-provider

**READ/INGESTION BOUNDARY.** No model runs, recommendations, official locks, or
results were persisted by this command. No bet was placed; no bet was ever possible.
Generated: 2026-07-24T12:27:51.801Z

- Mode: `live-provider`
- Ownership scope: `all-uk-ire`
- Owner: 9fa61152… (generation 1)
- Claim lifecycle: acquired → released
- External checks source: not_applicable — this command performs no external checks; run nationwide:preflight separately for an operator-attested verdict

## Provider stages attempted

- racecards: ok — racecards route responded
- odds: ok — odds route responded (considered=55 matched=55)

## Rollup reconciliation

- Courses: 8
- Total races: 55
- Total runners: 587
- Races with odds: 55
- Priced runners: 530
- No invariant violations.

### Per-course counts

| Course | Races | Runners | Odds | Priced runners |
| --- | --- | --- | --- | --- |
| ascot | 6 | 53 | 6 | 49 |
| chepstow | 7 | 57 | 7 | 55 |
| cork | 7 | 84 | 7 | 76 |
| kilbeggan | 8 | 120 | 8 | 102 |
| sandown | 6 | 39 | 6 | 31 |
| thirsk | 7 | 56 | 7 | 54 |
| uttoxeter | 8 | 98 | 8 | 86 |
| york | 6 | 80 | 6 | 77 |

## Scoring
- Eligible races: 55
- Scored races: 55
- Zero-priced skips: 0
- Failures (isolated): 0
- Total: 8968ms · Mean: 163ms · Median: 154ms · p95: 199ms · Max: 264ms
- Five-minute-cadence margin: 291032ms

## Command duration

- 27292ms total

## Outcome: COMPLETED

- The run completed its full stage contract.

No model runs, recommendations, locks, or results were persisted by this command.
No betting and no bet placement — this system never places a bet.
