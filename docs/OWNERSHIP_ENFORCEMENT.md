# Route-level producer ownership enforcement

Authoritative description of the final ownership boundary after route-hardening
Step A and Slices 1–4a. This document is **descriptive only** — reading or
editing it deploys nothing and enables nothing.

Honest scope note: route-level ownership prevents a **context-less or
foreign-owned** producer call from writing during an owned date. It does **not**
eliminate every possible duplicate-work path — several workflows are
intentionally exempt (see §F), and operators remain responsible for not running
two owners for the same date by other means.

---

## A. Final architecture

| Layer | What it does |
| --- | --- |
| **Step A — authentication** (`src/lib/auth.ts`) | Every write-capable route requires `Authorization: Bearer <CRON_SECRET>`. Missing/blank `CRON_SECRET` → HTTP 503; wrong/absent bearer → 401. Fail-closed; the secret value is never rendered. `POST /api/settle` (GET+POST) is a permanent inert **410**. |
| **Slice 1 — context contract** (`src/lib/ownershipContext.ts`) | A strict wire context with exactly five fields: `v`, `date`, `owner`, `generation`, `scope`. No `mode`, no credentials, no metadata. Scope must EXACTLY equal the live claim's scope. |
| **Slice 2 — route verification** (`src/lib/routeOwnershipGuard.ts`) | After Step A and before any provider/model/write, each guarded route reads the `x-producer-ownership` header, reads the live claim via the read-only `producer_claim_status` RPC, and verifies date/owner/generation/scope/liveness. Fail-closed. |
| **Slice 3 — orchestrator propagation** (`src/lib/ownershipPropagation.ts`) | The claim-holding orchestrators attach their current ownership proof (rebuilt per call from live state) to the racecards/odds calls they make through the shared `createCallCron` seam. |
| **Slice 4a — direct model CLI refusal** (`src/lib/directModelClaimCheck.ts`) | `run:model` and `model:day --commit` perform a read-only foreign-claim check before writing. |

**Default behaviour is `enforce`.** The enforcement mode comes from
`PRODUCER_OWNERSHIP_ENFORCEMENT`; missing, blank, or unknown values all resolve
to `enforce` (fail-closed).

---

## B. Guarded routes (verify ownership context under enforce)

- `GET /api/cron/racecards`
- `GET /api/cron/odds`
- `GET /api/cron/model`
- `GET /api/cron/results`
- `GET /api/cron/training-capture`
- `POST /api/run-model`

Under `enforce`, a direct `CRON_SECRET`-only call to any of these (no valid
`x-producer-ownership` header) is **rejected** — it is no longer a claim bypass.

---

## C. Propagating callers

The claim-holding orchestrators supply context:

- `pipeline:day`
- `pipeline:watch`
- nationwide **live-provider** dry-run (`all-uk-ire` scope)

Currently **only racecards and odds** are called through their shared
`createCallCron` seam. The selected-course model runs **in-process** (not via a
route), so `cron/model` is not called by the pipeline.

---

## D. Guarded routes without a current context-supplying caller

- `GET /api/cron/model`
- `GET /api/cron/results`
- `GET /api/cron/training-capture`
- `POST /api/run-model`

No orchestrator calls these through a context-supplying seam yet. Under
`enforce` they are therefore **fail-closed / unavailable** to context-less
callers. **Do not weaken the guard to make an old caller work** — the correct
fix is to build a context-supplying caller, which is future work.

---

## E. Direct model CLI policy (Slice 4a)

- `run:model` **always** resolves the target race's meeting date (SELECT-only)
  and checks ownership before writing.
- `model:day --commit` performs **one** ownership check for the requested date
  **before** the model loop (not once per race).
- **Live claim → refuse** (exit non-zero); **unknown/mechanism-unavailable/
  permission/transient/malformed status → refuse**; **absent or expired claim →
  allow**.
- Neither command **acquires, renews, releases, or steals** a claim, and neither
  fabricates an ownership context.
- `model:day` **dry-run** does not query claim status and never writes.

Refusal messages carry only the date, a fixed reason code, and an optional
8-character owner prefix — never a full owner id or secret — and never advise
stealing, deleting, or manually releasing a live claim.

---

## F. Exemptions (documented honestly)

| Entry point | Why exempt | Residual risk |
| --- | --- | --- |
| `tipster-discovery` | Spans **today + tomorrow** — no single unambiguous claim date | Writes `tipsters`/`tipster_priors` (model inputs); idempotent upsert, daily pre-racing slot |
| `lock:t-minus` | By policy OUTSIDE the claim; insert-only, `unique(race_id, minutes_before)`, commit-windowed. A claim-induced **missed** official lock would be worse than a harmless duplicate refused by the unique constraint | A duplicate lock attempt is a no-op |
| `results:auto` | Read-only (never writes, even with `--commit`) | None — nothing to serialise |
| `import:results` | The **audited, manual, operator-gated** settlement path | Operator responsibility |
| Read-only routes/audits/reports (`health`, `/api/accuracy`, `/api/recommendations`, race-day status, `ml/*`, `tipsters/*`, reports) | No writes | None |

Exemptions are test-enforced; Slice 4b does not change any of them.

---

## G. Enforcement modes

- **`enforce`** is the default. Blank, missing, or unknown values **fail closed
  to enforce**.
- **`warn`** permits **only a missing (absent) context**, logging a structured
  `OWNERSHIP_ABSENT_COMPAT` compatibility marker. A **malformed, conflicting,
  expired, or unverifiable** context still **fails closed** under `warn`.
- **`off`** skips route ownership verification entirely and is **emergency-only**
  (a fail-open lever, loudly logged).
- There is **no live deployment** currently, so there is no compatibility window
  to observe yet.

---

## H. Deployment state (verified facts at the time of this work)

- Railway was **offline** because the free trial had expired; there was **no
  active Railway deployment**.
- `CRON_SECRET` **existed** in Railway production variables.
- Vercel was **not live** per operator inspection.
- **Deployment state must be re-checked before any future deployment.**
- **Slice 2 and Slice 3 must be deployed together** (routes verify context;
  orchestrators supply it).
- Context-less `vercel.json` platform crons would be **rejected under enforce**.
- **Do not edit `vercel.json`** as part of this work.

This document does not deploy or enable anything.

---

## Verification tiers

Keep the three tiers separate.

1. **Offline automated verification** — the test suite
   (`npm run typecheck && npm run lint && npm run test`). Proves the guard,
   propagation, CLI refusal, and boundary with injected deps — no server, no
   provider, no Supabase, no claim mutation.
2. **Attended local integration verification** — the runbook below. Run by an
   operator on a suitable local machine; touches local Supabase/providers.
   **Not executed by this repository or by CI.**
3. **Future deployment verification** — designed only when a deployment is
   actually planned; out of scope here.

---

## Attended local verification runbook (DO NOT run as part of any automated task)

> This procedure is **attended** and **sequential**, and it **stops on the first
> failure**. It touches local Supabase and, in step 7, real provider calls, so it
> requires a suitable date/course and explicit operator supervision. It is **not**
> a deployment.

**Security rules for this runbook**
- Never paste `CRON_SECRET` into chat, logs, screenshots, Git, reports, or shell
  history unnecessarily, and never write a literal secret value anywhere.
- Where a request needs the bearer, load it from the local environment into a
  PowerShell variable and **do not echo it** (e.g. `$sec = $env:CRON_SECRET`;
  never `Write-Host $sec`).
- Never use a real owner id in a fixture — use a placeholder such as
  `00000000-0000-4000-8000-000000000000`.
- Never manually release a live claim while its owner process is still running.

**Steps**

1. **Repository clean & reviewed.** `git status` clean; `git rev-parse HEAD`
   equals the reviewed commit and matches `origin/main`. STOP if not.
2. **No producer active.** `npm run producer:claim-check -- --date <date> --op
   status` shows **absent/unclaimed**; confirm no local pipeline/watcher/nationwide
   process is running. STOP if a live claim exists.
3. **External inactive.** Confirm Railway remains offline / no active deployment
   and Vercel remains inactive (operator inspection). STOP if either is live.
4. **Local secret configured (not printed).** Confirm `CRON_SECRET` is present in
   `.env.local` / the environment **without printing it**
   (`if ($env:CRON_SECRET) { 'set' } else { 'MISSING' }`). STOP if missing.
5. **Local server starts.** Start the dev server locally and confirm it is
   reachable at the health path. STOP if it does not start.
6. **Claim acquired.** Run one attended selected-course `pipeline:day --commit
   --course <course> --date <today-or-tomorrow>`. Observe `PRODUCER_CLAIM_ACQUIRED`.
   *(Attended: this makes real racecards/odds provider calls; choose a safe
   date/course.)*
7. **Propagated calls succeed under enforce.** With `PRODUCER_OWNERSHIP_ENFORCEMENT`
   unset (default `enforce`), observe racecards and odds returning `ok` — i.e. the
   propagated context is accepted. STOP if either is refused.
8. **Context-less call rejected.** From a second shell, send an authenticated but
   **context-less** request to a guarded route and expect **403**:
   `$sec = $env:CRON_SECRET; Invoke-WebRequest -Method GET -Uri
   'http://localhost:3000/api/cron/odds?date=<date>' -Headers @{ Authorization =
   "Bearer $sec" }` (do not echo `$sec`). STOP if it is not 403.
9. **Stale/wrong-generation context rejected.** Send the same request with a
   hand-built `x-producer-ownership` header using a **placeholder** owner and a
   wrong generation; expect **409**. STOP if it is not 409.
10. **Claim releases cleanly.** Stop the pipeline (single Ctrl+C for the watcher)
    and observe `PRODUCER_CLAIM_RELEASED`. STOP if release did not complete.
11. **Final claim status absent.** `producer:claim-check --op status` shows
    **absent**. STOP if a claim lingers (do **not** force-release a live one).
12. **Direct model CLIs refuse an owned date.** While a *separate* attended owner
    holds the date, run `npm run run:model -- <race_id_on_that_date>` and
    `npm run model:day -- --date <date> --course <course> --commit`; both must
    **refuse** (non-zero) with no model write. STOP if either runs the model.
13. **No duplicate model persistence.** Confirm (read-only) that no duplicate
    model runs were created for the owned date beyond the owning pipeline's.
14. **Lock/result workflows unchanged.** Confirm `lock:t-minus`/`results:auto`
    behave exactly as before (claim-exempt, results:auto read-only).
15. **No nationwide persistence enabled.** Confirm no nationwide model runs /
    recommendations / locks / results were created.
16. **No deployment required.** This entire procedure runs locally; nothing is
    deployed.

Record only safe evidence (dates, reason codes, HTTP statuses, 8-char owner
prefixes). Never record a secret or a full owner id.
