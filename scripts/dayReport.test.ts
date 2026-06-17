/**
 * Unit tests for the pure end-of-day report helpers (src/lib/dayReport.ts) and a
 * read-only guard for the script (scripts/reportDay.ts).
 *
 * No DB, no network, no secrets: synthetic race records exercise argument
 * parsing, the report path, win/place classification, the P/L + day summary
 * (which reuse the shared `summarizeModelPerformance`), the factual pattern
 * counts, the per-race warnings, and the deterministic Markdown rendering. The
 * pre-off selection rule (latest run <= off_time, ignore post-off) is the pure
 * `selectPreOffRun`, exercised here to mirror what the script does. Two sanity
 * tests scan the source to prove the report performs no DB writes. Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { selectPreOffRun } from '../src/lib/modelPerformance';
import {
  parseDayReportArgs,
  buildDayReportPath,
  buildDayReportRaceWarnings,
  buildDayReportSummary,
  buildDayReportPatterns,
  racePnl,
  pickResultStatus,
  isLowConfidence,
  isPlacedPosition,
  placedButNotWon,
  renderDayReportMarkdown,
  DAY_REPORT_EVALUATION_MODE,
  type DayReport,
  type DayReportRace,
  type DayReportRunner,
  type DayReportPick,
} from '../src/lib/dayReport';

const DASH = '\u2014';

/* ------------------------------- builders -------------------------------- */

function runner(over: Partial<DayReportRunner> = {}): DayReportRunner {
  return {
    runner_id: 'r1',
    horse_name: 'Test Horse',
    odds: 4.0,
    ev: 0.1,
    model_prob: 0.25,
    market_prob: 0.25,
    finish_pos: null,
    ...over,
  };
}

function pick(over: Partial<DayReportPick> = {}): DayReportPick {
  return {
    ...runner(),
    stake: 1.0,
    confidence_label: 'Medium',
    ...over,
  };
}

/** A complete DayReportRace with sensible defaults for terse tests. */
function race(over: Partial<DayReportRace> = {}): DayReportRace {
  return {
    race_id: 'race-1',
    race_name: 'Test Stakes',
    course: 'Ascot',
    off_time: '2026-06-16T16:00:00.000Z',
    selected_run_id: 'run-1',
    selected_run_time: '2026-06-16T15:55:00.000Z',
    selected_run_is_current: false,
    post_off_run_count: 0,
    has_result: true,
    winner_name: 'Winner Horse',
    pick: pick(),
    favourite: runner({ runner_id: 'r-fav', horse_name: 'Fav Horse' }),
    alternatives: [],
    run_quality: 'OK',
    data_quality_short_summary: 'All good',
    data_quality_flags: [],
    tipster_short_summary: 'No tipster consensus',
    tipster_alignment_label: 'NO_RECOMMENDATION',
    ...over,
  };
}

/* ----------------------------- argument parsing --------------------------- */

test('parseDayReportArgs: parses --date and --course', () => {
  const a = parseDayReportArgs(['--date', '2026-06-16', '--course', 'Ascot']);
  assert.equal(a.date, '2026-06-16');
  assert.equal(a.course, 'Ascot');
});

test('parseDayReportArgs: rejects a malformed date (leaves date undefined)', () => {
  assert.equal(parseDayReportArgs(['--date', '16-06-2026']).date, undefined);
  assert.equal(parseDayReportArgs(['--date', 'not-a-date']).date, undefined);
  assert.equal(parseDayReportArgs([]).date, undefined);
});

test('parseDayReportArgs: course is optional, trimmed, order-independent; blank ignored', () => {
  assert.equal(parseDayReportArgs(['--date', '2026-06-16']).course, undefined);
  assert.equal(
    parseDayReportArgs(['--course', '  Ascot  ', '--date', '2026-06-16']).course,
    'Ascot',
  );
  assert.equal(parseDayReportArgs(['--course', '   ', '--date', '2026-06-16']).course, undefined);
});

test('buildDayReportPath: slugifies course; omits when absent/blank', () => {
  assert.equal(buildDayReportPath('2026-06-16', 'Ascot'), 'reports/day-report-2026-06-16-ascot.md');
  assert.equal(
    buildDayReportPath('2026-06-16', 'Royal Ascot'),
    'reports/day-report-2026-06-16-royal-ascot.md',
  );
  assert.equal(buildDayReportPath('2026-06-16'), 'reports/day-report-2026-06-16.md');
  assert.equal(buildDayReportPath('2026-06-16', ''), 'reports/day-report-2026-06-16.md');
});

/* ------------------------- pre-off run selection -------------------------- */

test('selects the latest pre-off run (run_time <= off_time)', () => {
  const chosen = selectPreOffRun(
    [
      { run_id: 'early', run_time: '2026-06-16T15:30:00Z' },
      { run_id: 'final', run_time: '2026-06-16T15:58:00Z' },
    ],
    '2026-06-16T16:00:00Z',
  );
  assert.equal(chosen?.run_id, 'final');
});

test('ignores post-off runs (a later stale rerun never wins)', () => {
  const chosen = selectPreOffRun(
    [
      { run_id: 'preoff', run_time: '2026-06-16T15:55:00Z' },
      { run_id: 'postoff', run_time: '2026-06-16T19:15:00Z' },
    ],
    '2026-06-16T16:00:00Z',
  );
  assert.equal(chosen?.run_id, 'preoff');
});

/* --------------------------- classification ------------------------------ */

test('isLowConfidence: case-insensitive "low" only', () => {
  assert.equal(isLowConfidence('Low'), true);
  assert.equal(isLowConfidence('low'), true);
  assert.equal(isLowConfidence(' LOW '), true);
  assert.equal(isLowConfidence('Medium'), false);
  assert.equal(isLowConfidence('High'), false);
  assert.equal(isLowConfidence(null), false);
  assert.equal(isLowConfidence(undefined), false);
});

test('place predicates: top-3 places; 2..3 placed-but-not-won', () => {
  assert.equal(isPlacedPosition(1), true);
  assert.equal(isPlacedPosition(3), true);
  assert.equal(isPlacedPosition(4), false);
  assert.equal(isPlacedPosition(null), false);
  assert.equal(placedButNotWon(1), false); // a win is not "placed but not won"
  assert.equal(placedButNotWon(2), true);
  assert.equal(placedButNotWon(3), true);
  assert.equal(placedButNotWon(4), false);
  assert.equal(placedButNotWon(null), false);
});

test('pickResultStatus: joins the pick to its finishing position', () => {
  assert.equal(pickResultStatus(race({ has_result: true, pick: pick({ finish_pos: 1 }) })), 'won');
  assert.equal(pickResultStatus(race({ has_result: true, pick: pick({ finish_pos: 5 }) })), 'lost');
  assert.equal(pickResultStatus(race({ has_result: false, pick: pick({ finish_pos: null }) })), 'pending');
  assert.equal(pickResultStatus(race({ pick: null })), 'no_bet');
});

/* --------------------------- P/L from stake/odds -------------------------- */

test('racePnl: a winner returns stake * (odds - 1)', () => {
  assert.equal(racePnl(race({ has_result: true, pick: pick({ finish_pos: 1, odds: 5, stake: 2 }) })), 8);
});

test('racePnl: a loser returns -stake', () => {
  assert.equal(racePnl(race({ has_result: true, pick: pick({ finish_pos: 3, odds: 5, stake: 2 }) })), -2);
});

test('racePnl: a pending race is null (never counted as a loss)', () => {
  assert.equal(racePnl(race({ has_result: false, pick: pick({ finish_pos: null, stake: 2 }) })), null);
});

test('racePnl: a no-bet race is null', () => {
  assert.equal(racePnl(race({ pick: null })), null);
});

test('racePnl: a zero-stake winner is money-neutral (0), not fabricated', () => {
  assert.equal(racePnl(race({ has_result: true, pick: pick({ finish_pos: 1, odds: 5, stake: 0 }) })), 0);
});

test('racePnl: a winner with no usable odds returns 0 (no fabricated price)', () => {
  assert.equal(racePnl(race({ has_result: true, pick: pick({ finish_pos: 1, odds: null, stake: 2 }) })), 0);
});

/* ------------------------------- day summary ------------------------------ */

test('buildDayReportSummary: aggregates settled/pending/no-bet/out-of-scope correctly', () => {
  const A = race({ race_id: 'A', selected_run_id: 'a', has_result: true, pick: pick({ runner_id: 'pa', finish_pos: 1, odds: 5, stake: 2, ev: 0.1 }) });
  const B = race({ race_id: 'B', selected_run_id: 'b', has_result: true, pick: pick({ runner_id: 'pb', finish_pos: 4, odds: 3, stake: 1, ev: 0.05 }) });
  const C = race({ race_id: 'C', selected_run_id: 'c', has_result: false, winner_name: null, pick: pick({ runner_id: 'pc', finish_pos: null, odds: 4, stake: 1, ev: 0.2 }) });
  const D = race({ race_id: 'D', selected_run_id: 'd', has_result: false, winner_name: null, pick: null });
  // E ran no model: no selected pre-off run -> out of scope (but counted in total).
  const E = race({ race_id: 'E', selected_run_id: null, selected_run_time: null, selected_run_is_current: null, pick: null });

  const s = buildDayReportSummary([A, B, C, D, E]);
  assert.equal(s.total_races, 5);
  assert.equal(s.recommendations_total, 3); // A, B, C
  assert.equal(s.settled_count, 2); // A, B
  assert.equal(s.pending_count, 1); // C
  assert.equal(s.winners, 1);
  assert.equal(s.losers, 1);
  assert.equal(s.strike_rate, 50);
  assert.equal(s.total_staked, 3); // 2 + 1 (C pending excluded)
  assert.equal(s.profit_loss, 7); // +8 - 1
  assert.ok(Math.abs(s.roi - 700 / 3) < 1e-9);
  assert.ok(s.average_ev !== null && Math.abs(s.average_ev - 0.35 / 3) < 1e-9);
  assert.equal(s.no_bet_races, 1); // D
  assert.equal(s.evaluation_mode, 'pre_off');
  assert.equal(s.evaluation_mode, DAY_REPORT_EVALUATION_MODE);
});

/* ------------------------------ pattern counts ---------------------------- */

test('buildDayReportPatterns: counts confidence, data-quality, tipster, favourite, and alternatives', () => {
  const R1 = race({
    race_id: 'R1',
    has_result: true,
    winner_name: 'Fav Horse',
    pick: pick({ runner_id: 'r-pick', confidence_label: 'Low', finish_pos: 2 }), // placed not won
    favourite: runner({ runner_id: 'r-fav', finish_pos: 1 }), // favourite won; pick != fav
    alternatives: [
      runner({ runner_id: 'alt-won', finish_pos: 1 }), // alternative won
      runner({ runner_id: 'alt-placed', finish_pos: 3 }), // alternative placed
    ],
    run_quality: 'DEGRADED',
    tipster_alignment_label: 'DIVERGENT',
  });
  const R2 = race({
    race_id: 'R2',
    has_result: false,
    winner_name: null,
    pick: pick({ runner_id: 'r-fav', confidence_label: 'Low', finish_pos: null }), // pick == favourite
    favourite: runner({ runner_id: 'r-fav' }),
    alternatives: [],
    run_quality: 'OK',
    tipster_alignment_label: 'NO_TIPSTER_CONSENSUS',
  });
  const R3 = race({
    race_id: 'R3',
    pick: null,
    favourite: runner({ runner_id: 'r-fav' }),
    run_quality: 'OK',
    tipster_alignment_label: 'ALIGNED',
  });

  const p = buildDayReportPatterns([R1, R2, R3]);
  assert.equal(p.low_confidence_picks, 2); // R1, R2
  assert.equal(p.degraded_data_quality_races, 1); // R1
  assert.equal(p.ok_data_quality_races, 2); // R2, R3
  assert.equal(p.divergent_tipster_races, 1); // R1
  assert.equal(p.no_tipster_consensus_races, 1); // R2
  assert.equal(p.picks_against_favourite, 1); // R1 (R2 pick == fav)
  assert.equal(p.favourite_won_races, 1); // R1
  assert.equal(p.pick_placed_not_won_races, 1); // R1 (finish 2)
  assert.equal(p.alternative_won_races, 1); // R1
  assert.equal(p.alternative_placed_races, 1); // R1 (finish 3)
  assert.equal(p.low_confidence_and_divergent, 1); // R1
  assert.equal(p.low_confidence_and_degraded, 1); // R1
  assert.equal(p.low_confidence_and_no_consensus, 1); // R2
  assert.equal(p.degraded_and_divergent, 1); // R1
});

test('buildDayReportPatterns: never infers from missing data (empty/blank races -> all zero)', () => {
  const blank = race({
    pick: null,
    favourite: null,
    alternatives: [],
    has_result: false,
    winner_name: null,
    run_quality: null,
    tipster_alignment_label: null,
  });
  const p = buildDayReportPatterns([blank]);
  assert.deepEqual(p, {
    low_confidence_picks: 0,
    degraded_data_quality_races: 0,
    ok_data_quality_races: 0,
    divergent_tipster_races: 0,
    no_tipster_consensus_races: 0,
    picks_against_favourite: 0,
    favourite_won_races: 0,
    pick_placed_not_won_races: 0,
    alternative_won_races: 0,
    alternative_placed_races: 0,
    low_confidence_and_divergent: 0,
    low_confidence_and_degraded: 0,
    low_confidence_and_no_consensus: 0,
    degraded_and_divergent: 0,
  });
});

/* -------------------------------- warnings -------------------------------- */

test('buildDayReportRaceWarnings: flags no-pre-off-run, no-result, and ignored post-off runs', () => {
  assert.deepEqual(
    buildDayReportRaceWarnings(
      race({ selected_run_id: null, has_result: true, post_off_run_count: 0 }),
    ),
    { noPreOffRun: true, noOfficialResult: false, postOffRunsIgnored: false },
  );
  assert.deepEqual(
    buildDayReportRaceWarnings(race({ selected_run_id: 'x', has_result: false, post_off_run_count: 0 })),
    { noPreOffRun: false, noOfficialResult: true, postOffRunsIgnored: false },
  );
  assert.deepEqual(
    buildDayReportRaceWarnings(race({ selected_run_id: 'x', has_result: true, post_off_run_count: 3 })),
    { noPreOffRun: false, noOfficialResult: false, postOffRunsIgnored: true },
  );
});

/* ----------------------------- markdown render ---------------------------- */

const REPORT: DayReport = {
  date: '2026-06-16',
  course: 'Ascot',
  generatedAt: '2026-06-16T20:00:00.000Z', // fixed -> deterministic
  races: [race()],
};

test('render: includes the report heading and all major sections', () => {
  const md = renderDayReportMarkdown(REPORT);
  assert.match(md, /# End-of-day race report \u2014 2026-06-16/);
  assert.match(md, /## Summary/);
  assert.match(md, /## Pattern analysis/);
  assert.match(md, /## Interpretation/);
  assert.match(md, /## Races/);
  assert.match(md, /Evaluation mode: pre_off/);
});

test('render: is deterministic (same report object -> identical string)', () => {
  assert.equal(renderDayReportMarkdown(REPORT), renderDayReportMarkdown(REPORT));
});

test('render: shows the pick finishing position and result', () => {
  const md = renderDayReportMarkdown({
    ...REPORT,
    races: [race({ has_result: true, winner_name: 'Test Horse', pick: pick({ horse_name: 'Test Horse', finish_pos: 1, odds: 5, stake: 2 }) })],
  });
  assert.match(md, /Model pick result: Won/);
  assert.match(md, /- Finish position: 1/);
  assert.match(md, /- P\/L: \+8\.00pt/);
});

test('render: a no-bet selected run renders as "No bet", not a fabricated pick', () => {
  const md = renderDayReportMarkdown({ ...REPORT, races: [race({ pick: null })] });
  assert.match(md, /Model pick result: No bet/);
  assert.match(md, /No bet \(the selected pre-off run made no rank-1 recommendation\)\./);
});

test('render: a race with no result yet renders as Pending', () => {
  const md = renderDayReportMarkdown({
    ...REPORT,
    races: [race({ has_result: false, winner_name: null, pick: pick({ finish_pos: null }) })],
  });
  assert.match(md, /Model pick result: Pending/);
});

test('render: missing values render as an em dash, never invented', () => {
  const sparse = race({
    off_time: null,
    course: null,
    winner_name: null,
    has_result: false,
    selected_run_id: null,
    selected_run_time: null,
    selected_run_is_current: null,
    pick: null,
    favourite: null,
    alternatives: [],
    run_quality: null,
    data_quality_short_summary: null,
    data_quality_flags: [],
    tipster_short_summary: null,
    tipster_alignment_label: null,
  });
  const md = renderDayReportMarkdown({ ...REPORT, races: [sparse] });
  assert.match(md, new RegExp(`- Winner: ${DASH}`));
  assert.match(md, new RegExp(`- Course: ${DASH}`));
  assert.match(md, new RegExp(`- Data quality: ${DASH}`));
  assert.match(md, /No pre-off model run exists for this race/);
  assert.match(md, /No official result is recorded for this race/);
});

test('render: post-off ignored runs surface a warning with the count', () => {
  const md = renderDayReportMarkdown({ ...REPORT, races: [race({ post_off_run_count: 2 })] });
  assert.match(md, /2 post-off run\(s\) exist but were ignored/);
});

test('render: interpretation states the pre-off record (0/7 for an Ascot-style 0-win card)', () => {
  const sevenLosers: DayReportRace[] = Array.from({ length: 7 }, (_, i) =>
    race({
      race_id: `r${i}`,
      selected_run_id: `run-${i}`,
      has_result: true,
      winner_name: 'Someone Else',
      pick: pick({ runner_id: `p${i}`, finish_pos: 4, odds: 5, stake: 1 }),
    }),
  );
  const md = renderDayReportMarkdown({
    date: '2026-06-16',
    course: 'Ascot',
    generatedAt: '2026-06-16T20:00:00.000Z',
    races: sevenLosers,
  });
  assert.match(md, /settled record was 0\/7/);
  assert.match(md, /pre-off/);
  assert.match(md, /not betting advice/);
});

test('render: interpretation makes no guarantee/prediction claims', () => {
  const md = renderDayReportMarkdown(REPORT);
  assert.equal(/guarantee|sure thing|will win|profit guaranteed/i.test(md), false);
});

test('render: empty race list yields a stable "no races" report', () => {
  const md = renderDayReportMarkdown({ ...REPORT, races: [] });
  assert.match(md, /_No races matched the given date\/course\._/);
  assert.match(md, /- Total races: 0/);
});

test('render: does not leak env/secret-looking content (sanity)', () => {
  const md = renderDayReportMarkdown(REPORT);
  assert.equal(/SERVICE_ROLE|BEGIN [A-Z ]*PRIVATE KEY|SUPABASE_URL|CRON_SECRET/.test(md), false);
});

/* ----------------------- read-only guards (source scan) ------------------- */

test('no DB writes: the report script issues only reads (no insert/update/upsert/delete/rpc)', () => {
  const src = readFileSync('scripts/reportDay.ts', 'utf8');
  assert.equal(/\.insert\s*\(/.test(src), false);
  assert.equal(/\.update\s*\(/.test(src), false);
  assert.equal(/\.upsert\s*\(/.test(src), false);
  assert.equal(/\.delete\s*\(/.test(src), false);
  assert.equal(/\.rpc\s*\(/.test(src), false);
});

test('no DB access: the pure helper module never imports a DB client, fs, or env', () => {
  const src = readFileSync('src/lib/dayReport.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(src), false);
  assert.equal(/node:fs/.test(src), false);
  assert.equal(/process\.env/.test(src), false);
});
