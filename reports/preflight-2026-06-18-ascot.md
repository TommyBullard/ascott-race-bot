# Race-day preflight pack (decision-support only)

Date: 2026-06-18  ·  Course: Ascot  
Read-only checklist — nothing here is executed; the DB-writing commands are backend / manual-approval only.

## 1. Environment / check commands
- Verify environment variables are present (names only):
  `npm run check:env`
- Verify database schema / connectivity (read-only probes):
  `npm run check:db`

## 2. Dashboard
- View the read-only race-day dashboard:
  http://localhost:3000/?date=2026-06-18&course=Ascot
- The /api/race-day/status polling endpoint is read-only (GET only — no database writes, no commit, no betting).

## 3. Required operating commands
- Pipeline refresh — racecards + odds + model (WRITES DB — backend / manual approval only): **[MANUAL / BACKEND APPROVAL — WRITES DB]**
  `npm run pipeline:day -- --date 2026-06-18 --course Ascot --commit`
- T-5 pre-off capture (read-only snapshot report):
  `npm run capture:t-minus -- --date 2026-06-18 --course Ascot --minutes-before 5`
- Results automation — dry-run first (audits only; never settles):
  `npm run results:auto -- --date 2026-06-18 --course Ascot`
- Results automation — settle audited settle-ready races (BACKEND / MANUAL ONLY — never from the UI): **[MANUAL / BACKEND APPROVAL — WRITES DB]**
  `npm run results:auto -- --date 2026-06-18 --course Ascot --commit`

## 4. End-of-day commands
- End-of-day report:
  `npm run report:day -- --date 2026-06-18 --course Ascot`
- Training-data export (local CSV only):
  `npm run export:training-data -- --from 2026-06-18 --to 2026-06-18 --course Ascot`
- Tipster audit:
  `npm run tipsters:audit -- --date 2026-06-18 --course Ascot`
- Confidence audit:
  `npm run confidence:audit -- --date 2026-06-18 --course Ascot`
- No-bet gate research audit:
  `npm run gates:audit -- --date 2026-06-18 --course Ascot`
- Place / each-way research audit:
  `npm run place:audit -- --date 2026-06-18 --course Ascot --places 4`
- Day lessons report:
  `npm run lessons:day -- --date 2026-06-18 --course Ascot`
- ML shadow evaluation (run AFTER the training-data export; only if data/exports/training-data-2026-06-18-to-2026-06-18-ascot.csv exists):
  `npm run ml:evaluate -- --input data/exports/training-data-2026-06-18-to-2026-06-18-ascot.csv`

## 5. Safety checklist
- [ ] No auto-betting is enabled (there is none) — decision-support only.
- [ ] No bet placement and no orders of any kind.
- [ ] No model probability / staking / ranking / tipster-weighting math changes during the race day.
- [ ] No code changes inside the final 10 minutes before any off.
- [ ] Always run results:auto as a dry-run BEFORE any approved backend result commit.

## 6. Data freshness checklist
- [ ] Odds updated — the dashboard "odds updated X ago" indicator is fresh.
- [ ] Model updated — the dashboard "model updated X ago" indicator is fresh.
- [ ] T-minus capture available — a capture:t-minus snapshot has been taken pre-off.
- [ ] Result status — each race shows its settlement status once officially resulted.

## 7. Known caveats
- The free Racing API result endpoint can lag — official finishing positions may appear later than the off time.
- The free endpoint provides finishing positions but NOT SP/BSP.
- Manual SP/BSP enrichment is optional (import a BSP CSV later if needed); prices are never fabricated.

## 8. Operator reminders
- Use the per-day performance block as the source of truth for settled count, winners/losers, P/L and ROI.
- The top-level legacy accuracy figure may differ (it is a lifetime/global scope) — prefer the scoped performance block.
