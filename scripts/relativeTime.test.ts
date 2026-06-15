/**
 * Unit tests for the pure relative-time helper (src/lib/relativeTime.ts).
 *
 * No I/O: a fixed `now` makes recency deterministic. Covers just-now / seconds /
 * minutes / hours / days, missing & unparseable timestamps, future-timestamp
 * safe handling, and the staleness predicate. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatRelativeAge, isStaleAge } from '../src/lib/relativeTime';

const NOW = Date.parse('2026-06-15T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('formatRelativeAge: just now for very recent / zero age', () => {
  assert.deepEqual(formatRelativeAge(ago(0), NOW), { text: 'just now', ageMs: 0 });
  assert.equal(formatRelativeAge(ago(5 * SECOND), NOW).text, 'just now'); // < 10s
});

test('formatRelativeAge: seconds ago', () => {
  const r = formatRelativeAge(ago(30 * SECOND), NOW);
  assert.equal(r.text, '30s ago');
  assert.equal(r.ageMs, 30 * SECOND);
});

test('formatRelativeAge: minutes ago', () => {
  assert.equal(formatRelativeAge(ago(5 * MINUTE), NOW).text, '5m ago');
  assert.equal(formatRelativeAge(ago(59 * MINUTE), NOW).text, '59m ago');
});

test('formatRelativeAge: hours ago', () => {
  assert.equal(formatRelativeAge(ago(2 * HOUR), NOW).text, '2h ago');
  assert.equal(formatRelativeAge(ago(23 * HOUR), NOW).text, '23h ago');
});

test('formatRelativeAge: days ago', () => {
  assert.equal(formatRelativeAge(ago(3 * DAY), NOW).text, '3d ago');
});

test('formatRelativeAge: missing / unparseable -> unknown, ageMs null', () => {
  assert.deepEqual(formatRelativeAge(null, NOW), { text: 'unknown', ageMs: null });
  assert.deepEqual(formatRelativeAge(undefined, NOW), { text: 'unknown', ageMs: null });
  assert.deepEqual(formatRelativeAge('not-a-date', NOW), { text: 'unknown', ageMs: null });
  assert.deepEqual(formatRelativeAge('', NOW), { text: 'unknown', ageMs: null });
});

test('formatRelativeAge: future timestamp clamps to just now (no negative age)', () => {
  const r = formatRelativeAge(new Date(NOW + 5 * MINUTE).toISOString(), NOW);
  assert.equal(r.text, 'just now');
  assert.equal(r.ageMs, 0);
});

test('formatRelativeAge: accepts epoch ms and Date inputs', () => {
  assert.equal(formatRelativeAge(NOW - 2 * MINUTE, NOW).text, '2m ago');
  assert.equal(formatRelativeAge(new Date(NOW - HOUR), NOW).text, '1h ago');
});

test('isStaleAge: true only when older than threshold; missing -> not stale', () => {
  const threshold = 10 * MINUTE;
  assert.equal(isStaleAge(ago(5 * MINUTE), NOW, threshold), false);
  assert.equal(isStaleAge(ago(10 * MINUTE), NOW, threshold), false); // exactly at threshold
  assert.equal(isStaleAge(ago(11 * MINUTE), NOW, threshold), true);
  // Missing / unparseable is NOT stale (UI shows a distinct unavailable state).
  assert.equal(isStaleAge(null, NOW, threshold), false);
  assert.equal(isStaleAge('bad', NOW, threshold), false);
  // Future timestamp is fresh.
  assert.equal(isStaleAge(new Date(NOW + MINUTE).toISOString(), NOW, threshold), false);
});
