/**
 * CLI: persist official T-minus-N locked race decisions into the append-only
 * `locked_race_decisions` table (Newmarket rebuild Phase 2).
 *
 * For each race on a meeting day (optionally one course) it rebuilds the same
 * read-only T-minus capture the report CLI uses (scripts/tMinusCaptureData.ts),
 * classifies the commit window, and — ONLY with `--commit`, ONLY inside the
 * window `capture_target_time <= now <= off_time` — INSERTs one immutable
 * decision row. `minutes_before = 5` (the default) is the OFFICIAL decision.
 *
 * Usage:
 *   npm run lock:t-minus -- --date 2026-07-12 --course Newmarket            (dry run)
 *   npm run lock:t-minus -- --date 2026-07-12 --course Newmarket --commit   (persist)
 *
 * SAFETY:
 *   - DRY RUN BY DEFAULT: without `--commit` nothing is persisted, ever.
 *   - ONE TIMESTAMP: `scriptNow` is captured once at startup and used for BOTH
 *     the window classification and the inserted `lock_time`, so a race that
 *     passes `now <= off_time` cannot fail the DB's `lock_time <=
 *     off_time_at_lock` CHECK via a later default now().
 *   - INSERT ONLY: this script never updates, upserts, or deletes. An existing
 *     lock (pre-checked, and re-checked via the unique-violation insert error)
 *     is reported as `already_locked` and left untouched — reruns are safe.
 *   - It NEVER runs the model, fetches live odds, imports/settles results, or
 *     places bets. Too-early races are `too_early_not_locked`; post-off or
 *     resulted races are `skipped_post_off`; neither is ever persisted.
 *   - Per-race failures are isolated: one bad race increments `errors` and the
 *     loop continues.
 *
 * Decision-support only — locked rows are research decision records, not bets.
 * Credentials load from `.env.local` / `.env` and are never printed.
 */

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import {
  loadEnv,
  fetchMeetingRaces,
  buildRaceCapture,
} from './tMinusCaptureData';
import {
  LOCKED_DECISIONS_TABLE,
  parseLockTMinusArgs,
  classifyLockWindow,
  buildLockedDecisionRow,
  summarizeLockOutcomes,
  renderLockOutcomeLine,
  renderLockRunSummary,
  isUniqueViolation,
  type LockRaceOutcome,
} from '../src/lib/lockTMinus';

async function main(): Promise<void> {
  loadEnv();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }

  const args = parseLockTMinusArgs(process.argv.slice(2));
  if (!args.date || args.minutesBefore === undefined) {
    console.error(
      'Usage: npm run lock:t-minus -- --date YYYY-MM-DD [--course <name>] [--minutes-before N] [--commit]\n' +
        '(N is a positive integer, default 5 — the official horizon. DRY RUN by default:\n' +
        'only --commit persists in-window decisions to locked_race_decisions. Existing\n' +
        'locks are never touched; too-early and post-off races are never persisted.)',
    );
    process.exitCode = 1;
    return;
  }
  const minutesBefore = args.minutesBefore;

  // THE single timestamp: window classification AND inserted lock_time.
  const scriptNowIso = new Date().toISOString();

  const races = await fetchMeetingRaces(args.date, args.course ?? null);

  const outcomes: LockRaceOutcome[] = [];
  for (const race of races) {
    const raceId = String(race.id);
    const base = {
      race_id: raceId,
      race_name: race.race_name,
      off_time: race.off_time,
    };
    try {
      // 1. Existing lock? Read-only pre-check; the row is never touched.
      const { data: existing, error: existingError } = await supabaseAdmin
        .from(LOCKED_DECISIONS_TABLE)
        .select('id, decision_status')
        .eq('race_id', raceId)
        .eq('minutes_before', minutesBefore)
        .maybeSingle();
      if (existingError) {
        throw new Error(`failed to read existing lock: ${existingError.message}`);
      }
      if (existing) {
        outcomes.push({
          ...base,
          kind: 'already_locked',
          detail: `existing ${String((existing as { decision_status?: unknown }).decision_status ?? 'lock')} row kept (never mutated)`,
        });
        continue;
      }

      // 2. Rebuild the T-minus state from stored history (read-only, shared
      //    with capture:t-minus — never runs the model, never fetches odds).
      const capture = await buildRaceCapture(race, minutesBefore);

      // 3. Commit-window classification at scriptNow.
      const window = classifyLockWindow(
        {
          off_time: capture.off_time,
          capture_target_time: capture.capture_target_time,
          status: race.status,
        },
        scriptNowIso,
      );
      if (window === 'too_early') {
        outcomes.push({
          ...base,
          kind: 'too_early_not_locked',
          detail: `window opens at ${capture.capture_target_time}`,
        });
        continue;
      }
      if (window === 'post_off') {
        outcomes.push({ ...base, kind: 'skipped_post_off', detail: null });
        continue;
      }
      if (window === 'no_window') {
        outcomes.push({
          ...base,
          kind: 'error',
          detail: 'missing/unparseable off time — no lock window can be established',
        });
        continue;
      }

      // 4. In-window: build the immutable decision row.
      const row = buildLockedDecisionRow(capture, minutesBefore, scriptNowIso);
      if (row === null) {
        // Defensive: classifyLockWindow already required both timestamps.
        outcomes.push({
          ...base,
          kind: 'error',
          detail: 'in-window race unexpectedly missing off/capture-target time',
        });
        continue;
      }
      const pickDetail =
        row.decision_status === 'locked_pick'
          ? `pick: ${row.pick_horse_name ?? '(unknown)'}`
          : row.decision_status === 'locked_no_bet'
            ? `reason: ${row.no_bet_reason}`
            : 'no model run at/before the capture target';

      // 5. Dry run (default): report what WOULD be written; persist nothing.
      if (!args.commit) {
        outcomes.push({
          ...base,
          kind: row.decision_status,
          detail: `${pickDetail} [dry-run — not persisted]`,
        });
        continue;
      }

      // 6. Commit: INSERT only. A unique violation means another invocation
      //    locked the race after our pre-check — already_locked, not an error.
      const { error: insertError } = await supabaseAdmin
        .from(LOCKED_DECISIONS_TABLE)
        .insert(row);
      if (insertError) {
        if (isUniqueViolation(insertError)) {
          outcomes.push({
            ...base,
            kind: 'already_locked',
            detail: 'concurrent lock won the insert (row kept, never mutated)',
          });
          continue;
        }
        throw new Error(`insert failed: ${insertError.message}`);
      }
      outcomes.push({ ...base, kind: row.decision_status, detail: pickDetail });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  race ${raceId}: ${message}`);
      outcomes.push({ ...base, kind: 'error', detail: message });
    }
  }

  for (const outcome of outcomes) {
    console.log(renderLockOutcomeLine(outcome));
  }
  console.log('');
  for (const line of renderLockRunSummary(summarizeLockOutcomes(outcomes), {
    date: args.date,
    course: args.course ?? null,
    minutesBefore,
    commit: args.commit,
    lockTimeIso: scriptNowIso,
  })) {
    console.log(line);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
