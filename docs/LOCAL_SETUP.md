# Local setup

How to set up and run **Ascott Race Bot** locally after a fresh Supabase reset.
This is a personal, research/decision-support tool — see the responsible-use note
at the end of [RACE_DAY_RUNBOOK.md](RACE_DAY_RUNBOOK.md).

> **Never commit secrets.** All credentials live in `.env.local`, which is
> git-ignored. Do not paste real keys into issues, chats, commits, or docs.

---

## 1. Prerequisites

- **Node.js >= 20.9.0** (see `engines` in [package.json](../package.json)). The
  scripts use Node's built-in `process.loadEnvFile`, which needs Node 20.9+.
- A **Supabase** project (Postgres).
- A **The Racing API** account (for live racecards / results).
- *(Optional)* a **Betfair** Exchange account (only for the live odds pipeline).

On Windows, run the commands below from **PowerShell** in the repo root
(`C:\Users\tommy\Desktop\Ascott Tips Bot\ascott-race-bot`). If your machine
blocks `npm.ps1`, use `npm.cmd` in place of `npm`.

---

## 2. Install dependencies

```powershell
npm install
```

---

## 3. Environment variables

Create `.env.local` in the repo root (copy the tracked template
[.env.example](../.env.example)). Every value is validated **lazily** — the dev
server starts even if some are blank, but a route that needs a missing key
returns a 500 like
`{ "ok": false, "error": "Missing environment variable: RACING_API_USER" }`.

| Variable | Required for | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | everything (DB) | Project URL, e.g. `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | everything (DB) | **Server-only**; bypasses RLS. Never expose to the browser or commit. |
| `RACING_API_USER` | racecards / results | HTTP Basic username |
| `RACING_API_KEY` | racecards / results | HTTP Basic password |
| `CRON_SECRET` | protecting cron + `/api/run-model` | Optional locally; when set, those routes require a bearer token |
| `BETFAIR_APP_KEY` | odds pipeline | Optional — leave blank if not testing odds |
| `BETFAIR_USERNAME` | odds pipeline | Optional |
| `BETFAIR_PASSWORD` | odds pipeline | Optional |
| `BETFAIR_CERT_PEM` | odds pipeline | Optional; PEM cert (see Betfair note below) |
| `BETFAIR_KEY_PEM` | odds pipeline | Optional; PEM private key |

Check which variables are set (prints **names + present/missing only — never
values**):

```powershell
npm run check:env
```

### Supabase setup

1. Create (or reset) your Supabase project.
2. From **Project Settings → API**, copy the **Project URL** into `SUPABASE_URL`
   and the **service_role** secret into `SUPABASE_SERVICE_ROLE_KEY`.
   Use the secret key (`sb_secret_…` or a legacy `eyJ…` JWT), **not** a
   publishable key.
3. Apply the SQL under [supabase/migrations/](../supabase/migrations/) (Supabase
   SQL editor, or `supabase db push`). **Note:** the repo migrations only *ALTER*
   the model tables and *create* `tipster_selections`; the base tables
   (`races`, `runners`, `market_snapshots`, `runner_quotes`, `model_runs`,
   `model_runner_scores`, `recommendations`, `bankroll_ledger`, `tipsters`,
   `tipster_aliases`, `tipster_priors`, `tipster_review_queue`) must already
   exist in your project. After a **fresh reset**, verify what is present with
   the health check below before relying on the app.

### Racing API setup

1. Sign up at the official, paid The Racing API and choose a plan that includes
   `/v1/racecards/standard` and `/v1/results` (Standard plan or higher).
2. Put your credentials in `RACING_API_USER` / `RACING_API_KEY`.
3. The adapter is ToS-compliant by design (official documented endpoints; no
   scraping) and rate-limited under the API's published limits.

### Betfair setup (PAUSED)

> **Certificate setup is currently paused.** The live odds pipeline
> (`/api/cron/odds`) needs Betfair cert-based login, but you can run everything
> else — racecards, model runs, the tipster importer, the dashboard, and the
> explanation panel — **without** Betfair by using synthetic local odds (see the
> demo seed in the runbook).
>
> When you resume: provide `BETFAIR_APP_KEY`, `BETFAIR_USERNAME`,
> `BETFAIR_PASSWORD`, and the `BETFAIR_CERT_PEM` / `BETFAIR_KEY_PEM` PEM strings.
> Treat the cert + key as secrets — never log, print, or commit them. (Platforms
> that strip newlines accept literal `\n` sequences; the app restores them at
> request time.) Do not store certificates inside the repo.

### CRON_SECRET generation

`CRON_SECRET` gates the cron routes (`/api/cron/*`) and the DB-mutating
`POST /api/run-model`. Leave it blank for open local/dev behaviour, or set a
random value to exercise the auth path. Generate one (the value is printed once
so you can paste it into `.env.local` — treat it as a secret):

```powershell
# Node (cross-platform)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# or PowerShell
[Convert]::ToHexString((1..32 | ForEach-Object { Get-Random -Max 256 }))
```

When set, send it as a bearer token: `Authorization: Bearer <CRON_SECRET>`.

---

## 4. Run the app

```powershell
npm run dev
```

Open <http://localhost:3000>. If port 3000 is busy, Next prints the actual port
in the startup banner (e.g. `http://localhost:3001`) — use that instead.

To detect what is listening on the default port:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3000,3001 | Select-Object LocalPort, OwningProcess
```

---

## 5. Quality gates

Run before committing:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

All four should pass. `npm test` uses the repo's built-in runner
(`tsx scripts/tests.ts`) — no extra framework.

---

## 6. Fresh-schema verification

After a Supabase reset, confirm the DB has the tables/columns the app expects
(**read-only** — performs no writes, prints no secrets):

```powershell
npm run check:db
```

It probes each required table + column, prints a **PASS/FAIL** summary with any
missing tables/columns, and emits read-only SQL you can run in the Supabase SQL
editor to confirm the things the REST API cannot introspect (index existence —
including `tipster_selections_dedupe_idx` — and RLS status).

A complementary read-only column inspector:

```powershell
npm run inspect:schema
```

---

## 7. Common errors

| Symptom | Cause | Fix |
| --- | --- | --- |
| `{ "error": "Missing environment variable: RACING_API_USER" }` (500) | Racing API creds absent | Add `RACING_API_USER` / `RACING_API_KEY` to `.env.local`, then **restart** `npm run dev` (env is read at startup). Confirm with `npm run check:env`. |
| `curl: (7) Failed to connect to localhost port 3000` | Dev server not running, or on another port | Start `npm run dev`; check the banner for the real port; verify with the `Get-NetTCPConnection` command above. |
| `{ "error": "Unauthorized" }` (401) from a cron route or `/api/run-model` | `CRON_SECRET` is set but the request had no/!wrong bearer | Send `Authorization: Bearer <CRON_SECRET>`, or unset `CRON_SECRET` for open local/dev. |
| `ENOENT … tipster-selections.csv` (importer) | The CSV path is missing/typo'd | Pass a real file: `npm run import:tipster-selections -- --file data/your.csv`. Start from [data/tipster-selections.example.csv](../data/tipster-selections.example.csv). |
| `Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY` (scripts) | Supabase env absent | Fill both in `.env.local`. |
| `relation "public.<table>" does not exist` | Base schema missing after a fresh reset | Create/restore the base tables, then re-run `npm run check:db`. |

---

## Where things live

- Routes: [src/app/](../src/app/) (dashboard `page.tsx`, API under `api/`).
- Pipeline/data access: [src/lib/](../src/lib/).
- Operational scripts: [scripts/](../scripts/).
- DB migrations: [supabase/migrations/](../supabase/migrations/).
- Architecture + model overview: [../README.md](../README.md).
