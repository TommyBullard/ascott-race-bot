# Known issues

A log of notable bugs found in Ascott Race Bot, their root cause, impact, fix,
and prevention. **Documentation only** — this file records history; it does not
change behaviour.

> **Responsible use.** Ascott Race Bot is a **research / decision-support** tool.
> It does not predict winners or guarantee profit. These notes are for review and
> prevention only; all betting involves risk.

---

## Post-off stale model runs superseded pre-off race-day decisions

- **Status:** Fixed
- **Date found:** 2026-06-16

### Symptoms

- Dashboard showed **0/4 winners, settled 4, pending 0, 3 no-bet**.
- The final three races had post-race **stale current runs with no
  recommendations**.
- "Model updated" timestamps showed the model had run **after races were already
  OFF / resulted**.

### Root cause

- `pipeline` / `watch` continued running **after** each race's off time.
- `runModelForRace` superseded the race's current run **even for post-off stale
  runs** (a new run always became `is_current` and retired the prior one).
- Performance/accuracy read **`is_current`** runs rather than the latest valid
  **pre-off** runs, so it reported the post-off stale run instead of the
  decision that was live at the off.

### Impact

- **Database history preserved the true pre-off runs** (model history is
  append-only — superseded runs are marked, never deleted).
- The **dashboard / evaluation view was misleading**: it showed 4 settled + 3
  no-bet instead of the true 7-race pre-off record (0/7).
- **No result data was lost**, and no model maths, staking, or ranking was
  affected.

### Fix

- **Pre-off / as-of-off-time evaluation** — performance selects each race's latest
  model run with `run_time <= off_time` (default for `/api/accuracy`).
- **Post-off / resulted model guard** — the producer skips a race once it has gone
  off (`now > off_time`) or is `status = result`; an explicitly-allowed post-off
  run is written **non-current** (diagnostic only) and never supersedes the
  pre-off run.
- **Tests preventing recurrence** — regression tests lock the 2026-06-16 scenario
  (a pre-off recommendation survives a later post-off no-bet run; the old
  current-pointer read reproduces the buggy 0/4 + 3 no-bet and is asserted to
  differ from the as-of-off-time 0/7), plus guard unit tests.

### Prevention

- **Stop watch mode after racing** (or rely on the off-time guard) — don't run
  `pipeline:day` / `pipeline:watch` after races have gone off unless explicitly
  doing diagnostics.
- **Never evaluate historical performance from `is_current` alone** — a post-off
  rerun can be the current row.
- **Use `run_time <= off_time`** for official pre-race evaluation (the latest such
  run is the race-day decision record).

### References

- [HANDOVER_ASCOT_DAY_1_FIXES.md](HANDOVER_ASCOT_DAY_1_FIXES.md) — handover summary.
- [API.md](API.md) — `/api/accuracy` response shape + pre-off counting rules.
- [RACE_DAY_RUNBOOK.md](RACE_DAY_RUNBOOK.md) §7 — race-lock / off-time safety.
- [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) — post-off guard + evaluation overview.
- [../ascot-day-1/end-of-day-analysis.md](../ascot-day-1/end-of-day-analysis.md) — day write-up.

> Decision-support only. This fix corrects the **record shown**, not any betting
> outcome, and is not betting advice.
