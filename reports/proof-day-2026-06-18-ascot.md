# Race-Day Update Proof — Ascot 2026-06-18

Durable, read-only proof of WHEN each stage last refreshed. Decision-support / audit only.

## Summary
- Races found: 7
- Runners found: 127
- Settled races: 7 / 7
- Latest odds snapshot: 2026-06-18T15:08:36.144+00:00 (stale)
- Latest model run: 2026-06-18T15:08:49.248+00:00
- Recommendations: 6
- Audit tables: cron_runs present, ml_training_examples present, genai_commentary present

## 1. Racecard load proof
- Races found: 7
- Runners found: 127
- Latest racecard sync: 2026-06-19T00:58:09.951+00:00 (last ok)

## 2. Odds proof
- Latest market snapshot: 2026-06-18T15:08:36.144+00:00
- Quotes written (last odds run): 539
- Status: stale (age 11h)

## 3. Model proof
- Latest model run: 2026-06-18T15:08:49.248+00:00
- Recommendation count: 6
- Model runs per race:
  - 13:30 Chesham Stakes (Listed Race): 2 run(s), 1 rec
  - 14:05 King George V Stakes (Heritage Handicap) (GBBPlus Race): 4 run(s), 1 rec
  - 14:40 Ribblesdale Stakes (Group 2) (Fillies): 5 run(s), 1 rec
  - 15:15 Gold Cup (Group 1): 6 run(s), 0 rec
  - 15:50 Britannia Stakes (Heritage Handicap) (Colts & Geldings): 6 run(s), 1 rec
  - 16:35 Hampton Court Stakes (Group 3): 6 run(s), 1 rec
  - 17:10 Buckingham Palace Stakes (Handicap): 6 run(s), 1 rec

## 4. Pre-off proof
- 13:30 Chesham Stakes (Listed Race): capture available, pre-off run 2026-06-18T13:17:10.194+00:00, post-off runs ignored 0
- 14:05 King George V Stakes (Heritage Handicap) (GBBPlus Race): capture available, pre-off run 2026-06-18T14:00:58.325+00:00, post-off runs ignored 0
- 14:40 Ribblesdale Stakes (Group 2) (Fillies): capture available, pre-off run 2026-06-18T14:35:11.226+00:00, post-off runs ignored 0
- 15:15 Gold Cup (Group 1): capture available, pre-off run 2026-06-18T15:08:45.824+00:00, post-off runs ignored 0
- 15:50 Britannia Stakes (Heritage Handicap) (Colts & Geldings): capture available, pre-off run 2026-06-18T15:08:46.802+00:00, post-off runs ignored 0
- 16:35 Hampton Court Stakes (Group 3): capture available, pre-off run 2026-06-18T15:08:47.852+00:00, post-off runs ignored 0
- 17:10 Buckingham Palace Stakes (Handicap): capture available, pre-off run 2026-06-18T15:08:49.248+00:00, post-off runs ignored 0

## 5. Results proof
- 13:30 Chesham Stakes (Listed Race): status result, finish_pos available, winner Nola Soul, source stored finish positions, settlement settled
- 14:05 King George V Stakes (Heritage Handicap) (GBBPlus Race): status result, finish_pos available, winner Enceladus, source stored finish positions, settlement settled
- 14:40 Ribblesdale Stakes (Group 2) (Fillies): status result, finish_pos available, winner Earth Shot, source stored finish positions, settlement settled
- 15:15 Gold Cup (Group 1): status result, finish_pos available, winner Scandinavia, source stored finish positions, settlement settled
- 15:50 Britannia Stakes (Heritage Handicap) (Colts & Geldings): status result, finish_pos available, winner Moonfall, source stored finish positions, settlement settled
- 16:35 Hampton Court Stakes (Group 3): status result, finish_pos available, winner Generic, source stored finish positions, settlement settled
- 17:10 Buckingham Palace Stakes (Handicap): status result, finish_pos available, winner Mezcala, source stored finish positions, settlement settled
- Note: the Standard /v1/results endpoint may be plan-blocked; same-day settlement uses results:auto (Basic/Free) and the manual CSV importer is the audited fallback.

## 6. Training capture proof
- ml_training_examples rows (this meeting): 0

## 7. GenAI proof
- Commentary file: reports/genai-commentary-2026-06-18-ascot.md (present)
- Stored commentary rows: 0
- Source notes: prepared + licence-reviewed via genai:prepare-notes (reviewed evidence only).
- Shadow-only: yes — never model-active, never a prediction, never betting advice.

## 8. Operator actions
- Recommended next (read-only / review-gated):
  - `npm run dashboard:ready -- --date 2026-06-18 --course Ascot`
  - `npm run report:day -- --date 2026-06-18 --course Ascot`

## 9. Safety
- No auto-betting and no bet placement.
- No UI writes — this proof reads stored state only and writes a single local report file.
- No guarantee — this proves WHEN data refreshed, not that any selection will win.
- No model, recommendation, ranking, or staking logic is changed.

---
Read-only audit. No model/recommendation/staking change, no auto-betting, no UI writes, no guarantee.
