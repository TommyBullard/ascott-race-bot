/**
 * Unit tests for the read-only race-day LESSONS report (src/lib/dayLessons.ts)
 * plus read-only source-scan guards on the pure module + CLI.
 *
 * The derivations are pure and deterministic, so no DB / network is needed. The
 * scans lock down the task's rules: the report is research-only, never writes the
 * DB, never calls an external API, never runs a pipeline, never exposes a commit
 * flag, never places a bet, and never imports model/staking/recommendation
 * logic. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BIG_FIELD_MIN_RUNNERS,
  NOT_ADVICE_NOTE,
  NO_EDGE_NOTE,
  SAMPLE_SIZE_NOTE,
  buildDayLessonsPath,
  parseDayLessonsArgs,
  buildRaceLessons,
  buildDayLessonsPatterns,
  buildWinValuePlaceNotes,
  buildDayLessonsReport,
  renderDayLessonsMarkdown,
  isLowConfidence,
  isPlacedPosition,
  placedButNotWon,
  type DayLessonsRunner,
  type DayLessonsPick,
  type DayLessonsRace,
  type DayLessonsPerformance,
} from '../src/lib/dayLessons';

function runner(over: Partial<DayLessonsRunner> = {}): DayLessonsRunner {
  return { runner_id: 'r1', horse_name: 'Test Horse', odds: 4, ev: 0.1, finish_pos: null, ...over };
}

function pick(over: Partial<DayLessonsPick> = {}): DayLessonsPick {
  return { ...runner(), confidence_label: 'Medium', stake: 1, is_favourite: false, ...over };
}

function race(over: Partial<DayLessonsRace> = {}): DayLessonsRace {
  return {
    race_id: 'race-1',
    race_name: 'Test Stakes',
    course: 'Ascot',
    off_time: '2026-06-17T14:00:00.000Z',
    status: 'result',
    field_size: 8,
    is_handicap: false,
    has_result: true,
    winner_name: 'Winner Horse',
    pick: pick(),
    favourite: runner({ runner_id: 'r-fav', horse_name: 'Fav Horse' }),
    alternatives: [],
    run_quality: 'OK',
    tipster_alignment_label: 'NO_RECOMMENDATION',
    ...over,
  };
}

// A — model wins, low confidence, big-field handicap, pick IS the favourite.
const RACE_A = race({
  race_id: 'A',
  race_name: 'Race A',
  off_time: '2026-06-17T14:00:00.000Z',
  field_size: 18,
  is_handicap: true,
  pick: pick({ runner_id: 'a', horse_name: 'Alpha', finish_pos: 1, confidence_label: 'Low', is_favourite: true }),
  favourite: runner({ runner_id: 'a', horse_name: 'Alpha', finish_pos: 1 }),
  winner_name: 'Alpha',
  run_quality: 'OK',
  tipster_alignment_label: 'ALIGNED',
});

// B — model loses, low confidence, DEGRADED data, NO_TIPSTER_CONSENSUS, alt wins.
const RACE_B = race({
  race_id: 'B',
  race_name: 'Race B',
  off_time: '2026-06-17T15:00:00.000Z',
  field_size: 10,
  is_handicap: false,
  pick: pick({ runner_id: 'm', horse_name: 'Mike', finish_pos: 4, confidence_label: 'Low', is_favourite: false }),
  favourite: runner({ runner_id: 'f', horse_name: 'Foxtrot', finish_pos: 2 }),
  alternatives: [runner({ runner_id: 'o', horse_name: 'Oscar', finish_pos: 1 })],
  winner_name: 'Oscar',
  run_quality: 'DEGRADED',
  tipster_alignment_label: 'NO_TIPSTER_CONSENSUS',
});

// C — model pick placed but did not win; favourite won; an alt placed (2nd).
const RACE_C = race({
  race_id: 'C',
  race_name: 'Race C',
  off_time: '2026-06-17T16:00:00.000Z',
  field_size: 9,
  is_handicap: false,
  pick: pick({ runner_id: 'p', horse_name: 'Papa', finish_pos: 3, confidence_label: 'Medium', is_favourite: false }),
  favourite: runner({ runner_id: 'w', horse_name: 'Whiskey', finish_pos: 1 }),
  alternatives: [runner({ runner_id: 'q', horse_name: 'Quebec', finish_pos: 2 })],
  winner_name: 'Whiskey',
  run_quality: 'OK',
  tipster_alignment_label: 'DIVERGENT',
});

// D — pending (no result yet).
const RACE_D = race({
  race_id: 'D',
  race_name: 'Race D',
  off_time: '2026-06-17T17:00:00.000Z',
  status: null,
  has_result: false,
  pick: pick({ runner_id: 'd', horse_name: 'Delta', finish_pos: null, confidence_label: 'Low' }),
  favourite: runner({ runner_id: 'e', horse_name: 'Echo', finish_pos: null }),
  alternatives: [],
  winner_name: null,
  run_quality: 'OK',
});

const ALL = [RACE_A, RACE_B, RACE_C, RACE_D];

const PERFORMANCE: DayLessonsPerformance = {
  settled_count: 3,
  winners: 1,
  losers: 2,
  profit_loss: 1.5,
  roi: 12.3,
  total_staked: 3,
  evaluationMode: 'pre_off',
  recommendations_total: 4,
  pending_count: 1,
  strike_rate: 33.3,
  no_bet_races: 0,
};

/* ----------------------------- argument parsing --------------------------- */

test('parseDayLessonsArgs: parses date/course; rejects bad dates; trims/ignores blank', () => {
  assert.deepEqual(parseDayLessonsArgs(['--date', '2026-06-17', '--course', 'Ascot']), {
    date: '2026-06-17',
    course: 'Ascot',
  });
  assert.equal(parseDayLessonsArgs(['--date', '17-06-2026']).date, undefined);
  assert.equal(parseDayLessonsArgs([]).date, undefined);
  assert.equal(parseDayLessonsArgs(['--course', '  Ascot  ', '--date', '2026-06-17']).course, 'Ascot');
  assert.equal(parseDayLessonsArgs(['--course', '   ', '--date', '2026-06-17']).course, undefined);
});

test('buildDayLessonsPath: slugifies course; omits when absent/blank', () => {
  assert.equal(buildDayLessonsPath('2026-06-17', 'Ascot'), 'reports/day-lessons-2026-06-17-ascot.md');
  assert.equal(buildDayLessonsPath('2026-06-17', 'Royal Ascot'), 'reports/day-lessons-2026-06-17-royal-ascot.md');
  assert.equal(buildDayLessonsPath('2026-06-17'), 'reports/day-lessons-2026-06-17.md');
  assert.equal(buildDayLessonsPath('2026-06-17', ''), 'reports/day-lessons-2026-06-17.md');
});

/* ------------------------------ classification ---------------------------- */

test('classification helpers honour low-confidence + top-3 place', () => {
  assert.equal(isLowConfidence('Low'), true);
  assert.equal(isLowConfidence('low'), true);
  assert.equal(isLowConfidence('High'), false);
  assert.equal(isLowConfidence(null), false);

  assert.equal(isPlacedPosition(1), true);
  assert.equal(isPlacedPosition(3), true);
  assert.equal(isPlacedPosition(4), false);
  assert.equal(isPlacedPosition(null), false);

  assert.equal(placedButNotWon(1), false);
  assert.equal(placedButNotWon(2), true);
  assert.equal(placedButNotWon(4), false);
});

/* ------------------------------ race-by-race ------------------------------ */

test('buildRaceLessons: sorts by off time and is deterministic', () => {
  const scrambled = [RACE_C, RACE_A, RACE_D, RACE_B];
  const rows = buildRaceLessons(scrambled);
  assert.deepEqual(rows.map((r) => r.race_id), ['A', 'B', 'C', 'D']);
  assert.deepEqual(buildRaceLessons(scrambled), buildRaceLessons(scrambled));
});

test('buildRaceLessons: detects alternative won/placed and pick status', () => {
  const byId = new Map(buildRaceLessons(ALL).map((r) => [r.race_id, r]));
  assert.equal(byId.get('A')!.pick_status, 'won');
  assert.equal(byId.get('B')!.pick_status, 'lost');
  assert.equal(byId.get('B')!.alternative_won, true);
  assert.equal(byId.get('C')!.alternative_placed, true);
  assert.equal(byId.get('C')!.alternative_won, false);
  assert.equal(byId.get('C')!.pick_placed, true); // 3rd is a place
  assert.equal(byId.get('D')!.pick_status, 'pending');
  assert.equal(byId.get('A')!.pick_is_favourite, true);
});

/* ------------------------------- patterns --------------------------------- */

test('buildDayLessonsPatterns: counts low-confidence winners/losers', () => {
  const p = buildDayLessonsPatterns(ALL);
  assert.equal(p.low_confidence_winners, 1); // A
  assert.equal(p.low_confidence_losers, 1); // B
});

test('buildDayLessonsPatterns: counts degraded-data winners/losers', () => {
  const p = buildDayLessonsPatterns(ALL);
  assert.equal(p.degraded_data_winners, 0);
  assert.equal(p.degraded_data_losers, 1); // B
  // A DEGRADED race whose pick won is counted as a degraded winner.
  const degradedWin = buildDayLessonsPatterns([
    race({ run_quality: 'DEGRADED', pick: pick({ finish_pos: 1, confidence_label: 'Medium' }) }),
  ]);
  assert.equal(degradedWin.degraded_data_winners, 1);
});

test('buildDayLessonsPatterns: counts no-consensus, favourite alignment, favourite wins', () => {
  const p = buildDayLessonsPatterns(ALL);
  assert.equal(p.no_tipster_consensus_races, 1); // B
  assert.equal(p.no_tipster_consensus_losers, 1); // B
  assert.equal(p.no_tipster_consensus_winners, 0);
  assert.equal(p.favourite_aligned_races, 1); // A pick is the favourite
  assert.equal(p.favourite_aligned_wins, 1); // A won
  assert.equal(p.favourite_won_races, 2); // A + C favourites finished 1st
});

test('buildDayLessonsPatterns: counts big-field handicap outcomes', () => {
  const p = buildDayLessonsPatterns(ALL);
  assert.equal(p.big_field_handicap_races, 1); // A (field 18, handicap)
  assert.equal(p.big_field_handicap_pick_wins, 1); // A won
  assert.equal(p.big_field_handicap_pick_placed, 1); // A placed (1st)
  // A big field that is NOT a handicap is not counted; a small handicap is not.
  assert.equal(
    buildDayLessonsPatterns([race({ field_size: BIG_FIELD_MIN_RUNNERS, is_handicap: false })])
      .big_field_handicap_races,
    0,
  );
  assert.equal(
    buildDayLessonsPatterns([race({ field_size: 6, is_handicap: true })]).big_field_handicap_races,
    0,
  );
});

/* ----------------------- win vs value vs place notes ---------------------- */

test('buildWinValuePlaceNotes: groups won / lost-but-alt-won / placed-not-won', () => {
  const notes = buildWinValuePlaceNotes(ALL);
  assert.deepEqual(notes.model_won, ['14:00 Race A']);
  assert.deepEqual(notes.model_lost_alternative_won, ['15:00 Race B']);
  assert.deepEqual(notes.pick_placed_not_won, ['16:00 Race C']);
});

/* -------------------------------- rendering ------------------------------- */

function buildReport() {
  return buildDayLessonsReport({
    date: '2026-06-17',
    course: 'Ascot',
    generatedAt: '2026-06-17T20:00:00.000Z',
    performance: PERFORMANCE,
    races: ALL,
  });
}

test('renderDayLessonsMarkdown: renders the final performance summary', () => {
  const md = renderDayLessonsMarkdown(buildReport());
  assert.match(md, /## 1\. Final performance summary/);
  assert.match(md, /- Settled races: 3/);
  assert.match(md, /- Winners: 1/);
  assert.match(md, /- Losers: 2/);
  assert.match(md, /- Profit\/Loss: \+1\.50pt/);
  assert.match(md, /- ROI: \+12\.3%/);
  assert.match(md, /- Total staked: 3\.00/);
  assert.match(md, /- Evaluation mode: pre_off/);
});

test('renderDayLessonsMarkdown: is deterministic and includes every section', () => {
  const report = buildReport();
  assert.equal(renderDayLessonsMarkdown(report), renderDayLessonsMarkdown(report));
  const md = renderDayLessonsMarkdown(report);
  assert.match(md, /## 2\. Race-by-race lessons/);
  assert.match(md, /## 3\. Pattern analysis/);
  assert.match(md, /## 4\. Win vs value vs place notes/);
  assert.match(md, /## 5\. Future action ideas/);
  assert.match(md, /## 6\. Safety/);
  // race-by-race surfaces pick, winner, favourite, confidence, data quality, alignment, alt flags
  assert.match(md, /Model pick: Alpha — finish 1 \(Won\)/);
  assert.match(md, /Winner: Alpha/);
  assert.match(md, /Tipster alignment: NO_TIPSTER_CONSENSUS/);
  assert.match(md, /Alternative won: yes/);
});

test('renderDayLessonsMarkdown: includes the sample-size + safety disclaimers, no edge claim', () => {
  const md = renderDayLessonsMarkdown(buildReport());
  assert.match(md, /far too small a sample/i);
  assert.ok(md.includes(SAMPLE_SIZE_NOTE));
  assert.ok(md.includes(NOT_ADVICE_NOTE));
  assert.ok(md.includes(NO_EDGE_NOTE));
  assert.match(md, /not betting advice/i);
});

test('renderDayLessonsMarkdown: missing values render as the em dash', () => {
  const md = renderDayLessonsMarkdown(
    buildDayLessonsReport({
      date: '2026-06-17',
      course: null,
      generatedAt: '2026-06-17T20:00:00.000Z',
      performance: PERFORMANCE,
      races: [
        race({
          race_name: null,
          pick: null,
          favourite: null,
          alternatives: [],
          winner_name: null,
          has_result: false,
          status: null,
          run_quality: null,
          tipster_alignment_label: null,
        }),
      ],
    }),
  );
  assert.match(md, /Model pick: \u2014 — finish \u2014 \(No bet\)/);
  assert.match(md, /Winner: \u2014/);
  assert.match(md, /Data quality: \u2014/);
});

/* ----------------- read-only guards (source scans) ------------------------ */

test('the lessons module is pure (no imports, DB, fs, env, network, engines, commit flag)', () => {
  const lib = readFileSync('src/lib/dayLessons.ts', 'utf8');
  assert.equal(/^\s*import\s/m.test(lib), false); // zero imports — fully self-contained
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs/.test(lib), false);
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/\bfetch\s*\(/.test(lib), false);
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(lib), false);
  assert.equal(/--commit/.test(lib), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/i.test(lib), false);
  assert.equal(/bettingEngine|modelProbabilities|kellyStake|scoreRaceRunners/.test(lib), false);
  assert.equal(/racingApi|betfair/i.test(lib), false);
});

test('the lessons CLI is read-only (select-only, no writes, no commit flag, no external API)', () => {
  const cli = readFileSync('scripts/dayLessons.ts', 'utf8');
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(cli), false);
  assert.equal(/--commit/.test(cli), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/i.test(cli), false);
  assert.equal(/\bfetch\s*\(/.test(cli), false); // no direct external API call
  assert.equal(/racingApi|betfair/i.test(cli), false); // no Racing API / Betfair clients
  assert.equal(/runModelForRace|runModelsForRaceDay/.test(cli), false); // never runs the model
  // It reads through the shared read-only helpers only.
  assert.match(cli, /fetchRaceCard/);
  assert.match(cli, /computeModelPerformance/);
  assert.match(cli, /\.select\(/); // read-only access
});
