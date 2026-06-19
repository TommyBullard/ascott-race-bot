# Full intelligence mode — 2026-06-19 Ascot (operator runbook)

**Safest possible "full intelligence" Racing Bot mode.** Every intelligence
layer is wired, but only the layers proven safe are live. This runbook is the
single source of operator commands for the day.

> **Hard invariants (unchanged by this mode):** no probability-math change, no
> staking change, no recommendation-logic change, no auto-betting, no bet
> placement. The public dashboard stays read-only. GenAI is never model-active.
> No ML model is promoted live. Generated with all four subsystems verified
> read-only/offline on 2026-06-19.

---

## What is LIVE vs SHADOW (read this first)

| Layer | State | Notes |
| --- | --- | --- |
| Market-implied + rules model (probability, EV, confidence) | **LIVE** | Unchanged. The only thing that drives recommendations + Kelly stake. |
| Tipster **selections** (quality-weighted into model probability) | **LIVE (wired) — but INERT today** | Model-active in code, but 0 selections match today → no effect until imported (see §2). |
| No-bet gate / stake suppression (data-quality, EV, consensus) | **LIVE** | Unchanged safety gate. Can zero a stake. |
| Auto-refresh (Railway cron) | **LIVE (when deployed)** | Refreshes stored data only; never bets (see §1). |
| Tipster **consensus / alignment / dynamic weighting** | **SHADOW** | Stored/among observability only; does not change selection or stake. |
| GenAI commentary | **SHADOW** | `model_active=false`, review-gated; not surfaced until a human approves (see §3). |
| ML / neural shadow model | **SHADOW (NO-GO)** | Not promoted; readiness 38.6/100 (see §4). |

---

## 1. Railway cron verification (auto-refresh every 5 minutes)

Verify (read-only, prints the plan, runs nothing):

```bash
npm run railway:cron-plan
```

Three **one-shot** jobs on `*/5 * * * *` (each runs once and exits — no infinite loop):

| Job | Command | Writes? |
| --- | --- | --- |
| 1 — Pipeline refresh (racecards + odds + model + recommendations) | `npm run race-day:refresh-today -- --course Ascot` | **DB write** via CRON_SECRET-gated cron endpoints |
| 2 — T-minus capture (pre-off snapshot) | `npm run capture:t-minus -- --date 2026-06-19 --course Ascot --minutes-before 5` | local report file only |
| 3 — Results auto-check (settlement audit) | `npm run results:auto -- --date 2026-06-19 --course Ascot` | dry-run only (no DB) |

**Railway setup:** set `PIPELINE_BASE_URL` to the deployed web service URL and
`CRON_SECRET` (already present in env). Only Job 1 writes, and only via the
authenticated backend — **no public user can trigger a write, and nothing places a bet.**

---

## 2. Today's tipster import (make tipster support model-active)

**Status now:** 0 selections match today → **every race is `NO_TIPSTER_CONSENSUS`**
(`npm run verify:tipster-match -- --date 2026-06-19 --course Ascot` confirms 0/7).
Tipster support is model-active **in code** but **inert** until real picks are matched.

Template (real today's runners + off-times; `EXAMPLE` tipster fields block `--commit`):
[data/tipster-selections-2026-06-19-ascot.csv](../data/tipster-selections-2026-06-19-ascot.csv)
· [README](../data/tipster-selections-2026-06-19-ascot.README.md)

Dry-run today already matches all 7 rows to races + runners
(`rows_insertable: 7`, `skipped_unmatched_*: 0`, `placeholder_example_present: true`).

**Operator workflow (do NOT fabricate picks; licensed/ToS-compliant sources only):**

```bash
# 1. Replace the EXAMPLE rows in the template with REAL tipster picks (keep real runner names).
# 2. DRY-RUN (read-only) — confirm matched count + 0 skipped + EXAMPLE guard cleared:
npm run import:tipster-selections -- --file data/tipster-selections-2026-06-19-ascot.csv
# 3. WRITE (operator approval) — only after the EXAMPLE guard clears:
npm run import:tipster-selections -- --file data/tipster-selections-2026-06-19-ascot.csv --commit
# 4. Verify consensus would form (read-only):
npm run verify:tipster-match -- --date 2026-06-19 --course Ascot
# 5. The next pipeline/model run consumes the selections (quality-weighted by tipster_priors when present).
```

After step 3+5, matched runners feed model probability and `NO_TIPSTER_CONSENSUS`
clears for those races. **No model math, staking, or recommendation logic changes** —
the engine just receives the inputs it already reads.

---

## 3. GenAI shadow commentary (OPENAI_API_KEY configured)

`OPENAI_API_KEY` is present (`check:env` → 11/11). Generation is gated behind `--live`,
storage behind `--commit`; the key is never printed.

```bash
# Offline plan (free, no API call, no writes):
npm run genai:commentary -- --date 2026-06-19 --course Ascot
# LIVE generate (calls OpenAI, NO writes) — produces shadow candidates:
npm run genai:commentary -- --date 2026-06-19 --course Ascot --live
# LIVE + STORE pending candidates for human review (writes model_active=false, review_status=pending):
npm run genai:commentary -- --date 2026-06-19 --course Ascot --live --commit
```

**Live run output (2026-06-19, no `--commit`):** 20 eligible (race × kind),
**7 candidates generated, 13 rejected** by the guardrails (ungrounded numbers e.g.
`"58%"`, and over-length notes). Nothing was written.

**Visibility:** the dashboard shows a read-only "AI commentary (shadow)" panel on
every race, currently the empty-state **"No reviewed AI shadow commentary available."**
Commentary becomes visible ONLY after: `--live --commit` (store pending) → a human
sets `review_status='approved'` on a vetted row in Supabase (out-of-band; there is
no public approve button). It is **never model-active** and **never betting advice**.

---

## 4. ML evaluation (2026-06-16 → 2026-06-18 Ascot)

```bash
npm run ml:promotion-audit -- --input data/exports/training-data-2026-06-16-to-2026-06-18-ascot.csv
```

Report: [reports/ml-promotion-audit-2026-06-16-to-2026-06-18-ascot.md](../reports/ml-promotion-audit-2026-06-16-to-2026-06-18-ascot.md)

- **Verdict: NO-GO (remain shadow). Readiness 38.6 / 100** (ramp threshold 70).
- 21 settled races (one course) « 100-race minimum — structurally too small.
- **Model rank 1 ≡ Market favourite** (37.5% strike, +55.5% ROI) → **zero edge**.
- Calibration is good (Brier 0.0479); confidence band non-discriminating; no-bet
  gate not proven protective; tipster signal too sparse.
- **No ML model may be promoted, made model-active, or allowed to influence live
  recommendations, EV, staking, or ranking** on this evidence.

---

## 5. Dashboard status summary

`http://localhost:3000/?date=2026-06-19&course=Ascot` (deployed: the Railway web service URL)

- **Live mode** — auto-refreshing read-only data every 45s.
- Safety banner: *"Decision-support only — not betting advice. No auto-betting and
  no bet placement, and this page is read-only."*
- 7 race cards (model pick / market favourite / EV / confidence / no-bet where gated).
- 7 "AI commentary (shadow)" panels, all empty-state (no approved commentary yet).
- **No bet-placement controls** of any kind (only the dev-tools overlay in local dev).

---

## 6. Exact operator command sequence (safe order)

```bash
# A. Pre-flight (read-only)
npm run check:env
npm run check:db
npm run railway:cron-plan

# B. Tipster (after filling REAL picks into the template)
npm run import:tipster-selections -- --file data/tipster-selections-2026-06-19-ascot.csv          # dry-run
npm run import:tipster-selections -- --file data/tipster-selections-2026-06-19-ascot.csv --commit  # WRITE
npm run verify:tipster-match -- --date 2026-06-19 --course Ascot

# C. Refresh model so tipster inputs take effect (date-safe; CRON_SECRET + PIPELINE_BASE_URL)
npm run race-day:refresh-today -- --course Ascot

# D. GenAI shadow commentary (optional; spends OpenAI credit)
npm run genai:commentary -- --date 2026-06-19 --course Ascot --live            # generate, no write
npm run genai:commentary -- --date 2026-06-19 --course Ascot --live --commit   # store pending for review
#   then approve vetted rows out-of-band in Supabase (review_status='approved')

# E. ML audit (read-only; informational — stays NO-GO/shadow)
npm run ml:promotion-audit -- --input data/exports/training-data-2026-06-16-to-2026-06-18-ascot.csv
```

Nothing in this runbook places a bet, changes the model/staking/recommendation
logic, promotes ML, or makes GenAI model-active.
