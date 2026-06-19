# Railway GenAI Setup (OpenAI shadow commentary)

> **Optional + shadow-only.** GenAI commentary is an explanatory, human-review-gated
> layer that restates already-computed model output in plain English. It is
> **off by default**, **does not affect picks**, **never places bets**, and
> **never guarantees outcomes**. Racing Bot runs completely without it.
>
> Decision-support only — not betting advice.

## What it is (and is not)

- **Is:** an optional OpenAI-backed generator that produces *shadow* notes,
  validated by guardrails (no predictions, no betting verbs, no ungrounded
  numbers) and stored as `review_status = 'pending'`, `model_active = false`.
  Only a human-**approved** note is ever surfaced, read-only, on the dashboard.
- **Is not:** model-active. It changes **no** model probability, EV, staking,
  ranking, recommendation, or no-bet logic. It places **no** bets and enables
  **no** auto-betting. It predicts **no** winners and guarantees **no** outcomes.

## 1. Add `OPENAI_API_KEY` — Railway

1. Railway → your service → **Variables**.
2. Add `OPENAI_API_KEY` = your OpenAI key (an `sk-...` value).
3. Deploy/restart the service so the variable is picked up.

It is **optional**: if absent, the app and all cron jobs run normally and
`npm run check:env` stays green, reporting the key as *optional, shadow-only*.
The value is read **only** when you explicitly run a GenAI command — never during
normal app operation, and never by the model/staking/recommendation path. It is
**never printed or logged**.

## 2. Add `OPENAI_API_KEY` — local

Put it in your git-ignored **`.env.local`** (loaded before `.env`):

```dotenv
# Optional, shadow-only. Never commit this file.
OPENAI_API_KEY=sk-...
```

- **Never commit `.env.local`** — `.env*.local` is git-ignored, and `.env.example`
  must stay empty of real values.
- Verify presence (prints names + present/missing only — never the value):

```bash
npm run check:env
```

## 3. Generate shadow commentary (explicit, gated)

Offline + dry-run by default (no OpenAI call, no DB writes):

```bash
# Plan only — lists eligible race/kind pairs, writes nothing, calls nothing:
npm run genai:generate -- --date 2026-06-19 --course Ascot

# Call OpenAI (needs OPENAI_API_KEY), still no DB writes:
npm run genai:generate -- --date 2026-06-19 --course Ascot --live

# Generate AND store pending candidates for review (needs the genai_commentary table):
#   WRITE — stores model_active=false, review_status='pending' rows only.
npm run genai:generate -- --date 2026-06-19 --course Ascot --live --commit
```

- `--live` without `OPENAI_API_KEY` **fails safely** (value-free error) and writes nothing.
- If the `genai_commentary` table is missing, it explains the migration and writes nothing.
- Stored rows are **pending** — nothing appears on the dashboard until a human approves it.

> The existing `npm run genai:commentary` is a **separate** offline tool that
> writes a Markdown *report* (it does not store DB candidates). Use
> `genai:generate` for the review-store pipeline.

## 4. Review + surface (read-only on the dashboard)

- Approval is an **out-of-band, operator-only** step (e.g. set
  `review_status = 'approved'` on a vetted candidate row in the Supabase SQL
  editor). There is **no public approve/reject button**.
- Once approved, the dashboard race card shows a read-only **"AI commentary
  (shadow)"** panel with the note, its kind, generator, prompt version, and time,
  under a persistent **"AI shadow note — not betting advice."** disclaimer.
- The panel renders **nothing** when there is no approved commentary, and it
  **never** shows pending or rejected text.

## 5. Kill switch

- Stop running `genai:generate --live` (and/or unset `OPENAI_API_KEY`). No key ⇒
  no generation. The dashboard panel simply shows nothing.
- Approved rows can be hidden again by setting their `review_status` away from
  `'approved'`.

## Safety summary

| Guarantee | How |
| --- | --- |
| Optional | App + crons run without the key; `check:env` stays green. |
| Shadow-only | `model_active = false` (DB CHECK); the model never reads `genai_commentary`. |
| No effect on picks | No change to probability, EV, staking, ranking, or recommendations. |
| No bets / no auto-betting | Guardrails reject betting verbs; nothing places or submits an order. |
| No guarantees | Guardrails reject predictions/overconfidence; the disclaimer is mandatory. |
| Secret-safe | The key is used only for the Authorization header; never printed or logged. |
