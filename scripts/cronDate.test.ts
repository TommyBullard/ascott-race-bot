/**
 * Unit tests for the pure cron day/date resolver (src/lib/cronDate.ts).
 *
 * No I/O: a fixed `now` makes "today"/"tomorrow" deterministic. These lock down
 * the precedence (valid date > day > today), strict date validation, and the
 * default-to-today behaviour. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveCronMeetingDate } from '../src/lib/cronDate';

// A fixed instant mid-day UTC so "today" is unambiguous.
const NOW = new Date('2026-06-15T12:00:00Z');

test('default (no params) -> today (UTC)', () => {
  assert.deepEqual(resolveCronMeetingDate({}, NOW), {
    meetingDate: '2026-06-15',
    source: 'today',
  });
  assert.deepEqual(resolveCronMeetingDate({ day: 'today' }, NOW), {
    meetingDate: '2026-06-15',
    source: 'today',
  });
});

test('day=tomorrow -> next UTC day', () => {
  assert.deepEqual(resolveCronMeetingDate({ day: 'tomorrow' }, NOW), {
    meetingDate: '2026-06-16',
    source: 'tomorrow',
  });
});

test('day=tomorrow rolls over month/year boundaries', () => {
  assert.equal(
    resolveCronMeetingDate({ day: 'tomorrow' }, new Date('2026-06-30T23:59:59Z')).meetingDate,
    '2026-07-01',
  );
  assert.equal(
    resolveCronMeetingDate({ day: 'tomorrow' }, new Date('2026-12-31T10:00:00Z')).meetingDate,
    '2027-01-01',
  );
});

test('valid date is used and wins over day', () => {
  assert.deepEqual(resolveCronMeetingDate({ date: '2026-06-20' }, NOW), {
    meetingDate: '2026-06-20',
    source: 'date',
  });
  // date precedence over a conflicting day.
  assert.deepEqual(
    resolveCronMeetingDate({ day: 'tomorrow', date: '2026-07-04' }, NOW),
    { meetingDate: '2026-07-04', source: 'date' },
  );
});

test('invalid date falls through to day / today (never throws, no fabrication)', () => {
  // Wrong format -> ignored.
  assert.deepEqual(resolveCronMeetingDate({ date: '06/20/2026' }, NOW), {
    meetingDate: '2026-06-15',
    source: 'today',
  });
  // Rolled-over calendar date (Feb 30) is rejected by the round-trip check.
  assert.deepEqual(resolveCronMeetingDate({ date: '2026-02-30' }, NOW), {
    meetingDate: '2026-06-15',
    source: 'today',
  });
  // Impossible month.
  assert.equal(resolveCronMeetingDate({ date: '2026-13-01' }, NOW).source, 'today');
  // Invalid date but valid day -> day wins.
  assert.deepEqual(resolveCronMeetingDate({ day: 'tomorrow', date: 'nope' }, NOW), {
    meetingDate: '2026-06-16',
    source: 'tomorrow',
  });
});

test('unknown / empty / null params -> today', () => {
  assert.equal(resolveCronMeetingDate({ day: 'someday' }, NOW).source, 'today');
  assert.equal(resolveCronMeetingDate({ day: '' }, NOW).source, 'today');
  assert.equal(resolveCronMeetingDate({ day: null, date: null }, NOW).source, 'today');
});

test('day is case-insensitive and trimmed', () => {
  assert.equal(resolveCronMeetingDate({ day: '  TOMORROW  ' }, NOW).source, 'tomorrow');
  assert.equal(resolveCronMeetingDate({ date: '  2026-06-20  ' }, NOW).meetingDate, '2026-06-20');
});
