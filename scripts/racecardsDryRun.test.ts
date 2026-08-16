/**
 * RACECARD MAPPING DRY RUN — safety and correctness guards.
 *
 * This command is the evidence a later, separately authorised write run depends
 * on, so the properties that make it safe must be provable rather than assumed:
 *
 *   1. It accepts today/tomorrow and nothing else, and rejects `--commit`.
 *   2. It reaches the provider exactly once, on the racecards path only.
 *   3. It consumes the REAL Programme 0 mappers — no rule is restated.
 *   4. Its database surface cannot mutate anything, structurally.
 *   5. Its output carries aggregates only: no provider identifier, no secret.
 *   6. Nothing it does can write a row, on any path including failure.
 *
 * Everything below runs on fixtures and stubs. No provider is contacted, no
 * database is opened, and the CLI itself is never executed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type {
  JockeyAnalysisResponse,
  RacecardsResponse,
  RacecardsStandardResponse,
  RacingApiClient,
  ResultsFreeResponse,
  ResultsResponse,
  StandardRacecard,
  TrainerAnalysisResponse,
} from '../src/lib/racingApi';
import { racecardRunnerToUpsert, racecardToRaceUpsert } from '../src/lib/raceSync';
import {
  MAX_PREVIEW_DETAIL_LENGTH,
  RACECARDS_DRY_RUN_REGIONS,
  RACE_COVERAGE_FIELDS,
  RUNNER_COVERAGE_FIELDS,
  RacecardsDryRunFailure,
  buildWarnings,
  describePreviewFailure,
  indexExistingRaces,
  indexExistingRunners,
  isPreviewDay,
  mapPreviewCards,
  raceFieldCoverage,
  raceMatchKey,
  redactPreviewDetail,
  renderPreviewFailure,
  renderRacecardsDryRunConsole,
  runRacecardsDryRun,
  runnerFieldCoverage,
  summariseDestinationDates,
  indexExistingRacesByProviderId,
  type ExistingProviderRaceRow,
  type ExistingRaceRow,
  type ExistingRunnerRow,
  type RacecardsDryRunReadSeam,
  type RacecardsDryRunReport,
} from '../src/lib/racecardsDryRun';
import { parseRacecardsDryRunArgs } from './racecardsDryRun';

const LIB_PATH = 'src/lib/racecardsDryRun.ts';
const CLI_PATH = 'scripts/racecardsDryRun.ts';
// Line endings are normalised to \n: this repository is checked out with
// core.autocrlf=true, so a committed file arrives as CRLF and a structural
// assertion looking for a literal '\n}\n' would silently parse nothing.
const LIB = () => readFileSync(LIB_PATH, 'utf8').replace(/\r\n/g, '\n');
const CLI = () => readFileSync(CLI_PATH, 'utf8').replace(/\r\n/g, '\n');

/**
 * Source with comments removed.
 *
 * Load-bearing for the forbidden-operation scans below. Both files legitimately
 * spell out, in prose, the things they never do — "never writes `cron_runs`",
 * "never acquires a producer claim", "no odds, model, lock or result action".
 * That documentation is the point, and it must never be able to fail a scan for
 * the very operation it promises not to perform. Every structural assertion
 * therefore runs on executable text only.
 */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const LIB_CODE = () => codeOf(LIB());
const CLI_CODE = () => codeOf(CLI());

const NOW = new Date('2026-08-16T12:00:00Z');
/** `--day tomorrow` relative to NOW. */
const SELECTED_DATE = '2026-08-17';

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

/** A fully-populated card: every Programme 0 race field is present. */
const FULL_RUNNER = {
  horse_id: 'hrs_33330000',
  horse: 'Fixture Runner (IRE)',
  number: '1',
  draw: '4',
  lbs: '133',
  ofr: '95',
  age: '4',
  trainer: 'Fixture Trainer',
  trainer_id: 'trn_44440000',
  jockey: 'Fixture Jockey',
  jockey_id: 'jck_55550000',
};

/** Mappable, but every Programme 0 runner field is absent. */
const BARE_RUNNER = { horse: 'Bare Fixture Runner' };

/** Unmappable: a blank horse name. */
const BLANK_RUNNER = { horse: '   ' };

const FULL_CARD: StandardRacecard = {
  race_id: 'rac_11110000',
  course: 'Fixtureton',
  course_id: 'crs_22220000',
  date: SELECTED_DATE,
  off_time: '14:05',
  off_dt: `${SELECTED_DATE}T14:05:00+01:00`,
  race_name: 'Fixture Handicap Stakes',
  region: 'GB',
  race_class: 'Class 2',
  type: 'Flat',
  age_band: '3yo+',
  going: 'Good To Firm',
  distance_f: '8.0',
  distance_round: '1m',
  field_size: '9',
  pattern: 'Listed',
  is_abandoned: false,
  runners: [FULL_RUNNER, BARE_RUNNER, BLANK_RUNNER],
};

/** The instant `FULL_CARD` resolves to (14:05 +01:00 -> 13:05Z). */
const FULL_CARD_INSTANT = `${SELECTED_DATE}T13:05:00.000Z`;

/** Mappable, but carries none of the optional Programme 0 attributes. */
const SPARSE_CARD: StandardRacecard = {
  course: 'Sparseton',
  off_dt: `${SELECTED_DATE}T15:00:00Z`,
  race_name: 'Sparse Fixture Race',
  runners: [BARE_RUNNER],
};

const ABANDONED_CARD: StandardRacecard = { ...FULL_CARD, is_abandoned: true };

/** Unmappable: blank course. Not flagged abandoned, so it counts as invalid. */
const INVALID_CARD: StandardRacecard = {
  course: '   ',
  off_dt: `${SELECTED_DATE}T16:00:00Z`,
  race_name: 'Invalid Fixture Race',
  runners: [BARE_RUNNER],
};

/** The UTC day after `SELECTED_DATE`; a mapped destination that is NOT selected. */
const OTHER_DATE = '2026-08-18';

/** Mappable, but destined for a different meeting date (review finding M-2). */
const OTHER_DATE_CARD: StandardRacecard = {
  course: 'Otherdayton',
  date: OTHER_DATE,
  off_dt: `${OTHER_DATE}T13:00:00Z`,
  race_name: 'Other Day Fixture Race',
  runners: [BARE_RUNNER],
};

/** A runner that appears only on the duplicate card. */
const SECOND_WAVE_RUNNER = { horse: 'Second Wave Fixture Runner' };

/**
 * A DUPLICATE of `FULL_CARD`: same course, same instant expressed in a
 * different textual form, different provider race id. Carries one repeated
 * runner and one new one (review finding L-1).
 */
const DUPLICATE_CARD: StandardRacecard = {
  ...FULL_CARD,
  race_id: 'rac_99990000',
  off_time: '13:05',
  off_dt: `${SELECTED_DATE}T13:05:00.000Z`,
  runners: [FULL_RUNNER, SECOND_WAVE_RUNNER],
};

/**
 * A hostile error message carrying every category of protected value the
 * review named, plus enough padding to force truncation.
 */
const HOSTILE_ERROR = new Error(
  'Racing API 401 Unauthorized for /racecards/standard ' +
    'https://api.theracingapi.com/v1/racecards/standard?day=today&key=leaked ' +
    'Authorization: Bearer sk-live-abcdef1234567890 ' +
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.cGF5bG9hZHBheWxvYWQ.c2lnbmF0dXJl ' +
    'sbp_0123456789abcdef ' +
    'race rac_11110000 course crs_22220000 horse hrs_33330000 ' +
    'trainer trn_44440000 jockey jck_55550000 ' +
    `${'padding-'.repeat(60)}`,
);

/** Every raw value that must never survive redaction. */
const PROTECTED_VALUES = [
  'https://',
  'api.theracingapi.com',
  'Bearer',
  'sk-live-abcdef1234567890',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'sbp_0123456789abcdef',
  'rac_11110000',
  'rac_99990000',
  'crs_22220000',
  'hrs_33330000',
  'trn_44440000',
  'jck_55550000',
];

/* -------------------------------------------------------------------------- *
 * Stubs
 * -------------------------------------------------------------------------- */

interface FakeClient extends RacingApiClient {
  calls: string[];
}

/**
 * A provider stub whose non-racecard methods THROW. If the preview ever reached
 * odds, results, tipster or analysis data, the test would fail loudly rather
 * than quietly tolerate it.
 */
function fakeClient(options: {
  standard?: RacecardsStandardResponse | (() => never);
  basic?: RacecardsStandardResponse | (() => never);
} = {}): FakeClient {
  const calls: string[] = [];
  const forbidden = (name: string) => (): never => {
    calls.push(name);
    throw new Error(`FORBIDDEN provider call: ${name}`);
  };
  return {
    calls,
    async getStandardRacecards(params) {
      calls.push(`getStandardRacecards(${params.day},${(params.regionCodes ?? []).join('+')})`);
      const value = options.standard;
      if (typeof value === 'function') return value();
      return value ?? { racecards: [] };
    },
    async getBasicRacecards(params) {
      calls.push(`getBasicRacecards(${params.day},${(params.regionCodes ?? []).join('+')})`);
      const value = options.basic;
      if (typeof value === 'function') return value();
      return value ?? { racecards: [] };
    },
    getFreeRacecards: forbidden('getFreeRacecards') as unknown as () => Promise<RacecardsResponse>,
    getTrainerCourseAnalysis: forbidden(
      'getTrainerCourseAnalysis',
    ) as unknown as () => Promise<TrainerAnalysisResponse>,
    getJockeyCourseAnalysis: forbidden(
      'getJockeyCourseAnalysis',
    ) as unknown as () => Promise<JockeyAnalysisResponse>,
    getResults: forbidden('getResults') as unknown as () => Promise<ResultsResponse>,
    getTodayResults: forbidden('getTodayResults') as unknown as () => Promise<ResultsFreeResponse>,
    getTodayFreeResults: forbidden(
      'getTodayFreeResults',
    ) as unknown as () => Promise<ResultsFreeResponse>,
  };
}

interface FakeSeam extends RacecardsDryRunReadSeam {
  calls: string[];
}

function fakeSeam(options: {
  dateCount?: number;
  providerRaces?: ExistingProviderRaceRow[];
  races?: ExistingRaceRow[];
  runners?: ExistingRunnerRow[];
  failOn?:
    | 'countRacesForDate'
    | 'findRacesByProviderIds'
    | 'findRacesByOffTimes'
    | 'findRunnersForRaces';
} = {}): FakeSeam {
  const calls: string[] = [];
  const maybeFail = (name: string) => {
    if (options.failOn === name) throw new Error(`${name} failed: fixture read error`);
  };
  return {
    calls,
    async countRacesForDate(date) {
      calls.push(`countRacesForDate(${date})`);
      maybeFail('countRacesForDate');
      return options.dateCount ?? 0;
    },
    async findRacesByProviderIds(providerRaceIds) {
      calls.push(`findRacesByProviderIds(${providerRaceIds.length})`);
      maybeFail('findRacesByProviderIds');
      return options.providerRaces ?? [];
    },
    async findRacesByOffTimes(offTimes) {
      calls.push(`findRacesByOffTimes(${offTimes.length})`);
      maybeFail('findRacesByOffTimes');
      return options.races ?? [];
    },
    async findRunnersForRaces(raceIds) {
      calls.push(`findRunnersForRaces(${raceIds.length})`);
      maybeFail('findRunnersForRaces');
      return options.runners ?? [];
    },
  };
}

async function preview(
  cards: StandardRacecard[],
  seamOptions: Parameters<typeof fakeSeam>[0] = {},
): Promise<{ report: RacecardsDryRunReport; client: FakeClient; seam: FakeSeam }> {
  const client = fakeClient({ standard: { racecards: cards } });
  const seam = fakeSeam(seamOptions);
  const report = await runRacecardsDryRun('tomorrow', {
    client,
    reads: seam,
    tier: 'standard',
    now: NOW,
  });
  return { report, client, seam };
}

/* ========================================================================== *
 * 1-5. Argument contract
 * ========================================================================== */

test('1. only today and tomorrow are accepted as --day', () => {
  assert.equal(parseRacecardsDryRunArgs(['--day', 'today']).day, 'today');
  assert.equal(parseRacecardsDryRunArgs(['--day', 'today']).error, null);
  assert.equal(parseRacecardsDryRunArgs(['--day', 'tomorrow']).day, 'tomorrow');
  assert.equal(parseRacecardsDryRunArgs(['--day', 'tomorrow']).error, null);

  // Case and spacing are NOT silently normalised — an exact value or nothing.
  for (const bad of ['Today', 'TOMORROW', ' today', 'yesterday', '']) {
    const parsed = parseRacecardsDryRunArgs(['--day', bad]);
    assert.equal(parsed.day, null, `--day "${bad}" must not resolve`);
    assert.ok(parsed.error, `--day "${bad}" must report an error`);
  }
  assert.equal(isPreviewDay('today'), true);
  assert.equal(isPreviewDay('tomorrow'), true);
  assert.equal(isPreviewDay('2026-08-17'), false);
});

test('2. arbitrary dates and date ranges are rejected', () => {
  for (const bad of [
    ['--day', '2026-08-17'],
    ['--date', '2026-08-17'],
    ['--day', '2026-08-17..2026-08-18'],
    ['--from', '2026-08-17', '--to', '2026-08-18'],
  ]) {
    const parsed = parseRacecardsDryRunArgs(bad);
    assert.ok(parsed.error, `${bad.join(' ')} must be rejected`);
    assert.equal(parsed.day, null);
  }
});

test('3. --commit is rejected and no commit field exists', () => {
  const parsed = parseRacecardsDryRunArgs(['--day', 'tomorrow', '--commit']);
  assert.match(parsed.error ?? '', /DRY RUN and has no --commit flag/);
  assert.deepEqual(Object.keys(parsed).sort(), ['day', 'error', 'json']);
  // The args type itself must never grow a commit member.
  assert.doesNotMatch(CLI(), /commit\??\s*:\s*boolean/);
});

test('4. unknown flags and stray positional arguments are rejected', () => {
  assert.match(parseRacecardsDryRunArgs(['--day', 'today', '--course']).error ?? '', /unknown flag/);
  assert.match(parseRacecardsDryRunArgs(['--day', 'today', '--force']).error ?? '', /unknown flag/);
  assert.match(parseRacecardsDryRunArgs(['--day', 'today', 'extra']).error ?? '', /unexpected argument/);
});

test('5. a missing --day is rejected, never defaulted to today', () => {
  assert.equal(parseRacecardsDryRunArgs([]).day, null);
  assert.equal(parseRacecardsDryRunArgs([]).error, null, 'absence is a usage case, not a bad value');
  assert.equal(parseRacecardsDryRunArgs(['--json']).day, null);
  // --json alone must not imply a day.
  assert.equal(parseRacecardsDryRunArgs(['--json']).json, true);
});

/* ========================================================================== *
 * 6-7. Provider contract
 * ========================================================================== */

test('6. the provider is contacted exactly once on a valid run', async () => {
  const { client } = await preview([FULL_CARD, SPARSE_CARD]);
  assert.equal(client.calls.length, 1, 'exactly one provider call');
  assert.match(client.calls[0], /^getStandardRacecards\(/);
});

test('7. the correct day and region scope reach the provider', async () => {
  const client = fakeClient({ standard: { racecards: [] } });
  await runRacecardsDryRun('tomorrow', {
    client,
    reads: fakeSeam(),
    tier: 'standard',
    now: NOW,
  });
  assert.deepEqual(client.calls, ['getStandardRacecards(tomorrow,gb+ire)']);
  assert.deepEqual([...RACECARDS_DRY_RUN_REGIONS], ['gb', 'ire']);

  const client2 = fakeClient({ standard: { racecards: [] } });
  await runRacecardsDryRun('today', { client: client2, reads: fakeSeam(), tier: 'standard', now: NOW });
  assert.deepEqual(client2.calls, ['getStandardRacecards(today,gb+ire)']);
});

test('7b. the basic tier and the Standard-plan fallback mirror liveSync exactly', async () => {
  // basic tier -> basic endpoint directly, standard endpoint never touched.
  const basic = fakeClient({ basic: { racecards: [SPARSE_CARD] } });
  const r1 = await runRacecardsDryRun('today', {
    client: basic,
    reads: fakeSeam(),
    tier: 'basic',
    now: NOW,
  });
  assert.deepEqual(basic.calls, ['getBasicRacecards(today,gb+ire)']);
  assert.equal(r1.tier_used, 'basic');
  assert.equal(r1.tier_requested, 'basic');

  // standard tier + "Standard Plan required" -> falls back to basic.
  const fallback = fakeClient({
    standard: () => {
      throw new Error('Racing API 403 for /racecards/standard: Standard Plan required');
    },
    basic: { racecards: [SPARSE_CARD] },
  });
  const r2 = await runRacecardsDryRun('today', {
    client: fallback,
    reads: fakeSeam(),
    tier: 'standard',
    now: NOW,
  });
  assert.deepEqual(fallback.calls, [
    'getStandardRacecards(today,gb+ire)',
    'getBasicRacecards(today,gb+ire)',
  ]);
  assert.equal(r2.tier_used, 'basic');
  assert.ok(r2.warnings.some((w) => /endpoint served the cards/.test(w)));

  // any OTHER provider error is rethrown, NEVER masked as an empty card list.
  const broken = fakeClient({
    standard: () => {
      throw new Error('Racing API 429 rate-limited for /racecards/standard');
    },
  });
  await assert.rejects(
    runRacecardsDryRun('today', { client: broken, reads: fakeSeam(), tier: 'standard', now: NOW }),
    /429/,
  );
  assert.deepEqual(broken.calls, ['getStandardRacecards(today,gb+ire)']);
});

/* ========================================================================== *
 * 8. Real mapping module
 * ========================================================================== */

test('8. the REAL Programme 0 mappers produce the previewed rows', () => {
  const pass = mapPreviewCards([FULL_CARD, SPARSE_CARD]);
  // Identity with the mapper's own output, field for field — nothing restated.
  assert.deepEqual(pass.mapped[0].race, racecardToRaceUpsert(FULL_CARD));
  assert.deepEqual(pass.mapped[1].race, racecardToRaceUpsert(SPARSE_CARD));
  assert.deepEqual(pass.mapped[0].runners[0], racecardRunnerToUpsert(FULL_RUNNER));
  assert.deepEqual(pass.mapped[0].runners[1], racecardRunnerToUpsert(BARE_RUNNER));

  // ...and the module consumes them from raceSync rather than owning a copy.
  const src = LIB();
  assert.match(src, /from '\.\/raceSync'/);
  assert.match(src, /racecardToRaceUpsert/);
  assert.match(src, /racecardRunnerToUpsert/);
  assert.match(src, /normalizeHorseName/);
  // No second slug / course-key / off-time rule may live here.
  assert.doesNotMatch(src, /function\s+(raceSlug|courseKey|normalizeCourse|resolveOffTime)\s*\(/);
});

/* ========================================================================== *
 * 9-10. Skip classification
 * ========================================================================== */

test('9. abandoned cards are counted as skipped, never mapped', async () => {
  const { report } = await preview([FULL_CARD, ABANDONED_CARD]);
  assert.equal(report.cards_returned, 2);
  assert.equal(report.cards_skipped_abandoned, 1);
  assert.equal(report.cards_skipped_invalid, 0);
  assert.equal(report.races_mapped, 1);
  // The skip DECISION is the mapper's, not a rule restated in the preview.
  assert.equal(racecardToRaceUpsert(ABANDONED_CARD), null);
});

test('10. unmappable cards are counted as invalid, separately from abandoned', async () => {
  const { report } = await preview([FULL_CARD, INVALID_CARD, ABANDONED_CARD]);
  assert.equal(report.cards_returned, 3);
  assert.equal(report.cards_skipped_abandoned, 1);
  assert.equal(report.cards_skipped_invalid, 1);
  assert.equal(report.races_mapped, 1);
  assert.ok(report.warnings.some((w) => /could not be mapped/.test(w)));
});

/* ========================================================================== *
 * 11-12. Programme 0 coverage
 * ========================================================================== */

test('11. race-field coverage counts exactly the populated Programme 0 columns', async () => {
  const { report } = await preview([FULL_CARD, SPARSE_CARD]);
  assert.equal(report.races_mapped, 2);
  assert.deepEqual(report.race_field_coverage, {
    provider_race_id: 1,
    provider_course_id: 1,
    course_key: 2,
    race_slug: 2,
    race_type: 1,
    going: 1,
    distance: 1,
    distance_f: 1,
    race_class: 1,
    age_band: 1,
    pattern: 1,
    field_size: 1,
    // `false` is a recorded value, not an absent one.
    is_abandoned: 1,
  });

  // The measured field list is exactly the Programme 0 race surface.
  assert.deepEqual(
    [...RACE_COVERAGE_FIELDS],
    [
      'provider_race_id',
      'provider_course_id',
      'course_key',
      'race_slug',
      'race_type',
      'going',
      'distance',
      'distance_f',
      'race_class',
      'age_band',
      'pattern',
      'field_size',
      'is_abandoned',
    ],
  );
});

test('11b. a populated `false` and a populated `0` are not mistaken for absent', () => {
  const cover = raceFieldCoverage([
    { ...racecardToRaceUpsert(FULL_CARD)!, is_abandoned: false, field_size: 0 },
  ]);
  assert.equal(cover.is_abandoned, 1);
  assert.equal(cover.field_size, 1);

  const runnerCover = runnerFieldCoverage([
    { ...racecardRunnerToUpsert(FULL_RUNNER)!, draw: 0, age: 0 },
  ]);
  assert.equal(runnerCover.draw, 1);
  assert.equal(runnerCover.age, 1);
});

test('12. runner-field coverage counts exactly the populated Programme 0 columns', async () => {
  const { report } = await preview([FULL_CARD, SPARSE_CARD]);
  assert.equal(report.runner_records_returned, 4);
  assert.equal(report.runner_records_on_mapped_races, 4);
  assert.equal(report.runners_mapped, 3);
  assert.equal(report.runners_skipped_invalid, 1);
  assert.deepEqual(report.runner_field_coverage, {
    provider_horse_id: 1,
    trainer_id: 1,
    jockey_id: 1,
    age: 1,
    draw: 1,
    official_rating: 1,
    weight_lbs: 1,
    trainer: 1,
    jockey: 1,
  });
  assert.deepEqual(
    [...RUNNER_COVERAGE_FIELDS],
    [
      'provider_horse_id',
      'trainer_id',
      'jockey_id',
      'age',
      'draw',
      'official_rating',
      'weight_lbs',
      'trainer',
      'jockey',
    ],
  );
});

/* ========================================================================== *
 * 13-16. Planned-action logic
 * ========================================================================== */

test('13. existing races match on course + off_time, comparing the off time as an INSTANT', async () => {
  // The database renders timestamptz as "+00:00"; the mapper emits ".000Z".
  // Postgres treats those as equal, so the preview must too.
  const stored: ExistingRaceRow = {
    id: 'race-1',
    course: 'Fixtureton',
    off_time: `${SELECTED_DATE}T13:05:00+00:00`,
  };
  const { report } = await preview([FULL_CARD, SPARSE_CARD], { races: [stored] });
  assert.equal(report.races_existing, 1);
  assert.equal(report.races_planned_insert, 1);

  assert.equal(
    raceMatchKey('Fixtureton', `${SELECTED_DATE}T13:05:00+00:00`),
    raceMatchKey('Fixtureton', FULL_CARD_INSTANT),
  );

  // A different course at the same instant is a DIFFERENT race.
  const otherCourse = await preview([FULL_CARD], {
    races: [{ ...stored, course: 'Elsewhere' }],
  });
  assert.equal(otherCourse.report.races_existing, 0);
  assert.equal(otherCourse.report.races_planned_insert, 1);

  // The same course at a corrected off time is ALSO a different race — the
  // known Programme 0 limitation, reproduced rather than papered over.
  const shifted = await preview([FULL_CARD], {
    races: [{ ...stored, off_time: `${SELECTED_DATE}T13:10:00+00:00` }],
  });
  assert.equal(shifted.report.races_existing, 0);
  assert.equal(shifted.report.races_planned_insert, 1);

  // An unparseable stored off time can match nothing.
  assert.equal(raceMatchKey('Fixtureton', 'not-a-time'), null);
  assert.equal(indexExistingRaces([{ id: 'x', course: 'A', off_time: null }]).size, 0);
});

test('14. existing runners match on the normalised horse name', async () => {
  const stored: ExistingRaceRow = {
    id: 'race-1',
    course: 'Fixtureton',
    off_time: `${SELECTED_DATE}T13:05:00+00:00`,
  };
  // Stored as "(GB)", card says "(IRE)" — both normalise to "fixture runner".
  const { report, seam } = await preview([FULL_CARD], {
    races: [stored],
    runners: [{ race_id: 'race-1', horse_name: 'Fixture Runner (GB)' }],
  });
  assert.equal(report.runners_existing, 1);
  assert.equal(report.runners_planned_insert, 1, 'the bare runner is still new');
  assert.ok(seam.calls.includes('findRunnersForRaces(1)'));

  const index = indexExistingRunners([
    { race_id: 'race-1', horse_name: 'Fixture Runner (GB)' },
    { race_id: 'race-1', horse_name: 'Another Horse' },
  ]);
  assert.equal(index.get('race-1')?.has('fixture runner'), true);
  assert.equal(index.get('race-1')?.size, 2);
});

test('15. planned inserts are counted correctly on a wholly new date', async () => {
  const { report, seam } = await preview([FULL_CARD, SPARSE_CARD]);
  assert.equal(report.races_planned_insert, 2);
  assert.equal(report.races_existing, 0);
  assert.equal(report.runners_planned_insert, 3);
  assert.equal(report.runners_existing, 0);
  // With no matched race there is nothing to look runners up against.
  assert.ok(!seam.calls.some((c) => c.startsWith('findRunnersForRaces')));
});

test('16. existing rows are counted correctly and never double-counted', async () => {
  const races: ExistingRaceRow[] = [
    { id: 'race-1', course: 'Fixtureton', off_time: `${SELECTED_DATE}T13:05:00+00:00` },
    { id: 'race-2', course: 'Sparseton', off_time: `${SELECTED_DATE}T15:00:00+00:00` },
  ];
  const runners: ExistingRunnerRow[] = [
    { race_id: 'race-1', horse_name: 'Fixture Runner' },
    { race_id: 'race-1', horse_name: 'Bare Fixture Runner' },
    { race_id: 'race-2', horse_name: 'Bare Fixture Runner' },
  ];
  const { report } = await preview([FULL_CARD, SPARSE_CARD], { races, runners, dateCount: 2 });
  assert.equal(report.races_existing, 2);
  assert.equal(report.races_planned_insert, 0);
  assert.equal(report.runners_existing, 3);
  assert.equal(report.runners_planned_insert, 0);
  assert.equal(report.duplicate_cards_in_provider_response, 0);
  assert.equal(report.runners_matched_within_provider_response, 0);
  // Every mapped race and every mapped runner lands in exactly one bucket,
  // including the ambiguous ones introduced with provider-id-first resolution.
  assert.equal(report.races_provider_id_ambiguous, 0);
  assert.equal(report.runners_on_ambiguous_races, 0);
  assert.equal(
    report.races_mapped,
    report.races_existing +
      report.races_planned_insert +
      report.duplicate_cards_in_provider_response +
      report.races_provider_id_ambiguous,
  );
  assert.equal(
    report.runners_mapped,
    report.runners_existing +
      report.runners_planned_insert +
      report.runners_matched_within_provider_response +
      report.runners_on_ambiguous_races,
  );
});

/* ========================================================================== *
 * 17-18. Empty-date gate
 * ========================================================================== */

test('17. first-capture suitability is true only when the date holds no races', async () => {
  const empty = await preview([FULL_CARD], { dateCount: 0 });
  assert.equal(empty.report.existing_races_for_selected_date, 0);
  assert.equal(empty.report.first_capture_suitable, true);
  assert.equal(empty.report.selected_date, SELECTED_DATE);
  assert.ok(empty.seam.calls.includes(`countRacesForDate(${SELECTED_DATE})`));

  for (const count of [1, 7, 40]) {
    const populated = await preview([FULL_CARD], { dateCount: count });
    assert.equal(populated.report.existing_races_for_selected_date, count);
    assert.equal(populated.report.first_capture_suitable, false);
  }
});

test('18. an already-populated date is explicitly NOT SUITABLE and promises no enrichment', async () => {
  const { report } = await preview([FULL_CARD], { dateCount: 12 });
  const out = renderRacecardsDryRunConsole(report).join('\n');
  assert.match(out, /NOT SUITABLE FOR FIRST-CAPTURE VERIFICATION/);
  assert.doesNotMatch(out, /\bSUITABLE FOR FIRST-CAPTURE VERIFICATION\b(?<!NOT SUITABLE FOR FIRST-CAPTURE VERIFICATION)/);
  assert.match(out, /never updates an existing/i);
  assert.ok(
    report.warnings.some((w) => /would NOT gain Programme 0 fields/.test(w)),
    'the operator must be told stored rows are not enriched',
  );

  const suitable = await preview([FULL_CARD], { dateCount: 0 });
  const okOut = renderRacecardsDryRunConsole(suitable.report).join('\n');
  // Wording strengthened by review finding M-2: emptiness alone is no longer
  // the whole claim, so the banner now states the destination condition too.
  assert.match(
    okOut,
    /SUITABLE FOR FIRST-CAPTURE VERIFICATION \(selected date empty; every mapped race targets it\)/,
  );
  assert.doesNotMatch(okOut, /NOT SUITABLE/);
});

/* ========================================================================== *
 * 19-20. Security and redaction
 * ========================================================================== */

test('19. no provider identifier reaches the output, in either format', async () => {
  const { report } = await preview([FULL_CARD, SPARSE_CARD, ABANDONED_CARD, INVALID_CARD], {
    races: [{ id: 'race-1', course: 'Fixtureton', off_time: `${SELECTED_DATE}T13:05:00+00:00` }],
    runners: [{ race_id: 'race-1', horse_name: 'Fixture Runner (GB)' }],
    dateCount: 3,
  });
  const rendered = renderRacecardsDryRunConsole(report).join('\n');
  const json = JSON.stringify(report);

  const identifiers = [
    'rac_11110000',
    'crs_22220000',
    'hrs_33330000',
    'trn_44440000',
    'jck_55550000',
    'race-1',
    'Fixtureton',
    'Sparseton',
    'Fixture Runner',
    'Fixture Trainer',
    'Fixture Jockey',
    'Fixture Handicap Stakes',
  ];
  for (const id of identifiers) {
    assert.ok(!rendered.includes(id), `console output must not contain "${id}"`);
    assert.ok(!json.includes(id), `json output must not contain "${id}"`);
  }
  // Not even a truncated/prefixed provider handle.
  assert.doesNotMatch(rendered, /\b(rac|crs|hrs|trn|jck)_/);
  assert.doesNotMatch(json, /\b(rac|crs|hrs|trn|jck)_/);
});

test('20. no secret can reach the output', () => {
  const lib = LIB();
  const cli = CLI();

  // The library never touches a credential at all.
  for (const secret of [
    'CRON_SECRET',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_URL',
    'RACING_API_KEY',
    'RACING_API_USER',
    'BETFAIR_',
  ]) {
    assert.ok(!lib.includes(secret), `${LIB_PATH} must not reference ${secret}`);
  }
  // The CLI checks PRESENCE only, and never prints an env value.
  for (const line of cli.split(/\r?\n/)) {
    if (/console\.(log|error|warn|info)/.test(line)) {
      assert.doesNotMatch(line, /process\.env/, `console line must not carry an env value: ${line}`);
    }
  }
  assert.doesNotMatch(cli, /CRON_SECRET/);
  // Presence checks are negations, never assignments into a printable variable.
  assert.doesNotMatch(cli, /(const|let|var)\s+\w+\s*=\s*process\.env\./);
});

/* ========================================================================== *
 * 21-24. Read-only boundary and absence of side effects
 * ========================================================================== */

test('21. the read seam declares no mutation method', () => {
  const src = LIB();
  const start = src.indexOf('export interface RacecardsDryRunReadSeam');
  assert.ok(start > 0, 'the seam interface must exist');
  const block = src.slice(start);
  const seamInterface = block.slice(0, block.indexOf('\n}\n') + 2);
  const methods = [...seamInterface.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]);
  assert.deepEqual(methods.sort(), [
    'countRacesForDate',
    'findRacesByOffTimes',
    'findRacesByProviderIds',
    'findRunnersForRaces',
  ]);
  for (const name of methods) {
    // "run" is deliberately absent from this list: `findRunnersForRaces` reads
    // RUNNERS, and a name-shape check must not mistake the domain noun for a
    // verb. The forbidden set is mutation vocabulary only.
    assert.doesNotMatch(
      name,
      /insert|update|upsert|delete|write|persist|save|mutate|commit|acquire|heartbeat|release|settle/i,
      `seam method "${name}" implies a mutation`,
    );
  }

  // The live implementation supplies exactly those three and nothing more.
  const seamKeys = Object.keys(fakeSeam()).filter((k) => k !== 'calls');
  assert.deepEqual(seamKeys.sort(), [
    'countRacesForDate',
    'findRacesByOffTimes',
    'findRacesByProviderIds',
    'findRunnersForRaces',
  ]);
});

test('22. no insert / update / upsert / delete / rpc call exists in either file', () => {
  for (const [path, src] of [
    [LIB_PATH, LIB()],
    [CLI_PATH, CLI()],
  ] as const) {
    assert.doesNotMatch(src, /\.insert\s*\(/, `${path} must not insert`);
    assert.doesNotMatch(src, /\.update\s*\(/, `${path} must not update`);
    assert.doesNotMatch(src, /\.upsert\s*\(/, `${path} must not upsert`);
    assert.doesNotMatch(src, /\.delete\s*\(/, `${path} must not delete`);
    assert.doesNotMatch(src, /\.rpc\s*\(/, `${path} must not call an rpc`);
    assert.doesNotMatch(src, /\.storage\b/, `${path} must not touch storage`);
    // No local file is written either.
    assert.doesNotMatch(src, /writeFileSync|createWriteStream|appendFileSync|mkdirSync/, path);
  }
  // Only `select` reaches Supabase in the live seam.
  const cli = CLI();
  const supabaseCalls = [...cli.matchAll(/supabaseAdmin\s*\n?\s*\.from\([^)]*\)\s*\n?\s*\.(\w+)/g)].map(
    (m) => m[1],
  );
  assert.ok(supabaseCalls.length >= 3, 'the seam must issue its reads through supabaseAdmin');
  for (const call of supabaseCalls) assert.equal(call, 'select');
});

test('23. no cron log, sync log or other telemetry row is written', () => {
  for (const src of [LIB_CODE(), CLI_CODE()]) {
    assert.doesNotMatch(src, /recordCronRun|buildCronRunRecord|cronHeartbeat/);
    assert.doesNotMatch(src, /cron_runs|sync_log/);
  }
});

test('24. no producer claim is acquired, renewed, released or even inspected', () => {
  for (const src of [LIB_CODE(), CLI_CODE()]) {
    assert.doesNotMatch(src, /producerClaim|producerOwnership|nationwideOwnership/);
    assert.doesNotMatch(src, /producer_run_claims|producer_claim_status/);
    assert.doesNotMatch(src, /try_acquire_producer_claim|heartbeat_producer_claim|release_producer_claim/);
    // ...and no route is invoked, so no ownership context is needed at all.
    assert.doesNotMatch(src, /ownershipContext|routeOwnershipGuard|ownershipPropagation/);
    assert.doesNotMatch(src, /callCron|\/api\/cron\/|fetch\s*\(/);
    // No model, lock, settlement or ML path.
    assert.doesNotMatch(src, /runModelForRace|scoreRaceRunners|lockTMinus|locked_race_decisions/);
    assert.doesNotMatch(src, /settle|autoResults|importResults|mlCapture|genai/i);
  }
});

/* ========================================================================== *
 * 25-27. Failure paths
 * ========================================================================== */

test('25. a provider failure propagates and reaches no database read', async () => {
  const client = fakeClient({
    standard: () => {
      throw new Error('Racing API 500 for /racecards/standard');
    },
  });
  const seam = fakeSeam();
  await assert.rejects(
    runRacecardsDryRun('tomorrow', { client, reads: seam, tier: 'standard', now: NOW }),
    (err: unknown) => {
      assert.ok(err instanceof RacecardsDryRunFailure);
      assert.equal(err.stage, 'provider_racecards_fetch');
      // The status survives as safe generic context; nothing raw is retained.
      assert.match(err.detail, /Racing API 500/);
      return true;
    },
  );
  assert.deepEqual(seam.calls, [], 'no database read after a provider failure');
});

test('26. a database-read failure propagates and is never degraded to a zero', async () => {
  for (const failOn of ['countRacesForDate', 'findRacesByOffTimes', 'findRunnersForRaces'] as const) {
    const seamOptions: Parameters<typeof fakeSeam>[0] = {
      failOn,
      races: [{ id: 'race-1', course: 'Fixtureton', off_time: `${SELECTED_DATE}T13:05:00+00:00` }],
    };
    const expectedStage =
      failOn === 'countRacesForDate'
        ? 'existing_race_date_count'
        : failOn === 'findRacesByOffTimes'
          ? 'existing_race_lookup'
          : 'existing_runner_lookup';
    await assert.rejects(
      runRacecardsDryRun('tomorrow', {
        client: fakeClient({ standard: { racecards: [FULL_CARD] } }),
        reads: fakeSeam(seamOptions),
        tier: 'standard',
        now: NOW,
      }),
      (err: unknown) => {
        assert.ok(err instanceof RacecardsDryRunFailure, `${failOn} must surface as a typed failure`);
        assert.equal(err.stage, expectedStage, `${failOn} must carry its own stage`);
        assert.match(err.detail, new RegExp(`${failOn} failed`));
        return true;
      },
      `${failOn} must surface, not silently return 0`,
    );
  }
});

test('27. invalid arguments reach neither the provider nor the database', () => {
  const cli = CLI();
  const mainStart = cli.indexOf('async function main()');
  assert.ok(mainStart > 0);
  const body = cli.slice(mainStart);
  const argCheck = body.indexOf('process.exitCode = 1');
  const clientBuild = body.indexOf('createRacingApiClient(');
  const seamUse = body.indexOf('reads: supabaseRacecardsReadSeam');
  assert.ok(argCheck > 0 && clientBuild > 0 && seamUse > 0);
  assert.ok(argCheck < clientBuild, 'arguments are validated before the provider client is built');
  assert.ok(argCheck < seamUse, 'arguments are validated before any database read');
  // The parser function itself is pure — it cannot reach anything. Scoped to
  // the function alone (the read seam is declared between it and main()).
  const parserStart = cli.indexOf('export function parseRacecardsDryRunArgs');
  const parserEnd = cli.indexOf('const READ_CHUNK');
  assert.ok(parserStart > 0 && parserEnd > parserStart);
  assert.doesNotMatch(
    cli.slice(parserStart, parserEnd),
    /supabaseAdmin|createRacingApiClient|await|async/,
  );
});

/* ========================================================================== *
 * 28. JSON output
 * ========================================================================== */

test('28. --json emits aggregates only, under a fixed key set', async () => {
  const { report } = await preview([FULL_CARD, SPARSE_CARD], { dateCount: 0 });
  assert.deepEqual(Object.keys(report).sort(), [
    'cards_returned',
    'cards_skipped_abandoned',
    'cards_skipped_invalid',
    'day',
    'duplicate_cards_in_provider_response',
    'existing_races_for_selected_date',
    'first_capture_suitable',
    'mapped_date_mismatch_count',
    'mapped_date_missing_count',
    'mapped_dates_matching_selected',
    'mapped_destination_date_count',
    'race_field_coverage',
    'races_existing',
    'races_mapped',
    'races_planned_insert',
    'races_provider_id_ambiguous',
    'regions',
    'runner_field_coverage',
    'runner_records_on_mapped_races',
    'runner_records_on_skipped_cards',
    'runner_records_returned',
    'runners_existing',
    'runners_mapped',
    'runners_matched_within_provider_response',
    'runners_on_ambiguous_races',
    'runners_planned_insert',
    'runners_skipped_invalid',
    'schema_version',
    'selected_date',
    'tier_requested',
    'tier_used',
    'warnings',
  ]);

  // Every leaf is a count, a fixed label, or warning prose — no row payloads.
  for (const [key, value] of Object.entries(report)) {
    if (key === 'race_field_coverage' || key === 'runner_field_coverage') {
      for (const n of Object.values(value as Record<string, unknown>)) {
        assert.equal(typeof n, 'number');
      }
      continue;
    }
    if (key === 'warnings' || key === 'regions') {
      assert.ok(Array.isArray(value));
      for (const item of value as unknown[]) assert.equal(typeof item, 'string');
      continue;
    }
    assert.ok(
      ['number', 'string', 'boolean'].includes(typeof value),
      `${key} must be a scalar aggregate`,
    );
  }
  assert.ok(JSON.parse(JSON.stringify(report)), 'the report must be JSON-serialisable');
});

test('28b. the console banner states the safety posture and the preview footer', async () => {
  const { report } = await preview([FULL_CARD], { dateCount: 0 });
  const lines = renderRacecardsDryRunConsole(report);
  assert.deepEqual(lines.slice(0, 4), [
    'RACECARDS DRY RUN',
    'NO DATABASE WRITES',
    'NO PRODUCER CLAIM',
    'NO ODDS, MODEL, LOCK OR RESULT ACTION',
  ]);
  const out = lines.join('\n');
  assert.match(
    out,
    /This is a preview\. Database state and provider data may change before a separately\nauthorised commit run\./,
  );
  // Planned, never guaranteed.
  assert.match(out, /PLANNED RACE ACTIONS/);
  assert.match(out, /PLANNED RUNNER ACTIONS/);
  assert.match(out, /Would appear NEW/);
  assert.doesNotMatch(out, /will be (inserted|written)/i);

  // Warnings are always rendered, including the empty case.
  assert.match(renderRacecardsDryRunConsole({ ...report, warnings: [] }).join('\n'), /WARNINGS \(0\)\n {2}none/);
  assert.deepEqual(buildWarnings({ ...report, cards_returned: 0 }).slice(0, 1), [
    'The provider returned no cards for this day. Nothing would be captured.',
  ]);
});

/* ========================================================================== *
 * 29-30. Behaviour preservation
 * ========================================================================== */

test('29. existing Programme 0 tests and registrations remain intact', () => {
  const tests = readFileSync('scripts/tests.ts', 'utf8');
  assert.match(tests, /import '\.\/canonicalRaceIdentity\.test';/);
  assert.match(tests, /import '\.\/raceSync\.test';/);
  assert.match(tests, /import '\.\/racecardsDryRun\.test';/);

  // The Programme 0 handoff contract was deliberately SUPERSEDED when
  // resolution moved onto provider identity; its replacement must still be
  // present, so the identity contract is never simply deleted.
  const p0 = readFileSync('scripts/canonicalRaceIdentity.test.ts', 'utf8');
  assert.match(
    p0,
    /IDENTITY RESOLUTION: provider id first, course \+ off_time fallback \(handoff contract\)/,
  );
  assert.equal(
    /P0 KNOWN CONSTRAINT: identity is captured, not resolved/.test(p0),
    false,
    'the superseded contract must not linger alongside its replacement',
  );

  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(pkg.scripts['racecards:dry-run'], 'tsx scripts/racecardsDryRun.ts');
  // The new command must not shadow or rename an existing one.
  assert.equal(pkg.scripts['nationwide:dry-run'], 'tsx scripts/nationwideDryRun.ts');
  assert.equal(pkg.scripts['pipeline:day'], 'tsx scripts/runRaceDayPipeline.ts');
});

test('30. no executable ingestion, route or model path was changed', () => {
  // The real ingestion write path is untouched and still insert-only.
  const liveSync = readFileSync('src/lib/liveSync.ts', 'utf8');
  assert.match(liveSync, /export async function syncRacecards\(/);
  assert.match(liveSync, /\.from\('races'\)\s*\.insert\(\{ id: raceId, \.\.\.raceRow \}\)/);
  assert.match(liveSync, /\.eq\('course', course\)\s*\n\s*\.eq\('off_time', offTimeIso\)/);
  assert.doesNotMatch(liveSync, /racecardsDryRun/);

  // The mappers are still the single source of mapping truth.
  const raceSync = readFileSync('src/lib/raceSync.ts', 'utf8');
  assert.match(raceSync, /export function racecardToRaceUpsert\(/);
  assert.match(raceSync, /export function racecardRunnerToUpsert\(/);
  assert.doesNotMatch(raceSync, /racecardsDryRun/);

  // The guarded route keeps auth THEN ownership, before any provider call.
  const route = readFileSync('src/app/api/cron/racecards/route.ts', 'utf8');
  const authAt = route.indexOf('requireCronSecret(');
  const ownershipAt = route.indexOf('enforceRouteOwnership(');
  const syncAt = route.indexOf('syncRacecards({');
  assert.ok(authAt > 0 && ownershipAt > authAt && syncAt > ownershipAt);
  assert.doesNotMatch(route, /racecardsDryRun/);

  // Nothing in the running application imports the preview: it is CLI-only.
  for (const file of [
    'src/lib/liveSync.ts',
    'src/lib/raceSync.ts',
    'src/lib/runModelForRace.ts',
    'src/app/api/cron/racecards/route.ts',
    'src/app/api/run-model/route.ts',
  ]) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /racecardsDryRun/, `${file} must not import it`);
  }
});

/* ========================================================================== *
 * 31-33. M-1: failure output is redacted
 * ========================================================================== */

test('31. M-1: a hostile error is stripped of every protected value and truncated', () => {
  const detail = redactPreviewDetail(HOSTILE_ERROR);
  const rendered = renderPreviewFailure(HOSTILE_ERROR).join('\n');

  for (const value of PROTECTED_VALUES) {
    assert.ok(!detail.includes(value), `detail must not contain "${value}"`);
    assert.ok(!rendered.includes(value), `rendered failure must not contain "${value}"`);
  }
  // No provider handle survives in any form, not even a truncated one.
  assert.doesNotMatch(rendered, /\b(rac|crs|hrs|trn|jck)_/);
  // No scheme-bearing URL survives.
  assert.doesNotMatch(rendered, /[a-z][a-z0-9+.-]*:\/\//i);
  // No JWT-shaped value survives.
  assert.doesNotMatch(rendered, /\beyJ[A-Za-z0-9._-]{10,}/);

  // Truncated: the hard ceiling, plus at most the single ellipsis character.
  assert.ok(
    detail.length <= MAX_PREVIEW_DETAIL_LENGTH + 1,
    `detail length ${detail.length} must not exceed ${MAX_PREVIEW_DETAIL_LENGTH} + ellipsis`,
  );
  assert.ok(HOSTILE_ERROR.message.length > 400, 'the fixture must actually need truncating');

  // Safe generic context is retained.
  assert.match(rendered, /RACECARDS DRY RUN FAILED/);
  assert.match(rendered, /NO DATABASE WRITES OCCURRED/);
  assert.match(rendered, /Stage {2}:/);
  assert.match(rendered, /Detail :/);

  // Non-Error inputs are handled without throwing and without leaking.
  assert.equal(redactPreviewDetail(undefined), 'unknown error');
  assert.equal(redactPreviewDetail(null), 'unknown error');
  assert.equal(redactPreviewDetail(''), 'unknown error');
  assert.ok(!redactPreviewDetail({ message: 'rac_11110000 broke' }).includes('rac_11110000'));
  // A PostgREST-shaped object contributes its code but not raw identifiers.
  const pg = redactPreviewDetail({ code: '42501', message: 'permission denied for table races' });
  assert.match(pg, /42501/);
  assert.match(pg, /permission denied/);
});

test('32. M-1: every failure stage stays distinguishable through the redacted output', async () => {
  const stages = [
    'provider_racecards_fetch',
    'existing_race_date_count',
    'existing_race_lookup',
    'existing_runner_lookup',
  ] as const;

  const labels = new Set<string>();
  for (const stage of stages) {
    const failure = RacecardsDryRunFailure.from(stage, HOSTILE_ERROR);
    assert.equal(failure.stage, stage);
    assert.equal(describePreviewFailure(failure).stage, stage);

    const lines = renderPreviewFailure(failure);
    const rendered = lines.join('\n');
    for (const value of PROTECTED_VALUES) assert.ok(!rendered.includes(value));
    const stageLine = lines.find((l) => l.includes('Stage'));
    assert.ok(stageLine);
    labels.add(stageLine);
  }
  assert.equal(labels.size, stages.length, 'each stage must render a distinct label');

  // An unrecognised throw is classified, never passed through raw.
  const loose = describePreviewFailure(HOSTILE_ERROR);
  assert.equal(loose.stage, 'unclassified');
  for (const value of PROTECTED_VALUES) assert.ok(!loose.detail.includes(value));

  // Re-wrapping never double-redacts or loses the original stage.
  const once = RacecardsDryRunFailure.from('existing_race_lookup', HOSTILE_ERROR);
  assert.equal(RacecardsDryRunFailure.from('provider_racecards_fetch', once), once);

  // The message itself is safe, so even a careless err.message cannot leak.
  for (const value of PROTECTED_VALUES) assert.ok(!once.message.includes(value));

  // ...and a real orchestration failure carries the same guarantee end to end.
  const client = fakeClient({
    standard: () => {
      throw HOSTILE_ERROR;
    },
  });
  await assert.rejects(
    runRacecardsDryRun('tomorrow', { client, reads: fakeSeam(), tier: 'standard', now: NOW }),
    (err: unknown) => {
      assert.ok(err instanceof RacecardsDryRunFailure);
      for (const value of PROTECTED_VALUES) assert.ok(!err.message.includes(value));
      return true;
    },
  );
});

test('33. M-1: the CLI never prints a raw message, object or stack, and still exits 2', () => {
  const cli = CLI();
  const code = CLI_CODE();

  // No raw error text can be printed: the CLI reads no `.message` at all.
  assert.doesNotMatch(code, /\.message/);
  assert.doesNotMatch(code, /String\(\s*err\s*\)/);
  assert.doesNotMatch(code, /\.stack/);

  // The catch renders the redacted block and preserves exit code 2.
  const catchAt = cli.indexOf('main().catch(');
  assert.ok(catchAt > 0);
  const catchBlock = cli.slice(catchAt);
  assert.match(catchBlock, /renderPreviewFailure\(err\)/);
  assert.match(catchBlock, /process\.exitCode = 2/);

  // Wrapped database-read errors are redacted at CONSTRUCTION, so a raw
  // PostgREST message cannot travel inside an Error to another caller.
  const seamBlock = cli.slice(cli.indexOf('supabaseRacecardsReadSeam'), cli.indexOf('const USAGE'));
  const throwSites = [...seamBlock.matchAll(/throw new Error\(`([^`]*)`\)/g)].map((m) => m[1]);
  assert.equal(throwSites.length, 4, 'four wrapped read errors');
  for (const site of throwSites) {
    assert.match(site, /redactPreviewDetail\(/, `unredacted throw site: ${site}`);
    assert.doesNotMatch(site, /error\.message/);
  }
  // Each retains a distinguishable generic context.
  assert.ok(throwSites.some((s) => s.startsWith('races count failed')));
  assert.ok(throwSites.some((s) => s.startsWith('races provider-id lookup failed')));
  assert.ok(throwSites.some((s) => s.startsWith('races lookup failed')));
  assert.ok(throwSites.some((s) => s.startsWith('runners lookup failed')));
});

/* ========================================================================== *
 * 34-36. M-2: mapped destination date versus selected date
 * ========================================================================== */

test('34. M-2: an empty selected date stays suitable when every mapped race targets it', async () => {
  const { report } = await preview([FULL_CARD, SPARSE_CARD], { dateCount: 0 });
  assert.equal(report.mapped_dates_matching_selected, 2);
  assert.equal(report.mapped_date_mismatch_count, 0);
  assert.equal(report.mapped_date_missing_count, 0);
  assert.equal(report.mapped_destination_date_count, 1);
  assert.equal(report.first_capture_suitable, true);
  assert.ok(!report.warnings.some((w) => /OTHER than the selected date/.test(w)));

  assert.deepEqual(summariseDestinationDates([], SELECTED_DATE), {
    matching: 0,
    mismatched: 0,
    missing: 0,
    distinctDates: 0,
  });
});

test('35. M-2: one mapped race destined elsewhere makes the preview UNSUITABLE', async () => {
  const { report } = await preview([FULL_CARD, OTHER_DATE_CARD], { dateCount: 0 });

  assert.equal(report.existing_races_for_selected_date, 0, 'the selected date IS empty');
  assert.equal(report.mapped_dates_matching_selected, 1);
  assert.equal(report.mapped_date_mismatch_count, 1);
  assert.equal(report.mapped_destination_date_count, 2);
  // An empty selected date must NOT override a mismatched destination.
  assert.equal(report.first_capture_suitable, false);

  const mismatchWarning = report.warnings.find((w) => /OTHER than the selected date/.test(w));
  assert.ok(mismatchWarning, 'a mismatch warning is required');
  assert.match(mismatchWarning, /does not tell you whether those destination dates are empty/);
  assert.ok(report.warnings.some((w) => /distinct destination dates/.test(w)));

  // The differing date is NEVER printed, in either output form.
  const human = renderRacecardsDryRunConsole(report).join('\n');
  const json = JSON.stringify(report);
  for (const text of [human, json]) {
    assert.ok(!text.includes(OTHER_DATE), 'the mismatching date must not leak');
    assert.ok(!text.includes('Otherdayton'), 'the course must not leak');
    assert.ok(!text.includes('Other Day Fixture Race'), 'the race name must not leak');
  }
  // The selected date is our own derived value and is expected to appear.
  assert.ok(human.includes(SELECTED_DATE));

  // Human and JSON report the SAME facts, from the same object.
  assert.match(human, /Mapped races destined for another date\s+: 1/);
  assert.match(human, /Mapped races destined for the selected date\s+: 1/);
  assert.match(human, /Distinct destination dates\s+: 2/);
  assert.match(human, /NOT SUITABLE FOR FIRST-CAPTURE VERIFICATION/);
  assert.equal(JSON.parse(json).mapped_date_mismatch_count, 1);
  assert.equal(JSON.parse(json).first_capture_suitable, false);

  // The mismatching card is still counted, never silently discarded.
  assert.equal(report.races_mapped, 2);
  assert.equal(report.cards_skipped_invalid, 0);
  assert.equal(report.cards_skipped_abandoned, 0);
});

test('36. M-2: an unusable meeting date is counted defensively, never as a match', () => {
  const good = racecardToRaceUpsert(FULL_CARD);
  assert.ok(good);
  const summary = summariseDestinationDates(
    [good, { ...good, meeting_date: '' }, { ...good, meeting_date: 'not-a-date' }],
    SELECTED_DATE,
  );
  assert.deepEqual(summary, { matching: 1, mismatched: 0, missing: 2, distinctDates: 1 });

  // A missing destination blocks suitability exactly as a mismatch does, and
  // warns without naming anything.
  const base = {
    existing_races_for_selected_date: 0,
    mapped_date_mismatch_count: 0,
    mapped_date_missing_count: 1,
    mapped_destination_date_count: 1,
    races_mapped: 1,
    first_capture_suitable: false,
    race_field_coverage: raceFieldCoverage([good]),
    warnings: [],
  } as unknown as RacecardsDryRunReport;
  const warning = buildWarnings(base).find((w) => /no well-formed meeting date/.test(w));
  assert.ok(warning);
  assert.ok(!warning.includes('Fixtureton'));

  // The current mapper cannot actually produce one — the guard is future-proofing.
  assert.match(good.meeting_date, /^\d{4}-\d{2}-\d{2}$/);
});

/* ========================================================================== *
 * 37-38. L-1: duplicate cards inside one provider response
 * ========================================================================== */

test('37. L-1: a duplicate card is not a second planned insert', async () => {
  const { report, seam } = await preview([FULL_CARD, DUPLICATE_CARD], { dateCount: 0 });

  assert.equal(report.races_mapped, 2);
  assert.equal(report.races_planned_insert, 1, 'ingestion would insert ONE row');
  assert.equal(report.duplicate_cards_in_provider_response, 1);
  assert.equal(report.races_existing, 0, 'a provider duplicate is NOT a stored race');

  // Equivalent timestamptz forms resolve to the same key.
  assert.equal(
    raceMatchKey('Fixtureton', `${SELECTED_DATE}T14:05:00+01:00`),
    raceMatchKey('Fixtureton', `${SELECTED_DATE}T13:05:00.000Z`),
  );

  // No extra read and no write: one provider lookup, one off-time lookup, no
  // runner lookup (nothing stored). Provider identity is queried FIRST.
  // Two DISTINCT provider ids are queried (the cards carry different ones), and
  // one shared off-time instant. Neither is stored, so the second card falls
  // through to the (course, off_time) fallback and is caught as a duplicate.
  assert.deepEqual(seam.calls, [
    `countRacesForDate(${SELECTED_DATE})`,
    'findRacesByProviderIds(2)',
    'findRacesByOffTimes(1)',
  ]);

  // A genuinely different key stays planned new.
  const distinct = await preview([FULL_CARD, SPARSE_CARD], { dateCount: 0 });
  assert.equal(distinct.report.races_planned_insert, 2);
  assert.equal(distinct.report.duplicate_cards_in_provider_response, 0);

  // No identifier leaks through the duplicate warning.
  const warning = report.warnings.find((w) => /resolve to a key an earlier card/.test(w));
  assert.ok(warning);
  for (const id of ['rac_11110000', 'rac_99990000', 'Fixtureton', 'Fixture Handicap Stakes']) {
    assert.ok(!warning.includes(id));
  }
});

test('38. L-1: duplicate-card runners model production; within-card duplicates do not', async () => {
  // FULL_CARD plans 2 runners. DUPLICATE_CARD repeats one and adds one, so
  // production would find the repeat already inserted and add only the new one.
  const { report } = await preview([FULL_CARD, DUPLICATE_CARD], { dateCount: 0 });
  assert.equal(report.runners_mapped, 4);
  assert.equal(report.runners_planned_insert, 3);
  assert.equal(report.runners_matched_within_provider_response, 1);
  assert.equal(report.runners_existing, 0, 'nothing is stored, so nothing is database-existing');
  assert.equal(
    report.runners_mapped,
    report.runners_planned_insert +
      report.runners_existing +
      report.runners_matched_within_provider_response +
      report.runners_on_ambiguous_races,
  );

  // Within ONE card, production reads the existing names BEFORE inserting, so
  // two identically-named runners are BOTH inserted. That must not change.
  const withinCard: StandardRacecard = {
    ...SPARSE_CARD,
    runners: [{ horse: 'Twin Fixture Runner (IRE)' }, { horse: 'Twin Fixture Runner (GB)' }],
  };
  const twin = await preview([withinCard], { dateCount: 0 });
  assert.equal(twin.report.runners_mapped, 2);
  assert.equal(twin.report.runners_planned_insert, 2, 'both are inserted, as production does');
  assert.equal(twin.report.runners_matched_within_provider_response, 0);
});

/* ========================================================================== *
 * 39. L-2: runner-record denominator
 * ========================================================================== */

test('39. L-2: runner records on skipped cards stay out of the mapped denominator', async () => {
  // FULL_CARD  : mapped, 3 runner records (1 unmappable).
  // ABANDONED  : skipped, 3 runner records that belong to no mapped race.
  const { report } = await preview([FULL_CARD, ABANDONED_CARD], { dateCount: 0 });

  assert.equal(report.cards_skipped_abandoned, 1);
  assert.equal(report.races_mapped, 1);

  assert.equal(report.runner_records_returned, 6);
  assert.equal(report.runner_records_on_skipped_cards, 3);
  assert.equal(report.runner_records_on_mapped_races, 3);
  assert.equal(report.runners_mapped, 2);
  assert.equal(report.runners_skipped_invalid, 1);

  // The two invariants the review asked to be made explicit.
  assert.equal(
    report.runner_records_on_mapped_races,
    report.runners_mapped + report.runners_skipped_invalid,
  );
  assert.equal(
    report.runner_records_returned,
    report.runner_records_on_mapped_races + report.runner_records_on_skipped_cards,
  );

  // Coverage denominators are the mapped counts, undistorted by skipped cards.
  const out = renderRacecardsDryRunConsole(report).join('\n');
  assert.match(out, /All runner records returned {11}: 6/);
  assert.match(out, /\.\.\.attached to skipped cards {10}: 3/);
  assert.match(out, /\.\.\.on mapped races \(the denominator\) {2}: 3/);
  assert.match(out, /Valid mapped runners {18}: 2/);
  assert.match(out, /Invalid runners skipped on mapped races: 1/);
  assert.match(out, /PROGRAMME 0 RUNNER FIELD COVERAGE \(of 2 mapped runners\)/);
  assert.match(out, /PROGRAMME 0 RACE FIELD COVERAGE \(of 1 mapped races\)/);
});

/* ========================================================================== *
 * 40-43. provider-id-first resolution parity with production
 * ========================================================================== */

test('40. the preview resolves by provider identity FIRST, ahead of the fallback', async () => {
  // Staged so the two routes would give DIFFERENT answers: the provider id
  // points at race-provider-1, while the (course, off_time) fallback would
  // find race-fallback-x. Provider identity must win.
  const { report, seam } = await preview([FULL_CARD], {
    providerRaces: [{ id: 'race-provider-1', provider_race_id: 'rac_11110000' }],
    races: [
      { id: 'race-fallback-x', course: 'Fixtureton', off_time: `${SELECTED_DATE}T13:05:00+00:00` },
    ],
    runners: [{ race_id: 'race-provider-1', horse_name: 'Fixture Runner (GB)' }],
    dateCount: 1,
  });

  assert.equal(report.races_existing, 1);
  assert.equal(report.races_planned_insert, 0);
  assert.equal(report.races_provider_id_ambiguous, 0);
  // The decisive assertion: the runner cohort came from the PROVIDER-resolved
  // race. Had the fallback won, race-provider-1's runners would be invisible.
  assert.equal(report.runners_existing, 1, 'provider-resolved race supplied the runner index');
  assert.equal(report.runners_planned_insert, 1, 'the bare runner is still new');

  // Provider identity is queried BEFORE the off-time fallback.
  const providerAt = seam.calls.findIndex((c) => c.startsWith('findRacesByProviderIds'));
  const offTimeAt = seam.calls.findIndex((c) => c.startsWith('findRacesByOffTimes'));
  assert.ok(providerAt >= 0 && offTimeAt > providerAt, 'provider lookup precedes the fallback');
  assert.ok(seam.calls.includes('findRunnersForRaces(1)'));

  // NOTE: the preview batches both lookups up front, so the off-time query is
  // issued even when every race resolves by provider identity. That is a READ
  // PATTERN difference from production's per-race lookup, not a resolution
  // difference — the resolved id is the provider one either way.
  assert.equal(indexExistingRacesByProviderId([]).size, 0);
});

test('41. a null provider id falls straight through to the historical fallback', async () => {
  // SPARSE_CARD carries no race_id at all — exactly a historical-shaped card.
  const { report, seam } = await preview([SPARSE_CARD], {
    races: [{ id: 'race-historical-1', course: 'Sparseton', off_time: `${SELECTED_DATE}T15:00:00+00:00` }],
    runners: [{ race_id: 'race-historical-1', horse_name: 'Bare Fixture Runner' }],
    dateCount: 1,
  });

  assert.equal(report.races_existing, 1, 'the historical row still resolves');
  assert.equal(report.races_planned_insert, 0);
  assert.equal(report.runners_existing, 1);
  // With no non-null provider id in the whole response, the provider lookup is
  // never issued at all.
  assert.ok(
    !seam.calls.some((c) => c.startsWith('findRacesByProviderIds')),
    'no provider lookup when nothing carries a provider id',
  );
  assert.deepEqual(seam.calls, [
    `countRacesForDate(${SELECTED_DATE})`,
    'findRacesByOffTimes(1)',
    'findRunnersForRaces(1)',
  ]);
});

test('42. duplicate stored provider ids FAIL CLOSED — never planned as an insert', async () => {
  const { report } = await preview([FULL_CARD, SPARSE_CARD], {
    providerRaces: [
      { id: 'race-dup-a', provider_race_id: 'rac_11110000' },
      { id: 'race-dup-b', provider_race_id: 'rac_11110000' },
    ],
    dateCount: 0,
  });

  assert.equal(report.races_provider_id_ambiguous, 1, 'the ambiguous card is counted');
  assert.equal(report.races_planned_insert, 1, 'only SPARSE_CARD is planned; the ambiguous one is not');
  assert.equal(report.races_existing, 0, 'an ambiguous race is NOT an existing match either');
  assert.equal(report.duplicate_cards_in_provider_response, 0);

  // Its runners are counted but never planned.
  assert.equal(report.runners_on_ambiguous_races, 2, "FULL_CARD's two mappable runners");
  assert.equal(report.runners_planned_insert, 1, 'only the sparse card contributes a plan');

  // Both bucket invariants still balance, now including the ambiguous buckets.
  assert.equal(
    report.races_mapped,
    report.races_existing +
      report.races_planned_insert +
      report.duplicate_cards_in_provider_response +
      report.races_provider_id_ambiguous,
  );
  assert.equal(
    report.runners_mapped,
    report.runners_planned_insert +
      report.runners_existing +
      report.runners_matched_within_provider_response +
      report.runners_on_ambiguous_races,
  );

  // The operator is warned, in aggregate terms, that a real run would refuse.
  const warning = report.warnings.find((w) => /MORE THAN ONE stored race/.test(w));
  assert.ok(warning, 'an ambiguity warning is required');
  assert.match(warning, /FAILS CLOSED/);
  assert.match(warning, /writes nothing at all/);
  // No identifier leaks through it.
  for (const id of ['rac_11110000', 'race-dup-a', 'race-dup-b', 'Fixtureton']) {
    assert.ok(!warning.includes(id));
  }

  const out = renderRacecardsDryRunConsole(report).join('\n');
  assert.match(out, /AMBIGUOUS provider id \(would refuse\) {2}: 1/);
  assert.match(out, /On an ambiguous race \(not planned\) {4}: 2/);
  assert.match(out, /PLANNED RACE ACTIONS \(provider_race_id first, then course \+ off_time\)/);
  for (const id of ['rac_11110000', 'race-dup-a', 'Fixtureton']) {
    assert.ok(!out.includes(id), `console output must not contain "${id}"`);
  }
});

test('43. the provider lookup is SELECT-only and fails closed on a read error', async () => {
  // A read failure carries its own stage and never degrades to "not found".
  await assert.rejects(
    runRacecardsDryRun('tomorrow', {
      client: fakeClient({ standard: { racecards: [FULL_CARD] } }),
      reads: fakeSeam({ failOn: 'findRacesByProviderIds' }),
      tier: 'standard',
      now: NOW,
    }),
    (err: unknown) => {
      assert.ok(err instanceof RacecardsDryRunFailure);
      assert.equal(err.stage, 'existing_race_provider_lookup');
      assert.match(err.detail, /findRacesByProviderIds failed/);
      return true;
    },
  );

  // The live implementation is a select, and its driver message is redacted —
  // the filter values ARE provider ids.
  const cli = CLI();
  const seamBlock = cli.slice(cli.indexOf('supabaseRacecardsReadSeam'), cli.indexOf('const USAGE'));
  const providerBlock = seamBlock.slice(
    seamBlock.indexOf('findRacesByProviderIds'),
    seamBlock.indexOf('findRacesByOffTimes'),
  );
  assert.match(providerBlock, /\.select\('id, provider_race_id'\)/);
  assert.match(providerBlock, /\.in\('provider_race_id', batch\)/);
  assert.match(providerBlock, /redactPreviewDetail\(error\)/);
  for (const forbidden of [/\.insert\s*\(/, /\.update\s*\(/, /\.upsert\s*\(/, /\.delete\s*\(/, /\.rpc\s*\(/]) {
    assert.doesNotMatch(providerBlock, forbidden);
  }
});
