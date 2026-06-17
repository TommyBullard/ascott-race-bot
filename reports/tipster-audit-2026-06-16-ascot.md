# Tipster intelligence audit — 2026-06-16

Course: Ascot  
Generated: 2026-06-17T10:44:15.977Z  
Approved selections: 5

> Read-only diagnostic. These tipster signals are NOT model-active, change
> no probability, staking, ranking, or weighting, and approve nothing. In-day
> form is diagnostic only; any future use must be capped and decayed (not
> implemented here). Decision-support only — not betting advice.

## 1. Approved selections

- Total approved selections: 5
- Races covered: 5
- Selections with unknown source: 0
- Selections with unknown tipster: 0

By source:
- public_royal_ascot_consensus: 3
- horseracing_net: 2

By tipster:
- Brian Healy public consensus: 1
- HorseRacing.net Most Napped: 1
- HorseRacing.net Spotlight: 1
- OLBG / Kevin Blake DRF public consensus: 1
- The Independent / Final Furlong public consensus: 1

By race:
- Ascot Stakes (Heritage Handicap) (GBBPlus Race): 1
- Copper Horse Stakes (Handicap) (GBBPlus Race): 1
- Coventry Stakes (Group 2): 1
- King Charles III Stakes (Group 1): 1
- St James's Palace Stakes (Group 1) (Colts): 1

## 2. Candidates

- Pending: 6
- Approved: 5
- Rejected: 0
- Source labels: horseracing_net, public_royal_ascot_consensus

## 3. Correlation / de-duplication

- No runner was selected by multiple distinct sources in scope.

## 4. Tipster evidence

- — (no recorded tipster evidence in scope)

## 5. In-day form (diagnostic only)

- Brian Healy public consensus: 1/1 won · 0 placed · 0 lost (settled 1)
- HorseRacing.net Most Napped: 1/1 won · 0 placed · 0 lost (settled 1)
- HorseRacing.net Spotlight: 0/1 won · 0 placed · 1 lost (settled 1)
- OLBG / Kevin Blake DRF public consensus: 0/1 won · 1 placed · 0 lost (settled 1)
- The Independent / Final Furlong public consensus: 1/1 won · 0 placed · 0 lost (settled 1)
- Note: in-day form is a small sample; any future weighting must be capped and decayed. NOT applied here.

## 6. Divergence analysis

- Races where tipster consensus ALIGNED with the model: 0
- Races where tipster consensus DIVERGED from the model: 5
- Races with NO tipster consensus: 2
- Other / not applicable: 0

| Off | Race | Alignment | Winner | Model pick | Tipster consensus |
| --- | --- | --- | --- | --- | --- |
| 13:30 | Queen Anne Stakes (Group 1) | NO_TIPSTER_CONSENSUS | Ten Bob Tony | Docklands | — |
| 14:05 | Coventry Stakes (Group 2) | DIVERGENT | Great Barrier Reef | Confucius | Great Barrier Reef |
| 14:40 | King Charles III Stakes (Group 1) | DIVERGENT | Mission Central | Night Raider | Overpass |
| 15:20 | St James's Palace Stakes (Group 1) (Colts) | DIVERGENT | Bow Echo | Talk Of New York | Bow Echo |
| 16:00 | Ascot Stakes (Heritage Handicap) (GBBPlus Race) | DIVERGENT | Kizlyar | Puturhandstogether | Reaching High |
| 16:35 | Wolferton Stakes (Listed Race) | NO_TIPSTER_CONSENSUS | Map Of Stars | Haatem | — |
| 17:10 | Copper Horse Stakes (Handicap) (GBBPlus Race) | DIVERGENT | Daiquiri Bay | Sing Us A Song | Daiquiri Bay |

## 7. Recommendations (factual)

- No runner was selected by multiple distinct sources in scope (no double-count detected).
- 6 candidate(s) pending review — review with `npm run review:tipster-candidates -- --list-candidates` (no auto-approval).
- Diagnostic only — not betting advice, and no predictive-edge claim is made.
