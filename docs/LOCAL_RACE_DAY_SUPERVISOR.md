# Local Race-Day Supervisor (Windows) — ownership-aware launcher

One local command validates the day, runs the Producer Readiness Preflight
gate, and only then starts the race-day producer stack in visible windows.
The web dashboard stays a **web dashboard only** (no Railway changes, no
cron/worker conversion). Everything runs through the existing safe npm
scripts — the supervisor adds **no** new database access, **no** betting, and
changes **no** model/staking/confidence logic.

Decision-support only — no auto-betting, no bet placement, anywhere.

---

## 1. Starting a race day

Date and course are **required** — there are no defaults, so a stale
hardcoded meeting can never launch by accident:

```bat
race-day-local\start-race-day.bat YYYY-MM-DD "Course Name"
```

To rehearse safely without starting anything (Gate C / dry planning):

```bat
race-day-local\start-race-day.bat YYYY-MM-DD "Course Name" --preflight-only
```

The course must be a single selected course. Allowed characters: letters,
digits, spaces, hyphen, apostrophe, parentheses, period. Anything else — and
every spelling of the reserved nationwide scope (`all-uk-ire` / `all uk ire`)
— is rejected before anything runs.

### What the launcher does, in order

1. **Validates** date/course and builds the scoped dashboard URLs
   (read-only `race-day:launch-check` helper).
2. **Acquires the local launcher lock** — an atomic lock *directory*
   `logs\race-day-<date>-<slug>\supervisor.lock\` created **before** the
   preflight, the initial pipeline, and every watcher window. If it already
   exists the launcher refuses, starts **nothing**, and prints recovery steps.
   The lock directory is **never deleted automatically** when found. It holds
   only date/course/slug/created_at — no secrets. The **database producer
   claim remains the authoritative cross-machine guard**; this local lock only
   prevents two three-window supervisors on the same machine.
3. **Runs the preflight gate**:
   `producer:preflight --require-server` (never `--confirm-external` on the
   first run).
   - **BLOCKED (exit 2) or usage (exit 1)** → nothing starts; the just-created
     lock is removed (no children were started); the launcher exits non-zero.
   - **REVIEW (exit 3)** → the launcher lists the checks that remain MANUAL
     (Railway job state, Vercel cron/deployment state, legacy local
     producers) and asks you to type **CONTINUE** — exactly, in capitals.
     Typing CONTINUE is an **operator attestation** that you completed those
     checks yourself; it is logged as your attestation, never as automatic
     verification. Anything else aborts with nothing started. After CONTINUE
     the preflight is re-run **with** `--confirm-external --require-server`,
     and only a READY (exit 0) verdict continues.
   - **READY (exit 0)** → continue.
4. **`--preflight-only` mode** stops here: it prints the three planned watcher
   commands and the dashboard URLs, removes its own lock, and exits having
   started zero pipelines, zero watchers, and made zero writes.
5. **Initial load**: `pipeline:day --commit` (ownership-aware — it claims,
   runs, releases). If it fails, **no watcher windows are launched**, the lock
   is removed (no children), and the launcher exits with the pipeline's code.
6. **Three watcher windows** open and stay up all day:

| Window title      | What it does | Cycle |
| ----------------- | ------------ | ----- |
| `PIPELINE WATCH…` | `pipeline:watch --interval-minutes 5 --commit` — owns the producer claim for the whole day (60s heartbeat), refreshes odds + reruns models, post-off guard skips started races. Exit-code-aware wrapper: see §4. | 5 min (internal) |
| `LOCK WATCH…`     | `lock:t-minus --minutes-before 5 --commit` — the official T-minus-5 locks. **Claim-exempt and independent.** Idempotent: reruns report `already_locked`; too-early/post-off races are never persisted. | every 120 s |
| `RESULTS WATCH…`  | `results:auto` **dry-run first**, then `results:auto --commit` only when the dry-run exited cleanly. **Claim-exempt and independent.** All gates live inside the script. | every 10 min |

Finally, the **dashboard links** are printed: the local URL always; the
production URL only when `PUBLIC_DASHBOARD_URL` is configured (see §6) —
otherwise `Production dashboard: not configured`.

## 2. Stopping a race day

1. `Ctrl+C` in the **pipeline** window (twice if the countdown is running) —
   the watcher releases the database producer claim on a clean stop. A killed
   window's claim simply TTL-expires (240 s); nothing is stuck.
2. `Ctrl+C` / close the **lock** and **results** windows.
3. In the launcher window, type **STOPPED** (exactly) at the prompt — *only
   after all three watcher windows are closed*. That removes the local
   launcher lock. Any other input keeps the lock and re-prompts.

If the launcher window was closed or crashed: the local lock stays behind
**by design**. Recovery: verify no PIPELINE/LOCK/RESULTS windows are open for
that date/course, then delete `logs\race-day-<date>-<slug>\supervisor.lock\`
yourself. Deleting the local lock never touches the database producer claim.
Never assume the watchers stopped just because the launcher window closed.

## 3. What good output looks like

- **Launcher:** preflight verdict READY (directly, or REVIEW + your CONTINUE
  attestation + READY), `pipeline:day` summary with races found, three
  windows up.
- **PIPELINE WATCH:** a cycle summary every ~5 minutes; races that have gone
  off are reported as skipped (`skipped_post_off`) — correct, never an error.
- **LOCK WATCH:** every 2 minutes a summary; `too_early_not_locked` before a
  race's window, one `locked_pick` / `locked_no_bet` per race in the window,
  `already_locked` afterwards. End of day: locked count ≈ race count.
- **RESULTS WATCH:** `dry-run clean — running results:auto --commit`, then
  `commit cycle finished cleanly.` `Nothing committed` early in the day is
  normal (no results yet).
- **Dashboard:** Proof-of-Update locks row accumulating, no `LOCK MISSING`
  while racing is live, performance block labelled OFFICIAL/MIXED.

## 4. What bad output looks like (and what to do)

The pipeline window is exit-code aware and **never loops blindly**:

| Pipeline window says | Meaning | What to do |
| --- | --- | --- |
| `stopped GRACEFULLY (exit 0)` | Deliberate stop (until/max-cycles/Ctrl+C) | Nothing — not restarted |
| `TERMINAL: producer OWNERSHIP refused or lost (exit 3)` | Another producer holds/took the date's claim | `npm run producer:claim-check -- --date <date>`; stop the other producer or wait for its TTL, then re-run the launcher |
| `TERMINAL: claim mechanism unavailable/uncertain (exit 2)` | Fail-closed — Supabase/RPC problem | Investigate connectivity; nothing ran after the failure |
| `bounded retry n/5 in 60 seconds` | Generic failure/crash | It retries at most 5 times, then stays visibly DEGRADED |

Other cases:

- `LOCK MISSING` on the dashboard for a race whose off has passed → that
  race's lock window was missed (a fact, never backfilled); check
  lock-watch.log. Official figures treat it as a separate bucket, never a
  loss.
- `Refusing to commit — … safety gate(s) failed` in results-watch.log →
  results source was blocked/partial/ambiguous; nothing was written. Settle
  later via the manual CSV importer (`docs/MANUAL_RESULTS_IMPORT.md`).
- Same-day note: the free/basic results endpoints work **today only**. If any
  race is still unsettled after midnight, use the manual CSV importer.
- Launcher says a local lock already exists → see §2 recovery. It started
  nothing.

## 5. Logs

Everything is appended under:

```text
logs\race-day-<date>-<course-slug>\
  supervisor.log       (launcher lifecycle: lock, preflight verdicts + exit
                        codes, your CONTINUE attestation as a factual event,
                        watcher launches, STOPPED cleanup)
  preflight.log        (both preflight runs' full output)
  pipeline-day.log     (initial load)
  pipeline-watch.log   (incl. every watcher exit code, retry, terminal state)
  lock-watch.log
  results-watch.log
  supervisor.lock\     (the local launcher lock directory + metadata.txt)
```

No log ever contains keys, tokens, `CRON_SECRET`, provider credentials,
authorization headers, or environment values. The `logs/` folder is
gitignored — local operator artefacts only.

## 6. Configuration (optional, non-secret)

- `PUBLIC_DASHBOARD_URL` — the public dashboard origin (e.g. your deployed
  web app). When set and valid (http/https, no URL credentials), the launcher
  prints a scoped production link `?date=…&course=…`. When absent:
  `Production dashboard: not configured`. This is deliberately **distinct**
  from any pipeline base URL and is never guessed.
- The local dashboard link always uses the validated local base URL
  (default `http://localhost:3000`).

## 7. What writes to Supabase (and what never does)

| Command | Writes? | Gate |
| ------- | ------- | ---- |
| `pipeline:day` / `pipeline:watch` | Yes, with `--commit` | producer-ownership claim first; racecards/odds/model runs only; post-off guard skips started races |
| `lock:t-minus --commit` | Yes | insert-only into `locked_race_decisions`; commit window enforced; `already_locked` on rerun; UPDATE blocked by trigger |
| `results:auto` (no flag) | **Never** | dry-run/audit only |
| `results:auto --commit` | Only when every safety gate passes | same-day sources only, per-race gate, loud refusal otherwise; SP/BSP never fabricated |
| `producer:preflight` | **Never** | read-only readiness verdict (status RPC + SELECTs + fixed health probe) |
| `race-day:launch-check` | **Never** | pure argument validation + URL building |
| The `.bat` supervisor files | **Never** | they only sequence the npm scripts above |

No script anywhere places bets. Locked decisions are only ever written by
`lock:t-minus` and are immutable once written. The launcher never releases
the database producer claim — only the pipeline watcher (or TTL expiry) does.
