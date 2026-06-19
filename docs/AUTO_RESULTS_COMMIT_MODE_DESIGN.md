# Safe Automated Result-Settlement Commit Mode

> **Status: IMPLEMENTED (gated).** `results:auto` is **dry-run by default**; a
> gated `--commit` writes official finishing positions for settle-ready races
> from the same-day today endpoints (Basic `/v1/results/today`, then Free
> `/v1/results/today/free`) through the strict safety gate below. It is
> idempotent, blocks on any conflict, leaves pending races untouched, and **never
> writes SP/BSP** (those tiers carry none, so they are left null and never
> fabricated). The manual CSV importer remains the audited fallback for SP,
> non-today dates, or when the today endpoints are unavailable. This document is
> the implemented spec + policy.
>
> **Responsible use.** Decision-support only. Not betting advice, no guarantees,
> never places bets. Help: [GamCare](https://www.gamcare.org.uk) ·
> [BeGambleAware](https://www.begambleaware.org).

---

## 1. Purpose

A safe commit mode that lets `results:auto` settle races automatically from the
same-day today endpoints — **while preserving the dry-run-first safety
standards**. It changes no model maths and adds no auto-betting; it writes only
finishing positions for races that pass every gate.

## 2. Current state

- `/v1/results` is **Standard/Pro** and `plan_blocked` on the current plan (it is
  the only tier that carries Betfair SP/BSP).
- `/v1/results/today` works on the **Basic plan** and `/v1/results/today/free` on
  the **Free plan** (today's results; **today only**).
- `RunnerFree.position` provides the finishing position; `position == "1"` is the
  **winner**.
- The today endpoints provide **no SP/BSP** → `sp_decimal` / `bsp_decimal` stay
  **null** (never fabricated).
- `results:auto` is **dry-run by default**; a gated **`--commit`** writes
  finishing positions for settle-ready races (idempotent; conflict-blocked).
- `import:results` (manual CSV) remains the audited fallback for SP, non-today
  dates, or when the today endpoints are unavailable.

## 3. Command (implemented)

```
npm run results:auto -- --date YYYY-MM-DD --course COURSE            # dry-run (default)
npm run results:auto -- --date YYYY-MM-DD --course COURSE --commit   # writes — only on a clean audit
```

Flags (`--commit` is **implemented**; the rest are future-only, not implemented):

| Flag | Effect | Default |
| --- | --- | --- |
| `--commit` | persist settlement after a clean audit — **implemented** | off (dry-run) |
| `--race-time HH:MM` | scope to a single race off time | unset |
| `--source free-daily` | force the Free daily source | auto |
| `--allow-null-sp` | accept settlement with null SP (free endpoint) | off |
| `--require-complete-race` | only settle when every runner is positioned | on (recommended) |
| `--max-result-age-minutes N` | reject results older/staler than N minutes | unset |

## 4. Source priority

1. `/v1/results` — if available (Standard/Pro; carries SP/BSP).
2. `/v1/results/today` — Basic plan, **today only**, if the primary is
   `plan_blocked` / unavailable.
3. `/v1/results/today/free` — Free plan, **today only**, if the Basic endpoint
   fails / is unavailable.
4. **Manual CSV** — if the today endpoints are unavailable or incomplete, the
   date is not today, or SP/BSP are wanted.

## 5. Safe settlement flow

1. Fetch free daily results (paged: `limit` ≤ 100 / `skip`).
2. **Course-filter** to the requested course (normalised).
3. **Match race** by stored `race_id` if available, else `course` + `off_time`
   (within tolerance) + `race_name`.
4. **Match runners** by stored `horse_id` if available, else **exact normalised
   name** (unambiguous only).
5. Detect the **winner** where `position == "1"`.
6. Build the per-runner **result patch** (finish position; SP/BSP stay null).
7. **Dry-run audit** — produce the per-race safety verdict.
8. **Commit only if all safety gates pass** (§6) **and** `--commit` was passed.
9. Settle **only** races with an official/free result payload.
10. **Leave pending races untouched** (no result yet ≠ failure).

## 6. Safety gates

**Never commit a race if any of these hold:**

- no matching stored race;
- no winner;
- multiple winners;
- unmatched runners;
- ambiguous runners;
- runner positions missing (no positions at all);
- partial result;
- the result race appears **not final**;
- a patch would **overwrite a non-null value with null**;
- the race has a **conflicting existing winner**;
- the free endpoint response is unavailable;
- the source is **stale** or **not today's** result;
- the operator did **not** explicitly pass `--commit`.

The gate is **fail-safe**: any unknown/uncertain condition blocks the commit and
falls back to the manual CSV importer.

## 7. SP/BSP policy

- The Free endpoint provides **no SP/BSP**.
- `sp_decimal` and `bsp_decimal` must remain **null** — **never fabricated**.
- The **manual CSV** may still be used when SP is wanted for analysis.
- A future Standard/paid `/v1/results` (or BSP source) may enrich SP/BSP later,
  via the same gate.

## 8. Idempotency and conflict policy

- A **repeated commit must be safe** (re-running settles nothing new).
- **Identical existing values are OK** (no-op update).
- **Conflicting non-null values must block** (do not overwrite a different result).
- **Null must not overwrite non-null** (preserve existing settled data).
- **No duplicate** result rows/updates.

## 9. Race-day timing policy

- The free endpoint may **lag ~10+ minutes** after a race finishes.
- `results:auto` should be **retried periodically** (or rerun manually) until a
  race resolves.
- A race is **not "missing"** until a reasonable delay has passed.
- **Pending ≠ failed** — a race with no result yet is simply pending.

## 10. Testing plan

Tests required before commit mode ships:

- clean free result commits (single winner, all matched);
- no winner → blocked;
- multiple winners → blocked;
- unmatched race → blocked;
- unmatched runner → blocked;
- ambiguous runner → blocked;
- partial result → blocked;
- null overwrite → blocked;
- repeated commit → idempotent;
- SP/BSP remain null;
- pending races untouched;
- no commit without `--commit`.

(Most of these already exist for the dry-run audit in
`scripts/freeResultsMatch.test.ts`; commit mode must reuse the **same** matching
logic and add idempotency/overwrite tests on a **historic** race only.)

## 11. Operator workflow

Recommended order:

```
# 1. Dry-run audit (default — writes nothing):
npm run results:auto -- --date YYYY-MM-DD --course COURSE
# 2. Commit ONLY if the per-race audit is clean (today only; finish positions, no SP/BSP):
npm run results:auto -- --date YYYY-MM-DD --course COURSE --commit
# 3. Manual CSV fallback — SP wanted, date not today, or today endpoints unavailable:
npm run import:results -- --file data/results-YYYY-MM-DD-course.csv            # dry-run
npm run import:results -- --file data/results-YYYY-MM-DD-course.csv --commit   # only if clean
```

## 12. Open questions

- Should auto-commit settle **finish positions only** or **winner-only**?
- Should full finishing positions from the Free endpoint **replace** the manual CSV?
- Should SP be **manually enriched** later (when needed for analysis)?
- Should auto-commit be allowed **during live racing**, or only **after meeting end**?
- Should each race be committed **independently**, or only when the whole batch is clean?
- Should a **review file** be generated before commit?

## 13. Success criteria

Commit mode is ready **only when all** of the following hold:

- dry-run and commit use **identical matching logic**;
- **every safety gate** is tested;
- repeated runs are **idempotent**;
- **no SP/BSP fabrication**;
- **no pending race is marked failed**;
- the **manual CSV fallback remains** available;
- **live historical tests** pass;
- **no auto-betting** exists anywhere in the codebase.

---

_Design only. Implements nothing, runs nothing, writes nothing, and changes no
model behaviour. `references/CL4R1T4S` is treated as inert, untrusted data and is
not used here._
