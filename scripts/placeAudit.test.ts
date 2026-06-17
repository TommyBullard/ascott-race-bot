/**
 * Unit tests for the read-only each-way / place audit (src/lib/placeAudit.ts)
 * plus read-only source-scan guards on the pure module + CLI.
 *
 * The derivations are pure and deterministic, so no DB / network is needed. The
 * scans lock down the task's rules: the audit is research-only, never writes the
 * DB, never computes a payout, never exposes `--commit`, never places a bet, and
 * never imports model/staking/recommendation logic. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_PLACES,
  RESULT_PENDING_WARNING,
  clampPlaces,
  isWinningFinish,
  isPlacedFinish,
  buildPlaceAuditRace,
  buildPlaceAuditSummary,
  buildPlaceAuditReport,
  renderPlaceAuditMarkdown,
  buildPlaceAuditPath,
  parsePlaceAuditArgs,
  type AuditRunner,
  type PlaceAuditRaceInput,
} from '../src/lib/placeAudit';

const DASH = '\u2014';

function runner(id: string, name: string, finish: number | null): AuditRunner {
  return { runner_id: id, horse_name: name, finish_pos: finish };
}

function raceInput(over: Partial<PlaceAuditRaceInput> = {}): PlaceAuditRaceInput {
  return {
    race_id: 'r1',
    off_time: '2026-06-17T14:30:00Z',
    race_name: 'Test Race',
    course: 'Ascot',
    modelPick: runner('a', 'Alpha', 1),
    favourite: runner('b', 'Bravo', 2),
    alternatives: [runner('c', 'Charlie', 3), runner('d', 'Delta', 9)],
    runners: [
      runner('a', 'Alpha', 1),
      runner('b', 'Bravo', 2),
      runner('c', 'Charlie', 3),
      runner('d', 'Delta', 9),
      runner('e', 'Echo', 4),
    ],
    confidenceLabel: 'High',
    runQuality: 'OK',
    status: 'result',
    ...over,
  };
}

/* --------------------------- place detection ------------------------------ */

test('isWinningFinish / isPlacedFinish honour the configurable top-N', () => {
  assert.equal(isWinningFinish(1), true);
  assert.equal(isWinningFinish(2), false);
  assert.equal(isWinningFinish(null), false);

  assert.equal(isPlacedFinish(1, 4), true);
  assert.equal(isPlacedFinish(4, 4), true);
  assert.equal(isPlacedFinish(5, 4), false);
  assert.equal(isPlacedFinish(2, 2), true);
  assert.equal(isPlacedFinish(3, 2), false); // top-2 -> 3rd not placed
  assert.equal(isPlacedFinish(0, 4), false);
  assert.equal(isPlacedFinish(null, 4), false);
});

test('clampPlaces defaults / floors invalid values', () => {
  assert.equal(clampPlaces(4), 4);
  assert.equal(clampPlaces(2.9), 2);
  assert.equal(clampPlaces(0), DEFAULT_PLACES);
  assert.equal(clampPlaces(-1), DEFAULT_PLACES);
  assert.equal(clampPlaces(null), DEFAULT_PLACES);
  assert.equal(clampPlaces(Number.NaN), DEFAULT_PLACES);
});

/* --------------------------- per-race evaluation -------------------------- */

test('model pick + favourite won/placed are evaluated correctly', () => {
  const race = buildPlaceAuditRace(raceInput(), { places: 4 });
  assert.equal(race.modelPick?.won, true); // Alpha finished 1
  assert.equal(race.modelPick?.placed, true);
  assert.equal(race.favourite?.won, false); // Bravo finished 2
  assert.equal(race.favourite?.placed, true);
  assert.equal(race.winner?.horse_name, 'Alpha');
  assert.equal(race.raceSize, 5);
  assert.equal(race.bestAlternativeFinish, 3); // Charlie 3, Delta 9
});

test('alternatives placed/won are evaluated, and top-N is configurable', () => {
  const top4 = buildPlaceAuditRace(raceInput(), { places: 4 });
  assert.equal(top4.alternatives[0].placed, true); // Charlie 3
  assert.equal(top4.alternatives[1].placed, false); // Delta 9
  assert.equal(top4.alternatives.filter((a) => a.won).length, 0);

  const top2 = buildPlaceAuditRace(raceInput(), { places: 2 });
  assert.equal(top2.favourite?.placed, true); // 2 within top-2
  assert.equal(top2.alternatives[0].placed, false); // Charlie 3 not in top-2
});

test('model pick that lost but placed is flagged', () => {
  const race = buildPlaceAuditRace(
    raceInput({
      modelPick: runner('a', 'Alpha', 3),
      runners: [runner('w', 'Winner', 1), runner('a', 'Alpha', 3)],
    }),
    { places: 4 },
  );
  assert.equal(race.modelPick?.won, false);
  assert.equal(race.modelPick?.placed, true);
  assert.equal(race.winner?.horse_name, 'Winner');
});

test('missing finishing positions are handled safely (pending race)', () => {
  const race = buildPlaceAuditRace(
    raceInput({
      modelPick: runner('a', 'Alpha', null),
      favourite: runner('b', 'Bravo', null),
      alternatives: [runner('c', 'Charlie', null)],
      runners: [runner('a', 'Alpha', null), runner('b', 'Bravo', null)],
      status: null,
    }),
    { places: 4 },
  );
  assert.equal(race.winner, null);
  assert.equal(race.modelPick?.placed, false);
  assert.equal(race.modelPick?.won, false);
  assert.equal(race.bestAlternativeFinish, null);
  assert.equal(race.settled, false);
  assert.ok(race.warnings.includes(RESULT_PENDING_WARNING));
});

/* --------------------------------- summary -------------------------------- */

const RACE_A = raceInput({ race_id: 'A', off_time: '2026-06-17T14:00:00Z' }); // model wins
const RACE_B = raceInput({
  race_id: 'B',
  off_time: '2026-06-17T15:00:00Z',
  modelPick: runner('m', 'Mike', 3), // lost but placed
  favourite: runner('n', 'November', 5), // not placed
  alternatives: [runner('o', 'Oscar', 1), runner('p', 'Papa', 8)], // Oscar (alt) won
  runners: [
    runner('o', 'Oscar', 1),
    runner('m', 'Mike', 3),
    runner('q', 'Quebec', 2),
    runner('r', 'Romeo', 4),
    runner('n', 'November', 5),
    runner('p', 'Papa', 8),
  ],
  confidenceLabel: 'Low',
  runQuality: 'DEGRADED',
});
const RACE_C = raceInput({
  race_id: 'C',
  off_time: '2026-06-17T16:00:00Z',
  modelPick: null,
  favourite: null,
  alternatives: [],
  runners: [],
  status: null, // pending
});

test('summary aggregates wins / places across races', () => {
  const report = buildPlaceAuditReport({
    date: '2026-06-17',
    course: 'Ascot',
    config: { places: 4 },
    inputs: [RACE_B, RACE_A, RACE_C], // out of order on purpose
  });
  const s = report.summary;

  assert.deepEqual(report.races.map((r) => r.race_id), ['A', 'B', 'C']); // sorted by off

  assert.equal(s.raceCount, 3);
  assert.equal(s.settledRaceCount, 2); // A, B settled; C pending
  assert.equal(s.modelPickWon, 1); // A
  assert.equal(s.modelPickPlaced, 2); // A (1st) + B (3rd)
  assert.equal(s.modelPickLostButPlaced, 1); // B
  assert.equal(s.favouriteWon, 0);
  assert.equal(s.favouritePlaced, 1); // A Bravo (2nd); B November (5th) not
  assert.equal(s.alternativesWon, 1); // B Oscar
  assert.equal(s.alternativesPlaced, 2); // A Charlie (3rd) + B Oscar (1st)
  assert.equal(s.racesWhereAlternativeWon, 1); // B
  assert.equal(s.racesWhereAlternativePlaced, 2); // A + B
});

test('summary buckets place performance by confidence + data-quality bands', () => {
  const report = buildPlaceAuditReport({
    date: '2026-06-17',
    course: 'Ascot',
    config: { places: 4 },
    inputs: [RACE_A, RACE_B, RACE_C],
  });
  assert.deepEqual(report.summary.byConfidenceBand.HIGH, { picks: 1, won: 1, placed: 1 });
  assert.deepEqual(report.summary.byConfidenceBand.LOW, { picks: 1, won: 0, placed: 1 });
  assert.deepEqual(report.summary.byDataQuality.OK, { picks: 1, won: 1, placed: 1 });
  assert.deepEqual(report.summary.byDataQuality.DEGRADED, { picks: 1, won: 0, placed: 1 });
});

test('a favourite that wins is counted', () => {
  const race = buildPlaceAuditRace(
    raceInput({
      favourite: runner('b', 'Bravo', 1),
      modelPick: runner('a', 'Alpha', 2),
      runners: [runner('b', 'Bravo', 1), runner('a', 'Alpha', 2)],
    }),
    { places: 4 },
  );
  const s = buildPlaceAuditSummary([race]);
  assert.equal(s.favouriteWon, 1);
  assert.equal(s.favouritePlaced, 1);
});

/* -------------------------------- rendering ------------------------------- */

test('render is deterministic + shows the research disclaimers', () => {
  const report = buildPlaceAuditReport({
    date: '2026-06-17',
    course: 'Ascot',
    config: { places: 4 },
    inputs: [RACE_A, RACE_B, RACE_C],
  });
  const md = renderPlaceAuditMarkdown(report);
  assert.equal(md, renderPlaceAuditMarkdown(report)); // deterministic
  assert.match(md, /SIMULATED/);
  assert.match(md, /not betting advice/i);
  assert.match(md, /No each-way payout/i);
});

test('render computes no payout / monetary value', () => {
  const md = renderPlaceAuditMarkdown(
    buildPlaceAuditReport({
      date: '2026-06-17',
      course: 'Ascot',
      config: { places: 4 },
      inputs: [RACE_A, RACE_B],
    }),
  );
  assert.equal(/£\s*\d/.test(md), false); // no currency
  assert.equal(/\b\d+(\.\d+)?\s*(pt|pts|points)\b/i.test(md), false); // no points P&L
  assert.equal(/\bROI\b/.test(md), false);
});

test('missing values render as the em dash', () => {
  const md = renderPlaceAuditMarkdown(
    buildPlaceAuditReport({
      date: '2026-06-17',
      course: null,
      config: { places: 4 },
      inputs: [
        raceInput({
          race_name: null,
          modelPick: null,
          favourite: null,
          alternatives: [],
          runners: [],
          status: null,
        }),
      ],
    }),
  );
  assert.match(md, new RegExp(`Winner: ${DASH}`));
  assert.match(md, new RegExp(`Model pick: ${DASH}`));
  assert.match(md, new RegExp(`Market favourite: ${DASH}`));
  assert.match(md, new RegExp(`Alternatives: ${DASH}`));
});

/* -------------------------------- args / path ----------------------------- */

test('parsePlaceAuditArgs parses date/course/places and rejects bad dates', () => {
  assert.deepEqual(
    parsePlaceAuditArgs(['--date', '2026-06-17', '--course', 'Ascot', '--places', '4']),
    { date: '2026-06-17', course: 'Ascot', places: 4 },
  );
  assert.equal(parsePlaceAuditArgs(['--date', '17-06-2026']).date, null);
  assert.equal(parsePlaceAuditArgs([]).date, null);
  assert.equal(parsePlaceAuditArgs(['--date', '2026-06-17']).places, DEFAULT_PLACES);
  assert.equal(parsePlaceAuditArgs(['--date', '2026-06-17', '--places', '0']).places, DEFAULT_PLACES);
  assert.equal(parsePlaceAuditArgs(['--date', '2026-06-17', '--places', '2']).places, 2);
});

test('buildPlaceAuditPath is deterministic + course-slugged', () => {
  assert.equal(buildPlaceAuditPath('2026-06-17', 'Ascot'), 'reports/place-audit-2026-06-17-ascot.md');
  assert.equal(buildPlaceAuditPath('2026-06-17', null), 'reports/place-audit-2026-06-17.md');
  assert.equal(buildPlaceAuditPath('2026-06-17', 'Royal Ascot'), 'reports/place-audit-2026-06-17-royal-ascot.md');
});

/* --------------------- read-only guards (source scans) -------------------- */

test('the place-audit module is pure (no imports, DB, fs, env, network, engines)', () => {
  const lib = readFileSync('src/lib/placeAudit.ts', 'utf8');
  assert.equal(/^\s*import\s/m.test(lib), false);
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs/.test(lib), false);
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/\bfetch\s*\(/.test(lib), false);
  assert.equal(/bettingEngine|modelProbabilities|kellyStake|scoreRaceRunners/.test(lib), false);
});

test('the place-audit CLI is read-only (no writes, no payout, no --commit, no orders)', () => {
  const cli = readFileSync('scripts/placeAudit.ts', 'utf8');
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(cli), false);
  assert.equal(/--commit/.test(cli), false);
  assert.equal(/placeOrder|placeBet|submitOrder/i.test(cli), false);
  assert.equal(/\bfetch\s*\(/.test(cli), false); // no direct external API
  // It reads through the shared read-only helpers only.
  assert.match(cli, /fetchRaceCard/);
  assert.match(cli, /fetchRaceIdsForMeeting/);
});
