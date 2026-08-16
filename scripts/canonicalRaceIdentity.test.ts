/**
 * PROGRAMME 0 — canonical race identity + future-data capture.
 *
 * Guards three things that are easy to lose and expensive to discover late:
 *
 *   1. The migration stays ADDITIVE. It may only add nullable columns and an
 *      index; any drop/rename/default/backfill/NOT NULL/unique is a failure.
 *   2. Ingestion maps the provider fields it used to discard, into the right
 *      columns, without inventing values for absent ones.
 *   3. The FUTURE-DATA-ONLY contract holds: no historical backfill, the uuid
 *      identity is untouched, and the frozen-slug property that makes stable
 *      URLs possible survives.
 *
 * Reads source text and runs pure functions only. No database, no provider, no
 * migration application.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  courseKey,
  normalizeCourse,
  raceSlug,
  racecardRunnerToUpsert,
  racecardToRaceUpsert,
  trimmedOrNull,
} from '../src/lib/raceSync';
import { REQUIRED_TABLES } from '../src/lib/dbHealthSpec';

const MIGRATION = 'supabase/migrations/20260816000000_canonical_race_identity.sql';
const RAW_SQL = readFileSync(MIGRATION, 'utf8');

/**
 * The migration WITHOUT its comments.
 *
 * Load-bearing: the file legitimately explains in prose why it does not drop,
 * rename, backfill or default anything, and those words must never satisfy —
 * or trip — a forbidden-statement check. Every structural assertion below runs
 * on this stripped text.
 */
const SQL = RAW_SQL.split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')
  .toLowerCase();

/* ========================================================================== *
 * 1. the migration is additive only
 * ========================================================================== */

test('P0 migration: contains only additive statements', () => {
  const statements = SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  assert.ok(statements.length > 0, 'the migration must contain statements');

  for (const s of statements) {
    const additive =
      /^alter table public\.(races|runners) add column if not exists /.test(s) ||
      /^create index if not exists /.test(s) ||
      /^comment on column /.test(s);
    assert.ok(additive, `non-additive statement found: ${s.slice(0, 90)}`);
  }
});

test('P0 migration: no destructive or mutating statement', () => {
  for (const forbidden of [
    'drop ',
    'rename ',
    'truncate',
    'delete from',
    'insert into',
    'update ',
    'alter column',
    'set not null',
    'set default',
    'add constraint',
    'create trigger',
    'create or replace function',
    'cascade',
    'grant ',
    'revoke ',
  ]) {
    assert.equal(
      SQL.includes(forbidden),
      false,
      `migration must not contain "${forbidden.trim()}"`
    );
  }
});

test('P0 migration: every new column is nullable and default-free', () => {
  /*
   * A DEFAULT would write a value into all 719 historical rows that no provider
   * ever supplied — fabrication, and precisely what "future data only" forbids.
   * NOT NULL would be worse: it cannot even be applied while those rows exist.
   *
   * Scoped to the ADD COLUMN statements. The partial index legitimately uses
   * `where provider_race_id is not null` as a predicate, which is the opposite
   * of a column constraint — a blanket text search would flag it wrongly.
   */
  const addColumnStatements = SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('alter table'));

  assert.equal(addColumnStatements.length, 11, 'ten race columns + one runner column');

  for (const s of addColumnStatements) {
    assert.equal(/\bnot null\b/.test(s), false, `NOT NULL in: ${s.slice(0, 80)}`);
    assert.equal(/\bdefault\b/.test(s), false, `DEFAULT in: ${s.slice(0, 80)}`);
    assert.equal(/\bunique\b/.test(s), false, `UNIQUE in: ${s.slice(0, 80)}`);
  }
});

test('P0 migration: adds exactly the intended columns', () => {
  const RACE_COLUMNS = [
    'provider_race_id', 'provider_course_id', 'course_key', 'race_slug',
    'race_type', 'distance_f', 'age_band', 'pattern', 'field_size',
    'is_abandoned',
  ];
  for (const col of RACE_COLUMNS) {
    assert.ok(
      SQL.includes(`alter table public.races add column if not exists ${col} `),
      `races.${col} must be added`
    );
  }
  assert.ok(
    SQL.includes('alter table public.runners add column if not exists provider_horse_id '),
    'runners.provider_horse_id must be added'
  );

  // Columns that ALREADY exist live must not be re-added.
  for (const existing of ['going', 'race_class', 'created_at', 'updated_at',
    'meeting_date', 'country', 'handicap_flag', 'is_handicap',
    'trainer_id', 'jockey_id', 'age']) {
    assert.equal(
      new RegExp(`add column if not exists ${existing}\\b`).test(SQL),
      false,
      `${existing} already exists live and must not be re-added`
    );
  }
});

test('P0 migration: the provider_race_id index is partial and NOT unique', () => {
  /*
   * Uniqueness is a claim about data that does not exist yet. Asserting it now
   * would turn the first duplicate into an outage; the index is promoted only
   * after future coverage proves it, in a separate migration.
   */
  assert.match(SQL, /create index if not exists races_provider_race_id_idx/);
  assert.match(SQL, /where provider_race_id is not null/);
  assert.equal(/unique index/.test(SQL), false, 'no unique index in this migration');
});

test('P0 migration: does not touch quotes, handicap columns or identity keys', () => {
  for (const untouched of ['runner_quotes', 'market_snapshot_id', 'is_handicap',
    'primary key', 'foreign key', 'references ']) {
    assert.equal(
      SQL.includes(untouched),
      false,
      `migration must not mention ${untouched}`
    );
  }
});

/* ========================================================================== *
 * 2. course key and race slug
 * ========================================================================== */

test('P0 courseKey: derives from normalizeCourse, hyphenated and deterministic', () => {
  for (const input of ['Great Yarmouth', 'Lingfield (AW)', 'Royal Ascot', 'Ascot',
    "Newmarket", '  Kempton  ', '']) {
    // The key is exactly the established normalisation with spaces swapped —
    // so the two can never disagree about aliases or "(AW)" handling.
    assert.equal(courseKey(input), normalizeCourse(input).replace(/ /g, '-'));
    // Deterministic.
    assert.equal(courseKey(input), courseKey(input));
    // Route-safe.
    assert.equal(/^[a-z0-9-]*$/.test(courseKey(input)), true, `unsafe key for "${input}"`);
  }

  assert.equal(courseKey('Great Yarmouth'), 'great-yarmouth');
  assert.equal(courseKey('Lingfield (AW)'), 'lingfield');
  assert.equal(courseKey('Royal Ascot'), 'ascot', 'the established alias still applies');
  assert.equal(courseKey(null), '');
});

test('P0 raceSlug: deterministic, route-safe, HHMM-prefixed', () => {
  const slug = raceSlug('2026-06-12T14:30:00Z', 'Bahrain Trophy Stakes (Group 3)');
  assert.equal(slug, '1430-bahrain-trophy-stakes-group-3');
  assert.equal(raceSlug('2026-06-12T14:30:00Z', 'Bahrain Trophy Stakes (Group 3)'), slug);
  assert.equal(/^[a-z0-9-]+$/.test(slug), true);

  // Offset instants resolve to the same UTC HHMM.
  assert.equal(
    raceSlug('2026-06-12T15:30:00+01:00', 'X'),
    raceSlug('2026-06-12T14:30:00Z', 'X')
  );

  // Deterministic fallback for a missing name; never an invented handle.
  assert.equal(raceSlug('2026-06-12T14:30:00Z', ''), '1430-unknown-race');
  assert.equal(raceSlug('2026-06-12T14:30:00Z', null), '1430-unknown-race');
  assert.equal(raceSlug('2026-06-12T14:30:00Z', '!!!'), '1430-unknown-race');

  // Unusable instant -> '' so the caller stores null rather than a fake slug.
  assert.equal(raceSlug('not a date', 'X'), '');
  assert.equal(raceSlug(null, 'X'), '');

  // NOT a race-number or array-position slug.
  assert.equal(/^\d{4}-/.test(slug), true, 'slug starts with the scheduled HHMM');
});

test('P0 raceSlug: per-row slug immutability comes from the write path', () => {
  /*
   * THIS CONTRACT PROVES PER-ROW SLUG IMMUTABILITY. IT PROVES NOTHING MORE.
   *
   * `liveSync.syncRacecards` looks a race up by (course, off_time) and INSERTS
   * only when it is absent — no upsert, no update of an existing race row — and
   * settlement writes only status and official_result_time. So a slug already
   * stored on a row is never rewritten. Asserted against the source so it
   * cannot be lost silently by a future refactor to an upsert.
   *
   * WHAT THIS DOES NOT PROVE: stable real-world race identity. Because the
   * lookup keys are the raw course string and off_time, a corrected off time or
   * course label MISSES the existing row and inserts another row with another
   * slug. Navigation must not assume provider_race_id resolution exists — see
   * the companion known-constraint test below.
   */
  const live = readFileSync('src/lib/liveSync.ts', 'utf8');
  assert.match(
    live,
    /const raceRow = racecardToRaceUpsert\(card\);/,
    'liveSync still maps races through raceSync'
  );
  assert.match(
    live,
    /let raceId = await findRaceId\(raceRow\.course, raceRow\.off_time\);/,
    'races are still looked up before being written'
  );
  assert.match(
    live,
    /from\('races'\)\.insert\(\{ id: raceId, \.\.\.raceRow \}\)/,
    'races are INSERTED only, never upserted'
  );
  assert.equal(
    /from\('races'\)[\s\S]{0,80}\.upsert\(/.test(live),
    false,
    'an upsert on races would break the frozen-slug guarantee'
  );

  /*
   * There IS one update on races — the settlement path, which stamps
   * `status: 'result'` and `official_result_time` once a race is resulted.
   * That is legitimate and must not be forbidden. What matters for the frozen
   * slug is its PAYLOAD: it must never write the slug, the off time or the
   * race name. Pinning the exact patch is what keeps that true.
   */
  const raceUpdates = [...live.matchAll(/\.update\(\{([^}]*)\}\)/g)].map((m) => m[1]);
  const settlementPatch = raceUpdates.find((p) => p.includes("status: 'result'"));
  assert.ok(settlementPatch, 'the settlement update must still exist');
  assert.match(settlementPatch!, /official_result_time:/);
  for (const frozen of ['race_slug', 'off_time', 'race_name', 'course_key',
    'provider_race_id']) {
    assert.equal(
      settlementPatch!.includes(frozen),
      false,
      `settlement must never rewrite ${frozen}`
    );
  }
});

test('P0 KNOWN CONSTRAINT: identity is captured, not resolved (handoff contract)', () => {
  /*
   * A HANDOFF CONTRACT, NOT A PERMANENT RULE.
   *
   * Programme 0 stores `provider_race_id` but no lookup reads it: races are
   * still resolved by the RAW course string plus off_time. So a corrected off
   * time or course label misses the existing row and inserts a second row with
   * a second uuid and a second slug, and the deliberately non-unique partial
   * index does not prevent it. That duplication PREDATES Programme 0 and is
   * unchanged by it.
   *
   * This test exists so the limitation is visible rather than assumed away. It
   * is EXPECTED to be superseded by the programme that migrates resolution to
   * provider_race_id-first — deliberately, with review, not by accident. It
   * does not assert that duplication must remain, only that it is the current
   * behaviour and that nothing here has quietly claimed otherwise.
   */
  const live = readFileSync('src/lib/liveSync.ts', 'utf8');
  const findRaceId = live.slice(
    live.indexOf('async function findRaceId'),
    live.indexOf('export interface RacecardsSyncSummary')
  );
  assert.ok(findRaceId.length > 0, 'findRaceId must still exist to be described');

  // 1. Resolution keys are still the raw course string and the off time.
  assert.match(findRaceId, /\.eq\('course', course\)/);
  assert.match(findRaceId, /\.eq\('off_time', offTimeIso\)/);

  // 2. provider_race_id takes no part in resolution — anywhere in liveSync.
  assert.equal(
    findRaceId.includes('provider_race_id'),
    false,
    'findRaceId must not silently start resolving on provider identity'
  );
  assert.equal(
    /\.eq\('provider_race_id'/.test(live),
    false,
    'no lookup filters on provider_race_id yet'
  );

  // 3. Yet capture DOES happen — which is exactly the capture/resolve split.
  const sync = readFileSync('src/lib/raceSync.ts', 'utf8');
  assert.match(sync, /provider_race_id: trimmedOrNull\(card\.race_id\)/);

  // 4. And the limitation is stated where the next programme will look.
  assert.match(
    sync,
    /provider_race_id-first|resolution to provider_race_id/i,
    'the raceSlug docblock must name the deferred resolution change'
  );
});

/* ========================================================================== *
 * 3. race mapping
 * ========================================================================== */

const FULL_CARD = {
  race_id: 'rac_abc123',
  course_id: 'crs_77',
  course: 'Lingfield (AW)',
  region: 'GB',
  race_name: 'Betway Handicap',
  race_class: 'Class 4',
  type: 'Flat',
  age_band: '3yo+',
  going: 'Standard',
  distance_f: '8.0',
  distance_round: '1m',
  pattern: 'Listed',
  field_size: '11',
  is_abandoned: false,
  off_dt: '2026-06-12T14:30:00Z',
  date: '2026-06-12',
  off_time: '14:30',
  runners: [],
};

test('P0 race mapping: persists provider identity and route identity', () => {
  const row = racecardToRaceUpsert(FULL_CARD)!;
  assert.ok(row);
  assert.equal(row.provider_race_id, 'rac_abc123');
  assert.equal(row.provider_course_id, 'crs_77');
  assert.equal(row.course_key, 'lingfield');
  assert.equal(row.race_slug, '1430-betway-handicap');
});

test('P0 race mapping: persists the previously discarded card attributes', () => {
  const row = racecardToRaceUpsert(FULL_CARD)!;
  assert.equal(row.race_type, 'Flat');
  assert.equal(row.distance_f, 8);
  assert.equal(row.distance, '1m');
  assert.equal(row.going, 'Standard');
  assert.equal(row.race_class, 'Class 4');
  assert.equal(row.age_band, '3yo+');
  assert.equal(row.pattern, 'Listed');
  assert.equal(row.field_size, 11);
  assert.equal(row.is_abandoned, false);
});

test('P0 race mapping: the original seven fields are unchanged', () => {
  const row = racecardToRaceUpsert(FULL_CARD)!;
  assert.equal(row.meeting_date, '2026-06-12');
  assert.equal(row.course, 'Lingfield (AW)', 'the display label is stored verbatim');
  assert.equal(row.country, 'GB');
  assert.equal(row.race_name, 'Betway Handicap');
  assert.equal(row.off_time, '2026-06-12T14:30:00.000Z');
  assert.equal(row.handicap_flag, true);
  assert.equal(row.status, 'scheduled');
});

test('P0 race mapping: absent provider fields become null, never invented', () => {
  const row = racecardToRaceUpsert({
    course: 'Ascot',
    off_dt: '2026-06-12T14:30:00Z',
    date: '2026-06-12',
    race_name: 'Some Stakes',
  })!;
  assert.ok(row);
  for (const [key, value] of [
    ['provider_race_id', row.provider_race_id],
    ['provider_course_id', row.provider_course_id],
    ['race_type', row.race_type],
    ['distance_f', row.distance_f],
    ['distance', row.distance],
    ['going', row.going],
    ['race_class', row.race_class],
    ['age_band', row.age_band],
    ['pattern', row.pattern],
    ['field_size', row.field_size],
    ['is_abandoned', row.is_abandoned],
  ] as const) {
    assert.equal(value, null, `${key} must be null when the card omits it`);
  }
  // Route identity is still derivable from what we do have.
  assert.equal(row.course_key, 'ascot');
  assert.equal(row.race_slug, '1430-some-stakes');
});

test('P0 race mapping: blank provider strings are null, not empty strings', () => {
  const row = racecardToRaceUpsert({
    ...FULL_CARD,
    race_id: '   ',
    going: '',
    pattern: '  ',
  })!;
  assert.equal(row.provider_race_id, null);
  assert.equal(row.going, null);
  assert.equal(row.pattern, null);
});

test('P0 race mapping: never writes is_handicap', () => {
  /*
   * handicap_flag is the ACTIVE column (populated on all 719 audited races).
   * is_handicap is legacy and false on every row; writing it would create a
   * second, contradictory source of truth.
   */
  const row = racecardToRaceUpsert(FULL_CARD)!;
  assert.equal('is_handicap' in row, false, 'is_handicap must not be in the mapped row');
  assert.equal(row.handicap_flag, true, 'handicap_flag remains the destination');

  const src = readFileSync('src/lib/raceSync.ts', 'utf8');
  assert.equal(
    /is_handicap\s*:/.test(src),
    false,
    'raceSync must never assign is_handicap'
  );
});

test('P0 race mapping: abandoned cards are still skipped entirely', () => {
  // Behaviour freeze: Programme 0 did not change which cards are stored.
  assert.equal(
    racecardToRaceUpsert({ ...FULL_CARD, is_abandoned: true }),
    null
  );
  assert.equal(racecardToRaceUpsert({ ...FULL_CARD, course: '' }), null);
  assert.equal(
    racecardToRaceUpsert({ ...FULL_CARD, off_dt: 'bad', date: undefined, off_time: undefined }),
    null
  );
});

/* ========================================================================== *
 * 4. runner mapping
 * ========================================================================== */

const FULL_RUNNER = {
  horse_id: 'hrs_999',
  horse: 'Alpha (IRE)',
  number: '3',
  draw: '5',
  ofr: '88',
  lbs: '140',
  age: '4',
  trainer: 'A Trainer',
  trainer_id: 'trn_1',
  jockey: 'A Jockey',
  jockey_id: 'jky_2',
};

test('P0 runner mapping: persists provider identity and the three empty columns', () => {
  const row = racecardRunnerToUpsert(FULL_RUNNER)!;
  assert.ok(row);
  assert.equal(row.provider_horse_id, 'hrs_999');
  assert.equal(row.trainer_id, 'trn_1');
  assert.equal(row.jockey_id, 'jky_2');
  assert.equal(row.age, 4);
});

test('P0 runner mapping: the original eight fields are unchanged', () => {
  const row = racecardRunnerToUpsert(FULL_RUNNER)!;
  assert.equal(row.horse_name, 'Alpha (IRE)');
  assert.equal(row.trainer, 'A Trainer');
  assert.equal(row.jockey, 'A Jockey');
  assert.equal(row.draw, 5);
  assert.equal(row.saddlecloth, 3);
  assert.equal(row.official_rating, 88);
  assert.equal(row.weight_lbs, 140);
  assert.equal(row.runner_status, 'declared');
});

test('P0 runner mapping: never writes legacy or settlement columns', () => {
  const row = racecardRunnerToUpsert(FULL_RUNNER)!;
  for (const legacy of ['trainer_name', 'jockey_name', 'finish_position',
    'betfair_sp', 'official_sp']) {
    assert.equal(legacy in row, false, `${legacy} is legacy and must not be written`);
  }
  for (const settlement of ['finish_pos', 'sp_decimal', 'bsp_decimal']) {
    assert.equal(
      settlement in row,
      false,
      `${settlement} is owned by the results path, not ingestion`
    );
  }
});

test('P0 runner mapping: absent provider fields become null', () => {
  const row = racecardRunnerToUpsert({ horse: 'Beta' })!;
  assert.ok(row);
  assert.equal(row.provider_horse_id, null);
  assert.equal(row.trainer_id, null);
  assert.equal(row.jockey_id, null);
  assert.equal(row.age, null);
  assert.equal(row.official_rating, null);
  assert.equal(racecardRunnerToUpsert({ horse: '' }), null);
});

test('P0 trimmedOrNull: blank and non-string inputs are null', () => {
  assert.equal(trimmedOrNull('  x '), 'x');
  assert.equal(trimmedOrNull(''), null);
  assert.equal(trimmedOrNull('   '), null);
  assert.equal(trimmedOrNull(undefined), null);
  assert.equal(trimmedOrNull(null), null);
});

/* ========================================================================== *
 * 5. contract, scope and behaviour freeze
 * ========================================================================== */

test('P0 dbHealthSpec: declares the new nullable columns', () => {
  const races = REQUIRED_TABLES.find((t) => t.name === 'races')!;
  const runners = REQUIRED_TABLES.find((t) => t.name === 'runners')!;
  assert.ok(races && runners);

  for (const col of ['provider_race_id', 'provider_course_id', 'course_key',
    'race_slug', 'race_type', 'distance_f', 'distance', 'going', 'race_class',
    'age_band', 'pattern', 'field_size', 'is_abandoned']) {
    assert.ok(races.columns.includes(col), `dbHealthSpec races must list ${col}`);
  }
  for (const col of ['provider_horse_id', 'trainer_id', 'jockey_id', 'age']) {
    assert.ok(runners.columns.includes(col), `dbHealthSpec runners must list ${col}`);
  }

  // The original contract survives unchanged.
  for (const col of ['id', 'meeting_date', 'course', 'country', 'race_name',
    'off_time', 'handicap_flag', 'status', 'official_result_time']) {
    assert.ok(races.columns.includes(col), `dbHealthSpec races must keep ${col}`);
  }
  // is_handicap is legacy and deliberately NOT part of the app contract.
  assert.equal(races.columns.includes('is_handicap'), false);
});

test('P0 future-data-only: nothing backfills history', () => {
  /*
   * The 719 existing races and 7,332 runners keep their uuid identity and carry
   * null for every new column. Navigation must therefore tolerate a race with
   * no provider id and no slug — that is a permanent state for history, not a
   * transient one.
   */
  assert.equal(/\bbackfill\b/.test(SQL), false, 'no backfill statement');
  assert.equal(/insert into/.test(SQL), false);
  assert.equal(/update /.test(SQL), false);
  assert.equal(
    /select/.test(SQL),
    false,
    'an additive migration reads no rows at all'
  );
});

test('P0 scope: no model, recommendation, lock, evaluation or quote change', () => {
  const src = readFileSync('src/lib/raceSync.ts', 'utf8');
  for (const forbidden of ['model_prob', 'recommendation', 'locked_race_decisions',
    'kelly', 'confidence_score', 'ev_per_1', 'market_snapshot_id']) {
    assert.equal(
      src.includes(forbidden),
      false,
      `raceSync must not reference ${forbidden}`
    );
  }
  // runner_quotes is untouched by this programme.
  assert.equal(SQL.includes('runner_quotes'), false);
});
