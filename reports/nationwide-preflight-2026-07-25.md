# Nationwide readiness preflight — 2026-07-25 — target mode: live-provider

Generated: 2026-07-25T16:40:47.976Z

**READ ONLY.** No provider or scoring work was started. No ownership claim was
acquired (status inspection only). Nationwide execution remains disabled.
External producer checks (Railway / Vercel / other-machine producers) are
manual/operator-attested unless proven — this command did not verify them.

## Verdict: READY

- Target mode: `live-provider`
- Pre-ingestion workload state: `empty`
- Stored workload required: `false`
- Expected write boundary: `races`, `runners`, `market_snapshots`, `runner_quotes`, `cron_runs`
- External checks source: `operator_attestation`

| Check | Status | Evidence | Detail |
| --- | --- | --- | --- |
| date / nationwide scope | PASS | automatically_verified | date 2026-07-25, scope all-uk-ire |
| ownership mechanism | PASS | automatically_verified | producer_claim_status RPC reachable and well-formed (read-only) |
| active claim | PASS | automatically_verified | no claim exists for this date (unclaimed) |
| stored nationwide workload | PASS | automatically_verified | pre-ingestion workload empty; live-provider mode is expected to ingest racecards and odds under the nationwide claim |
| odds coverage | INFO | not_applicable | no stored races |
| rollup reconciliation | INFO | not_applicable | no stored races |
| country / region warnings | INFO | not_applicable | no stored races |
| required configuration | PASS | automatically_verified | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET present (presence only — no values); Supabase project host: xbbgrufmykodeqhrjdrq.supabase.co |
| server reachability | PASS | automatically_verified | read-only health endpoint responded for meeting date 2026-07-25 |
| local supervisor locks | PASS | operator_attested | no local supervisor.lock found for this date, and no other-machine producer known to be active — operator attestation only (--confirm-external) — NOT automatically verified by this command |
| Railway job state | PASS | operator_attested | Railway pipeline-refresh / selected-course jobs quiescent for this date — operator attestation only (--confirm-external) — NOT automatically verified by this command |
| Vercel cron state | PASS | operator_attested | no live Vercel deployment firing vercel.json crons — operator attestation only (--confirm-external) — NOT automatically verified by this command |
| bypass entry points | INFO | automatically_verified | gated by this preflight: nationwide:dry-run only. Still able to bypass ANY producer claim (operational restrictions — do not use while a nationwide claim is held): direct CRON_SECRET calls to /api/cron/racecards\|odds\|model\|results, POST /api/run-model, run:model, model:day, and any selected-course pipeline:day/pipeline:watch launch for this date (it will be refused by the claim, but its attempt still costs an RPC). |

## Next safe command (suggestion only — not executed)

```
npm run nationwide:dry-run -- --date 2026-07-25 --mode live-provider --report
```

---

Decision-support only — no betting, no bet placement.
