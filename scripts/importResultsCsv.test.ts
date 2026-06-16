/**
 * Unit tests for the pure helpers in the manual results CSV importer
 * (scripts/importResultsCsv.ts).
 *
 * No DB, no network: importing the script does NOT run its `main()` (it is
 * guarded by an `import.meta.url` entry-point check), so these exercise only the
 * pure parsing, validation, patch-building, and race-conflict logic that keeps
 * the importer safe (no fabrication, no null overwrites, conflicts refused).
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCsv,
  isBlankRow,
  parseFinishPos,
  composeOffTimeIso,
  canonicalIso,
  matchResultRace,
  validateResultRow,
  buildRunnerResultPatch,
  detectRaceConflicts,
  raceHasWinner,
  parseArgs,
  newAudit,
  type CandidateRace,
  type RawResultRow,
} from './importResultsCsv';

/** A complete, valid raw row with all optional fields blank by default. */
function rawRow(overrides: Partial<RawResultRow> = {}): RawResultRow {
  return {
    date: '2026-06-16',
    course: 'Ascot',
    off_time: '14:30',
    horse_name: 'Some Horse',
    finish_pos: '1',
    sp_decimal: '',
    bsp_decimal: '',
    runner_status: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseCsv / isBlankRow
// ---------------------------------------------------------------------------

test('parseCsv: header + records, quoted fields with embedded commas', () => {
  const text = 'date,course,horse_name\n2026-06-16,Ascot,"Comma, Horse"\n';
  const rows = parseCsv(text);
  assert.deepEqual(rows[0], ['date', 'course', 'horse_name']);
  assert.deepEqual(rows[1], ['2026-06-16', 'Ascot', 'Comma, Horse']);
});

test('parseCsv: escaped quotes and a final line without newline', () => {
  const rows = parseCsv('a,b\n"He said ""hi""",2');
  assert.deepEqual(rows[1], ['He said "hi"', '2']);
});

test('isBlankRow: all-empty cells only', () => {
  assert.equal(isBlankRow(['', '  ', '']), true);
  assert.equal(isBlankRow(['', 'x']), false);
});

// ---------------------------------------------------------------------------
// parseFinishPos
// ---------------------------------------------------------------------------

test('parseFinishPos: positive integers only; else null (never invented)', () => {
  assert.equal(parseFinishPos('1'), 1);
  assert.equal(parseFinishPos('12'), 12);
  assert.equal(parseFinishPos('01'), 1);
  assert.equal(parseFinishPos('0'), null);
  assert.equal(parseFinishPos('-1'), null);
  assert.equal(parseFinishPos('1.5'), null);
  assert.equal(parseFinishPos('PU'), null);
  assert.equal(parseFinishPos(''), null);
  assert.equal(parseFinishPos(null), null);
  assert.equal(parseFinishPos(undefined), null);
});

// ---------------------------------------------------------------------------
// composeOffTimeIso / canonicalIso
// ---------------------------------------------------------------------------

test('composeOffTimeIso: UTC instant, pads single-digit hours', () => {
  assert.equal(composeOffTimeIso('2026-06-16', '14:30'), '2026-06-16T14:30:00.000Z');
  assert.equal(composeOffTimeIso('2026-06-16', '9:05'), '2026-06-16T09:05:00.000Z');
  assert.equal(composeOffTimeIso('2026-06-16', 'nope'), null);
  assert.equal(composeOffTimeIso('not-a-date', '14:30'), null);
});

test('canonicalIso: canonicalises a stored timestamp or returns null', () => {
  assert.equal(canonicalIso('2026-06-16T14:30:00+00:00'), '2026-06-16T14:30:00.000Z');
  assert.equal(canonicalIso(null), null);
  assert.equal(canonicalIso(undefined), null);
  assert.equal(canonicalIso('nope'), null);
});

// ---------------------------------------------------------------------------
// matchResultRace  (req 6: match race by date + normalised course + off_time)
// ---------------------------------------------------------------------------

/** A day's races for the matcher (off_time stored as UTC, like the DB). */
const DAY_RACES: CandidateRace[] = [
  { id: 'r-ascot-1330', course: 'Ascot', off_time: '2026-06-16T13:30:00+00:00' },
  { id: 'r-ascot-1405', course: 'Ascot', off_time: '2026-06-16T14:05:00+00:00' },
  { id: 'r-york-1415', course: 'York', off_time: '2026-06-16T14:15:00+00:00' },
];

test('matchResultRace: exact course + off-time resolves to the one race', () => {
  const out = matchResultRace(DAY_RACES, 'Ascot', '2026-06-16T13:30:00.000Z');
  assert.deepEqual(out, { status: 'resolved', raceId: 'r-ascot-1330' });
});

test('matchResultRace: Royal Ascot alias matches a stored "Ascot" race', () => {
  // The CSV may say "Royal Ascot"; normalizeCourse maps it to "ascot".
  const out = matchResultRace(DAY_RACES, 'Royal Ascot', '2026-06-16T14:05:00.000Z');
  assert.deepEqual(out, { status: 'resolved', raceId: 'r-ascot-1405' });
});

test('matchResultRace: course is normalised (case/whitespace/punctuation)', () => {
  const out = matchResultRace(DAY_RACES, '  aScOt ', '2026-06-16T13:30:00.000Z');
  assert.equal(out.status, 'resolved');
  assert.equal(out.raceId, 'r-ascot-1330');
});

test('matchResultRace: no course match -> unmatched', () => {
  const out = matchResultRace(DAY_RACES, 'Newmarket', '2026-06-16T13:30:00.000Z');
  assert.deepEqual(out, { status: 'unmatched', raceId: null });
});

test('matchResultRace: right course but wrong off-time -> unmatched (no fuzzy)', () => {
  const out = matchResultRace(DAY_RACES, 'Ascot', '2026-06-16T13:31:00.000Z');
  assert.deepEqual(out, { status: 'unmatched', raceId: null });
});

test('matchResultRace: two races at the same course + off-time -> ambiguous', () => {
  const dup: CandidateRace[] = [
    { id: 'a', course: 'Ascot', off_time: '2026-06-16T13:30:00+00:00' },
    { id: 'b', course: 'Ascot', off_time: '2026-06-16T13:30:00Z' },
  ];
  const out = matchResultRace(dup, 'Ascot', '2026-06-16T13:30:00.000Z');
  assert.deepEqual(out, { status: 'ambiguous', raceId: null });
});

test('matchResultRace: a null stored off_time never matches', () => {
  const out = matchResultRace(
    [{ id: 'x', course: 'Ascot', off_time: null }],
    'Ascot',
    '2026-06-16T13:30:00.000Z',
  );
  assert.deepEqual(out, { status: 'unmatched', raceId: null });
});

// ---------------------------------------------------------------------------
// validateResultRow
// ---------------------------------------------------------------------------

test('validateResultRow: a complete row validates + normalises', () => {
  const result = validateResultRow(
    rawRow({ course: '  Ascot ', horse_name: ' Some Horse ', sp_decimal: '3.5', bsp_decimal: '3.62', runner_status: ' won ' }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.row, {
    meetingDate: '2026-06-16',
    course: 'Ascot',
    offTime: '14:30',
    offTimeIso: '2026-06-16T14:30:00.000Z',
    horseName: 'Some Horse',
    finishPos: 1,
    spDecimal: 3.5,
    bspDecimal: 3.62,
    runnerStatus: 'won',
  });
});

test('validateResultRow: optional SP/BSP/status default to null when blank', () => {
  const result = validateResultRow(rawRow({ finish_pos: '3' }));
  assert.equal(result.ok, true);
  assert.equal(result.row?.finishPos, 3);
  assert.equal(result.row?.spDecimal, null);
  assert.equal(result.row?.bspDecimal, null);
  assert.equal(result.row?.runnerStatus, null);
});

test('validateResultRow: each missing/ill-formed required field is reported', () => {
  const result = validateResultRow({
    date: '16-06-2026',
    course: '   ',
    off_time: '2.30pm',
    horse_name: '',
    finish_pos: 'PU',
    sp_decimal: '',
    bsp_decimal: '',
    runner_status: '',
  });
  assert.equal(result.ok, false);
  assert.equal(result.row, null);
  assert.ok(result.problems.some((p) => p.includes('date')));
  assert.ok(result.problems.some((p) => p.includes('course')));
  assert.ok(result.problems.some((p) => p.includes('off_time')));
  assert.ok(result.problems.some((p) => p.includes('horse_name')));
  assert.ok(result.problems.some((p) => p.includes('finish_pos')));
});

test('validateResultRow: a present but invalid price is a problem (not dropped)', () => {
  const sp = validateResultRow(rawRow({ sp_decimal: '1' })); // <= 1 not a real price
  assert.equal(sp.ok, false);
  assert.ok(sp.problems.some((p) => p.includes('sp_decimal')));

  const bsp = validateResultRow(rawRow({ bsp_decimal: 'abc' }));
  assert.equal(bsp.ok, false);
  assert.ok(bsp.problems.some((p) => p.includes('bsp_decimal')));
});

// ---------------------------------------------------------------------------
// buildRunnerResultPatch  (req 10: never null out existing fields)
// ---------------------------------------------------------------------------

test('buildRunnerResultPatch: only includes supplied fields (never null keys)', () => {
  const row = validateResultRow(rawRow({ finish_pos: '2' })).row!;
  const patch = buildRunnerResultPatch(row);
  assert.deepEqual(patch, { finish_pos: 2 });
  // No SP/BSP/status keys at all -> existing DB values are left untouched.
  assert.equal('sp_decimal' in patch, false);
  assert.equal('bsp_decimal' in patch, false);
  assert.equal('runner_status' in patch, false);
});

test('buildRunnerResultPatch: includes SP/BSP/status when supplied', () => {
  const row = validateResultRow(
    rawRow({ finish_pos: '1', sp_decimal: '4.0', bsp_decimal: '4.4', runner_status: 'won' }),
  ).row!;
  assert.deepEqual(buildRunnerResultPatch(row), {
    finish_pos: 1,
    sp_decimal: 4.0,
    bsp_decimal: 4.4,
    runner_status: 'won',
  });
});

// ---------------------------------------------------------------------------
// detectRaceConflicts  (req 14)
// ---------------------------------------------------------------------------

test('detectRaceConflicts: clean race (one winner, distinct runners) -> no conflict', () => {
  const result = detectRaceConflicts([
    { runnerId: 'a', finishPos: 1 },
    { runnerId: 'b', finishPos: 2 },
    { runnerId: 'c', finishPos: 3 },
  ]);
  assert.equal(result.conflicted, false);
  assert.deepEqual(result.reasons, []);
});

test('detectRaceConflicts: multiple finish_pos=1 -> conflict', () => {
  const result = detectRaceConflicts([
    { runnerId: 'a', finishPos: 1 },
    { runnerId: 'b', finishPos: 1 },
  ]);
  assert.equal(result.conflicted, true);
  assert.ok(result.reasons.some((r) => r.includes('finish_pos=1')));
});

test('detectRaceConflicts: duplicate rows for the same runner -> conflict', () => {
  const result = detectRaceConflicts([
    { runnerId: 'a', finishPos: 1 },
    { runnerId: 'a', finishPos: 2 },
  ]);
  assert.equal(result.conflicted, true);
  assert.ok(result.reasons.some((r) => r.includes('duplicate')));
});

test('detectRaceConflicts: reports both reasons at once', () => {
  const result = detectRaceConflicts([
    { runnerId: 'a', finishPos: 1 },
    { runnerId: 'a', finishPos: 1 },
    { runnerId: 'b', finishPos: 1 },
  ]);
  assert.equal(result.conflicted, true);
  assert.equal(result.reasons.length, 2);
});

// ---------------------------------------------------------------------------
// raceHasWinner / parseArgs / newAudit
// ---------------------------------------------------------------------------

test('raceHasWinner: true only when a finish_pos=1 row is present', () => {
  assert.equal(raceHasWinner([{ finishPos: 2 }, { finishPos: 1 }]), true);
  assert.equal(raceHasWinner([{ finishPos: 2 }, { finishPos: 3 }]), false);
  assert.equal(raceHasWinner([]), false);
});

test('parseArgs: reads --file and --commit (dry-run by default)', () => {
  assert.deepEqual(parseArgs(['--file', 'data/results.csv']), {
    file: 'data/results.csv',
    commit: false,
  });
  assert.deepEqual(parseArgs(['--file', 'x.csv', '--commit']), {
    file: 'x.csv',
    commit: true,
  });
  assert.deepEqual(parseArgs([]), { commit: false });
});

test('newAudit: starts at all-zero with the eight required counters', () => {
  assert.deepEqual(newAudit(), {
    rows_read: 0,
    races_matched: 0,
    runners_matched: 0,
    runners_updated: 0,
    unmatched_races: 0,
    unmatched_runners: 0,
    ambiguous_rows: 0,
    skipped_rows: 0,
  });
});
