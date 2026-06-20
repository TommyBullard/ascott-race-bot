# Tipster manual-review checklist — 2026-06-19 Royal Ascot

> Source-compliant, human-in-the-loop. No scraping, no paywall bypass, no
> fabrication. Every captured row stays `review_status=pending` and
> `model_active_eligible=false` until you explicitly approve it.

Work through **one source at a time** from
[data/tipster-source-audit-2026-06-19-ascot.json](tipster-source-audit-2026-06-19-ascot.json),
filling [data/tipster-opinions-2026-06-19-ascot-manual-review.csv](tipster-opinions-2026-06-19-ascot-manual-review.csv).

## Per-source checklist

For each source row:

- [ ] **Open the URL manually** in your own browser (do not let any tool fetch it).
- [ ] **Confirm it opens without login** — if it asks you to sign in, stop and mark it `blocked_login`. Do not use it.
- [ ] **Confirm no paywall** blocks the content — if the tip is behind a paywall (e.g. The Times), stop and mark it `blocked_login`. Do not use it.
- [ ] **Identify the tipster name** (e.g. Templegate, Newsboy, Jon Vine, Brian Healy) and put it in `tipster_name`.
- [ ] **Identify the race time and race name** for 2026-06-19 Ascot, and put them in `race_time` (HH:MM) and `race_name`.
- [ ] **Identify the runner name** they actually tip, and put it in `runner_name`. If there is no clear runner-level pick, leave it blank — do **not** guess.
- [ ] **Capture only a short evidence excerpt / reference** in `evidence_excerpt` (one short attributable phrase, never the full article).
- [ ] **Set `licence_status`** only when you have verified it: `public_allowed`, `manual`, or `licensed`. Leave `unknown` otherwise (it will stay blocked from model use).
- [ ] **Keep `review_status=pending`** until you have personally checked the row. Only change to `approved` when you are sure.
- [ ] Leave `model_active_eligible=false` unless the row is fully verified AND approved.

## Hard rules — do not break

- [ ] Do **not** use blocked / login / paywalled content.
- [ ] Do **not** copy full articles — short attributable excerpts only.
- [ ] Do **not** guess tips or invent a tipster's opinion.
- [ ] Do **not** perform any betting action — this workflow never places, suggests, or sizes a bet.
- [ ] Do **not** count the PR family (The Profit Rocket / UNDERDOG Racing Tips / ACTIVE Betting Hub) as three votes — they are one `PR_family` group; keep only the representative (The Profit Rocket).

## When a row is fully verified

1. Set `runner_name`, `race_time`, `race_name`, `evidence_excerpt`, `licence_status`.
2. Set `review_status=approved` and (only if permitted) `model_active_eligible=true`.
3. Run the read-only review (reports counts, imports nothing):
   ```
   npm run tipsters:review-opinions -- --file data/tipster-opinions-2026-06-19-ascot-manual-review.csv --registry data/tipster-source-registry-2026-06-19.csv
   ```
4. Copy only the verified + approved rows into
   `data/tipster-opinions-2026-06-19-ascot-approved.csv`
   (see [the approved example](tipster-opinions-2026-06-19-ascot-approved.example.csv) for the exact import format).

See [docs/TIPSTER_MANUAL_REVIEW_2026_06_19.md](../docs/TIPSTER_MANUAL_REVIEW_2026_06_19.md) for the full import + verify + rerun steps.
