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
  prepareMeetingRaces,
  runModelForMeetingRaces,
  summarizeModelDayOutcomes,
  formatModelDaySummary,
  type MeetingRace,
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
    skipped_post_off: 0,
    skipped_resulted: 0,
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
  assert.equal(lines.length, 9);
  assert.ok(lines.some((l) => l.includes('races_found: 0')));
  assert.ok(lines.some((l) => l.includes('failures: 0')));
});

// --- prepareMeetingRaces (shared by model:day + pipeline:day) ---------------

function rows(): MeetingRace[] {
  return [
    { id: 'r2', course: 'Ascot', off_time: '2026-06-16T15:00:00Z', race_name: 'Late' },
    { id: 'r1', course: 'Royal Ascot', off_time: '2026-06-16T13:30:00Z', race_name: 'Early' },
    { id: 'r3', course: 'York', off_time: '2026-06-16T14:00:00Z', race_name: 'Other' },
    { id: 'r4', course: 'Ascot', off_time: null, race_name: 'No time' },
  ];
}

test('prepareMeetingRaces: course filter (Ascot matches Royal Ascot) + off-time sort', () => {
  const out = prepareMeetingRaces(rows(), 'Ascot');
  // York excluded; the two Ascot + Royal Ascot kept, sorted by off time (null last).
  assert.deepEqual(out.map((r) => r.id), ['r1', 'r2', 'r4']);
});

test('prepareMeetingRaces: no course -> all races, sorted; nulls last', () => {
  const out = prepareMeetingRaces(rows());
  assert.deepEqual(out.map((r) => r.id), ['r1', 'r3', 'r2', 'r4']);
});

test('prepareMeetingRaces: does not mutate the input', () => {
  const input = rows();
  const snapshot = JSON.parse(JSON.stringify(input));
  prepareMeetingRaces(input, 'Ascot');
  assert.deepEqual(input, snapshot);
});

// --- runModelForMeetingRaces (injected runOne; no DB) -----------------------

test('runModelForMeetingRaces: maps run / skipped / failed from runOne', async () => {
  const races: MeetingRace[] = [
    { id: 'a', course: 'Ascot', off_time: null, race_name: null },
    { id: 'b', course: 'Ascot', off_time: null, race_name: null },
    { id: 'c', course: 'Ascot', off_time: null, race_name: null },
  ];
  const outcomes = await runModelForMeetingRaces(races, async (id) => {
    if (id === 'a') return { scored: 8, recommended: 1 }; // run
    if (id === 'b') return null; // skipped (no priced field)
    throw new Error('boom'); // c -> failed
  });
  assert.deepEqual(outcomes[0], { raceId: 'a', status: 'run', recommended: 1, scored: 8 });
  assert.deepEqual(outcomes[1], { raceId: 'b', status: 'skipped' });
  assert.equal(outcomes[2].status, 'failed');
  assert.equal(outcomes[2].error, 'boom');

  // The summary derives correctly from these outcomes.
  const s = summarizeModelDayOutcomes(outcomes);
  assert.equal(s.races_found, 3);
  assert.equal(s.races_run, 1);
  assert.equal(s.skipped_races, 1);
  assert.equal(s.failures, 1);
  assert.equal(s.recommendations_created, 1);
});

test('runModelForMeetingRaces: one failure does not stop the batch; onOutcome called per race', async () => {
  const seen: string[] = [];
  const races: MeetingRace[] = [
    { id: 'a', course: null, off_time: null, race_name: null },
    { id: 'b', course: null, off_time: null, race_name: null },
  ];
  const outcomes = await runModelForMeetingRaces(
    races,
    async (id) => {
      if (id === 'a') throw new Error('x');
      return { scored: 5, recommended: 0 };
    },
    (race) => seen.push(race.id),
  );
  assert.deepEqual(seen, ['a', 'b']); // both visited despite 'a' failing
  assert.equal(outcomes[0].status, 'failed');
  assert.equal(outcomes[1].status, 'run');
  assert.equal(outcomes[1].recommended, 0); // no-bet
});
