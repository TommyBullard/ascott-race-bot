# Windows command helper

Copy-paste commands for calling the app's local routes from **Windows**
(PowerShell or cmd), plus how to read the results. This complements
[RACE_DAY_RUNBOOK.md](RACE_DAY_RUNBOOK.md) (what each step does) and
[LOCAL_SETUP.md](LOCAL_SETUP.md) (env + setup).

> Nothing here changes backend behaviour. The cron routes are **GET** and are
> open in local/dev unless `CRON_SECRET` is set. **Never paste your real
> `CRON_SECRET`** into shared output — use the `<CRON_SECRET>` placeholder.

A print-only helper (it only **prints** commands, never runs them):

```powershell
npm run local:racecards          # prints the local commands (default port 3000)
npm run local:racecards -- 3001  # same, for port 3001
```

---

## Two-terminal workflow

### Terminal 1 — start the dev server

```powershell
npm run dev
```

Leave this running. Note the URL it prints (e.g. `http://localhost:3000`).

### Terminal 2 — call a route

```powershell
curl http://localhost:3000/api/cron/racecards
```

Other routes work the same way (see the table at the bottom).

---

## With the `CRON_SECRET` header

Only needed when you have set `CRON_SECRET` in `.env.local`. Replace
`<CRON_SECRET>` with your value (don't share it):

**cmd** (`curl.exe` ships with Windows 10/11):

```cmd
curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/racecards
```

**PowerShell** — `curl` is an *alias* for `Invoke-WebRequest` and does **not**
accept `-H`. Use real `curl.exe`, or the native cmdlet:

```powershell
# Force the real curl binary:
curl.exe -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/racecards

# Or the native PowerShell cmdlet:
Invoke-WebRequest -Uri "http://localhost:3000/api/cron/racecards" `
  -Headers @{ Authorization = "Bearer <CRON_SECRET>" } -UseBasicParsing |
  Select-Object -ExpandProperty Content
```

`POST /api/run-model` needs `-Method POST` (and the race id as a query param):

```powershell
Invoke-WebRequest -Method POST `
  -Uri "http://localhost:3000/api/run-model?race_id=<race_id>" -UseBasicParsing |
  Select-Object -ExpandProperty Content
```

---

## PowerShell `Invoke-WebRequest` equivalent (no auth)

```powershell
Invoke-WebRequest -Uri "http://localhost:3000/api/cron/racecards" -UseBasicParsing |
  Select-Object -ExpandProperty Content
```

`-UseBasicParsing` avoids a dependency on Internet Explorer's DOM engine and
keeps output predictable. `Select-Object -ExpandProperty Content` prints just the
JSON body.

---

## Why `GET /api/cron/racecards` "doesn't work"

`GET /api/cron/racecards` is **REST shorthand** (HTTP method + path), not a shell
command. If you type it into cmd or PowerShell, the shell tries to run a program
literally named `GET` and fails (`'GET' is not recognized…` / `The term 'GET' is
not recognized…`). To actually make the request you need an HTTP client:

- cmd / PowerShell: `curl http://localhost:3000/api/cron/racecards`
- PowerShell native: `Invoke-WebRequest -Uri "http://localhost:3000/api/cron/racecards" -UseBasicParsing`

Also note: in **PowerShell**, `curl` is aliased to `Invoke-WebRequest`, so flags
like `-H` / `-X` fail there — use `curl.exe` (the real binary) or the cmdlet form
shown above.

---

## Detecting the port (3000 vs 3001)

Next uses **3000** by default and falls back to **3001** (or higher) when 3000 is
busy — it prints the chosen port in the Terminal 1 banner
(`- Local: http://localhost:3001`). To check what is listening:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3000,3001 |
  Select-Object LocalPort, OwningProcess
```

Identify the owning process:

```powershell
Get-Process -Id (Get-NetTCPConnection -State Listen -LocalPort 3000).OwningProcess
```

If you get `curl: (7) Failed to connect to localhost port 3000`, the server is
either not running or is on a different port — check the banner and retry with
the right port.

---

## Checking Supabase row counts after each step

Run these **read-only** queries in the Supabase SQL editor after each pipeline
step to confirm it wrote what you expected.

After `racecards`:

```sql
select count(*) as races_today
from public.races
where meeting_date = (now() at time zone 'utc')::date;

select count(*) as runners_total from public.runners;
```

After `odds`:

```sql
select count(*) as snapshots from public.market_snapshots;
select count(*) as quotes    from public.runner_quotes;

select race_id, snapshot_time, source_label
from public.market_snapshots
order by snapshot_time desc
limit 10;
```

After `run-model` (or `npm run run:model -- <race_id>`):

```sql
select count(*) as current_runs from public.model_runs where is_current = true;
select count(*) as recommendations from public.recommendations where is_current = true;
```

After importing tipster selections:

```sql
select count(*) as selections from public.tipster_selections;
select source_label, count(*) from public.tipster_selections group by source_label order by 2 desc;
```

You can also run the read-only health check from a terminal (no writes, no
secrets printed):

```powershell
npm run check:db
```

---

## Local route reference

| Route | Method | Notes |
| --- | --- | --- |
| `/api/cron/racecards` | GET | `?day=tomorrow` optional. Needs Racing API env. |
| `/api/cron/odds` | GET | Needs Betfair env (paused). |
| `/api/cron/results` | GET | Needs Racing API env. |
| `/api/cron/tipster-discovery` | GET | Needs Racing API env. |
| `/api/run-model?race_id=<id>` | POST | Writes a model run. Only Supabase needed. |
| `/api/recommendations` | GET | Dashboard data (read-only). |
| `/api/accuracy` | GET | Live accuracy (read-only). |

All cron routes + `/api/run-model` accept `Authorization: Bearer <CRON_SECRET>`
when the secret is set; otherwise they are open in local/dev.
