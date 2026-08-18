/**
 * Canonical racing navigation — /date, /meeting, /race.
 *
 * Pure helpers are exercised directly, the read layer through an injected
 * fixture seam, and the presentational components through real
 * `renderToStaticMarkup` output. Page-level wiring that cannot be reached
 * without a database (the `notFound()` calls, the query columns, the absence
 * of writes) is pinned as a SOURCE contract instead, and every source scan
 * runs on COMMENT-STRIPPED code so a scanner can never be satisfied by prose.
 *
 * This file opens no database, calls no provider, runs no model, captures no
 * odds, creates no lock, settles no result and acquires no producer claim.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import nodePath from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';

import {
  canonicalDateHref,
  canonicalMeetingHref,
  canonicalRaceHref,
  compareRaces,
  compareRunners,
  datePageTitle,
  decodeRouteSegment,
  describeRaceStatus,
  displayDistance,
  displayValue,
  findAdjacentRaces,
  formatMeetingDate,
  formatOffTime,
  groupRacesByMeeting,
  isCanonicalDate,
  isCanonicalHandle,
  meetingPageTitle,
  nextMeetingDate,
  previousMeetingDate,
  racePageTitle,
  summariseStoredStatuses,
  MAX_HANDLE_LENGTH,
  NAVIGATION_RACE_COLUMNS,
  NAVIGATION_RUNNER_COLUMNS,
  RACING_TIME_ZONE,
  UNAVAILABLE_LABEL,
  UNKNOWN_COURSE_LABEL,
  type NavigationRaceRow,
  type NavigationRunnerRow,
} from '../src/lib/racingNavigation';
import {
  loadMeeting,
  loadRacesForDate,
  loadRunnersForRace,
  resolveCanonicalRace,
  type NavigationReadSeam,
} from '../src/lib/racingNavigationRead';
import Breadcrumbs from '../src/components/racing/Breadcrumbs';
import MeetingSummaryCard from '../src/components/racing/MeetingSummaryCard';
import RaceSummaryRow from '../src/components/racing/RaceSummaryRow';
import RunnerList from '../src/components/racing/RunnerList';

/* -------------------------------------------------------------------------- */
/* Sources + fixtures                                                         */
/* -------------------------------------------------------------------------- */

const DATE_PAGE = 'src/app/date/[date]/page.tsx';
const MEETING_PAGE = 'src/app/date/[date]/meeting/[course_key]/page.tsx';
const RACE_PAGE = 'src/app/date/[date]/meeting/[course_key]/race/[race_slug]/page.tsx';
const READ_LIB = 'src/lib/racingNavigationRead.ts';
const PURE_LIB = 'src/lib/racingNavigation.ts';
const COMPONENTS = [
  'src/components/racing/Breadcrumbs.tsx',
  'src/components/racing/MeetingSummaryCard.tsx',
  'src/components/racing/RaceSummaryRow.tsx',
  'src/components/racing/RunnerList.tsx',
];
const NAVIGATION_FILES = [DATE_PAGE, MEETING_PAGE, RACE_PAGE, READ_LIB, PURE_LIB, ...COMPONENTS];

const src = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** Executable code only: block and line comments removed (`://` preserved). */
const code = (path: string): string =>
  src(path)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

function race(over: Partial<NavigationRaceRow> = {}): NavigationRaceRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    meeting_date: '2026-08-17',
    course: 'Ascot',
    country: 'GB',
    course_key: 'ascot',
    race_slug: '1330-example-stakes',
    race_name: 'Example Stakes',
    off_time: '2026-08-17T13:30:00.000Z',
    status: 'scheduled',
    race_type: 'Flat',
    going: 'Good',
    distance: '1m 2f',
    distance_f: 10,
    race_class: 'Class 2',
    age_band: '3yo+',
    pattern: 'Listed',
    field_size: 8,
    is_abandoned: false,
    ...over,
  };
}

function runner(over: Partial<NavigationRunnerRow> = {}): NavigationRunnerRow {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    horse_name: 'Example Horse',
    draw: 3,
    saddlecloth: 1,
    age: 4,
    official_rating: 92,
    weight_lbs: 133,
    trainer: 'A Trainer',
    jockey: 'A Jockey',
    runner_status: 'runner',
    ...over,
  };
}

/** A seam that records every call and returns fixtures. Never touches a DB. */
function stubSeam(rows: {
  date?: NavigationRaceRow[];
  meeting?: NavigationRaceRow[];
  handle?: NavigationRaceRow[];
  runners?: NavigationRunnerRow[];
  fail?: boolean;
}): { seam: NavigationReadSeam; calls: string[] } {
  const calls: string[] = [];
  const fail = rows.fail === true;
  const seam: NavigationReadSeam = {
    async racesForDate(date) {
      calls.push(`racesForDate(${date})`);
      return fail ? { ok: false, rows: null } : { ok: true, rows: rows.date ?? [] };
    },
    async racesForMeeting(date, courseKey) {
      calls.push(`racesForMeeting(${date},${courseKey})`);
      return fail ? { ok: false, rows: null } : { ok: true, rows: rows.meeting ?? [] };
    },
    async racesForCanonicalHandle(date, courseKey, raceSlug) {
      calls.push(`racesForCanonicalHandle(${date},${courseKey},${raceSlug})`);
      return fail ? { ok: false, rows: null } : { ok: true, rows: rows.handle ?? [] };
    },
    async runnersForRace(raceId) {
      calls.push(`runnersForRace(${raceId})`);
      return fail ? { ok: false, rows: null } : { ok: true, rows: rows.runners ?? [] };
    },
  };
  return { seam, calls };
}

/* -------------------------------------------------------------------------- */
/* 1-4. Date validation                                                       */
/* -------------------------------------------------------------------------- */

test('1. a valid ISO calendar date is accepted', () => {
  for (const good of ['2026-08-17', '2026-01-01', '2026-12-31', '2024-02-29']) {
    assert.equal(isCanonicalDate(good), true, good);
  }
});

test('2. malformed date input is rejected, never repaired', () => {
  for (const bad of [
    '2026-8-17',
    '26-08-17',
    '2026/08/17',
    '2026-08-17T00:00:00Z',
    '2026-08-17 ',
    ' 2026-08-17',
    'today',
    '',
    '2026-08',
    '2026-08-017',
    '../../etc/passwd',
    "2026-08-17' or '1'='1",
  ]) {
    assert.equal(isCanonicalDate(bad), false, JSON.stringify(bad));
  }
  for (const wrongType of [null, undefined, 20260817, {}, []]) {
    assert.equal(isCanonicalDate(wrongType), false, String(wrongType));
  }
});

test('3. impossible calendar dates are rejected', () => {
  for (const impossible of [
    '2026-02-30',
    '2026-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-01-32',
    '2026-01-00',
  ]) {
    assert.equal(isCanonicalDate(impossible), false, impossible);
  }
});

test('4. a date is NEVER silently normalised into a different day', () => {
  // Date.UTC would roll 2026-02-30 to 2026-03-02. The round-trip check is what
  // stops the page answering for a day the user did not ask for.
  assert.equal(isCanonicalDate('2026-02-30'), false);
  assert.equal(canonicalDateHref('2026-02-30'), null);
  // Two-digit-year shorthand cannot resolve either (Date.UTC(26,…) is 1926).
  assert.equal(isCanonicalDate('0026-01-01'), false);
  // A rejected date produces no href at all, so no redirect target can exist.
  assert.equal(canonicalDateHref('2026-13-01'), null);
  assert.equal(previousMeetingDate('2026-02-30'), null);
  assert.equal(nextMeetingDate('2026-02-30'), null);
});

test('4b. adjacent-day arithmetic is pure, UTC and crosses month/year ends', () => {
  assert.equal(previousMeetingDate('2026-08-17'), '2026-08-16');
  assert.equal(nextMeetingDate('2026-08-17'), '2026-08-18');
  assert.equal(previousMeetingDate('2026-01-01'), '2025-12-31');
  assert.equal(nextMeetingDate('2026-12-31'), '2027-01-01');
  assert.equal(nextMeetingDate('2024-02-28'), '2024-02-29');
  // Deterministic: no clock is consulted, so repeated calls agree.
  assert.equal(previousMeetingDate('2026-08-17'), previousMeetingDate('2026-08-17'));
});

test('4c. route segments are decoded safely and malformed escapes never throw', () => {
  assert.equal(decodeRouteSegment('great-yarmouth'), 'great-yarmouth');
  assert.equal(decodeRouteSegment('%41scot'), 'Ascot');
  assert.equal(decodeRouteSegment('%E0%A4%A'), null, 'a malformed escape is null, not a throw');
  assert.equal(decodeRouteSegment(''), null);
  assert.equal(decodeRouteSegment(undefined), null);

  // Handle charset: only what courseKey()/raceSlug() can actually emit.
  for (const good of ['ascot', 'great-yarmouth', '1330-example-stakes', 'a1']) {
    assert.equal(isCanonicalHandle(good), true, good);
  }
  for (const bad of [
    'Ascot',
    'ascot/../admin',
    'ascot%2F',
    'ascot_key',
    '-ascot',
    'ascot-',
    'ascot--key',
    'ascot key',
    "ascot';select",
    '',
    'a'.repeat(MAX_HANDLE_LENGTH + 1),
  ]) {
    assert.equal(isCanonicalHandle(bad), false, JSON.stringify(bad));
  }
});

/* -------------------------------------------------------------------------- */
/* 5-8. Date page                                                             */
/* -------------------------------------------------------------------------- */

test('5. the date-page query filters on meeting_date', async () => {
  const { seam, calls } = stubSeam({ date: [race()] });
  const outcome = await loadRacesForDate('2026-08-17', seam);
  assert.equal(outcome.kind, 'ok');
  assert.deepEqual(calls, ['racesForDate(2026-08-17)']);

  // And the live seam filters on that exact column.
  const readCode = code(READ_LIB);
  assert.match(readCode, /\.eq\('meeting_date', date\)/);
  assert.match(readCode, /\.from\('races'\)/);
});

test('6. the date page groups by STORED course_key, never by display name', () => {
  const rows = [
    race({ id: 'a', course_key: 'ascot', course: 'Ascot', off_time: '2026-08-17T14:00:00.000Z' }),
    // Same course, DIFFERENT display spelling — must still group with the above,
    // because grouping keys on the stored handle.
    race({ id: 'b', course_key: 'ascot', course: 'Royal Ascot', off_time: '2026-08-17T13:00:00.000Z' }),
    race({ id: 'c', course_key: 'ayr', course: 'Ayr', off_time: '2026-08-17T13:30:00.000Z' }),
  ];
  const meetings = groupRacesByMeeting(rows);
  assert.equal(meetings.length, 2);

  const ascot = meetings.find((m) => m.courseKey === 'ascot');
  assert.ok(ascot);
  assert.equal(ascot.raceCount, 2, 'two spellings of one stored key stay one meeting');
  assert.equal(ascot.firstOffTime, '2026-08-17T13:00:00.000Z');
  assert.equal(ascot.lastOffTime, '2026-08-17T14:00:00.000Z');

  // Meetings themselves order by first off time — deterministic.
  assert.deepEqual(
    meetings.map((m) => m.courseKey),
    ['ascot', 'ayr'],
  );
});

test('7. canonical meeting links are built from the stored course_key', () => {
  assert.equal(canonicalMeetingHref('2026-08-17', 'ascot'), '/date/2026-08-17/meeting/ascot');
  const markup = renderToStaticMarkup(
    h(MeetingSummaryCard, { meeting: groupRacesByMeeting([race()])[0], date: '2026-08-17' }),
  );
  assert.match(markup, /href="\/date\/2026-08-17\/meeting\/ascot"/);
  assert.match(markup, />Ascot</);
});

test('8. historical rows with a null course_key get NO fabricated link', () => {
  const historical = race({ id: 'h', course_key: null, race_slug: null, course: 'Old Course' });
  const meetings = groupRacesByMeeting([historical]);
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0].courseKey, null);
  assert.equal(meetings[0].courseLabel, 'Old Course', 'it is still displayed, never hidden');
  assert.equal(meetings[0].linkableRaceCount, 0);
  assert.equal(canonicalMeetingHref('2026-08-17', null), null);

  const markup = renderToStaticMarkup(
    h(MeetingSummaryCard, { meeting: meetings[0], date: '2026-08-17' }),
  );
  assert.doesNotMatch(markup, /<a /, 'a handle-less meeting renders no anchor at all');
  assert.match(markup, /Old Course/);
  assert.match(markup, /no permanent meeting page or race links/);
});

test('8b. a date mixing canonical and historical rows links only the canonical ones', () => {
  const meetings = groupRacesByMeeting([
    race({ id: 'canon', course_key: 'ascot', race_slug: '1330-example-stakes' }),
    race({ id: 'hist', course_key: null, race_slug: null, course: 'Legacy Park' }),
  ]);
  assert.equal(meetings.length, 2);
  const canon = meetings.find((m) => m.courseKey === 'ascot');
  const hist = meetings.find((m) => m.courseKey === null);
  assert.ok(canon && hist);
  assert.equal(canon.linkableRaceCount, 1);
  assert.equal(hist.linkableRaceCount, 0);
});

/* -------------------------------------------------------------------------- */
/* 9-12. Meeting page                                                         */
/* -------------------------------------------------------------------------- */

test('9. the meeting query uses date + course_key, and never the display name', async () => {
  const { seam, calls } = stubSeam({ meeting: [race()] });
  const outcome = await loadMeeting('2026-08-17', 'ascot', seam);
  assert.equal(outcome.kind, 'ok');
  assert.deepEqual(calls, ['racesForMeeting(2026-08-17,ascot)']);

  const readCode = code(READ_LIB);
  const fn = readCode.slice(readCode.indexOf('async racesForMeeting'), readCode.indexOf('async racesForCanonicalHandle'));
  assert.match(fn, /\.eq\('meeting_date', date\)/);
  assert.match(fn, /\.eq\('course_key', courseKey\)/);
  assert.doesNotMatch(fn, /\.eq\('course',/, 'a meeting is never resolved by display label');
});

test('9b. an invalid meeting tuple is not_found without any query', async () => {
  const { seam, calls } = stubSeam({ meeting: [race()] });
  assert.deepEqual(await loadMeeting('2026-02-30', 'ascot', seam), { kind: 'not_found' });
  assert.deepEqual(await loadMeeting('2026-08-17', 'Ascot', seam), { kind: 'not_found' });
  assert.deepEqual(calls, [], 'a rejected parameter never reaches the database');
});

test('9c. a meeting with no stored rows is not_found', async () => {
  const { seam } = stubSeam({ meeting: [] });
  assert.deepEqual(await loadMeeting('2026-08-17', 'ascot', seam), { kind: 'not_found' });
});

test('10. meeting races are ordered by off time with a total tie-breaker', async () => {
  const rows = [
    race({ id: 'c', off_time: '2026-08-17T15:00:00.000Z', race_name: 'Third' }),
    race({ id: 'a', off_time: '2026-08-17T13:00:00.000Z', race_name: 'First' }),
    race({ id: 'b', off_time: '2026-08-17T14:00:00.000Z', race_name: 'Second' }),
  ];
  const { seam } = stubSeam({ meeting: rows });
  const outcome = await loadMeeting('2026-08-17', 'ascot', seam);
  assert.equal(outcome.kind, 'ok');
  if (outcome.kind !== 'ok') return;
  assert.deepEqual(outcome.races.map((r) => r.id), ['a', 'b', 'c']);

  // Total: identical visible fields still order deterministically by id, and a
  // null off time sorts last rather than at an arbitrary position.
  const tied = [race({ id: 'z' }), race({ id: 'y' })].sort(compareRaces);
  assert.deepEqual(tied.map((r) => r.id), ['y', 'z']);
  const withNull = [race({ id: 'n', off_time: null }), race({ id: 'm' })].sort(compareRaces);
  assert.deepEqual(withNull.map((r) => r.id), ['m', 'n']);
});

test('11. race links are built from the stored race_slug', () => {
  assert.equal(
    canonicalRaceHref('2026-08-17', 'ascot', '1330-example-stakes'),
    '/date/2026-08-17/meeting/ascot/race/1330-example-stakes',
  );
  const markup = renderToStaticMarkup(h(RaceSummaryRow, { race: race(), date: '2026-08-17' }));
  assert.match(markup, /href="\/date\/2026-08-17\/meeting\/ascot\/race\/1330-example-stakes"/);
});

test('12. a null race_slug yields no link and no invented handle', () => {
  assert.equal(canonicalRaceHref('2026-08-17', 'ascot', null), null);
  assert.equal(canonicalRaceHref('2026-08-17', null, '1330-example-stakes'), null);
  const markup = renderToStaticMarkup(
    h(RaceSummaryRow, { race: race({ race_slug: null }), date: '2026-08-17' }),
  );
  assert.doesNotMatch(markup, /<a /);
  // RaceSummaryRow keeps its own wording: this is a RACE row, not a meeting
  // card, so "no permanent page" is accurate and deliberately unchanged.
  assert.match(markup, /no permanent page/);

  // The slug builder is never imported into the navigation — nothing can
  // recompute a handle at request time.
  for (const file of NAVIGATION_FILES) {
    assert.doesNotMatch(code(file), /\braceSlug\s*\(/, file);
    assert.doesNotMatch(code(file), /\bcourseKey\s*\(\s*['"]/, file);
    assert.doesNotMatch(code(file), /from '[^']*raceSync'/, file);
  }
});

/* -------------------------------------------------------------------------- */
/* 13-17. Race resolution                                                     */
/* -------------------------------------------------------------------------- */

test('13. the race query uses date + course_key + race_slug', async () => {
  const { seam, calls } = stubSeam({ handle: [race()] });
  const resolution = await resolveCanonicalRace('2026-08-17', 'ascot', '1330-example-stakes', seam);
  assert.equal(resolution.kind, 'ok');
  assert.deepEqual(calls, ['racesForCanonicalHandle(2026-08-17,ascot,1330-example-stakes)']);

  const readCode = code(READ_LIB);
  const fn = readCode.slice(
    readCode.indexOf('async racesForCanonicalHandle'),
    readCode.indexOf('async runnersForRace'),
  );
  assert.match(fn, /\.eq\('meeting_date', date\)/);
  assert.match(fn, /\.eq\('course_key', courseKey\)/);
  assert.match(fn, /\.eq\('race_slug', raceSlug\)/);
});

test('14. no UUID ever appears in a public path', () => {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  // The href builders are structurally incapable of embedding one.
  assert.equal(canonicalDateHref('2026-08-17'), '/date/2026-08-17');
  assert.equal(canonicalMeetingHref('2026-08-17', 'ascot'), '/date/2026-08-17/meeting/ascot');
  assert.doesNotMatch(
    String(canonicalRaceHref('2026-08-17', 'ascot', '1330-example-stakes')),
    uuid,
  );

  // Rendered output carries no uuid even though every fixture row has one.
  const rendered = [
    renderToStaticMarkup(h(RaceSummaryRow, { race: race(), date: '2026-08-17' })),
    renderToStaticMarkup(
      h(MeetingSummaryCard, { meeting: groupRacesByMeeting([race()])[0], date: '2026-08-17' }),
    ),
    renderToStaticMarkup(h(RunnerList, { runners: [runner()], caption: 'Field' })),
  ];
  for (const markup of rendered) assert.doesNotMatch(markup, uuid);

  // No route segment is named after an id.
  for (const page of [DATE_PAGE, MEETING_PAGE, RACE_PAGE]) {
    assert.doesNotMatch(page, /\[(race_)?id\]/);
  }
});

test('15. zero matching rows resolves to not_found', async () => {
  const { seam } = stubSeam({ handle: [] });
  assert.deepEqual(
    await resolveCanonicalRace('2026-08-17', 'ascot', '1330-example-stakes', seam),
    { kind: 'not_found' },
  );
  // And the page turns that into an actual 404.
  assert.match(code(RACE_PAGE), /if \(resolution\.kind === 'not_found'\) notFound\(\);/);
  assert.match(code(RACE_PAGE), /from 'next\/navigation'/);
});

test('16. DUPLICATE canonical handles fail closed — never an arbitrary pick', async () => {
  const duplicates = [
    race({ id: 'dup-a', race_name: 'First stored copy' }),
    race({ id: 'dup-b', race_name: 'Second stored copy' }),
  ];
  const { seam } = stubSeam({ handle: duplicates });
  const resolution = await resolveCanonicalRace('2026-08-17', 'ascot', '1330-example-stakes', seam);

  assert.equal(resolution.kind, 'ambiguous');
  if (resolution.kind !== 'ambiguous') return;
  assert.equal(resolution.matchCount, 2);
  // Crucially: the outcome carries NO race, so no caller can render one.
  assert.equal('race' in resolution, false);

  // Three matches behave identically — it is not a two-row special case.
  const { seam: three } = stubSeam({ handle: [...duplicates, race({ id: 'dup-c' })] });
  const triple = await resolveCanonicalRace('2026-08-17', 'ascot', '1330-example-stakes', three);
  assert.equal(triple.kind, 'ambiguous');
});

test('16b. the ambiguity message names no internal identifier', () => {
  const pageCode = code(RACE_PAGE);
  const branch = pageCode.slice(pageCode.indexOf("resolution.kind === 'ambiguous' ?"));
  const message = branch.slice(0, branch.indexOf('</ErrorState>'));
  assert.match(message, /cannot be shown safely/);
  assert.doesNotMatch(message, /race\.id|resolution\.race|matchCount|\{race/);
  // The safe log carries a count and nothing identifying.
  const readCode = code(READ_LIB);
  assert.match(readCode, /NAVIGATION_AMBIGUOUS_RACE_HANDLE matches=/);
  assert.doesNotMatch(readCode, /console\.error\([^)]*raceSlug\}/);
});

test('17. no query can silently select one of several rows', () => {
  const readCode = code(READ_LIB);
  // `.single()` throws on multiple, `.maybeSingle()` errors, `.limit(1)` picks
  // one arbitrarily. None may appear: the resolver must SEE the duplicate.
  for (const forbidden of [/\.single\s*\(/, /\.maybeSingle\s*\(/, /\.limit\s*\(\s*1\s*\)/]) {
    assert.doesNotMatch(readCode, forbidden, String(forbidden));
  }
  // And no `[0]` indexing before the count is checked.
  const resolver = readCode.slice(readCode.indexOf('export async function resolveCanonicalRace'));
  const lengthCheck = resolver.indexOf('result.rows.length > 1');
  const firstIndex = resolver.indexOf('result.rows[0]');
  assert.ok(lengthCheck > 0 && firstIndex > 0);
  assert.ok(lengthCheck < firstIndex, 'the duplicate check must precede any row access');
});

/* -------------------------------------------------------------------------- */
/* 18-20. Runners                                                             */
/* -------------------------------------------------------------------------- */

test('18. runners are loaded by the resolved INTERNAL race uuid', async () => {
  const { seam, calls } = stubSeam({ runners: [runner()] });
  const outcome = await loadRunnersForRace('11111111-1111-4111-8111-111111111111', seam);
  assert.equal(outcome.kind, 'ok');
  assert.deepEqual(calls, ['runnersForRace(11111111-1111-4111-8111-111111111111)']);

  const readCode = code(READ_LIB);
  assert.match(readCode, /\.from\('runners'\)/);
  assert.match(readCode, /\.eq\('race_id', raceId\)/);
  // The page passes the RESOLVED row's id, not a route parameter.
  assert.match(code(RACE_PAGE), /loadRunnersForRace\(race\.id\)/);
});

test('19. runner ordering is deterministic: draw, then name, then id', () => {
  const unsorted = [
    runner({ id: 'r3', horse_name: 'Cedar', draw: 2 }),
    runner({ id: 'r1', horse_name: 'Alder', draw: null }),
    runner({ id: 'r2', horse_name: 'Birch', draw: 1 }),
    runner({ id: 'r4', horse_name: 'Alder', draw: null }),
  ];
  const sorted = [...unsorted].sort(compareRunners);
  assert.deepEqual(
    sorted.map((r) => r.id),
    ['r2', 'r3', 'r1', 'r4'],
    'drawn runners first in draw order; undrawn last, alphabetical, id-stable',
  );
  // Stable across repeated sorts of a different initial permutation.
  const again = [...unsorted].reverse().sort(compareRunners);
  assert.deepEqual(again.map((r) => r.id), sorted.map((r) => r.id));
});

test('20. a null official rating is distinct from a recorded zero', () => {
  assert.equal(displayValue(null), UNAVAILABLE_LABEL);
  assert.equal(displayValue(undefined), UNAVAILABLE_LABEL);
  assert.equal(displayValue(0), '0');
  assert.equal(displayValue(false), 'No');
  assert.equal(displayValue(true), 'Yes');
  assert.equal(displayValue(''), UNAVAILABLE_LABEL);
  assert.notEqual(displayValue(0), displayValue(null));

  const markup = renderToStaticMarkup(
    h(RunnerList, {
      runners: [
        runner({ id: 'zero', horse_name: 'Zero Rated', official_rating: 0, draw: 0 }),
        runner({ id: 'null', horse_name: 'Unrated', official_rating: null, draw: null }),
      ],
      caption: 'Field',
    }),
  );
  assert.match(markup, />0</, 'a recorded zero renders as 0');
  assert.match(markup, new RegExp(UNAVAILABLE_LABEL), 'an absent value says so');
});

/* -------------------------------------------------------------------------- */
/* 21-22. Leakage                                                             */
/* -------------------------------------------------------------------------- */

test('21. provider identifiers are absent from the projections and the output', () => {
  // Structural: the selected column lists cannot fetch them.
  for (const columns of [NAVIGATION_RACE_COLUMNS, NAVIGATION_RUNNER_COLUMNS]) {
    for (const forbidden of ['provider_race_id', 'provider_course_id', 'provider_horse_id', 'trainer_id', 'jockey_id']) {
      assert.equal(columns.includes(forbidden), false, `${forbidden} must not be selected`);
    }
  }
  // Behavioural: even a polluted row cannot render one, because the components
  // read named fields rather than spreading the row.
  const polluted = {
    ...runner(),
    provider_horse_id: 'PROVIDER-HORSE-123',
    trainer_id: 'PROVIDER-TRAINER-9',
  } as unknown as NavigationRunnerRow;
  const markup = renderToStaticMarkup(h(RunnerList, { runners: [polluted], caption: 'Field' }));
  assert.doesNotMatch(markup, /PROVIDER-HORSE-123|PROVIDER-TRAINER-9/);

  const pollutedRace = {
    ...race(),
    provider_race_id: 'PROVIDER-RACE-777',
  } as unknown as NavigationRaceRow;
  const raceMarkup = renderToStaticMarkup(h(RaceSummaryRow, { race: pollutedRace, date: '2026-08-17' }));
  assert.doesNotMatch(raceMarkup, /PROVIDER-RACE-777/);

  // And no navigation file names a provider column at all.
  for (const file of NAVIGATION_FILES) {
    assert.doesNotMatch(code(file), /provider_race_id|provider_horse_id|provider_course_id/, file);
  }
});

test('22. no credential or environment value can reach a client prop', () => {
  for (const file of [...COMPONENTS, DATE_PAGE, MEETING_PAGE, RACE_PAGE]) {
    const fileCode = code(file);
    assert.doesNotMatch(fileCode, /process\.env/, file);
    assert.doesNotMatch(fileCode, /SERVICE_ROLE|CRON_SECRET|RACING_API|BETFAIR/i, file);
    assert.doesNotMatch(fileCode, /'use client'/, `${file} must stay a server component`);
    assert.doesNotMatch(fileCode, /dangerouslySetInnerHTML/, file);
  }
  // Only the read module touches the service-role client, and it is never
  // imported by a presentational component.
  for (const file of COMPONENTS) {
    assert.doesNotMatch(code(file), /supabaseAdmin/, file);
  }
  assert.match(code(READ_LIB), /import \{ supabaseAdmin \}/);
  // The pure helper module stays free of any client, env or I/O.
  const pure = code(PURE_LIB);
  for (const forbidden of [/supabaseAdmin/, /process\.env/, /\bfetch\s*\(/, /node:fs/, /require\(/]) {
    assert.doesNotMatch(pure, forbidden, String(forbidden));
  }
});

/* -------------------------------------------------------------------------- */
/* 23-27. Side-effect freedom (source-level, comment-stripped)                */
/* -------------------------------------------------------------------------- */

test('23-27. navigation performs NO write, provider, odds, model, lock or claim call', () => {
  const forbidden: [string, RegExp][] = [
    ['insert', /\.insert\s*\(/],
    ['update', /\.update\s*\(/],
    ['upsert', /\.upsert\s*\(/],
    ['delete', /\.delete\s*\(/],
    ['rpc', /\.rpc\s*\(/],
    ['storage write', /\.storage\b/],
    ['raw fetch', /\bfetch\s*\(/],
    ['cron route', /\/api\/cron/],
    ['run-model route', /\/api\/run-model/],
    ['provider host', /theracingapi|racingapi|betfair/i],
    ['model invocation', /runModelForRace|modelDayRun|scoreRaceRunners/],
    ['odds invocation', /syncOdds|captureOdds|fetchOdds/],
    ['racecard ingestion', /syncRacecards|racecardToRaceUpsert/],
    ['lock invocation', /try_acquire_model_lock|release_model_lock|withModelRunLock|lockTMinus/],
    ['result/settlement', /settleRace|syncResults|importResults/],
    ['producer claim', /producerClaim|try_acquire_producer_claim|acquireRacecards/],
  ];
  for (const file of NAVIGATION_FILES) {
    const fileCode = code(file);
    for (const [label, pattern] of forbidden) {
      assert.doesNotMatch(fileCode, pattern, `${file} must contain no ${label}`);
    }
  }

  // Positive control: the scans run on executable code, and the only database
  // verbs present anywhere in the navigation are `select`/`eq`/`from`.
  const readCode = code(READ_LIB);
  assert.match(readCode, /\.select\(/);
  const verbs = [...readCode.matchAll(/\.(\w+)\(/g)].map((m) => m[1]);
  const dbVerbs = verbs.filter((v) => ['from', 'select', 'eq', 'insert', 'update', 'upsert', 'delete', 'rpc'].includes(v));
  assert.deepEqual([...new Set(dbVerbs)].sort(), ['eq', 'from', 'select']);
});

test('23b. the scanners are non-vacuous (they see real code, not an empty slice)', () => {
  for (const file of NAVIGATION_FILES) {
    const fileCode = code(file);
    assert.ok(fileCode.trim().length > 200, `${file} produced no scannable code`);
    assert.match(fileCode, /export/, file);
  }
  // Comment stripping genuinely removes prose: the read module's docblock
  // mentions these words, and none survives into the scanned code.
  assert.match(src(READ_LIB), /insert, update, upsert, delete, rpc, storage write/);
  assert.doesNotMatch(code(READ_LIB), /insert, update, upsert, delete, rpc, storage write/);
});

/* -------------------------------------------------------------------------- */
/* 28-33. Presentation                                                        */
/* -------------------------------------------------------------------------- */

test('28. breadcrumb links are canonical, accessible, and end on the current page', () => {
  const markup = renderToStaticMarkup(
    h(Breadcrumbs, {
      items: [
        { label: 'Racing', href: '/' },
        { label: '17 August 2026', href: '/date/2026-08-17' },
        { label: 'Ascot', href: '/date/2026-08-17/meeting/ascot' },
        { label: '14:30 Example Stakes', href: null },
      ],
    }),
  );
  assert.match(markup, /aria-label="Breadcrumb"/);
  assert.match(markup, /<ol/);
  assert.match(markup, /href="\/date\/2026-08-17"/);
  assert.match(markup, /href="\/date\/2026-08-17\/meeting\/ascot"/);
  assert.match(markup, /aria-current="page"/);
  // The last crumb is text, not a link — no self-link keyboard trap.
  assert.doesNotMatch(markup, /<a[^>]*>14:30 Example Stakes/);
  // Separators are decorative only.
  assert.match(markup, /aria-hidden="true"/);
  assert.equal(renderToStaticMarkup(h(Breadcrumbs, { items: [] })), '');

  // Each page builds its trail from canonical href helpers.
  for (const page of [MEETING_PAGE, RACE_PAGE]) {
    assert.match(code(page), /canonicalDateHref\(date\)/, page);
  }
  assert.match(code(RACE_PAGE), /canonicalMeetingHref\(date, courseKey\)/);
});

test('29. adjacent-race links use stored slugs and skip handle-less neighbours', () => {
  const meeting = [
    race({ id: 'r1', off_time: '2026-08-17T13:00:00.000Z', race_slug: '1300-first' }),
    race({ id: 'r2', off_time: '2026-08-17T13:30:00.000Z', race_slug: '1330-second', race_name: 'Second' }),
    race({ id: 'r3', off_time: '2026-08-17T14:00:00.000Z', race_slug: '1400-third' }),
  ];
  const middle = findAdjacentRaces(meeting, 'r2');
  assert.equal(middle.previous?.href, '/date/2026-08-17/meeting/ascot/race/1300-first');
  assert.equal(middle.next?.href, '/date/2026-08-17/meeting/ascot/race/1400-third');
  assert.match(String(middle.previous?.label), /^14:00 |^\d{2}:\d{2} /);

  // Ends of the card have no neighbour on one side.
  assert.equal(findAdjacentRaces(meeting, 'r1').previous, null);
  assert.equal(findAdjacentRaces(meeting, 'r3').next, null);
  // A race not in the meeting yields neither.
  assert.deepEqual(findAdjacentRaces(meeting, 'absent'), { previous: null, next: null });

  // A neighbour without a stored slug is NOT linked and NOT invented.
  const withHistorical = [
    race({ id: 'h', off_time: '2026-08-17T12:00:00.000Z', race_slug: null, course_key: null }),
    race({ id: 'r1', off_time: '2026-08-17T13:00:00.000Z', race_slug: '1300-first' }),
  ];
  assert.equal(findAdjacentRaces(withHistorical, 'r1').previous, null);
});

test('30. an empty date is a normal empty state, never an error', async () => {
  const { seam } = stubSeam({ date: [] });
  const outcome = await loadRacesForDate('2026-08-17', seam);
  assert.deepEqual(outcome, { kind: 'ok', races: [] }, 'empty is ok, not a failure');

  const pageCode = code(DATE_PAGE);
  // The empty branch renders EmptyState; only a read failure renders ErrorState.
  assert.match(pageCode, /outcome\.races\.length === 0 \?[\s\S]{0,400}?EmptyState/);
  assert.match(pageCode, /outcome\.kind === 'read_failed' \?[\s\S]{0,200}?ErrorState/);
  // An empty date must NOT 404: notFound is reserved for an invalid date.
  const notFoundCalls = pageCode.match(/notFound\(\)/g) ?? [];
  assert.equal(notFoundCalls.length, 1, 'the date page 404s only on an invalid date');
  assert.match(pageCode, /if \(date === null\) notFound\(\);/);
});

test('31. metadata is factual, stable and derived from stored data only', () => {
  assert.equal(datePageTitle('2026-08-17'), 'Racing on 17 August 2026');
  assert.equal(meetingPageTitle('Ascot', '2026-08-17'), 'Ascot, 17 August 2026');
  assert.equal(racePageTitle(race(), 'Ascot'), '14:30 Example Stakes, Ascot');
  // Stable: repeated calls agree (no clock, no randomness).
  assert.equal(datePageTitle('2026-08-17'), datePageTitle('2026-08-17'));
  // An invalid date yields no title to render.
  assert.equal(datePageTitle('2026-02-30'), null);
  assert.equal(meetingPageTitle('Ascot', 'nonsense'), null);
  // Absent fields degrade cleanly rather than fabricating.
  assert.equal(racePageTitle({ off_time: null, race_name: null }, 'Ascot'), 'Race, Ascot');

  for (const page of [DATE_PAGE, MEETING_PAGE, RACE_PAGE]) {
    const pageCode = code(page);
    assert.match(pageCode, /export async function generateMetadata/, page);
    // No betting language, no live claim, no model claim, no provider id.
    assert.doesNotMatch(pageCode, /guaranteed|sure thing|best bet|tip of the day/i, page);
    // Ban the affirmative CLAIM, not the word: these pages legitimately say
    // "No live status is implied", which is the opposite of a live claim.
    assert.doesNotMatch(pageCode, /live (odds|prices|data|results|market)/i, page);
    assert.doesNotMatch(pageCode, /updated live|updating live|real[- ]time/i, page);
  }
});

test('32. recency wording is truthful — no fabricated "last updated"', () => {
  // `races` has no verified capture timestamp in this repository, so no page
  // may claim one. Status counts come from the stored `status` column.
  const rows = [
    race({ id: 'a', status: 'scheduled' }),
    race({ id: 'b', status: 'scheduled' }),
    race({ id: 'c', status: 'result' }),
    race({ id: 'd', is_abandoned: true }),
    race({ id: 'e', status: null, is_abandoned: null }),
  ];
  assert.deepEqual(summariseStoredStatuses(rows), [
    { label: 'Scheduled', count: 2 },
    { label: 'Abandoned', count: 1 },
    { label: UNAVAILABLE_LABEL, count: 1 },
    { label: 'Result recorded', count: 1 },
  ]);

  for (const page of [DATE_PAGE, MEETING_PAGE]) {
    const pageCode = code(page);
    assert.match(pageCode, /No live status is implied/, page);
    assert.match(pageCode, /no capture timestamp is recorded for racecards/, page);
    // The dishonest phrasings the brief rules out.
    assert.doesNotMatch(pageCode, /last updated/i, page);
    assert.doesNotMatch(pageCode, /updated_at|captured_at|generated_at|created_at/, page);
  }
  // No navigation query selects an unverified timestamp column.
  assert.doesNotMatch(NAVIGATION_RACE_COLUMNS, /created_at|updated_at|captured_at/);

  // The race page states plainly that no market or model data is loaded.
  assert.match(code(RACE_PAGE), /Odds and model output are not loaded here/);
});

test('33. the runner table scrolls inside its own container, not the page', () => {
  const markup = renderToStaticMarkup(
    h(RunnerList, { runners: [runner(), runner({ id: 'b', horse_name: 'Second' })], caption: 'Field' }),
  );
  assert.match(markup, /class="rb-scroll-x"/, 'the wide table opts into its own scroll container');
  assert.match(markup, /<table class="rb-table"/);
  // Semantic table structure: caption, column headers, row headers.
  assert.match(markup, /<caption/);
  assert.match(markup, /scope="col"/);
  assert.match(markup, /scope="row"/);
  // No inline fixed pixel width could force the page to overflow.
  assert.doesNotMatch(markup, /style="[^"]*width:\s*\d+px/);

  const tokens = readFileSync('src/styles/tokens.css', 'utf8');
  assert.match(tokens, /\.rb-scroll-x \{[^}]*overflow-x: auto/);
  // The meeting grid is mobile-first: one column until a min-width query.
  assert.match(tokens, /\.rb-meeting-grid \{[^}]*grid-template-columns: 1fr/);
  assert.match(tokens, /@media \(min-width: 40rem\) \{\s*\.rb-meeting-grid/);
  // Focus outlines are never removed by the added rules.
  assert.doesNotMatch(tokens, /outline:\s*(none|0)\b/);

  const empty = renderToStaticMarkup(h(RunnerList, { runners: [], caption: 'Field' }));
  assert.match(empty, /No runners are stored/);
});

test('33b. status is never communicated by colour alone', () => {
  const markup = renderToStaticMarkup(h(RaceSummaryRow, { race: race({ is_abandoned: true }), date: '2026-08-17' }));
  assert.match(markup, /Abandoned/, 'the status is stated in text');
  assert.match(markup, /rb-badge__glyph/, 'and carries a non-colour glyph');

  assert.deepEqual(describeRaceStatus({ status: 'result', is_abandoned: false }), {
    label: 'Result recorded',
    tone: 'official',
  });
  assert.deepEqual(describeRaceStatus({ status: 'scheduled', is_abandoned: true }), {
    label: 'Abandoned',
    tone: 'warning',
  }, 'abandonment outranks the raw status');
  assert.deepEqual(describeRaceStatus({ status: null, is_abandoned: null }), {
    label: UNAVAILABLE_LABEL,
    tone: 'neutral',
  });
  // An unrecognised stored status is shown verbatim, never guessed at.
  assert.equal(describeRaceStatus({ status: 'delayed', is_abandoned: null }).label, 'delayed');
});

/* -------------------------------------------------------------------------- */
/* 34-35. Formatting, read failure and behaviour freeze                       */
/* -------------------------------------------------------------------------- */

test('34. times format in the racing timezone, independent of the host clock', () => {
  assert.equal(RACING_TIME_ZONE, 'Europe/London');
  // 13:30 UTC in August is 14:30 British Summer Time — a server in UTC must
  // still render the card time a punter would recognise.
  assert.equal(formatOffTime('2026-08-17T13:30:00.000Z'), '14:30');
  // In January the offset is zero.
  assert.equal(formatOffTime('2026-01-17T13:30:00.000Z'), '13:30');
  assert.equal(formatOffTime(null), null);
  assert.equal(formatOffTime('not-a-date'), null);
  assert.equal(formatMeetingDate('2026-08-17'), '17 August 2026');
  assert.equal(formatMeetingDate('2026-02-30'), null);

  assert.equal(displayDistance({ distance: '1m 2f', distance_f: 10 }), '1m 2f');
  assert.equal(displayDistance({ distance: null, distance_f: 10 }), '10f');
  assert.equal(displayDistance({ distance: null, distance_f: null }), UNAVAILABLE_LABEL);
  assert.equal(displayDistance({ distance: '  ', distance_f: 6 }), '6f');
});

test('34b. a read failure is a safe typed outcome carrying no database text', async () => {
  const { seam } = stubSeam({ fail: true });
  assert.deepEqual(await loadRacesForDate('2026-08-17', seam), { kind: 'read_failed' });
  assert.deepEqual(await loadMeeting('2026-08-17', 'ascot', seam), { kind: 'read_failed' });
  assert.deepEqual(
    await resolveCanonicalRace('2026-08-17', 'ascot', '1330-example-stakes', seam),
    { kind: 'read_failed' },
  );
  assert.deepEqual(await loadRunnersForRace('race-uuid', seam), { kind: 'read_failed' });

  // The outcome types cannot carry a message, and the live seam never logs one.
  const readCode = code(READ_LIB);
  assert.doesNotMatch(readCode, /error\.message|error\.details|error\.hint/);
  assert.match(readCode, /return \{ ok: false, rows: null \}/);
});

test('35. ingestion, identity, timing, locks and settlement are untouched', () => {
  // This tranche adds files; it changes no producer module. If navigation ever
  // imported one of these, page rendering could acquire a side effect.
  const producerModules = [
    'liveSync',
    'raceSync',
    'runModelForRace',
    'offTimeObservation',
    'lockTMinus',
    'racecardsCommitRunner',
    'racecardsDryRun',
    'producerOwnership',
    'ownershipContext',
    'autoResults',
    'todayResultsSettlement',
  ];
  for (const file of NAVIGATION_FILES) {
    const fileCode = code(file);
    for (const mod of producerModules) {
      assert.doesNotMatch(
        fileCode,
        new RegExp(`from '[^']*${mod}'`),
        `${file} must not import ${mod}`,
      );
    }
  }
  // The navigation reads exactly two tables, both read-only.
  const readCode = code(READ_LIB);
  const tables = [...readCode.matchAll(/\.from\('(\w+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)].sort(), ['races', 'runners']);
});

/* ========== M-1: historical meetings never merge across courses =========== */

/** A pre-Programme-0 row: no stored handles, only a display label. */
function historical(course: string | null, over: Partial<NavigationRaceRow> = {}): NavigationRaceRow {
  return race({ course, course_key: null, race_slug: null, ...over });
}

test('M-1a. two historical rows for the SAME course group together', () => {
  const meetings = groupRacesByMeeting([
    historical('Ascot', { id: 'a1', off_time: '2026-06-16T13:00:00.000Z' }),
    historical('Ascot', { id: 'a2', off_time: '2026-06-16T14:00:00.000Z' }),
  ]);
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0].courseLabel, 'Ascot');
  assert.equal(meetings[0].raceCount, 2);
  assert.equal(meetings[0].courseKey, null);
});

test('M-1b. two historical rows for Ayr group together, separately from Ascot', () => {
  const meetings = groupRacesByMeeting([
    historical('Ayr', { id: 'y1', off_time: '2026-06-16T13:15:00.000Z' }),
    historical('Ayr', { id: 'y2', off_time: '2026-06-16T14:15:00.000Z' }),
  ]);
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0].courseLabel, 'Ayr');
  assert.equal(meetings[0].raceCount, 2);
});

test('M-1c. REGRESSION: Ascot and Ayr are two meetings, never one merged card', () => {
  // The defect: every handle-less row shared ONE bucket, so a historical date
  // rendered a single card carrying one course name, a combined race count and
  // a combined first-to-last window — a meeting that never existed.
  const meetings = groupRacesByMeeting([
    historical('Ascot', { id: 'a1', off_time: '2026-06-16T13:00:00.000Z' }),
    historical('Ayr', { id: 'y1', off_time: '2026-06-16T13:15:00.000Z' }),
    historical('Ascot', { id: 'a2', off_time: '2026-06-16T14:00:00.000Z' }),
    historical('Ayr', { id: 'y2', off_time: '2026-06-16T16:30:00.000Z' }),
  ]);

  assert.equal(meetings.length, 2, 'two stored courses must remain two meetings');
  const ascot = meetings.find((m) => m.courseLabel === 'Ascot');
  const ayr = meetings.find((m) => m.courseLabel === 'Ayr');
  assert.ok(ascot && ayr);

  // Counts are course-local, not combined.
  assert.equal(ascot.raceCount, 2);
  assert.equal(ayr.raceCount, 2);

  // Windows are course-local: Ascot must NOT borrow Ayr's 16:30 close.
  assert.equal(ascot.firstOffTime, '2026-06-16T13:00:00.000Z');
  assert.equal(ascot.lastOffTime, '2026-06-16T14:00:00.000Z');
  assert.equal(ayr.firstOffTime, '2026-06-16T13:15:00.000Z');
  assert.equal(ayr.lastOffTime, '2026-06-16T16:30:00.000Z');

  // Each group contains only its own course's rows.
  assert.deepEqual(ascot.races.map((r) => r.id), ['a1', 'a2']);
  assert.deepEqual(ayr.races.map((r) => r.id), ['y1', 'y2']);

  // Still unlinkable, both of them.
  for (const m of meetings) {
    assert.equal(m.courseKey, null);
    assert.equal(m.linkableRaceCount, 0);
    assert.equal(canonicalMeetingHref('2026-06-16', m.courseKey), null);
  }
});

test('M-1d. three historical courses produce three separate groups', () => {
  const meetings = groupRacesByMeeting([
    historical('Ascot', { id: 'a', off_time: '2026-06-16T13:00:00.000Z' }),
    historical('Ayr', { id: 'y', off_time: '2026-06-16T13:30:00.000Z' }),
    historical('Newmarket', { id: 'n', off_time: '2026-06-16T14:00:00.000Z' }),
  ]);
  assert.equal(meetings.length, 3);
  assert.deepEqual(
    meetings.map((m) => m.courseLabel),
    ['Ascot', 'Ayr', 'Newmarket'],
    'ordered by first off time — deterministic',
  );
  for (const m of meetings) {
    assert.equal(m.raceCount, 1);
    assert.equal(m.courseKey, null);
  }
});

test('M-1e. the internal grouping discriminator never reaches rendered markup', () => {
  const meetings = groupRacesByMeeting([
    historical('Ascot', { id: 'a' }),
    historical('Ayr', { id: 'y' }),
    historical(null, { id: 'blank' }),
  ]);
  for (const meeting of meetings) {
    const markup = renderToStaticMarkup(h(MeetingSummaryCard, { meeting, date: '2026-06-16' }));
    // No sentinel, no prefix, no separator artefact, no NUL byte.
    assert.doesNotMatch(markup, /historical:/i, 'the Map-key prefix must never render');
    assert.equal(markup.includes(String.fromCharCode(0)), false, 'no NUL byte may reach output');
    assert.doesNotMatch(markup, /<a /, 'a handle-less meeting renders no anchor');
    // And it never becomes a URL.
    assert.equal(canonicalMeetingHref('2026-06-16', meeting.courseKey), null);
  }
  // The prefix is not a valid handle, so it can never collide with a real key.
  assert.equal(isCanonicalHandle(' historical:Ascot'), false);
  assert.equal(isCanonicalHandle('historical:Ascot'), false);
});

test('M-1f. blank and null course labels share ONE neutral unlinked group', () => {
  const meetings = groupRacesByMeeting([
    historical(null, { id: 'n1', off_time: '2026-06-16T13:00:00.000Z' }),
    historical('', { id: 'n2', off_time: '2026-06-16T13:30:00.000Z' }),
    historical('   ', { id: 'n3', off_time: '2026-06-16T14:00:00.000Z' }),
  ]);
  assert.equal(meetings.length, 1, 'blank labels must not fragment into empty cards');
  assert.equal(meetings[0].courseLabel, UNKNOWN_COURSE_LABEL);
  assert.equal(meetings[0].raceCount, 3);
  assert.equal(meetings[0].courseKey, null);
  assert.equal(meetings[0].linkableRaceCount, 0);

  const markup = renderToStaticMarkup(
    h(MeetingSummaryCard, { meeting: meetings[0], date: '2026-06-16' }),
  );
  assert.match(markup, new RegExp(UNKNOWN_COURSE_LABEL));
  assert.doesNotMatch(markup, /<a /);
});

test('M-1g. a canonical group and a same-named historical group never collide', () => {
  const meetings = groupRacesByMeeting([
    // Canonical: has a stored handle, so it is identity and it links.
    race({ id: 'canon', course: 'Ascot', course_key: 'ascot', off_time: '2026-06-16T13:00:00.000Z' }),
    // Historical: label happens to match, but the row stored NO handle.
    historical('Ascot', { id: 'hist', off_time: '2026-06-16T13:30:00.000Z' }),
    // Historical whose label even resembles a canonical handle.
    historical('ascot', { id: 'lookalike', off_time: '2026-06-16T14:00:00.000Z' }),
  ]);
  assert.equal(meetings.length, 3, 'canonical identity never merges with a label');

  const canon = meetings.filter((m) => m.courseKey !== null);
  assert.equal(canon.length, 1);
  assert.equal(canon[0].courseKey, 'ascot');
  assert.equal(canon[0].raceCount, 1, 'the historical rows must not inflate it');
  assert.equal(
    canonicalMeetingHref('2026-06-16', canon[0].courseKey),
    '/date/2026-06-16/meeting/ascot',
  );

  // A handle-lookalike LABEL still yields no link, because the row stored none.
  for (const m of meetings.filter((x) => x.courseKey === null)) {
    assert.equal(canonicalMeetingHref('2026-06-16', m.courseKey), null);
    assert.equal(m.linkableRaceCount, 0);
  }
});

test('M-1h. canonical grouping and links are unchanged by the correction', () => {
  const meetings = groupRacesByMeeting([
    race({ id: 'a', course_key: 'ascot', course: 'Ascot', off_time: '2026-08-17T14:00:00.000Z' }),
    race({ id: 'b', course_key: 'ascot', course: 'Royal Ascot', off_time: '2026-08-17T13:00:00.000Z' }),
    race({ id: 'c', course_key: 'ayr', course: 'Ayr', off_time: '2026-08-17T13:30:00.000Z' }),
  ]);
  assert.deepEqual(meetings.map((m) => m.courseKey), ['ascot', 'ayr']);
  const ascot = meetings[0];
  assert.equal(ascot.raceCount, 2, 'two spellings of one stored key stay one meeting');
  assert.equal(ascot.firstOffTime, '2026-08-17T13:00:00.000Z');
  assert.equal(ascot.lastOffTime, '2026-08-17T14:00:00.000Z');
  assert.equal(ascot.linkableRaceCount, 2);

  const markup = renderToStaticMarkup(h(MeetingSummaryCard, { meeting: ascot, date: '2026-08-17' }));
  assert.match(markup, /href="\/date\/2026-08-17\/meeting\/ascot"/);
});

test('M-1i. no handle is generated for a historical row', () => {
  const meetings = groupRacesByMeeting([historical('Great Yarmouth', { id: 'g' })]);
  const [meeting] = meetings;
  assert.equal(meeting.courseKey, null);
  // The label is used VERBATIM — never slugified into a handle-looking value.
  assert.equal(meeting.courseLabel, 'Great Yarmouth');
  assert.doesNotMatch(meeting.courseLabel, /^[a-z0-9-]+$/, 'no slugification occurred');
  assert.equal(canonicalRaceHref('2026-06-16', null, null), null);

  // The rows themselves are untouched: still null handles, nothing written back.
  for (const r of meeting.races) {
    assert.equal(r.course_key, null);
    assert.equal(r.race_slug, null);
  }

  // And the module still imports no handle builder (guarded again here so the
  // fix cannot have quietly reached for one).
  const pure = code(PURE_LIB);
  assert.doesNotMatch(pure, /\braceSlug\s*\(/);
  assert.doesNotMatch(pure, /from '[^']*raceSync'/);
  assert.doesNotMatch(pure, /normalizeCourse/);
});

/* ============ L-2: transitive import-closure safety guard ================= */

/**
 * Resolves a local import specifier to a file path, or null for a package.
 * Mirrors the tsconfig `@/*` -> `src/*` alias plus relative resolution.
 */
function resolveLocalImport(spec: string, fromFile: string, externals: Set<string>): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = nodePath.join('src', spec.slice(2));
  else if (spec.startsWith('.')) base = nodePath.join(nodePath.dirname(fromFile), spec);
  else {
    externals.add(spec);
    return null;
  }
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx', '']) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate.split(nodePath.sep).join('/');
    }
  }
  return null;
}

/** Every local module reachable from `roots`, plus the packages they import. */
function importClosure(roots: readonly string[]): {
  modules: string[];
  externals: string[];
} {
  const visited = new Set<string>();
  const externals = new Set<string>();
  const walk = (file: string): void => {
    if (visited.has(file)) return; // visited set breaks cycles
    visited.add(file);
    // COMMENT-STRIPPED: prose such as `derived from "today"` would otherwise be
    // recorded as an external import, and a commented-out import would be
    // followed. Only real specifiers count.
    const text = code(file);
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const resolved = resolveLocalImport(match[1], file, externals);
      if (resolved !== null) walk(resolved);
    }
  };
  for (const root of roots) walk(root);
  return { modules: [...visited].sort(), externals: [...externals].sort() };
}

const ROUTE_ROOTS = [DATE_PAGE, MEETING_PAGE, RACE_PAGE] as const;

test('L-2a. the import closure is complete, non-empty and not truncated', () => {
  const { modules, externals } = importClosure(ROUTE_ROOTS);

  // Non-vacuous: the walker actually reached past the roots.
  assert.ok(modules.length >= 10, `closure too small to be real: ${modules.length}`);
  for (const root of ROUTE_ROOTS) assert.ok(modules.includes(root), `missing root ${root}`);

  // If any of these were absent the graph would be truncated and every scan
  // below would pass vacuously. They are the modules that MUST be reachable.
  for (const required of [
    PURE_LIB,
    READ_LIB,
    'src/lib/supabaseAdmin.ts',
    'src/components/AppShell.tsx',
    'src/components/AppNavigation.tsx',
    'src/components/navDestinations.ts',
    'src/components/UiPrimitives.tsx',
    ...COMPONENTS,
  ]) {
    assert.ok(modules.includes(required), `closure is truncated: ${required} not reached`);
  }

  // Packages are recorded, then ignored. Only these may appear.
  assert.deepEqual(externals, [
    '@supabase/supabase-js',
    'next',
    'next/link',
    'next/navigation',
    'react',
  ]);
});

test('L-2b. NO module reachable from a route can reach a producer or write path', () => {
  const { modules } = importClosure(ROUTE_ROOTS);

  // Producer / mapper / identity modules that must be unreachable entirely.
  const forbiddenImports = [
    'raceSync',
    'liveSync',
    'raceData',
    'racingApi',
    'betfair',
    'racecardsCommitRunner',
    'racecardsDryRun',
    'runModelForRace',
    'modelDayRun',
    'bettingEngine',
    'offTimeObservation',
    'lockTMinus',
    'modelRunLock',
    'autoResults',
    'todayResultsSettlement',
    'producerClaim',
    'producerOwnership',
    'ownershipContext',
    'ownershipPropagation',
  ];

  // Executable calls that must not appear on ANY reachable path.
  const forbiddenCalls: [string, RegExp][] = [
    ['insert', /\.insert\s*\(/],
    ['update', /\.update\s*\(/],
    ['upsert', /\.upsert\s*\(/],
    ['delete', /\.delete\s*\(/],
    ['rpc', /\.rpc\s*\(/],
    ['fetch', /\bfetch\s*\(/],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/],
    ['WebSocket', /\bWebSocket\b/],
    ['storage write', /\.storage\b/],
    ['cron/api route', /['"`]\/api\//],
    ['slug generation', /\braceSlug\s*\(|\bcourseKey\s*\(\s*['"]|normalizeCourse\s*\(/],
  ];

  for (const file of modules) {
    const executable = code(file);
    for (const mod of forbiddenImports) {
      assert.doesNotMatch(
        executable,
        new RegExp(`from ['"][^'"]*${mod}['"]`),
        `${file} (reachable from a route) must not import ${mod}`,
      );
    }
    for (const [label, pattern] of forbiddenCalls) {
      assert.doesNotMatch(executable, pattern, `${file} (reachable from a route) contains ${label}`);
    }
  }

  // Non-vacuous: the scanned text is real executable code, and the ONE allowed
  // database access is still present in the read layer.
  for (const file of modules) {
    assert.ok(code(file).trim().length > 100, `${file} produced no scannable code`);
  }
  assert.match(code(READ_LIB), /\.from\('races'\)[\s\S]{0,80}\.select\(/);
});

test('L-2c. the service-role client stays on the server side of the closure', () => {
  const { modules } = importClosure(ROUTE_ROOTS);
  const ADMIN = 'src/lib/supabaseAdmin.ts';

  // Exactly one module may read the environment: the client factory itself.
  const envReaders = modules.filter((f) => /process\.env/.test(code(f)));
  assert.deepEqual(envReaders, [ADMIN], 'only supabaseAdmin may touch process.env');

  // Exactly one module may import it, and it must not re-export it.
  const importers = modules.filter(
    (f) => f !== ADMIN && /from ['"][^'"]*supabaseAdmin['"]/.test(code(f)),
  );
  assert.deepEqual(importers, [READ_LIB]);
  assert.doesNotMatch(code(READ_LIB), /export\s+\{[^}]*supabaseAdmin/);
  assert.doesNotMatch(code(READ_LIB), /export\s+.*\bsupabaseAdmin\b\s*[;=]/);

  // No CLIENT component may reach the service-role client. Walk the closure of
  // every 'use client' module in the graph and prove supabaseAdmin is absent.
  const clientEntries = modules.filter((f) => /['"]use client['"]/.test(code(f)));
  assert.ok(clientEntries.length > 0, 'expected at least one client component in the closure');
  const clientClosure = importClosure(clientEntries).modules;
  assert.equal(
    clientClosure.includes(ADMIN),
    false,
    'a client component can reach the service-role client',
  );
  for (const file of clientClosure) {
    assert.doesNotMatch(code(file), /process\.env/, `${file} is client-reachable and reads env`);
  }
});
