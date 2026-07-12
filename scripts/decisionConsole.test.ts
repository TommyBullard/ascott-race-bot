/**
 * Tests for the Race-Day Decision Console classifier
 * (src/lib/decisionConsole.ts) and its read-only wiring.
 *
 * Proves every priority class and its precedence (WARNING beats NEXT ACTION
 * beats MONITOR beats GOOD for a single race), the next-action countdown
 * wording, lock-missing / no-run / stale-data / pending-long escalations, the
 * settled classification, the requested sort order (NEXT ACTION → WARNING →
 * MONITOR → GOOD, urgent first within each class), the summary counts, and —
 * by source scan — that the lib is pure and the panel presentational-only
 * with the top-3 / collapsible layout. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildDecisionConsole,
  NEXT_ACTION_WINDOW_MS,
  MONITOR_WINDOW_MS,
  CONSOLE_PRIORITY_ORDER,
} from '../src/lib/decisionConsole';
import { RESULT_PENDING_SLOW_MS } from '../src/lib/commandCentre';
import type { TimelineInput } from '../src/lib/raceDayTimeline';

const NOW = Date.parse('2026-07-11T14:00:00.000Z');
const FRESH = '2026-07-11T13:58:00.000Z';

/** ISO string `minutes` after NOW. */
function inMinutes(minutes: number): string {
  return new Date(NOW + minutes * 60_000).toISOString();
}

/** A race with healthy data, parameterised by off time / lock / status. */
function race(over: Partial<TimelineInput> & { race_id: string }): TimelineInput {
  return {
    off_time: inMinutes(120),
    race_name: over.race_id,
    oddsUpdatedAt: FRESH,
    modelUpdatedAt: FRESH,
    hasModelRun: true,
    status: null,
    resultTime: null,
    runQuality: 'OK',
    lockedDecisionStatus: null,
    ...over,
  };
}

function only(input: TimelineInput) {
  const view = buildDecisionConsole([input], NOW);
  assert.equal(view.items.length, 1);
  return view.items[0];
}

/* ------------------------------ NEXT ACTION -------------------------------- */

test('NEXT ACTION: lock due within 15 minutes, with countdown', () => {
  // Off in 12m -> T-minus-5 target in 7m.
  const item = only(race({ race_id: 'soon', off_time: inMinutes(12) }));
  assert.equal(item.priority, 'next_action');
  assert.equal(item.reason, 'lock due in 7m');
  assert.equal(item.countdown, 'lock due in 7m');
});

test('NEXT ACTION: lock due NOW once the capture target has passed (window still open)', () => {
  // Off in 3m -> target 2m ago; still not_locked_yet.
  const item = only(race({ race_id: 'due-now', off_time: inMinutes(3) }));
  assert.equal(item.priority, 'next_action');
  assert.equal(item.reason, 'lock due now');
});

test('NEXT ACTION: already-locked race off within 15 minutes ("off in Xm")', () => {
  const item = only(
    race({ race_id: 'locked-soon', off_time: inMinutes(12), lockedDecisionStatus: 'locked_pick' }),
  );
  assert.equal(item.priority, 'next_action');
  assert.equal(item.reason, 'off in 12m');
});

test('NEXT ACTION: result expected soon (just off / pending inside the normal window)', () => {
  const justOff = only(
    race({ race_id: 'just-off', off_time: inMinutes(-2), lockedDecisionStatus: 'locked_pick' }),
  );
  assert.equal(justOff.priority, 'next_action');
  assert.equal(justOff.reason, 'result expected soon');

  const pending = only(
    race({ race_id: 'pending-ok', off_time: inMinutes(-10), lockedDecisionStatus: 'locked_no_bet' }),
  );
  assert.equal(pending.priority, 'next_action');
  assert.equal(pending.reason, 'result expected soon');
});

/* -------------------------------- WARNING ---------------------------------- */

test('WARNING: lock missing after the window (post-off, no official row)', () => {
  const item = only(race({ race_id: 'gone', off_time: inMinutes(-30) }));
  assert.equal(item.priority, 'warning');
  assert.match(item.reason, /lock missing/);
});

test('WARNING: no_run_available', () => {
  const item = only(
    race({ race_id: 'no-run', off_time: inMinutes(30), lockedDecisionStatus: 'no_run_available' }),
  );
  assert.equal(item.priority, 'warning');
  assert.match(item.reason, /no model run available at lock/);
});

test('WARNING: stale odds / stale model before the off', () => {
  const staleOdds = only(
    race({ race_id: 'stale-odds', off_time: inMinutes(30), oddsUpdatedAt: inMinutes(-60) }),
  );
  assert.equal(staleOdds.priority, 'warning');
  assert.equal(staleOdds.reason, 'stale odds before the off');

  const staleModel = only(
    race({ race_id: 'stale-model', off_time: inMinutes(30), runQuality: 'STALE' }),
  );
  assert.equal(staleModel.priority, 'warning');
  assert.equal(staleModel.reason, 'stale model before the off');
});

test('WARNING: result pending unusually long after the off', () => {
  const minutes = Math.floor((RESULT_PENDING_SLOW_MS + 5 * 60_000) / 60_000);
  const item = only(
    race({ race_id: 'slow', off_time: inMinutes(-minutes), lockedDecisionStatus: 'locked_pick' }),
  );
  assert.equal(item.priority, 'warning');
  assert.match(item.reason, /result still pending \d+m after the off/);
});

test('escalation precedence: a problem beats a deadline (stale odds + lock due soon -> WARNING)', () => {
  const item = only(
    race({ race_id: 'both', off_time: inMinutes(10), oddsUpdatedAt: inMinutes(-60) }),
  );
  assert.equal(item.priority, 'warning');
  assert.equal(item.reason, 'stale odds before the off');
  // The countdown context is still shown alongside the problem.
  assert.match(item.countdown ?? '', /off in/);
});

test('escalation over time: not-yet-due -> next action -> lock missing as the clock moves', () => {
  // Odds are refreshed at each step (as the live pipeline does) so only the
  // CLOCK drives the escalation, not data staleness.
  const at = (nowMs: number, oddsIso: string) =>
    buildDecisionConsole(
      [race({ race_id: 'lifecycle', off_time: inMinutes(120), oddsUpdatedAt: oddsIso })],
      nowMs,
    ).items[0];

  assert.equal(at(NOW, FRESH).priority, 'monitor'); // lock due later
  const nearLock = NOW + 110 * 60_000; // 10m before the off -> target within 15m
  assert.equal(at(nearLock, new Date(nearLock - 60_000).toISOString()).priority, 'next_action');
  const postOff = NOW + 200 * 60_000; // long past the off, never locked, no result
  const late = at(postOff, new Date(postOff - 60_000).toISOString());
  assert.equal(late.priority, 'warning');
  assert.match(late.reason, /lock missing/);
});

/* -------------------------------- MONITOR ---------------------------------- */

test('MONITOR: race within 60 minutes shows the lock countdown when unlocked', () => {
  const item = only(race({ race_id: 'hour', off_time: inMinutes(45) }));
  assert.equal(item.priority, 'monitor');
  assert.equal(item.reason, 'lock due in 40m');
});

test('MONITOR: lock due later (far-out race, fresh data)', () => {
  const item = only(race({ race_id: 'later', off_time: inMinutes(4 * 60) }));
  assert.equal(item.priority, 'monitor');
  assert.equal(item.reason, 'lock due in 3h 55m');
});

/* --------------------------------- GOOD ------------------------------------ */

test('GOOD: settled race; GOOD: locked race with no other concern', () => {
  const settled = only(
    race({
      race_id: 'settled',
      off_time: inMinutes(-120),
      status: 'result',
      resultTime: inMinutes(-110),
      lockedDecisionStatus: 'locked_pick',
    }),
  );
  assert.equal(settled.priority, 'good');
  assert.equal(settled.reason, 'settled');

  const lockedFarOut = only(
    race({ race_id: 'locked-early', off_time: inMinutes(90), lockedDecisionStatus: 'locked_no_bet' }),
  );
  assert.equal(lockedFarOut.priority, 'good');
  assert.equal(lockedFarOut.reason, 'locked — official no-bet');
});

/* ---------------------------- sorting + counts ----------------------------- */

test('sort: NEXT ACTION -> WARNING -> MONITOR -> GOOD; soonest first within class', () => {
  const view = buildDecisionConsole(
    [
      race({
        race_id: 'good',
        off_time: inMinutes(-180),
        status: 'result',
        resultTime: inMinutes(-170),
        lockedDecisionStatus: 'locked_pick',
      }),
      race({ race_id: 'monitor-late', off_time: inMinutes(55) }),
      race({ race_id: 'warning', off_time: inMinutes(-60) }), // lock missing
      race({ race_id: 'next-b', off_time: inMinutes(14) }),
      race({ race_id: 'next-a', off_time: inMinutes(8) }),
      race({ race_id: 'monitor-early', off_time: inMinutes(30) }),
    ],
    NOW,
  );
  assert.deepEqual(
    view.items.map((i) => i.race_id),
    ['next-a', 'next-b', 'warning', 'monitor-early', 'monitor-late', 'good'],
  );
  assert.deepEqual(view.counts, { next_action: 2, warning: 1, monitor: 2, good: 1 });
  assert.deepEqual(CONSOLE_PRIORITY_ORDER, ['next_action', 'warning', 'monitor', 'good']);
});

test('window constants match the display rules (15m / 60m)', () => {
  assert.equal(NEXT_ACTION_WINDOW_MS, 15 * 60_000);
  assert.equal(MONITOR_WINDOW_MS, 60 * 60_000);
});

/* --------------------------- safety source scans --------------------------- */

test('decision-console lib is pure: no DB / fs / env / network, no writes', () => {
  const src = readFileSync('src/lib/decisionConsole.ts', 'utf8');
  assert.equal(/supabaseAdmin|node:fs|process\.env|\bfetch\s*\(/.test(src), false);
  assert.equal(/\.(insert|update|upsert|delete)\s*\(/.test(src), false);
});

test('panel is presentational only, top-3 visible + collapsible remainder', () => {
  const src = readFileSync('src/components/DecisionConsolePanel.tsx', 'utf8');
  assert.equal(/fetch\(|supabaseAdmin|\/api\//.test(src), false);
  assert.equal(/<form|<button|onClick|onSubmit|--commit/.test(src), false);
  assert.match(src, /CONSOLE_VISIBLE_ROWS = 3/);
  assert.match(src, /<details>/); // remaining rows collapse natively
});

test('homepage renders the console below the Command Centre', () => {
  const src = readFileSync('src/app/page.tsx', 'utf8');
  const centre = src.indexOf('<CommandCentrePanel view={commandCentre} />');
  const console_ = src.indexOf('<DecisionConsolePanel view={decisionConsole} />');
  assert.ok(centre >= 0 && console_ > centre, 'console rendered below the Command Centre');
});
