/**
 * Unit tests for the pure T-minus lock helpers (src/lib/lockTMinus.ts) and
 * safety source-scans for the lock CLI (scripts/lockTMinus.ts) + the shared
 * read-only data module (scripts/tMinusCaptureData.ts).
 *
 * No DB, no network, no wall clock: synthetic captures + injected `now` values
 * exercise argument parsing, the commit-window boundaries, the decision-status
 * mapping, the no-bet-reason derivation, the insert-row construction (nulls
 * preserved, never fabricated), the summary counting, and the rendering. The
 * source scans prove the CLI inserts ONLY into locked_race_decisions, never
 * updates/upserts/deletes, never runs the model, and never fetches live odds.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  LOCKED_DECISIONS_TABLE,
  LOCKED_STATE_SCHEMA_VERSION,
  OFFICIAL_MINUTES_BEFORE,
  parseLockTMinusArgs,
  classifyLockWindow,
  deriveNoBetReason,
  deriveLockDecision,
  buildLockedDecisionRow,
  summarizeLockOutcomes,
  renderLockOutcomeLine,
  renderLockRunSummary,
  isUniqueViolation,
  type LockRaceOutcome,
} from '../src/lib/lockTMinus';
import type { TMinusRaceCapture } from '../src/lib/tMinusCapture';

const OFF = '2026-07-12T15:00:00.000Z';
const CAPTURE_TARGET = '2026-07-12T14:55:00.000Z'; // OFF - 5 min
const LOCK_NOW = '2026-07-12T14:56:30.000Z'; // inside the window

/** A complete TMinusRaceCapture with sensible defaults for terse tests. */
function capture(over: Partial<TMinusRaceCapture> = {}): TMinusRaceCapture {
  return {
    race_id: 'race-1',
    race_name: 'July Stakes',
    course: 'Newmarket',
    off_time: OFF,
    capture_target_time: CAPTURE_TARGET,
    selected_run_id: 'run-1',
    selected_run_time: '2026-07-12T14:53:00.000Z',
    selected_run_is_current: true,
    later_pre_off_run_exists: false,
    post_off_run_count: 0,
    pick: {
      runner_id: 'runner-9',
      horse_name: 'Test Horse',
      odds: 4.5,
      ev: 0.12,
      model_prob: 0.28,
      market_prob: 0.22,
      stake: 1.0,
      confidence_label: 'Low',
    },
    favourite: { horse_name: 'Fav', odds: 3.5, ev: 0.05, model_prob: 0.3, market_prob: 0.3 },
    alternatives: [],
    run_quality: 'OK',
    data_quality_flags: [],
    data_quality_short_summary: null,
    tipster_short_summary: null,
    tipster_alignment_label: null,
    ...over,
  };
}

/* ----------------------------- argument parsing --------------------------- */

test('parseLockTMinusArgs: dry-run by default; --commit must be explicit', () => {
  const dry = parseLockTMinusArgs(['--date', '2026-07-12', '--course', 'Newmarket']);
  assert.equal(dry.commit, false);
  assert.equal(dry.date, '2026-07-12');
  assert.equal(dry.course, 'Newmarket');
  assert.equal(dry.minutesBefore, OFFICIAL_MINUTES_BEFORE);

  const wet = parseLockTMinusArgs(['--date', '2026-07-12', '--commit']);
  assert.equal(wet.commit, true);
});

test('parseLockTMinusArgs: inherits capture arg rules (bad date/minutes rejected)', () => {
  assert.equal(parseLockTMinusArgs(['--date', '12-07-2026']).date, undefined);
  assert.equal(
    parseLockTMinusArgs(['--date', '2026-07-12', '--minutes-before', '0']).minutesBefore,
    undefined,
  );
  assert.equal(
    parseLockTMinusArgs(['--date', '2026-07-12', '--minutes-before', '10']).minutesBefore,
    10,
  );
});

/* --------------------------- commit-window rule --------------------------- */

const WINDOW = { off_time: OFF, capture_target_time: CAPTURE_TARGET, status: null };

test('classifyLockWindow: exactly AT the capture target is lockable (inclusive open)', () => {
  assert.equal(classifyLockWindow(WINDOW, CAPTURE_TARGET), 'in_window');
});

test('classifyLockWindow: exactly AT the off is lockable (inclusive last safe moment)', () => {
  assert.equal(classifyLockWindow(WINDOW, OFF), 'in_window');
});

test('classifyLockWindow: before the capture target -> too_early', () => {
  assert.equal(classifyLockWindow(WINDOW, '2026-07-12T14:54:59.999Z'), 'too_early');
  assert.equal(classifyLockWindow(WINDOW, '2026-07-12T09:00:00.000Z'), 'too_early');
});

test('classifyLockWindow: after the off -> post_off', () => {
  assert.equal(classifyLockWindow(WINDOW, '2026-07-12T15:00:00.001Z'), 'post_off');
  assert.equal(classifyLockWindow(WINDOW, '2026-07-12T19:00:00.000Z'), 'post_off');
});

test('classifyLockWindow: a resulted race is post_off regardless of the clock', () => {
  assert.equal(
    classifyLockWindow({ ...WINDOW, status: 'result' }, LOCK_NOW),
    'post_off',
  );
});

test('classifyLockWindow: missing/unparseable off or capture target -> no_window (cannot lock)', () => {
  assert.equal(
    classifyLockWindow({ off_time: null, capture_target_time: null, status: null }, LOCK_NOW),
    'no_window',
  );
  assert.equal(
    classifyLockWindow({ off_time: 'nonsense', capture_target_time: CAPTURE_TARGET, status: null }, LOCK_NOW),
    'no_window',
  );
  assert.equal(
    classifyLockWindow({ off_time: OFF, capture_target_time: null, status: null }, LOCK_NOW),
    'no_window',
  );
});

/* ----------------------------- decision mapping --------------------------- */

test('deriveLockDecision: run + pick -> locked_pick, reason null', () => {
  assert.deepEqual(deriveLockDecision(capture()), {
    decision_status: 'locked_pick',
    no_bet_reason: null,
  });
});

test('deriveLockDecision: run without pick -> locked_no_bet with a required reason', () => {
  const d = deriveLockDecision(capture({ pick: null }));
  assert.equal(d.decision_status, 'locked_no_bet');
  assert.ok(d.no_bet_reason && d.no_bet_reason.length > 0);
});

test('deriveLockDecision: no selected run -> no_run_available, reason null', () => {
  const d = deriveLockDecision(
    capture({ selected_run_id: null, selected_run_time: null, pick: null }),
  );
  assert.deepEqual(d, { decision_status: 'no_run_available', no_bet_reason: null });
});

test('deriveNoBetReason: deterministic, stored facts only', () => {
  const bare = capture({ pick: null, run_quality: 'OK', data_quality_short_summary: null });
  assert.equal(deriveNoBetReason(bare), 'captured run produced no rank-1 recommendation');
  assert.equal(deriveNoBetReason(bare), deriveNoBetReason(bare)); // deterministic

  const degraded = capture({
    pick: null,
    run_quality: 'DEGRADED',
    data_quality_short_summary: 'Odds snapshot 12 min old',
  });
  assert.equal(
    deriveNoBetReason(degraded),
    'captured run produced no rank-1 recommendation; run quality: DEGRADED; data quality: Odds snapshot 12 min old',
  );
  // A null quality/summary is omitted, never invented.
  assert.equal(
    deriveNoBetReason(capture({ pick: null, run_quality: null })),
    'captured run produced no rank-1 recommendation',
  );
});

/* --------------------------- insert-row construction ---------------------- */

test('buildLockedDecisionRow: locked_pick populates the promoted pick columns + one lock_time', () => {
  const row = buildLockedDecisionRow(capture(), 5, LOCK_NOW);
  assert.ok(row);
  assert.equal(row.race_id, 'race-1');
  assert.equal(row.model_run_id, 'run-1');
  assert.equal(row.lock_time, LOCK_NOW); // the injected scriptNow, not a DB default
  assert.equal(row.minutes_before, 5);
  assert.equal(row.off_time_at_lock, OFF);
  assert.equal(row.capture_target_time, CAPTURE_TARGET);
  assert.equal(row.decision_status, 'locked_pick');
  assert.equal(row.no_bet_reason, null);
  assert.equal(row.pick_runner_id, 'runner-9');
  assert.equal(row.pick_horse_name, 'Test Horse');
  assert.equal(row.pick_odds, 4.5);
  assert.equal(row.pick_ev, 0.12);
  assert.equal(row.pick_model_prob, 0.28);
  assert.equal(row.pick_market_prob, 0.22);
  assert.equal(row.pick_stake, 1.0);
  assert.equal(row.pick_confidence_label, 'Low');
  assert.equal(row.locked_state_schema_version, LOCKED_STATE_SCHEMA_VERSION);
});

test('buildLockedDecisionRow: locked_no_bet -> pick columns all null, reason set', () => {
  const row = buildLockedDecisionRow(capture({ pick: null }), 5, LOCK_NOW);
  assert.ok(row);
  assert.equal(row.decision_status, 'locked_no_bet');
  assert.equal(row.model_run_id, 'run-1');
  assert.ok(row.no_bet_reason);
  for (const v of [
    row.pick_runner_id, row.pick_horse_name, row.pick_odds, row.pick_ev,
    row.pick_model_prob, row.pick_market_prob, row.pick_stake, row.pick_confidence_label,
  ]) {
    assert.equal(v, null);
  }
});

test('buildLockedDecisionRow: no_run_available -> model_run_id null, pick null, reason null', () => {
  const row = buildLockedDecisionRow(
    capture({ selected_run_id: null, selected_run_time: null, pick: null }),
    5,
    LOCK_NOW,
  );
  assert.ok(row);
  assert.equal(row.decision_status, 'no_run_available');
  assert.equal(row.model_run_id, null);
  assert.equal(row.pick_runner_id, null);
  assert.equal(row.no_bet_reason, null);
});

test('buildLockedDecisionRow: locked_state preserves the full capture with nulls intact + schema_version', () => {
  const c = capture({
    pick: {
      runner_id: 'runner-9',
      horse_name: 'Test Horse',
      odds: null, // missing odds stay null — never fabricated
      ev: null,
      model_prob: null,
      market_prob: null,
      stake: null,
      confidence_label: null,
    },
    tipster_short_summary: null,
  });
  const row = buildLockedDecisionRow(c, 5, LOCK_NOW);
  assert.ok(row);
  assert.equal(row.pick_odds, null);
  const state = row.locked_state as unknown as TMinusRaceCapture & {
    schema_version: number;
    warnings: Record<string, boolean>;
  };
  assert.equal(state.schema_version, LOCKED_STATE_SCHEMA_VERSION);
  assert.equal(state.race_id, 'race-1');
  assert.equal(state.pick?.odds, null);
  assert.equal(state.tipster_short_summary, null);
  assert.equal(typeof state.warnings.noCaptureRun, 'boolean');
  // Serialisable + deterministic.
  assert.equal(
    JSON.stringify(buildLockedDecisionRow(c, 5, LOCK_NOW)),
    JSON.stringify(buildLockedDecisionRow(c, 5, LOCK_NOW)),
  );
});

test('buildLockedDecisionRow: missing off/capture target -> null (never guessed)', () => {
  assert.equal(buildLockedDecisionRow(capture({ off_time: null }), 5, LOCK_NOW), null);
  assert.equal(buildLockedDecisionRow(capture({ capture_target_time: null }), 5, LOCK_NOW), null);
});

/* ----------------------------- summary counting --------------------------- */

function outcome(kind: LockRaceOutcome['kind']): LockRaceOutcome {
  return { race_id: 'r', race_name: null, off_time: null, kind, detail: null };
}

test('summarizeLockOutcomes: every kind counted; races_considered is the total', () => {
  const s = summarizeLockOutcomes([
    outcome('locked_pick'), outcome('locked_pick'),
    outcome('locked_no_bet'),
    outcome('no_run_available'),
    outcome('too_early_not_locked'), outcome('too_early_not_locked'), outcome('too_early_not_locked'),
    outcome('skipped_post_off'),
    outcome('already_locked'),
    outcome('error'),
  ]);
  assert.deepEqual(s, {
    races_considered: 10,
    locked_pick: 2,
    locked_no_bet: 1,
    no_run_available: 1,
    too_early_not_locked: 3,
    skipped_post_off: 1,
    already_locked: 1,
    errors: 1,
  });
});

test('renderLockRunSummary: DRY RUN banner present by default, absent on commit; deterministic', () => {
  const s = summarizeLockOutcomes([outcome('locked_pick')]);
  const opts = {
    date: '2026-07-12',
    course: 'Newmarket',
    minutesBefore: 5,
    commit: false,
    lockTimeIso: LOCK_NOW,
  };
  const dry = renderLockRunSummary(s, opts).join('\n');
  assert.match(dry, /DRY RUN — nothing was persisted/);
  assert.match(dry, /--commit/);
  assert.equal(dry.includes('were persisted'), false);

  const wet = renderLockRunSummary(s, { ...opts, commit: true }).join('\n');
  assert.match(wet, /COMMIT/);
  assert.equal(wet.includes('DRY RUN'), false);

  assert.equal(dry, renderLockRunSummary(s, opts).join('\n')); // deterministic
  // All eight counters appear.
  for (const label of [
    'Races considered', 'locked_pick', 'locked_no_bet', 'no_run_available',
    'too_early_not_locked', 'skipped_post_off', 'already_locked', 'errors',
  ]) {
    assert.ok(dry.includes(label), `summary missing counter: ${label}`);
  }
});

test('renderLockOutcomeLine: off time + name + kind + detail; em dash when unknown', () => {
  const line = renderLockOutcomeLine({
    race_id: 'r1',
    race_name: 'July Stakes',
    off_time: OFF,
    kind: 'locked_pick',
    detail: 'pick: Test Horse',
  });
  assert.equal(line, '  15:00 July Stakes: locked_pick — pick: Test Horse');
  // Unknown off time renders as an em dash; unknown race name is labelled.
  assert.equal(renderLockOutcomeLine(outcome('error')), '  — (unknown race): error');
});

/* ------------------------- already_locked classification ------------------ */

test('isUniqueViolation: 23505 / duplicate-key / constraint name -> already_locked path', () => {
  assert.equal(isUniqueViolation({ code: '23505' }), true);
  assert.equal(
    isUniqueViolation({
      message: 'duplicate key value violates unique constraint "locked_race_decisions_one_per_horizon"',
    }),
    true,
  );
  assert.equal(isUniqueViolation({ message: 'locked_race_decisions_one_per_horizon' }), true);
  assert.equal(isUniqueViolation({ code: '42501', message: 'permission denied' }), false);
  assert.equal(isUniqueViolation(null), false);
});

/* ----------------------- safety source scans (CLI) ------------------------ */

test('lock CLI: insert-only — no update/upsert/delete/rpc, single insert into locked_race_decisions', () => {
  const src = readFileSync('scripts/lockTMinus.ts', 'utf8');
  assert.equal(/\.update\s*\(/.test(src), false);
  assert.equal(/\.upsert\s*\(/.test(src), false);
  assert.equal(/\.delete\s*\(/.test(src), false);
  assert.equal(/\.rpc\s*\(/.test(src), false);
  // Exactly ONE insert call, and its target is the locked-decisions table.
  const inserts = src.match(/\.insert\s*\(/g) ?? [];
  assert.equal(inserts.length, 1);
  assert.match(src, /\.from\(LOCKED_DECISIONS_TABLE\)[\s\S]{0,40}\.insert\(/);
  // Commit gating exists: the insert path is behind args.commit.
  assert.match(src, /if\s*\(!args\.commit\)/);
});

test('lock CLI: never runs the model, fetches live odds, settles results, or places bets', () => {
  const src = readFileSync('scripts/lockTMinus.ts', 'utf8');
  assert.equal(/runModelForRace|modelDayRun|raceDayPipeline/.test(src), false);
  assert.equal(/betfair|racingApi|liveSync|\bfetch\s*\(/i.test(src), false);
  assert.equal(/importResultsCsv|autoResults|todayResultsSettlement|\/api\/settle/i.test(src), false);
  assert.equal(/placeBet|place_bet|betSlip|wager/i.test(src), false);
});

test('shared T-minus data module is read-only (selects only) with no top-level side effects', () => {
  const src = readFileSync('scripts/tMinusCaptureData.ts', 'utf8');
  assert.equal(/\.insert\s*\(/.test(src), false);
  assert.equal(/\.update\s*\(/.test(src), false);
  assert.equal(/\.upsert\s*\(/.test(src), false);
  assert.equal(/\.delete\s*\(/.test(src), false);
  assert.equal(/\.rpc\s*\(/.test(src), false);
  assert.ok(/\.select\(/.test(src));
  // No top-level main() invocation — safe for both CLIs to import.
  assert.equal(/^main\(\)/m.test(src), false);
});

test('the pure lock module has no DB / fs / env / network access', () => {
  const src = readFileSync('src/lib/lockTMinus.ts', 'utf8');
  assert.equal(/supabaseAdmin|node:fs|process\.env|\bfetch\s*\(/.test(src), false);
  assert.equal(/\.(insert|update|upsert|delete)\s*\(/.test(src), false);
});
