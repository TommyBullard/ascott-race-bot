# Tipster manual review — 2026-06-19 Royal Ascot
> ARCHIVE NOTE: This document is historical and specific to 2026-06-19 Ascot.
> Use `docs/RACE_DAY_RUNBOOK.md` for the current workflow and
> `CLAUDE.md` for authoritative AI assistant instructions.
A compliant, human-in-the-loop workflow to turn **public, manually verified**
tipster opinions into approved current selections, so the model can use real
consensus where it genuinely exists — and `NO_TIPSTER_CONSENSUS` clears only
where valid current picks are imported.

## Why NO_TIPSTER_CONSENSUS remains

`NO_TIPSTER_CONSENSUS` on a race means **there are no matched, approved current
selections** for it — not a negative signal. It clears only when:

1. a real, current (2026-06-19) runner-level tip is **manually verified** from a
   permitted public/licensed source,
2. it is **approved** by you,
3. it is **imported** into `tipster_selections`, and
4. the **model is rerun** so it can read the new selections.

Until then the model runs **market-only** for that race. This is correct and
honest — it never invents consensus.

## Source registry vs current selections

These are two different things:

- **Source registry** — [data/tipster-source-registry-2026-06-19.csv](../data/tipster-source-registry-2026-06-19.csv):
  *who* the candidate tipsters/sources are, their access class, correlation
  group, and (when verified) evidence/weighting. The strict-verification PDF is
  the higher-priority layer; the older research brief is secondary. **This is a
  registry, not a list of today's tips.** It never makes anything model-active.
- **Current selections** — the actual runner each tipster backs **for today**.
  Only these, once approved + imported, feed tipster consensus.

A source being in the registry does **not** mean it has a current pick.

## Step 1 — Manually fill the capture sheet

Use [data/tipster-opinions-2026-06-19-ascot-manual-review.csv](../data/tipster-opinions-2026-06-19-ascot-manual-review.csv)
and the [checklist](../data/tipster-manual-review-checklist-2026-06-19-ascot.md).
For each source you choose to use:

- Open the URL **yourself** (no tool fetches it). Confirm it opens **without
  login** and **no paywall** blocks the content.
- Fill `race_time` (HH:MM), `race_name`, `runner_name`, and a **short**
  `evidence_excerpt` (never the full article).
- Set `licence_status` only when verified (`public_allowed` / `manual` /
  `licensed`). Leave `unknown` otherwise — it stays blocked.
- Leave `review_status=pending` and `model_active_eligible=false` until you are
  sure.

**Do not** use blocked/login/paywalled content, copy full articles, or guess a
tip. The audit [data/tipster-source-audit-2026-06-19-ascot.json](../data/tipster-source-audit-2026-06-19-ascot.json)
marks paywalled/login sources (e.g. The Times, Tipstrr-style pool) as blocked.

## Step 2 — Approve rows

For a row you have personally verified, set `review_status=approved` and (only
if the licence permits) `model_active_eligible=true`.

## Step 3 — Run the read-only review

Reports counts only; imports nothing and writes no database:

```
npm run tipsters:review-opinions -- --file data/tipster-opinions-2026-06-19-ascot-manual-review.csv --registry data/tipster-source-registry-2026-06-19.csv
```

It reports: total / pending / approved / blocked / missing runner_name /
missing race_name·time / missing evidence / unknown·blocked licence /
model_active_eligible / likely matchable / PR-family rows.

## Step 4 — Create the approved CSV

Copy only your **verified + approved** rows into
`data/tipster-opinions-2026-06-19-ascot-approved.csv`, in the importer's format
(see [the approved example](../data/tipster-opinions-2026-06-19-ascot-approved.example.csv)):

```
meeting_date,course,off_time,horse_name,tipster_name,raw_affiliation,source_label
```

Map your manual-review cells: `off_time = race_time` (HH:MM),
`horse_name = runner_name`. The `.example.csv` cannot be imported — every row
contains `EXAMPLE`, which the importer refuses to commit.

## Step 5 — Import approved only

```
npm run import:tipster-selections -- --file data/tipster-opinions-2026-06-19-ascot-approved.csv --commit
```

The importer is dry-run without `--commit`, refuses any row containing
`EXAMPLE`, and inserts only rows whose race **and** runner resolve to real DB
rows. It never runs the model.

## Step 6 — Verify the match

```
npm run verify:tipster-match -- --date 2026-06-19 --course Ascot
```

Shows how many selections matched a real runner and which races would gain
consensus. Read-only.

## Step 7 — Rerun the model

```
npm run pipeline:day -- --date 2026-06-19 --course Ascot --commit
```

The next model run reads the new selections. Probability math, EV, staking, the
no-bet gate, and recommendations are unchanged — adding tipster consensus is an
input, not a maths change. No bet is ever placed.

## PR family duplicates

**The Profit Rocket, UNDERDOG Racing Tips, and ACTIVE Betting Hub are one
duplicated PR family** (`correlation_group=PR_family`). They must **not** count
as three independent votes. Keep only the representative (**The Profit Rocket**);
the ingestion-time correlation cap enforces a single family vote. This is a
de-duplication step, not a change to the probability model.

## What not to use

- Paywalled / login / restricted pages (e.g. The Times, Tipstrr/Betting
  Gods/Tipsters Empire current picks) unless you have a permitted, public,
  attributable excerpt.
- Full-article copies.
- Any GenAI-guessed or invented opinion.
- The research documents as if they were today's selections — they are a
  registry/quality/weighting/correlation basis only.

## Safety

This workflow performs **no scraping**, **no paywall bypass**, **no
fabrication**, **no probability/staking change**, **no auto-betting**, and **no
bet placement**. The public UI stays read-only. Every captured row defaults to
`review_status=pending` and `model_active_eligible=false` until you approve it.
