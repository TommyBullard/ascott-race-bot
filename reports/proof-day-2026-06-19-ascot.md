# Race-Day Update Proof — Ascot 2026-06-19

Durable, read-only proof of WHEN each stage last refreshed. Decision-support / audit only.

## Summary
- Races found: 7
- Runners found: 139
- Settled races: 0 / 7
- Latest odds snapshot: 2026-06-19T00:58:10.023+00:00 (stale)
- Latest model run: 2026-06-19T00:58:18.542+00:00
- Recommendations: 4
- Audit tables: cron_runs present, ml_training_examples present, genai_commentary present

## 1. Racecard load proof
- Races found: 7
- Runners found: 139
- Latest racecard sync: 2026-06-19T00:58:09.951+00:00 (last ok)

## 2. Odds proof
- Latest market snapshot: 2026-06-19T00:58:10.023+00:00
- Quotes written (last odds run): 539
- Status: stale (age 3h)

## 3. Model proof
- Latest model run: 2026-06-19T00:58:18.542+00:00
- Recommendation count: 4
- Model runs per race:
  - 13:30 Albany Stakes (Group 3) (Fillies): 2 run(s), 0 rec
  - 14:05 Commonwealth Cup (Group 1) (No Geldings): 2 run(s), 1 rec
  - 14:40 Duke Of Edinburgh Stakes (Handicap) (GBBPlus Race): 2 run(s), 0 rec
  - 15:20 Coronation Stakes (Group 1) (Fillies): 2 run(s), 1 rec
  - 16:00 Sandringham Stakes (Handicap) (Fillies): 2 run(s), 1 rec
  - 16:35 King Edward VII Stakes (Group 2) (Colts & Geldings): 2 run(s), 0 rec
  - 17:10 Palace Of Holyroodhouse (Handicap): 2 run(s), 1 rec

## 4. Pre-off proof
- 13:30 Albany Stakes (Group 3) (Fillies): capture available, pre-off run 2026-06-19T00:58:15.595+00:00, post-off runs ignored 0
- 14:05 Commonwealth Cup (Group 1) (No Geldings): capture available, pre-off run 2026-06-19T00:58:16.082+00:00, post-off runs ignored 0
- 14:40 Duke Of Edinburgh Stakes (Handicap) (GBBPlus Race): capture available, pre-off run 2026-06-19T00:58:16.598+00:00, post-off runs ignored 0
- 15:20 Coronation Stakes (Group 1) (Fillies): capture available, pre-off run 2026-06-19T00:58:17.066+00:00, post-off runs ignored 0
- 16:00 Sandringham Stakes (Handicap) (Fillies): capture available, pre-off run 2026-06-19T00:58:17.573+00:00, post-off runs ignored 0
- 16:35 King Edward VII Stakes (Group 2) (Colts & Geldings): capture available, pre-off run 2026-06-19T00:58:18.094+00:00, post-off runs ignored 0
- 17:10 Palace Of Holyroodhouse (Handicap): capture available, pre-off run 2026-06-19T00:58:18.542+00:00, post-off runs ignored 0

## 5. Results proof
- 13:30 Albany Stakes (Group 3) (Fillies): status scheduled, finish_pos none, winner —, source —, settlement upcoming
- 14:05 Commonwealth Cup (Group 1) (No Geldings): status scheduled, finish_pos none, winner —, source —, settlement upcoming
- 14:40 Duke Of Edinburgh Stakes (Handicap) (GBBPlus Race): status scheduled, finish_pos none, winner —, source —, settlement upcoming
- 15:20 Coronation Stakes (Group 1) (Fillies): status scheduled, finish_pos none, winner —, source —, settlement upcoming
- 16:00 Sandringham Stakes (Handicap) (Fillies): status scheduled, finish_pos none, winner —, source —, settlement upcoming
- 16:35 King Edward VII Stakes (Group 2) (Colts & Geldings): status scheduled, finish_pos none, winner —, source —, settlement upcoming
- 17:10 Palace Of Holyroodhouse (Handicap): status scheduled, finish_pos none, winner —, source —, settlement upcoming
- Note: the Standard /v1/results endpoint may be plan-blocked; same-day settlement uses results:auto (Basic/Free) and the manual CSV importer is the audited fallback.

## 6. Training capture proof
- ml_training_examples rows (this meeting): 0

## 7. GenAI proof
- Commentary file: reports/genai-commentary-2026-06-19-ascot.md (not generated)
- Stored commentary rows: 0
- Source notes: prepared + licence-reviewed via genai:prepare-notes (reviewed evidence only).
- Shadow-only: yes — never model-active, never a prediction, never betting advice.

## 8. Operator actions
- Recommended next (read-only / review-gated):
  - `npm run dashboard:ready -- --date 2026-06-19 --course Ascot`
  - `npm run results:auto -- --date 2026-06-19 --course Ascot   # dry-run audit (read-only)`
  - `npm run genai:commentary -- --date 2026-06-19 --course Ascot --notes <notes.json> --output reports/genai-commentary-2026-06-19-ascot.md`

## 9. Safety
- No auto-betting and no bet placement.
- No UI writes — this proof reads stored state only and writes a single local report file.
- No guarantee — this proves WHEN data refreshed, not that any selection will win.
- No model, recommendation, ranking, or staking logic is changed.

---
Read-only audit. No model/recommendation/staking change, no auto-betting, no UI writes, no guarantee.
