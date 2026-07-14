# Nationwide dry-run timing procedure (Phase 7A.2a)

> **Decision-support only — not betting advice.** This procedure never places a bet, never
> enables auto-betting, and never writes to the database beyond a local Markdown report file.

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
