/**
 * Unit tests for the pure tipster-import diagnostics helpers
 * (src/lib/tipsterImportDiagnostics.ts).
 *
 * No DB, no network: synthetic data exercises the formatting and the (display-
 * only) nearby-race summary. These assert the helpers never invent a match and
 * never mutate inputs. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hhmmFromIso,
  formatRaceListingLines,
  availableRunnerNames,
  summarizeNearbyRaces,
  buildFixCsvSection,
  type DiagRaceRow,
  type ImportIssueCounts,
} from '../src/lib/tipsterImportDiagnostics';

/** A simple normaliser mirroring normalizeCourse's shape for tests. */
function fakeNormalizeCourse(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

test('hhmmFromIso: HH:MM (UTC) or en-dash when missing/unparseable', () => {
  assert.equal(hhmmFromIso('2026-06-15T14:30:00Z'), '14:30');
  assert.equal(hhmmFromIso('2026-06-15T09:05:00Z'), '09:05');
  assert.equal(hhmmFromIso(null), '\u2014');
  assert.equal(hhmmFromIso(undefined), '\u2014');
  assert.equal(hhmmFromIso('not-a-date'), '\u2014');
});

test('formatRaceListingLines: empty -> placeholder line', () => {
  assert.deepEqual(formatRaceListingLines([]), [
    '(no races found for the given filters)',
  ]);
});

test('formatRaceListingLines: sorts by off_time and includes id/course/count', () => {
  const races: DiagRaceRow[] = [
    { id: 'r2', course: 'Ascot', off_time: '2026-06-15T15:00:00Z', race_name: 'Late', runner_count: 8 },
    { id: 'r1', course: 'Ascot', off_time: '2026-06-15T14:30:00Z', race_name: 'Early', runner_count: 10 },
  ];
  const lines = formatRaceListingLines(races);
  assert.equal(lines.length, 2);
  // Earlier off-time first.
  assert.ok(lines[0].includes('14:30'));
  assert.ok(lines[0].includes('r1'));
  assert.ok(lines[0].includes('Ascot'));
  assert.ok(lines[0].includes('10 runners'));
  assert.ok(lines[1].includes('15:00'));
  assert.ok(lines[1].includes('r2'));
});

test('formatRaceListingLines: unknown runner_count renders as ?', () => {
  const lines = formatRaceListingLines([
    { id: 'r1', course: 'Ayr', off_time: '2026-06-15T13:00:00Z' },
  ]);
  assert.ok(lines[0].includes('? runners'));
});

test('availableRunnerNames: verbatim names, de-duplicated and sorted; no mutation', () => {
  const runners = [
    { horse_name: 'Sea The Stars' },
    { horse_name: 'Frankel' },
    { horse_name: 'Frankel' }, // duplicate
    { horse_name: '  ' }, // blank dropped
  ];
  const snapshot = JSON.parse(JSON.stringify(runners));
  const names = availableRunnerNames(runners);
  assert.deepEqual(names, ['Frankel', 'Sea The Stars']);
  // Verbatim — not normalised/altered.
  assert.equal(names.includes('frankel'), false);
  assert.deepEqual(runners, snapshot);
});

test('summarizeNearbyRaces: groups same-course off-times and lists other courses', () => {
  const dayRaces: DiagRaceRow[] = [
    { id: 'a', course: 'Ascot', off_time: '2026-06-15T14:30:00Z' },
    { id: 'b', course: 'ASCOT', off_time: '2026-06-15T15:05:00Z' },
    { id: 'c', course: 'Ayr', off_time: '2026-06-15T13:00:00Z' },
    { id: 'd', course: 'Newmarket', off_time: '2026-06-15T16:00:00Z' },
  ];
  const result = summarizeNearbyRaces(dayRaces, 'ascot', fakeNormalizeCourse);
  assert.deepEqual(result.sameCourseOffTimes, ['14:30', '15:05']);
  assert.deepEqual(result.otherCourses, ['Ayr', 'Newmarket']);
});

test('summarizeNearbyRaces: never returns a chosen race; no-course-match yields empty same-course', () => {
  const dayRaces: DiagRaceRow[] = [
    { id: 'c', course: 'Ayr', off_time: '2026-06-15T13:00:00Z' },
  ];
  const result = summarizeNearbyRaces(dayRaces, 'Ascot', fakeNormalizeCourse);
  assert.deepEqual(result.sameCourseOffTimes, []);
  assert.deepEqual(result.otherCourses, ['Ayr']);
  // Result shape carries no race id — it cannot be used to auto-match.
  assert.equal('raceId' in result, false);
  assert.equal('id' in result, false);
});

test('buildFixCsvSection: lists only the categories that occurred', () => {
  const counts: ImportIssueCounts = {
    skipped_missing_required: 2,
    skipped_unmatched_race: 1,
    skipped_ambiguous_race: 0,
    skipped_unmatched_horse: 3,
    skipped_ambiguous_horse: 0,
    tipsters_unresolved: 4,
    duplicate_rows_ignored_or_would_ignore: 0,
  };
  const lines = buildFixCsvSection(counts);
  const joined = lines.join('\n');
  assert.ok(joined.includes('missing required'));
  assert.ok(joined.includes('matched no race'));
  assert.ok(joined.includes('matched no runner'));
  assert.ok(joined.includes('unresolved tipster'));
  // Categories with zero count are omitted.
  assert.equal(joined.includes('more than one race'), false);
  assert.equal(joined.includes('more than one runner'), false);
  assert.equal(joined.includes('duplicate'), false);
});

test('buildFixCsvSection: all-clear when there are no issues', () => {
  const counts: ImportIssueCounts = {
    skipped_missing_required: 0,
    skipped_unmatched_race: 0,
    skipped_ambiguous_race: 0,
    skipped_unmatched_horse: 0,
    skipped_ambiguous_horse: 0,
    tipsters_unresolved: 0,
    duplicate_rows_ignored_or_would_ignore: 0,
  };
  const lines = buildFixCsvSection(counts);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('No issues detected'));
});
