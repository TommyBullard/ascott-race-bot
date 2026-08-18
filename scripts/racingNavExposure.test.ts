/**
 * Racing navigation EXPOSURE — Today / Meetings activation.
 *
 * Covers the current-racing-date helper, the destination builders, the shell's
 * server-to-client date boundary, the meetings anchor, the active-navigation
 * policy, and the corrected historical meeting copy.
 *
 * Every instant is INJECTED. No test reads the real clock, so a suite run at
 * 23:59 London time behaves identically to one run at noon. Components are
 * rendered with `renderToStaticMarkup`; source contracts are asserted on
 * COMMENT-STRIPPED code so no scanner can be satisfied by prose.
 *
 * This file opens no database, calls no provider, runs no model, captures no
 * odds, creates no lock, settles no result and acquires no producer claim.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import nodePath from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  AppShell,
  MEETINGS_ANCHOR_ID,
  MOBILE_DESTINATIONS,
  MOBILE_NAV_MAX_DESTINATIONS,
  PLANNED_DESTINATIONS,
  PRIMARY_DESTINATIONS,
  PLACEHOLDER_SLOTS,
  buildMobileDestinations,
  buildPrimaryDestinations,
  isNavDestinationActive,
} from '../src/components/AppShell';
import { AppNavigation, resolveActivePathname } from '../src/components/AppNavigation';
import {
  RACING_NAV_TIME_ZONE,
  currentRacingDate,
  isIsoRacingDate,
} from '../src/components/racingDate';
import { RACING_TIME_ZONE, isCanonicalDate, groupRacesByMeeting } from '../src/lib/racingNavigation';
import MeetingSummaryCard from '../src/components/racing/MeetingSummaryCard';

/* -------------------------------------------------------------------------- */
/* Sources + helpers                                                          */
/* -------------------------------------------------------------------------- */

const SHELL = 'src/components/AppShell.tsx';
const NAV = 'src/components/AppNavigation.tsx';
const NAV_MODEL = 'src/components/navDestinations.ts';
const DATE_HELPER = 'src/components/racingDate.ts';
const DATE_PAGE = 'src/app/date/[date]/page.tsx';
const MEETING_CARD = 'src/components/racing/MeetingSummaryCard.tsx';
const EXPOSURE_FILES = [SHELL, NAV, NAV_MODEL, DATE_HELPER, MEETING_CARD];

const src = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const code = (p: string): string =>
  src(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** A fixed instant, so nothing depends on when the suite runs. */
const at = (iso: string): Date => new Date(Date.parse(iso));

const TODAY = '2026-08-17';

/**
 * The SERVER / first-hydration render of the whole shell.
 *
 * `renderToStaticMarkup` runs no effects, so this is exactly what a static
 * page ships and what the browser renders before hydration completes. The
 * racing date is mount-gated, so `Today` and `Meetings` are absent here.
 */
const renderShell = (pathname: string | null): string =>
  renderToStaticMarkup(h(AppShell, { pathname, children: 'content' }));

/**
 * The POST-MOUNT navigation render.
 *
 * The seam supplies a pre-resolved date, standing in for the state the effect
 * sets after mount — this suite has no DOM to run effects in. Passing null
 * reproduces the pre-mount render of the navigation alone.
 */
const renderNav = (
  variant: 'primary' | 'mobile',
  pathname: string | null,
  todayDate: string | null = TODAY,
): string => renderToStaticMarkup(h(AppNavigation, { variant, pathname, todayDate }));

/** All anchors in a fragment of markup, as { href, text } pairs. */
function anchors(html: string): { href: string; text: string }[] {
  return [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: m[1],
    text: m[2].replace(/<[^>]*>/g, ''),
  }));
}

/** The primary (header) navigation only. */
const headerNav = (html: string): string => {
  const start = html.indexOf('<nav class="rb-nav rb-nav--primary"');
  return html.slice(start, html.indexOf('</nav>', start));
};

/** The mobile bottom navigation only. */
const mobileNav = (html: string): string => {
  const start = html.indexOf('<nav class="rb-nav rb-nav--mobile"');
  return html.slice(start, html.indexOf('</nav>', start));
};

/* -------------------------------------------------------------------------- */
/* 1-6. Europe/London current racing date                                     */
/* -------------------------------------------------------------------------- */

test('1. winter (GMT): the London date equals the UTC date', () => {
  assert.equal(currentRacingDate(at('2026-01-15T12:00:00.000Z')), '2026-01-15');
  // 23:30 GMT is still the 15th in London — no offset applies.
  assert.equal(currentRacingDate(at('2026-01-15T23:30:00.000Z')), '2026-01-15');
  // 00:30 GMT is already the 16th in both zones.
  assert.equal(currentRacingDate(at('2026-01-16T00:30:00.000Z')), '2026-01-16');
});

test('2. summer (BST): the London date can be a day AHEAD of UTC', () => {
  assert.equal(currentRacingDate(at('2026-08-17T12:00:00.000Z')), '2026-08-17');
  // 23:30 UTC in August is 00:30 BST the NEXT day. A UTC-only calculation
  // would send "Today" to yesterday's racing for half an hour every night.
  assert.equal(currentRacingDate(at('2026-08-17T23:30:00.000Z')), '2026-08-18');
  assert.equal(currentRacingDate(at('2026-08-17T22:59:59.000Z')), '2026-08-17');
  assert.equal(currentRacingDate(at('2026-08-17T23:00:00.000Z')), '2026-08-18');
});

test('3. the UTC date and the London date genuinely differ at the boundary', () => {
  const instant = at('2026-06-30T23:15:00.000Z');
  const utcDate = instant.toISOString().slice(0, 10);
  const londonDate = currentRacingDate(instant);
  assert.equal(utcDate, '2026-06-30');
  assert.equal(londonDate, '2026-07-01');
  assert.notEqual(londonDate, utcDate, 'a UTC-text calculation would be wrong here');

  // Around the DST transitions themselves.
  // 2026: BST starts 29 Mar 01:00 UTC, ends 25 Oct 02:00 UTC.
  assert.equal(currentRacingDate(at('2026-03-29T00:30:00.000Z')), '2026-03-29');
  assert.equal(currentRacingDate(at('2026-03-29T01:30:00.000Z')), '2026-03-29');
  assert.equal(currentRacingDate(at('2026-10-25T00:30:00.000Z')), '2026-10-25');
  assert.equal(currentRacingDate(at('2026-10-25T23:30:00.000Z')), '2026-10-25', 'GMT again');
});

test('4. leap day is handled, and a non-leap 29 February is rejected', () => {
  assert.equal(currentRacingDate(at('2024-02-29T12:00:00.000Z')), '2024-02-29');
  assert.equal(isIsoRacingDate('2024-02-29'), true);
  assert.equal(isIsoRacingDate('2026-02-29'), false);
  assert.equal(isIsoRacingDate('2026-02-30'), false, 'never normalised to 03-02');
});

test('5. an unusable instant fails safely rather than guessing a day', () => {
  assert.equal(currentRacingDate(new Date(Number.NaN)), null);
  assert.equal(currentRacingDate(new Date('not-a-date')), null);
  assert.equal(currentRacingDate('2026-08-17' as unknown as Date), null, 'a non-Date is null');
  assert.equal(currentRacingDate(null as unknown as Date), null);
  assert.equal(currentRacingDate(0 as unknown as Date), null, 'a number is not a Date');
  // `undefined` is deliberately NOT tested here: it selects the default
  // parameter, which reads the real clock, and this suite never does that.
});

test('6. output is exact YYYY-MM-DD and agrees with the route validator', () => {
  const value = currentRacingDate(at('2026-08-17T12:00:00.000Z'));
  assert.match(String(value), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(String(value).length, 10);

  // ONE timezone definition, kept in step by assertion rather than coupling.
  assert.equal(RACING_NAV_TIME_ZONE, RACING_TIME_ZONE);
  assert.equal(RACING_NAV_TIME_ZONE, 'Europe/London');

  // The shell validator and the route validator must never disagree, or a
  // link could be built that the route itself would 404.
  const corpus = [
    '2026-08-17', '2024-02-29', '2026-02-29', '2026-02-30', '2026-13-01',
    '2026-00-01', '2026-01-00', '0026-01-01', '2026-8-17', '2026-08-17T00:00:00Z',
    ' 2026-08-17', '2026-08-17 ', '', 'today', '2026-08-170',
  ];
  for (const candidate of corpus) {
    assert.equal(
      isIsoRacingDate(candidate),
      isCanonicalDate(candidate),
      `validators disagree on ${JSON.stringify(candidate)}`,
    );
  }
  for (const wrongType of [null, undefined, 20260817, {}, []]) {
    assert.equal(isIsoRacingDate(wrongType), isCanonicalDate(wrongType), String(wrongType));
  }
});

/* -------------------------------------------------------------------------- */
/* 7-9, 19, 22. Destination builders                                          */
/* -------------------------------------------------------------------------- */

test('7-8. Today and Meetings hrefs derive from the one calculated date', () => {
  const destinations = buildPrimaryDestinations(TODAY);
  const today = destinations.find((d) => d.label === 'Today');
  const meetings = destinations.find((d) => d.label === 'Meetings');
  assert.ok(today && meetings);

  assert.equal(today.href, `/date/${TODAY}`);
  assert.equal(meetings.href, `/date/${TODAY}#${MEETINGS_ANCHOR_ID}`);
  assert.equal(MEETINGS_ANCHOR_ID, 'meetings');

  // Same date, distinct hrefs and labels — no duplicate destination.
  assert.ok(meetings.href.startsWith(today.href));
  assert.notEqual(today.href, meetings.href);
  assert.notEqual(today.label, meetings.label);
  assert.equal(destinations.filter((d) => d.label === 'Today').length, 1);
  assert.equal(destinations.filter((d) => d.label === 'Meetings').length, 1);

  // Racing entry points sit immediately after Overview.
  assert.deepEqual(
    destinations.map((d) => d.label),
    ['Overview', 'Today', 'Meetings', 'Methodology', 'Tipster Evidence', 'Official Record'],
  );
});

test('9. no hardcoded fixture date appears in production navigation code', () => {
  for (const file of [...EXPOSURE_FILES, DATE_PAGE]) {
    const executable = code(file);
    // The production-proven fixture dates must not be baked in anywhere.
    assert.doesNotMatch(executable, /2026-08-17/, `${file} hardcodes a fixture date`);
    assert.doesNotMatch(executable, /2026-06-16/, `${file} hardcodes a fixture date`);
    // Nor any other literal ISO date.
    assert.doesNotMatch(executable, /['"`]\d{4}-\d{2}-\d{2}['"`]/, `${file} hardcodes a date`);
  }
});

test('19, 22. a missing or malformed date can never produce /date/undefined', () => {
  for (const bad of [
    undefined, null, '', 'undefined', 'null', 'today', '2026-8-17', '2026-02-30',
    '2026-13-01', ' 2026-08-17', '2026-08-17T00:00:00Z', '../../etc/passwd',
  ] as (string | null | undefined)[]) {
    const primary = buildPrimaryDestinations(bad);
    // Fail-safe: the static set alone. A missing link beats a broken one.
    assert.deepEqual(
      primary.map((d) => d.label),
      ['Overview', 'Methodology', 'Tipster Evidence', 'Official Record'],
      `malformed date ${JSON.stringify(bad)} must add no destination`,
    );
    for (const destination of [...primary, ...buildMobileDestinations(bad)]) {
      assert.doesNotMatch(destination.href, /undefined|null|NaN/, destination.href);
      assert.notEqual(destination.href, '');
      assert.doesNotMatch(destination.href, /\/date\//, 'no date route without a valid date');
    }
  }

  // And the rendered shell emits no empty or broken href either.
  for (const html of [renderNav('primary', '/', null), renderNav('primary', '/', 'nonsense')]) {
    for (const anchor of anchors(html)) {
      assert.notEqual(anchor.href, '');
      assert.doesNotMatch(anchor.href, /undefined|\/date\//);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* 10-18, 38, 40. Planned versus active destinations                          */
/* -------------------------------------------------------------------------- */

test('10-11. Today and Meetings are no longer planned', () => {
  for (const label of ['Today', 'Meetings']) {
    assert.equal(
      PLANNED_DESTINATIONS.some((p) => p.label === label),
      false,
      `${label} must not be planned`,
    );
  }
  const html = renderNav('primary', `/date/${TODAY}`);
  // No Planned tag beside either label.
  for (const label of ['Today', 'Meetings']) {
    assert.doesNotMatch(
      html,
      new RegExp(`${label}<span class="rb-nav__planned-tag">Planned`),
      `${label} still renders a Planned badge`,
    );
  }
});

test('12-15. Search, Date, Scope and Operations remain planned', () => {
  // Operations is the only remaining planned NAV destination.
  assert.deepEqual(
    PLANNED_DESTINATIONS.map((p) => p.label),
    ['Operations'],
  );
  // The header control slots are untouched.
  assert.deepEqual(
    PLACEHOLDER_SLOTS.map((s) => `${s.label}:${s.state}`),
    ['Search:Planned', 'Date:Planned', 'Scope:Planned'],
  );

  const html = renderShell(`/date/${TODAY}`);
  assert.match(html, /Operations<span class="rb-nav__planned-tag">Planned/);
  for (const slot of PLACEHOLDER_SLOTS) {
    assert.match(
      html,
      new RegExp(
        `<span class="rb-slot__label">${slot.label}</span><span class="rb-slot__state">${slot.state}</span>`,
      ),
      `${slot.label} control must still read ${slot.state}`,
    );
  }

  // Planned items are still structurally incapable of being links.
  for (const planned of PLANNED_DESTINATIONS) {
    assert.equal('href' in planned, false);
    for (const anchor of anchors(html)) {
      assert.equal(anchor.text.includes(planned.label), false, `${planned.label} inside a link`);
    }
  }
});

test('16-18. Today and Meetings render as real links; planned items have no href', () => {
  const header = renderNav('primary', `/date/${TODAY}`);
  const links = anchors(header);

  const today = links.find((a) => a.text === 'Today');
  const meetings = links.find((a) => a.text === 'Meetings');
  assert.ok(today, 'Today must be an anchor');
  assert.ok(meetings, 'Meetings must be an anchor');
  assert.equal(today.href, `/date/${TODAY}`);
  assert.equal(meetings.href, `/date/${TODAY}#${MEETINGS_ANCHOR_ID}`);

  // Every anchor carries meaningful text and a non-empty href.
  for (const anchor of links) {
    assert.notEqual(anchor.href, '');
    assert.ok(anchor.text.trim().length > 0, `empty link text for ${anchor.href}`);
  }

  // The planned item renders as a span, not an anchor.
  assert.match(header, /<span class="rb-nav__planned">\s*Operations/);
});

test('38, 40. mobile structure and every existing label are preserved', () => {
  const mobile = renderNav('mobile', `/date/${TODAY}`);
  const links = anchors(mobile);

  // Structure: capped, working destinations only, short labels, no planned item.
  assert.ok(links.length > 0);
  assert.ok(
    links.length <= MOBILE_NAV_MAX_DESTINATIONS,
    `mobile has ${links.length}, ceiling is ${MOBILE_NAV_MAX_DESTINATIONS}`,
  );
  assert.equal(/rb-nav__planned|rb-nav__item--planned|aria-disabled/.test(mobile), false);
  for (const planned of PLANNED_DESTINATIONS) {
    assert.equal(mobile.includes(planned.label), false);
  }

  // No established destination was displaced: the fragment destination is what
  // stays out of the bar, so all four originals survive and Today joins them.
  assert.deepEqual(
    buildMobileDestinations(TODAY).map((d) => d.shortLabel),
    ['Overview', 'Today', 'Method', 'Tipsters', 'Record'],
  );
  for (const original of MOBILE_DESTINATIONS) {
    assert.ok(
      buildMobileDestinations(TODAY).some((d) => d.href === original.href),
      `${original.href} was displaced from the bottom bar`,
    );
  }
  // No fragment href reaches the bar.
  for (const destination of buildMobileDestinations(TODAY)) {
    assert.doesNotMatch(destination.href, /#/);
  }

  // Existing labels are unchanged.
  for (const expected of ['Overview', 'Methodology', 'Tipster Evidence', 'Official Record']) {
    assert.ok(
      PRIMARY_DESTINATIONS.some((d) => d.label === expected),
      `${expected} label changed`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 20-21, 23-25. Active-navigation policy and the client boundary             */
/* -------------------------------------------------------------------------- */

test('20-21. AppNavigation derives the date only through the shared helper', () => {
  const navCode = code(NAV);
  // It constructs no clock read of its own and duplicates no timezone logic:
  // the single source is `currentRacingDate`, called once from the effect.
  assert.doesNotMatch(navCode, /new Date\(/, 'the navigation must not construct a clock read');
  assert.doesNotMatch(navCode, /Date\.now|Intl\.DateTimeFormat/);
  assert.doesNotMatch(navCode, /Europe\/London/, 'no second timezone definition');
  // It builds hrefs from the resolved date, not from a clock.
  assert.match(navCode, /buildPrimaryDestinations\(racingDate\)/);
  assert.match(navCode, /buildMobileDestinations\(racingDate\)/);
  assert.match(code(NAV), /['"]use client['"]/, 'AppNavigation is the client component');

  // The seam renders the post-mount output for this suite.
  assert.match(renderNav('primary', '/'), new RegExp(`href="/date/${TODAY}"`));
});

test('23-24. Today is active across its route family, with no prefix collision', () => {
  const activeFor = (pathname: string | null): string[] =>
    buildPrimaryDestinations(TODAY)
      .filter((d) => isNavDestinationActive(resolveActivePathname(undefined, pathname), d.href))
      .map((d) => d.label);

  // The whole current-date hierarchy.
  assert.deepEqual(activeFor(`/date/${TODAY}`), ['Today']);
  assert.deepEqual(activeFor(`/date/${TODAY}/meeting/catterick`), ['Today']);
  assert.deepEqual(activeFor(`/date/${TODAY}/meeting/catterick/race/1315-example`), ['Today']);
  assert.deepEqual(activeFor(`/date/${TODAY}/`), ['Today'], 'trailing slash');
  assert.deepEqual(activeFor(`/date/${TODAY}?x=1`), ['Today'], 'query string');
  assert.deepEqual(activeFor(`/date/${TODAY}#${MEETINGS_ANCHOR_ID}`), ['Today'], 'hash');

  // Segment boundary: a longer date-like segment is NOT a descendant.
  assert.deepEqual(activeFor(`/date/${TODAY}0`), [], 'prefix collision must not activate');
  assert.deepEqual(activeFor('/date/2026-08-18'), [], 'another date is not Today');
  assert.deepEqual(activeFor('/date'), []);
  assert.deepEqual(activeFor(null), []);

  // Unrelated destinations behave exactly as before.
  assert.deepEqual(activeFor('/'), ['Overview']);
  assert.deepEqual(activeFor('/how-it-works'), ['Methodology']);
  assert.deepEqual(activeFor('/leaderboard'), ['Tipster Evidence']);
  assert.deepEqual(activeFor('/results-audit'), ['Official Record']);
  assert.deepEqual(activeFor('/leaderboards'), [], 'no false prefix match');
});

test('25. aria-current lands on exactly one destination — Today owns the route family', () => {
  // POLICY: a fragment destination is never active. Meetings targets a section
  // of a page Today already represents, and a fragment is not part of
  // usePathname() on either side, so marking it would be non-deterministic.
  assert.equal(isNavDestinationActive(`/date/${TODAY}`, `/date/${TODAY}#${MEETINGS_ANCHOR_ID}`), false);
  assert.equal(isNavDestinationActive(`/date/${TODAY}#${MEETINGS_ANCHOR_ID}`, `/date/${TODAY}#${MEETINGS_ANCHOR_ID}`), false);

  for (const pathname of [
    '/',
    `/date/${TODAY}`,
    `/date/${TODAY}/meeting/catterick`,
    `/date/${TODAY}/meeting/catterick/race/1315-example`,
    '/how-it-works',
    '/results-audit',
  ]) {
    const html = renderShell(pathname);
    for (const [name, region] of [
      ['header', headerNav(html)],
      ['mobile', mobileNav(html)],
    ] as const) {
      const current = [...region.matchAll(/aria-current="page"/g)];
      assert.ok(
        current.length <= 1,
        `${pathname}: ${name} nav marked ${current.length} destinations current`,
      );
    }
  }

  // On a current-date route exactly one is marked, and it is Today.
  const header = renderNav('primary', `/date/${TODAY}/meeting/catterick`);
  const marked = [...header.matchAll(/<a\b[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/a>/g)].map(
    (m) => m[1].replace(/<[^>]*>/g, ''),
  );
  assert.deepEqual(marked, ['Today']);
});

/* -------------------------------------------------------------------------- */
/* 26-28. Meetings anchor                                                     */
/* -------------------------------------------------------------------------- */

test('26-28. the meetings anchor exists exactly once, on populated and empty dates', () => {
  const pageCode = code(DATE_PAGE);

  // One shared constant, no duplicated literal.
  assert.match(pageCode, /import \{ MEETINGS_ANCHOR_ID \}/);
  assert.doesNotMatch(pageCode, /id="meetings"/, 'the id must come from the constant');

  const occurrences = [...pageCode.matchAll(/id=\{MEETINGS_ANCHOR_ID\}/g)];
  assert.equal(occurrences.length, 2, 'one per mutually exclusive branch');

  // The two occurrences sit in the EMPTY branch and the POPULATED branch, which
  // cannot render together — so exactly one id reaches the document.
  const emptyBranch = pageCode.indexOf('outcome.races.length === 0');
  const populated = pageCode.indexOf('rb-meeting-grid');
  assert.ok(emptyBranch > 0 && populated > emptyBranch);
  assert.ok(occurrences[0].index! > emptyBranch && occurrences[0].index! < populated);
  assert.ok(occurrences[1].index! > populated - 400);

  // Focusable when the fragment is followed, without JavaScript.
  assert.equal((pageCode.match(/tabIndex=\{-1\}/g) ?? []).length, 2);
  assert.doesNotMatch(pageCode, /useEffect|scrollIntoView|window\./, 'no JS is required');
  assert.doesNotMatch(pageCode, /['"]use client['"]/, 'still a server component');

  // Heading order is untouched: the anchor adds no heading and no second h1.
  assert.equal((pageCode.match(/<h1/g) ?? []).length, 1);
  assert.match(pageCode, /<section id=\{MEETINGS_ANCHOR_ID\} aria-label="Meetings"/);
});

test('26b. no scroll-offset CSS was needed, and none was added', () => {
  const tokens = readFileSync('src/styles/tokens.css', 'utf8');
  // The header is not fixed or sticky, so an anchor jump cannot land beneath it.
  const headerRule = tokens.slice(tokens.indexOf('.rb-header {'));
  const headerBody = headerRule.slice(0, headerRule.indexOf('}'));
  assert.doesNotMatch(headerBody, /position:\s*(fixed|sticky)/);
  // Nothing animated or outline-suppressing crept in.
  assert.doesNotMatch(tokens, /scroll-behavior:\s*smooth/);
  assert.doesNotMatch(tokens, /outline:\s*(none|0)\b/);
});

/* -------------------------------------------------------------------------- */
/* 29-31. Historical meeting copy                                             */
/* -------------------------------------------------------------------------- */

test('29-31. historical copy is accurate; canonical copy is unchanged', () => {
  const historical = groupRacesByMeeting([
    {
      id: 'h1', meeting_date: '2026-06-16', course: 'Ascot', country: 'GB',
      course_key: null, race_slug: null, race_name: 'Legacy Race',
      off_time: '2026-06-16T13:00:00.000Z', status: 'result', race_type: null,
      going: null, distance: null, distance_f: null, race_class: null,
      age_band: null, pattern: null, field_size: null, is_abandoned: null,
    },
  ])[0];
  const historicalHtml = renderToStaticMarkup(
    h(MeetingSummaryCard, { meeting: historical, date: '2026-06-16' }),
  );

  // The date page shows CARDS, not the races inside them, so the old claim was
  // false on this page.
  assert.doesNotMatch(historicalHtml, /listed here/i, 'must not claim races are listed here');
  assert.doesNotMatch(historicalHtml, /are not linked/i);
  assert.match(historicalHtml, /no permanent meeting page or race links/);
  assert.match(historicalHtml, /stored before canonical race identity was captured/);

  // Still honest about the data: not invalid, no promised backfill, no link.
  assert.doesNotMatch(historicalHtml, /invalid|corrupt|error|broken/i);
  assert.doesNotMatch(historicalHtml, /will be|backfill|soon|future|coming/i);
  assert.doesNotMatch(historicalHtml, /<a /, 'no guessed legacy link');

  // Canonical cards carry no such note at all.
  const canonical = groupRacesByMeeting([
    {
      id: 'c1', meeting_date: TODAY, course: 'Catterick', country: 'GB',
      course_key: 'catterick', race_slug: '1315-example', race_name: 'Example',
      off_time: `${TODAY}T13:15:00.000Z`, status: 'scheduled', race_type: null,
      going: null, distance: null, distance_f: null, race_class: null,
      age_band: null, pattern: null, field_size: null, is_abandoned: null,
    },
  ])[0];
  const canonicalHtml = renderToStaticMarkup(
    h(MeetingSummaryCard, { meeting: canonical, date: TODAY }),
  );
  assert.doesNotMatch(canonicalHtml, /stored before canonical race identity/);
  assert.doesNotMatch(canonicalHtml, /no permanent meeting page/);
  assert.match(canonicalHtml, new RegExp(`href="/date/${TODAY}/meeting/catterick"`));
});

/* -------------------------------------------------------------------------- */
/* 32-35, 39. Safety boundaries                                               */
/* -------------------------------------------------------------------------- */

test('32-33. navigation hrefs use canonical route text only', () => {
  const html = renderNav('primary', `/date/${TODAY}`);
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  for (const anchor of anchors(html)) {
    // No legacy query-string dashboard link.
    assert.doesNotMatch(anchor.href, /\?date=|&course=/, `legacy link: ${anchor.href}`);
    assert.doesNotMatch(anchor.href, uuid, `uuid in href: ${anchor.href}`);
    assert.doesNotMatch(anchor.href, /provider|race_id|horse_id/i);
  }
  // The builder composes only validated date + fixed route text.
  const modelCode = code(NAV_MODEL);
  assert.match(modelCode, /`\/date\/\$\{todayDate\}`/);
  assert.match(modelCode, /isIsoRacingDate\(todayDate\)/);
  assert.doesNotMatch(modelCode, /\?date=/);
});

test('34-35, 39. the exposure files perform no side effect and reach no server module', () => {
  const forbidden: [string, RegExp][] = [
    ['fetch', /\bfetch\s*\(/],
    ['rpc', /\.rpc\s*\(/],
    ['insert', /\.insert\s*\(/],
    ['update', /\.update\s*\(/],
    ['upsert', /\.upsert\s*\(/],
    ['delete', /\.delete\s*\(/],
    ['storage', /\.storage\b/],
    ['api route', /['"`]\/api\//],
    ['supabase', /supabaseAdmin|@supabase/],
    ['provider', /theracingapi|betfair/i],
    ['model/odds/lock', /runModelForRace|syncOdds|try_acquire_model_lock|lockTMinus/],
    ['settlement', /settleRace|syncResults/],
    ['producer claim', /producerClaim|producerOwnership/],
    ['env access', /process\.env/],
    ['dangerous html', /dangerouslySetInnerHTML/],
  ];
  for (const file of EXPOSURE_FILES) {
    const executable = code(file);
    assert.ok(executable.trim().length > 200, `${file} produced no scannable code`);
    for (const [label, pattern] of forbidden) {
      assert.doesNotMatch(executable, pattern, `${file} contains ${label}`);
    }
  }

  // The date helper is deliberately dependency-free, which is what keeps the
  // client bundle from reaching the server-side navigation library.
  assert.doesNotMatch(code(DATE_HELPER), /^import /m, 'the date helper must import nothing');

  // The shell components must not reach @/lib at all (existing contract).
  for (const file of [SHELL, NAV, NAV_MODEL, DATE_HELPER]) {
    for (const m of code(file).matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.equal(m[1].startsWith('@/lib'), false, `${file} imports server code: ${m[1]}`);
    }
  }
});

test('39b. the client closure still cannot reach the service-role client', () => {
  // Same walker contract as the route closure guard: start at the one client
  // component in the shell and prove supabaseAdmin is unreachable.
  const resolveLocal = (spec: string, from: string): string | null => {
    let base: string;
    if (spec.startsWith('@/')) base = nodePath.join('src', spec.slice(2));
    else if (spec.startsWith('.')) base = nodePath.join(nodePath.dirname(from), spec);
    else return null;
    for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx', '']) {
      const candidate = base + ext;
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate.split(nodePath.sep).join('/');
      }
    }
    return null;
  };
  const visited = new Set<string>();
  const walk = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const m of src(file).matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const resolved = resolveLocal(m[1], file);
      if (resolved !== null) walk(resolved);
    }
  };
  walk(NAV);

  // Non-vacuous: the walk reached past its root into the navigation model.
  assert.ok(visited.size >= 2, `client closure too small: ${visited.size}`);
  assert.ok(visited.has(NAV) && visited.has(NAV_MODEL), 'closure is truncated');
  assert.equal(visited.has('src/lib/supabaseAdmin.ts'), false, 'client reaches service role');
  for (const file of visited) {
    assert.doesNotMatch(code(file), /process\.env/, `${file} is client-reachable and reads env`);
    assert.doesNotMatch(code(file), /supabaseAdmin/, `${file} is client-reachable`);
  }
});

/* ========== H-1 / M-1: the mount-gated hydration contract ================= */

test('H1-a. AppShell performs no current-date calculation of any kind', () => {
  const shellCode = code(SHELL);
  // The defect was here: a shared module reading a clock. On a statically
  // prerendered page that read happens at BUILD time and freezes forever.
  assert.doesNotMatch(shellCode, /currentRacingDate/, 'AppShell must not compute the date');
  assert.doesNotMatch(shellCode, /new Date\(/, 'AppShell must not read a clock');
  assert.doesNotMatch(shellCode, /Date\.now|Intl\.DateTimeFormat|Europe\/London/);
  assert.doesNotMatch(shellCode, /from ['"]\.\/racingDate['"]/, 'no date import remains');

  // It cannot accept an injected date either: a server page passing one would
  // reintroduce exactly the same frozen-date defect.
  assert.doesNotMatch(shellCode, /todayDate/, 'AppShell must expose no date prop');
  assert.doesNotMatch(shellCode, /<AppNavigation[^>]*todayDate/, 'no date is handed down');
});

test('H1-b. AppShell is documented as SHARED, not server-only', () => {
  const shellDoc = src(SHELL);
  // M-1: the old wording asserted server-only, which is what hid the defect.
  assert.doesNotMatch(shellDoc, /SERVER COMPONENT\./);
  assert.doesNotMatch(shellDoc, /Derived HERE, on the server/);
  assert.match(shellDoc, /SHARED COMPONENT/);
  assert.match(shellDoc, /NOT inherently server-only/);
  assert.match(shellDoc, /bundled for the BROWSER/);
  assert.match(shellDoc, /must never read/);
  assert.match(shellDoc, /request-time or current-time state/);

  // And no test proves "server-only" from directive absence any more: the
  // shell no longer needs that claim, because it reads nothing time-dependent.
  // (Scanning this file for the old phrase would match this assertion itself,
  // so the guarantee is asserted against the component instead.)
  assert.doesNotMatch(code(SHELL), /currentRacingDate|new Date\(/);
});

test('H1-c. the SERVER render carries no dated href — nothing can freeze', () => {
  // renderToStaticMarkup runs no effects, so this IS the server output and the
  // first hydration render. Both are identical by construction.
  for (const pathname of ['/', '/how-it-works', '/leaderboard', '/results-audit', `/date/${TODAY}`]) {
    const html = renderShell(pathname);
    assert.doesNotMatch(html, /href="\/date\//, `${pathname} froze a dated href`);
    assert.doesNotMatch(html, /\d{4}-\d{2}-\d{2}/, `${pathname} embedded a date`);
    // Still no broken or empty link in that state.
    for (const anchor of anchors(html)) {
      assert.notEqual(anchor.href, '');
      assert.doesNotMatch(anchor.href, /undefined|null|NaN/);
    }
  }
});

test('H1-d. server and first-hydration navigation renders are byte-identical', () => {
  // The initial state is a plain `null` literal, never a clock read, and a
  // useState initializer DOES run during server rendering — so the first
  // client render reproduces the server render exactly.
  const serverRender = renderShell(`/date/${TODAY}`);
  const firstClientRender = renderShell(`/date/${TODAY}`);
  assert.equal(serverRender, firstClientRender);

  // Rendering the navigation alone with no resolved date agrees with it.
  const preMount = renderNav('primary', `/date/${TODAY}`, null);
  assert.doesNotMatch(preMount, /href="\/date\//);
  assert.doesNotMatch(preMount, /Today|Meetings/, 'no dated destination before mount');

  // A hydration mismatch on the date is structurally impossible: the SERVER
  // snapshot React renders on both sides is a constant null.
  assert.match(code(NAV), /serverRacingDate = \(\): string \| null => null;/);
  assert.doesNotMatch(code(NAV), /serverRacingDate[^;]*currentRacingDate/, 'server snapshot must not read a clock');
});

test('H1-e. the date is resolved once, after mount, via the server-snapshot hook', () => {
  const navCode = code(NAV);
  // React renders getServerSnapshot on the server AND on hydration, then
  // switches to getSnapshot once mounted — the mount gate, by construction.
  assert.match(
    navCode,
    /useSyncExternalStore\(subscribeNoop, currentRacingDate, serverRacingDate\)/,
  );
  assert.equal((navCode.match(/useSyncExternalStore\(/g) ?? []).length, 1, 'exactly one store');
  // No set-state-in-effect pattern, so no extra render pass and no lint escape.
  assert.doesNotMatch(navCode, /useState\(|useEffect\(/, 'no state or effect is used');
  // The subscribe is a stable module-scoped no-op: the date does not change
  // during a page's lifetime.
  assert.match(navCode, /const subscribeNoop = \(\): \(\(\) => void\) => \(\) => \{\};/);
  // It reuses the existing helper rather than duplicating the calculation.
  assert.match(navCode, /from ['"]\.\/racingDate['"]/);
  assert.doesNotMatch(navCode, /Europe\/London/, 'no second timezone definition');
  assert.doesNotMatch(navCode, /Intl\.DateTimeFormat/);
});

test('H1-f. after mount, Today and Meetings are built from the racing date', () => {
  const header = renderNav('primary', `/date/${TODAY}`);
  const links = anchors(header);
  assert.equal(links.find((a) => a.text === 'Today')?.href, `/date/${TODAY}`);
  assert.equal(
    links.find((a) => a.text === 'Meetings')?.href,
    `/date/${TODAY}#${MEETINGS_ANCHOR_ID}`,
  );
  // One shared date per mounted navigation — both links agree.
  assert.ok(links.find((a) => a.text === 'Meetings')?.href.startsWith(`/date/${TODAY}`));

  // A null resolved date leaves both unavailable rather than malformed.
  const unresolved = renderNav('primary', `/date/${TODAY}`, null);
  for (const anchor of anchors(unresolved)) {
    assert.doesNotMatch(anchor.href, /\/date\//);
    assert.notEqual(anchor.href, '');
  }
});

test('H1-g. no route was forced dynamic and no revalidation was added', () => {
  // The remedy must not change deployment rendering characteristics.
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...walk(full));
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  };
  const appFiles = walk('src/app').filter((f) => !f.includes('/api/'));
  assert.ok(appFiles.length >= 5, 'expected the app routes to be found');
  for (const file of appFiles) {
    const fileCode = code(file);
    assert.doesNotMatch(fileCode, /export const dynamic/, `${file} forces a rendering mode`);
    assert.doesNotMatch(fileCode, /export const revalidate/, `${file} adds revalidation`);
    assert.doesNotMatch(fileCode, /force-dynamic|force-static/, file);
    assert.doesNotMatch(fileCode, /\bconnection\(\)/, `${file} opts into dynamic rendering`);
  }
  // The shell components likewise.
  for (const file of [SHELL, NAV, NAV_MODEL, DATE_HELPER]) {
    assert.doesNotMatch(code(file), /connection\(\)|export const (dynamic|revalidate)/, file);
  }
});

test('H1-h. a date change takes effect on a fresh load, with no redeployment', () => {
  // The mounted value is whatever the helper returns at mount time, so two
  // different instants produce two different navigations from the SAME build.
  const dayOne = currentRacingDate(at('2026-08-17T12:00:00.000Z'));
  const dayTwo = currentRacingDate(at('2026-08-17T23:30:00.000Z')); // already tomorrow in BST
  assert.equal(dayOne, '2026-08-17');
  assert.equal(dayTwo, '2026-08-18');
  assert.notEqual(dayOne, dayTwo);

  assert.match(renderNav('primary', '/', dayOne), /href="\/date\/2026-08-17"/);
  assert.match(renderNav('primary', '/', dayTwo), /href="\/date\/2026-08-18"/);

  // Nothing in the shell or navigation caches a date beyond the mount.
  assert.doesNotMatch(code(NAV), /localStorage|sessionStorage|globalThis\./);
  assert.doesNotMatch(code(SHELL), /localStorage|sessionStorage/);
});

test('H1-i. no production caller passes todayDate — the seam is test-only', () => {
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...walk(full));
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  };
  const production = [...walk('src')];
  assert.ok(production.length > 10);
  for (const file of production) {
    if (file.endsWith('AppNavigation.tsx')) continue; // the declaration itself
    // JSX attribute form only: a type annotation or a parameter name in the
    // pure builders is not a caller supplying a render-time date.
    assert.doesNotMatch(
      code(file),
      /todayDate=\{/,
      `${file} supplies a render-time date, reintroducing the frozen-date defect`,
    );
  }
});

test('H1-j. the pre-mount navigation has no aria-current on a racing destination', () => {
  // Before mount those destinations do not exist, so they cannot claim state.
  const preMount = renderNav('primary', `/date/${TODAY}`, null);
  const marked = [...preMount.matchAll(/<a\b[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/a>/g)].map(
    (m) => m[1].replace(/<[^>]*>/g, ''),
  );
  assert.deepEqual(marked, [], 'nothing is current when the date is unresolved');

  // After mount, Today claims it and Meetings never does.
  const mounted = renderNav('primary', `/date/${TODAY}/meeting/catterick`);
  const mountedMarked = [
    ...mounted.matchAll(/<a\b[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/a>/g),
  ].map((m) => m[1].replace(/<[^>]*>/g, ''));
  assert.deepEqual(mountedMarked, ['Today']);
});

test('H1-k. racingDate is deliberately inside the client closure and is inert', () => {
  const helper = code(DATE_HELPER);
  assert.doesNotMatch(helper, /^import /m, 'zero imports keeps the client bundle small');
  assert.doesNotMatch(helper, /process\.env/);
  assert.doesNotMatch(helper, /\bfetch\s*\(|\.rpc\s*\(|\.insert\s*\(|\.update\s*\(|\.delete\s*\(/);
  assert.doesNotMatch(helper, /supabase|@supabase/i);

  // It is now reached from the client component, which is intended.
  assert.match(code(NAV), /from ['"]\.\/racingDate['"]/);
  // And AppNavigation remains the ONLY shell module carrying the directive.
  const withDirective = [SHELL, NAV, NAV_MODEL, DATE_HELPER].filter((f) =>
    /['"]use client['"]/.test(code(f)),
  );
  assert.deepEqual(withDirective, [NAV]);
});
