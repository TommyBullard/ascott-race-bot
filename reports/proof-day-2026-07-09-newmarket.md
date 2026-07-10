# Race-Day Update Proof — Newmarket 2026-07-09

Durable, read-only proof of WHEN each stage last refreshed. Decision-support / audit only.

## Summary
- Races found: 7
- Runners found: 60
- Settled races: 7 / 7
- Latest odds snapshot: 2026-07-09T16:20:47.651+00:00 (stale)
- Latest model run: 2026-07-09T16:15:41.667+00:00
- Recommendations: 4
- Audit tables: cron_runs present, ml_training_examples present, genai_commentary present

## 1. Racecard load proof
- Races found: 7
- Runners found: 60
- Latest racecard sync: 2026-07-09T16:20:47.511+00:00 (last ok)

## 2. Odds proof
- Latest market snapshot: 2026-07-09T16:20:47.651+00:00
- Quotes written (last odds run): 0
- Status: stale (age 17h)

## 3. Model proof
- Latest model run: 2026-07-09T16:15:41.667+00:00
- Recommendation count: 4
- Model runs per race:
  - 12:50 Bahrain Trophy Stakes (Group 3): 17 run(s), 0 rec
  - 13:25 Kingdom Of Bahrain July Stakes (Group 2): 24 run(s), 0 rec
  - 14:00 Betway Handicap (Heritage Handicap): 36 run(s), 1 rec
  - 14:35 Princess Of Wales's Stakes (Sponsored By The Kingdom Of Bahrain) (Group 2): 46 run(s), 1 rec
  - 15:10 British Stallion Studs EBF Maiden Fillies' Stakes (GBB Race): 46 run(s), 1 rec
  - 15:45 Edmondson Hall Solicitors Sir Henry Cecil Stakes (Listed): 48 run(s), 0 rec
  - 16:20 Debenhams Handicap: 58 run(s), 1 rec

## 4. Pre-off proof
- 12:50 Bahrain Trophy Stakes (Group 3): capture available, pre-off run 2026-07-09T12:47:56.881+00:00, post-off runs ignored 0
- 13:25 Kingdom Of Bahrain July Stakes (Group 2): capture available, pre-off run 2026-07-09T13:22:11.841+00:00, post-off runs ignored 0
- 14:00 Betway Handicap (Heritage Handicap): capture available, pre-off run 2026-07-09T13:59:13.591+00:00, post-off runs ignored 0
- 14:35 Princess Of Wales's Stakes (Sponsored By The Kingdom Of Bahrain) (Group 2): capture available, pre-off run 2026-07-09T14:25:27.172+00:00, post-off runs ignored 0
- 15:10 British Stallion Studs EBF Maiden Fillies' Stakes (GBB Race): capture available, pre-off run 2026-07-09T14:25:28.145+00:00, post-off runs ignored 0
- 15:45 Edmondson Hall Solicitors Sir Henry Cecil Stakes (Listed): capture available, pre-off run 2026-07-09T15:44:30.415+00:00, post-off runs ignored 0
- 16:20 Debenhams Handicap: capture available, pre-off run 2026-07-09T16:15:41.667+00:00, post-off runs ignored 0

## 5. Results proof
- 12:50 Bahrain Trophy Stakes (Group 3): status result, finish_pos available, winner Point Of Law, source stored finish positions, settlement settled
- 13:25 Kingdom Of Bahrain July Stakes (Group 2): status result, finish_pos available, winner Inner City Blues, source stored finish positions, settlement settled
- 14:00 Betway Handicap (Heritage Handicap): status result, finish_pos available, winner Jazl, source stored finish positions, settlement settled
- 14:35 Princess Of Wales's Stakes (Sponsored By The Kingdom Of Bahrain) (Group 2): status result, finish_pos available, winner Rebel's Romance, source stored finish positions, settlement settled
- 15:10 British Stallion Studs EBF Maiden Fillies' Stakes (GBB Race): status result, finish_pos available, winner Scommessa Sicura, source stored finish positions, settlement settled
- 15:45 Edmondson Hall Solicitors Sir Henry Cecil Stakes (Listed): status result, finish_pos available, winner Shayem, source stored finish positions, settlement settled
- 16:20 Debenhams Handicap: status result, finish_pos available, winner Asmen Warrior, source stored finish positions, settlement settled
- Note: the Standard /v1/results endpoint may be plan-blocked; same-day settlement uses results:auto (Basic/Free) and the manual CSV importer is the audited fallback.

## 6. Training capture proof
- ml_training_examples rows (this meeting): 0

## 7. GenAI proof
- Commentary file: reports/genai-commentary-2026-07-09-newmarket.md (not generated)
- Stored commentary rows: 0
- Source notes: prepared + licence-reviewed via genai:prepare-notes (reviewed evidence only).
- Shadow-only: yes — never model-active, never a prediction, never betting advice.

## 8. Operator actions
- Recommended next (read-only / review-gated):
  - `npm run dashboard:ready -- --date 2026-07-09 --course Newmarket`
  - `npm run report:day -- --date 2026-07-09 --course Newmarket`
  - `npm run genai:commentary -- --date 2026-07-09 --course Newmarket --notes <notes.json> --output reports/genai-commentary-2026-07-09-newmarket.md`

## 9. Safety
- No auto-betting and no bet placement.
- No UI writes — this proof reads stored state only and writes a single local report file.
- No guarantee — this proves WHEN data refreshed, not that any selection will win.
- No model, recommendation, ranking, or staking logic is changed.

---
Read-only audit. No model/recommendation/staking change, no auto-betting, no UI writes, no guarantee.
