/**
 * Racing search, date and scope controls.
 *
 * The pure contract is exercised directly, the read layer through an injected
 * fixture seam, the route handler by calling it with a synthetic `Request`, and
 * the UI through real `renderToStaticMarkup` output. Source contracts are
 * asserted on COMMENT-STRIPPED code so no scanner can be satisfied by prose.
 *
 * This file opens no database, calls no provider, starts no server, runs no
 * model, captures no odds, creates no lock, settles no result and acquires no
 * producer claim. Every network path is a fixture.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  DEFAULT_SEARCH_SCOPE,
  MATCH_TIER,
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_MIN_QUERY_LENGTH,
  SEARCH_PROBE_LIMIT,
  SEARCH_RACE_COLUMNS,
  SEARCH_RESULT_LIMIT,
  SEARCH_SCOPES,
  AMBIGUOUS_RACE_LABEL,
  buildContainsPattern,
  buildMeetingResults,
  buildRaceResults,
  buildSearchResults,
  escapeLikePattern,
  matchTier,
  normaliseSearchQuery,
  parseSearchScope,
  queryAsMeetingDate,
  type SearchRaceRow,
  type SearchResult,
} from '../src/lib/racingSearchContract';
import {
  SEARCH_MATCH_COLUMNS,
  SEARCH_TABLE,
  searchRacingRows,
  type RacingSearchReadSeam,
} from '../src/lib/racingSearchRead';
import SearchResultsList, {
  isLocalResultHref,
} from '../src/components/racing/SearchResultsList';
import { RacingControls, resolveDateHref } from '../src/components/RacingControls';

/* -------------------------------------------------------------------------- */
/* Sources + fixtures                                                         */
/* -------------------------------------------------------------------------- */

const CONTRACT = 'src/lib/racingSearchContract.ts';
const READ = 'src/lib/racingSearchRead.ts';
const ROUTE = 'src/app/api/search/racing/route.ts';
const CONTROLS = 'src/components/RacingControls.tsx';
const RESULTS = 'src/components/racing/SearchResultsList.tsx';
const SEARCH_FILES = [CONTRACT, READ, ROUTE, CONTROLS, RESULTS];

const src = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const code = (p: string): string =>
  src(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

function row(over: Partial<SearchRaceRow> = {}): SearchRaceRow {
  return {
    meeting_date: '2026-08-17',
    course: 'Catterick',
    course_key: 'catterick',
    race_slug: '1315-example-handicap',
    race_name: 'Example Handicap',
    off_time: '2026-08-17T12:15:00.000Z',
    ...over,
  };
}

/** A seam that records every call and returns fixtures. Never touches a DB. */
function stubSeam(config: {
  byColumn?: Partial<Record<(typeof SEARCH_MATCH_COLUMNS)[number], SearchRaceRow[]>>;
  byDate?: SearchRaceRow[];
  failColumns?: (typeof SEARCH_MATCH_COLUMNS)[number][];
  failDate?: boolean;
}): { seam: RacingSearchReadSeam; calls: string[] } {
  const calls: string[] = [];
  const seam: RacingSearchReadSeam = {
    async matchColumn(column, pattern) {
      calls.push(`matchColumn(${column},${pattern})`);
      if (config.failColumns?.includes(column)) return { ok: false, rows: null };
      return { ok: true, rows: config.byColumn?.[column] ?? [] };
    },
    async matchMeetingDate(date) {
      calls.push(`matchMeetingDate(${date})`);
      if (config.failDate === true) return { ok: false, rows: null };
      return { ok: true, rows: config.byDate ?? [] };
    },
  };
  return { seam, calls };
}

/* -------------------------------------------------------------------------- */
/* 1-4. Query validation                                                      */
/* -------------------------------------------------------------------------- */

test('1-2. query length bounds are enforced at both ends', () => {
  assert.equal(SEARCH_MIN_QUERY_LENGTH, 2);
  assert.equal(SEARCH_MAX_QUERY_LENGTH, 64);

  assert.deepEqual(normaliseSearchQuery('a'), { ok: false, reason: 'too_short' });
  assert.deepEqual(normaliseSearchQuery('as'), { ok: true, query: 'as' });
  const atLimit = 'x'.repeat(SEARCH_MAX_QUERY_LENGTH);
  assert.deepEqual(normaliseSearchQuery(atLimit), { ok: true, query: atLimit });
  assert.deepEqual(normaliseSearchQuery('x'.repeat(SEARCH_MAX_QUERY_LENGTH + 1)), {
    ok: false,
    reason: 'too_long',
  });
});

test('3. surrounding whitespace is trimmed, and length is measured after', () => {
  assert.deepEqual(normaliseSearchQuery('  Ascot  '), { ok: true, query: 'Ascot' });
  assert.deepEqual(normaliseSearchQuery('\tAscot\n'), { ok: true, query: 'Ascot' });
  // " a " is one character once trimmed, so it cannot pass the minimum.
  assert.deepEqual(normaliseSearchQuery('  a  '), { ok: false, reason: 'too_short' });
  assert.deepEqual(normaliseSearchQuery('   '), { ok: false, reason: 'missing' });
  assert.deepEqual(normaliseSearchQuery(''), { ok: false, reason: 'missing' });
  assert.deepEqual(normaliseSearchQuery(null), { ok: false, reason: 'missing' });
  assert.deepEqual(normaliseSearchQuery(undefined), { ok: false, reason: 'missing' });
  // Interior spacing is preserved: it is part of what was typed.
  assert.deepEqual(normaliseSearchQuery(' great yarmouth '), { ok: true, query: 'great yarmouth' });
});

test('4. control characters are refused, not stripped', () => {
  for (const codePoint of [0, 1, 9, 10, 13, 27, 31, 127, 155]) {
    const value = `As${String.fromCharCode(codePoint)}cot`;
    const result = normaliseSearchQuery(value);
    // A tab/newline at the EDGE is trimmed; anywhere inside it is refused.
    if ([9, 10, 13].includes(codePoint)) {
      assert.equal(result.ok, false, `interior whitespace control ${codePoint}`);
    } else {
      assert.deepEqual(result, { ok: false, reason: 'invalid_characters' }, String(codePoint));
    }
  }
  // The source contains no literal control character of its own.
  assert.equal(src(CONTRACT).includes(String.fromCharCode(0)), false);
});

/* -------------------------------------------------------------------------- */
/* 5-6. Scope                                                                 */
/* -------------------------------------------------------------------------- */

test('5-6. scope is a closed set: valid values pass, anything else is refused', () => {
  assert.deepEqual([...SEARCH_SCOPES], ['all', 'meetings', 'races']);
  assert.equal(DEFAULT_SEARCH_SCOPE, 'all');

  for (const scope of SEARCH_SCOPES) {
    assert.deepEqual(parseSearchScope(scope), { ok: true, scope });
  }
  // Absent means the default — never a refusal.
  assert.deepEqual(parseSearchScope(null), { ok: true, scope: 'all' });
  assert.deepEqual(parseSearchScope(undefined), { ok: true, scope: 'all' });
  assert.deepEqual(parseSearchScope(''), { ok: true, scope: 'all' });

  // Present but unrecognised is REFUSED, never coerced to the default.
  for (const bad of ['ALL', 'Meetings', 'runners', 'races;drop', '*', 'all,races', ' all']) {
    assert.deepEqual(parseSearchScope(bad), { ok: false, reason: 'unsupported_scope' }, bad);
  }
});

/* -------------------------------------------------------------------------- */
/* 7-10. Bounds and injection defences                                        */
/* -------------------------------------------------------------------------- */

test('7-8. result and probe limits are server constants a caller cannot raise', () => {
  assert.equal(SEARCH_RESULT_LIMIT, 20);
  assert.equal(SEARCH_PROBE_LIMIT, 40);

  // Nothing reads a caller-supplied limit anywhere in the search path.
  for (const file of SEARCH_FILES) {
    const executable = code(file);
    assert.doesNotMatch(executable, /searchParams\.get\(['"](limit|count|max|per_page)['"]\)/, file);
  }
  assert.match(code(READ), /\.limit\(SEARCH_PROBE_LIMIT\)/);
  assert.equal((code(READ).match(/\.limit\(/g) ?? []).length, 2, 'every probe is bounded');

  // The cap is applied to the assembled list.
  const many = Array.from({ length: 60 }, (_, i) =>
    row({ race_slug: `13${String(i).padStart(2, '0')}-race`, race_name: `Example ${i}` }),
  );
  const built = buildSearchResults({ rows: many, query: 'Example', scope: 'races' });
  assert.equal(built.results.length, SEARCH_RESULT_LIMIT);
  assert.equal(built.truncated, true);
});

test('9. LIKE wildcards in user input are escaped and matched literally', () => {
  assert.equal(escapeLikePattern('%'), '\\%');
  assert.equal(escapeLikePattern('_'), '\\_');
  assert.equal(escapeLikePattern('\\'), '\\\\');
  assert.equal(escapeLikePattern('100%_sure'), '100\\%\\_sure');
  assert.equal(escapeLikePattern('Ascot'), 'Ascot');

  // A bare wildcard cannot become "match everything".
  assert.equal(buildContainsPattern('%'), '%\\%%');
  assert.equal(buildContainsPattern('Ascot'), '%Ascot%');
});

test('10. PostgREST filter-injection strings cannot alter query structure', () => {
  // These are the shapes that break a `.or()` string filter. They are carried
  // as a discrete ilike VALUE here, and the column/operator are fixed in code.
  const attacks = [
    'a,course_key.eq.x',
    'a)&or=(id.gt.0',
    'a.eq.1',
    '*',
    'a%2Cb',
    "a'||'b",
    'a);select',
  ];
  for (const attack of attacks) {
    const validated = normaliseSearchQuery(attack);
    if (!validated.ok) continue;
    const pattern = buildContainsPattern(validated.query);
    // The pattern is a value only: it never names a column or an operator.
    assert.ok(pattern.startsWith('%') && pattern.endsWith('%'), attack);
    assert.equal(pattern.includes(validated.query.replace(/([\\%_])/g, '\\$1')), true, attack);
  }

  // Structurally: no `.or(` anywhere, and every filter names a literal column.
  const readCode = code(READ);
  assert.doesNotMatch(readCode, /\.or\s*\(/, 'or() filters are string-interpolated and injectable');
  assert.doesNotMatch(readCode, /\.filter\s*\(/);
  assert.doesNotMatch(readCode, /\.textSearch\s*\(/);
  assert.match(readCode, /\.ilike\(column, pattern\)/);
  assert.match(readCode, /\.eq\('meeting_date', date\)/);
  // The column set is a closed literal list.
  assert.deepEqual(
    [...SEARCH_MATCH_COLUMNS],
    ['course', 'course_key', 'race_name', 'race_slug'],
  );
});

/* -------------------------------------------------------------------------- */
/* 11-12. Privacy                                                             */
/* -------------------------------------------------------------------------- */

test('11-12. no provider id and no internal uuid can reach a response', () => {
  for (const forbidden of [
    'id',
    'provider_race_id',
    'provider_course_id',
    'provider_horse_id',
    'trainer_id',
    'jockey_id',
  ]) {
    const columns = SEARCH_RACE_COLUMNS.split(',').map((c) => c.trim());
    assert.equal(columns.includes(forbidden), false, `${forbidden} must not be selected`);
  }
  assert.deepEqual(SEARCH_RACE_COLUMNS.split(',').map((c) => c.trim()), [
    'meeting_date',
    'course',
    'course_key',
    'race_slug',
    'race_name',
    'off_time',
  ]);

  // Even a polluted row cannot leak: results are built from named fields.
  const polluted = {
    ...row(),
    id: '11111111-1111-4111-8111-111111111111',
    provider_race_id: 'PROVIDER-RACE-9',
  } as unknown as SearchRaceRow;
  const built = buildSearchResults({ rows: [polluted], query: 'Catterick', scope: 'all' });
  const json = JSON.stringify(built);
  assert.doesNotMatch(json, /PROVIDER-RACE-9/);
  assert.doesNotMatch(json, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

  // And no search file names a provider column at all.
  for (const file of SEARCH_FILES) {
    assert.doesNotMatch(code(file), /provider_race_id|provider_horse_id|provider_course_id/, file);
  }
});

/* -------------------------------------------------------------------------- */
/* 13-18. Meetings, races, historical rows, duplicates                        */
/* -------------------------------------------------------------------------- */

test('13. meetings deduplicate by stored date + course_key, never by display name', () => {
  const meetings = buildMeetingResults(
    [
      row({ course: 'Catterick', race_slug: '1315-a' }),
      row({ course: 'Catterick Bridge', race_slug: '1345-b' }), // same stored key
      row({ meeting_date: '2026-08-18', race_slug: '1400-c' }), // different date
    ],
    'catterick',
  );
  assert.equal(meetings.length, 2, 'one per (date, course_key)');
  const first = meetings.find((m) => m.meetingDate === '2026-08-17');
  assert.ok(first);
  assert.equal(first.matchingRaceCount, 2, 'two spellings of one stored key stay one meeting');
  assert.equal(first.href, '/date/2026-08-17/meeting/catterick');
  assert.equal(first.availability, 'canonical');
});

test('14. historical meetings group by exact label and stay unlinked', () => {
  const meetings = buildMeetingResults(
    [
      row({ course: 'Ascot', course_key: null, race_slug: null }),
      row({ course: 'Ascot', course_key: null, race_slug: null, race_name: 'Second' }),
      row({ course: 'Ayr', course_key: null, race_slug: null }),
    ],
    'a',
  );
  // Two groups: Ascot and Ayr. A row recording NO course has nothing to match
  // "a" against, so it is correctly not returned at all.
  assert.equal(meetings.length, 2);
  for (const meeting of meetings) {
    assert.equal(meeting.availability, 'historical');
    assert.equal(meeting.href, null, 'a historical meeting is never linked');
  }
  const ascot = meetings.find((m) => m.courseLabel === 'Ascot');
  const ayr = meetings.find((m) => m.courseLabel === 'Ayr');
  assert.ok(ascot && ayr);
  assert.equal(ascot.matchingRaceCount, 2, 'counts stay course-local');
  assert.equal(ayr.matchingRaceCount, 1);

  // A course-less historical row IS returned when the query names its date,
  // under a neutral label and still unlinked.
  const byDate = buildMeetingResults(
    [row({ course: null, course_key: null, race_slug: null })],
    '2026-08-17',
  );
  assert.equal(byDate.length, 1);
  assert.equal(byDate[0].courseLabel, 'Course not recorded');
  assert.equal(byDate[0].href, null);
});

test('15-16. race hrefs come from the stored tuple; a null handle stays unlinked', () => {
  const [canonical] = buildRaceResults([row()], 'Example');
  assert.equal(canonical.href, '/date/2026-08-17/meeting/catterick/race/1315-example-handicap');
  assert.equal(canonical.availability, 'canonical');

  for (const broken of [
    row({ course_key: null }),
    row({ race_slug: null }),
    row({ course_key: null, race_slug: null }),
  ]) {
    const [result] = buildRaceResults([broken], 'Example');
    assert.equal(result.href, null);
    assert.equal(result.availability, 'historical');
  }
  // A row with no usable date is not returned at all.
  assert.deepEqual(buildRaceResults([row({ meeting_date: null })], 'Example'), []);
});

test('17-18. a duplicate canonical tuple fails closed, with no arbitrary pick', () => {
  const duplicates = [
    row({ race_name: 'First stored copy' }),
    row({ race_name: 'Second stored copy' }),
  ];
  const results = buildRaceResults(duplicates, 'Example');

  assert.equal(results.length, 1, 'one entry, not two races implied');
  assert.equal(results[0].availability, 'ambiguous');
  assert.equal(results[0].href, null, 'never a link to an arbitrary duplicate');
  // NEITHER stored copy is named. Showing one of two conflicting records as
  // "the" race would be an arbitrary pick wearing a disclaimer.
  assert.notEqual(results[0].raceName, 'First stored copy');
  assert.notEqual(results[0].raceName, 'Second stored copy');
  assert.equal(results[0].raceName, AMBIGUOUS_RACE_LABEL);
  assert.equal(results[0].offTime, null, 'no off time is claimed either');

  // Three copies behave identically — not a two-row special case.
  const triple = buildRaceResults([...duplicates, row({ race_name: 'Third' })], 'Example');
  assert.equal(triple.length, 1);
  assert.equal(triple[0].availability, 'ambiguous');

  // The rendered explanation names no identifier.
  const markup = renderToStaticMarkup(
    h(SearchResultsList, { results: results as SearchResult[], label: 'Results' }),
  );
  assert.doesNotMatch(markup, /<a /, 'an ambiguous result is not a link');
  assert.match(markup, /cannot be opened safely/);
  assert.doesNotMatch(markup, /[0-9a-f]{8}-[0-9a-f]{4}-/i);
});

/* -------------------------------------------------------------------------- */
/* 19-20. Ranking                                                             */
/* -------------------------------------------------------------------------- */

test('19-20. ranking is deterministic and exact beats contained', () => {
  assert.equal(matchTier('catterick', { handles: ['catterick'], labels: [] }), MATCH_TIER.exactHandle);
  assert.equal(matchTier('Catterick', { handles: [], labels: ['catterick'] }), MATCH_TIER.exactLabel);
  assert.equal(matchTier('cat', { handles: ['catterick'], labels: [] }), MATCH_TIER.prefix);
  assert.equal(matchTier('terick', { handles: ['catterick'], labels: [] }), MATCH_TIER.contains);
  assert.equal(matchTier('zzz', { handles: ['catterick'], labels: [] }), MATCH_TIER.none);
  assert.ok(MATCH_TIER.exactHandle < MATCH_TIER.exactLabel);
  assert.ok(MATCH_TIER.exactLabel < MATCH_TIER.prefix);
  assert.ok(MATCH_TIER.prefix < MATCH_TIER.contains);

  // An exact course_key match outranks a mere containment on another row.
  const results = buildMeetingResults(
    [
      row({ course: 'Newcastle', course_key: 'newcastle', meeting_date: '2026-08-19' }),
      row({ course: 'Cat', course_key: 'cat', meeting_date: '2026-08-18' }),
    ],
    'cat',
  );
  assert.equal(results[0].courseLabel, 'Cat', 'the exact handle match ranks first');

  // Deterministic: the same input always produces the same order.
  const again = buildMeetingResults(
    [
      row({ course: 'Newcastle', course_key: 'newcastle', meeting_date: '2026-08-19' }),
      row({ course: 'Cat', course_key: 'cat', meeting_date: '2026-08-18' }),
    ],
    'cat',
  );
  assert.deepEqual(results.map((r) => r.courseLabel), again.map((r) => r.courseLabel));
});

/* -------------------------------------------------------------------------- */
/* 21. Read failure versus no results                                         */
/* -------------------------------------------------------------------------- */

test('21. a failed probe is a read failure, never a confident zero-result', () => {
  const okSeam = stubSeam({ byColumn: { course: [row()] } });
  const failSeam = stubSeam({ failColumns: ['race_name'] });

  return Promise.all([
    searchRacingRows({ pattern: '%a%', meetingDate: null }, okSeam.seam),
    searchRacingRows({ pattern: '%a%', meetingDate: null }, failSeam.seam),
    searchRacingRows({ pattern: '%a%', meetingDate: null }, stubSeam({}).seam),
  ]).then(([ok, failed, empty]) => {
    assert.equal(ok.kind, 'ok');
    assert.equal(failed.kind, 'read_failed', 'one failed probe fails the whole read');
    assert.equal(empty.kind, 'ok', 'genuinely empty is still a success');
    if (empty.kind === 'ok') assert.deepEqual(empty.rows, []);

    // Probes: one per fixed column, plus the date probe only when applicable.
    assert.deepEqual(okSeam.calls, [
      'matchColumn(course,%a%)',
      'matchColumn(course_key,%a%)',
      'matchColumn(race_name,%a%)',
      'matchColumn(race_slug,%a%)',
    ]);
  });
});

test('21b. the date probe runs only for an exact canonical date', () => {
  assert.equal(queryAsMeetingDate('2026-08-17'), '2026-08-17');
  for (const notADate of ['2026-08', '2026-02-30', '2026-8-17', 'ascot', '2026-13-01']) {
    assert.equal(queryAsMeetingDate(notADate), null, notADate);
  }
  const { seam, calls } = stubSeam({});
  return searchRacingRows({ pattern: '%x%', meetingDate: '2026-08-17' }, seam).then(() => {
    assert.ok(calls.includes('matchMeetingDate(2026-08-17)'));
    assert.equal(calls.length, 5);
  });
});

/* -------------------------------------------------------------------------- */
/* 22-25. Route contract                                                      */
/* -------------------------------------------------------------------------- */

test('22-23. the route is GET-only and refuses every other method', async () => {
  const mod = await import('../src/app/api/search/racing/route');
  assert.equal(typeof mod.GET, 'function');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const handler = mod[method] as () => Response;
    assert.equal(typeof handler, 'function', `${method} must be explicitly refused`);
    const response = handler();
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('Allow'), 'GET');
  }
  // No write verb exists in the route at all.
  const routeCode = code(ROUTE);
  for (const forbidden of [/\.insert\s*\(/, /\.update\s*\(/, /\.upsert\s*\(/, /\.delete\s*\(/, /\.rpc\s*\(/]) {
    assert.doesNotMatch(routeCode, forbidden, String(forbidden));
  }
});

test('24-25. refusals state the rule, never a database detail, and are not cached', async () => {
  const mod = await import('../src/app/api/search/racing/route');
  const call = (qs: string) =>
    mod.GET(new Request(`https://example.test/api/search/racing${qs}`) as never);

  const short = await call('?q=a');
  assert.equal(short.status, 400);
  assert.equal(short.headers.get('Cache-Control'), 'no-store');
  const shortBody = (await short.json()) as { error: string };
  assert.match(shortBody.error, /at least 2 characters/);

  const badScope = await call('?q=ascot&scope=runners');
  assert.equal(badScope.status, 400);
  assert.match(((await badScope.clone().json()) as { error: string }).error, /all, meetings, races/);

  // No refusal leaks a database word. Bodies were read once above, so the
  // already-parsed values are re-checked rather than re-consumed.
  for (const body of [shortBody, await badScope.clone().json()]) {
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /postgres|pgrst|supabase|relation|column|syntax|stack/i);
  }

  // Success is publicly cacheable for a short window.
  assert.match(code(ROUTE), /public, max-age=60, stale-while-revalidate=300/);
  assert.match(code(ROUTE), /'no-store'/);
});

/* -------------------------------------------------------------------------- */
/* 26-32. Controls render                                                     */
/* -------------------------------------------------------------------------- */

test('26-32. Search, Date and Scope render as real labelled controls', () => {
  const html = renderToStaticMarkup(h(RacingControls, {}));

  // The planned placeholders are gone from this surface.
  assert.doesNotMatch(html, /rb-slot__state/);
  assert.doesNotMatch(html, /Planned/);

  // Search input, labelled and bounded.
  assert.match(html, /<label[^>]*>Search racing<\/label>/);
  assert.match(html, /<input[^>]*type="search"/);
  assert.match(html, new RegExp(`maxLength="${SEARCH_MAX_QUERY_LENGTH}"|maxlength="${SEARCH_MAX_QUERY_LENGTH}"`));

  // Scope selector, labelled, with exactly the three supported values.
  assert.match(html, /<label[^>]*>Search scope<\/label>/);
  assert.match(html, /<select/);
  for (const label of ['All', 'Meetings', 'Races']) {
    assert.ok(html.includes(`>${label}</option>`), `${label} option`);
  }
  const options = [...html.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(options, ['all', 'meetings', 'races']);

  // Date input, labelled.
  assert.match(html, /<label[^>]*>Go to date<\/label>/);
  assert.match(html, /<input[^>]*type="date"/);

  // No duplicate id anywhere.
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate id');

  // Asserted from the FOR side: every label resolves to a real id, and there
  // are exactly three. A control rendered with no label at all now fails.
  const labelled = [...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(labelled.length, 3, 'search, scope and date are each labelled');
  for (const target of labelled) {
    assert.ok(ids.includes(target), `label points at a missing id: ${target}`);
  }
});

test('30b. the pre-mount render embeds no date default and announces nothing', () => {
  // Mount-gated: `renderToStaticMarkup` runs no effects, so this is the server
  // and first-hydration output. A dated default here would freeze into static
  // HTML exactly as the Today link once did.
  const html = renderToStaticMarkup(h(RacingControls, {}));
  assert.doesNotMatch(html, /\d{4}-\d{2}-\d{2}/, 'no date default in server HTML');
  assert.match(html, /type="date" value=""|value="" type="date"/);
  // The live region is present but empty, and adds no second status landmark.
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /role="status"/);
  assert.match(code(CONTROLS), /serverRacingDate = \(\): string \| null => null;/);
});

/* -------------------------------------------------------------------------- */
/* 33-37. Client request discipline                                           */
/* -------------------------------------------------------------------------- */

test('33-37. debounced, aborted, single-endpoint, never an arbitrary URL', () => {
  const controls = code(CONTROLS);

  // Does not search below the minimum, and mirrors the server bounds.
  assert.match(controls, /const MIN_QUERY_LENGTH = 2;/);
  assert.match(controls, /const MAX_QUERY_LENGTH = 64;/);
  assert.match(controls, /trimmed\.length >= MIN_QUERY_LENGTH && trimmed\.length <= MAX_QUERY_LENGTH/);
  assert.match(controls, /if \(!eligible\) \{/);

  // Debounced.
  assert.match(controls, /SEARCH_DEBOUNCE_MS = 250/);
  assert.match(controls, /setTimeout\(\(\) => \{/);
  assert.match(controls, /clearTimeout\(timer\)/);

  // Superseded requests are aborted, and an abort is not reported as a failure.
  assert.match(controls, /new AbortController\(\)/);
  assert.match(controls, /inFlight\.current\?\.abort\(\)/);
  assert.match(controls, /signal: controller\.signal/);
  assert.match(controls, /error\.name === 'AbortError'/);

  // Exactly one endpoint, a module constant, never derived from input.
  assert.match(controls, /const SEARCH_ENDPOINT = '\/api\/search\/racing';/);
  assert.equal((controls.match(/\bfetch\s*\(/g) ?? []).length, 1, 'one fetch call site');
  const paths = [...controls.matchAll(/['"`](\/[a-z][^'"`]*)['"`]/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(paths)].sort(), ['/api/search/racing', '/date/']);
  assert.doesNotMatch(controls, /https?:\/\//, 'no absolute URL');
  // Parameters are encoded, so input cannot restructure the query string.
  assert.match(controls, /encodeURIComponent\(trimmed\)/);
  assert.match(controls, /encodeURIComponent\(scope\)/);
});

/* -------------------------------------------------------------------------- */
/* 38-44. Result presentation                                                 */
/* -------------------------------------------------------------------------- */

test('38-40. loading, empty and failure are three distinct states', () => {
  const controls = code(CONTROLS);
  assert.match(controls, /'Searching…'/);
  assert.match(controls, /No racing found for/);
  assert.match(controls, /Search is unavailable right now\./);
  // A failure is never worded as an empty result.
  const failureBranch = controls.slice(controls.indexOf("visible.status === 'failed'"));
  assert.doesNotMatch(failureBranch.slice(0, 120), /No racing found/);
});

test('41-44. results are a semantic list; canonical link, historical does not', () => {
  const results: SearchResult[] = [
    {
      kind: 'meeting',
      meetingDate: '2026-08-17',
      courseLabel: 'Catterick',
      matchingRaceCount: 6,
      availability: 'canonical',
      href: '/date/2026-08-17/meeting/catterick',
    },
    {
      kind: 'race',
      meetingDate: '2026-08-17',
      courseLabel: 'Catterick',
      raceName: 'Example Handicap',
      offTime: '2026-08-17T12:15:00.000Z',
      availability: 'canonical',
      href: '/date/2026-08-17/meeting/catterick/race/1315-example-handicap',
    },
    {
      kind: 'meeting',
      meetingDate: '2026-06-16',
      courseLabel: 'Legacy Park',
      matchingRaceCount: 3,
      availability: 'historical',
      href: null,
    },
  ];
  const html = renderToStaticMarkup(h(SearchResultsList, { results, label: 'Search results' }));

  assert.match(html, /<ul[^>]*aria-label="Search results"/);
  assert.equal((html.match(/<li\b/g) ?? []).length, 3);

  // Canonical results are links; the historical one is not.
  const anchors = [...html.matchAll(/<a[^>]*href="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(anchors, [
    '/date/2026-08-17/meeting/catterick',
    '/date/2026-08-17/meeting/catterick/race/1315-example-handicap',
  ]);
  assert.match(html, /Legacy Park/);
  assert.match(html, /no permanent page/);
  for (const href of anchors) assert.notEqual(href, '');

  // Off time is shown in the racing timezone (12:15 UTC in August is 13:15 BST).
  assert.match(html, /13:15/);

  // No provider id, no uuid, no raw HTML injection surface.
  assert.doesNotMatch(html, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.doesNotMatch(code(RESULTS), /dangerouslySetInnerHTML/);
  assert.doesNotMatch(code(CONTROLS), /dangerouslySetInnerHTML/);

  // Text is escaped by React, so a scripted label cannot execute.
  const nasty = renderToStaticMarkup(
    h(SearchResultsList, {
      results: [{ ...results[2], courseLabel: '<img src=x onerror=alert(1)>' }],
      label: 'Search results',
    }),
  );
  assert.doesNotMatch(nasty, /<img src=x/);
  assert.match(nasty, /&lt;img/);
});

/* -------------------------------------------------------------------------- */
/* 45-52. Date and scope behaviour                                            */
/* -------------------------------------------------------------------------- */

test('45-49. date selection validates and navigates canonically only', () => {
  const controls = code(CONTROLS);
  // Validated with the same predicate the route uses, through one pure helper.
  assert.match(controls, /isIsoRacingDate\(value\) \? `\$\{DATE_ROUTE_PREFIX\}\$\{value\}` : null/);
  assert.match(controls, /const href = resolveDateHref\(value\);/);
  assert.match(controls, /if \(href === null\) return;/);
  assert.match(controls, /export const DATE_ROUTE_PREFIX = '\/date\/';/);
  // No legacy query-string dashboard, no uuid.
  assert.doesNotMatch(controls, /\?date=|&course=/);
  assert.doesNotMatch(controls, /[0-9a-f]{8}-[0-9a-f]{4}-/i);

  // BEHAVIOURAL: the rule itself, not the source that expresses it.
  assert.equal(resolveDateHref('2026-08-17'), '/date/2026-08-17');
  assert.equal(resolveDateHref('2024-02-29'), '/date/2024-02-29');
  for (const refused of [
    '',
    '   ',
    '2026-02-30',
    '2026-13-01',
    '2026-8-17',
    '2026-08-17T00:00:00Z',
    '//evil.example',
    'javascript:alert(1)',
    '../admin',
    null,
    undefined,
  ]) {
    assert.equal(resolveDateHref(refused), null, JSON.stringify(refused));
  }
  // A produced href is always a LOCAL canonical date route.
  const produced = resolveDateHref('2026-08-17');
  assert.ok(produced !== null && produced.startsWith('/date/') && !produced.startsWith('//'));

  // TYPING MUST NOT NAVIGATE. `<input type="date">` fires change on every
  // completed segment edit, so committing there tore the page away mid-keystroke
  // (editing the year of 2026-08-18 momentarily yields the valid 0002-08-18).
  const controlsSrc = code(CONTROLS);
  assert.ok(controlsSrc.includes('onChange={(event) => setChosenDate(event.target.value)}'));
  assert.ok(controlsSrc.includes('onBlur={(event) => goToDate(event.target.value)}'));
  // Line-based, so comment stripping cannot shift the window onto other code.
  const changeLine = controlsSrc
    .split('\n')
    .find((line) => line.includes('onChange={(event) => setChosenDate'));
  assert.ok(changeLine !== undefined, 'the date change handler was located');
  assert.doesNotMatch(changeLine, /goToDate/, 'change must never navigate');

  // The seam is wired, and rendering alone never navigates.
  const seen: string[] = [];
  renderToStaticMarkup(h(RacingControls, { navigate: (href: string) => seen.push(href) }));
  assert.deepEqual(seen, [], 'rendering alone never navigates');
});

test('50-52. scope defaults to All, is bounded, and reruns an eligible search', () => {
  const controls = code(CONTROLS);
  assert.match(controls, /useState<SearchScope>\('all'\)/);
  // The effect depends on scope, so changing it reruns an eligible search.
  assert.match(controls, /\}, \[trimmed, scope, eligible\]\);/);
  // Options are a fixed list, never derived from a response.
  assert.match(controls, /const SCOPE_OPTIONS: readonly \{ value: SearchScope; label: string \}\[\]/);
  // Scope reaches only the bounded endpoint, as an encoded parameter.
  assert.match(controls, /scope=\$\{encodeURIComponent\(scope\)\}/);

  // The server refuses anything outside the closed set (already asserted), and
  // the scope never becomes a column, table or operator anywhere.
  for (const file of [CONTRACT, READ, ROUTE]) {
    assert.doesNotMatch(code(file), /\.from\(\s*scope|\.select\(\s*scope|\.eq\(\s*scope/, file);
  }
});

/* -------------------------------------------------------------------------- */
/* 53-60. Boundaries                                                          */
/* -------------------------------------------------------------------------- */

test('53-59. no client Supabase, no write, no rpc, no provider, no operational call', () => {
  // The UI never reaches a server module.
  for (const file of [CONTROLS, RESULTS]) {
    const executable = code(file);
    assert.doesNotMatch(executable, /supabaseAdmin|@supabase/, file);
    assert.doesNotMatch(executable, /process\.env/, file);
    assert.doesNotMatch(executable, /racingSearchRead|racingNavigationRead/, file);
    assert.doesNotMatch(executable, /\.insert\s*\(|\.update\s*\(|\.upsert\s*\(|\.delete\s*\(|\.rpc\s*\(/, file);
  }
  // A type-only import is erased at runtime, so the contract module never
  // enters the browser bundle as code.
  assert.match(code(CONTROLS), /import type \{[^}]*\} from '@\/lib\/racingSearchContract'/);

  // The server side is SELECT-only against exactly one table.
  const readCode = code(READ);
  assert.equal(SEARCH_TABLE, 'races');
  const tables = [...readCode.matchAll(/\.from\((\w+|'[^']*')\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)], ['SEARCH_TABLE']);
  const verbs = [...readCode.matchAll(/\.(\w+)\(/g)]
    .map((m) => m[1])
    .filter((v) => ['from', 'select', 'ilike', 'eq', 'limit', 'insert', 'update', 'upsert', 'delete', 'rpc'].includes(v));
  assert.deepEqual([...new Set(verbs)].sort(), ['eq', 'from', 'ilike', 'limit', 'select']);

  // Nothing in the search path calls the provider or an operational route.
  for (const file of SEARCH_FILES) {
    const executable = code(file);
    assert.doesNotMatch(executable, /theracingapi|betfair/i, file);
    assert.doesNotMatch(executable, /\/api\/cron|\/api\/run-model|\/api\/settle/, file);
    assert.doesNotMatch(executable, /runModelForRace|syncOdds|lockTMinus|settleRace|producerClaim/, file);
  }

  // The search text is never logged.
  assert.doesNotMatch(code(READ), /console\.(log|error|warn)\([^)]*pattern/);
  assert.doesNotMatch(code(ROUTE), /console\.(log|error|warn)\([^)]*query/);
});

test('60. the mobile bottom bar is untouched by the new controls', () => {
  const shell = code('src/components/AppShell.tsx');
  // Controls live in the header control channel, not the navigation.
  assert.match(shell, /<RacingControls \/>/);
  const channel = shell.slice(shell.indexOf('rb-control-channel'));
  assert.ok(channel.indexOf('<RacingControls />') < channel.indexOf('rb-nav--mobile'));
  // The bottom bar still renders only AppNavigation.
  assert.match(shell, /<nav className="rb-nav rb-nav--mobile"[\s\S]{0,120}<AppNavigation variant="mobile"/);
  assert.doesNotMatch(
    shell.slice(shell.indexOf('rb-nav--mobile')),
    /RacingControls/,
    'no control may enter the bottom bar',
  );
});

/* -------------------------------------------------------------------------- */
/* CSS                                                                        */
/* -------------------------------------------------------------------------- */

test('CSS additions are additive, namespaced and non-clipping', () => {
  const tokens = readFileSync('src/styles/tokens.css', 'utf8');
  for (const selector of [
    '.rb-controls',
    '.rb-controls__field',
    '.rb-controls__label',
    '.rb-controls__input',
    '.rb-controls__select',
    '.rb-controls__status',
    '.rb-search__panel',
    '.rb-search__results',
  ]) {
    assert.ok(tokens.includes(`${selector} {`) || tokens.includes(`${selector},`), `${selector} defined`);
  }
  // Never suppress focus, never animate, never clip results away.
  assert.doesNotMatch(tokens, /outline:\s*(none|0)\b/);
  assert.doesNotMatch(tokens, /\.rb-search__panel \{[^}]*overflow:\s*hidden/);
  assert.match(tokens, /\.rb-search__panel \{[^}]*overflow-y: auto/);
  // Mobile-first: the panel floats only above a min-width breakpoint.
  assert.match(tokens, /@media \(min-width: 48rem\) \{\s*\.rb-search__panel/);
  // Touch targets meet the existing minimum.
  // Scoped to the NEW rule: a page-wide match would be satisfied by the nav's
  // existing use of the same token even after this rule lost the property.
  const anchor = tokens.indexOf('.rb-controls__input,');
  assert.ok(anchor > 0, 'the control rule exists');
  const controlRule = tokens.slice(anchor, tokens.indexOf('}', anchor));
  assert.match(controlRule, /min-height: var\(--rb-touch-target-min\)/);
});

/* ========== review corrections: gaps the first pass left untested ========== */

test('R1. `*` is refused, because PostgREST treats it as a wildcard alias', () => {
  // PostgREST rewrites `*` to `%` inside a like/ilike value, and `\*` becomes
  // `\%` (a literal percent), so it cannot be escaped away. Refusing is the
  // only option that keeps "we search for exactly what you typed" true.
  for (const withStar of ['Asc*t', '*', '**', 'Ascot*', '*Ascot']) {
    assert.deepEqual(normaliseSearchQuery(withStar), { ok: false, reason: 'wildcard' }, withStar);
  }
  assert.deepEqual(normaliseSearchQuery('Ascot'), { ok: true, query: 'Ascot' });
});

test('R2. probes are ordered, so the bounded window keeps the newest racing', () => {
  const readCode = code(READ);
  // Without ORDER BY, LIMIT returns arbitrary heap order — in practice the
  // OLDEST rows — so a busy course would answer with last season.
  assert.match(readCode, /\.order\('meeting_date', \{ ascending: false \}\)/);
  assert.match(readCode, /\.order\('off_time', \{ ascending: false, nullsFirst: false \}\)/);
  assert.match(readCode, /\.order\('off_time', \{ ascending: true, nullsFirst: false \}\)/);
  // Every probe orders before it limits.
  const orderAt = readCode.indexOf(".order('meeting_date'");
  const limitAt = readCode.indexOf('.limit(SEARCH_PROBE_LIMIT)');
  assert.ok(orderAt > 0 && limitAt > orderAt, 'order must precede limit');
});

test('R3. a clipped probe window is reported as truncated, never as complete', async () => {
  const full = Array.from({ length: SEARCH_PROBE_LIMIT }, (_, i) =>
    row({ race_slug: `13${String(i).padStart(2, '0')}-race`, race_name: `Race ${i}` }),
  );
  const { seam } = stubSeam({ byColumn: { course: full } });
  const outcome = await searchRacingRows({ pattern: '%c%', meetingDate: null }, seam);
  assert.equal(outcome.kind, 'ok');
  if (outcome.kind !== 'ok') return;
  assert.equal(outcome.truncated, true, 'a full page means matches were clipped');

  // A short page is a complete answer.
  const { seam: small } = stubSeam({ byColumn: { course: [row()] } });
  const partial = await searchRacingRows({ pattern: '%c%', meetingDate: null }, small);
  assert.equal(partial.kind === 'ok' && partial.truncated, false);

  // And the flag reaches the response even when few results survive ranking.
  const body = buildSearchResults({
    rows: [row()],
    query: 'Catterick',
    scope: 'all',
    probeTruncated: true,
  });
  assert.ok(body.results.length < SEARCH_RESULT_LIMIT);
  assert.equal(body.truncated, true, 'probe truncation must not be hidden');
});

test('R4. ordering runs forwards within a date and newest-date first', () => {
  const races = buildRaceResults(
    [
      row({ race_slug: '1745-last', race_name: 'Last', off_time: '2026-08-17T16:45:00.000Z' }),
      row({ race_slug: '1315-first', race_name: 'First', off_time: '2026-08-17T12:15:00.000Z' }),
      row({ race_slug: '1615-mid', race_name: 'Mid', off_time: '2026-08-17T15:15:00.000Z' }),
    ],
    'Catterick',
  );
  // A card reads forwards: negating one concatenated key would have listed the
  // last race of the day first.
  assert.deepEqual(races.map((r) => r.raceName), ['First', 'Mid', 'Last']);

  // Across dates, the newest meeting leads.
  const meetings = buildMeetingResults(
    [
      row({ meeting_date: '2026-08-15', course_key: 'ayr', course: 'Ayr' }),
      row({ meeting_date: '2026-08-19', course_key: 'ayr', course: 'Ayr' }),
      row({ meeting_date: '2026-08-17', course_key: 'ayr', course: 'Ayr' }),
    ],
    'Ayr',
  );
  assert.deepEqual(
    meetings.map((m) => m.meetingDate),
    ['2026-08-19', '2026-08-17', '2026-08-15'],
  );

  // Courses on one date read A-Z, not Z-A.
  const sameDay = buildMeetingResults(
    [
      row({ course_key: 'york', course: 'York' }),
      row({ course_key: 'ascot', course: 'Ascot' }),
      row({ course_key: 'newbury', course: 'Newbury' }),
    ],
    '2026-08-17',
  );
  assert.deepEqual(sameDay.map((m) => m.courseLabel), ['Ascot', 'Newbury', 'York']);
});

test('R5. a meeting label and tier come from the whole group, not its first row', () => {
  // The first row stores no course name; a sibling does. The group must use the
  // real name rather than falling back to the raw handle.
  const meetings = buildMeetingResults(
    [
      row({ course: null, race_slug: '1315-a' }),
      row({ course: 'Catterick', race_slug: '1345-b' }),
    ],
    'catterick',
  );
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0].courseLabel, 'Catterick', 'not the raw handle');
  assert.equal(meetings[0].matchingRaceCount, 2);
});

test('R6. scope narrows the response, and meetings/races interleave by relevance', () => {
  const rows = [row(), row({ race_slug: '1345-other', race_name: 'Other Race' })];

  const meetingsOnly = buildSearchResults({ rows, query: 'Catterick', scope: 'meetings' });
  assert.ok(meetingsOnly.results.length > 0);
  assert.ok(meetingsOnly.results.every((r) => r.kind === 'meeting'), 'no races in meetings scope');

  const racesOnly = buildSearchResults({ rows, query: 'Catterick', scope: 'races' });
  assert.ok(racesOnly.results.length > 0);
  assert.ok(racesOnly.results.every((r) => r.kind === 'race'), 'no meetings in races scope');

  const all = buildSearchResults({ rows, query: 'Catterick', scope: 'all' });
  assert.ok(all.results.some((r) => r.kind === 'meeting'));
  assert.ok(all.results.some((r) => r.kind === 'race'));
  // A meeting leads at equal relevance: it is the broader answer.
  assert.equal(all.results[0].kind, 'meeting');
});

test('R7. the route returns 200 with a shaped body, and 503 on a read failure', async () => {
  const mod = await import('../src/app/api/search/racing/route');
  const call = (qs: string, seam: RacingSearchReadSeam) =>
    mod.handleRacingSearch(
      new Request(`https://example.test/api/search/racing${qs}`) as never,
      seam,
    );

  const { seam: ok } = stubSeam({ byColumn: { course: [row()] } });
  const success = await call('?q=Catterick', ok);
  assert.equal(success.status, 200);
  assert.equal(success.headers.get('Cache-Control'), 'public, max-age=60, stale-while-revalidate=300');
  const body = (await success.json()) as {
    query: string;
    scope: string;
    results: SearchResult[];
    truncated: boolean;
  };
  assert.equal(body.query, 'Catterick');
  assert.equal(body.scope, 'all');
  assert.equal(body.truncated, false);
  assert.ok(body.results.length > 0);
  // No uuid, no provider id anywhere in the serialised response.
  const json = JSON.stringify(body);
  assert.doesNotMatch(json, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.doesNotMatch(json, /provider/i);

  // A failed probe is a 503, NOT an empty result set.
  const { seam: broken } = stubSeam({ failColumns: ['race_slug'] });
  const failed = await call('?q=Catterick', broken);
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('Cache-Control'), 'no-store');
  const failedBody = (await failed.json()) as { error: string; results?: unknown };
  assert.equal(failedBody.results, undefined, 'a failure must not carry a results array');
  assert.match(failedBody.error, /could not be searched/);
  assert.doesNotMatch(JSON.stringify(failedBody), /postgres|pgrst|supabase|column|relation/i);

  // A genuinely empty answer is a 200 with an empty list — a different claim.
  const { seam: empty } = stubSeam({});
  const none = await call('?q=Nowhere', empty);
  assert.equal(none.status, 200);
  assert.deepEqual(((await none.json()) as { results: unknown[] }).results, []);
});

test('R8. the new shell components carry the same safety invariants as the shell', () => {
  /*
   * `appShell.test.ts` applies its scans to a fixed list of four shell files.
   * These two components joined the shell after that list was written, so the
   * invariants are re-applied here rather than being quietly skipped.
   *
   * Two narrow, named exemptions for the search UI, which is what it is for:
   * it may call `fetch`, and it may name its own `/api/` path. Everything else
   * is forbidden exactly as it is for the original four.
   */
  const NEW_SHELL = [CONTROLS, RESULTS];
  const exempt = new Set([CONTROLS]);

  for (const file of NEW_SHELL) {
    const executable = code(file);
    assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie/.test(executable), false, file);
    assert.equal(/process\.env|SUPABASE|SERVICE_ROLE|CRON_SECRET/.test(executable), false, file);
    assert.equal(/dangerouslySetInnerHTML/.test(executable), false, file);
    assert.equal(/placeBet|placeOrder|createOrder|stake|betfair/i.test(executable), false, file);
    assert.equal(/XMLHttpRequest|EventSource|WebSocket/.test(executable), false, file);
    if (!exempt.has(file)) {
      assert.equal(/\bfetch\s*\(/.test(executable), false, `${file} must not fetch`);
      assert.equal(/['"`]\/api\//.test(executable), false, `${file} must not name an API path`);
    }
  }

  // Only ONE of them is a client component, and the results list is not.
  assert.match(code(CONTROLS), /['"]use client['"]/);
  assert.doesNotMatch(code(RESULTS), /['"]use client['"]/);

  // `window` is touched in exactly one place, for one purpose, guarded.
  const windowUses = [...code(CONTROLS).matchAll(/\bwindow\./g)];
  assert.equal(windowUses.length, 1, 'one window use: the date navigation');
  assert.match(code(CONTROLS), /if \(typeof window === 'undefined'\) return;/);
  assert.match(code(CONTROLS), /window\.location\.assign\(href\);/);
});

test('R9. a server-supplied href is only followed when it is a local path', () => {
  // Defence in depth: the server can only emit `/date/...` today, but a link is
  // rendered only for a same-origin absolute path, so a future change, a
  // tampered response or a poisoned cache cannot produce an off-site link.
  for (const good of ['/date/2026-08-17', '/date/2026-08-17/meeting/catterick']) {
    assert.equal(isLocalResultHref(good), true, good);
  }
  for (const bad of [
    null,
    '',
    '//evil.example/date',
    'https://evil.example',
    'javascript:alert(1)',
    'data:text/html,x',
    'date/2026-08-17',
  ]) {
    assert.equal(isLocalResultHref(bad as string | null), false, String(bad));
  }

  const hostile: SearchResult[] = [
    {
      kind: 'meeting',
      meetingDate: '2026-08-17',
      courseLabel: 'Hostile',
      matchingRaceCount: 1,
      availability: 'canonical',
      href: 'https://evil.example' as string,
    },
  ];
  const html = renderToStaticMarkup(h(SearchResultsList, { results: hostile, label: 'Results' }));
  assert.doesNotMatch(html, /<a /, 'an off-site href is never rendered as a link');
  assert.doesNotMatch(html, /evil\.example/);
});

test('R10. dedupe cannot silently drop a distinct row through key collision', async () => {
  // Field-boundary shift: without a separator these two rows share a key.
  const a = row({ race_slug: '1315-a', race_name: '' });
  const b = row({ race_slug: '1315', race_name: '-a' });
  const { seam } = stubSeam({ byColumn: { course: [a], course_key: [b] } });
  const outcome = await searchRacingRows({ pattern: '%c%', meetingDate: null }, seam);
  assert.equal(outcome.kind, 'ok');
  if (outcome.kind !== 'ok') return;
  assert.equal(outcome.rows.length, 2, 'distinct rows must both survive');

  // A genuine duplicate across probes is still collapsed.
  const { seam: dup } = stubSeam({ byColumn: { course: [row()], course_key: [row()] } });
  const collapsed = await searchRacingRows({ pattern: '%c%', meetingDate: null }, dup);
  assert.equal(collapsed.kind === 'ok' && collapsed.rows.length, 1);
});

test('R11. Escape clears from anywhere in the controls, and focus is restored', () => {
  const controls = code(CONTROLS);
  // The handler is on the control GROUP, so it fires while focus is on a
  // result link — where an input-only handler never would.
  assert.match(controls, /className="rb-controls"[\s\S]{0,400}onKeyDown=/);
  assert.match(controls, /event\.key === 'Escape'/);
  // Dismissing returns focus to a real element rather than leaving it on body.
  assert.match(controls, /searchInputRef\.current\?\.focus\(\);/);
  assert.match(controls, /ref=\{searchInputRef\}/);
  // The live region is not also the input's description (double announcement).
  assert.doesNotMatch(controls, /aria-describedby=\{statusId\}/);
});

/* ========== re-review corrections (N-1 .. N-4) ============================ */

test('N1. the wildcard refusal states the rule, not a generic message', async () => {
  const mod = await import('../src/app/api/search/racing/route');
  const response = await mod.handleRacingSearch(
    new Request('https://example.test/api/search/racing?q=Asc*t') as never,
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.notEqual(body.error, 'Invalid search request.', 'must not fall through to the fallback');
  assert.match(body.error, /\*/, 'the message names the character');
  assert.match(body.error, /wildcard/i);
  // Every rejection reason has its own sentence.
  const routeCode = code(ROUTE);
  for (const reason of ['missing', 'too_short', 'too_long', 'invalid_characters', 'wildcard', 'unsupported_scope']) {
    assert.match(routeCode, new RegExp(`${reason}:`), `${reason} needs a message`);
  }
});

test('N2. leaving the date field unchanged does not navigate', () => {
  const controls = code(CONTROLS);
  // Tabbing THROUGH a pre-filled date field fires blur on an unchanged, valid
  // value. Navigating there would tear the page away for no user action.
  assert.match(controls, /const committedDate = useRef<string \| null>\(null\);/);
  assert.match(controls, /if \(committedDate\.current === value\) return;/);
  assert.match(controls, /committedDate\.current = value;/);
  // The guard sits before the navigate call, not after it.
  const guardAt = controls.indexOf('if (committedDate.current === value) return;');
  const navigateAt = controls.indexOf('navigate(href);');
  assert.ok(guardAt > 0 && navigateAt > guardAt, 'the guard must precede navigation');
});

test('N3. cross-kind ranking uses the REAL match tier, not a position index', () => {
  // A weak meeting match must not evict a strong race match. Query "cat":
  // "Cat" is an exact handle for both a meeting and its races; "Catterick" is
  // only a prefix match.
  const rows = [
    row({ course: 'Cat', course_key: 'cat', race_slug: '1300-a', race_name: 'Alpha' }),
    row({ course: 'Cat', course_key: 'cat', race_slug: '1330-b', race_name: 'Bravo' }),
    row({ course: 'Catterick', course_key: 'catterick', race_slug: '1400-c', race_name: 'Charlie' }),
  ];
  const { results } = buildSearchResults({ rows, query: 'cat', scope: 'all' });

  const tiers = results.map((r) => (r.courseLabel === 'Cat' ? 'exact' : 'weaker'));
  const firstWeaker = tiers.indexOf('weaker');
  const lastExact = tiers.lastIndexOf('exact');
  assert.ok(
    firstWeaker === -1 || firstWeaker > lastExact,
    'every exact-handle match must precede every weaker one, across kinds',
  );

  // The merge no longer re-keys results by position.
  const contractCode = code(CONTRACT);
  assert.doesNotMatch(contractCode, /tier: index as unknown as MatchTier/);
  assert.doesNotMatch(contractCode, /as unknown as MatchTier/);
  assert.match(contractCode, /rankMeetingResults\(rows, query\)/);
  assert.match(contractCode, /rankRaceResults\(rows, query\)/);

  // A meeting still leads a race of EQUAL tier.
  const equal = buildSearchResults({
    rows: [row({ course: 'Cat', course_key: 'cat', race_slug: '1300-a', race_name: 'cat' })],
    query: 'cat',
    scope: 'all',
  });
  assert.equal(equal.results[0].kind, 'meeting');
});

test('N4. a backslash scheme-relative href is refused as well', () => {
  // WHATWG URL parsing treats `\` as `/` for special schemes, so `/\host`
  // resolves off-site despite starting with a single slash.
  // `'\\'` is ONE backslash: the string under test is `/\evil.example`.
  assert.equal(isLocalResultHref('/\\evil.example'), false);
  assert.equal(isLocalResultHref(`/${String.fromCharCode(92)}evil.example`), false);
  assert.equal(isLocalResultHref('//evil.example'), false);
  assert.equal(isLocalResultHref('/date/2026-08-17'), true);

  const hostile: SearchResult[] = [
    {
      kind: 'meeting',
      meetingDate: '2026-08-17',
      courseLabel: 'Backslash',
      matchingRaceCount: 1,
      availability: 'canonical',
      href: `/${String.fromCharCode(92)}evil.example`,
    },
  ];
  const html = renderToStaticMarkup(h(SearchResultsList, { results: hostile, label: 'Results' }));
  assert.doesNotMatch(html, /<a /);
  assert.doesNotMatch(html, /evil\.example/);
});

test('N5. an ambiguous race does not order by one clashing row-s off time', () => {
  const contractCode = code(CONTRACT);
  assert.match(contractCode, /tieKey: ambiguous \? '' :/);
});
