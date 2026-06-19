# Morning Command Pack — 2026-06-19

> **One ordered list to start the day.** Run top to bottom. Every command is
> exact. Read-only checks come first; anything that writes is clearly tagged and
> appears **after** its dry-run. This file executes nothing by itself.
>
> Decision-support only — not betting advice. No auto-betting, no bet placement.

## Legend

| Tag | Meaning |
| --- | --- |
| 🟢 **READ-ONLY** | Safe. No DB writes, no file writes (prints only). |
| 📝 **WRITES FILE** | Writes a local report/CSV file only. Never touches the DB. |
| 🟡 **WORKING TREE** | Changes git working tree (pull). Review first. |
| 🔴 **WRITES DB (`--commit`)** | Mutates the database. Needs deliberate approval. |

## Set your variables first

Pick the race day you are operating. Examples below use today + Ascot —
substitute your real values.

```bash
# Windows PowerShell — use npm.cmd (npm.ps1 is blocked by execution policy).
# DATE = the meeting date you are working;  COURSE = the meeting.
#   e.g. DATE=2026-06-19  COURSE=Ascot
```

Dashboard URL for that day:
`http://localhost:3000/?date=2026-06-19&course=Ascot`

---

## 1. Git sync 🟡

```bash
git status
git fetch origin
git log --oneline -5
git pull --ff-only origin main
```

- Run `git status` **first**. If there is **uncommitted local work**, review it
  before pulling — do **not** stash/discard blindly.
- `git pull --ff-only` is non-destructive (it refuses anything but a clean
  fast-forward). If it refuses, stop and reconcile manually.

---

## 2. Safety check 🟢

```bash
npm.cmd run security:secrets-check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

- `security:secrets-check` scans for committed secrets (read-only).
- The four gates must all be green before you trust anything downstream.
- Confirm `git status` shows **no `.env*` / key / cert files staged**.

---

## 3. Environment check 🟢

```bash
npm.cmd run check:env
```

- Presence/booleans only — it never prints a secret value.
- Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RACING_API_USER`,
  `RACING_API_KEY`. `OPENAI_API_KEY` is optional (shadow-only GenAI).
- Exit 0 = all required present.

---

## 4. DB check 🟢

```bash
npm.cmd run check:db
```

- Read-only table/column probes (head requests, no rows pulled).
- Expect `PASS — 22/22 tables present`.

---

## 5. Migration status 🟢 (verify only — do **not** auto-apply)

```bash
npm.cmd run schema:launch-check
```

- Read-only. Reports any missing tables / columns / RPC functions and the exact
  migration files that would close each gap.
- **Applying** migrations is a deliberate, human step in the **Supabase SQL
  editor** — never `supabase db push` from this pack. Follow, in order:
  - [docs/MIGRATION_APPLY_PLAN_2026_06_19.md](MIGRATION_APPLY_PLAN_2026_06_19.md)
  - [docs/LAUNCH_SCHEMA_SYNC_RUNBOOK.md](LAUNCH_SCHEMA_SYNC_RUNBOOK.md)
- **Back up first**, apply one file at a time, re-run `schema:launch-check` after
  each. The RLS-hardening migration is applied **last**.

> Note: known gap = the two model-lock RPCs (`try_acquire_model_lock`,
> `release_model_lock`). They are **not wired into app code**, so the app is
> unaffected until you apply them. `field_coverage` has **no migration** — do not
> invent one.

---

## 6. Race-day readiness 🟢 → 📝 → 🔴

Run the read-only checks first, then (only if a refresh is actually needed) the
pipeline — **dry-run before commit**.

```bash
# 6a. Is there enough stored data for the dashboard to be useful?  🟢 READ-ONLY
npm.cmd run dashboard:ready -- --date 2026-06-19 --course Ascot

# 6b. Pre-day checklist/report for the day.  📝 WRITES FILE (reports/preflight-*.md)
npm.cmd run preflight:day -- --date 2026-06-19 --course Ascot

# 6c. Pipeline DRY-RUN — plans racecards/odds/model, writes NOTHING.  🟢 READ-ONLY
npm.cmd run pipeline:day -- --date 2026-06-19 --course Ascot
```

```bash
# 6d. Pipeline COMMIT — refreshes racecards/odds and runs the model.
#     🔴 WRITES DB (--commit).  Prerequisites: dev server running (Section 10)
#     AND CRON_SECRET set in .env.local.  Run ONLY when 6c looked right.
npm.cmd run pipeline:day -- --date 2026-06-19 --course Ascot --commit
```

- `pipeline:day` is **dry-run by default** (no `--commit` = no writes).
- Add `--allow-stale` only if you deliberately want to re-score against stale
  odds (normally do **not**).

---

## 7. Results settlement path 🟢 (dry-run; never writes here)

```bash
npm.cmd run results:auto -- --date 2026-06-19 --course Ascot
```

- Dry-run audit only. This phase **never writes the database** — even
  `--commit` is gated/reserved and is refused, so the automated free/standard
  result fetch is informational. (Free fallback is **today-only**.)
- The actual settlement write path for beta is the **manual CSV importer**
  (Section 8). If `results:auto` shows `plan_blocked` / not settleable, go to 8.

---

## 8. Manual CSV fallback 📝 → 🟢 → 🔴

Generate a template, fill in real finishing positions, dry-run, then commit.

```bash
# 8a. Generate a blank results CSV template for the day.  📝 WRITES FILE (data/*.csv)
npm.cmd run results:template -- --date 2026-06-19 --course Ascot --output data/results-2026-06-19-ascot.csv

# 8b. (Edit data/results-2026-06-19-ascot.csv by hand — fill finish positions / SP.)

# 8c. Import DRY-RUN — validates + reports, writes NOTHING.  🟢 READ-ONLY
npm.cmd run import:results -- --file data/results-2026-06-19-ascot.csv
```

```bash
# 8d. Import COMMIT — writes finish_pos / SP / status to the DB.
#     🔴 WRITES DB (--commit).  Run ONLY after 8c is clean and the CSV is real
#     (no EXAMPLE/placeholder rows — the importer refuses placeholders).
npm.cmd run import:results -- --file data/results-2026-06-19-ascot.csv --commit
```

---

## 9. Proof report 📝 WRITES FILE

```bash
# 9a. Proof-of-update snapshot for the day.  📝 reports/proof-day-*.md
npm.cmd run proof:day -- --date 2026-06-19 --course Ascot

# 9b. End-of-day performance report (run after results are settled).  📝 reports/day-report-*.md
npm.cmd run report:day -- --date 2026-06-19 --course Ascot
```

- Both are read-only against the DB; they only write a Markdown report file.

---

## 10. Launch smoke test 🟢

```bash
# 10a. Start the dev server (leave running in its own terminal).
npm.cmd run dev
```

Then open, and eyeball each:

- `http://localhost:3000/` — header shows **(Beta)**, "Static view", safety
  banner, lifetime accuracy.
- `http://localhost:3000/?date=2026-06-19&course=Ascot` — live race-day view:
  recommendations visible, stale flags present, settlement notes present, GenAI
  shows **"not configured (shadow-only)"** when no key.

Check for: no console/runtime errors, no broken links (`/how-it-works`,
`/leaderboard`), no write/commit buttons, mobile layout acceptable at ~375px.

---

## 11. Public beta checklist

- [ ] Gates green: `lint` / `typecheck` / `test` / `build` (Section 2).
- [ ] `check:env` exit 0; all REQUIRED vars present (Section 3).
- [ ] `check:db` PASS 22/22 (Section 4).
- [ ] `schema:launch-check` reviewed; migration decision recorded (Section 5).
- [ ] **Supabase RLS verified** on base + internal tables (anon has no
      read/write) — run the SQL in
      [docs/MIGRATION_APPLY_PLAN_2026_06_19.md](MIGRATION_APPLY_PLAN_2026_06_19.md)
      Section 1/Batch C. **This is the one true public-launch gate.**
- [ ] Dashboard loads at both URLs; stale/settlement/GenAI states correct (Section 10).
- [ ] Delete stray 0-byte junk files if present: `Remove-Item C, Start-Sleep, npm, while`.
- [ ] 18+ / BeGambleAware line visible in the public UI (or accepted as a fast-follow).
- [ ] No secrets staged; `.env.local` git-ignored.

---

## 12. Do-NOT-run list (unattended / morning)

Do **not** run these without explicit, deliberate intent — never as a "just in
case":

- 🔴 `npm.cmd run pipeline:day -- ... --commit` — only after a clean dry-run (6c)
  with the dev server up and `CRON_SECRET` set.
- 🔴 `npm.cmd run import:results -- ... --commit` — only after a clean dry-run (8c)
  on a real, non-placeholder CSV.
- 🔴 `npm.cmd run results:auto -- ... --commit` — gated/never writes; don't rely on it to settle.
- 🔴 `npm.cmd run seed:demo -- --confirm-demo` — writes synthetic demo data to the DB.
- 🔴 `supabase db push` / pasting migrations blindly — apply per the runbook, backup first, one at a time.
- 🟡 `git push` / `git push --force` / `git reset --hard` / `git stash drop` — no pushing or history rewriting from this pack.
- ❌ Never paste a secret value into a terminal, the Supabase SQL editor, logs, chat, or a commit.
- ❌ Never run `--commit` anything within **30 minutes** of a race off-time (race-day freeze).

---

*Generated as a documentation-only pack. It executes nothing, mutates no
database, and is not committed or pushed.*
