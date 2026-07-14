# Nationwide dry-run timing evidence — 2026-07-09

**READ ONLY — SELECT-only timing harness.** No `--commit` flag exists anywhere in this
procedure. Nothing was inserted, updated, upserted, or deleted; no model run, lock, or
result was written; no bet was placed.
Generated: 2026-07-14T13:15:58.663Z

> This report measures whether the existing model-scoring step can read + score every
> UK/IRE race nationwide inside one 5-minute watcher cycle, with failures isolated. It is
> evidence for a future gated decision (Phase 7B) — it does NOT enable, schedule, or
> invoke nationwide commit mode.

## Coverage

- Races considered: 40
- Races scored (read + compute, no write): 34
- Runners scored: 302
- Skipped — no priced field: 6
- Failed (isolated): 0

## Timing (sequential, matching the real watcher loop)

- Total: 10726ms
- Min: 246ms · Mean: 315ms · Median: 275ms · p95: 505ms · Max: 880ms
- Slowest race: 8ec17fb7-d252-46fc-83bb-537563747004
- Watcher cadence: 300000ms
- Margin: 289274ms

## Verdict: REVIEW

- 6 race(s) had no priced field to score (odds/racecard gap) — review coverage

This report does not enable nationwide commit mode.
