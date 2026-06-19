# Railway Race-Day Automation

> **Decision-support only — no auto-betting, no bet placement.** This automation
> refreshes *data* (racecards, odds, model runs, recommendations) on a schedule.
> It never places a bet, never enables auto-betting, and changes no model,
> staking, or recommendation logic. The **public UI stays read-only** — no public
> user can trigger a database write.
>
> Responsible use only — not betting advice.
> [GamCare](https://www.gamcare.org.uk) · [BeGambleAware](https://www.begambleaware.org).

## What this gives you

The operator no longer hand-runs `npm run pipeline:day -- --date … --course Ascot --commit`.
Instead, **Railway cron jobs** run one-off commands on a schedule and exit. Each
job is a **one-shot command** — there are **no infinite loops** (Railway does the
scheduling; the commands run once and return).

Three jobs, all on `*/5 * * * *` (every 5 minutes — naturally covers **T-15,
T-10, and T-5** before every race):

| Job name | Command (recommended, date-safe) | Writes DB? |
| --- | --- | --- |
| `pipeline-refresh` | `npm run race-day:refresh-today -- --course Ascot` | ✅ yes (backend only) |
| `t-minus-capture` | `npm run capture:t-minus -- --date "$(date -u +%F)" --course Ascot --minutes-before 5` | ❌ no (writes a report file) |
| `results-auto-check` | `npm run results:auto -- --date "$(date -u +%F)" --course Ascot` | ❌ no (dry-run) |

`race-day:refresh-today` resolves **today's UTC date** for you, so the pipeline
job needs no daily edits. For the other two, Railway's Linux cron shell expands
`$(date -u +%F)` to today's UTC date — also no daily edits.

> Preview anytime (read-only, writes nothing):
> `npm run railway:cron-plan -- --course Ascot`

---

## 1. Railway web service setup

1. **Deploy the app as a Railway web service** from this repo (Next.js).
   - Build: `npm run build` · Start: `npm run start` (Railway sets `PORT`).
2. Note the service's public URL, e.g. `https://your-app.up.railway.app`.
   This is the **base URL** the pipeline cron job calls.
3. The public dashboard is served read-only from that URL. Confirm it loads:
   `https://your-app.up.railway.app/`

## 2. Required environment variables

Set these on the Railway **service** (shared by the web app and the cron jobs).
**Never commit them; never paste secret values into logs or chat.**

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Supabase project URL (server-side). |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service-role key — **server-side only**, bypasses RLS. Never expose to the browser. |
| `RACING_API_USER` / `RACING_API_KEY` | yes | Racing API (racecards / results). |
| `CRON_SECRET` | yes (prod) | Bearer token that gates `/api/cron/*` + `POST /api/run-model`. The pipeline job needs it to authenticate its calls. |
| `BETFAIR_APP_KEY` / `BETFAIR_USERNAME` / `BETFAIR_PASSWORD` / `BETFAIR_CERT_PEM` / `BETFAIR_KEY_PEM` | for odds | Only needed by the odds step. |
| `PIPELINE_BASE_URL` | recommended | Base URL the refresh helper calls (e.g. `https://your-app.up.railway.app`). Defaults to `http://localhost:3000`. |
| `OPENAI_API_KEY` | optional | Shadow-only GenAI commentary; never model-active. |

> If you ever exposed these values, **rotate them** (Supabase key, CRON_SECRET,
> Racing API key, Betfair password, and re-issue the Betfair certificate/key).

## 3. Cron jobs — names, schedules, commands

Create three Railway cron jobs on the **same service** (so they share the env and
the codebase). All use the schedule `*/5 * * * *`.

### Job 1 — `pipeline-refresh`  🔴 WRITES DB

```bash
# Schedule: */5 * * * *
npm run race-day:refresh-today -- --course Ascot
```

- Resolves today's UTC date and runs the existing `pipeline:day --commit` once,
  then exits. Refreshes racecards + odds + model + recommendations.
- Needs `PIPELINE_BASE_URL` (the deployed web service) + `CRON_SECRET`.
- Explicit, date-pinned equivalent (must be edited each race day):
  `npm run pipeline:day -- --date 2026-06-19 --course Ascot --commit` 🔴

### Job 2 — `t-minus-capture`  🟢 read-only

```bash
# Schedule: */5 * * * *
npm run capture:t-minus -- --date "$(date -u +%F)" --course Ascot --minutes-before 5
```

- Read-only pre-off snapshot for audit. Writes a local report file only — **never
  the database**.

### Job 3 — `results-auto-check`  🟢 dry-run (no DB writes)

```bash
# Schedule: */5 * * * *
npm run results:auto -- --date "$(date -u +%F)" --course Ascot
```

- Dry-run settlement audit. `results:auto` **never writes** today (its `--commit`
  path is gated). See §6–§7 for the dry-run → commit story.

> ⚠️ **Race-day freeze:** if you change schema or deploy, avoid doing it within
> ~30 minutes of an off-time. The cron jobs themselves are safe to leave running.

## 4. Verify fresh odds / model on the public dashboard

After a `pipeline-refresh` run (give it a minute), open:

```text
https://your-app.up.railway.app/?date=2026-06-19&course=Ascot
```

Check the **Proof of update** panel:

- **Odds last updated** — should read "just now / Xm ago", not "stale".
- **Model last updated** — should advance after each refresh.
- **Racecards loaded: yes**, **Races / Runners** populated.

You can also dry-run the planner locally to see exactly what the jobs run:

```bash
npm run railway:cron-plan -- --date 2026-06-19 --course Ascot   # 🟢 prints only
npm run race-day:refresh-today -- --course Ascot --dry-run       # 🟢 spawns nothing
```

## 5. Test `results:auto` (dry-run)  🟢

Always start with the dry-run — it writes nothing:

```bash
npm run results:auto -- --date 2026-06-19 --course Ascot
```

Read the per-race audit. A `plan_blocked` / "not settleable" outcome means the
automated source can't settle (e.g. Standard-plan-only endpoint) — use the manual
CSV path below.

## 6. Switch `results:auto` from dry-run to `--commit`  🔴

```bash
# 🔴 WRITES DB (gated). Only meaningful once the auto-commit settlement phase is
# enabled; today it is refused and writes nothing.
npm run results:auto -- --date 2026-06-19 --course Ascot --commit
```

- `results:auto --commit` is **gated and currently never writes**. The **real,
  audited settlement write path** during beta is the manual CSV importer:

  ```bash
  npm run results:template -- --date 2026-06-19 --course Ascot --output data/results-2026-06-19-ascot.csv  # 📝 writes a CSV template
  # (fill in finishing positions / SP by hand)
  npm run import:results -- --file data/results-2026-06-19-ascot.csv            # 🟢 dry-run (validate)
  npm run import:results -- --file data/results-2026-06-19-ascot.csv --commit   # 🔴 WRITES DB
  ```

- **Dry-run before commit, always.** Never run a `--commit` settlement on an
  unvalidated CSV.

## 7. Safety guarantees (read this)

- **The public UI must remain read-only.** This automation adds **no** public
  write button and **no** public write route. Every database write happens inside
  a backend cron job authenticated by `CRON_SECRET` — never from a browser.
- **Decision-support only — no auto-betting, no bet placement.** Nothing here
  places a bet or enables auto-betting. The model, staking, and recommendation
  logic are unchanged; the jobs only refresh stored data.
- **One-shot, not loops.** Every Railway cron command runs once and exits.
  `race-day:refresh-today` spawns the pipeline a single time and returns. (The
  local `pipeline:watch` loop is for a developer's machine — **do not** use it on
  Railway.)
- **Secrets stay server-side.** The service-role key and `CRON_SECRET` are
  server-only env vars; they are never sent to the browser and never printed.

## 8. Verify the automation wiring (read-only)

```bash
npm run railway:cron-plan -- --course Ascot     # prints the exact jobs + schedules + URL
npm run check:env                               # confirms required env vars are present (booleans only)
npm run check:db                                # read-only DB health
```

---

*This document is operational guidance. The planner (`railway:cron-plan`) and the
`--dry-run` helper write nothing. The only DB writes come from the deliberately
scheduled, `CRON_SECRET`-authenticated backend cron jobs.*
