/**
 * Tests for the homepage race-day navigation links.
 *
 * Proves the today/yesterday Ascot links are correct, navigation-only (plain
 * in-app anchors — no API/cron call, no write, no --commit, no betting UI), and
 * that the homepage renders them under the safety banner.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildRaceDayHref,
  TODAY_ASCOT_HREF,
  YESTERDAY_ASCOT_HREF,
  TODAY_ASCOT_VIEW,
  YESTERDAY_ASCOT_VIEW,
  VIEW_TODAY_LABEL,
  VIEW_YESTERDAY_LABEL,
  RACE_DAY_NAV_EMPTY_MESSAGE,
} from '../src/lib/raceDayNav';

test("today's button href is exactly /?date=2026-06-19&course=Ascot", () => {
  assert.equal(TODAY_ASCOT_HREF, '/?date=2026-06-19&course=Ascot');
  assert.equal(buildRaceDayHref(TODAY_ASCOT_VIEW), '/?date=2026-06-19&course=Ascot');
});

test("yesterday's link href is exactly /?date=2026-06-18&course=Ascot", () => {
  assert.equal(YESTERDAY_ASCOT_HREF, '/?date=2026-06-18&course=Ascot');
  assert.equal(buildRaceDayHref(YESTERDAY_ASCOT_VIEW), '/?date=2026-06-18&course=Ascot');
});

test('labels + empty-state message match the spec', () => {
  assert.equal(VIEW_TODAY_LABEL, "View Today's Ascot Races");
  assert.equal(VIEW_YESTERDAY_LABEL, "View Yesterday's Ascot Results");
  assert.match(RACE_DAY_NAV_EMPTY_MESSAGE, /read-only and auto-refreshes once a date\/course is selected/);
});

test('hrefs are relative in-app navigation, never an API/cron route', () => {
  for (const href of [TODAY_ASCOT_HREF, YESTERDAY_ASCOT_HREF]) {
    assert.ok(href.startsWith('/?'), href);
    assert.doesNotMatch(href, /\/api\//);
    assert.doesNotMatch(href, /^https?:/);
    assert.doesNotMatch(href, /--commit|cron|pipeline|results:auto/);
  }
});

test('buildRaceDayHref encodes its inputs', () => {
  assert.equal(buildRaceDayHref({ date: '2026-06-19', course: 'Royal Ascot' }), '/?date=2026-06-19&course=Royal%20Ascot');
});

/* -------------------------------------------------------------------------- */
/* Source scans                                                               */
/* -------------------------------------------------------------------------- */

const LIB_SRC = readFileSync('src/lib/raceDayNav.ts', 'utf8');
const PAGE_SRC = readFileSync('src/app/page.tsx', 'utf8');

test('nav lib is pure: no I/O, no API, no write, no betting', () => {
  assert.doesNotMatch(LIB_SRC, /fetch\(|supabaseAdmin|\/api\/|--commit|placeOrder|placeBet|submitOrder/);
});

test('homepage imports + renders the race-day nav', () => {
  assert.match(PAGE_SRC, /from '@\/lib\/raceDayNav'/);
  assert.match(PAGE_SRC, /<RaceDayNav scoped=\{scoped\} \/>/);
  // The labels are rendered (as expressions, so they appear in the source).
  assert.match(PAGE_SRC, /VIEW_TODAY_LABEL/);
  assert.match(PAGE_SRC, /VIEW_YESTERDAY_LABEL/);
});

test('nav block is anchors only — no form/button/onClick/fetch/--commit', () => {
  const start = PAGE_SRC.indexOf('function RaceDayNav');
  const end = PAGE_SRC.indexOf('const raceDayPrimaryButtonStyle');
  assert.ok(start >= 0 && end > start, 'RaceDayNav block located');
  const navBlock = PAGE_SRC.slice(start, end);

  // It links via plain anchors to the href constants...
  assert.match(navBlock, /<a href=\{TODAY_ASCOT_HREF\}/);
  assert.match(navBlock, /<a href=\{YESTERDAY_ASCOT_HREF\}/);
  // ...and introduces no write control or network call.
  assert.doesNotMatch(navBlock, /<form|<button|onClick|onSubmit|fetch\(|method:\s*['"]POST/);
  assert.doesNotMatch(navBlock, /--commit|placeOrder|placeBet|submitOrder|\/api\//);
});
