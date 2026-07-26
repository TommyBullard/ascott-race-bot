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
> failure**. It touches local Supabase and, from step 6, real provider calls, so
> it requires a suitable date/course (today or tomorrow — the Racing API only
> serves those) and explicit operator supervision. It is **not** a deployment.
>
> **Why a watcher, not `pipeline:day`.** The refusal tests (steps 10–12) must run
> while a producer **still owns the date**. `pipeline:day` is one-shot and
> **releases its claim when it finishes**, so it cannot hold the claim across the
> refusal tests. This runbook therefore holds the claim with a single long-lived
> **watcher** (`pipeline:watch` via the proven Windows helper) for the whole
> refusal phase, and releases it only at the very end with one Ctrl+C.

**Security rules for this runbook**
- Never paste `CRON_SECRET` into chat, logs, screenshots, Git, reports, or shell
  history unnecessarily, and never write a literal secret value anywhere.
- Where a request needs the bearer, load it from the local environment into a
  PowerShell variable and **do not echo it** (`$sec = $env:CRON_SECRET`; never
  `Write-Host $sec` / `$sec`).
- Never use a real, complete owner id in a fixture — use a placeholder such as
  `00000000-0000-4000-8000-000000000000`.
- Never manually release the live claim while its owner (the watcher) is running.
- Record only safe evidence: dates, reason codes, HTTP statuses, and at most an
  8-character owner prefix. Never record a secret or a full owner id.

### PowerShell note — an expected 403/409 is NOT a script failure

In Windows PowerShell 5.1, `Invoke-WebRequest` **throws** on a non-2xx response,
so an *expected* 403/409 looks like an error. Capture the status code instead of
treating the throw as a failure (and never echo `$sec`):

```powershell
$sec = $env:CRON_SECRET                     # loaded, never printed
function Get-Status([hashtable]$args) {
  try   { (Invoke-WebRequest @args -UseBasicParsing).StatusCode }
  catch { $_.Exception.Response.StatusCode.value__ }   # 403 / 409 land here
}
```

`curl.exe` is an alternative: `curl.exe -s -o NUL -w "%{http_code}" ...` prints
just the numeric status and does not throw.

**Steps**

1. **Repository clean & reviewed.** `git status` clean; `git rev-parse HEAD`
   equals the reviewed commit and matches `origin/main`. STOP if not.
2. **Date initially unclaimed.** `npm run producer:claim-check -- --date <date>
   --op status` shows **absent/unclaimed**. STOP if a live claim exists.
3. **External inactive & no other producer.** Confirm Railway remains offline / no
   active deployment, Vercel remains inactive (operator inspection), and no other
   local pipeline/watcher/nationwide process is running. STOP if any is active.
4. **Local secret configured (not printed).** Confirm `CRON_SECRET` is present
   **without printing it**: `if ($env:CRON_SECRET) { 'set' } else { 'MISSING' }`.
   STOP if missing.
5. **Local server starts.** Start the dev server locally and confirm it is
   reachable at the read-only health path. STOP if it does not start.
6. **Start exactly one selected-course watcher (holds the claim).** In its own
   window, run the proven helper:
   `race-day-local\watch-pipeline.bat <date> "<course>" "<logdir>"`
   *(equivalently `npm run pipeline:watch -- --date <date> --course "<course>"
   --interval-minutes 5 --commit`, but prefer the helper for the graceful-Ctrl+C
   contract)*. Observe `PRODUCER_CLAIM_ACQUIRED`. **Leave this window running** —
   it is the live owner for steps 8–12. *(Attended: it makes real racecards/odds
   provider calls; choose a safe today/tomorrow date/course.)*
7. **Wait for one cycle, then a waiting state.** Wait until the watcher logs one
   completed cycle (racecards + odds + in-process model) and then enters its
   inter-cycle **waiting** state (e.g. "next check in …"). STOP if the first cycle
   fails.
8. **Claim is live.** In a second shell, `producer:claim-check -- --date <date>
   --op status` shows **live**. STOP if not live.
9. **Propagated calls succeeded under enforce.** With
   `PRODUCER_OWNERSHIP_ENFORCEMENT` unset (default `enforce`), confirm from the
   watcher's cycle log that racecards and odds returned `ok` — the propagated
   context was accepted. STOP if either was refused.
10. **(watcher still owns the date) Context-less call → 403.** Using
    `Get-Status` above, send an authenticated but **context-less** request to a
    guarded route and require **403**:

    ```powershell
    Get-Status @{ Method='GET'; Uri="http://localhost:3000/api/cron/odds?date=<date>";
                  Headers=@{ Authorization = "Bearer $sec" } }   # expect 403
    ```

    STOP if it is not 403.
11. **(watcher still owns the date) Foreign / stale context → 409.** Send the same
    request with a hand-built `x-producer-ownership` header for the **same date**
    using a **placeholder** owner id and any generation, and require **409**:

    ```powershell
    $ctx = '{"v":1,"date":"<date>","owner":"00000000-0000-4000-8000-000000000000","generation":1,"scope":"course:<normalised-course>"}'
    Get-Status @{ Method='GET'; Uri="http://localhost:3000/api/cron/odds?date=<date>";
                  Headers=@{ Authorization = "Bearer $sec"; 'x-producer-ownership' = $ctx } }   # expect 409
    ```

    **Honest labelling:** the guard checks owner **before** generation, so a
    placeholder owner yields `owner_mismatch` (409). This proves the 409 conflict
    path **without exposing the real owner id**. Proving `generation_mismatch`
    *specifically* would require the live claim's real owner id with a wrong
    generation — deliberately **not** done here (it would reveal the owner id). A
    409 is the required result either way. STOP if it is not 409.
12. **(watcher still owns the date) Direct model CLIs refuse.** First get a real
    `race_id` for the date **read-only, no writes, no secret** via a dry run:
    `npm run model:day -- --date <date> --course "<course>" --dry-run` — it lists
    each race as `… (<race_id>)` and never queries the claim or writes. Then, while
    the watcher is still live, run both and require a **non-zero refusal before any
    model work**:
    - `npm run run:model -- <race_id>` → refuses (`live_claim`), no model run;
    - `npm run model:day -- --date <date> --course "<course>" --commit` → refuses
      **before** the model loop.
    STOP if either runs the model. Do **not** re-run if a refusal is unclear —
    investigate first.
13. **Stop the watcher — exactly one Ctrl+C during the waiting state.** Switch to
    the watcher window and press **Ctrl+C once** while it is in its inter-cycle
    wait. Do **not** press it twice (a second Ctrl+C forces a non-graceful stop),
    and do **not** manually release the claim.
14. **Require a graceful release.** The watcher/helper must show ALL of:
    `PRODUCER_CLAIM_RELEASED`, `WATCH_STOPPED_GRACEFULLY`, a **terminal graceful**
    helper result (effective exit 0 — `terminal_graceful` / `terminal_graceful_normalised`),
    and **no bounded-retry** line. STOP if any is missing.
15. **Final claim status absent.** `producer:claim-check -- --date <date> --op
    status` shows **absent**. STOP if a claim lingers (do **not** force-release it
    — investigate the release path).
16. **No helper/watcher process remains.** Confirm the watcher window has exited
    and no `node`/`pipeline:watch` helper process for this run remains.
17. **No duplicate model persistence.** Confirm (read-only) that no duplicate
    model runs were created for the date beyond the watcher's own cycles.
18. **Lock/result workflows unchanged.** Confirm `lock:t-minus` and `results:auto`
    behave exactly as before (claim-exempt; `results:auto` read-only). This runbook
    changes neither.
19. **No nationwide persistence enabled.** Confirm no nationwide model runs /
    recommendations / locks / results were created.
20. **No deployment required.** This entire procedure runs locally; nothing is
    deployed and no Railway/Vercel variable is changed.
