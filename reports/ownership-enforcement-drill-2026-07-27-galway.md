# Route-level ownership enforcement — attended drill evidence

**Generated:** 2026-07-27 (attended local drill; documentation-only report).

Companion to [docs/OWNERSHIP_ENFORCEMENT.md](../docs/OWNERSHIP_ENFORCEMENT.md)
(the runbook this drill executed). This report records **verified operational
evidence** from one completed attended run. It is a read-only write-up: creating
it deploys nothing, enables nothing, and places no bet.

---

## 1. Purpose

Prove, on a real local machine under the fail-closed default (`enforce`), that
route-level producer ownership behaves as designed end-to-end:

- a claim-holding orchestrator's **propagated** ownership context is accepted;
- an authenticated but **context-less** call to a guarded route is refused;
- a **foreign / stale** ownership context is refused;
- the direct model CLIs **refuse** to write while another producer owns the date;
- the owner releases its claim **gracefully** on a single Ctrl+C;
- the claim is **absent** afterwards and no process lingers.

This corresponds to Verification Tier 2 (attended local integration) in
`OWNERSHIP_ENFORCEMENT.md`; it is not a deployment and not CI.

## 2. Reviewed commit

- Reviewed commit before the drill: `7588ed5e79df5ffb31b906674694532f4ef3c5f2`.
- Working tree was **clean** and matched `origin/main`.

## 3. Environment and deployment state

| Item | State |
| --- | --- |
| Drill date | 2026-07-27 |
| Selected course | Galway (`course:galway`) |
| Railway | **Offline** — free trial expired; **no active deployment** |
| Vercel | **Not live** |
| `CRON_SECRET` | Configured locally; **value never displayed** |
| `PRODUCER_OWNERSHIP_ENFORCEMENT` | **Unset** → effective mode was the fail-closed default **`enforce`** |
| Competing local producer | **None** running |

## 4. Initial safety checks

- Repository clean and on the reviewed commit; matched `origin/main`.
- Initial producer claim status for the date: **absent**.
- No competing pipeline / watcher / nationwide process active.
- `CRON_SECRET` present (presence confirmed only; value never printed).
- Railway offline / Vercel not live confirmed by operator inspection.

## 5. Claim lifecycle

- Owner started with the approved Windows watcher helper
  `race-day-local\watch-pipeline.bat` (long-lived `pipeline:watch`, so the claim
  is **held across** the refusal checks — not a one-shot `pipeline:day`).
- Scope: `course:galway`.
- Claim **generation: 1**.
- Owner identity shown only as the safe **8-character prefix `09e62659`** in all
  operational evidence (the full owner id was never displayed).
- Claim **acquired successfully**.
- **Exactly one cycle** completed; the watcher then held the claim in its
  **inter-cycle waiting state** for the duration of the enforcement checks.

## 6. Cycle result (Cycle 1)

| Stage | Result |
| --- | --- |
| racecards | **ok** (provider tier: basic) — racesInserted **35**, runnersInserted **366** |
| odds | **ok** — considered **35**, matched **35**, snapshots **35**, quotes **352** |
| model (Galway, in-process) | modelled **7** races, models_run **7**, recommendations_created **0**, no_bet_races **7**, failures **0** |

The racecards/odds calls succeeded under `enforce` because the watcher propagated
its **valid** ownership context — this is the propagation-accepted evidence
(§8).

## 7. Cycle result summary

Cycle 1 completed cleanly with zero failures: racecards + odds ingested, and the
selected-course model ran **in-process** for all 7 Galway races (`cron/model` was
not called — the pipeline runs the model in-process by design). Recommendations
were 0 with 7 no-bet races, consistent with a decision-support run that placed
and could place no bet.

## 8. Ownership propagation evidence (propagated context accepted)

While the watcher owned the date, a read-only producer claim status check
returned:

- status: **live**;
- scope: **`course:galway`**;
- generation: **1**.

Because the same cycle's racecards and odds returned **ok** under `enforce`, the
guard **accepted the watcher's propagated context** — a context-less call would
have been refused (§9). **Sub-verdict: PASS.**

## 9. HTTP 403 evidence (context-less request refused)

- An **authenticated** (bearer present) but **context-less** GET to
  `GET /api/cron/odds?date=2026-07-27` returned **HTTP 403**.
- The bearer was supplied from the local environment and **never displayed**; no
  authorization header value appears in this report.

This confirms that, under `enforce`, a valid `CRON_SECRET` is necessary but **not
sufficient** — a guarded route with no valid ownership context is rejected.
**Sub-verdict: PASS.**

## 10. HTTP 409 evidence (foreign / stale context refused) — with honest limitation

- An authenticated request carrying a **validly shaped placeholder foreign**
  ownership context for the same date returned **HTTP 409**.

**Honest limitation (as designed and documented in the runbook):** the guard
checks the **owner before the generation**, so a placeholder owner produces an
`owner_mismatch` (409). This evidence therefore proves rejection of a **foreign
or stale** context; it does **not** specifically prove `generation_mismatch`,
because the placeholder owner deliberately differs from the live owner (the real
owner id was intentionally **not** used, so it is never exposed). A 409 conflict
was the required and observed result either way. **Sub-verdict: PASS.**

## 11. Direct model CLI refusal evidence

All checks ran **while the watcher still held the live claim** for the date.

- **`model:day --dry-run`** — listed **7** Galway races, wrote **no** model runs,
  and safely provided a `race_id` (dry-run does not query the claim and does not
  write).
- **`run:model <galway race id>`** — **refused** because the date had a live
  producer claim; **ran no model**; showed only the safe owner prefix.
- **`model:day --commit`** — **refused** because the date had a live producer
  claim; **entered no model loop**; **ran no model**.

Both write-capable direct CLIs visibly refused **before any model work**.
**Sub-verdict: PASS.**

## 12. Graceful shutdown evidence

- **Exactly one Ctrl+C** during the inter-cycle waiting state.
- `PRODUCER_CLAIM_RELEASED` emitted.
- `WATCH_STOPPED_GRACEFULLY` emitted.
- `pipeline:watch` exited with **code 0**.
- Helper reported **terminal graceful shutdown**; **did not restart**.
- **No** bounded retry occurred.
- **No** release-failure event.
- **No** force-stopped event.

**Sub-verdict: PASS.**

## 13. Final claim and process state

- Final producer claim status: **absent**.
- **No** watcher or helper process remained.

The claim was never manually released — it was released by the watcher's own
graceful shutdown. **Sub-verdict: PASS.**

## 14. Read-only Galway audit results (post-drill)

| Metric | Value |
| --- | --- |
| Course | Galway |
| Races | 7 |
| Runners | 109 |
| Odds coverage | 7/7 |
| Priced runners | 105/109 |
| Pre-off model coverage | 7/7 |
| Diagnostic picks | 0 |
| Diagnostic no-bets | 7 |
| Official locks | 0 |
| Settled results | 0 |
| Warnings | none |
| Coverage gaps | none |
| Evidence-gate verdict | **PASS** |

## 15. Limitations

- **Duplicate-row cardinality was NOT independently audited.** The nationwide
  audit proves **7/7 race-level model coverage** but does **not** expose the raw
  number of `model_runs` rows per race. It is therefore **not** claimed that the
  audit independently proved zero duplicate `model_runs` rows. What is accurate:
  - both direct model commands **visibly refused before model work**;
  - race-level model coverage remained **7/7**;
  - **no additional model execution was observed**;
  - raw per-race `model_runs` row cardinality was **not independently audited**.
- The 409 check proves **foreign/stale** rejection, not `generation_mismatch`
  specifically (§10).
- This is a single attended local drill on one date/course under `enforce`; it is
  not a deployment or a multi-date/multi-course proof.

## 16. Final verdict

**PASS.**

| Sub-verdict | Result |
| --- | --- |
| Propagated ownership accepted | **PASS** |
| Context-less request refused (403) | **PASS** |
| Foreign/stale context refused (409) | **PASS** |
| Direct CLI conflict protection | **PASS** |
| Graceful release | **PASS** |
| Final claim absence | **PASS** |
| Post-drill audit | **PASS** |
| Independent duplicate-row cardinality proof | **NOT MEASURED** |

## 17. Deployment statement

**Nothing was deployed.** Railway remained offline with no active deployment,
Vercel remained not live, no Railway/Vercel variable was changed, and the entire
drill ran locally.

## 18. Betting statement

**No bet was placed and no betting capability was exercised.** This system is
decision-support only: it has no bet-placement path. Cycle 1 produced 0
recommendations and 7 no-bet races, and no order-placement action exists or was
taken anywhere in the drill.

---

*Redaction: this report contains no `CRON_SECRET`, no authorization header value,
no complete owner id (only the 8-character prefix `09e62659`), no provider or
Supabase credentials, no environment values, and no secret-shaped value.*
