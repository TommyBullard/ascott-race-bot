# Tipster candidate review

How to safely capture, review, and approve automated/semi-automated tipster
picks (Phase 4A) — **without** scraping, without GenAI, and without anything
reaching the model until you approve it.

> **Responsible use — read first.** This is a personal research / decision-support
> tool. It does **not** predict winners and offers **no guaranteed profit**.
> Capturing a tipster's pick here is a note for review, not advice to bet. All
> betting involves risk; if gambling stops being fun, seek support (e.g. GamCare /
> BeGambleAware).

Prerequisites: [LOCAL_SETUP.md](LOCAL_SETUP.md) (env vars, `npm install`,
Supabase) plus the Phase 4A migration applied
([supabase/migrations/20260616000000_tipster_source_registry_and_candidates.sql](../supabase/migrations/20260616000000_tipster_source_registry_and_candidates.sql)).
Commands assume PowerShell in the repo root; use `npm.cmd` if `npm` is blocked.
The tool reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `.env.local`;
credentials are never logged.

---

## Why this exists (and what it deliberately does NOT do)

The model reads its tipster signal from one table: `tipster_selections`. To bring
in picks from other sources *safely*, Phase 4A adds a **review queue** in front
of that table so nothing is trusted automatically:

- A pick is captured as a **candidate** in `tipster_selection_candidates`.
- The model **never reads candidates** — only `tipster_selections`. So a captured
  pick has **zero** effect on any recommendation until you approve it.
- Approval is **operator-driven and explicit**: it only ever happens when you run
  the approve command **with `--commit`**, and only from a **registered, approved
  source**.

This tool does **not** scrape websites, does **not** call any GenAI, does **not**
auto-approve anything, and changes **no** model maths or staking. It only records
what you give it and, on your explicit approval, copies a resolved pick into
`tipster_selections`.

---

## The two tables

### Candidate source registry (`tipster_source_registry`)

An **allow-list** of where picks may come from. A source is registered first and
is **not trusted until you approve it** (`is_approved` defaults to `false`). A
candidate can only be approved when its `source_label` is present here **and**
approved — so picks can never enter the model from an unvetted feed.

| Column | Meaning |
| --- | --- |
| `source_label` | Stable machine label, e.g. `racing-post-tips` (unique). |
| `source_name` | Human-readable name, e.g. `Racing Post — Tips`. |
| `source_url` | Optional reference URL for provenance. |
| `is_approved` | Trust flag — `false` until you approve it (never automatic). |
| `notes` | Why it's trusted / ToS notes / anything for audit. |
| `approved_at` | When approval was granted (null while unapproved). |

### Candidate queue (`tipster_selection_candidates`)

Raw, as-captured picks awaiting review. The pick is stored verbatim and only
resolved to a real race/runner at **approval** time (so you can capture a pick
even before the racecard is ingested). Provenance is preserved on every
candidate: **`source_label`, `source_url`, and `source_name`** are all stored.

---

## Candidate status meanings

| Status | Meaning |
| --- | --- |
| `pending` | Captured and awaiting review. **Default.** Not seen by the model. |
| `approved` | You approved it; a row was written to `tipster_selections` and the model will read it on the next run. The resolved `race_id` / `runner_id` / `tipster_id` are recorded on the candidate for audit. |
| `rejected` | You decided not to use it. It never enters `tipster_selections`. |

Important: a candidate that **cannot** be resolved or is **not** from an approved
source is **not** auto-rejected — it simply **stays `pending`** (on the
watchlist) so you can fix the source/details and review it again later. Only an
explicit `--reject-candidate` moves a pick to `rejected`.

---

## Workflow at a glance

```text
register source ──approve source──┐
                                  ▼
capture candidate ──review──► approve (--commit) ──► tipster_selections ──► model
       │                          │
       └─────────── reject ───────┴──► stays out of the model
```

Everything is **dry-run by default**. Every write command prints what it *would*
do and writes nothing unless you add `--commit`.

---

## 1. Register and approve a source

Register the source first (it is created **unapproved**):

```powershell
npm run review:tipster-candidates -- --add-source `
  --source-label racing-post-tips `
  --source-name "Racing Post — Tips" `
  --source-url https://www.racingpost.com/tips/ `
  --note "Public tips column; ToS reviewed" --commit
```

Then approve it explicitly (separate, deliberate step):

```powershell
npm run review:tipster-candidates -- --approve-source racing-post-tips --commit
```

List sources and their approval state any time:

```powershell
npm run review:tipster-candidates -- --list-sources
```

> Until a source is approved, any candidate from it **cannot** be approved — it
> stays on the watchlist.

---

## 2. Capture a candidate (pending review)

Add a pick to the queue. Provide the provenance you have — `--source-label`
links it to the registry; `--source-url` / `--source-name` are preserved for
audit:

```powershell
npm run review:tipster-candidates -- --add-candidate `
  --meeting-date 2026-06-16 --course Ascot --off-time 14:30 `
  --horse "Some Horse" --tipster "Some Tipster" `
  --source-label racing-post-tips `
  --source-url https://www.racingpost.com/tips/ `
  --source-name "Racing Post — Tips" --commit
```

> **`off_time` is UTC.** Use the race's **stored** off time (UTC), e.g. a 2:30pm
> BST Royal Ascot race is `13:30`. The dashboard or
> `npm run import:tipster-selections -- --list-races --date <date>` shows it.

A candidate with no `--source-label` is still captured, but it **cannot be
approved** until you link it to a registered, approved source.

---

## 3. Dry-run review

List what's pending (optionally filter by source):

```powershell
npm run review:tipster-candidates -- --list-candidates --status pending
npm run review:tipster-candidates -- --list-candidates --status pending --source racing-post-tips
```

Dry-run an approval to see **exactly** what would be written — **no `--commit`,
so nothing changes**:

```powershell
npm run review:tipster-candidates -- --approve-candidate <id>
```

The dry-run resolves the race + runner and prints the resulting
`race_id` / `runner_id` / `tipster_id` / `source_label`, or tells you precisely
why it can't be approved (unapproved source, unresolved race, ambiguous runner,
etc.). Fix the candidate or the source and re-run the dry-run until it's clean.

### How matching works (exact only — never fuzzy)

Approval resolves the raw pick to real rows using the **same conservative
matching as the rest of the pipeline**:

- **Race** — among that day's races, exactly one must match on **normalised
  course** (so "Royal Ascot" matches "Ascot") **and** the UTC off-time instant.
  Zero matches or more than one → **not approved**, candidate stays `pending`.
- **Runner** — within that race, the horse name must match exactly one runner by
  **exact normalised name** (no partial/fuzzy match). No match, or two runners
  normalising to the same name (ambiguous) → **not approved**, stays `pending`.

Nothing is ever guessed. If a pick won't resolve, it remains on the watchlist
until the data is right.

---

## 4. Approve (writes to `tipster_selections`)

Only after a clean dry-run, add `--commit`:

```powershell
npm run review:tipster-candidates -- --approve-candidate <id> --commit
```

On commit it:

1. Re-checks the trust gate (source registered **and** approved).
2. Resolves the race + runner exactly (as above).
3. Inserts one row into `tipster_selections` (idempotent — `upsert` with
   `ignoreDuplicates` on `race_id, runner_id, raw_tipster_name`, so approving the
   same pick twice never double-counts it).
4. Marks the candidate `approved` and records the resolved `race_id` /
   `runner_id` / `tipster_id` for audit.

The pick now becomes part of the tipster consensus **on the next model run**.
Only `source_label` carries onto the selection (the sole provenance column on
`tipster_selections`); `source_url` / `source_name` stay on the candidate row.

To reject instead:

```powershell
npm run review:tipster-candidates -- --reject-candidate <id> --note "off the pace" --commit
```

---

## What counts as acceptable evidence to approve

Approve a candidate only when **all** of these hold:

- The pick comes from a **registered, approved** source you actually trust — a
  real, attributable, **ToS-compliant** origin (a public tips column, your own
  notes, a service you subscribe to). Record *why* in the source `notes`.
- You can point to the **specific** pick (a `source_url` or a clear reference),
  not a vague recollection.
- The race and runner **resolve exactly** in the dry-run (no ambiguity, no "close
  enough").
- Capturing/using the pick does **not** breach the source's terms — no scraping
  of protected, paywalled, logged-in, or private (Telegram/Discord) content.

If any of those is shaky, **don't approve** — leave it pending or reject it.

## What should stay watchlist-only

Keep a candidate `pending` (or reject it) when:

- The source isn't registered/approved yet, or you're still assessing it.
- The pick can't be resolved unambiguously (wrong/missing off time, a horse
  name that doesn't match, a non-runner).
- The provenance is weak — a screenshot with no link, a forwarded message, an
  unverifiable "tip".
- The terms of access are unclear or would require scraping/bypassing a login or
  paywall.

The watchlist exists precisely so uncertain picks can sit safely **outside** the
model until you're sure.

---

## How this preserves the manual edge

The results that came from **hand-curated** tipster selection (e.g. a carefully
chosen Cheltenham shortlist) came from a human deciding *who* to trust and *which*
picks to back — not from indiscriminately ingesting every tip available. This
review queue keeps that discipline intact while letting you capture picks faster:

- **Human-in-the-loop by construction.** Capture is cheap and safe (it never
  touches the model), but **promotion to the model is a deliberate act** — an
  approved source plus an explicit `--commit` approval.
- **Provenance on every pick.** `source_label` / `source_url` / `source_name`
  mean every selection is attributable, so you can audit and roll back by source.
- **No silent drift.** Because candidates never auto-approve and the model only
  reads `tipster_selections`, the model's tipster signal still reflects *your*
  judgement — the same judgement that produced the manual edge — just with less
  manual data-entry friction.

In short: it scales the *capture*, not the *trust*. The trust decision stays
with you.

---

## Rollback

Approved picks carry their `source_label` into `tipster_selections`, so a batch
is cleanly removable. **Preview first** (Supabase SQL editor):

```sql
select count(*) from public.tipster_selections where source_label = 'racing-post-tips';
delete from public.tipster_selections where source_label = 'racing-post-tips';
```

Re-running the model after a rollback refreshes the affected races' picks from
the remaining data (append-only history keeps the older runs). The candidate rows
themselves remain for audit; reject them if you no longer want them on the
watchlist.

---

## Never fabricate or force a pick

Only ever record picks that a real, attributable source actually made. Do **not**
invent a tip, and do **not** hand-edit the database to force a candidate into
`tipster_selections` to bypass the resolve/approve checks — that defeats the
provenance and exact-matching guarantees the queue exists to provide. If a pick
won't resolve or its source isn't trusted, it belongs on the watchlist, not in
the model.
