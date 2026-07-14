# Nationwide dry-run timing evidence — 2026-07-10

**READ ONLY — SELECT-only timing harness.** No `--commit` flag exists anywhere in this
procedure. Nothing was inserted, updated, upserted, or deleted; no model run, lock, or
result was written; no bet was placed.
Generated: 2026-07-14T13:16:57.231Z

> This report measures whether the existing model-scoring step can read + score every
> UK/IRE race nationwide inside one 5-minute watcher cycle, with failures isolated. It is
> evidence for a future gated decision (Phase 7B) — it does NOT enable, schedule, or
> invoke nationwide commit mode.

## Coverage

- Races considered: 49
- Races scored (read + compute, no write): 49
- Runners scored: 468
- Skipped — no priced field: 0
- Failed (isolated): 0

## Timing (sequential, matching the real watcher loop)

- Total: 12795ms
- Min: 224ms · Mean: 261ms · Median: 251ms · p95: 310ms · Max: 545ms
- Slowest race: 1a337e77-c903-48c4-98df-3ad25f71d861
- Watcher cadence: 300000ms
- Margin: 287205ms

## Verdict: PASS

- total sequential read+score time is comfortably inside the watcher cadence with no failures or skips

This report does not enable nationwide commit mode.
