# Launch Schema Sync Runbook

> **Scope & safety.** This runbook is an operational checklist for bringing a live
> Supabase database up to the schema the app expects, before launch. It changes no
> model logic, no recommendation logic, and places no bets. Every migration
> referenced is **additive and idempotent** (`create ... if not exists` /
> `create or replace` / guarded `do $$ ... $$`) — none drops a column, constraint,
> index, or row. **Verify read-only first; apply nothing automatically.**
>
> Responsible use only. Not betting advice. Help:
> [GamCare](https://www.gamcare.org.uk) · [BeGambleAware](https://www.begambleaware.org).

---

## 0. Hard rules

- **Back up first** (Section 2). No apply before a verified backup.
- **Read-only verification first** — `npm run schema:launch-check` mutates nothing.
- **Service-role key only.** Never use the anon / publishable key for these checks.
- **No automated `supabase db push`.** A human applies each migration deliberately.
- **No destructive SQL.** Never `drop`/`truncate`/`delete` to "fix" a gap. These
  migrations only add objects; a missing object is created, never replaced.
- **No data drop, ever.**
- **No race-day schema changes within 30 minutes of any race off-time** (Section 7).

---

## 1. Read-only verification (do this first)

```
npm run schema:launch-check
```

This probes (read-only, no writes):

- all required **base tables** + their columns,
- all new **operational tables** (`cron_runs`, `ml_training_examples`,
  `model_run_locks`, `genai_commentary`, the tipster discovery/weight tables),
- the **RPC functions** (`try_acquire_model_lock`, `release_model_lock`) via an
  empty-arg existence probe that never executes them,

and prints **PASS/FAIL**, the **missing tables / columns / functions**, and the
**exact migrations likely needed**.

Indexes, **RLS status**, and **grants** are not exposed by the data API, so the
checker prints **read-only SQL** for you to run in the **Supabase SQL editor**
(it never runs it). Run that block and confirm:

1. every required index exists,
2. `try_acquire_model_lock` + `release_model_lock` exist,
3. `relrowsecurity = true` for each internal table,
4. `anon` / `authenticated` have **no** privileges on the internal tables,
5. `service_role` has `EXECUTE` on the lock functions; `anon` does not.

> Known live gaps this targets: `cron_runs`, `ml_training_examples`,
> `model_run_locks`, `try_acquire_model_lock`, `release_model_lock`.

### `field_coverage` — unresolved

The launch list mentioned a `field_coverage` table, but **this repository has no
migration and no code that references it**. It cannot be synced from this codebase.
Before launch, decide one of: (a) it is not required → drop it from the list; or
(b) it is required → author and review a dedicated migration. Do **not** invent a
schema for it here.

---

## 2. Back up first (required)

Do **both** where possible, and record the backup id/time:

- **Supabase**: Dashboard → Database → **Backups** → take/confirm a fresh backup
  (or a PITR restore point). Note the timestamp.
- **Logical dump** (optional belt-and-braces), run by an operator from a trusted
  machine — never paste credentials into chat or commit them:

  ```
  pg_dump --schema-only "$SUPABASE_DB_URL" > backup-schema-<date>.sql
  pg_dump --data-only --table=public.runners --table=public.recommendations \
    "$SUPABASE_DB_URL" > backup-keydata-<date>.sql
  ```

Do not proceed until the backup is confirmed.

---

## 3. Apply migrations IN ORDER

Apply by pasting each file into the **Supabase SQL editor** (preferred for control),
or via `supabase db push` run **manually by the operator** (this runbook never runs
it for you). Apply in **filename order** (timestamp prefix = apply order). All are
additive + idempotent, so re-running a file is safe.

Full additive set (apply any that the check reported missing, in this order):

| # | Migration file | Adds |
|---|---|---|
| 1 | `20260615000000_add_model_run_audit_fields.sql` | model-run audit columns |
| 2 | `20260615010000_add_model_history_flags.sql` | `is_current`/`superseded_at` + history indexes |
| 3 | `20260615020000_tipster_selections_idempotency.sql` | `tipster_selections_dedupe_idx` |
| 4 | `20260616000000_tipster_source_registry_and_candidates.sql` | `tipster_source_registry`, `tipster_selection_candidates` |
| 5 | `20260616010000_tipster_candidate_evidence_fields.sql` | candidate evidence columns |
| 6 | `20260618000000_tipster_discovery_engine.sql` | `tipster_discovery_runs`, `tipster_discovery_candidates` |
| 7 | `20260618010000_tipster_dynamic_weights.sql` | `tipster_dynamic_weights` |
| 8 | `20260618020000_genai_commentary.sql` | `genai_commentary` (shadow, review-gated) |
| 9 | `20260618030000_cron_runs.sql` | `cron_runs` |
| 10 | `20260618040000_ml_training_examples.sql` | `ml_training_examples` |
| 11 | `20260618050000_model_run_locks.sql` | `model_run_locks` + `try_acquire_model_lock` + `release_model_lock` |
| 12 | `20260618060000_rls_harden_recent_tables.sql` | **RLS enable + grant lock-down** — apply **LAST** |

**Why #12 is last:** it enables RLS and revokes the public-API grants on the
internal tables and locks the lock-function grants to `service_role`. It is guarded
(`to_regclass` / `to_regprocedure`), so it safely skips any object that does not yet
exist — but applying it last guarantees every internal table/function is hardened.

### Minimal gap-closing set (for the reported live gaps)

If only the operational gaps are missing, apply **#9 → #10 → #11 → #12** in that
order.

---

## 4. Verify after each batch

After each migration (or each small batch), re-run:

```
npm run schema:launch-check
```

and re-run the **manual verification SQL** it prints. Expect the **Missing** lists
to shrink and **PASS** once all required tables/columns/functions are present.
After #12, confirm via SQL sections 3–5 that RLS is **on** and `anon`/`authenticated`
have **no** access. Do not move to the next batch while the previous one is unverified.

---

## 5. Rollback notes

These migrations are **additive**, so the safest "rollback" is usually to **leave the
new objects in place** (they are inert until used). If you must reverse one:

- **Tables (`cron_runs`, `ml_training_examples`, `model_run_locks`, …):** the app is
  **fail-open** for the operational tables (e.g. `model_run_locks` degrades to
  today's unprotected behaviour if absent). Only an operator may
  `drop table if exists public.<t>;` — and **only** a table this batch created and
  that holds no data you need. Never drop a base/data table.
- **Functions:** `drop function if exists public.try_acquire_model_lock(uuid, text, integer);`
  and `…release_model_lock(uuid, text);` revert to fail-open locking.
- **RLS hardening (#12):** reversing it **re-opens** anon/authenticated access — a
  **security regression**. Only disable RLS if you are certain no public key can
  reach the project, and re-enable as soon as possible:
  `alter table public.<t> disable row level security;` (caution).
- Prefer **restoring from the Section 2 backup** over hand-written rollback SQL.

Never use rollback as a shortcut, and never drop data.

---

## 6. Production caution

- Apply in a **maintenance window**, lowest-traffic time, with an operator watching.
- Run the **read-only check first** and the **manual SQL** both **before and after**.
- Confirm the **service-role** key is in use (never the anon key) and that **no**
  secret is pasted into a shared surface.
- Apply **one file at a time**, verifying between files; stop on the first surprise.
- The cron jobs are **fail-open** for the new tables, so a partial apply degrades
  gracefully rather than breaking the app — but finish the batch promptly.

---

## 7. Race-day freeze

- **No schema changes within 30 minutes of any race off-time.** Schema work is a
  pre-day or post-day activity.
- If a gap is discovered during racing, prefer the **fail-open** behaviour (the app
  keeps running without the new table/function) and apply the migration **after the
  last race**, then verify with `npm run schema:launch-check`.
- Never apply migration #12 (RLS) mid-card; do it in a quiet window with verification
  on both sides.

---

## 8. Quick reference

```
# read-only verification (mutates nothing)
npm run schema:launch-check

# then, after a confirmed backup, apply the reported migrations IN ORDER via the
# Supabase SQL editor (or operator-run `supabase db push`), re-verifying after each.
```

This runbook applies nothing itself. It documents the safe order, the verification,
and the rollback posture only.
