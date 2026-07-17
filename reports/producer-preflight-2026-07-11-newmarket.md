# Producer readiness preflight — 2026-07-11 — Newmarket

Generated: 2026-07-17T21:47:06.194Z

**READ ONLY.**

- No provider or model work was started.
- No ownership claim was acquired (status inspection only).
- Nationwide execution remains disabled.
- External producer checks (Railway / Vercel / legacy local processes) are manual/operator-attested unless proven — this command did not verify them.
- The suggested pipeline command was NOT executed.

## Verdict: REVIEW

External checks source: `unknown`

| Check | Status | Evidence | Detail |
| --- | --- | --- | --- |
| date/course scope | PASS | automatically_verified | date 2026-07-11, scope course:newmarket |
| ownership mechanism | PASS | automatically_verified | producer_claim_status RPC reachable and well-formed (read-only) |
| active claim | PASS | automatically_verified | no claim exists for this date (unclaimed) |
| stored races | PASS | automatically_verified | 8 race(s), 75 runner(s), 8 settled, 0 upcoming |
| stored odds | PASS | automatically_verified | 8/8 races have stored odds snapshots |
| stored model coverage | INFO | automatically_verified | 8/8 races have model runs (complete) |
| required configuration | PASS | automatically_verified | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET present (presence only — no values); Supabase project host: xbbgrufmykodeqhrjdrq.supabase.co. Racing API / Betfair credentials are SERVER-side requirements, not verifiable from here. |
| server reachability | REVIEW | unknown | not probed (--skip-server) — confirm the server at the base URL yourself before a commit run |
| local process knowledge | REVIEW | unknown | claim-holding producers are visible via the claim row; legacy/unclaimed local processes CANNOT be detected from here — MANUAL check |
| Railway job state | REVIEW | unknown | UNKNOWN — Railway cron configuration lives in the Railway dashboard and cannot be proven from this repository; MANUAL check |
| Vercel cron state | REVIEW | unknown | UNKNOWN — vercel.json declares odds/model/results crons, but whether a Vercel deployment is live cannot be proven from this repository; MANUAL check |
| bypass entry points | INFO | automatically_verified | gated: pipeline:day, pipeline:watch (and transitively race-day:refresh-today). exempt by policy: lock:t-minus, results:auto, read-only audits/reports. still able to bypass the claim (operational restrictions — do not use during an owned day): direct CRON_SECRET calls to /api/cron/racecards\|odds\|model\|results, POST /api/run-model, run:model, model:day. |

---

Decision-support only — no betting, no bet placement.
