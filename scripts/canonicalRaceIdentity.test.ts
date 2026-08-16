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
import { readdirSync, readFileSync } from 'node:fs';

import {
  courseKey,
  normalizeCourse,
  raceSlug,
  racecardRunnerToUpsert,
  racecardToRaceUpsert,
  trimmedOrNull,
} from '../src/lib/raceSync';
import {
  AmbiguousProviderRaceError,
  resolveExistingRaceId,
  scrubProviderId,
  type RaceResolutionLookups,
  type ResolvableRace,
} from '../src/lib/liveSync';
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
    /let raceId = await resolveExistingRaceId\(raceRow, supabaseRaceResolutionLookups\);/,
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

test('IDENTITY RESOLUTION: provider id first, course + off_time fallback (handoff contract)', () => {
  /*
   * SUPERSEDES the Programme 0 handoff contract, deliberately and with review.
   *
   * That earlier test asserted the CAPTURE/RESOLVE SPLIT: `provider_race_id`
   * was stored but read by no lookup, so a corrected off time or course label
   * inserted a second row with a second uuid and a second slug. It existed so
   * that limitation stayed visible, and it said in terms that it expected to be
   * replaced by the programme that moved resolution onto provider identity.
   * This is that replacement — the split is closed, so asserting it would now
   * assert something false.
   *
   * WHAT THIS ASSERTS INSTEAD. Resolution is provider-id-FIRST with the raw
   * (course, off_time) lookup retained as the fallback that still resolves the
   * 719 historical rows; a historical match is returned as-is and never
   * enriched, stamped or rewritten; and resolution remains resolution — it
   * reads, and introduces no update path.
   *
   * WHAT IS STILL DEFERRED, and must stay visible: runner resolution is still
   * a normalised horse name (provider_horse_id-first is a separate evidenced
   * decision), the partial provider index is still NON-unique, and no backfill
   * attaches provider identity to a historical row.
   */
  const live = readFileSync('src/lib/liveSync.ts', 'utf8');

  // 1. Provider identity is resolved FIRST, and it is a real filtered lookup.
  const resolver = live.slice(
    live.indexOf('export async function resolveExistingRaceId'),
    live.indexOf('export function scrubProviderId')
  );
  assert.ok(resolver.length > 0, 'the resolution function must exist');
  assert.match(resolver, /findIdsByProviderRaceId\(providerRaceId\)/);
  assert.match(live, /\.eq\('provider_race_id', providerRaceId\)/,
    'provider identity must be an actual filtered query');
  // The provider branch precedes the fallback inside the resolver.
  assert.ok(
    resolver.indexOf('findIdsByProviderRaceId') <
      resolver.indexOf('findIdByCourseAndOffTime'),
    'provider identity must be consulted before the fallback'
  );

  // 2. The (course, off_time) fallback is UNCHANGED and still present.
  const findRaceId = live.slice(
    live.indexOf('async function findRaceId'),
    live.indexOf('/* ---')
  );
  assert.ok(findRaceId.length > 0, 'the fallback lookup must still exist');
  assert.match(findRaceId, /\.eq\('course', course\)/);
  assert.match(findRaceId, /\.eq\('off_time', offTimeIso\)/);
  assert.equal(
    findRaceId.includes('provider_race_id'),
    false,
    'the fallback must stay a pure (course, off_time) lookup'
  );

  // 3. Ambiguity fails closed — never an arbitrary pick, never a fallback.
  assert.match(resolver, /if \(ids\.length > 1\) throw new AmbiguousProviderRaceError\(\);/);
  assert.match(live, /export class AmbiguousProviderRaceError/);

  // 4. Resolution never writes: no update/upsert/insert inside the resolver.
  for (const forbidden of [/\.update\(/, /\.upsert\(/, /\.insert\(/]) {
    assert.doesNotMatch(resolver, forbidden, 'resolution must not write');
  }
  // ...and no code path stamps provider identity onto an existing row.
  assert.equal(
    /\.update\(\{[^}]*provider_race_id/.test(live),
    false,
    'a historical row must never be back-stamped with provider identity'
  );

  // 5. Capture still happens — resolution did not replace it.
  const sync = readFileSync('src/lib/raceSync.ts', 'utf8');
  assert.match(sync, /provider_race_id: trimmedOrNull\(card\.race_id\)/);

  // 6. The remaining deferrals stay named where the next programme will look.
  assert.equal(
    /provider_horse_id.{0,80}(first|resolution)/is.test(live) ||
      /provider_horse_id-first/i.test(readFileSync('src/lib/racecardsDryRun.ts', 'utf8')),
    true,
    'runner-side provider resolution must remain explicitly deferred'
  );
  const migration = readFileSync(MIGRATION, 'utf8');
  assert.match(migration, /non-unique/i, 'the provider index must still be non-unique');
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

/* ========================================================================== *
 * 6. provider-id-first race resolution (behaviour, over injected lookups)
 * ========================================================================== */

/** A recording pair of lookups. No database, no provider, no I/O. */
function lookups(options: {
  providerIds?: string[];
  fallbackId?: string | null;
  providerThrows?: boolean;
  fallbackThrows?: boolean;
} = {}) {
  const calls: string[] = [];
  const seam: RaceResolutionLookups = {
    async findIdsByProviderRaceId(providerRaceId) {
      calls.push(`byProviderId(${providerRaceId})`);
      if (options.providerThrows) {
        throw new Error('races provider-id lookup failed: 42501 permission denied');
      }
      return options.providerIds ?? [];
    },
    async findIdByCourseAndOffTime(course, offTimeIso) {
      calls.push(`byCourseOffTime(${course},${offTimeIso})`);
      if (options.fallbackThrows) throw new Error('races lookup failed: fixture');
      return options.fallbackId ?? null;
    },
  };
  return { seam, calls };
}

const STORED_UUID = '11111111-2222-3333-4444-555555555555';
const HISTORICAL_UUID = '99999999-8888-7777-6666-555555555555';

/** The mapped row a corrected card produces: same provider id, changed details. */
function mappedRace(overrides: Partial<ResolvableRace> = {}): ResolvableRace {
  return {
    provider_race_id: 'rac_abc123',
    course: 'Lingfield (AW)',
    off_time: '2026-06-12T14:30:00.000Z',
    ...overrides,
  };
}

test('RESOLUTION: a non-null provider id is queried FIRST and one match wins', async () => {
  const { seam, calls } = lookups({ providerIds: [STORED_UUID] });
  const id = await resolveExistingRaceId(mappedRace(), seam);

  assert.equal(id, STORED_UUID, 'the existing internal uuid is returned');
  // The provider lookup ran first, and the fallback was NOT consulted at all.
  assert.deepEqual(calls, ['byProviderId(rac_abc123)']);
});

test('RESOLUTION: a corrected off time or course still resolves to the same race', async () => {
  // This is the whole point of the tranche: neither correction may create a
  // second uuid, a second slug or a second runner cohort.
  for (const corrected of [
    mappedRace({ off_time: '2026-06-12T14:35:00.000Z' }), // off time corrected
    mappedRace({ course: 'Lingfield' }), // raw course label corrected
    mappedRace({ course: 'Lingfield', off_time: '2026-06-12T15:00:00.000Z' }), // both
  ]) {
    const { seam, calls } = lookups({ providerIds: [STORED_UUID], fallbackId: null });
    const id = await resolveExistingRaceId(corrected, seam);
    assert.equal(id, STORED_UUID, 'the corrected card resolves to the EXISTING race');
    assert.deepEqual(calls, ['byProviderId(rac_abc123)'], 'no fallback, so no second insert');
  }
});

test('RESOLUTION: zero provider matches falls through to the unchanged fallback', async () => {
  const { seam, calls } = lookups({ providerIds: [], fallbackId: HISTORICAL_UUID });
  const id = await resolveExistingRaceId(mappedRace(), seam);

  assert.equal(id, HISTORICAL_UUID);
  assert.deepEqual(calls, [
    'byProviderId(rac_abc123)',
    'byCourseOffTime(Lingfield (AW),2026-06-12T14:30:00.000Z)',
  ]);
});

test('RESOLUTION: a null provider id goes straight to the fallback', async () => {
  const { seam, calls } = lookups({ fallbackId: HISTORICAL_UUID });
  const id = await resolveExistingRaceId(mappedRace({ provider_race_id: null }), seam);

  assert.equal(id, HISTORICAL_UUID, 'historical rows still resolve');
  assert.deepEqual(calls, ['byCourseOffTime(Lingfield (AW),2026-06-12T14:30:00.000Z)']);

  // A blank provider id is defensively treated as absent, never as a wildcard.
  const blank = lookups({ fallbackId: HISTORICAL_UUID });
  await resolveExistingRaceId(mappedRace({ provider_race_id: '' }), blank.seam);
  assert.deepEqual(blank.calls, ['byCourseOffTime(Lingfield (AW),2026-06-12T14:30:00.000Z)']);
});

test('RESOLUTION: neither lookup matching returns null so the caller inserts once', async () => {
  const { seam, calls } = lookups({ providerIds: [], fallbackId: null });
  const id = await resolveExistingRaceId(mappedRace(), seam);

  assert.equal(id, null, 'null is the signal to insert');
  assert.equal(calls.length, 2, 'exactly one provider lookup and one fallback lookup');

  // The insert path itself is unchanged: still one insert of the mapped row.
  const live = readFileSync('src/lib/liveSync.ts', 'utf8');
  assert.match(live, /raceId = randomUUID\(\);/);
  assert.match(live, /from\('races'\)\.insert\(\{ id: raceId, \.\.\.raceRow \}\)/);
  const inserts = [...live.matchAll(/from\('races'\)\.insert\(/g)];
  assert.equal(inserts.length, 1, 'exactly one races insert site');
});

test('RESOLUTION: duplicate provider rows FAIL CLOSED — no pick, no fallback, no insert', async () => {
  const { seam, calls } = lookups({
    providerIds: [STORED_UUID, HISTORICAL_UUID],
    fallbackId: HISTORICAL_UUID,
  });

  await assert.rejects(
    resolveExistingRaceId(mappedRace(), seam),
    (err: unknown) => {
      assert.ok(err instanceof AmbiguousProviderRaceError);
      // The provider id value is never exposed in the safe error.
      assert.ok(!err.message.includes('rac_abc123'));
      assert.doesNotMatch(err.message, /\b(rac|crs|hrs|trn|jck)_/);
      assert.match(err.message, /AMBIGUOUS/);
      assert.match(err.message, /operator investigation/);
      return true;
    },
  );

  // It did not arbitrarily pick a row, and it did not consult the fallback.
  assert.deepEqual(calls, ['byProviderId(rac_abc123)'], 'no fallback after ambiguity');
});

test('RESOLUTION: a provider-lookup read failure fails closed, never as "not found"', async () => {
  const { seam, calls } = lookups({ providerThrows: true, fallbackId: HISTORICAL_UUID });

  await assert.rejects(resolveExistingRaceId(mappedRace(), seam), /provider-id lookup failed/);
  // Crucially: the fallback did NOT run, so a read failure can never be
  // mistaken for "no such race" and turned into an insert.
  assert.deepEqual(calls, ['byProviderId(rac_abc123)']);
});

test('RESOLUTION: the driver message is scrubbed of the provider id value', () => {
  const leaked = 'invalid input for eq: provider_race_id=rac_abc123 near "rac_abc123"';
  const safe = scrubProviderId(leaked, 'rac_abc123');
  assert.ok(!safe.includes('rac_abc123'));
  assert.equal(safe.split('[provider-id]').length - 1, 2, 'every occurrence is replaced');
  assert.match(safe, /invalid input for eq/, 'the diagnostic shape survives');
  // A blank id is a no-op rather than a global replacement.
  assert.equal(scrubProviderId('untouched', ''), 'untouched');

  // The live lookup routes its driver message through the scrubber.
  const live = readFileSync('src/lib/liveSync.ts', 'utf8');
  assert.match(live, /scrubProviderId\(error\.message, providerRaceId\)/);
});

test('RESOLUTION: no existing race row is updated, enriched or re-slugged', () => {
  const live = readFileSync('src/lib/liveSync.ts', 'utf8');

  // The ONLY races update remains settlement, with its frozen payload.
  const raceUpdates = [...live.matchAll(/\.update\(\{([^}]*)\}\)/g)].map((m) => m[1]);
  const settlementPatch = raceUpdates.find((p) => p.includes("status: 'result'"));
  assert.ok(settlementPatch, 'the settlement update must still exist');
  for (const frozen of [
    'race_slug',
    'off_time',
    'course',
    'race_name',
    'course_key',
    'provider_race_id',
    'provider_course_id',
    'race_type',
    'going',
    'distance_f',
    'race_class',
    'age_band',
    'pattern',
    'field_size',
  ]) {
    assert.equal(
      settlementPatch!.includes(frozen),
      false,
      `no write path may rewrite ${frozen}`
    );
  }

  // Runner matching is untouched: still normalised horse name, insert-only.
  assert.match(live, /\.select\('id, horse_name'\)\s*\n\s*\.eq\('race_id', raceId\)/);
  assert.match(live, /!present\.has\(normalizeHorseName\(r\.horse_name\)\)/);
  assert.equal(
    /provider_horse_id/.test(live),
    false,
    'provider_horse_id-first runner resolution is NOT part of this tranche'
  );

  // The settlement path still resolves on (course, off_time) — deliberately
  // frozen: changing it would be a second behavioural change.
  assert.match(live, /const raceId = await findRaceId\(course, resolved\.offTimeIso\);/);
});

test('RESOLUTION: no schema change accompanies this tranche', () => {
  // The provider index stays partial and NON-unique; nothing here promotes it.
  const migration = readFileSync(MIGRATION, 'utf8');
  assert.match(migration, /create index if not exists\s+races_provider_race_id_idx/);
  assert.equal(
    /create unique index[\s\S]*provider_race_id/i.test(migration),
    false,
    'the partial index must not become unique on this evidence'
  );
  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql'));
  assert.equal(
    files.filter((f) => /provider.?id.?resolution|resolution/i.test(f)).length,
    0,
    'this tranche adds no migration'
  );
});

/*
 * POST-RELEASE VERIFICATION ANCHORS — documentation, never production logic.
 *
 * These are the recorded fingerprints of the first controlled capture
 * (2026-08-17). They exist so a reviewer can find the exact values to re-check
 * AFTER release; nothing in the runtime reads them, and no test asserts them
 * against a database. Recording them as a constant here would risk them being
 * mistaken for a runtime expectation, so they live in prose:
 *
 *   races        : 25          fingerprint 039bbcf9a246ebe65211714f72b734ed
 *   runners      : 217         fingerprint 7450ac0c3935b1bd4ae1112e952e9675
 *
 * The post-release check is that BOTH remain unchanged after this tranche
 * ships, because resolution-only changes must not rewrite a single stored row.
 */
test('RESOLUTION: identity fingerprints are documentation, not runtime logic', () => {
  const live = readFileSync('src/lib/liveSync.ts', 'utf8');
  const dryRun = readFileSync('src/lib/racecardsDryRun.ts', 'utf8');
  for (const fingerprint of [
    '039bbcf9a246ebe65211714f72b734ed',
    '7450ac0c3935b1bd4ae1112e952e9675',
  ]) {
    assert.equal(live.includes(fingerprint), false, 'no runtime file may embed a fingerprint');
    assert.equal(dryRun.includes(fingerprint), false, 'no runtime file may embed a fingerprint');
  }
});
