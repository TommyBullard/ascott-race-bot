/**
 * Unit tests for the pure locked-first performance evaluator
 * (src/lib/lockedEvaluation.ts) — Newmarket rebuild Phase 5B — plus source
 * scans proving the locked-first accuracy path added no write path.
 *
 * No DB, no network: synthetic locked decisions + winners exercise the
 * official outcome building (stored locked odds/stake only), the bucket rules
 * (locked_no_bet / no_run_available / lock_missing are NEVER losses; pending
 * is NEVER a loss), the coverage maths, and the mode resolution. The main
 * regression fixture is Newmarket 2026-07-09: coverage 5/7, locked picks 0/3
 * winners, 2 official no-bets, 2 lock-missing — where the old pre-off headline
 * looked better than the official record. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildLockedOutcomes,
  resolveOfficialMode,
  type LockedEvaluationRace,
} from '../src/lib/lockedEvaluation';
import { summarizeModelPerformance } from '../src/lib/modelPerformance';
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
    pick_runner_id: 'runner-pick',
    pick_horse_name: 'Some Pick',
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

function race(over: Partial<LockedEvaluationRace> & { race_id: string }): LockedEvaluationRace {
  return { winner_runner_id: null, locked: lockedDecision(), ...over };
}

/* ----------------------------- outcome building --------------------------- */

test('locked_pick: won/lost from stored winner; stored locked odds/stake/ev only', () => {
  const r = buildLockedOutcomes([
    race({ race_id: 'a', winner_runner_id: 'runner-pick' }), // official winner
    race({ race_id: 'b', winner_runner_id: 'runner-other' }), // official loser
  ]);
  assert.equal(r.outcomes.length, 2);
  assert.deepEqual(r.outcomes[0], {
    settled: true,
    won: true,
    odds: 5.0,
    stake: 1.0,
    ev: 0.1,
  });
  assert.equal(r.outcomes[1].won, false);
  assert.equal(r.outcomes[1].settled, true);
});

test('locked_pick pending: no winner yet -> settled false, NEVER a loss', () => {
  const r = buildLockedOutcomes([race({ race_id: 'a', winner_runner_id: null })]);
  assert.equal(r.outcomes[0].settled, false);
  const perf = summarizeModelPerformance(r.outcomes, r.lockedNoBet);
  assert.equal(perf.pending_count, 1);
  assert.equal(perf.losers, 0);
});

test('stored nulls pass through (a winning pick with no odds pays 0, never invented)', () => {
  const r = buildLockedOutcomes([
    race({
      race_id: 'a',
      winner_runner_id: 'runner-pick',
      locked: lockedDecision({ pick_odds: null, pick_stake: null, pick_ev: null }),
    }),
  ]);
  assert.deepEqual(r.outcomes[0], {
    settled: true,
    won: true,
    odds: null,
    stake: null,
    ev: null,
  });
  const perf = summarizeModelPerformance(r.outcomes, 0);
  assert.equal(perf.winners, 1);
  assert.equal(perf.profit_loss, 0);
});

/* ------------------------------- bucket rules ------------------------------ */

test('locked_no_bet: a valid official decision — counted, never a loss', () => {
  const r = buildLockedOutcomes([
    race({
      race_id: 'a',
      winner_runner_id: 'runner-x',
      locked: lockedDecision({
        decision_status: 'locked_no_bet',
        no_bet_reason: 'captured run produced no rank-1 recommendation',
        pick_runner_id: null,
      }),
    }),
  ]);
  assert.equal(r.lockedNoBet, 1);
  assert.equal(r.outcomes.length, 0);
  const perf = summarizeModelPerformance(r.outcomes, r.lockedNoBet);
  assert.equal(perf.no_bet_races, 1);
  assert.equal(perf.losers, 0);
});

test('no_run_available: separate counter — never a loss, never a no-bet', () => {
  const r = buildLockedOutcomes([
    race({
      race_id: 'a',
      winner_runner_id: 'runner-x',
      locked: lockedDecision({
        decision_status: 'no_run_available',
        model_run_id: null,
        pick_runner_id: null,
      }),
    }),
  ]);
  assert.equal(r.noRunAvailable, 1);
  assert.equal(r.lockedNoBet, 0);
  assert.equal(r.outcomes.length, 0);
});

test('lock_missing: listed for fallback, contributes NOTHING official — never a loss/no-bet', () => {
  const r = buildLockedOutcomes([
    race({ race_id: 'gone', winner_runner_id: 'runner-x', locked: null }),
  ]);
  assert.deepEqual(r.lockMissingRaceIds, ['gone']);
  assert.equal(r.outcomes.length, 0);
  assert.equal(r.lockedNoBet, 0);
  assert.equal(r.noRunAvailable, 0);
  assert.equal(r.coverage.lock_missing, 1);
});

test('unevaluable locked_pick (null pick_runner_id) excluded from winners AND losers', () => {
  const r = buildLockedOutcomes([
    race({
      race_id: 'a',
      winner_runner_id: 'runner-x',
      locked: lockedDecision({ pick_runner_id: null }),
    }),
  ]);
  assert.equal(r.unevaluable, 1);
  assert.equal(r.outcomes.length, 0);
});

/* --------------------------- coverage + mode ------------------------------- */

test('resolveOfficialMode: all locked / some missing / none', () => {
  const all = buildLockedOutcomes([race({ race_id: 'a' }), race({ race_id: 'b' })]);
  assert.equal(resolveOfficialMode(all.coverage), 'official_locked');

  const some = buildLockedOutcomes([race({ race_id: 'a' }), race({ race_id: 'b', locked: null })]);
  assert.equal(resolveOfficialMode(some.coverage), 'mixed');

  const none = buildLockedOutcomes([race({ race_id: 'a', locked: null })]);
  assert.equal(resolveOfficialMode(none.coverage), 'fallback_pre_off');
  // Empty scope is also fallback (no locks) — and never divides by zero.
  assert.equal(resolveOfficialMode(buildLockedOutcomes([]).coverage), 'fallback_pre_off');
});

/* ------------------- Newmarket 2026-07-09 regression fixture --------------- */

test('Newmarket 2026-07-09: official record 0/3, 2 no-bet, 5/7 coverage, 2 missing', () => {
  // Three locked picks that all LOST (incl. the final race: official Shipbourne
  // lost while the diagnostic pick Asmen Warrior won — the diagnostic result
  // must NOT appear in these official figures).
  const inputs: LockedEvaluationRace[] = [
    race({
      race_id: 'r1',
      winner_runner_id: 'runner-jazl',
      locked: lockedDecision({ pick_runner_id: 'runner-other1', pick_odds: 6.0, pick_stake: 1 }),
    }),
    race({
      race_id: 'r2',
      winner_runner_id: 'runner-w2',
      locked: lockedDecision({ pick_runner_id: 'runner-other2', pick_odds: 4.0, pick_stake: 1 }),
    }),
    race({
      race_id: 'r-final',
      winner_runner_id: 'runner-asmen', // Asmen Warrior won...
      locked: lockedDecision({
        pick_runner_id: 'runner-ship', // ...but the OFFICIAL lock was Shipbourne
        pick_horse_name: 'Shipbourne',
        pick_odds: 5.0,
        pick_stake: 1,
      }),
    }),
    race({
      race_id: 'r4',
      winner_runner_id: 'runner-w4',
      locked: lockedDecision({
        decision_status: 'locked_no_bet',
        no_bet_reason: 'captured run produced no rank-1 recommendation',
        pick_runner_id: null,
      }),
    }),
    race({
      race_id: 'r5',
      winner_runner_id: 'runner-w5',
      locked: lockedDecision({
        decision_status: 'locked_no_bet',
        no_bet_reason: 'captured run produced no rank-1 recommendation',
        pick_runner_id: null,
      }),
    }),
    race({ race_id: 'r6-missing', winner_runner_id: 'runner-w6', locked: null }),
    race({ race_id: 'r7-missing', winner_runner_id: 'runner-w7', locked: null }),
  ];
  const r = buildLockedOutcomes(inputs);

  assert.equal(r.coverage.races, 7);
  assert.equal(r.coverage.locked, 5);
  assert.equal(r.coverage.coverage_pct, 71.4);
  assert.equal(r.coverage.locked_pick, 3);
  assert.equal(r.coverage.locked_no_bet, 2);
  assert.equal(r.coverage.lock_missing, 2);
  assert.equal(resolveOfficialMode(r.coverage), 'mixed');
  assert.deepEqual(r.lockMissingRaceIds, ['r6-missing', 'r7-missing']);

  const official = summarizeModelPerformance(r.outcomes, r.lockedNoBet);
  assert.equal(official.recommendations_total, 3);
  assert.equal(official.winners, 0); // Shipbourne lost — no diagnostic leakage
  assert.equal(official.losers, 3);
  assert.equal(official.strike_rate, 0);
  assert.equal(official.profit_loss, -3);
  assert.equal(official.no_bet_races, 2);
  assert.equal(official.pending_count, 0);
});

/* --------------------------- safety source scans --------------------------- */

test('the pure locked evaluator has no DB / fs / env / network access', () => {
  const src = readFileSync('src/lib/lockedEvaluation.ts', 'utf8');
  assert.equal(/supabaseAdmin|node:fs|process\.env|\bfetch\s*\(/.test(src), false);
  assert.equal(/\.(insert|update|upsert|delete)\s*\(/.test(src), false);
});

test('locked-first accuracy added no write path to raceData.ts', () => {
  const src = readFileSync('src/lib/raceData.ts', 'utf8');
  // The locked read goes through the shared table constant, select-only.
  assert.ok(src.includes('readLockedDecisionsForPerformance'));
  assert.equal(/from\(LOCKED_DECISIONS_TABLE\)[\s\S]{0,80}\.(insert|update|upsert|delete)\(/.test(src), false);
});
