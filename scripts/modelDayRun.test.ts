/**
 * Unit tests for the pure race-day model-run helpers (src/lib/modelDayRun.ts).
 *
 * No DB: synthetic argv + outcome lists verify argument parsing, the dry-run /
 * commit gating defaults, outcome accumulation (run / skipped / failed), and
 * summary formatting. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseModelDayArgs,
  summarizeModelDayOutcomes,
  formatModelDaySummary,
  type RaceRunOutcome,
} from '../src/lib/modelDayRun';

test('parseModelDayArgs: date + course + commit', () => {
  const a = parseModelDayArgs(['--date', '2026-06-16', '--course', 'Ascot', '--commit']);
  assert.equal(a.date, '2026-06-16');
  assert.equal(a.course, 'Ascot');
  assert.equal(a.commit, true);
  assert.equal(a.dryRun, false);
});

test('parseModelDayArgs: dry-run flag + defaults (commit false by default)', () => {
  const a = parseModelDayArgs(['--date', '2026-06-16', '--dry-run']);
  assert.equal(a.commit, false); // never writes without --commit
  assert.equal(a.dryRun, true);
  assert.equal(a.course, undefined);
});

test('parseModelDayArgs: missing or wrong-format date -> undefined (caller errors out)', () => {
  assert.equal(parseModelDayArgs([]).date, undefined);
  assert.equal(parseModelDayArgs(['--date', '06/16/2026']).date, undefined);
  assert.equal(parseModelDayArgs(['--date', 'today']).date, undefined);
  // Validation is shape-only (YYYY-MM-DD); an impossible calendar date passes the
  // shape check and simply matches no races downstream (no fabrication).
  assert.equal(parseModelDayArgs(['--date', '2026-13-40']).date, '2026-13-40');
});

test('parseModelDayArgs: blank course is ignored; values are trimmed', () => {
  assert.equal(parseModelDayArgs(['--course', '   ']).course, undefined);
  assert.equal(parseModelDayArgs(['--date', '  2026-06-16  ']).date, '2026-06-16');
  assert.equal(parseModelDayArgs(['--course', '  Ascot  ']).course, 'Ascot');
});

test('summarizeModelDayOutcomes: mixes run / no-bet / skipped / failed', () => {
  const outcomes: RaceRunOutcome[] = [
    { raceId: 'r1', status: 'run', recommended: 1 },
    { raceId: 'r2', status: 'run', recommended: 0 }, // no-bet
    { raceId: 'r3', status: 'run', recommended: 2 },
    { raceId: 'r4', status: 'skipped' },
    { raceId: 'r5', status: 'failed' },
  ];
  const s = summarizeModelDayOutcomes(outcomes);
  assert.equal(s.races_found, 5);
  assert.equal(s.races_run, 3);
  assert.equal(s.model_runs_created, 3);
  assert.equal(s.recommendations_created, 3); // 1 + 0 + 2
  assert.equal(s.no_bet_races, 1);
  assert.equal(s.skipped_races, 1);
  assert.equal(s.failures, 1);
});

test('summarizeModelDayOutcomes: empty -> all zero', () => {
  const s = summarizeModelDayOutcomes([]);
  assert.deepEqual(s, {
    races_found: 0,
    races_run: 0,
    model_runs_created: 0,
    recommendations_created: 0,
    no_bet_races: 0,
    skipped_races: 0,
    failures: 0,
  });
});

test('summarizeModelDayOutcomes: missing recommended counts as no-bet', () => {
  const s = summarizeModelDayOutcomes([{ raceId: 'r1', status: 'run' }]);
  assert.equal(s.recommendations_created, 0);
  assert.equal(s.no_bet_races, 1);
});

test('formatModelDaySummary: one line per count', () => {
  const lines = formatModelDaySummary(summarizeModelDayOutcomes([]));
  assert.equal(lines.length, 7);
  assert.ok(lines.some((l) => l.includes('races_found: 0')));
  assert.ok(lines.some((l) => l.includes('failures: 0')));
});
