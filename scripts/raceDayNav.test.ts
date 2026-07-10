/**
 * Tests for the course/date-aware homepage race-day navigation
 * (src/lib/raceDayNav.ts — multi-course rebuild, no hardcoded course).
 *
 * Proves the nav wording names ONLY the selected course (never a hardcoded
 * one), the previous-day link is pure UTC date arithmetic on the SELECTED
 * date (clock-free, so server/client render identically), the audit deep link
 * preserves the query verbatim, and everything stays navigation-only (plain
 * in-app anchors — no API/cron call, no write, no --commit, no betting UI).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildRaceDayHref,
  buildRaceDayNavView,
  parseRaceDayScope,
  previousIsoDate,
  RACE_DAY_NAV_EMPTY_MESSAGE,
} from '../src/lib/raceDayNav';

/* ------------------------------ scope parsing ----------------------------- */

test('parseRaceDayScope: reads date/course; leading ? optional; invalid date -> null', () => {
  assert.deepEqual(parseRaceDayScope('?date=2026-07-10&course=Newmarket'), {
    date: '2026-07-10',
    course: 'Newmarket',
  });
  assert.deepEqual(parseRaceDayScope('date=2026-07-10'), { date: '2026-07-10', course: null });
  assert.deepEqual(parseRaceDayScope('?date=not-a-date&course=%20'), { date: null, course: null });
  assert.deepEqual(parseRaceDayScope(''), { date: null, course: null });
  assert.deepEqual(parseRaceDayScope(null), { date: null, course: null });
});

/* --------------------------- previous-day arithmetic ----------------------- */

test('previousIsoDate: pure UTC minus one day, incl. month/year boundaries', () => {
  assert.equal(previousIsoDate('2026-07-10'), '2026-07-09');
  assert.equal(previousIsoDate('2026-07-01'), '2026-06-30');
  assert.equal(previousIsoDate('2026-01-01'), '2025-12-31');
  assert.equal(previousIsoDate('2024-03-01'), '2024-02-29'); // leap year
  assert.equal(previousIsoDate('junk'), null);
});

/* ------------------------------ nav building ------------------------------ */

test('scoped to Newmarket: wording names Newmarket, links preserve course/date', () => {
  const nav = buildRaceDayNavView('?date=2026-07-10&course=Newmarket');
  assert.deepEqual(nav.primary, {
    href: '/?day=today&course=Newmarket',
    label: "View Today's Newmarket Races",
  });
  assert.deepEqual(nav.previousDay, {
    href: '/?date=2026-07-09&course=Newmarket',
    label: 'View Previous Day Newmarket Results',
  });
  assert.deepEqual(nav.audit, {
    href: '/results-audit?date=2026-07-10&course=Newmarket',
    label: 'Prediction Audit →',
  });
});

test('scoped to Ascot: says Ascot (course-aware, not hardcoded)', () => {
  const nav = buildRaceDayNavView('?date=2026-06-20&course=Ascot');
  assert.equal(nav.primary.label, "View Today's Ascot Races");
  assert.equal(nav.previousDay?.label, 'View Previous Day Ascot Results');
});

test('unscoped: generic wording, no course named anywhere, no previous-day link', () => {
  const nav = buildRaceDayNavView('');
  assert.deepEqual(nav.primary, { href: '/?day=today', label: "View Today's Races" });
  assert.equal(nav.previousDay, null);
  assert.deepEqual(nav.audit, { href: '/results-audit', label: 'Prediction Audit →' });
  for (const text of [nav.primary.label, nav.primary.href, nav.audit.href]) {
    assert.doesNotMatch(text, /Ascot|Newmarket/);
  }
});

test('course without date: course-aware today link, no previous-day link', () => {
  const nav = buildRaceDayNavView('?course=Newmarket');
  assert.equal(nav.primary.label, "View Today's Newmarket Races");
  assert.equal(nav.previousDay, null);
  assert.equal(nav.audit.href, '/results-audit?course=Newmarket');
});

test('hrefs encode course names with spaces/parentheses', () => {
  const nav = buildRaceDayNavView('?date=2026-07-10&course=Newmarket%20(July)');
  assert.equal(nav.primary.href, '/?day=today&course=Newmarket%20(July)');
  assert.equal(nav.previousDay?.href, '/?date=2026-07-09&course=Newmarket%20(July)');
  assert.equal(buildRaceDayHref({ date: '2026-06-19', course: 'Royal Ascot' }), '/?date=2026-06-19&course=Royal%20Ascot');
});

test('empty-state message unchanged', () => {
  assert.match(
    RACE_DAY_NAV_EMPTY_MESSAGE,
    /read-only and auto-refreshes once a date\/course is selected/,
  );
});

test('every nav href is relative in-app navigation, never an API/cron route', () => {
  const nav = buildRaceDayNavView('?date=2026-07-10&course=Newmarket');
  for (const link of [nav.primary, nav.previousDay!, nav.audit]) {
    assert.ok(link.href.startsWith('/'), link.href);
    assert.doesNotMatch(link.href, /\/api\//);
    assert.doesNotMatch(link.href, /^https?:/);
    assert.doesNotMatch(link.href, /--commit|cron|pipeline|results:auto/);
  }
});

/* -------------------------------------------------------------------------- */
/* Source scans                                                               */
/* -------------------------------------------------------------------------- */

const LIB_SRC = readFileSync('src/lib/raceDayNav.ts', 'utf8');
const PAGE_SRC = readFileSync('src/app/page.tsx', 'utf8');

test('nav lib is pure: no I/O, no API, no write, no betting, no clock', () => {
  assert.doesNotMatch(LIB_SRC, /fetch\(|supabaseAdmin|\/api\/|--commit|placeOrder|placeBet|submitOrder/);
  assert.doesNotMatch(LIB_SRC, /Date\.now\(\)|new Date\(\)/); // clock-free (hydration-safe)
});

test('no hardcoded course name remains in the nav lib', () => {
  assert.doesNotMatch(LIB_SRC, /Ascot|Newmarket/);
});

test('homepage imports + renders the course-aware race-day nav', () => {
  assert.match(PAGE_SRC, /from '@\/lib\/raceDayNav'/);
  assert.match(PAGE_SRC, /<RaceDayNav scoped=\{scoped\} search=\{search\} \/>/);
  assert.match(PAGE_SRC, /buildRaceDayNavView/);
});

test('nav block is anchors only — no form/button/onClick/fetch/--commit', () => {
  const start = PAGE_SRC.indexOf('function RaceDayNav');
  const end = PAGE_SRC.indexOf('const raceDayPrimaryButtonStyle');
  assert.ok(start >= 0 && end > start, 'RaceDayNav block located');
  const navBlock = PAGE_SRC.slice(start, end);

  // It links via plain anchors to the built nav hrefs...
  assert.match(navBlock, /<a href=\{nav\.primary\.href\}/);
  assert.match(navBlock, /<a href=\{nav\.audit\.href\}/);
  // ...and introduces no write control or network call.
  assert.doesNotMatch(navBlock, /<form|<button|onClick|onSubmit|fetch\(|method:\s*['"]POST/);
  assert.doesNotMatch(navBlock, /--commit|placeOrder|placeBet|submitOrder|\/api\//);
});
