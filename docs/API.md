# API reference — performance & accuracy

Reference for **API consumers and future agents** of the read-only
`GET /api/accuracy` endpoint, focused on the **pre-off / as-of-off-time**
performance semantics introduced after the 2026-06-16 incident.

For the full route list see [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) §8. This
document does not change runtime behaviour; it describes the existing response.

> **Responsible use.** Ascott Race Bot is a **research / decision-support** tool.
> Nothing here predicts winners or guarantees profit. These figures are a record
> for review and calibration only; all betting involves risk.

---

## `GET /api/accuracy`

Public, read-only. Computed live on every request (no cache), so it always
reflects the latest stored runs and settled results.

### Query parameters

| Param | Applies to | Meaning |
| --- | --- | --- |
| `date` | `performance` | Meeting day `YYYY-MM-DD` (UTC). Defaults to today (UTC). |
| `day` | `performance` | `today` / `tomorrow` alternative to `date`. |
| `course` | `performance` | Course filter, normalised ("Ascot" matches "Royal Ascot"). |

The lifetime `accuracy` object is **global** and ignores these parameters.

### Response `200`

```jsonc
{
  "accuracy": {            // lifetime, global (ignores date/course)
    "racesSettled": 0,
    "winners": 0,
    "strikeRatePct": 0,
    "profitPoints": 0,
    "roiPct": 0,
    "computedAt": "2026-06-16T20:00:00.000Z"
  },
  "performance": {         // per-day (date + optional course)
    "recommendations_total": 7,
    "settled_count": 7,
    "pending_count": 0,
    "winners": 0,
    "losers": 7,
    "strike_rate": 0,
    "profit_loss": -7,
    "roi": -100,
    "average_ev": 0.14,
    "total_staked": 7,
    "no_bet_races": 0,
    "date": "2026-06-16",
    "course": "Ascot",
    "computedAt": "2026-06-16T20:00:00.000Z",
    "evaluationMode": "pre_off"
  }
}
```

On unexpected failure: `500 { "error": "Failed to compute model accuracy" }`
(details are logged server-side, never exposed). No secrets are ever returned.

> Field names are the source of truth as returned; treat any field not listed
> here as out of contract.

---

## Pre-off (as-of-off-time) evaluation

### 1. Default behaviour

The `performance` object is evaluated **as-of off time by default**
(`evaluationMode: "pre_off"`). For each in-scope race it selects that race's
**latest model run produced at or before the scheduled off time**, then scores
that run. Post-off reruns are ignored for the official per-day record.

### 2. Definition of "pre-off"

A run is pre-off for a race when:

```
model_runs.run_time <= races.off_time
```

Among a race's pre-off runs, the one with the **greatest `run_time`** is the
decision record (the "final pre-off run"). `off_time` is a UTC timestamp.

### 3. Why `is_current` alone is insufficient for historical performance

Model history is **append-only**: each run inserts as `is_current = true` and
supersedes the prior current run (rows are marked, never deleted). If the
pipeline keeps running **after** a race goes off, a post-off rerun on stale odds
becomes `is_current` and supersedes the genuine pre-off run. Reading `is_current`
then reports the **post-off** run — not the decision that was live at the off.
For a historical/decision record you must select by `run_time <= off_time`, not
by `is_current`. (Live, pre-off, the two agree; the divergence only appears once
a race has gone off and been re-run.)

### 4. How `no_bet_races` is counted

A race counts as **no-bet** when its **latest pre-off run exists but has no
rank-1 recommendation** (the model ran but selected nothing worth staking as of
the off). A race with no pre-off run at all is out of scope (neither counted nor
no-bet).

### 5. How `pending_count` is counted

A race is **pending** when a **pre-off rank-1 recommendation exists but the race
has no official result yet** (no recorded winner). Pending races are **never**
counted as winners or losers.

### 6. How `settled_count` is counted

A race is **settled** when a **pre-off rank-1 recommendation exists and the race
has an official result** (a recorded winner). `winners` is the subset whose
pre-off pick won; `losers` is the remainder. `strike_rate = winners /
settled_count * 100`.

### 7. Post-off / diagnostic / stale runs are ignored

Runs produced after `off_time` (including explicitly-allowed diagnostic runs,
which are written non-current) are **excluded** from the official `performance`
evaluation. They remain in append-only history for audit but never form the
per-day decision record.

> A `current` evaluation mode (read the latest `is_current` run) still exists for
> internal callers that explicitly want the live-pointer view; `/api/accuracy`
> does **not** use it. When present, the response's `evaluationMode` field states
> which rule produced the figures (`pre_off` by default).

---

## 8. Worked example — Royal Ascot Day 1 (2026-06-16)

The pipeline kept running after races went off. For the final three races the
post-off reruns scored on stale odds and produced **no bet**, and those no-bet
runs became `is_current`, superseding the valid pre-off recommendations.

- **Current-pointer view (the bug):** reading `is_current` showed
  **0/4 winners, settled 4, pending 0, 3 no-bet** — the three superseded races
  collapsed to no-bet.
- **Pre-off evaluation (the fix):** selecting each race's latest run with
  `run_time <= off_time` recovers the true **7-race** evaluation — **7 settled,
  0 pending, 0 no-bet, 0/7 winners** (the model's final pre-off pick won none).

Because history is append-only, the genuine pre-off runs were still present, so
this is an evaluation/selection change only — no rows were mutated and no model
math changed.

```powershell
# Read-only; requires the dev server (npm run dev). Prints no secrets.
curl "http://localhost:3000/api/accuracy?date=2026-06-16&course=Ascot"
```

Inspect `performance`: post-fix it reports `settled_count: 7`,
`no_bet_races: 0`, `evaluationMode: "pre_off"`. If you instead see
`settled_count: 4` and `no_bet_races: 3`, that environment is evaluating the
`is_current` pointer rather than the pre-off run.

See also [HANDOVER_ASCOT_DAY_1_FIXES.md](HANDOVER_ASCOT_DAY_1_FIXES.md),
[RACE_DAY_RUNBOOK.md](RACE_DAY_RUNBOOK.md) §7, and the day write-up
[../ascot-day-1/end-of-day-analysis.md](../ascot-day-1/end-of-day-analysis.md).
This is decision-support only, not betting advice.
