# Migration Apply Plan — 2026-06-19

> **Scope & safety.** This is a *plan only*. It applies nothing, runs no SQL, and
> mutates no database. Every migration referenced is **additive and idempotent**
> (`create … if not exists` / `create or replace` / guarded `do $$ … $$`) — none
> drops a column, constraint, index, or row. A human applies each batch
> deliberately, in order, after a verified backup, using the **service-role**
> connection only.
>
> No model logic, recommendation logic, or staking logic changes here. Nothing
> places bets. Responsible use only — not betting advice.
> Help: [GamCare](https://www.gamcare.org.uk) · [BeGambleAware](https://www.begambleaware.org).

**Companion docs:** [docs/LAUNCH_SCHEMA_SYNC_RUNBOOK.md](LAUNCH_SCHEMA_SYNC_RUNBOOK.md)
(the standing runbook) and the read-only checker `npm run schema:launch-check`
(pure spec in [src/lib/launchSchemaSpec.ts](../src/lib/launchSchemaSpec.ts)).

---

## 0. Hard rules

- **Do not** run `supabase db push` from this plan. A human applies each file.
- **Do not** mutate data. These migrations only *add* objects.
- **Read-only verification first** (Section 1) — confirm the *actual* live state
  before trusting the reported gap list.
- **Backup first.** No apply before a verified Supabase backup / PITR point.
- **Service-role key only.** Never the `anon` / publishable key. Never paste a
  secret into a shared surface.
- **Apply one file at a time, in timestamp order**, verifying between files.
- **Race-day freeze:** no schema change within **30 minutes** of any race
  off-time. Confirm there is no live card before starting.

---

## 1. Confirm the live state first (read-only — do this before anything)

The gap list below is the *reported* state. Confirm it against the live DB before
applying anything (a prior `check:db` reported all tables present, so the two
must be reconciled — never apply blind).

```bash
npm run schema:launch-check
```

Then run this single read-only probe in the **Supabase SQL editor** (service-role
connection). It writes nothing:

```sql
-- 1a. Tables the repo migrates (present = migration already applied).
select t as object,
       to_regclass('public.' || t) is not null as present
from unnest(array[
  'tipster_selections',
  'tipster_source_registry',
  'tipster_selection_candidates',
  'tipster_discovery_runs',
  'tipster_discovery_candidates',
  'tipster_dynamic_weights',
  'genai_commentary',
  'cron_runs',
  'ml_training_examples',
  'model_run_locks'
]) as t
order by t;

-- 1b. The model-lock RPCs (present = lock migration already applied).
select 'try_acquire_model_lock(uuid,text,integer)' as fn,
       to_regprocedure('public.try_acquire_model_lock(uuid, text, integer)') is not null as present
union all
select 'release_model_lock(uuid,text)',
       to_regprocedure('public.release_model_lock(uuid, text)') is not null;

-- 1c. field_coverage — expected FALSE; there is no migration for it (see No-Go).
select to_regclass('public.field_coverage') is not null as field_coverage_present;
```

Apply only the batches whose objects come back `present = false`. Re-running an
already-applied file is safe (idempotent) but unnecessary.

---

## 2. Full migration inventory (apply order = filename timestamp order)

| # | Migration file | Creates / alters | Status vs live DB |
| --- | --- | --- | --- |
| 1 | `20260612000000_create_tipster_selections.sql` | `tipster_selections` | Assumed **present** (verify) |
| 2 | `20260615000000_add_model_run_audit_fields.sql` | `model_runs` audit columns | Assumed **present** (verify) |
| 3 | `20260615010000_add_model_history_flags.sql` | `is_current` / `superseded_at` + history indexes | Assumed **present** (verify) |
| 4 | `20260615020000_tipster_selections_idempotency.sql` | `tipster_selections_dedupe_idx` | Assumed **present** (verify) |
| 5 | `20260616000000_tipster_source_registry_and_candidates.sql` | `tipster_source_registry`, `tipster_selection_candidates` | Assumed **present** (verify) |
| 6 | `20260616010000_tipster_candidate_evidence_fields.sql` | candidate evidence columns | Assumed **present** (verify) |
| 7 | `20260618000000_tipster_discovery_engine.sql` | `tipster_discovery_runs`, `tipster_discovery_candidates` + 2 registry columns | **MISSING** → Batch A |
| 8 | `20260618010000_tipster_dynamic_weights.sql` | `tipster_dynamic_weights` | **MISSING** → Batch A |
| 9 | `20260618020000_genai_commentary.sql` | `genai_commentary` (shadow, review-gated) | **MISSING** → Batch A |
| 10 | `20260618030000_cron_runs.sql` | `cron_runs` | **MISSING** → Batch A |
| 11 | `20260618040000_ml_training_examples.sql` | `ml_training_examples` | **MISSING** → Batch B |
| 12 | `20260618050000_model_run_locks.sql` | `model_run_locks` + `try_acquire_model_lock()` + `release_model_lock()` | **MISSING** → Batch C |
| 13 | `20260618060000_rls_harden_recent_tables.sql` | RLS enable + grant lock-down on 9 internal tables/2 functions | **Apply LAST** → Batch C |
| — | *(no file)* | `field_coverage` | **PHANTOM — no migration** → Batch D (No-Go) |

### 2.1 Likely already represented in the DB (verify, do not re-apply blind)

Migrations **#1–#6**. The live DB already serves `tipster_selections`, model-run
audit/history columns, and the tipster source-registry / candidate tables, so
these are assumed applied. Section 1a/1b confirms. If any come back
`present = false`, apply that file **before** the batch that depends on it (see
preconditions).

### 2.2 Missing (the work this plan schedules)

Migrations **#7, #8, #9, #10, #11, #12** plus a **final (re-)apply of #13** to
harden the newly-created tables. Mapped to batches A → B → C below.

---

## 3. Batches

Apply **A → B → C**. Batch **D does not apply** (No-Go). The cross-batch apply
order is exactly the filename order: `7 → 8 → 9 → 10 → 11 → 12 → 13`.

> **Global precondition (all batches):** the baseline tables `tipsters`, `races`,
> `runners`, `model_runs` must exist (foreign-key targets). They have no
> `create table` migration — restore them from the schema baseline if Section 1
> shows them missing. Also confirm **#5** (`tipster_source_registry`) is present
> before Batch A — migration #7 *alters* it.

---

### Batch A — operational tables

System / decision-support / monitoring tables. All **fail-open** and inert until a
caller writes to them; none is read by the betting model.

- **SQL files (in order):**
  1. `20260618000000_tipster_discovery_engine.sql`
  2. `20260618010000_tipster_dynamic_weights.sql`
  3. `20260618020000_genai_commentary.sql`
  4. `20260618030000_cron_runs.sql`
- **Preconditions:** `tipster_source_registry` (migration #5) and base tables
  `tipsters`, `races`, `model_runs` exist (FK targets; #7 also adds two columns
  to `tipster_source_registry`).
- **Expected after applying:**
  - Tables: `tipster_discovery_runs`, `tipster_discovery_candidates`,
    `tipster_dynamic_weights`, `genai_commentary`, `cron_runs`.
  - New columns on `tipster_source_registry`: `supports_discovery`,
    `last_discovered_at`.
  - `genai_commentary.model_active` has a `CHECK (model_active = false)` shadow
    guard (a model-active row is physically un-insertable).
  - Indexes: `tipster_discovery_runs_source_idx`,
    `tipster_discovery_candidates_source_name_uidx` (unique),
    `tipster_discovery_candidates_status_idx`,
    `tipster_discovery_candidates_tipster_idx`,
    `tipster_dynamic_weights_tipster_date_uidx` (unique),
    `tipster_dynamic_weights_as_of_idx`, `genai_commentary_race_idx`,
    `genai_commentary_review_idx`, `cron_runs_job_finished_idx`,
    `cron_runs_finished_idx`.
  - **No RLS yet** — these tables are created RLS-disabled; Batch C (#13) hardens
    them. Do not leave Batch A applied without Batch C before launch.
- **Verification SQL (read-only):**

  ```sql
  -- A.1 tables present
  select t, to_regclass('public.'||t) is not null as present
  from unnest(array[
    'tipster_discovery_runs','tipster_discovery_candidates',
    'tipster_dynamic_weights','genai_commentary','cron_runs'
  ]) t order by t;

  -- A.2 discovery columns added to the existing registry (expect 2 rows)
  select column_name
  from information_schema.columns
  where table_schema='public' and table_name='tipster_source_registry'
    and column_name in ('supports_discovery','last_discovered_at')
  order by column_name;

  -- A.3 genai_commentary shadow guard (expect a CHECK with "model_active = false")
  select conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
  where conrelid = 'public.genai_commentary'::regclass and contype = 'c'
  order by conname;

  -- A.4 indexes exist
  select tablename, indexname from pg_indexes
  where schemaname='public'
    and tablename in ('tipster_discovery_runs','tipster_discovery_candidates',
                      'tipster_dynamic_weights','genai_commentary','cron_runs')
  order by tablename, indexname;
  ```

- **Rollback notes:** Additive — the safest reversal is to **leave the objects in
  place** (inert until used). If an operator must reverse, only on tables this
  batch created and that hold no data you need:
  `drop table if exists public.cron_runs;` (and the others). The two registry
  columns: `alter table public.tipster_source_registry drop column if exists
  supports_discovery, drop column if exists last_discovered_at;`. Prefer restoring
  from the Section-0 backup. **Never drop a base/data table.**
- **Race-day risk: LOW.** Nothing here is on a race-day write path. `cron_runs` is
  written best-effort by cron (a failed insert never breaks a job); discovery,
  dynamic weights, and `genai_commentary` are advisory / shadow / review-gated.
  Still observe the 30-minute freeze.

---

### Batch B — learning / capture tables

The self-building, append-only ML training dataset. **Strictly shadow** — never
read by the production model; never changes probability, EV, staking, ranking, or
any recommendation.

- **SQL files:**
  1. `20260618040000_ml_training_examples.sql`
- **Preconditions:** base tables `races`, `runners`, `model_runs` exist (FK
  targets). Independent of Batch A — but apply after A to keep filename order.
- **Expected after applying:**
  - Table `ml_training_examples` with leakage-segregated columns: pre-off
    **features** (`recommended`, `recommendation_rank`, `model_prob`,
    `market_prob`, `edge`, `ev`, `odds`, `confidence_score`, `confidence_label`,
    `is_favourite`) and post-race **labels** (`finish_pos`, `won`, `placed`,
    `favourite_won`, `favourite_placed`, `bsp_decimal`, `sp_decimal`).
  - Indexes: `ml_training_examples_race_runner_uidx` (unique),
    `ml_training_examples_meeting_idx`.
  - **No RLS yet** — hardened by Batch C (#13).
- **Verification SQL (read-only):**

  ```sql
  -- B.1 table present
  select to_regclass('public.ml_training_examples') is not null as ml_training_examples_present;

  -- B.2 indexes present (expect both)
  select indexname from pg_indexes
  where schemaname='public' and tablename='ml_training_examples'
  order by indexname;

  -- B.3 feature + label columns both present (leakage segregation is by column, not table)
  select column_name from information_schema.columns
  where table_schema='public' and table_name='ml_training_examples'
    and column_name in ('model_prob','ev','odds','finish_pos','won','placed','bsp_decimal','sp_decimal')
  order by column_name;
  ```

- **Rollback notes:** Additive. Leave in place, or
  `drop table if exists public.ml_training_examples;` (operator only; it is a
  capture store — confirm you do not need the rows). Prefer backup restore.
- **Race-day risk: LOW.** Capture runs best-effort *after* a race settles and is
  never read by the live model. No effect on in-race behaviour.

---

### Batch C — locks / RLS

Concurrency control for model runs, then the security hardening. **Apply #13
LAST** — it enables RLS and revokes the public-API grants on **all nine** internal
tables (Batch A + B + the lock table) and locks the lock-function grants to
`service_role`.

- **SQL files (in order):**
  1. `20260618050000_model_run_locks.sql`
  2. `20260618060000_rls_harden_recent_tables.sql` ← **last**
- **Preconditions:** Batches A and B applied first (so #13 hardens the tables they
  created — it is guarded with `to_regclass` / `to_regprocedure` and silently
  skips any object that is still absent, which would leave that table unhardened).
- **Expected after applying:**
  - Table `model_run_locks` (per-race TTL lease, `race_id` PK).
  - Functions `try_acquire_model_lock(uuid, text, integer)` and
    `release_model_lock(uuid, text)`, both `SECURITY DEFINER`, `EXECUTE` granted
    to `service_role` only.
  - RLS **enabled** on all nine internal tables; `anon` / `authenticated` have
    **no** privileges; `service_role` retains full access (it bypasses RLS).
- **Verification SQL (read-only):**

  ```sql
  -- C.1 lock table + functions present
  select to_regclass('public.model_run_locks') is not null as model_run_locks_present;
  select
    to_regprocedure('public.try_acquire_model_lock(uuid, text, integer)') is not null as try_acquire_present,
    to_regprocedure('public.release_model_lock(uuid, text)') is not null as release_present;

  -- C.2 RLS enabled on every internal table (expect relrowsecurity = true for each present row)
  select relname, relrowsecurity
  from pg_class
  where relnamespace = 'public'::regnamespace
    and relname in (
      'tipster_source_registry','tipster_selection_candidates','tipster_discovery_runs',
      'tipster_discovery_candidates','tipster_dynamic_weights','genai_commentary',
      'cron_runs','ml_training_examples','model_run_locks')
  order by relname;

  -- C.3 anon / authenticated have NO table privileges on the internal tables (expect ZERO rows)
  select table_name, grantee, privilege_type
  from information_schema.role_table_grants
  where table_schema='public'
    and grantee in ('anon','authenticated')
    and table_name in (
      'tipster_source_registry','tipster_selection_candidates','tipster_discovery_runs',
      'tipster_discovery_candidates','tipster_dynamic_weights','genai_commentary',
      'cron_runs','ml_training_examples','model_run_locks')
  order by table_name, grantee;

  -- C.4 function grants: service_role can execute, anon cannot (expect: true, true, false)
  select
    has_function_privilege('service_role','public.try_acquire_model_lock(uuid, text, integer)','execute') as svc_try_acquire,
    has_function_privilege('service_role','public.release_model_lock(uuid, text)','execute')             as svc_release,
    has_function_privilege('anon','public.try_acquire_model_lock(uuid, text, integer)','execute')        as anon_try_acquire;
  ```

- **Rollback notes:**
  - Lock objects (fail-open): `drop function if exists
    public.try_acquire_model_lock(uuid, text, integer);` and
    `drop function if exists public.release_model_lock(uuid, text);` then
    `drop table if exists public.model_run_locks;` reverts to today's unprotected
    (but working) behaviour.
  - **RLS (#13) reversal is a security regression** — disabling RLS re-opens
    `anon` / `authenticated` access through the public API. Only
    `alter table public.<t> disable row level security;` if you are certain no
    public key can reach the project, and re-enable immediately. Prefer backup
    restore over hand-rollback.
- **Race-day risk: MEDIUM.**
  - `model_run_locks` is **fail-open** when absent, but once present the model /
    results / pipeline paths begin serialising per-race runs through it — a
    behaviour change. Apply and smoke-test in a **quiet window**, not mid-card.
  - **Never apply #13 (RLS) within 30 minutes of a race**, and verify grants on
    **both sides** of the apply. A mistaken grant change is the highest-impact
    action in this plan.

---

### Batch D — field coverage  🚫 NO-GO (do not apply)

- **SQL files:** **none.** There is no migration for `field_coverage`, and no code
  in the repo references it (confirmed in
  [src/lib/launchSchemaSpec.ts](../src/lib/launchSchemaSpec.ts) `UNRESOLVED_OBJECTS`).
- **Action:** **Do not invent a schema.** Before launch, decide one of:
  1. it is **not required** → drop `field_coverage` from the launch gap list; or
  2. it **is required** → author a dedicated, reviewed migration, then fold it into
     a future dated apply plan.
- **Verification SQL (read-only):**

  ```sql
  -- Expect false. Do NOT create it from this plan.
  select to_regclass('public.field_coverage') is not null as field_coverage_present;
  ```

- **Race-day risk:** N/A (nothing applied).

---

## 4. Recommended apply order

```bash
# Verify first (read-only, mutates nothing)
npm run schema:launch-check        # + Section 1 SQL (1a/1b/1c)

# Back up (Supabase Backups / PITR) and record the timestamp — required.

# Batch A — operational tables
20260618000000_tipster_discovery_engine.sql
20260618010000_tipster_dynamic_weights.sql
20260618020000_genai_commentary.sql
20260618030000_cron_runs.sql
#   -> run Batch A verification SQL; expect all present, 2 registry columns, shadow CHECK

# Batch B — learning / capture
20260618040000_ml_training_examples.sql
#   -> run Batch B verification SQL

# Batch C — locks / RLS  (RLS file LAST)
20260618050000_model_run_locks.sql
20260618060000_rls_harden_recent_tables.sql
#   -> run Batch C verification SQL; RLS true, anon/authenticated zero rows, svc can execute

# Batch D — field_coverage: DO NOT APPLY (no migration exists)

# Final: re-run the read-only check; expect PASS.
npm run schema:launch-check
```

Skip any file that Section 1 already shows `present = true`. Apply one file at a
time; verify between files; stop on the first surprise.

---

## 5. No-go warnings

1. **`field_coverage` has no migration.** It cannot be synced from this codebase.
   Do **not** hand-craft a table for it. Resolve (drop from list, or author a
   reviewed migration) before launch. *(Batch D.)*
2. **#13 (RLS) must be applied LAST and never blind.** Applied before the Batch
   A/B tables exist, its guards skip them, leaving new tables **RLS-disabled and
   publicly readable/writable** through the anon key. Re-apply #13 only after the
   tables exist, and verify grants on both sides.
3. **Reconcile the gap list with reality first.** A prior `check:db` reported all
   tables present, which conflicts with the reported missing list. Run
   `schema:launch-check` + Section 1 SQL and apply **only** what is truly absent.
4. **No apply without a verified backup.** Record the backup id/time first.
5. **Race-day freeze.** No schema change within 30 minutes of any off-time. Confirm
   there is no live card on 2026-06-19 before starting. Batch C is the highest-risk
   batch — quiet window only.
6. **Service-role only; never the anon key; never paste secrets** into the SQL
   editor, chat, logs, or commits.
7. **Never use `drop` / `truncate` / `delete` to "fix" a gap.** These migrations
   only add objects; a missing object is *created*, never replaced. No data drop,
   ever.

---

## 6. Final checklist

- [ ] Confirmed there is **no live race card** within 30 minutes (race-day freeze).
- [ ] Ran `npm run schema:launch-check` (read-only) and recorded the output.
- [ ] Ran Section 1 SQL (1a/1b/1c); recorded which objects are truly missing.
- [ ] Took / confirmed a **Supabase backup** (or PITR point); recorded the timestamp.
- [ ] Connected with the **service-role** key (not anon); no secret exposed.
- [ ] **Batch A** applied in file order; A.1–A.4 verification passed.
- [ ] **Batch B** applied; B.1–B.3 verification passed.
- [ ] **Batch C** applied (`model_run_locks` then RLS `#13` **last**); C.1–C.4 passed
      (RLS `true`, anon/authenticated **zero** privilege rows, `service_role` can
      execute the lock functions, `anon` cannot).
- [ ] **Batch D** (`field_coverage`) **not applied**; resolution decision recorded.
- [ ] Final `npm run schema:launch-check` returns **PASS**.
- [ ] Smoke-tested model run + dashboard in a quiet window (lock behaviour now active).
- [ ] No `supabase db push` was run by this plan; no data mutated; nothing committed
      from this plan without explicit human review.

---

*This plan documents the safe order, verification, rollback posture, and risks
only. It applies nothing itself.*
