# Live race-day operating plan (decision-support only)

Date: 2026-06-16  ·  Course: Ascot  
Mode: plan-only (nothing is executed; no database writes)  
All times UTC.

> Decision-support only. This phase PLANS a race day; it executes nothing,
> writes no database, places no bets, and runs no pipeline / model / odds /
> racecards command. The one DB-writing command below (pipeline:day --commit)
> is documented for MANUAL approval only and is never run here.

## 1. Preflight

- Verify environment variables are present (names only):
  `npm run check:env`
- Verify database schema / connectivity (read-only probes):
  `npm run check:db`
- Results automation dry-run / fallback check:
  `npm run results:auto -- --date 2026-06-16 --course Ascot`

## 2. Race discovery

- Races found for 2026-06-16 / Ascot: 7
- 13:30 UTC — Queen Anne Stakes (Group 1)
- 14:05 UTC — Coventry Stakes (Group 2)
- 14:40 UTC — King Charles III Stakes (Group 1)
- 15:20 UTC — St James's Palace Stakes (Group 1) (Colts)
- 16:00 UTC — Ascot Stakes (Heritage Handicap) (GBBPlus Race)
- 16:35 UTC — Wolferton Stakes (Listed Race)
- 17:10 UTC — Copper Horse Stakes (Handicap) (GBBPlus Race)

## 3. Per-race schedule (UTC)

| Race | T-10 refresh | T-5 capture | Off | Post-off lock | Result check |
| --- | --- | --- | --- | --- | --- |
| Queen Anne Stakes (Group 1) | 13:20 | 13:25 | 13:30 | 13:30+ | 14:00 |
| Coventry Stakes (Group 2) | 13:55 | 14:00 | 14:05 | 14:05+ | 14:35 |
| King Charles III Stakes (Group 1) | 14:30 | 14:35 | 14:40 | 14:40+ | 15:10 |
| St James's Palace Stakes (Group 1) (Colts) | 15:10 | 15:15 | 15:20 | 15:20+ | 15:50 |
| Ascot Stakes (Heritage Handicap) (GBBPlus Race) | 15:50 | 15:55 | 16:00 | 16:00+ | 16:30 |
| Wolferton Stakes (Listed Race) | 16:25 | 16:30 | 16:35 | 16:35+ | 17:05 |
| Copper Horse Stakes (Handicap) (GBBPlus Race) | 17:00 | 17:05 | 17:10 | 17:10+ | 17:40 |

_T-10 refresh = off — 10m; T-5 capture = off — 5m; post-off lock from the off time onward (no further pre-off actions); result check ~30m after off (official only)._

## 4. Commands to run manually / via future controlled automation

- Run the model + persist recommendations (WRITES DB — manual approval only): **[MANUAL APPROVAL — WRITES DB]**
  `npm run pipeline:day -- --date 2026-06-16 --course Ascot --commit`
- T-5 pre-off capture (read-only report):
  `npm run capture:t-minus -- --date 2026-06-16 --course Ascot --minutes-before 5`
- Results automation (dry-run / fallback; never settles):
  `npm run results:auto -- --date 2026-06-16 --course Ascot`
- Manual results fallback (dry-run without `--commit`):
  `npm run import:results -- --file data/results-2026-06-16-ascot.csv`
- After racing: see §6 (end-of-day report / export / audits).

## 5. Dangerous commands (NOT run by this phase)

- This phase NEVER runs pipeline / model / odds / racecards / write commands. It only prints this plan.
- `pipeline:day … --commit` writes model runs and recommendations to the database — run it manually only after review.
- `import:results --commit` mutates result rows — requires manual approval; without `--commit` the importer is a dry-run.
- No auto-betting and no bet placement under any flag in this phase.

## 6. End of day

- End-of-day report:
  `npm run report:day -- --date 2026-06-16 --course Ascot`
- Training-data export (local CSV only):
  `npm run export:training-data -- --from 2026-06-16 --to 2026-06-16 --course Ascot`
- Tipster audit:
  `npm run tipsters:audit -- --date 2026-06-16 --course Ascot`
- Confidence audit:
  `npm run confidence:audit -- --date 2026-06-16 --course Ascot`
- No-bet gate research audit:
  `npm run gates:audit -- --date 2026-06-16 --course Ascot`
- ML shadow evaluation (only if data/exports/training-data-2026-06-16-to-2026-06-16-ascot.csv exists):
  `npm run ml:evaluate -- --input data/exports/training-data-2026-06-16-to-2026-06-16-ascot.csv`

## 7. Future modes (documented, NOT active in this phase)

- `--operate` — would execute the scheduled operations automatically. NOT implemented in this phase.
- `--allow-writes` — would permit DB-writing commands (e.g. pipeline:day --commit). NOT implemented in this phase.
- `--auto-results` — would auto-run results:auto / import on a schedule. NOT implemented in this phase.

## 8. Safety disclaimer

- Decision-support only; not betting advice and no guarantees.
- No auto-betting and no bet placement.
- Official, weighed-in results only — never settle on provisional data.
- No changes to model probability, staking, ranking, or tipster weighting.
- Plan-only: no database writes and no commands are executed by this phase.
