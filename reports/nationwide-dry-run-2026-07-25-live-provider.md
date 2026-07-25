# Nationwide dry-run — 2026-07-25 — live-provider

**READ/INGESTION BOUNDARY.** No model runs, recommendations, official locks, or
results were persisted by this command. No bet was placed; no bet was ever possible.
Generated: 2026-07-25T16:45:21.303Z

- Mode: `live-provider`
- Ownership scope: `all-uk-ire`
- Owner: 4457d070… (generation 1)
- Claim lifecycle: acquired → released
- External checks source: not_applicable — this command performs no external checks; run nationwide:preflight separately for an operator-attested verdict

## Provider stages attempted

- racecards: ok — racecards route responded
- odds: ok — odds route responded (considered=51 matched=14)

## Rollup reconciliation

- Courses: 7
- Total races: 51
- Total runners: 527
- Races with odds: 14
- Priced runners: 88
- No invariant violations.

### Per-course counts

| Course | Races | Runners | Odds | Priced runners |
| --- | --- | --- | --- | --- |
| ascot | 8 | 94 | 0 | 0 |
| chester | 7 | 62 | 0 | 0 |
| gowran park | 8 | 95 | 1 | 7 |
| lingfield | 7 | 45 | 6 | 37 |
| newcastle | 8 | 104 | 1 | 13 |
| salisbury | 6 | 35 | 6 | 31 |
| york | 7 | 92 | 0 | 0 |

## Scoring
- Eligible races: 51
- Scored races: 14
- Zero-priced skips: 37
- Failures (isolated): 0
- Total: 2093ms · Mean: 150ms · Median: 130ms · p95: 251ms · Max: 251ms
- Five-minute-cadence margin: 297907ms

## Command duration

- 18432ms total

## Outcome: COMPLETED

- The run completed its full stage contract.

No model runs, recommendations, locks, or results were persisted by this command.
No betting and no bet placement — this system never places a bet.
