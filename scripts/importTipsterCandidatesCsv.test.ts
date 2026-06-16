/**
 * Unit tests for the pure helpers in the hot-tipster candidate CSV importer
 * (scripts/importTipsterCandidatesCsv.ts).
 *
 * No DB, no network: importing the script does NOT run its `main()` (it is
 * guarded by an `import.meta.url` entry-point check), so these exercise only the
 * pure parsing, validation, candidate mapping, and exact race/runner resolution
 * that keep capture safe (writes candidates only, never approves, never guesses).
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCsv,
  isBlankRow,
  isHttpUrl,
  normalizeEvidenceConfidence,
  validateCandidateImportRow,
  buildCandidateInsert,
  matchCandidateRace,
  resolveCandidateRunner,
  candidateDedupeKey,
  parseArgs,
  newAudit,
  type RawCandidateImportRow,
  type CandidateRaceRow,
} from './importTipsterCandidatesCsv';
import type { MatchableRunner } from '../src/lib/runnerMatch';

/** A complete, valid raw row with all optional fields blank by default. */
function rawRow(overrides: Partial<RawCandidateImportRow> = {}): RawCandidateImportRow {
  return {
    date: '2026-06-16',
    course: 'Ascot',
    off_time: '14:30',
    horse_name: 'Some Horse',
    tipster_name: 'Some Tipster',
    source_label: 'racing-post-tips',
    race_name: '',
    source_name: '',
    source_url: '',
    proof_url: '',
    confidence_text: '',
    evidence_confidence: '',
    notes: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CSV parsing
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
// Small helpers
// ---------------------------------------------------------------------------

test('isHttpUrl: only http(s) URLs', () => {
  assert.equal(isHttpUrl('https://example.com/tips'), true);
  assert.equal(isHttpUrl('http://example.com'), true);
  assert.equal(isHttpUrl('  https://example.com  '), true);
  assert.equal(isHttpUrl('example.com'), false);
  assert.equal(isHttpUrl('ftp://example.com'), false);
  assert.equal(isHttpUrl(''), false);
});

test('normalizeEvidenceConfidence: blank -> null; high/medium/low (case-insensitive); else not ok', () => {
  assert.deepEqual(normalizeEvidenceConfidence(''), { ok: true, value: null });
  assert.deepEqual(normalizeEvidenceConfidence(null), { ok: true, value: null });
  assert.deepEqual(normalizeEvidenceConfidence('High'), { ok: true, value: 'high' });
  assert.deepEqual(normalizeEvidenceConfidence(' MEDIUM '), { ok: true, value: 'medium' });
  assert.deepEqual(normalizeEvidenceConfidence('low'), { ok: true, value: 'low' });
  assert.deepEqual(normalizeEvidenceConfidence('very-high'), { ok: false, value: null });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('validateCandidateImportRow: a complete row validates + normalises', () => {
  const result = validateCandidateImportRow(
    rawRow({
      course: '  Ascot ',
      horse_name: ' Some Horse ',
      race_name: 'Queen Anne Stakes',
      source_name: 'Racing Post',
      source_url: 'https://example.com/tips',
      proof_url: 'https://example.com/proof',
      confidence_text: 'NAP',
      evidence_confidence: 'High',
      notes: ' strong recent form ',
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.row, {
    meetingDate: '2026-06-16',
    course: 'Ascot',
    offTime: '14:30',
    offTimeIso: '2026-06-16T14:30:00.000Z',
    horseName: 'Some Horse',
    tipsterName: 'Some Tipster',
    sourceLabel: 'racing-post-tips',
    raceName: 'Queen Anne Stakes',
    sourceName: 'Racing Post',
    sourceUrl: 'https://example.com/tips',
    proofUrl: 'https://example.com/proof',
    confidenceText: 'NAP',
    evidenceConfidence: 'high',
    notes: 'strong recent form',
  });
});

test('validateCandidateImportRow: optional fields default to null when blank', () => {
  const result = validateCandidateImportRow(rawRow());
  assert.equal(result.ok, true);
  assert.equal(result.row?.raceName, null);
  assert.equal(result.row?.sourceName, null);
  assert.equal(result.row?.sourceUrl, null);
  assert.equal(result.row?.proofUrl, null);
  assert.equal(result.row?.confidenceText, null);
  assert.equal(result.row?.evidenceConfidence, null);
  assert.equal(result.row?.notes, null);
});

test('validateCandidateImportRow: each missing/ill-formed required field is reported', () => {
  const result = validateCandidateImportRow(
    rawRow({
      date: '16-06-2026',
      course: '   ',
      off_time: '2.30pm',
      horse_name: '',
      tipster_name: '',
      source_label: '',
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.row, null);
  assert.ok(result.problems.some((p) => p.includes('meeting_date')));
  assert.ok(result.problems.some((p) => p.includes('course')));
  assert.ok(result.problems.some((p) => p.includes('off_time')));
  assert.ok(result.problems.some((p) => p.includes('horse_name')));
  assert.ok(result.problems.some((p) => p.includes('tipster_name')));
  assert.ok(result.problems.some((p) => p.includes('source_label')));
});

// Source validation: source_label required + URL fields must look like URLs.
test('validateCandidateImportRow: source_label is required (source validation)', () => {
  const result = validateCandidateImportRow(rawRow({ source_label: '   ' }));
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('source_label is required')));
});

test('validateCandidateImportRow: bad source_url / proof_url are reported, not dropped', () => {
  const badSource = validateCandidateImportRow(rawRow({ source_url: 'not-a-url' }));
  assert.equal(badSource.ok, false);
  assert.ok(badSource.problems.some((p) => p.includes('source_url')));

  const badProof = validateCandidateImportRow(rawRow({ proof_url: 'javascript:alert(1)' }));
  assert.equal(badProof.ok, false);
  assert.ok(badProof.problems.some((p) => p.includes('proof_url')));
});

test('validateCandidateImportRow: invalid evidence_confidence is reported', () => {
  const result = validateCandidateImportRow(rawRow({ evidence_confidence: 'certain' }));
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('evidence_confidence')));
});

test('validateCandidateImportRow: does not mutate its input', () => {
  const input = rawRow({ course: ' Ascot ', notes: ' x ' });
  const snapshot = JSON.stringify(input);
  validateCandidateImportRow(input);
  assert.equal(JSON.stringify(input), snapshot);
});

// ---------------------------------------------------------------------------
// Candidate mapping
// ---------------------------------------------------------------------------

test('buildCandidateInsert: maps to a pending candidate (never approved/active)', () => {
  const row = validateCandidateImportRow(
    rawRow({ evidence_confidence: 'medium', notes: 'watch' }),
  ).row!;
  const insert = buildCandidateInsert(row);
  assert.equal(insert.status, 'pending');
  assert.equal(insert.meeting_date, '2026-06-16');
  assert.equal(insert.course, 'Ascot');
  assert.equal(insert.off_time, '14:30');
  assert.equal(insert.horse_name, 'Some Horse');
  assert.equal(insert.tipster_name, 'Some Tipster');
  assert.equal(insert.source_label, 'racing-post-tips');
  assert.equal(insert.evidence_confidence, 'medium');
  assert.equal(insert.notes, 'watch');
  // It must NOT carry race_id/runner_id/tipster_id — those are set at approval.
  assert.equal('race_id' in insert, false);
  assert.equal('runner_id' in insert, false);
  assert.equal('tipster_id' in insert, false);
});

test('buildCandidateInsert: does not mutate its input', () => {
  const row = validateCandidateImportRow(rawRow()).row!;
  const snapshot = JSON.stringify(row);
  buildCandidateInsert(row);
  assert.equal(JSON.stringify(row), snapshot);
});

// ---------------------------------------------------------------------------
// Race resolution (exact + normalised)
// ---------------------------------------------------------------------------

const DAY_RACES: CandidateRaceRow[] = [
  { id: 'r-ascot-1330', course: 'Ascot', off_time: '2026-06-16T13:30:00+00:00' },
  { id: 'r-ascot-1430', course: 'Ascot', off_time: '2026-06-16T14:30:00+00:00' },
  { id: 'r-york-1415', course: 'York', off_time: '2026-06-16T14:15:00+00:00' },
];

test('matchCandidateRace: exact course + off-time resolves; Royal Ascot alias works', () => {
  assert.deepEqual(matchCandidateRace(DAY_RACES, 'Ascot', '2026-06-16T14:30:00.000Z'), {
    status: 'resolved',
    raceId: 'r-ascot-1430',
  });
  assert.deepEqual(
    matchCandidateRace(DAY_RACES, 'Royal Ascot', '2026-06-16T13:30:00.000Z'),
    { status: 'resolved', raceId: 'r-ascot-1330' },
  );
});

test('matchCandidateRace: no match -> unmatched; wrong off-time -> unmatched (no fuzzy)', () => {
  assert.deepEqual(matchCandidateRace(DAY_RACES, 'Newmarket', '2026-06-16T14:30:00.000Z'), {
    status: 'unmatched',
    raceId: null,
  });
  assert.deepEqual(matchCandidateRace(DAY_RACES, 'Ascot', '2026-06-16T14:31:00.000Z'), {
    status: 'unmatched',
    raceId: null,
  });
});

test('matchCandidateRace: duplicate course+off-time -> ambiguous', () => {
  const dup: CandidateRaceRow[] = [
    { id: 'a', course: 'Ascot', off_time: '2026-06-16T13:30:00+00:00' },
    { id: 'b', course: 'Ascot', off_time: '2026-06-16T13:30:00Z' },
  ];
  assert.deepEqual(matchCandidateRace(dup, 'Ascot', '2026-06-16T13:30:00.000Z'), {
    status: 'ambiguous',
    raceId: null,
  });
});

// ---------------------------------------------------------------------------
// Runner resolution (exact horse match + ambiguous handling)
// ---------------------------------------------------------------------------

const RUNNERS: MatchableRunner[] = [
  { id: 'run-1', horse_name: 'Some Horse (IRE)' },
  { id: 'run-2', horse_name: 'Another One' },
];

test('resolveCandidateRunner: exact normalised match resolves to the runner', () => {
  assert.deepEqual(resolveCandidateRunner(RUNNERS, 'some horse'), {
    status: 'resolved',
    runnerId: 'run-1',
  });
});

test('resolveCandidateRunner: no match -> unmatched (no partial/fuzzy)', () => {
  assert.deepEqual(resolveCandidateRunner(RUNNERS, 'Some'), {
    status: 'unmatched',
    runnerId: null,
  });
});

test('resolveCandidateRunner: two runners with the same normalised name -> ambiguous', () => {
  const dup: MatchableRunner[] = [
    { id: 'x', horse_name: 'Twin Star' },
    { id: 'y', horse_name: 'Twin Star' },
  ];
  assert.deepEqual(resolveCandidateRunner(dup, 'Twin Star'), {
    status: 'ambiguous',
    runnerId: null,
  });
});

// ---------------------------------------------------------------------------
// Dedupe key / args / audit
// ---------------------------------------------------------------------------

test('candidateDedupeKey: same pick + source -> same key (normalised)', () => {
  const a = validateCandidateImportRow(rawRow({ course: 'Royal Ascot', horse_name: 'Some Horse (IRE)' })).row!;
  const b = validateCandidateImportRow(rawRow({ course: 'Ascot', horse_name: 'some horse' })).row!;
  assert.equal(candidateDedupeKey(a), candidateDedupeKey(b));

  const c = validateCandidateImportRow(rawRow({ tipster_name: 'Other Tipster' })).row!;
  assert.notEqual(candidateDedupeKey(a), candidateDedupeKey(c));
});

test('parseArgs: reads --file and --commit (dry-run by default)', () => {
  assert.deepEqual(parseArgs(['--file', 'data/hot.csv']), { file: 'data/hot.csv', commit: false });
  assert.deepEqual(parseArgs(['--file', 'x.csv', '--commit']), { file: 'x.csv', commit: true });
  assert.deepEqual(parseArgs([]), { commit: false });
});

test('newAudit: starts at all-zero with the seven required counters', () => {
  assert.deepEqual(newAudit(), {
    rows_read: 0,
    candidates_valid: 0,
    races_resolved: 0,
    runners_resolved: 0,
    ambiguous: 0,
    unmatched: 0,
    skipped: 0,
  });
});
