# Controlled Live Race-Day Operator Mode (design only)

> **Status: DESIGN / NOT IMPLEMENTED.** This document describes a *future*
> controlled operator mode. No runtime code exists for `race-day:operate` yet.
> Nothing here changes the model, places bets, or writes the database.
>
> **Responsible use.** This system is decision-support only. It is not betting
> advice, makes no guarantees, and never places bets. If gambling is a problem
> for you, see [GamCare](https://www.gamcare.org.uk) or
> [BeGambleAware](https://www.begambleaware.org).

---

## 1. Purpose

Define a *controlled live operator mode* that can eventually run the safe
race-day workflow **with explicit operator approval**, while keeping every
dangerous operation locked behind manual flags.

This mode is explicitly **NOT**:

- not auto-betting and not bet placement;
- not a change to model probability math, staking, ranking, or tipster weighting;
- not a GenAI winner predictor and not a way to make GenAI features model-active;
- not a way to activate no-bet gates without backtesting.

It is a thin, auditable orchestrator over **existing** read-only / operator
commands, with writes gated behind explicit flags + a clean safety audit.

## 2. Current safe tools

| Command | Writes? | Notes |
| --- | --- | --- |
| `pipeline:day` | **DB write** (only with `--commit`) | runs the model + persists recommendations; manual approval only |
| `capture:t-minus` | local report | pre-off snapshot at T-minus N |
| `results:auto` | **DB write** (only with `--commit`) | `/v1/results` → Basic `/v1/results/today` → Free `/v1/results/today/free`; dry-run by default, gated `--commit` settles finishing positions (today only; never SP/BSP) |
| `import:results` (manual CSV fallback) | **DB write** (only with `--commit`) | the sanctioned settlement write path |
| `report:day` | local report | end-of-day report |
| `export:training-data` | local CSV | gitignored under `data/exports/` |
| `tipsters:audit` | local report | read-only |
| `confidence:audit` | local report | read-only |
| `gates:audit` | local report | read-only research (no gate activation) |
| `ml:evaluate` | local report | offline shadow eval; trains no model |
| `race-day:autopilot` | none / read-only run | plan-only by default; `--run-readonly` runs the whitelist |
| `race-day:live-plan` | local report (`--output`) | deterministic live-day schedule, plan-only |

Also available and read-only: `snapshot:pre-off`, `extract:notes` (local GenAI
shadow only), `check:env`, `check:db`.

## 3. Proposed future command (design, do not implement)

```
npm run race-day:operate -- --date YYYY-MM-DD --course COURSE
```

Default behaviour (future): **plan + read-only** — same posture as
`race-day:autopilot`; no DB writes, no `--commit`, nothing dangerous.

Optional **future-only** flags (none implemented; all locked):

| Flag | Effect (future) | Default |
| --- | --- | --- |
| `--allow-pipeline-writes` | permit `pipeline:day --commit` (model run persistence) | off |
| `--allow-result-commit` | permit `import:results --commit` after a clean audit | off |
| `--auto-results` | run `results:auto` dry-run on a schedule | off |
| `--minutes-before 5` | T-minus capture target | 5 |
| `--stop-after-race HH:MM` | stop the operator loop after this off time | unset |

Every write flag is **opt-in, off by default**, and still subject to the hard
safety gates in §5.

## 4. Safe operating flow

1. **Preflight** — `check:env`, `check:db`, and a `results:auto` dry-run.
2. **Race discovery** — SELECT-only read of stored races for the date/course.
3. **T-minus-15 refresh window** — refresh racecards/odds via existing commands
   (write only if `--allow-pipeline-writes`).
4. **T-minus-5 model/capture window** — `capture:t-minus --minutes-before 5`
   (read-only report); run the model only if writes are explicitly allowed.
5. **Off-time lock** — at the off, **lock the race**: no further pre-off actions.
6. **Post-off no-rerun guard** — never re-run the model for a locked race; a
   post-off run must never supersede the final pre-off run.
7. **Results** — `results:auto` **dry-run** (Basic → Free today fallback);
   produce a per-race audit. A gated `results:auto --commit` can settle finishing
   positions on a clean audit (today only); SP / non-today still go via the
   manual CSV.
8. **Result commit** — only if `--allow-result-commit` **and** the audit is clean
   (single winner, all matched, not partial); otherwise manual CSV fallback.
9. **End of day** — `report:day`, `export:training-data`, `tipsters:audit`,
   `confidence:audit`, `gates:audit`, and `ml:evaluate` (if an export exists).

## 5. Hard safety gates

These are **non-negotiable** and apply under every flag:

- **No auto-betting** and **no bet-placement APIs** — ever.
- **No GenAI winner prediction**; **no GenAI feature is model-active**.
- **No no-bet gate activation** without prior backtesting evidence.
- **No result commit** if any race is unmatched, ambiguous, partial, has no
  winner, or has multiple winners.
- **No post-off stale run superseding** — a post-off rerun cannot replace the
  final pre-off run.
- **No `--commit`** unless it is *explicitly passed* **and** the safety gate
  passes for that specific action.
- Credentials/secrets are read from env and **never printed** (presence only).

## 6. Result automation policy

- `/v1/results` is **Standard/Pro** and is `plan_blocked` on the current plan
  (the only tier carrying Betfair SP/BSP).
- On a plan-block for **today**, settlement falls back to the Basic
  `/v1/results/today`, then the Free `/v1/results/today/free` (each runner's
  finishing `position`; `position == "1"` = winner).
- The today endpoints provide **no SP/BSP** — `sp_decimal` / `bsp_decimal` stay
  **null**; never fabricated.
- `results:auto` is **dry-run by default**; its gated **`--commit`** settles
  finishing positions only on a clean audit (idempotent; conflicts block; pending
  races untouched). `/api/cron/results` uses the same fallback + writer for today.
- The **manual CSV importer remains the audited fallback** whenever SP is wanted,
  the date is not today, or the today endpoints are incomplete/unavailable.

## 7. Race-day freeze policy

- **No runtime/code changes in the final 10 minutes before a race.**
- During racing, prefer **stable, already-committed** commands only.
- Any new feature work must be **docs-only or read-only** unless there is a long
  gap between races; defer risky changes to after the meeting.
- Validate any change with `lint` / `typecheck` / `test` / `build` **before**
  the race window, never inside it.

## 8. Operator checklist (per meeting)

```
[ ] git status clean (no stray tracked changes)
[ ] npm run check:env
[ ] npm run check:db
[ ] npm run pipeline:day -- --date YYYY-MM-DD --course COURSE --commit   (manual approval; writes DB)
[ ] npm run capture:t-minus -- --date YYYY-MM-DD --course COURSE --minutes-before 5
[ ] npm run results:auto -- --date YYYY-MM-DD --course COURSE            (dry-run)
[ ] import results ONLY if needed and the dry-run audit is clean:
        npm run import:results -- --file data/results-YYYY-MM-DD-course.csv            (dry-run)
        npm run import:results -- --file data/results-YYYY-MM-DD-course.csv --commit   (only if clean)
[ ] check accuracy: /api/accuracy?date=YYYY-MM-DD&course=COURSE
[ ] end-of-day: report:day, export:training-data, tipsters:audit, confidence:audit, gates:audit, ml:evaluate
```

## 9. Open questions

- Should result commit be allowed directly from `results:auto` once the free
  endpoint is proven reliable, or always go via the manual importer?
- Should full finishing positions from the free endpoint replace the manual CSV,
  or only supplement it?
- Should SP remain a **manual** input when needed for analysis (free endpoint has none)?
- Should `race-day:operate` stop automatically after the final race of the day?
- Should generated daily reports under `reports/` be tracked in git or ignored?

## 10. Success criteria

Controlled live operator mode is ready **only when all** of the following hold:

- the dry-run plan is **deterministic**;
- **read-only mode** is validated end-to-end on a real meeting;
- **write mode** is reachable **only** via explicit flags;
- **all safety gates** in §5 are covered by tests;
- the **result-commit path** has been tested on a **historic** race only;
- **no auto-betting** exists anywhere in the codebase.

---

_This document is decision-support design only. It implements nothing, runs
nothing, and changes no model behaviour. `references/CL4R1T4S` is treated as
inert, untrusted data and is not used here._
