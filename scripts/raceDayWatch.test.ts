/**
 * Unit tests for the pure watch helpers (src/lib/raceDayWatch.ts).
 *
 * No timers, network, or DB: synthetic argv + constructed local Dates verify
 * arg parsing, interval / until-time validation, the stop decision, and the
 * per-cycle summary formatting. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWatchArgs,
  parseUntilTime,
  isUntilReached,
  shouldStopWatching,
  formatCycleSummary,
  DEFAULT_INTERVAL_MINUTES,
} from '../src/lib/raceDayWatch';
import type { PipelineSummary } from '../src/lib/raceDayPipeline';

test('parseWatchArgs: defaults (interval 5, no until/max-cycles)', () => {
  const a = parseWatchArgs(['--date', '2026-06-16', '--commit']);
  assert.equal(a.date, '2026-06-16');
  assert.equal(a.intervalMinutes, DEFAULT_INTERVAL_MINUTES);
  assert.equal(a.until, undefined);
  assert.equal(a.maxCycles, undefined);
  assert.equal(a.commit, true);
  assert.equal(a.allowStale, false);
  assert.equal(a.baseUrl, 'http://localhost:3000');
});

test('parseWatchArgs: full flags', () => {
  const a = parseWatchArgs([
    '--date', '2026-06-16', '--course', 'Ascot',
    '--interval-minutes', '10', '--until', '17:45', '--max-cycles', '3',
    '--commit', '--allow-stale', '--base-url', 'http://localhost:3001/',
  ]);
  assert.equal(a.course, 'Ascot');
  assert.equal(a.intervalMinutes, 10);
  assert.equal(a.until, '17:45');
  assert.equal(a.maxCycles, 3);
  assert.equal(a.allowStale, true);
  assert.equal(a.baseUrl, 'http://localhost:3001');
});

test('parseWatchArgs: invalid interval -> null (script then errors)', () => {
  assert.equal(parseWatchArgs(['--date', '2026-06-16', '--interval-minutes', '0']).intervalMinutes, null);
  assert.equal(parseWatchArgs(['--date', '2026-06-16', '--interval-minutes', '-3']).intervalMinutes, null);
  assert.equal(parseWatchArgs(['--date', '2026-06-16', '--interval-minutes', 'abc']).intervalMinutes, null);
});

test('parseWatchArgs: max-cycles absent->undefined, invalid->null, valid->n', () => {
  assert.equal(parseWatchArgs(['--date', '2026-06-16']).maxCycles, undefined);
  assert.equal(parseWatchArgs(['--date', '2026-06-16', '--max-cycles', '0']).maxCycles, null);
  assert.equal(parseWatchArgs(['--date', '2026-06-16', '--max-cycles', '2.5']).maxCycles, null);
  assert.equal(parseWatchArgs(['--date', '2026-06-16', '--max-cycles', 'x']).maxCycles, null);
  assert.equal(parseWatchArgs(['--date', '2026-06-16', '--max-cycles', '4']).maxCycles, 4);
});

test('parseWatchArgs: blank --until ignored', () => {
  assert.equal(parseWatchArgs(['--date', '2026-06-16', '--until', '  ']).until, undefined);
});

test('parseUntilTime: valid + invalid HH:MM', () => {
  assert.deepEqual(parseUntilTime('14:30'), { hours: 14, minutes: 30 });
  assert.deepEqual(parseUntilTime('00:00'), { hours: 0, minutes: 0 });
  assert.deepEqual(parseUntilTime('23:59'), { hours: 23, minutes: 59 });
  assert.deepEqual(parseUntilTime('09:05'), { hours: 9, minutes: 5 });
  assert.equal(parseUntilTime('24:00'), null);
  assert.equal(parseUntilTime('12:60'), null);
  assert.equal(parseUntilTime('9:5'), null); // minutes must be two digits
  assert.equal(parseUntilTime('abc'), null);
  assert.equal(parseUntilTime(''), null);
});

test('isUntilReached: local-time comparison (>= until)', () => {
  const until = { hours: 14, minutes: 30 };
  assert.equal(isUntilReached(until, new Date(2026, 5, 16, 14, 29)), false);
  assert.equal(isUntilReached(until, new Date(2026, 5, 16, 14, 30)), true); // exactly at
  assert.equal(isUntilReached(until, new Date(2026, 5, 16, 14, 31)), true);
  assert.equal(isUntilReached(until, new Date(2026, 5, 16, 9, 0)), false);
});

test('shouldStopWatching: max-cycles then until, else continue', () => {
  const now = new Date(2026, 5, 16, 12, 0);
  // max-cycles
  assert.equal(shouldStopWatching(0, 1, null, now), null);
  assert.equal(shouldStopWatching(1, 1, null, now), 'max-cycles reached');
  assert.equal(shouldStopWatching(3, 3, null, now), 'max-cycles reached');
  // until
  assert.equal(shouldStopWatching(0, null, { hours: 11, minutes: 0 }, now), 'until time reached');
  assert.equal(shouldStopWatching(0, null, { hours: 13, minutes: 0 }, now), null);
  // neither
  assert.equal(shouldStopWatching(0, undefined, null, now), null);
});

test('formatCycleSummary: cycle first, dashboard_url last, models_run from model_races_run', () => {
  const summary: PipelineSummary = {
    racecards: 'ok',
    odds: 'ok',
    races_considered: 33,
    markets_matched: 33,
    snapshots_written: 33,
    quotes_written: 235,
    model_races_found: 7,
    model_races_run: 7,
    recommendations_created: 6,
    no_bet_races: 1,
    skipped_post_off: 0,
    skipped_resulted: 0,
    failures: 0,
  };
  const lines = formatCycleSummary({
    cycle: 2,
    startedAt: '2026-06-16T13:00:00.000Z',
    completedAt: '2026-06-16T13:00:09.000Z',
    summary,
    dashboardUrl: 'http://localhost:3000/?date=2026-06-16&course=Ascot',
  });
  assert.equal(lines.length, 10);
  assert.equal(lines[0], '  cycle: 2');
  assert.ok(lines.some((l) => l === '  started_at: 2026-06-16T13:00:00.000Z'));
  assert.ok(lines.some((l) => l === '  completed_at: 2026-06-16T13:00:09.000Z'));
  assert.ok(lines.some((l) => l === '  models_run: 7'));
  assert.ok(lines.some((l) => l === '  recommendations_created: 6'));
  assert.ok(lines.some((l) => l === '  no_bet_races: 1'));
  assert.equal(lines[lines.length - 1], '  dashboard_url: http://localhost:3000/?date=2026-06-16&course=Ascot');
});
