/**
 * OFF-TIME INTEGRITY — observe and tighten; `races.off_time` is never written.
 *
 * Guards the invariant the whole programme rests on:
 *
 *   The off time every WRITE-SIDE safety guard uses is a monotone-DECREASING
 *   function of accumulated evidence. It starts at `races.off_time` and can
 *   only ever move EARLIER. No observation, from any direction, at any time, in
 *   any order, can manufacture a pre-off state.
 *
 * Raising a stored off is the fabrication vector — it would let a post-race run
 * become `is_current`, let an IMMUTABLE T-minus-5 lock be built from post-race
 * output, and leak permanently into training data and lifetime accuracy. So a
 * published delay is recorded and never applied.
 *
 * Everything below runs on fixtures and injected seams. No database, no
 * provider, no migration application, no CLI execution.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MIN_CORROBORATING_OBSERVATIONS,
  MIN_OBSERVED_DELTA_MS,
  OFF_TIME_OBSERVATIONS_TABLE,
  OFF_TIME_OBSERVER_RACECARDS,
  buildOffTimeObservationRow,
  classifyOffTimeObservation,
  dedupeObservations,
  emptyOffTimeObservationSummary,
  fetchEffectiveOffTime,
  isMissingColumnError,
  recordOffTimeObservations,
  resolveEffectiveOffTime,
  type EffectiveOffObservation,
  type ObservedOffTime,
  type OffTimeObservationInsertRow,
  type OffTimeObservationLookups,
  type StoredRaceOffTime,
} from '../src/lib/offTimeObservation';
import { racecardOffTimeSource, racecardToRaceUpsert, resolveOffTime } from '../src/lib/raceSync';
import { shouldRefuseContestedLock } from '../src/lib/lockTMinus';

const MIGRATION = 'supabase/migrations/20260818000000_race_off_time_observations.sql';
const RAW_SQL = readFileSync(MIGRATION, 'utf8');

/**
 * The migration WITHOUT its comments, and with line endings normalised.
 *
 * Load-bearing twice over. The header legitimately explains at length why it
 * never drops, rewrites or backfills anything, and those words must never
 * satisfy — or trip — a forbidden-statement check. And this repository is
 * checked out with `core.autocrlf=true`, so a structural regex looking for a
 * literal newline silently matches nothing on a committed file.
 */
const SQL = RAW_SQL.replace(/\r\n/g, '\n')
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')
  .toLowerCase();

/**
 * The same SQL with the dollar-quoted function BODY and every single-quoted
 * literal replaced by a placeholder.
 *
 * Load-bearing for statement splitting. The append-only guard is plpgsql and
 * its body legitimately contains semicolons; so do the column comments, which
 * explain the policy in prose ("...effective off; a published delay..."). Naive
 * splitting on ';' shreds both into fragments like `end if` and reports them as
 * non-additive statements. The CONTENT of both is asserted separately against
 * {@link SQL}, which retains everything.
 */
const SQL_STATEMENTS_SOURCE = SQL.replace(/\$\$[\s\S]*?\$\$/g, '$$body$$').replace(
  /'(?:[^']|'')*'/g,
  "'literal'",
);

/** Source with line endings normalised, for every structural assertion. */
function src(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Destructive DML inside a function body, QUALIFIED OR NOT.
 *
 * The previous scan matched only `delete from public.` / `update public.`, so
 * `delete from race_off_time_observations` — an unqualified name, the more
 * natural way to write it inside a trigger on that very table — evaded the
 * check entirely. These are anchored on the statement verb and require a
 * following identifier, so `TG_OP = 'UPDATE'` (a comparison against a blanked
 * string literal) cannot match while a real statement always does.
 */
const DESTRUCTIVE_BODY_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['DELETE FROM <table>', /\bdelete\s+from\s+[a-z_"]/],
  ['UPDATE <table> SET', /\bupdate\s+[a-z_."]+\s+set\b/],
  ['INSERT INTO <table>', /\binsert\s+into\s+[a-z_"]/],
  ['DROP TABLE', /\bdrop\s+table\b/],
  ['DROP COLUMN', /\bdrop\s+column\b/],
  ['TRUNCATE', /\btruncate\b/],
  ['ALTER TABLE', /\balter\s+table\b/],
  ['GRANT', /\bgrant\s+[a-z]/],
  ['REVOKE', /\brevoke\s+[a-z]/],
];

/** Executable source only — prose promising an absence must never fail a scan. */
function codeOf(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const RACE = 'race-1111-2222-3333';
const DATE = '2026-08-18';
const STORED_OFF = '2026-08-18T14:30:00.000Z';

function stored(overrides: Partial<StoredRaceOffTime> = {}): StoredRaceOffTime {
  return {
    race_id: RACE,
    off_time: STORED_OFF,
    meeting_date: DATE,
    status: 'scheduled',
    provider_race_id: 'rac_11110000',
    ...overrides,
  };
}

function observed(overrides: Partial<ObservedOffTime> = {}): ObservedOffTime {
  return {
    race_id: RACE,
    provider_race_id: 'rac_11110000',
    off_time_iso: STORED_OFF,
    meeting_date: DATE,
    source_field: 'off_dt',
    ...overrides,
  };
}

/** Eligible observation shorthand for the effective-off tests. */
function ob(iso: string | null, eligible = true): EffectiveOffObservation {
  return { observed_off_time: iso, tightening_eligible: eligible };
}

/* ========================================================================== *
 * 1-8. Classification — the required correction scenarios
 * ========================================================================== */

test('1. same provider id, UNCHANGED time: nothing is classified and nothing is recorded', () => {
  const d = classifyOffTimeObservation(stored(), observed(), DATE);
  assert.equal(d.classification, null, 'unchanged is the common path and must record nothing');
  assert.equal(d.tightening_eligible, false);
  assert.equal(buildOffTimeObservationRow(stored(), observed(), d, ctx()), null);

  // Sub-second representational noise is also unchanged: resolveOffTime emits
  // `...T14:30:00.000Z` while PostgREST returns `+00:00` — same instant.
  const noise = classifyOffTimeObservation(
    stored({ off_time: '2026-08-18T14:30:00+00:00' }),
    observed({ off_time_iso: '2026-08-18T14:30:00.400Z' }),
    DATE,
  );
  assert.equal(noise.classification, null);
  assert.equal(MIN_OBSERVED_DELTA_MS, 1_000);
});

test('2. same provider id, LATER corrected time: recorded, never eligible', () => {
  const d = classifyOffTimeObservation(stored(), observed({ off_time_iso: '2026-08-18T14:45:00.000Z' }), DATE);
  assert.equal(d.classification, 'later_than_stored');
  assert.equal(d.tightening_eligible, false, 'a published delay is NEVER applied');
  assert.equal(d.delta_seconds, 900);
});

test('3. same provider id, EARLIER corrected time: recorded AND eligible to tighten', () => {
  const d = classifyOffTimeObservation(stored(), observed({ off_time_iso: '2026-08-18T14:00:00.000Z' }), DATE);
  assert.equal(d.classification, 'earlier_than_stored');
  assert.equal(d.tightening_eligible, true, 'only EARLIER may ever tighten');
  assert.equal(d.delta_seconds, -1800);
});

test('4. corrected raw COURSE label with an unchanged time observes nothing', () => {
  // Course is not part of the observation at all — identity already resolved by
  // provider id, and the time is what the guards consume.
  const d = classifyOffTimeObservation(stored(), observed(), DATE);
  assert.equal(d.classification, null);
});

test('5. corrected course AND time is classified purely by the time', () => {
  const d = classifyOffTimeObservation(stored(), observed({ off_time_iso: '2026-08-18T13:55:00.000Z' }), DATE);
  assert.equal(d.classification, 'earlier_than_stored');
  assert.equal(d.tightening_eligible, true);
});

test('6. a null / unparseable stored off is never invented, and never tightens', () => {
  for (const off of [null, '', 'not-a-time']) {
    const d = classifyOffTimeObservation(stored({ off_time: off }), observed({ off_time_iso: '2026-08-18T14:00:00.000Z' }), DATE);
    assert.equal(d.classification, 'stored_off_unknown', `stored off ${String(off)}`);
    assert.equal(d.tightening_eligible, false);
    assert.equal(d.delta_seconds, null);
  }
  // ...and the built row carries a null delta exactly when the stored off is null.
  const d = classifyOffTimeObservation(stored({ off_time: null }), observed(), DATE);
  const row = buildOffTimeObservationRow(stored({ off_time: null }), observed(), d, ctx());
  assert.ok(row);
  assert.equal(row.stored_off_time, null);
  assert.equal(row.delta_seconds, null);
});

test('7. the ambiguous local-forced-to-UTC source can never tighten', () => {
  // resolveOffTime's fallback composes date + a documented LOCAL off_time and
  // forces it to UTC — a one-hour error under British Summer Time.
  const d = classifyOffTimeObservation(
    stored(),
    observed({ off_time_iso: '2026-08-18T13:30:00.000Z', source_field: 'date_off_time' }),
    DATE,
  );
  assert.equal(d.classification, 'ambiguous_source');
  assert.equal(d.tightening_eligible, false, 'an hour-wrong instant must never suppress a run');
  assert.equal(d.delta_seconds, -3600);
});

test('8. precedence is fail-closed: scope, then day, then unknown, then unchanged', () => {
  // Out-of-scope beats everything, including a genuine earlier time.
  const out = classifyOffTimeObservation(stored(), observed({ meeting_date: '2026-08-19', off_time_iso: '2026-08-18T14:00:00.000Z' }), DATE);
  assert.equal(out.classification, 'out_of_scope_meeting_date');
  assert.equal(out.tightening_eligible, false);

  // A day change (both in scope) is not a race that has already run.
  const moved = classifyOffTimeObservation(
    stored({ meeting_date: '2026-08-17' }),
    observed({ meeting_date: DATE, off_time_iso: '2026-08-18T14:00:00.000Z' }),
    DATE,
  );
  assert.equal(moved.classification, 'meeting_date_differs');
  assert.equal(moved.tightening_eligible, false);
});

/* ========================================================================== *
 * 9-13. The effective off — monotonicity, ceiling, order, identity
 * ========================================================================== */

test('9. IDENTITY: with no eligible observations the effective off IS the stored off', () => {
  for (const obs of [[], [ob('2026-08-18T14:00:00.000Z', false)], [ob(null)]]) {
    const e = resolveEffectiveOffTime(STORED_OFF, obs);
    assert.equal(e.effectiveOffTime, STORED_OFF, 'byte-identical: the guard behaves exactly as today');
    assert.equal(e.tightened, false);
    assert.equal(e.corroboratingCount, 0);
  }
  // An unparseable stored off is returned unchanged rather than guessed.
  assert.equal(resolveEffectiveOffTime(null, [ob('2026-08-18T14:00:00.000Z')]).effectiveOffTime, null);
});

test('10. CORROBORATION: one eligible observation is never enough', () => {
  assert.equal(MIN_CORROBORATING_OBSERVATIONS, 2);
  const one = resolveEffectiveOffTime(STORED_OFF, [ob('2026-08-18T14:00:00.000Z')]);
  assert.equal(one.tightened, false, 'one transient bad card must not suppress a run or forfeit a lock');
  assert.equal(one.effectiveOffTime, STORED_OFF);

  const two = resolveEffectiveOffTime(STORED_OFF, [ob('2026-08-18T14:00:00.000Z'), ob('2026-08-18T14:00:00.000Z')]);
  assert.equal(two.tightened, true);
  assert.equal(two.effectiveOffTime, '2026-08-18T14:00:00.000Z');
  assert.equal(two.corroboratingCount, 2);
});

test('11. the k-th SMALLEST is used, not the minimum: one outlier cannot win', () => {
  // Support for "this race goes off at X" is the number of observations at or
  // before X. The minimum would let a single outlier set the effective off.
  const outlier = resolveEffectiveOffTime(STORED_OFF, [ob('2026-08-18T13:00:00.000Z'), ob('2026-08-18T14:00:00.000Z')]);
  assert.equal(outlier.effectiveOffTime, '2026-08-18T14:00:00.000Z', 'the lone 13:00 is not corroborated');

  const corroborated = resolveEffectiveOffTime(STORED_OFF, [
    ob('2026-08-18T13:00:00.000Z'), ob('2026-08-18T13:00:00.000Z'), ob('2026-08-18T14:00:00.000Z'),
  ]);
  assert.equal(corroborated.effectiveOffTime, '2026-08-18T13:00:00.000Z');
});

test('12. MONOTONICITY + CEILING: adding evidence can only LOWER, never raise', () => {
  const growing: EffectiveOffObservation[] = [];
  let previous = Date.parse(STORED_OFF);
  for (const iso of [
    '2026-08-18T14:20:00.000Z', '2026-08-18T14:20:00.000Z',
    '2026-08-18T14:10:00.000Z', '2026-08-18T14:10:00.000Z',
    '2026-08-18T13:00:00.000Z', '2026-08-18T13:00:00.000Z',
  ]) {
    growing.push(ob(iso));
    const e = resolveEffectiveOffTime(STORED_OFF, growing);
    const ms = Date.parse(e.effectiveOffTime ?? '');
    assert.ok(ms <= previous, 'the effective off may never move later');
    assert.ok(ms <= Date.parse(STORED_OFF), 'CEILING: never later than the stored off');
    previous = ms;
  }

  // A LATER observation marked eligible (only reachable by a direct SQL writer;
  // the CHECK forbids it) still cannot raise anything.
  const late = resolveEffectiveOffTime(STORED_OFF, [ob('2026-08-18T15:00:00.000Z'), ob('2026-08-18T15:00:00.000Z')]);
  assert.equal(late.effectiveOffTime, STORED_OFF, 'a later instant is filtered out entirely');
  assert.equal(late.tightened, false);
});

test('13. ORDER-INDEPENDENCE: the result never depends on input order', () => {
  const obs = [
    ob('2026-08-18T13:00:00.000Z'), ob('2026-08-18T14:00:00.000Z'),
    ob('2026-08-18T14:00:00.000Z'), ob('2026-08-18T12:00:00.000Z', false),
  ];
  const forward = resolveEffectiveOffTime(STORED_OFF, obs);
  const reversed = resolveEffectiveOffTime(STORED_OFF, [...obs].reverse());
  assert.deepEqual(forward, reversed);
});

/* ========================================================================== *
 * 14-20. Recording: batching, dedupe, failure isolation
 * ========================================================================== */

function ctx(hadOfficialLock = false) {
  return {
    observedAtIso: '2026-08-18T12:00:00.000Z',
    observer: OFF_TIME_OBSERVER_RACECARDS,
    scopeMeetingDate: DATE,
    hadOfficialLock,
  };
}

interface Recorder {
  calls: string[];
  inserted: OffTimeObservationInsertRow[];
}

function fakeLookups(
  rec: Recorder,
  options: { rows?: StoredRaceOffTime[]; locked?: string[]; failOn?: 'fetchStoredRaces' | 'fetchOfficialLockRaceIds' | 'insertObservations' } = {},
): OffTimeObservationLookups {
  const boom = (name: string) => {
    if (options.failOn === name) throw new Error(`${name} failed: fixture`);
  };
  return {
    async fetchStoredRaces(ids) {
      rec.calls.push(`fetchStoredRaces(${ids.length})`);
      boom('fetchStoredRaces');
      return options.rows ?? [stored()];
    },
    async fetchOfficialLockRaceIds(ids) {
      rec.calls.push(`fetchOfficialLockRaceIds(${ids.length})`);
      boom('fetchOfficialLockRaceIds');
      return new Set(options.locked ?? []);
    },
    async insertObservations(rows) {
      rec.calls.push(`insertObservations(${rows.length})`);
      boom('insertObservations');
      rec.inserted.push(...rows);
    },
  };
}

test('14. an all-unchanged sync costs exactly ONE read and writes nothing', async () => {
  const rec: Recorder = { calls: [], inserted: [] };
  const s = await recordOffTimeObservations([observed()], DATE, ctx().observedAtIso, OFF_TIME_OBSERVER_RACECARDS, fakeLookups(rec));
  assert.deepEqual(rec.calls, ['fetchStoredRaces(1)'], 'no lock read, no insert on the common path');
  assert.deepEqual(rec.inserted, []);
  assert.deepEqual(s, emptyOffTimeObservationSummary());
});

test('15. a divergence is recorded once, with lock context, and counted', async () => {
  const rec: Recorder = { calls: [], inserted: [] };
  const s = await recordOffTimeObservations(
    [observed({ off_time_iso: '2026-08-18T14:00:00.000Z' })],
    DATE, ctx().observedAtIso, OFF_TIME_OBSERVER_RACECARDS,
    fakeLookups(rec, { locked: [RACE] }),
  );
  assert.deepEqual(rec.calls, ['fetchStoredRaces(1)', 'fetchOfficialLockRaceIds(1)', 'insertObservations(1)']);
  assert.equal(s.offTimeDivergencesObserved, 1);
  assert.equal(s.offTimeTighteningObservations, 1);
  assert.equal(s.offTimeObservationsRecorded, 1);
  assert.equal(s.offTimeObservationErrors, 0);

  const row = rec.inserted[0];
  assert.equal(row.classification, 'earlier_than_stored');
  assert.equal(row.tightening_eligible, true);
  assert.equal(row.stored_off_time, STORED_OFF, 'the stored value is evidence, never rewritten');
  assert.equal(row.had_official_lock, true, 'context only — it gates nothing, because nothing is applied');
  assert.equal(row.scope_meeting_date, DATE);
  assert.equal(row.observer, OFF_TIME_OBSERVER_RACECARDS);
});

test('16. repeated identical observations in ONE sync collapse to a single row', async () => {
  const rec: Recorder = { calls: [], inserted: [] };
  const dup = observed({ off_time_iso: '2026-08-18T14:00:00.000Z' });
  const s = await recordOffTimeObservations([dup, dup, dup], DATE, ctx().observedAtIso, OFF_TIME_OBSERVER_RACECARDS, fakeLookups(rec));
  assert.equal(s.offTimeObservationsRecorded, 1, 'no duplicate revision records');
  assert.equal(rec.inserted.length, 1);

  // Two cards sharing one provider race in a single response: LAST wins.
  const deduped = dedupeObservations([
    observed({ off_time_iso: '2026-08-18T14:00:00.000Z' }),
    observed({ off_time_iso: '2026-08-18T13:00:00.000Z' }),
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].off_time_iso, '2026-08-18T13:00:00.000Z');
});

test('17. EVERY recording failure is isolated: counted, logged, never thrown', async () => {
  for (const failOn of ['fetchStoredRaces', 'fetchOfficialLockRaceIds', 'insertObservations'] as const) {
    const rec: Recorder = { calls: [], inserted: [] };
    const s = await recordOffTimeObservations(
      [observed({ off_time_iso: '2026-08-18T14:00:00.000Z' })],
      DATE, ctx().observedAtIso, OFF_TIME_OBSERVER_RACECARDS,
      fakeLookups(rec, { failOn }),
    );
    assert.equal(s.offTimeObservationErrors, 1, failOn);
    assert.equal(s.offTimeObservationsRecorded, 0, failOn);
  }
  // An empty observation set does no I/O at all.
  const rec: Recorder = { calls: [], inserted: [] };
  await recordOffTimeObservations([], DATE, ctx().observedAtIso, OFF_TIME_OBSERVER_RACECARDS, fakeLookups(rec));
  assert.deepEqual(rec.calls, []);
});

test('18. a race that vanished between resolve and read is skipped, not guessed', async () => {
  const rec: Recorder = { calls: [], inserted: [] };
  const s = await recordOffTimeObservations(
    [observed({ race_id: 'gone', off_time_iso: '2026-08-18T14:00:00.000Z' })],
    DATE, ctx().observedAtIso, OFF_TIME_OBSERVER_RACECARDS,
    fakeLookups(rec, { rows: [] }),
  );
  assert.equal(s.offTimeDivergencesObserved, 0);
  assert.deepEqual(rec.inserted, []);
});

test('19. the effective-off read FAILS OPEN to the stored off', async () => {
  const e = await fetchEffectiveOffTime(RACE, STORED_OFF, {
    async fetchTighteningObservations() {
      throw new Error('relation "race_off_time_observations" does not exist');
    },
  });
  assert.equal(e.effectiveOffTime, STORED_OFF, 'a missing table degrades to exactly today');
  assert.equal(e.tightened, false);
  assert.equal(e.corroboratingCount, 0);
});

test('20. the effective-off read tightens when the evidence corroborates', async () => {
  const e = await fetchEffectiveOffTime(RACE, STORED_OFF, {
    async fetchTighteningObservations() {
      return [ob('2026-08-18T14:00:00.000Z'), ob('2026-08-18T14:00:00.000Z')];
    },
  });
  assert.equal(e.effectiveOffTime, '2026-08-18T14:00:00.000Z');
  assert.equal(e.tightened, true);
});

/* ========================================================================== *
 * 21-24. Date boundaries and provider-shaped inputs
 * ========================================================================== */

test('21. a late-evening race whose UTC instant falls on the NEXT day is not a boundary crossing', () => {
  // A 00:05 Irish race legitimately stores off_time 23:05Z with the NEXT day's
  // meeting_date. Comparing the instant's date-part to meeting_date would
  // permanently and wrongly refuse this whole class of race.
  const irish = resolveOffTime('2026-08-19T00:05:00+01:00', '2026-08-19', '00:05');
  assert.ok(irish);
  assert.equal(irish.offTimeIso, '2026-08-18T23:05:00.000Z');
  assert.equal(irish.meetingDate, '2026-08-19', 'the meeting date is the provider day, not the UTC day');

  const d = classifyOffTimeObservation(
    stored({ off_time: '2026-08-18T23:05:00.000Z', meeting_date: '2026-08-19' }),
    observed({ off_time_iso: '2026-08-18T22:50:00.000Z', meeting_date: '2026-08-19' }),
    '2026-08-19',
  );
  assert.equal(d.classification, 'earlier_than_stored', 'a genuine correction is still seen across the UTC midnight boundary');
  assert.equal(d.tightening_eligible, true);
});

test('22. a correction that changes the meeting DATE never tightens', () => {
  const d = classifyOffTimeObservation(
    stored({ meeting_date: DATE }),
    observed({ meeting_date: '2026-08-19', off_time_iso: '2026-08-19T14:00:00.000Z' }),
    '2026-08-19',
  );
  assert.equal(d.classification, 'meeting_date_differs');
  assert.equal(d.tightening_eligible, false);
});

test('23. resolveOffTime reports its SOURCE, and an abandoned card is still skipped upstream', () => {
  assert.equal(resolveOffTime('2026-08-18T14:30:00Z', '2026-08-18', '15:30')?.source, 'off_dt');
  assert.equal(resolveOffTime(undefined, '2026-08-18', '15:30')?.source, 'date_off_time');
  assert.equal(resolveOffTime(undefined, undefined, undefined), null);

  // An abandoned card maps to null and never reaches the observer at all.
  const abandoned = { course: 'Ayr', off_dt: '2026-08-18T14:30:00Z', race_name: 'X', is_abandoned: true };
  assert.equal(racecardToRaceUpsert(abandoned), null);
  // ...while a normal card exposes its provenance without entering RaceUpsert.
  const card = { course: 'Ayr', off_dt: '2026-08-18T14:30:00Z', race_name: 'X' };
  assert.equal(racecardOffTimeSource(card), 'off_dt');
  assert.equal(Object.keys(racecardToRaceUpsert(card) ?? {}).includes('off_time_source'), false,
    'provenance must never become a races column');
});

test('24. a real delay that publishes NO field change produces nothing at all', () => {
  // The most common race-day delay (a stewards hold) changes no provider field,
  // so there is no observation, no counter and no tightening. Stated plainly
  // rather than papered over.
  const d = classifyOffTimeObservation(stored(), observed(), DATE);
  assert.equal(d.classification, null);
  assert.match(src('src/lib/offTimeObservation.ts'), /HONEST LIMIT/);
});

/* ========================================================================== *
 * 25-30. Write boundary, immutability and behaviour preservation
 * ========================================================================== */

test('25. the module NEVER writes races, and its only write is one append-only insert', () => {
  const code = codeOf(src('src/lib/offTimeObservation.ts'));
  assert.doesNotMatch(code, /\.update\s*\(/, 'no update anywhere');
  assert.doesNotMatch(code, /\.upsert\s*\(/);
  assert.doesNotMatch(code, /\.delete\s*\(/);
  assert.doesNotMatch(code, /\.rpc\s*\(/);
  assert.doesNotMatch(code, /\.storage\b/);

  const inserts = code.match(/\.insert\s*\(/g) ?? [];
  assert.equal(inserts.length, 1, 'exactly one insert site');
  assert.match(code, /\.from\(OFF_TIME_OBSERVATIONS_TABLE\)\s*\n?\s*\.insert\(/);
  assert.equal(OFF_TIME_OBSERVATIONS_TABLE, 'race_off_time_observations');

  // The seam types offer no way to express a mutation of anything else.
  const seam = src('src/lib/offTimeObservation.ts');
  const block = seam.slice(seam.indexOf('export interface OffTimeObservationLookups'));
  const iface = block.slice(0, block.indexOf('\n}\n') + 2);
  assert.deepEqual([...iface.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]).sort(), [
    'fetchOfficialLockRaceIds', 'fetchStoredRaces', 'insertObservations',
  ]);
});

test('26. NO write path anywhere under src/lib rewrites races.off_time', () => {
  // Previously this was only true of the one settlement patch that happened to
  // be inspected. Now it is checked across every update payload in the tree.
  const files = [
    'src/lib/liveSync.ts', 'src/lib/todayResultsSettlement.ts', 'src/lib/raceSync.ts',
    'src/lib/runModelForRace.ts', 'src/lib/lockTMinus.ts', 'src/lib/offTimeObservation.ts',
  ];
  for (const f of files) {
    const code = codeOf(src(f));
    for (const patch of [...code.matchAll(/\.update\(\{([^}]*)\}\)/g)].map((m) => m[1])) {
      for (const frozen of ['off_time', 'race_slug', 'course_key', 'meeting_date', 'provider_race_id', 'course']) {
        assert.equal(patch.includes(frozen), false, `${f} must never rewrite ${frozen}`);
      }
    }
  }
  // And the observations table is never the target of a mutation.
  for (const f of files) {
    const code = codeOf(src(f));
    assert.doesNotMatch(code, /race_off_time_observations[\s\S]{0,60}\.(update|upsert|delete)\(/);
  }
});

test('27. the guards consume the EFFECTIVE off; the lock still records the STORED off', () => {
  const model = src('src/lib/runModelForRace.ts');
  assert.match(model, /const effectiveOff = await fetchEffectiveOffTime\(raceId, storedOffTime\)/);
  assert.match(model, /off_time: effectiveOff\.effectiveOffTime/, 'the guard judges the strictest known off');
  assert.match(model, /off_time_at_run: effectiveOff\.effectiveOffTime/, 'and the run records what it was judged against');

  // The lock's immutable columns are untouched, so both DB CHECKs still hold.
  const lock = src('src/lib/lockTMinus.ts');
  assert.match(lock, /off_time_at_lock: capture\.off_time/);
  // The CLI refuses rather than re-anchoring, and only ever refuses.
  const cli = src('scripts/lockTMinus.ts');
  assert.match(cli, /kind: 'skipped_off_time_contested'/);
  const refuseAt = cli.indexOf("kind: 'skipped_off_time_contested'");
  // The INSERT, not the earlier already-locked pre-check, which also reads that
  // table — `indexOf` alone would find the pre-check and prove nothing.
  const insertAt = cli.indexOf('.insert(row)');
  assert.ok(refuseAt > 0 && insertAt > refuseAt, 'the contested check is the LAST read before the write');
  assert.doesNotMatch(codeOf(cli), /buildLockedDecisionRow\([\s\S]{0,80}effective/, 'a lock is never anchored to the effective off');
});

test('28. races.id and race_slug remain frozen; identity resolution is untouched', () => {
  const live = codeOf(src('src/lib/liveSync.ts'));
  // Still exactly one races insert, still insert-only, still provider-id-first.
  assert.equal((live.match(/from\('races'\)\.insert\(/g) ?? []).length, 1);
  assert.match(live, /resolveExistingRaceId\(raceRow, supabaseRaceResolutionLookups\)/);
  assert.doesNotMatch(live, /from\('races'\)[\s\S]{0,80}\.upsert\(/);
  // The observation is collected on the RESOLVED branch only — a newly inserted
  // race cannot diverge from itself.
  const resolvedAt = live.indexOf('summary.racesExisting++');
  const pushAt = live.indexOf('offTimeObservations.push(');
  const insertAt = live.indexOf("from('races').insert(");
  assert.ok(resolvedAt > 0 && pushAt > resolvedAt && pushAt < insertAt);
});

test('29. the migration is ADDITIVE only and adds no constraint to an existing column', () => {
  const statements = SQL_STATEMENTS_SOURCE.split(';').map((s) => s.trim()).filter((s) => s !== '');
  assert.ok(statements.length > 0);
  for (const s of statements) {
    const additive =
      /^create table if not exists /.test(s) ||
      /^create index if not exists /.test(s) ||
      /^create or replace function /.test(s) ||
      /^drop trigger if exists /.test(s) ||
      /^create trigger /.test(s) ||
      /^alter table public\.model_runs add column if not exists /.test(s) ||
      /^revoke all on table /.test(s) ||
      /^alter table public\.race_off_time_observations enable row level security/.test(s) ||
      /^comment on column /.test(s);
    assert.ok(additive, `non-additive statement: ${s.slice(0, 100)}`);
  }
  // Nothing destructive to EXISTING objects. Checked at STATEMENT POSITION, not
  // as a substring: `before update or delete on ...` is a trigger DEFINITION
  // that BLOCKS mutation, and a substring scan would flag the very guard that
  // makes the table append-only. `drop trigger if exists` is likewise scoped to
  // this migration's own, not-yet-existing trigger.
  for (const s of statements) {
    for (const verb of ['drop table', 'drop column', 'drop function', 'truncate', 'delete from', 'update ', 'alter column', 'rename ']) {
      assert.equal(s.startsWith(verb), false, `non-additive statement: ${s.slice(0, 80)}`);
    }
  }
  // ...and no statement anywhere mutates a table's rows.
  assert.equal(/\bupdate\s+public\./.test(SQL_STATEMENTS_SOURCE), false);
  assert.equal(/\bdelete\s+from\s+public\./.test(SQL_STATEMENTS_SOURCE), false);
  // The one column added to an existing table is nullable and default-free.
  const addColumn = statements.filter((s) => s.startsWith('alter table public.model_runs'));
  assert.equal(addColumn.length, 1);
  assert.equal(/\bnot null\b/.test(addColumn[0]), false);
  assert.equal(/\bdefault\b/.test(addColumn[0]), false);
  assert.equal(/\bunique\b/.test(addColumn[0]), false);
  // An additive migration reads no rows and backfills nothing.
  assert.equal(/\binsert into\b/.test(SQL), false);
  // The $$ BODY is blanked for statement splitting, so it must be scanned
  // separately — otherwise a destructive statement hidden inside the guard
  // function would evade every check above.
  const bodies = SQL.match(/\$\$[\s\S]*?\$\$/g) ?? [];
  assert.ok(bodies.length > 0, 'at least one function body must be discovered to be scanned');
  assert.ok(
    bodies.some((b) => b.includes('race_off_time_observations is append-only')),
    'the append-only guard body specifically must be among the bodies inspected',
  );
  for (const body of bodies) {
    // String literals are blanked FIRST so the guard's own 'UPDATE' / 'DELETE'
    // words — and its exception prose — cannot be mistaken for statements,
    // while `TG_OP = 'UPDATE'` (a comparison, not a mutation) stays legible.
    const exec = body.replace(/'(?:[^']|'')*'/g, "''");
    for (const [label, re] of DESTRUCTIVE_BODY_PATTERNS) {
      assert.doesNotMatch(exec, re, `guard body must not contain ${label}`);
    }
  }

  // Append-only posture matches locked_race_decisions.
  assert.match(SQL, /raise exception/);
  assert.match(SQL, /before update or delete on public\.race_off_time_observations/);
  assert.match(SQL, /revoke all on table public\.race_off_time_observations from public, anon, authenticated/);
  // Eligibility is a ROW-LOCAL invariant, so a direct SQL writer cannot mark a
  // later or ambiguous observation eligible.
  assert.match(SQL, /race_off_time_observations_tightening_is_earlier/);
  assert.match(SQL, /observed_off_time < stored_off_time/);
});

test('30. schema contract, registration and historical evaluation are intact', () => {
  const spec = src('src/lib/dbHealthSpec.ts');
  assert.match(spec, /'off_time_at_run'/);
  assert.match(spec, /name: 'race_off_time_observations'/);
  assert.match(spec, /race_off_time_observations_race_id_idx/);

  // The launch check must be able to NAME the migration and verify the two
  // properties that matter for an immutable audit table (RLS + the no-mutate
  // trigger). Without these, schema:launch-check FAILs saying "Migrations
  // likely needed: none" and check:db tells the operator to hand-author the
  // table from a baseline that does not contain it.
  const launch = src('src/lib/launchSchemaSpec.ts');
  assert.match(launch, /race_off_time_observations: '20260818000000_race_off_time_observations\.sql'/);
  assert.match(launch, /'race_off_time_observations',/, 'must be in RLS_REQUIRED_TABLES');
  assert.match(launch, /OFF_TIME_OBSERVATIONS_GUARD/);
  assert.match(launch, /race_off_time_observations_no_mutate/);
  assert.match(launch, /APPEND_ONLY_GUARDS/, 'both guards must be verified, not just the locked one');

  // This file is registered, or it would silently run zero assertions.
  assert.match(src('scripts/tests.ts'), /import '\.\/offTimeObservation\.test';/);

  // Historical evaluation is untouched BY CONSTRUCTION: read-side selectors
  // still read races.off_time, which no write path moves. The pre-off selector
  // and the shared guard are unchanged by this programme.
  assert.doesNotMatch(src('src/lib/modelRunGuard.ts'), /offTimeObservation|effectiveOff/);
  assert.doesNotMatch(src('src/lib/modelPerformance.ts'), /offTimeObservation|effectiveOff/);
  assert.doesNotMatch(src('src/lib/lockedEvaluation.ts'), /offTimeObservation|effectiveOff/);
});

/* ========================================================================== *
 * 31-33. Regressions found by independent review
 * ========================================================================== */

/**
 * Evaluates the migration's three row-local CHECK constraints in TypeScript.
 *
 * The suite previously asserted only that the constraint TEXT existed, so a row
 * shape the database would reject looked healthy in test. Independent review
 * found exactly that: two of six classifications produced a row violating
 * `delta_matches`, and because the insert is one batched statement, a single
 * such row destroyed the whole cycle's evidence. This runs every produced row
 * through the real predicates.
 */
function violatesChecks(row: OffTimeObservationInsertRow): string[] {
  const broken: string[] = [];

  // COLUMN TYPES, not just CHECKs. The previous helper modelled only the three
  // CHECK predicates, so it declared a row valid that the database would have
  // rejected on `observed_off_time timestamptz NOT NULL`. A row shape test that
  // cannot see the column type gives false assurance about exactly the batch-
  // killing failure this programme already fixed once.
  if (row.observed_off_time === null || row.observed_off_time === undefined) {
    broken.push('observed_off_time NOT NULL');
  } else if (!Number.isFinite(Date.parse(row.observed_off_time))) {
    broken.push('observed_off_time is not a timestamptz');
  }
  if (row.stored_off_time !== null && !Number.isFinite(Date.parse(row.stored_off_time))) {
    broken.push('stored_off_time is not a timestamptz');
  }
  for (const [field, value] of [
    ['race_id', row.race_id], ['source_field', row.source_field],
    ['classification', row.classification], ['observed_at', row.observed_at],
    ['observer', row.observer], ['scope_meeting_date', row.scope_meeting_date],
    ['observed_meeting_date', row.observed_meeting_date],
  ] as const) {
    if (value === null || value === undefined || value === '') broken.push(`${field} NOT NULL`);
  }
  if (typeof row.tightening_eligible !== 'boolean') broken.push('tightening_eligible NOT NULL');
  if (typeof row.had_official_lock !== 'boolean') broken.push('had_official_lock NOT NULL');

  // delta_matches: a BICONDITIONAL — populated exactly together.
  const storedPresent = row.stored_off_time !== null;
  const deltaPresent = row.delta_seconds !== null;
  if (storedPresent !== deltaPresent) broken.push('delta_matches');
  // zero_delta_is_scoped: a zero delta is only meaningful for the date-scoped kinds.
  if (
    row.delta_seconds !== null &&
    row.delta_seconds === 0 &&
    row.classification !== 'meeting_date_differs' &&
    row.classification !== 'out_of_scope_meeting_date'
  ) {
    broken.push('zero_delta_is_scoped');
  }
  // tightening_is_earlier: eligibility is structural.
  if (
    row.tightening_eligible &&
    !(
      row.classification === 'earlier_than_stored' &&
      row.source_field === 'off_dt' &&
      row.stored_off_time !== null &&
      row.observed_off_time !== null &&
      row.observed_off_time < row.stored_off_time
    )
  ) {
    broken.push('tightening_is_earlier');
  }
  return broken;
}

test('31. EVERY producible row satisfies every CHECK the migration declares', () => {
  const cases: { name: string; stored: StoredRaceOffTime; observed: ObservedOffTime; scope: string }[] = [
    { name: 'earlier', stored: stored(), observed: observed({ off_time_iso: '2026-08-18T14:00:00.000Z' }), scope: DATE },
    { name: 'later', stored: stored(), observed: observed({ off_time_iso: '2026-08-18T14:45:00.000Z' }), scope: DATE },
    { name: 'ambiguous', stored: stored(), observed: observed({ off_time_iso: '2026-08-18T13:30:00.000Z', source_field: 'date_off_time' }), scope: DATE },
    // The two that used to be unwritable — a real stored off, no delta.
    { name: 'out_of_scope', stored: stored(), observed: observed({ meeting_date: '2026-08-19', off_time_iso: '2026-08-19T14:00:00.000Z' }), scope: DATE },
    { name: 'meeting_date_differs', stored: stored({ meeting_date: '2026-08-17' }), observed: observed({ off_time_iso: '2026-08-18T14:00:00.000Z' }), scope: DATE },
    // Stored off absent, and stored off PRESENT BUT UNPARSEABLE — the third
    // shape that violated delta_matches before normalisation.
    { name: 'stored null', stored: stored({ off_time: null }), observed: observed({ off_time_iso: '2026-08-18T14:00:00.000Z' }), scope: DATE },
    { name: 'stored unparseable', stored: stored({ off_time: 'not-a-time' }), observed: observed({ off_time_iso: '2026-08-18T14:00:00.000Z' }), scope: DATE },
  ];

  let built = 0;
  for (const c of cases) {
    const decision = classifyOffTimeObservation(c.stored, c.observed, c.scope);
    const row = buildOffTimeObservationRow(c.stored, c.observed, decision, ctx());
    assert.ok(row, `${c.name} must produce a row`);
    built += 1;
    assert.deepEqual(violatesChecks(row), [], `${c.name} violates: ${violatesChecks(row).join(', ')}`);
  }
  assert.equal(built, cases.length, 'every case above must actually produce a row');

  // M-1: an unparseable OBSERVED instant produces NO row at all — it would have
  // been rejected by `observed_off_time timestamptz NOT NULL` and taken the
  // whole batch with it.
  for (const bad of ['not-a-time', '', '   ']) {
    const observedBad = observed({ off_time_iso: bad });
    const decision = classifyOffTimeObservation(stored(), observedBad, DATE);
    assert.equal(
      buildOffTimeObservationRow(stored(), observedBad, decision, ctx()),
      null,
      `observed "${bad}" must emit no row`,
    );
  }
});

test('32. the two date-scoped rows carry a real delta, and an unparseable stored off is normalised', () => {
  // Previously null, which satisfied neither arm of delta_matches.
  const outOfScope = buildOffTimeObservationRow(
    stored(),
    observed({ meeting_date: '2026-08-19', off_time_iso: '2026-08-19T14:00:00.000Z' }),
    classifyOffTimeObservation(stored(), observed({ meeting_date: '2026-08-19', off_time_iso: '2026-08-19T14:00:00.000Z' }), DATE),
    ctx(),
  );
  assert.ok(outOfScope);
  assert.equal(outOfScope.classification, 'out_of_scope_meeting_date');
  assert.notEqual(outOfScope.delta_seconds, null, 'a stored instant existed, so a delta must be recorded');
  assert.equal(outOfScope.stored_off_time, STORED_OFF);

  const movedDay = classifyOffTimeObservation(
    stored({ meeting_date: '2026-08-17' }),
    observed({ off_time_iso: '2026-08-18T14:00:00.000Z' }),
    DATE,
  );
  assert.equal(movedDay.classification, 'meeting_date_differs');
  assert.notEqual(movedDay.delta_seconds, null);

  // A present-but-unparseable stored value is recorded as NULL, not as garbage,
  // so "a delta exists only when a stored instant exists" holds structurally.
  const junk = buildOffTimeObservationRow(
    stored({ off_time: 'not-a-time' }),
    observed({ off_time_iso: '2026-08-18T14:00:00.000Z' }),
    classifyOffTimeObservation(stored({ off_time: 'not-a-time' }), observed({ off_time_iso: '2026-08-18T14:00:00.000Z' }), DATE),
    ctx(),
  );
  assert.ok(junk);
  assert.equal(junk.stored_off_time, null);
  assert.equal(junk.delta_seconds, null);
  assert.equal(junk.classification, 'stored_off_unknown');

  // M-2: the CHECK is the BICONDITIONAL — the strongest correct invariant. The
  // implication was broader than required, because the only extra shape it
  // admitted (stored present, delta absent) needs an unparseable observed
  // instant, which M-1 now refuses to build.
  assert.match(RAW_SQL, /\(stored_off_time is null and delta_seconds is null\)/);
  assert.match(RAW_SQL, /or \(stored_off_time is not null and delta_seconds is not null\)/);
  assert.doesNotMatch(RAW_SQL, /delta_seconds is null or stored_off_time is not null/);
});

test('32b. M-2 truth table: the CHECK accepts exactly two of four combinations', () => {
  const base = buildOffTimeObservationRow(
    stored(),
    observed({ off_time_iso: '2026-08-18T14:00:00.000Z' }),
    classifyOffTimeObservation(stored(), observed({ off_time_iso: '2026-08-18T14:00:00.000Z' }), DATE),
    ctx(),
  );
  assert.ok(base);

  // 1. both present  -> accepted
  assert.equal(violatesChecks({ ...base, stored_off_time: STORED_OFF, delta_seconds: -1800 }).includes('delta_matches'), false);
  // 2. both absent   -> accepted
  assert.equal(violatesChecks({ ...base, stored_off_time: null, delta_seconds: null }).includes('delta_matches'), false);
  // 3. stored present, delta absent -> REJECTED (the over-relaxed shape)
  assert.equal(violatesChecks({ ...base, stored_off_time: STORED_OFF, delta_seconds: null }).includes('delta_matches'), true);
  // 4. stored absent, delta present -> REJECTED
  assert.equal(violatesChecks({ ...base, stored_off_time: null, delta_seconds: -1800 }).includes('delta_matches'), true);

  // ...and no classification the runtime can produce lands in 3 or 4.
  for (const c of [
    { stored: stored(), observed: observed({ off_time_iso: '2026-08-18T14:00:00.000Z' }) },
    { stored: stored(), observed: observed({ off_time_iso: '2026-08-18T14:45:00.000Z' }) },
    { stored: stored(), observed: observed({ off_time_iso: '2026-08-18T13:30:00.000Z', source_field: 'date_off_time' }) },
    { stored: stored(), observed: observed({ meeting_date: '2026-08-19', off_time_iso: '2026-08-19T14:00:00.000Z' }) },
    { stored: stored({ meeting_date: '2026-08-17' }), observed: observed({ off_time_iso: '2026-08-18T14:00:00.000Z' }) },
    { stored: stored({ off_time: null }), observed: observed({ off_time_iso: '2026-08-18T14:00:00.000Z' }) },
  ]) {
    const row = buildOffTimeObservationRow(
      c.stored, c.observed, classifyOffTimeObservation(c.stored, c.observed, DATE), ctx(),
    );
    assert.ok(row);
    assert.deepEqual(violatesChecks(row), []);
  }
});

test('33. a pre-migration schema cannot break the model run: the new column is fail-open', () => {
  // Independent review found the column was inserted unconditionally, so
  // deploying before the migration would have hard-failed EVERY model run —
  // no runs, no recommendations, no locks — while a shipped comment claimed
  // deploy order was free.
  // ONLY the two codes that PROVE pre-execution rejection may retry.
  for (const err of [
    { code: 'PGRST204', message: "Could not find the 'off_time_at_run' column of 'model_runs'" },
    { code: '42703', message: 'column "off_time_at_run" of relation "model_runs" does not exist' },
    { code: '42703' },
  ]) {
    assert.equal(isMissingColumnError(err), true, JSON.stringify(err));
  }

  // L-1: a message is an unbounded provider-formatted string and proves
  // NOTHING about whether the insert executed. A retry after a possibly
  // committed insert would create a second model run, so every one of these
  // must be refused — including the missing-column WORDING under an unrelated
  // code, and the same wording with NO code at all.
  for (const err of [
    null, undefined, 'boom', 42, [], {},
    { message: "could not find the 'off_time_at_run' column in the schema cache" },
    { code: '23505', message: "could not find the 'off_time_at_run' column" },
    { code: 'PGRST301', message: 'could not find the column' },
    { code: 'PGRST205', message: "Could not find the table 'public.model_runs' in the schema cache" },
    { code: '23505', message: 'duplicate key value violates unique constraint' },
    { code: '42501', message: 'permission denied for table model_runs' },
    { code: '42P01', message: 'relation "model_runs" does not exist' },
    { message: 'network unreachable' },
    { message: 'fetch failed' },
    { code: 42703, message: 'numeric code is not the string code' },
  ]) {
    assert.equal(isMissingColumnError(err), false, JSON.stringify(err));
  }
  // The detector is code-based only — no text matching survives.
  assert.doesNotMatch(codeOf(src('src/lib/offTimeObservation.ts')), /could not find/i);

  const model = src('src/lib/runModelForRace.ts');
  // Exactly one optimistic attempt plus exactly one bounded retry — never a loop.
  assert.match(model, /isMissingColumnError\(runError\)/);
  assert.equal((model.match(/off_time_at_run:/g) ?? []).length, 1, 'the column is named once');
  assert.equal((model.match(/\.from\(MODEL_RUNS_TABLE\)\s*\n\s*\.insert\(/g) ?? []).length, 2, 'attempt + one retry');
  assert.doesNotMatch(codeOf(model), /while\s*\(|for\s*\(\s*let\s+attempt/, 'no retry loop');
  // The retry drops ONLY that column; every other field is identical.
  assert.match(model, /\.insert\(\{ \.\.\.modelRunBase, \.\.\.writeMarker \}\)/);

  // The deploy-safety claim now covers all three new dependencies.
  const obs = src('src/lib/offTimeObservation.ts');
  assert.match(obs, /DEPLOY ORDER IS FREE, and that claim covers all THREE new dependencies/);
});

test('34. the contested-lock refusal is one-directional, and asserted by BEHAVIOUR', () => {
  const capture = { capture_target_time: '2026-08-18T14:25:00.000Z' };
  const inWindow = '2026-08-18T14:27:00.000Z';

  // Untightened: byte-for-byte today's behaviour — never refuses.
  assert.equal(
    shouldRefuseContestedLock({ effectiveOffTime: STORED_OFF, tightened: false }, capture, 'scheduled', inWindow),
    false,
  );
  // Tightened but the effective off has NOT yet passed: still lockable.
  assert.equal(
    shouldRefuseContestedLock({ effectiveOffTime: '2026-08-18T14:29:00.000Z', tightened: true }, capture, 'scheduled', inWindow),
    false,
  );
  // Tightened and the effective off HAS passed: refuse.
  assert.equal(
    shouldRefuseContestedLock({ effectiveOffTime: '2026-08-18T14:26:00.000Z', tightened: true }, capture, 'scheduled', inWindow),
    true,
  );
  // Exactly AT the effective off is still lockable (inclusive last safe moment,
  // matching classifyLockWindow and the DB CHECK lock_time <= off_time_at_lock).
  assert.equal(
    shouldRefuseContestedLock({ effectiveOffTime: inWindow, tightened: true }, capture, 'scheduled', inWindow),
    false,
  );
  // A null effective off cannot manufacture a refusal from nothing.
  assert.equal(
    shouldRefuseContestedLock({ effectiveOffTime: null, tightened: true }, capture, 'scheduled', inWindow),
    false,
  );

  // ONE-DIRECTIONAL: across a sweep of effective offs it NEVER returns false
  // where the untightened call would have refused — it can only ever add
  // refusals, never remove one, and never create a lock.
  for (const off of ['2026-08-18T13:00:00.000Z', '2026-08-18T14:26:00.000Z', '2026-08-18T14:30:00.000Z', '2026-08-18T15:00:00.000Z']) {
    const refused = shouldRefuseContestedLock({ effectiveOffTime: off, tightened: true }, capture, 'scheduled', inWindow);
    assert.equal(typeof refused, 'boolean');
    if (!refused) {
      // Not refusing leaves the ORIGINAL decision untouched — it never asserts
      // that a lock should be created.
      assert.equal(shouldRefuseContestedLock({ effectiveOffTime: off, tightened: false }, capture, 'scheduled', inWindow), false);
    }
  }

  // A resulted race is refused regardless of the clock (delegated to the shared guard).
  assert.equal(
    shouldRefuseContestedLock({ effectiveOffTime: '2026-08-18T16:00:00.000Z', tightened: true }, capture, 'result', inWindow),
    true,
  );
});

test('35. L-2 FIXTURE PROOF: the hardened body scanner catches unqualified destructive DML', () => {
  // The scanner is only worth having if it FAILS on the thing it exists to
  // catch. These fixtures are the exact statements the previous
  // `delete from public.` / `update public.` scan let through.
  const mustFail = [
    "begin delete from race_off_time_observations where id = old.id; return old; end;",
    'begin delete from public.race_off_time_observations; return old; end;',
    "begin update race_off_time_observations set tightening_eligible = true; return new; end;",
    'begin update public.race_off_time_observations set delta_seconds = 0; return new; end;',
    'begin insert into race_off_time_observations (id) values (gen_random_uuid()); return new; end;',
    'begin drop table race_off_time_observations; end;',
    'begin alter table public.races drop column off_time; end;',
    'begin truncate race_off_time_observations; end;',
    'begin grant all on public.race_off_time_observations to anon; end;',
    'begin revoke all on public.races from service_role; end;',
  ];
  for (const fixture of mustFail) {
    const exec = fixture.replace(/'(?:[^']|'')*'/g, "''");
    const caught = DESTRUCTIVE_BODY_PATTERNS.some(([, re]) => re.test(exec));
    assert.equal(caught, true, `scanner MISSED destructive SQL: ${fixture}`);
  }

  // ...and it must NOT flag the real guard body, whose only 'UPDATE'/'DELETE'
  // are string literals and a TG_OP comparison.
  const realBodies = SQL.match(/\$\$[\s\S]*?\$\$/g) ?? [];
  assert.ok(realBodies.length > 0);
  for (const body of realBodies) {
    const exec = body.replace(/'(?:[^']|'')*'/g, "''");
    for (const [label, re] of DESTRUCTIVE_BODY_PATTERNS) {
      assert.doesNotMatch(exec, re, `false positive on the real guard body: ${label}`);
    }
  }
  // The literal-blanking is what makes that possible — prove it is load-bearing
  // by confirming the raw body DOES contain the bare words.
  assert.ok(realBodies.some((b) => b.includes("'update'") || b.includes('tg_op')),
    "the guard genuinely compares TG_OP against 'UPDATE', so blanking matters");
});
