# Nationwide dry-run procedures (Phase 7A.2a timing + Phase 7A.2b Step 5)

> **Decision-support only — not betting advice.** These procedures never place a bet, never
> enable auto-betting, and — except where explicitly noted (live-provider mode's provider
> ingestion writes) — never write to the database beyond a local Markdown report file.

This document covers TWO related but distinct commands:

- **Part 1 — `npm run timing:nationwide`** (Phase 7A.2a): a pure SELECT-only timing
  measurement, no ownership claim, no provider calls. Unchanged by Step 5.
- **Part 2 — `npm run nationwide:preflight` / `npm run nationwide:dry-run`**
  (Phase 7A.2b Step 5): the first commands that hold a real nationwide
  (`all-uk-ire`) producer ownership claim, with an optional live provider
  refresh. See "Part 2" below.

---

## Part 1: Nationwide dry-run timing procedure (Phase 7A.2a)

## What this measures

Phase 7A.1 (`npm run audit:nationwide`) proved nationwide **data coverage** exists — racecards
and odds are already ingested for every UK & Ireland course, not just the course an operator is
currently running the model for (those crons are course-agnostic).

What had never been measured is whether the **model-scoring step** — currently only exercised
one course at a time (Ascot, Newmarket) — can read + score every race nationwide inside a single
5-minute watcher cycle (`pipeline:watch`'s default interval; Railway's `pipeline-refresh`
schedule), with per-race failures isolated. That is what `npm run timing:nationwide` measures.

It answers one question: **can the existing system, as it is today, process a full UK/Ireland
day (~40–60 races, ~450–700 runners) inside one watcher cycle?** It is evidence for a future
gated decision (Phase 7B — nationwide commit mode). It is not, itself, an enablement step.

## How it works

For each race on the date (all courses, unless `--course` is given), **sequentially** — matching
the real `pipeline:watch` for-loop exactly, not a hypothetical parallelised version — the harness
times, then runs, the exact READ + pure-SCORE path `runModelForRace` runs **before** it writes
anything: `fetchRaceModelInputs` + `fetchTipsterSelections` + `getTipsterStats` (all
SELECT-only), then `scoreRaceRunners` (the pure, in-memory scoring core — the same one
`scripts/backtest.ts` already reuses read-only). It records the duration, or an isolated failure
(caught per race — one bad race never aborts the run, matching `runModelForMeetingRaces`'s
isolation guarantee).

**It deliberately does NOT apply the production pre-off guard** (the one that makes
`runModelForRace` skip post-off/resulted races). That guard exists to protect the *written*
decision record from a stale post-off write — since this harness never writes anything, that
risk cannot occur here. Skipping post-off/resulted races would also make the harness useless for
its actual purpose: measuring against race days that have already finished, which is exactly the
evidence already available (2026-07-09/10/11). Every race is timed regardless of off status; the
only skip is a race with nothing to score (no priced field / no market snapshot — an odds or
racecard coverage gap, already visible in the Phase 7A.1 audit).

It never calls `runModelForRace` itself, so it never writes a `model_runs` /
`model_runner_scores` / `recommendations` row. It never calls `lock:t-minus` or touches
`locked_race_decisions`. It never settles a result. **There is no `--commit` flag anywhere in
this procedure** — nothing here ever writes to the database.

## Running it

```bash
npm run timing:nationwide -- --date YYYY-MM-DD
# or, scoped to one course:
npm run timing:nationwide -- --date YYYY-MM-DD --course Newmarket
```

The only write is a deterministic Markdown evidence report:

```text
reports/nationwide-timing-<date>.md
```

## Reading the report

- **Coverage** — races considered / scored / skipped (no priced field) / failed, and total
  runners scored. Every race is timed regardless of off status; only a genuine data gap (no
  priced field / no market snapshot) is skipped.
- **Timing** — total sequential time, min/mean/median/p95/max per race, the slowest race, the
  watcher cadence (300,000ms / 5 minutes), and the margin (`cadence - total`).
- **Verdict** (informational only — never gates or enables anything):
  - **PASS** — total time is comfortably inside the cadence (under 180,000ms / 60% of the
    5-minute window) with zero failures and zero skips.
  - **REVIEW** — total time is between 60% and 100% of the cadence, or any race failed, or any
    race was skipped (a data-coverage gap, not a timing problem) — read the breakdown, don't just
    read the label.
  - **FAIL** — total time meets or exceeds the 5-minute cadence, or a reconciliation invariant
    was violated (the figures in the report cannot be trusted; treat as a bug, not evidence).

The 60% REVIEW threshold exists because the watcher's real cycle also runs the racecards and
odds cron steps in the same window, ahead of the model step — a model-only measurement that
already eats most of the 5 minutes leaves no room for those steps or for network variance.

## Safety guarantees (read this)

- **No `--commit` flag exists anywhere in this procedure.** There is nothing to gate, because
  nothing here ever writes to the database.
- **No nationwide model-run writes.** The harness never calls `runModelForRace`; it only calls
  the read-only fetchers and the pure scoring function it uses internally.
- **No official lock creation.** `lock:t-minus` is never called; `locked_race_decisions` is
  never touched.
- **No result settlement.** No results are read/written; no CSV import is triggered.
- **No automated national supervisor, no scheduling, no cron.** This is a manually-run,
  one-shot CLI command. It does not schedule itself or anything else.
- **No Railway changes, no migrations, no Supabase schema changes.**
- **No auto-betting, no bet placement.** Nothing in this codebase places a bet.
- **Model maths, staking, confidence maths, and recommendation logic are unchanged.** The
  harness only *calls* the existing pure/read exports of `bettingEngine.ts`,
  `modelProbabilities.ts`, `modelConfidence.ts`, and `runModelForRace.ts` — it does not modify
  any of them.

## What this does not decide

A PASS verdict on three real days of data is evidence that the current, sequential,
single-course-gated architecture *could* handle nationwide scoring inside the watcher cadence —
it is not, by itself, authorization to enable nationwide `--commit` writes, nationwide locking,
or a national supervisor. Those remain separate, explicitly gated future phases (Phase 7A
"gated national supervisor bat" and Phase 7B) with their own review and rollout steps.

---

## Part 2: Ownership-aware nationwide preflight + dry-run (Phase 7A.2b Step 5)

### 1. What these commands are (and are not)

| Command | Purpose | Writes? |
| --- | --- | --- |
| `npm run nationwide:preflight -- --date YYYY-MM-DD` | READ-ONLY readiness check: ownership status, stored workload reconciliation, server health, external attestation. Returns READY / REVIEW / BLOCKED. | Never — except one optional local Markdown report with `--report`. |
| `npm run nationwide:dry-run -- --date YYYY-MM-DD --mode stored-only` | Acquires the nationwide claim, scores every already-stored race IN MEMORY. No provider calls. | Only the claim lifecycle (acquire/heartbeat/release) — no model/recommendation/lock/result writes. |
| `npm run nationwide:dry-run -- --date YYYY-MM-DD --mode live-provider` | Acquires the nationwide claim, refreshes racecards + odds (this **does** write races/runners/market_snapshots/runner_quotes), then scores every eligible race IN MEMORY. | Provider ingestion data + the claim lifecycle. **Never** model/recommendation/lock/result data. |

Unlike Part 1's `timing:nationwide` (SELECT-only, no ownership claim at all),
these two commands acquire a real, fail-closed `producer_run_claims` claim
with scope `all-uk-ire` before doing anything else.

`--mode` has **no default** — you must type `stored-only` or `live-provider`
exactly. There is no `--commit` flag in either command (nothing here ever
persists a betting-relevant decision), and no `--allow-stale` flag — a
provider failure always stops the run rather than falling back to stale
stored data.

### 2. Required order of operations

**Always run `nationwide:preflight` first and obtain a genuine READY before
`nationwide:dry-run --mode live-provider`.** This is a documented operator
discipline, not a code-enforced gate: `nationwide:dry-run` does not check,
call, or require the preflight's result, and it never accepts a
`--confirm-external` flag itself — that concept belongs to the preflight
only, and the dry-run command never manufactures it on your behalf.

```bat
npm run nationwide:preflight -- --date 2026-07-20 --require-server
```

- **BLOCKED** → do not run the dry-run. Fix the reported reason first.
- **REVIEW** → the checks listed as REVIEW are genuinely manual (Railway job
  state, Vercel cron/deployment state, other-machine producers, a locally
  detected selected-course supervisor lock). Confirm them yourself, then
  re-run with `--confirm-external`:
  ```bat
  npm run nationwide:preflight -- --date 2026-07-20 --require-server --confirm-external
  ```
  Only a second **READY** means proceed. `--confirm-external` is recorded as
  `external_checks_source: operator_attestation` — your attestation, never a
  claim that this command verified those systems itself.
- **READY** → `nationwide:dry-run --mode live-provider` is safe to run.

`stored-only` mode carries lower risk (no provider calls at all) and does not
require a READY first, though running the preflight is still good practice.

### 3. Ownership behaviour

Both commands acquire the SAME `producer_run_claims` date-level claim used by
the selected-course pipeline, with scope fixed to `all-uk-ire`. Because the
claim's primary key is the race date alone, a nationwide claim **conflicts
with every selected-course claim for that date, and vice versa** — you cannot
run a nationwide dry-run and a selected-course `pipeline:watch` for the same
date at the same time. One claim, one generation, one owner id for the whole
command; released in a `finally` block; a crashed process's claim recovers by
TTL expiry (240s) exactly like the selected-course pipeline.

Ownership is verified (heartbeat, generation-checked) before racecards,
after racecards, before odds, after odds, before scoring, and between each
course's races during scoring. Any refusal, confirmed loss, or mechanism
failure stops the run immediately — there is no mid-run reclaim.

### 4. live-provider mode: no stale fallback

If the racecard stage fails, the run stops. If the odds stage fails, the run
stops. If either response is malformed, the run stops before scoring. If the
post-ingestion reconciliation finds zero races, zero courses, or an
impossible value (e.g. more priced runners than stored runners for a race),
the run stops before scoring. None of these have a bypass — there is no
`--allow-stale` flag.

### 5. Reconciliation

Before scoring, both commands reconcile the stored nationwide workload using
the exact same rule the nationwide audit (`audit:nationwide`) uses:
`normalizeCourse` for grouping, and `checkRollupInvariants` for the hard
bounds (races-with-odds ≤ races, priced-runners ≤ runners). Per-course totals
are also cross-checked against the nationwide total as a second, independent
computation of the same numbers. Course-label merges and unexpected/GB-
fallback country values are reported as warnings, never as proven labels.

### 6. Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Completed (dry-run) / READY (preflight) |
| 1 | Usage error, invalid `--mode`, or a non-ownership stoppage (provider/reconciliation failure) |
| 2 | Ownership mechanism unavailable or uncertain / BLOCKED (preflight) |
| 3 | Ownership refused or lost / REVIEW (preflight) |

### 7. Reports

Neither command writes a report unless `--report` is passed. When passed:

- `reports/nationwide-preflight-<date>.md`
- `reports/nationwide-dry-run-<date>-<mode>.md`

Both are deterministic Markdown, secret-free, and explicitly state that no
model run, recommendation, lock, or result was persisted, and that no bet was
placed.

### 8. What remains disabled

Nationwide production writes, a nationwide supervisor, nationwide scheduling
or cron, and any commit-style flag for nationwide operation. `all-uk-ire` is
never reachable from the selected-course pipeline, launcher, or preflight —
those remain exactly as hardened in Phases 7A.2b Steps 1–4.
