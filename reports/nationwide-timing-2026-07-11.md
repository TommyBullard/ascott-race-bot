# Nationwide dry-run timing evidence — 2026-07-11

**READ ONLY — SELECT-only timing harness.** No `--commit` flag exists anywhere in this
procedure. Nothing was inserted, updated, upserted, or deleted; no model run, lock, or
result was written; no bet was placed.
Generated: 2026-07-14T13:17:28.410Z

> This report measures whether the existing model-scoring step can read + score every
> UK/IRE race nationwide inside one 5-minute watcher cycle, with failures isolated. It is
> evidence for a future gated decision (Phase 7B) — it does NOT enable, schedule, or
> invoke nationwide commit mode.

## Coverage

- Races considered: 57
- Races scored (read + compute, no write): 57
- Runners scored: 540
- Skipped — no priced field: 0
- Failed (isolated): 0

## Timing (sequential, matching the real watcher loop)

- Total: 15773ms
- Min: 223ms · Mean: 277ms · Median: 249ms · p95: 377ms · Max: 517ms
- Slowest race: 05da81ba-fc41-41cc-9683-02175f379309
- Watcher cadence: 300000ms
- Margin: 284227ms

## Verdict: PASS

- total sequential read+score time is comfortably inside the watcher cadence with no failures or skips

This report does not enable nationwide commit mode.
