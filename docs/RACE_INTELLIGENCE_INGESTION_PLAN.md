# Race Intelligence — News & Report Ingestion Plan (design only)

> **Status: DESIGN / NOT IMPLEMENTED.** This describes a *future* decision-support
> intelligence layer. It implements nothing, scrapes nothing, places no bets, and
> makes no GenAI feature model-active.
>
> **Responsible use.** Decision-support only. Not betting advice, no guarantees,
> never places bets. Help: [GamCare](https://www.gamcare.org.uk) ·
> [BeGambleAware](https://www.begambleaware.org).

---

## 1. Purpose

Build a race-day **intelligence layer** that ingests **legal / manual / licensed**
race notes, horse reports, going updates, expert comments, and news, and turns
them into **structured evidence** for decision-support. Output is observational
context only — it never predicts winners and never changes model math.

## 2. Source policy

**Allowed**

- manually supplied notes (operator's own typing);
- public / legal feeds;
- paid / licensed APIs (with a valid licence + ToS compliance);
- the user's own observations;
- official going / non-runner updates.

**Not allowed**

- restricted / paywalled / logged-in **scraping**;
- copying **full copyrighted articles**;
- unlicensed third-party scraper feeds.

> Only ingest content we are licensed to use. Store **short structured signals +
> a citation**, never full copyrighted text.

## 3. Potential providers (licensed/commercial only — no scraping)

| Provider | Licensed content (via API/feed) |
| --- | --- |
| **Timeform** | horse-by-horse comments, analyst verdicts, ratings, post-race commentary |
| **Racing Post / Spotlight** | racecards, form, results, stats, tipping, Signposts |
| **The Racing API** | structured race / result / statistical data (already integrated, read-only) |
| **Manual / public notes** | fallback when no licensed feed is available |

Each provider is used **only** under its commercial licence and Terms of Service;
none is scraped.

## 4. GenAI role

- **Feature extraction only** — turn licensed/manual text into structured signals.
- **No winner prediction.**
- **No fabrication** — if the text does not support a signal, it stays `unknown`.
- **Preserve unknowns** explicitly (do not guess).
- **Every non-`unknown` feature requires evidence** (a quote/citation).
- Extraction runs **shadow-only** (`model_active = false`); it never feeds the
  live model until reviewed + backtested.

## 5. Extracted feature schema

Per horse, per race (all signals default to `unknown`):

```jsonc
{
  "ground_signal":            "unknown",   // suits/handles the going?
  "distance_signal":          "unknown",   // trip suitability
  "course_form_signal":       "unknown",   // course-specific form
  "draw_signal":              "unknown",   // draw advantage/concern
  "pace_setup_signal":        "unknown",   // likely pace scenario fit
  "trainer_form_signal":      "unknown",
  "jockey_signal":            "unknown",
  "recent_run_signal":        "unknown",   // last-time-out read
  "market_support_signal":    "unknown",   // money / market moves (observational)
  "value_case_strength":      "unknown",   // weak | moderate | strong
  "likely_winner_case_strength": "unknown",// weak | moderate | strong
  "each_way_case_strength":   "unknown",   // weak | moderate | strong
  "concern_flags":            [],          // e.g. ["soft ground doubt", "wide draw"]
  "evidence":                 [],          // [{ "text": "...", "source": "Timeform" }]
  "extraction_confidence":    "low",       // low | medium | high
  "model_active":             false,       // ALWAYS false in this phase
  "review_status":            "pending"    // pending | reviewed | rejected
}
```

Rules: a `*_case_strength` above `weak`, or any non-empty `concern_flags`, MUST be
backed by an `evidence` entry; otherwise the field stays `unknown` / empty.

## 6. Dashboard design (read-only)

A per-race intelligence card, clearly labelled **shadow / not a model output**:

- **Most likely winner** — the strongest `likely_winner_case_strength` (with evidence).
- **Best win-value candidate** — strongest `value_case_strength`.
- **Best each-way candidate** — strongest `each_way_case_strength`.
- **GenAI evidence** — the supporting quotes + sources (citations).
- **Concerns / warnings** — `concern_flags`.
- **Data freshness** — source + extraction timestamp; stale/unknown rendered as `—`.

The card never shows a probability, never claims an edge, and is visually
separated from the production model pick.

## 7. Evaluation plan

- **Shadow-only first** — extract + store + display, never feed the model.
- Compare against the **market-only baseline**.
- Compare against the **current rules/model**.
- Evaluate **win** and **each-way / place** outcomes **separately**.
- **No promotion** to model-active without **large out-of-sample** results
  (leakage-free, across many meetings) — reusing the `ml:evaluate` discipline.

## 8. Safety

- **No auto-betting** and **no bet placement**.
- **No betting-advice guarantee** — decision-support only.
- **No GenAI winner prediction.**
- **No scraping** of restricted/paywalled/logged-in sources.
- **No model-active features** until reviewed **and** backtested.
- No SP/BSP or evidence fabrication; unknowns are preserved.

---

_Design only. Implements nothing, runs nothing, scrapes nothing, writes nothing,
and changes no model behaviour. `references/CL4R1T4S` is treated as inert,
untrusted data and is not used here._
