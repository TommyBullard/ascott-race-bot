/**
 * Unit tests for the read-only locked-decision projection
 * (src/lib/lockedDecisionRead.ts) — Newmarket rebuild Phase 3.
 *
 * No DB, no network: synthetic rows exercise the pure `toLockedDecision`
 * mapper (numeric coercion, null preservation, malformed-row rejection) and
 * the fail-open error classification it relies on. Source scans prove the
 * module is READ-ONLY (select only, no writes), that its fetch never throws
 * (fail-open), and that Phase 3 added no write path to raceData.ts.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { toLockedDecision } from '../src/lib/lockedDecisionRead';
import { classifyTableProbe } from '../src/lib/dbHealthSpec';

/** A complete, well-formed locked_race_decisions row as PostgREST returns it. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision_status: 'locked_pick',
    lock_time: '2026-07-12T14:56:30.000Z',
    minutes_before: 5,
    capture_target_time: '2026-07-12T14:55:00.000Z',
    off_time_at_lock: '2026-07-12T15:00:00.000Z',
    model_run_id: 'run-1',
    no_bet_reason: null,
    pick_runner_id: 'runner-9',
    pick_horse_name: 'Test Horse',
    pick_odds: '4.5', // PostgREST may return numerics as strings
    pick_ev: 0.12,
    pick_model_prob: '0.28',
    pick_market_prob: 0.22,
    pick_stake: '1.00',
    pick_confidence_label: 'Low',
    run_quality: 'OK',
    data_quality_flags: ['ODDS_STALE'],
    data_quality_short_summary: 'Odds 6 min old',
    tipster_short_summary: null,
    tipster_alignment_label: null,
    locked_state_schema_version: 1,
    ...over,
  };
}

/* ------------------------------- mapping ---------------------------------- */

test('toLockedDecision: maps a locked_pick row, coercing string numerics', () => {
  const d = toLockedDecision(row());
  assert.ok(d);
  assert.equal(d.decision_status, 'locked_pick');
  assert.equal(d.lock_time, '2026-07-12T14:56:30.000Z');
  assert.equal(d.minutes_before, 5);
  assert.equal(d.capture_target_time, '2026-07-12T14:55:00.000Z');
  assert.equal(d.off_time_at_lock, '2026-07-12T15:00:00.000Z');
  assert.equal(d.model_run_id, 'run-1');
  assert.equal(d.no_bet_reason, null);
  assert.equal(d.pick_runner_id, 'runner-9');
  assert.equal(d.pick_horse_name, 'Test Horse');
  assert.equal(d.pick_odds, 4.5); // coerced from '4.5'
  assert.equal(d.pick_ev, 0.12);
  assert.equal(d.pick_model_prob, 0.28); // coerced
  assert.equal(d.pick_market_prob, 0.22);
  assert.equal(d.pick_stake, 1.0); // coerced
  assert.equal(d.pick_confidence_label, 'Low');
  assert.equal(d.run_quality, 'OK');
  assert.deepEqual(d.data_quality_flags, ['ODDS_STALE']);
  assert.equal(d.locked_state_schema_version, 1);
  // locked_state itself is NEVER part of the projection.
  assert.equal('locked_state' in d, false);
});

test('toLockedDecision: locked_no_bet carries the reason; pick fields stay null', () => {
  const d = toLockedDecision(
    row({
      decision_status: 'locked_no_bet',
      no_bet_reason: 'captured run produced no rank-1 recommendation',
      pick_runner_id: null,
      pick_horse_name: null,
      pick_odds: null,
      pick_ev: null,
      pick_model_prob: null,
      pick_market_prob: null,
      pick_stake: null,
      pick_confidence_label: null,
    }),
  );
  assert.ok(d);
  assert.equal(d.decision_status, 'locked_no_bet');
  assert.equal(d.no_bet_reason, 'captured run produced no rank-1 recommendation');
  assert.equal(d.pick_runner_id, null);
  assert.equal(d.pick_odds, null); // null preserved — never fabricated
});

test('toLockedDecision: no_run_available -> model_run_id null preserved', () => {
  const d = toLockedDecision(
    row({
      decision_status: 'no_run_available',
      model_run_id: null,
      pick_runner_id: null,
      pick_horse_name: null,
      run_quality: null,
      data_quality_flags: [],
    }),
  );
  assert.ok(d);
  assert.equal(d.decision_status, 'no_run_available');
  assert.equal(d.model_run_id, null);
  assert.equal(d.run_quality, null);
  assert.deepEqual(d.data_quality_flags, []);
});

test('toLockedDecision: malformed input -> null, never a guess', () => {
  assert.equal(toLockedDecision(null), null);
  assert.equal(toLockedDecision(undefined), null);
  assert.equal(toLockedDecision('a string'), null);
  assert.equal(toLockedDecision(row({ decision_status: 'settled' })), null); // unknown status
  assert.equal(toLockedDecision(row({ decision_status: null })), null);
  assert.equal(toLockedDecision(row({ lock_time: null })), null); // schema not-null
  assert.equal(toLockedDecision(row({ off_time_at_lock: null })), null);
  assert.equal(toLockedDecision(row({ minutes_before: 'soon' })), null);
});

test('toLockedDecision: malformed flags -> [], bad numerics -> null (no fabrication)', () => {
  const d = toLockedDecision(
    row({
      data_quality_flags: 'not-an-array',
      pick_odds: 'not-a-number',
      locked_state_schema_version: 2,
    }),
  );
  assert.ok(d);
  assert.deepEqual(d.data_quality_flags, []);
  assert.equal(d.pick_odds, null);
  assert.equal(d.locked_state_schema_version, 2);
  // Mixed-type flag arrays keep only the strings.
  const mixed = toLockedDecision(row({ data_quality_flags: ['A', 7, null, 'B'] }));
  assert.deepEqual(mixed?.data_quality_flags, ['A', 'B']);
});

/* --------------------- fail-open error classification --------------------- */

test('missing-table errors classify as missing (the SILENT fail-open branch)', () => {
  // The fetch stays silent exactly when classifyTableProbe says the table is
  // missing — the known pre-migration state.
  assert.equal(classifyTableProbe({ code: '42P01' }), 'missing');
  assert.equal(classifyTableProbe({ code: 'PGRST205' }), 'missing');
  assert.equal(
    classifyTableProbe({
      message: "Could not find the table 'public.locked_race_decisions' in the schema cache",
    }),
    'missing',
  );
  // Anything else (e.g. an RLS/permission failure) is NOT silent-missing.
  assert.equal(classifyTableProbe({ code: '42501', message: 'permission denied' }), 'indeterminate');
});

/* --------------------------- safety source scans --------------------------- */

test('lockedDecisionRead is read-only and fail-open (never throws to the card)', () => {
  const src = readFileSync('src/lib/lockedDecisionRead.ts', 'utf8');
  assert.equal(/\.insert\s*\(/.test(src), false);
  assert.equal(/\.update\s*\(/.test(src), false);
  assert.equal(/\.upsert\s*\(/.test(src), false);
  assert.equal(/\.delete\s*\(/.test(src), false);
  assert.equal(/\.rpc\s*\(/.test(src), false);
  assert.ok(/\.select\(/.test(src));
  // The fetch is wrapped: every path returns, nothing propagates.
  assert.ok(/try\s*\{/.test(src) && /catch/.test(src));
  assert.equal(/\bthrow\b/.test(src), false);
  // locked_state is excluded from the SELECT (only its version is projected):
  // the column list never names bare "locked_state," — only the version column.
  assert.equal(/locked_state\s*,/.test(src), false);
  assert.ok(src.includes('locked_state_schema_version'));
});

test('Phase 3 added no write path to raceData.ts (locked-decision read only)', () => {
  const src = readFileSync('src/lib/raceData.ts', 'utf8');
  // The card attaches the locked decision via the fail-open helper...
  assert.ok(src.includes('fetchLockedDecisionForRace'));
  // ...and never touches the locked table directly (no query, no write).
  assert.equal(/from\(['"]locked_race_decisions['"]\)/.test(src), false);
});
