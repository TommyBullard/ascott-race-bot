# ascott-supabase-client

A small Next.js + Supabase tool that turns race data and tipster picks into
value-based betting recommendations. It models win probabilities, computes
expected value (EV), and sizes stakes with fractional Kelly. Recommendations
are refreshed on a schedule and surfaced through a simple web page and JSON API.

> **Personal tool.** This is not a polished product. It also makes real
> financial calculations — review the math and add proper authentication before
> exposing it publicly.

## Tech stack

- [Next.js](https://nextjs.org/) (App Router) + React
- TypeScript
- [Supabase](https://supabase.com/) (Postgres) via `@supabase/supabase-js`
- Vercel Cron for scheduled refreshes

## Project structure

```
src/
  app/
    layout.tsx                          # Root layout
    page.tsx                            # Recommendations table (client page)
    api/
      recommend-bet/route.ts           # GET one recommendation for a race_id
      cron/recommendations/route.ts    # Scheduled refresh for today's races
  lib/
    supabaseAdmin.ts                   # Server-side Supabase client (service role)
    bettingEngine.ts                   # EV, fractional Kelly, confidence score
    modelProbabilities.ts              # Tipster-weighted win probabilities
    raceData.ts                        # Supabase data access (runners, quotes, races)
    recommendBet.ts                    # End-to-end recommendation pipeline
vercel.json                            # Cron schedule (every 5 minutes)
```

## Getting started

### Prerequisites

- Node.js >= 18.18
- A Supabase project

### Install

```bash
npm install
```

### Configure environment

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

| Variable                    | Description                                                            |
| --------------------------- | ---------------------------------------------------------------------- |
| `SUPABASE_URL`              | Your Supabase project URL.                                             |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key. **Server-side only** — it bypasses RLS.              |
| `CRON_SECRET`               | Shared secret required by the cron endpoint (sent as a Bearer token).  |

### Run

```bash
npm run dev
```

Then open http://localhost:3000.

## Scripts

| Script                 | Purpose                                |
| ---------------------- | -------------------------------------- |
| `npm run dev`          | Start the dev server.                  |
| `npm run build`        | Production build.                      |
| `npm run start`        | Run the production build.              |
| `npm run lint`         | Lint with ESLint (`next lint`).        |
| `npm run typecheck`    | Type-check with `tsc --noEmit`.        |
| `npm run format`       | Format with Prettier.                  |
| `npm run format:check` | Verify formatting without writing.     |

## How recommendations are produced

`recommendBet(race_id)` runs the full pipeline:

1. Fetch runners for the race with their latest decimal odds.
2. Fetch tipster selections for the race.
3. Build tipster-weighted model probabilities (normalized to sum to 1).
4. Compute expected value for each runner: `EV = prob * odds - 1`.
5. Pick the highest-EV runner.
6. Score confidence from EV, independent tipster support, and liquidity.
7. Size the stake with fractional Kelly (0.2), clamped to 0.1%–2% of bankroll.

The result is `{ horse_name, odds, model_prob, ev, confidence, stake }`.

## API

### `GET /api/recommend-bet?race_id=<id>`

Returns a single recommendation for one race.

- `200` — `{ horse_name, odds, model_prob, ev, confidence, stake }`
- `400` — missing `race_id`
- `404` — no priced runners for the race
- `500` — unexpected error

### `GET /api/cron/recommendations`

Refreshes recommendations for all of today's races and upserts them into the
`recommendations` table. Protected by `CRON_SECRET` when that variable is set.
Scheduled every 5 minutes via [vercel.json](vercel.json).

## Assumed database schema

These tables/columns are assumed by the data layer. Adjust the constants at the
top of [src/lib/raceData.ts](src/lib/raceData.ts) if your schema differs.

- `races` — `race_id`, `start_time`
- `runners` — `runner_id`, `race_id`, `horse_name`
- `runner_quotes` — `runner_id`, `race_id`, `odds_decimal`, `captured_at`
- `tipster_selections` — `runner_id`, `race_id`, `tipster_id`
- `recommendations` — `race_id` (unique), `horse_name`, `odds`, `model_prob`,
  `ev`, `confidence`, `stake`, `updated_at`

The upsert in the cron route requires a unique or primary-key constraint on
`recommendations.race_id`.

## Deployment

Designed for Vercel. The cron schedule in [vercel.json](vercel.json) runs every
5 minutes (requires a plan that supports sub-daily crons). Set `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, and `CRON_SECRET` as environment variables.

## Security notes

- `supabaseAdmin` uses the service-role key and **bypasses Row Level Security**.
  Only import it in server-side code (route handlers, server actions).
- The cron endpoint requires `CRON_SECRET`. Set it in every environment.
- The `recommend-bet` endpoint currently has no authentication. Add auth before
  exposing it publicly, since it returns staking guidance derived from
  service-role data access.
