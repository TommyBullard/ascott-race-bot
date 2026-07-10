/**
 * Source-scan tests for the local race-day supervisor (race-day-local/*.bat +
 * docs/LOCAL_RACE_DAY_SUPERVISOR.md).
 *
 * The supervisor is Windows batch, so these tests verify its SOURCE (never
 * executing the loops): each watcher calls only the existing safe npm scripts
 * with the agreed flags and cadence, the results watcher gates --commit on a
 * clean dry-run, nothing touches the database or betting directly, and the
 * runbook documents start/stop and the phone URL. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LAUNCHER = readFileSync('race-day-local/start-race-day.bat', 'utf8');
const PIPELINE = readFileSync('race-day-local/watch-pipeline.bat', 'utf8');
const LOCKS = readFileSync('race-day-local/watch-locks.bat', 'utf8');
const RESULTS = readFileSync('race-day-local/watch-results.bat', 'utf8');
const RUNBOOK = readFileSync('docs/LOCAL_RACE_DAY_SUPERVISOR.md', 'utf8');
const ALL_BATS = [LAUNCHER, PIPELINE, LOCKS, RESULTS];

/* ------------------------------- launcher --------------------------------- */

test('launcher: defaults 2026-07-11 Newmarket, initial pipeline:day, three watcher windows', () => {
  assert.match(LAUNCHER, /set "RACE_DATE=2026-07-11"/);
  assert.match(LAUNCHER, /set "COURSE=Newmarket"/);
  assert.match(LAUNCHER, /npm run pipeline:day -- --date %RACE_DATE% --course "%COURSE%" --commit/);
  assert.match(LAUNCHER, /start "PIPELINE WATCH[^"]*".*watch-pipeline\.bat/);
  assert.match(LAUNCHER, /start "LOCK WATCH[^"]*".*watch-locks\.bat/);
  assert.match(LAUNCHER, /start "RESULTS WATCH[^"]*".*watch-results\.bat/);
  // Logs go under logs\race-day-<date>-<slug>.
  assert.match(LAUNCHER, /logs\\race-day-%RACE_DATE%-%SLUG%/);
});

/* ------------------------------ lock watcher ------------------------------ */

test('lock watcher: lock:t-minus --minutes-before 5 --commit every 120 seconds, loop never dies', () => {
  assert.match(LOCKS, /npm run lock:t-minus -- --date %RACE_DATE% --course "%COURSE%" --minutes-before 5 --commit/);
  assert.match(LOCKS, /timeout \/t 120 \/nobreak/);
  assert.match(LOCKS, /:loop/);
  assert.match(LOCKS, /goto loop/);
});

/* ---------------------------- pipeline watcher ----------------------------- */

test('pipeline watcher: pipeline:watch --interval-minutes 5 --commit, restarts on exit', () => {
  assert.match(PIPELINE, /npm run pipeline:watch -- --date %RACE_DATE% --course "%COURSE%" --interval-minutes 5 --commit/);
  assert.match(PIPELINE, /timeout \/t 60 \/nobreak/); // restart backoff
  assert.match(PIPELINE, /goto loop/);
});

/* ----------------------------- results watcher ----------------------------- */

test('results watcher: DRY-RUN first, --commit only when the dry-run exited cleanly, every 10 minutes', () => {
  // Dry-run call (no --commit on that line) appears BEFORE the commit call.
  const dryIdx = RESULTS.indexOf('npm run results:auto -- --date %RACE_DATE% --course "%COURSE%" >>');
  const commitIdx = RESULTS.indexOf('npm run results:auto -- --date %RACE_DATE% --course "%COURSE%" --commit');
  assert.ok(dryIdx >= 0, 'dry-run call present');
  assert.ok(commitIdx > dryIdx, 'commit call comes after the dry-run');
  // The commit call is inside the errorlevel-clean branch.
  assert.match(RESULTS, /if errorlevel 1 \(/);
  assert.match(RESULTS, /SKIPPING commit/);
  assert.match(RESULTS, /timeout \/t 600 \/nobreak/);
  assert.match(RESULTS, /goto loop/);
});

/* ------------------------------ safety scans ------------------------------- */

test('supervisor calls ONLY the four safe npm scripts — no direct DB/API/betting access', () => {
  for (const src of ALL_BATS) {
    // Every npm invocation is one of the four known-safe scripts.
    const calls = src.match(/npm run [a-z:-]+/g) ?? [];
    for (const call of calls) {
      assert.ok(
        ['npm run pipeline:day', 'npm run pipeline:watch', 'npm run lock:t-minus', 'npm run results:auto'].includes(call),
        `unexpected npm script: ${call}`,
      );
    }
    // No direct database, HTTP, or betting access from batch.
    assert.doesNotMatch(src, /supabase|psql|curl |Invoke-WebRequest|Invoke-RestMethod/i);
    assert.doesNotMatch(src, /placeBet|placeOrder|submitOrder|betfair/i);
    // No secrets echoed.
    assert.doesNotMatch(src, /SERVICE_ROLE|CRON_SECRET|RACING_API_KEY|BETFAIR_/);
  }
});

test('lock watcher never bypasses lock:t-minus semantics (no delete/update/admin escape)', () => {
  assert.doesNotMatch(LOCKS, /delete|update|upsert|locked_decisions_admin/i);
});

/* -------------------------------- runbook ---------------------------------- */

test('runbook documents the start command, windows, phone URL, and how to stop', () => {
  assert.match(RUNBOOK, /race-day-local\\start-race-day\.bat/);
  assert.match(RUNBOOK, /ascott-race-bot-production\.up\.railway\.app\/\?day=today&course=Newmarket/);
  assert.match(RUNBOOK, /How to stop everything/);
  assert.match(RUNBOOK, /dry-run first/i);
  assert.match(RUNBOOK, /no auto-betting, no bet placement/i);
  assert.match(RUNBOOK, /MANUAL_RESULTS_IMPORT/); // after-midnight fallback documented
});
