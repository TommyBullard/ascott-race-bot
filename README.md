# ascott-race-bot

A Next.js + Supabase horse-racing **value model**. It ingests today's UK & Irish
races, prices the field from live market odds (optionally blended with
quality-weighted tipster signals), finds positive expected-value (+EV) bets,
sizes stakes with fractional Kelly, and persists the result to Postgres. A web
dashboard and JSON APIs read that persisted output.

> **Personal tool.** This is not a polished product, and it produces real
> staking guidance. Review the math, and add authentication before exposing any
> endpoint publicly.

## Tech stack

- [Next.js 16](https://nextjs.org/) (App Router) + [React 19](https://react.dev/)
- TypeScript (path alias `@/*` → `src/*`)
- [Supabase](https://supabase.com/) (Postgres) via `@supabase/supabase-js`,
  using the **service-role key, server-side only**
- [Vercel Cron](https://vercel.com/docs/cron-jobs) for scheduled ingestion
- [tsx](https://github.com/privatenumber/tsx) for the standalone scripts and the
  custom test runner
- External data: [The Racing API](https://www.theracingapi.com) (paid,
  ToS-compliant) and the [Betfair Exchange API](https://developer.betfair.com/)

## How it works

The system is split into a **producer side** (cron jobs ingest data and write a
model run to the database) and a **reader side** (the dashboard and most APIs
only read what the producer persisted). Nothing in the web app recomputes the
model on the fly.

```mermaid
flowchart TD
    subgraph ext[External sources]
        RA[The Racing API]
        BF[Betfair Exchange API]
    end
    subgraph cron[Vercel Cron jobs]
        TD["tipster-discovery (daily 06:00)"]
        RC["racecards (daily 07:00)"]
        OD["odds (every 5 min)"]
        RES["results (every 5 min)"]
    end
    RA --> RC --> DB[(Supabase Postgres)]
    BF --> OD --> DB
    RA --> RES --> DB
    RA --> TD --> DB
    OD -->|after odds| MODEL[runModelForRace]
    RES -->|re-run remaining races| MODEL
    MODEL -->|model_runs, model_runner_scores, recommendations| DB
    DB --> API[Read-only APIs]
    API --> UI[Dashboard + Leaderboard]
```

Two layers keep the pipeline testable:

- **[src/lib/raceSync.ts](src/lib/raceSync.ts)** — the **pure transform layer**:
  deterministic mapping + entity-matching (no I/O, no DB), unit-tested on
  fixtures. It never invents data — missing fields map to `null`/`undefined`.
- **[src/lib/liveSync.ts](src/lib/liveSync.ts)** — the **I/O orchestration
  layer**: fetches from The Racing API / Betfair, applies the transforms, and
  performs idempotent writes to `races` / `runners` / `market_snapshots` /
  `runner_quotes`, then triggers the model. Exposes `syncRacecards`,
  `syncOddsFromBetfair`, and `syncResults`.

## Project structure

```
src/
  app/
    layout.tsx                       # Root layout
    page.tsx                         # Recommendations dashboard (client page)
    leaderboard/page.tsx             # Tipster leaderboard (client page)
    api/
      recommendations/route.ts       # GET today's race cards (dashboard)
      recommend-bet/route.ts         # GET top pick for one race_id
      run-model/route.ts             # POST trigger a model run for a race
      settle/route.ts                # POST record a result + recompute accuracy
      accuracy/route.ts              # GET live strike rate / P&L / ROI
      tipsters/in-form/route.ts      # GET top active tipsters
      tipsters/leaderboard/route.ts  # GET all tracked tipsters
      cron/
        tipster-discovery/route.ts   # Daily: refresh tipster signals
        racecards/route.ts           # Daily: ingest today's cards
        odds/route.ts                # Every 5 min: ingest Betfair prices
        results/route.ts             # Every 5 min: settle + re-run model
        recommendations/route.ts     # DISABLED stub (returns 410)
  lib/
    supabaseAdmin.ts                 # Server-side Supabase client (service role)
    racingApi.ts                     # The Racing API adapter (cards, results, signals)
    betfairExchange.ts               # Betfair Exchange client (cert login + prices)
    raceSync.ts                      # Pure transforms + entity matching (no I/O)
    liveSync.ts                      # I/O orchestration for the cron pipeline
    runModelForRace.ts               # Model producer: scores a race + persists it
    bettingEngine.ts                 # EV, fractional Kelly, confidence score
    modelProbabilities.ts            # Tipster-weighted, anti-crowd win probabilities
    raceData.ts                      # Supabase data access (reads model output)
    recommendBet.ts                  # Reads the latest run's top recommendation
    discoverTipsters.ts              # Tipster "needle" scoring + promote/demote
    historicalRaceLoader.ts          # Validation core for the historical loader
    betfairBsp.ts                    # Betfair BSP CSV -> historical import
    backtestStats.ts                 # Backtest aggregation math
scripts/                            # CLI tools, simulations, backtests, tests
supabase/migrations/                # SQL migrations
data/                               # Example historical-race import
vercel.json                         # Cron schedule
```

## The ingestion pipeline (cron jobs)

Four cron routes are scheduled in [vercel.json](vercel.json). Each is **idempotent**
and protected by an optional `CRON_SECRET` bearer token (Vercel Cron sends it).

| Route                          | Schedule        | What it does                                                                                   |
| ------------------------------ | --------------- | ---------------------------------------------------------------------------------------------- |
| `/api/cron/tipster-discovery`  | `0 6 * * *`     | Pull trainer/jockey performance from The Racing API, score tipster momentum, upsert tipsters.  |
| `/api/cron/racecards`          | `0 7 * * *`     | Pull today's UK & IRE racecards, upsert `races` (`scheduled`) + `runners`.                      |
| `/api/cron/odds`               | `*/5 * * * *`   | Poll Betfair Exchange for live prices, write `market_snapshots` + `runner_quotes`.             |
| `/api/cron/results`            | `*/5 * * * *`   | Pull settled results (finish pos, BSP/SP), mark races settled, then **re-run the model**.      |

**Entity matching:** the `races` / `runners` tables hold no external provider id,
so API entities are matched back to DB rows on a normalised **(course + off-time)**
for the race and a normalised **horse name** for the runner. Unmatched entities
are **skipped**, never written to the wrong row.

## The model (producer)

[src/lib/runModelForRace.ts](src/lib/runModelForRace.ts) is the producer that
powers the read side. For one race it runs the TypeScript engine and **persists**
the result across three tables:

- `model_runs` — one row per run (run metadata + the `market_snapshots` anchor).
- `model_runner_scores` — per-runner probability / edge / EV / rank.
- `recommendations` — the run's recommended bet(s), keyed by `model_run_id`.

Idempotency ("overwrite the run for this race") is achieved by inserting the new
run and its children **first**, then deleting older runs for the race — so a
failed insert never destroys existing data, and the reader always sees a complete
run. (supabase-js cannot wrap multiple statements in one transaction, so this is
best-effort rather than atomic — see Caveats.)

The scoring pipeline:

1. **Probabilities** ([src/lib/modelProbabilities.ts](src/lib/modelProbabilities.ts)) —
   base probabilities are de-overrounded market-implied (`1/odds`, normalised)
   when every runner is priced, else an equal split. They are then adjusted by
   quality-weighted tipster support, an anti-crowd "hidden value" bias (rewards
   strong but lightly-tipped runners, penalises over-hyped favourites above 40%
   crowd share), and odds-band multipliers (prices `< 2.0` and `> 12.0` are
   faded). Normalised to sum to 1.
2. **EV** ([src/lib/bettingEngine.ts](src/lib/bettingEngine.ts)) — `EV = prob * odds - 1`.
3. **Confidence** — blends EV size, model-vs-market edge, and independent tipster
   agreement into a `[0, 1]` score with `high` / `medium` / `low` labels.
4. **Stake** — **fractional Kelly (0.2)** scaled by confidence and clamped to
   **0.1%–2%** of bankroll. Bankroll is read from the latest `bankroll_ledger`
   balance, falling back to `1000` when the ledger is empty.

Tipster quality weight = `0.5·ROI + 0.3·A/E + 0.2·strikeRate` (ROI and A/E
min-max normalised across the cohort scored in a run).

> The web app does **not** recompute any of this.
> [src/lib/recommendBet.ts](src/lib/recommendBet.ts) simply reads the latest
> run's rank-1 recommendation.

## Tipster discovery

[src/lib/discoverTipsters.ts](src/lib/discoverTipsters.ts) turns **real, proofed**
leaderboard figures into a momentum ("needle") score and a model weight, then
auto-promotes/demotes tipsters in the active pool:

- `reliability = N / (N + 400)` (sample-size shrinkage)
- `needle_score = 0.45·z(longRunROI) + 0.35·z(recentROI_30d) + 0.20·z(streak)`
- `final_weight = reliability · exp(needle_score)`

[src/lib/racingApi.ts](src/lib/racingApi.ts) is the only implemented signal
source (it derives signals from real trainer/jockey analysis). The other
platform adapters in `discoverTipsters.ts` are deliberately **left
unimplemented** (they throw) so the integrity contract holds: a source must
return verbatim proofed figures or nothing — never a guess.

## API

All routes are read-only unless noted. Errors are logged server-side; client
responses avoid leaking internal detail.

| Route                                         | Method | Purpose                                                            |
| --------------------------------------------- | ------ | ------------------------------------------------------------------ |
| `/api/recommendations`                        | GET    | One rich race card per today's race, sorted by off-time.           |
| `/api/recommend-bet?race_id=<id>`             | GET    | The latest run's top (`rank` 1) recommendation for one race.       |
| `/api/run-model?race_id=<id>`                 | POST   | **Writes.** Trigger a model run for a race over HTTP.              |
| `/api/settle?race_id=&winning_runner_id=`     | POST   | **Writes.** Record a winner, then recompute live accuracy.        |
| `/api/accuracy`                               | GET    | Live strike rate / level-stakes P&L / ROI across settled races.    |
| `/api/tipsters/in-form?limit=<n>`             | GET    | Top active tipsters by needle weight (+ today's picks).            |
| `/api/tipsters/leaderboard`                   | GET    | Every tracked tipster (active + demoted).                          |

`/api/recommend-bet` returns `RaceRecommendation`
(`{ race_id, runner_id, horse_name, rank, odds, model_prob, market_prob, ev,
confidence_label, confidence_score, stake_pct, stake_amount }`): `200` with the
pick, `400` when `race_id` is missing, `404` when the race has no run yet, `500`
on failure.

> **Obsolete:** `/api/cron/recommendations` is a **disabled stub** that returns
> HTTP `410 Gone`. It used to recompute recommendations in TypeScript and upsert
> them; the model now produces them upstream. Its cron entry has been removed
> from [vercel.json](vercel.json).

## Frontend

- **[/](src/app/page.tsx)** — recommendations dashboard: one card per race with a
  live countdown, the market favourite, the model's rank-1 pick (with a "Why"
  rationale and stake), 1–2 alternatives, and a live accuracy tracker.
- **[/leaderboard](src/app/leaderboard/page.tsx)** — sortable tipster leaderboard;
  active vs. demoted rows, signed ROI, and a reliability bar.

Both pages are client components with inline styles (no UI library) and poll the
read APIs for updates.

## Database schema

Table and column names are centralised as constants at the top of
[src/lib/raceData.ts](src/lib/raceData.ts) (verified against the live schema).

- **Core:** `races`, `runners`, `market_snapshots`, `runner_quotes`,
  `model_runs`, `model_runner_scores`, `recommendations`, `bankroll_ledger`.
- **Tipsters:** `tipsters`, `tipster_aliases`, `tipster_priors`,
  `tipster_review_queue`, `tipster_selections`.

Schema details worth knowing:

- `runner_quotes` has **no** `race_id`/timestamp of its own — odds hang off the
  parent `market_snapshots` row (`snapshot_id`). "Latest odds" means the newest
  snapshot for the race, taking the best decimal price per runner within it.
- `recommendations` is keyed by `model_run_id` (not by `race_id`).
- `tipster_selections` is created by
  [supabase/migrations/20260612000000_create_tipster_selections.sql](supabase/migrations/20260612000000_create_tipster_selections.sql).
  **It exists but the live pipeline does not populate it**, so live model runs
  are **market-only** (no tipster weighting) unless selections are supplied
  separately. `runModelForRace` handles empty tipster data gracefully.

## Getting started

### Prerequisites

- Node.js >= 20.9.0 (see `engines` in [package.json](package.json))
- A Supabase project
- API credentials for The Racing API and Betfair (for the live pipeline)

### Install

```bash
npm install
```

### Configure environment

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

| Variable                    | Required for          | Description                                                              |
| --------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `SUPABASE_URL`              | everything            | Supabase project URL.                                                     |
| `SUPABASE_SERVICE_ROLE_KEY` | everything            | Service-role secret key. **Server-side only — bypasses RLS.**            |
| `CRON_SECRET`               | cron auth             | Bearer secret the cron routes require when set.                          |
| `RACING_API_USER`           | racecards / results / tipsters | The Racing API HTTP Basic username.                             |
| `RACING_API_KEY`            | racecards / results / tipsters | The Racing API HTTP Basic password.                             |
| `BETFAIR_APP_KEY`           | odds                  | Betfair application key.                                                  |
| `BETFAIR_USERNAME`          | odds                  | Betfair account username.                                                |
| `BETFAIR_PASSWORD`          | odds                  | Betfair account password.                                                |
| `BETFAIR_CERT_PEM`          | odds                  | Betfair client certificate PEM (literal `\n` allowed).                   |
| `BETFAIR_KEY_PEM`           | odds                  | Betfair client private key PEM (literal `\n` allowed).                   |
| `DEBUG_MODEL`               | optional              | Set to `1` to emit model trace logs.                                      |

All credentials are validated **lazily, at request time**, so importing a module
never throws and `next build` can statically analyse the routes.

> **TODO:** `.env.example` currently lists only `SUPABASE_URL`,
> `SUPABASE_SERVICE_ROLE_KEY`, and `CRON_SECRET`. The Racing API and Betfair
> variables above are read by the code but are **not** yet in `.env.example`.

### Run

```bash
npm run dev
```

Then open http://localhost:3000.

## Scripts

| Script                    | Purpose                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `npm run dev`             | Start the dev server.                                                |
| `npm run build`           | Production build.                                                    |
| `npm run start`           | Run the production build.                                            |
| `npm run lint`            | Lint with ESLint (`eslint .`).                                       |
| `npm run typecheck`       | Type-check with `tsc --noEmit`.                                      |
| `npm run format`          | Format with Prettier.                                                |
| `npm run format:check`    | Verify formatting without writing.                                  |
| `npm test`                | Run the custom test runner ([scripts/tests.ts](scripts/tests.ts)).  |
| `npm run run:model`       | Run the model for a race from the CLI.                              |
| `npm run backtest`        | Backtest the model over settled/historical races.                  |
| `npm run simulate`        | Royal Ascot simulation.                                            |
| `npm run simulate:novalue`| No-value simulation.                                               |
| `npm run seed:tipsters`   | Seed in-form tipsters.                                             |
| `npm run load:races`      | Load a historical-races import (see [data/](data/)).               |
| `npm run convert:bsp`     | Convert a Betfair BSP CSV into a historical import.                |
| `npm run verify:racing`   | Smoke-check The Racing API integration.                            |
| `npm run verify:ingestion`| Verify pipeline ingestion.                                         |
| `npm run inspect:schema`  | Inspect the live database schema.                                  |

## Deployment

Designed for Vercel. The cron schedules in [vercel.json](vercel.json) include
sub-daily jobs (every 5 minutes), which require a plan that supports them. Set
all environment variables above in every environment.

## Design principles

- **Never fabricate data.** Every persisted value traces to an API response;
  missing data is stored as `null`/omitted and unmatched entities are skipped —
  nothing is invented, estimated, or interpolated.
- **Idempotent ingestion.** Re-running any cron job in the same day reuses
  existing rows rather than duplicating them.
- **Pure core, I/O shell.** Transforms and math (`raceSync`, `modelProbabilities`,
  `bettingEngine`, `backtestStats`, `historicalRaceLoader`, `betfairBsp`) are
  side-effect-free and unit-tested on fixtures; DB orchestration stays thin.
- **Producer / reader split.** The model writes to the database; the web app
  reads it.
- **Service role is server-only.** `supabaseAdmin` bypasses RLS and must only be
  imported in server-side code (route handlers, scripts).

## Caveats & TODOs

- **Live runs are market-only.** Until `tipster_selections` is populated for
  live races, the model scores from market odds alone (no tipster weighting).
- **`/api/recommend-bet` and `/api/run-model` have no auth.** Add authentication
  before exposing them, since they expose / trigger staking logic backed by
  service-role data access.
- **Model writes are not atomic.** supabase-js can't run a multi-statement
  transaction, so `runModelForRace` uses a best-effort insert-then-delete order.
  For strict atomicity, move the logic into a Postgres function called via
  `supabaseAdmin.rpc(...)`.
- **`.env.example` is incomplete** (missing the Racing API + Betfair variables;
  see the environment table above).
- Some platform tipster-source adapters in `discoverTipsters.ts` are intentional
  unimplemented stubs and throw until real, ToS-compliant fetch/parse logic is
  supplied.

## Security notes

- `supabaseAdmin` uses the service-role key and **bypasses Row Level Security**.
  Only import it in server-side code.
- The cron endpoints require `CRON_SECRET` when it is set. Set it in every
  environment.
- Add authentication to the non-cron mutating/reading endpoints before exposing
  them publicly (see Caveats).
