/**
 * Unit tests for the dashboard live-status view-model (src/lib/liveStatus.ts)
 * plus read-only source-scan guards on the status-polling wiring in page.tsx.
 *
 * The helper is pure + deterministic. The scans lock down the task's rules: the
 * dashboard polls the read-only /api/race-day/status only on scoped pages, on
 * the shared 30-60s cadence, keeps the last known data + warns (non-blocking) on
 * failure, and adds no write / commit / bet controls. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildLiveStatusView, LIVE_STATUS_WARNING } from '../src/lib/liveStatus';

/* ------------------------------ pure helper ------------------------------- */

test('buildLiveStatusView prefers the status time, falls back to cards', () => {
  assert.equal(
    buildLiveStatusView({ statusUpdatedMs: 100, cardsUpdatedMs: 50, statusError: false }).refreshedMs,
    100,
  );
  assert.equal(
    buildLiveStatusView({ statusUpdatedMs: null, cardsUpdatedMs: 50, statusError: false }).refreshedMs,
    50,
  );
  assert.equal(
    buildLiveStatusView({ statusUpdatedMs: null, cardsUpdatedMs: null, statusError: false }).refreshedMs,
    null,
  );
});

test('buildLiveStatusView raises a non-blocking warning only when the poll failed', () => {
  assert.equal(
    buildLiveStatusView({ statusUpdatedMs: 100, cardsUpdatedMs: 50, statusError: true }).warning,
    LIVE_STATUS_WARNING,
  );
  assert.equal(
    buildLiveStatusView({ statusUpdatedMs: 100, cardsUpdatedMs: 50, statusError: false }).warning,
    null,
  );
  // A failed poll still keeps the last known refresh time (data is not cleared).
  assert.equal(
    buildLiveStatusView({ statusUpdatedMs: 100, cardsUpdatedMs: 50, statusError: true }).refreshedMs,
    100,
  );
});

test('the live-status warning is plain decision-support text (no commit / bet)', () => {
  assert.ok(LIVE_STATUS_WARNING.length > 0);
  assert.equal(/--commit/.test(LIVE_STATUS_WARNING), false);
  assert.equal(/placeOrder|placeBet|auto-?bet/i.test(LIVE_STATUS_WARNING), false);
});

/* --------------------- read-only guards (source scans) -------------------- */

test('the dashboard polls the read-only status API only on scoped date pages', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.match(page, /\/api\/race-day\/status/);
  // Gated on scope + a date param, and uses the shared 30-60s refresh cadence.
  assert.match(page, /if \(!scoped \|\| !scope\.date\) return;/);
  assert.match(page, /setInterval\(pollStatus, RACE_DAY_REFRESH_MS\)/);
});

test('a failed status poll keeps the last known data and warns (non-blocking)', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.match(page, /setStatusError\(true\)/);
  assert.match(page, /buildLiveStatusView/);
  // The last good status is never reset to null on a failed poll.
  assert.equal(/setStatusData\(null\)/.test(page), false);
});

test('the live bar shows a last-refresh label and the unscoped view still works', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.match(page, /Status refreshed/);
  assert.match(page, /Static view/); // unscoped page renders, does not break
});

test('the status-polling wiring adds no write / commit / bet controls', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.equal(/--commit/.test(page), false);
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(page), false);
  assert.equal(/placeOrder|placeBet|submitOrder/i.test(page), false);
  // The status fetch is read-only (no mutating HTTP method anywhere on the page).
  assert.equal(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(page), false);
});
