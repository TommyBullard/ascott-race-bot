/**
 * Unit tests for the pure locked-decision report helpers
 * (src/lib/lockedDayReport.ts) and read-only source scans for the CLI
 * (scripts/lockedReport.ts) — Newmarket rebuild Phase 5A.
 *
 * No DB, no network, no wall clock: synthetic race inputs exercise the
 * five-bucket classification (locked_pick / locked_no_bet / no_run_available /
 * lock_missing / pending), the official P/L (stored locked odds/stake only),
 * the coverage maths, the divergence labels — including the motivating
 * Newmarket 2026-07-09 case (diagnostic pick won, official locked pick lost) —
 * and the deterministic rendering. Source scans prove the CLI is SELECT-only
 * with no commit flag and no model/odds/settlement path.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseLockedReportArgs,
  buildLockedReportPath,
  classifyOfficialStatus,
  evaluateLockedPick,
  classifyPickDivergence,
  classifyOutcomeDivergence,
  buildLockedDayReport,
  renderLockedDayReportMarkdown,
  type LockedReportRaceInput,
} from '../src/lib/lockedDayReport';
import type { LockedDecision } from '../src/lib/lockedDecisionRead';

/** A complete LockedDecision with terse-test defaults (a locked pick). */
function lockedDecision(over: Partial<LockedDecision> = {}): LockedDecision {
  return {
    decision_status: 'locked_pick',
    lock_time: '2026-07-09T15:35:30.000Z',
    minutes_before: 5,
    capture_target_time: '2026-07-09T15:35:00.000Z',
    off_time_at_lock: '2026-07-09T15:40:00.000Z',
    model_run_id: 'run-1',
    no_bet_reason: null,
    pick_runner_id: 'runner-ship',
    pick_horse_name: 'Shipbourne',
    pick_odds: 5.0,
    pick_ev: 0.1,
    pick_model_prob: 0.25,
    pick_market_prob: 0.2,
    pick_stake: 1.0,
    pick_confidence_label: 'Low',
    run_quality: 'OK',
    data_quality_flags: [],
    data_quality_short_summary: null,
    tipster_short_summary: null,
    tipster_alignment_label: null,
    locked_state_schema_version: 1,
    ...over,
  };
}

/** A complete race input with terse-test defaults. */
function race(over: Partial<LockedReportRaceInput> = {}): LockedReportRaceInput {
  return {
    race_id: 'race-1',
    race_name: 'Test Stakes',
    course: 'Newmarket',
    off_time: '2026-07-09T15:40:00.000Z',
    locked: lockedDecision(),
    settled: true,
    winner_name: 'Some Winner',
    locked_pick_finish: 4,
    diagnostic: {
      runner_id: 'runner-ship',
      horse_name: 'Shipbourne',
      odds: 5.0,
      finish_pos: 4,
    },
    diagnostic_run_exists: true,
    ...over,
  };
}

/** The motivating Newmarket 2026-07-09 final race: official lost, diagnostic won. */
function shipbourneVsAsmenWarrior(): LockedReportRaceInput {
  return race({
    race_name: 'Debenhams Handicap',
    winner_name: 'Asmen Warrior',
    locked: lockedDecision({ pick_runner_id: 'runner-ship', pick_horse_name: 'Shipbourne' }),
    locked_pick_finish: 6,
    diagnostic: {
      runner_id: 'runner-asmen',
      horse_name: 'Asmen Warrior',
      odds: 4.0,
      finish_pos: 1,
    },
  });
}

/* ------------------------------ args + path ------------------------------- */

test('parseLockedReportArgs: capture semantics, minutes-before defaults to 5, no commit flag', () => {
  const a = parseLockedReportArgs(['--date', '2026-07-09', '--course', 'Newmarket']);
  assert.equal(a.date, '2026-07-09');
  assert.equal(a.course, 'Newmarket');
  assert.equal(a.minutesBefore, 5);
  assert.equal('commit' in a, false); // read-only by construction
});

test('buildLockedReportPath: date + optional slug', () => {
  assert.equal(
    buildLockedReportPath('2026-07-09', 'Newmarket'),
    'reports/locked-report-2026-07-09-newmarket.md',
  );
  assert.equal(buildLockedReportPath('2026-07-09'), 'reports/locked-report-2026-07-09.md');
});

/* ------------------------- five-bucket classification --------------------- */

test('classifyOfficialStatus: lock row status wins; no row -> lock_missing', () => {
  assert.equal(classifyOfficialStatus(race()), 'locked_pick');
  assert.equal(
    classifyOfficialStatus(race({ locked: lockedDecision({ decision_status: 'locked_no_bet' }) })),
    'locked_no_bet',
  );
  assert.equal(
    classifyOfficialStatus(
      race({ locked: lockedDecision({ decision_status: 'no_run_available' }) }),
    ),
    'no_run_available',
  );
  assert.equal(classifyOfficialStatus(race({ locked: null })), 'lock_missing');
});

test('evaluateLockedPick: won / lost / pending; pending is NEVER a loss', () => {
  assert.equal(evaluateLockedPick(race({ locked_pick_finish: 1 })), 'won');
  assert.equal(evaluateLockedPick(race({ locked_pick_finish: 4 })), 'lost');
  assert.equal(
    evaluateLockedPick(race({ settled: false, winner_name: null, locked_pick_finish: null })),
    'pending',
  );
  // Non-pick statuses have no outcome at all.
  assert.equal(
    evaluateLockedPick(race({ locked: lockedDecision({ decision_status: 'locked_no_bet' }) })),
    null,
  );
  assert.equal(evaluateLockedPick(race({ locked: null })), null);
  // A locked_pick without a runner id is unevaluable — never guessed.
  assert.equal(
    evaluateLockedPick(race({ locked: lockedDecision({ pick_runner_id: null }) })),
    'unevaluable',
  );
});

/* ----------------------------- official summary --------------------------- */

function reportOf(inputs: LockedReportRaceInput[]) {
  return buildLockedDayReport({
    date: '2026-07-09',
    course: 'Newmarket',
    minutesBefore: 5,
    generatedAt: '2026-07-09T19:00:00.000Z',
    lockedTableAvailable: true,
    inputs,
  });
}

test('official summary counts ONLY locked_pick races; other buckets never losses', () => {
  const r = reportOf([
    race({ race_id: 'a', locked_pick_finish: 1 }), // official winner
    race({ race_id: 'b', locked_pick_finish: 5 }), // official loser
    race({ race_id: 'c', locked: lockedDecision({ decision_status: 'locked_no_bet', no_bet_reason: 'x', pick_runner_id: null, pick_horse_name: null, pick_odds: null, pick_ev: null, pick_model_prob: null, pick_market_prob: null, pick_stake: null, pick_confidence_label: null }) }),
    race({ race_id: 'd', locked: lockedDecision({ decision_status: 'no_run_available', model_run_id: null, pick_runner_id: null, pick_horse_name: null, pick_odds: null, pick_ev: null, pick_model_prob: null, pick_market_prob: null, pick_stake: null, pick_confidence_label: null }) }),
    race({ race_id: 'e', locked: null }), // lock_missing
    race({ race_id: 'f', settled: false, winner_name: null, locked_pick_finish: null }), // pending pick
  ]);
  assert.equal(r.official.recommendations_total, 3); // a, b, f only
  assert.equal(r.official.winners, 1);
  assert.equal(r.official.losers, 1);
  assert.equal(r.official.pending_count, 1); // f — pending, NOT a loss
  assert.equal(r.official.no_bet_races, 1); // c
  assert.equal(r.locked_no_bet_count, 1);
  assert.equal(r.no_run_available_count, 1); // d — separate, not a no-bet
  assert.equal(r.coverage.missing, 1); // e — separate, not a loss
  // P/L from stored locked odds/stake only: win pays 1.0 * (5.0 - 1) = 4, loss -1.
  assert.equal(r.official.profit_loss, 3);
  assert.equal(r.official.total_staked, 2);
});

test('a winning locked pick with no usable stored odds returns 0 — never fabricated', () => {
  const r = reportOf([
    race({ locked: lockedDecision({ pick_odds: null }), locked_pick_finish: 1 }),
  ]);
  assert.equal(r.official.winners, 1);
  assert.equal(r.official.profit_loss, 0);
});

test('unevaluable locked picks are excluded from winners AND losers', () => {
  const r = reportOf([race({ locked: lockedDecision({ pick_runner_id: null }) })]);
  assert.equal(r.official.recommendations_total, 0);
  assert.equal(r.unevaluable_count, 1);
});

test('coverage: 5/7 locked -> 71.4%, missing races listed', () => {
  const inputs = [
    race({ race_id: 'a' }),
    race({ race_id: 'b' }),
    race({ race_id: 'c' }),
    race({ race_id: 'd' }),
    race({ race_id: 'e' }),
    race({ race_id: 'f', locked: null, race_name: 'Missing One' }),
    race({ race_id: 'g', locked: null, race_name: 'Missing Two' }),
  ];
  const r = reportOf(inputs);
  assert.equal(r.coverage.races, 7);
  assert.equal(r.coverage.locked, 5);
  assert.equal(r.coverage.missing, 2);
  assert.equal(r.coverage.coverage_pct, 71.4);
  assert.deepEqual(
    r.coverage.missing_races.map((m) => m.race_name),
    ['Missing One', 'Missing Two'],
  );
});

/* ------------------------------- divergence ------------------------------- */

test('classifyPickDivergence: all labels', () => {
  assert.equal(classifyPickDivergence(race()), 'same_pick'); // same runner id
  assert.equal(classifyPickDivergence(shipbourneVsAsmenWarrior()), 'different_pick');
  assert.equal(
    classifyPickDivergence(
      race({ locked: lockedDecision({ decision_status: 'locked_no_bet', pick_runner_id: null }) }),
    ),
    'official_no_bet_diagnostic_pick',
  );
  assert.equal(
    classifyPickDivergence(race({ diagnostic: null, diagnostic_run_exists: true })),
    'official_pick_diagnostic_no_bet',
  );
  assert.equal(
    classifyPickDivergence(
      race({
        locked: lockedDecision({ decision_status: 'locked_no_bet', pick_runner_id: null }),
        diagnostic: null,
        diagnostic_run_exists: true,
      }),
    ),
    'same_no_bet',
  );
  assert.equal(classifyPickDivergence(race({ locked: null })), 'not_comparable');
  assert.equal(
    classifyPickDivergence(
      race({ locked: lockedDecision({ decision_status: 'no_run_available', pick_runner_id: null }) }),
    ),
    'not_comparable',
  );
});

test('Newmarket 2026-07-09 headline case: diagnostic won, official locked pick lost', () => {
  const input = shipbourneVsAsmenWarrior();
  assert.equal(classifyPickDivergence(input), 'different_pick');
  assert.equal(evaluateLockedPick(input), 'lost');
  assert.equal(classifyOutcomeDivergence(input), 'diagnostic_won_official_lost');
});

test('outcome divergence: official won where diagnostic lost; none when pending or same pick', () => {
  const officialWon = race({
    locked_pick_finish: 1,
    diagnostic: { runner_id: 'runner-x', horse_name: 'Other', odds: 3.0, finish_pos: 5 },
  });
  assert.equal(classifyOutcomeDivergence(officialWon), 'official_won_diagnostic_lost');
  // Pending -> no outcome divergence, ever.
  assert.equal(
    classifyOutcomeDivergence(
      race({ settled: false, winner_name: null, locked_pick_finish: null }),
    ),
    null,
  );
  // Same pick -> outcomes cannot diverge.
  assert.equal(classifyOutcomeDivergence(race({ locked_pick_finish: 1, diagnostic: { runner_id: 'runner-ship', horse_name: 'Shipbourne', odds: 5.0, finish_pos: 1 } })), null);
  // Official no-bet while diagnostic won is also the headline divergence.
  assert.equal(
    classifyOutcomeDivergence(
      race({
        locked: lockedDecision({ decision_status: 'locked_no_bet', pick_runner_id: null }),
        diagnostic: { runner_id: 'runner-asmen', horse_name: 'Asmen Warrior', odds: 4.0, finish_pos: 1 },
      }),
    ),
    'diagnostic_won_official_lost',
  );
});

/* -------------------------------- rendering ------------------------------- */

test('render: deterministic; separates buckets; shows the headline divergence', () => {
  const r = reportOf([
    shipbourneVsAsmenWarrior(),
    race({ race_id: 'm1', locked: null, race_name: 'Missing One' }),
  ]);
  const md = renderLockedDayReportMarkdown(r);
  assert.equal(md, renderLockedDayReportMarkdown(r)); // deterministic
  assert.match(md, /OFFICIAL decision = `locked_race_decisions`/);
  assert.match(md, /## Lock coverage/);
  assert.match(md, /Coverage: 50\.0%/);
  assert.match(md, /NEVER backfilled/);
  assert.match(md, /Diagnostic won but official lock lost/);
  assert.match(md, /official Shipbourne LOST vs diagnostic Asmen Warrior WON/);
  assert.match(md, /## Fallback view — lock_missing races .*NOT official figures/);
  // Never leaks secret-looking content.
  assert.equal(/SERVICE_ROLE|SUPABASE_URL|CRON_SECRET|PRIVATE KEY/.test(md), false);
});

test('render: unreadable locked table -> prominent warning, empty official figures', () => {
  const r = buildLockedDayReport({
    date: '2026-07-09',
    course: 'Newmarket',
    minutesBefore: 5,
    generatedAt: '2026-07-09T19:00:00.000Z',
    lockedTableAvailable: false,
    inputs: [race({ locked: null })],
  });
  const md = renderLockedDayReportMarkdown(r);
  assert.match(md, /locked_race_decisions was unreadable/);
  assert.equal(r.official.recommendations_total, 0);
});

test('render: missing values render as em dash, never invented', () => {
  const r = reportOf([
    race({
      settled: false,
      winner_name: null,
      locked_pick_finish: null,
      locked: lockedDecision({ pick_odds: null, pick_stake: null, pick_ev: null, pick_confidence_label: null }),
      diagnostic: null,
      diagnostic_run_exists: false,
    }),
  ]);
  const md = renderLockedDayReportMarkdown(r);
  assert.match(md, /odds — · EV — · stake — · confidence —/);
  assert.match(md, /pending \(not counted\)/);
});

/* --------------------------- safety source scans --------------------------- */

test('locked-report CLI is SELECT-only: no writes, no rpc, no commit flag', () => {
  const cli = readFileSync('scripts/lockedReport.ts', 'utf8');
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(cli), false);
  assert.equal(/--commit/.test(cli), false);
  assert.ok(/\.select\(/.test(cli));
});

test('locked-report CLI never runs the model, fetches odds, or settles results', () => {
  const cli = readFileSync('scripts/lockedReport.ts', 'utf8');
  assert.equal(/runModelForRace|modelDayRun|raceDayPipeline/.test(cli), false);
  assert.equal(/betfair|racingApi|liveSync|\bfetch\s*\(/i.test(cli), false);
  assert.equal(/importResultsCsv|autoResults|todayResultsSettlement|\/api\/settle/i.test(cli), false);
  assert.equal(/placeBet|place_bet|betSlip|wager/i.test(cli), false);
});

test('the pure locked-report module has no DB / fs / env / network access', () => {
  const lib = readFileSync('src/lib/lockedDayReport.ts', 'utf8');
  assert.equal(/supabaseAdmin|node:fs|process\.env|\bfetch\s*\(/.test(lib), false);
  assert.equal(/\.(insert|update|upsert|delete)\s*\(/.test(lib), false);
});
