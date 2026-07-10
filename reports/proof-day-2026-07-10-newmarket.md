# Race-Day Update Proof — Newmarket 2026-07-10

Durable, read-only proof of WHEN each stage last refreshed. Decision-support / audit only.

## Summary
- Races found: 7
- Runners found: 65
- Settled races: 7 / 7
- Latest odds snapshot: 2026-07-10T16:24:14.717+00:00 (stale)
- Latest model run: 2026-07-10T16:19:09.972+00:00
- Recommendations: 6
- Audit tables: cron_runs present, ml_training_examples present, genai_commentary present

## 1. Racecard load proof
- Races found: 7
- Runners found: 65
- Latest racecard sync: 2026-07-10T21:56:32.016+00:00 (last ok)

## 2. Odds proof
- Latest market snapshot: 2026-07-10T16:24:14.717+00:00
- Quotes written (last odds run): 0
- Status: stale (age 5h)

## 3. Model proof
- Latest model run: 2026-07-10T16:19:09.972+00:00
- Recommendation count: 6
- Model runs per race:
  - 12:50 Oddschecker Handicap (Heritage Handicap) (GBBPlus Race): 36 run(s), 0 rec
  - 13:25 Duchess Of Cambridge Stakes (Sponsored By Ultimate Provence) (Fillies' Group 2): 43 run(s), 1 rec
  - 14:00 Betway Trophy (Heritage Handicap) (GBBPlus Race): 50 run(s), 1 rec
  - 14:35 Tattersalls Sceptre Sessions Falmouth Stakes (Fillies' & Mares' Group 1): 56 run(s), 1 rec
  - 15:10 Weatherbys Banking Group British EBF Maiden Fillies' Stakes (GBB Race): 63 run(s), 1 rec
  - 15:45 Debenhams Handicap: 70 run(s), 1 rec
  - 16:20 Jockey Club Estates Handicap: 77 run(s), 1 rec

## 4. Pre-off proof
- 12:50 Oddschecker Handicap (Heritage Handicap) (GBBPlus Race): capture available, pre-off run 2026-07-10T12:45:24.844+00:00, post-off runs ignored 0
- 13:25 Duchess Of Cambridge Stakes (Sponsored By Ultimate Provence) (Fillies' Group 2): capture available, pre-off run 2026-07-10T13:22:08.003+00:00, post-off runs ignored 0
- 14:00 Betway Trophy (Heritage Handicap) (GBBPlus Race): capture available, pre-off run 2026-07-10T13:58:44.534+00:00, post-off runs ignored 0
- 14:35 Tattersalls Sceptre Sessions Falmouth Stakes (Fillies' & Mares' Group 1): capture available, pre-off run 2026-07-10T14:30:03.865+00:00, post-off runs ignored 0
- 15:10 Weatherbys Banking Group British EBF Maiden Fillies' Stakes (GBB Race): capture available, pre-off run 2026-07-10T15:06:31.726+00:00, post-off runs ignored 0
- 15:45 Debenhams Handicap: capture available, pre-off run 2026-07-10T15:42:57.835+00:00, post-off runs ignored 0
- 16:20 Jockey Club Estates Handicap: capture available, pre-off run 2026-07-10T16:19:09.972+00:00, post-off runs ignored 0

## 5. Results proof
- 12:50 Oddschecker Handicap (Heritage Handicap) (GBBPlus Race): status result, finish_pos available, winner Heraldry, source stored finish positions, settlement settled
- 13:25 Duchess Of Cambridge Stakes (Sponsored By Ultimate Provence) (Fillies' Group 2): status result, finish_pos available, winner Senorita Bonita, source stored finish positions, settlement settled
- 14:00 Betway Trophy (Heritage Handicap) (GBBPlus Race): status result, finish_pos available, winner Valedictory, source stored finish positions, settlement settled
- 14:35 Tattersalls Sceptre Sessions Falmouth Stakes (Fillies' & Mares' Group 1): status result, finish_pos available, winner Blue Bolt, source stored finish positions, settlement settled
- 15:10 Weatherbys Banking Group British EBF Maiden Fillies' Stakes (GBB Race): status result, finish_pos available, winner Acting Lady, source stored finish positions, settlement settled
- 15:45 Debenhams Handicap: status result, finish_pos available, winner Twilight Calls, source stored finish positions, settlement settled
- 16:20 Jockey Club Estates Handicap: status result, finish_pos available, winner Sierra Sands, source stored finish positions, settlement settled
- Note: the Standard /v1/results endpoint may be plan-blocked; same-day settlement uses results:auto (Basic/Free) and the manual CSV importer is the audited fallback.

## 6. Training capture proof
- ml_training_examples rows (this meeting): 0

## 7. GenAI proof
- Commentary file: reports/genai-commentary-2026-07-10-newmarket.md (not generated)
- Stored commentary rows: 0
- Source notes: prepared + licence-reviewed via genai:prepare-notes (reviewed evidence only).
- Shadow-only: yes — never model-active, never a prediction, never betting advice.

## 8. Operator actions
- Recommended next (read-only / review-gated):
  - `npm run dashboard:ready -- --date 2026-07-10 --course Newmarket`
  - `npm run report:day -- --date 2026-07-10 --course Newmarket`
  - `npm run genai:commentary -- --date 2026-07-10 --course Newmarket --notes <notes.json> --output reports/genai-commentary-2026-07-10-newmarket.md`

## 9. Safety
- No auto-betting and no bet placement.
- No UI writes — this proof reads stored state only and writes a single local report file.
- No guarantee — this proves WHEN data refreshed, not that any selection will win.
- No model, recommendation, ranking, or staking logic is changed.

---
Read-only audit. No model/recommendation/staking change, no auto-betting, no UI writes, no guarantee.
