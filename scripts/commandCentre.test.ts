/**
 * Tests for the Race-Day Command Centre view-model (src/lib/commandCentre.ts)
 * and its read-only wiring.
 *
 * Proves the GREEN/AMBER/RED badge rules (lock missing / no-run / feed failure
 * / empty capture -> RED; upcoming staleness / slow results / status-poll
 * error -> AMBER; not-yet-due races alone never change the badge), the lock and
 * results counts, the "next lock due" derivation from the T-minus-5 capture
 * targets, and — by source scan — that the lib is pure and the panel component
 * has no fetch/write/controls. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildCommandCentre,
  RESULT_PENDING_SLOW_MS,
  type CommandCentreInput,
} from '../src/lib/commandCentre';
import type { TimelineInput } from '../src/lib/raceDayTimeline';

const NOW = Date.parse('2026-07-11T14:00:00.000Z');
const FRESH = '2026-07-11T13:58:00.000Z'; // 2m ago — fresh

/** A settled, locked, cleanly-captured race (everything healthy). */
function settledRace(over: Partial<TimelineInput> = {}): TimelineInput {
  return {
    race_id: over.race_id ?? 'r-settled',
    off_time: '2026-07-11T13:00:00.000Z',
    oddsUpdatedAt: '2026-07-11T12:58:00.000Z', // fresh AS-OF the off
    modelUpdatedAt: '2026-07-11T12:57:00.000Z',
    hasModelRun: true,
    status: 'result',
    resultTime: '2026-07-11T13:10:00.000Z',
    runQuality: 'OK',
    lockedDecisionStatus: 'locked_pick',
    ...over,
  };
}

/** An upcoming race, fresh data, not yet due to lock (off 14:30, now 14:00). */
function upcomingRace(over: Partial<TimelineInput> = {}): TimelineInput {
  return {
    race_id: over.race_id ?? 'r-upcoming',
    off_time: '2026-07-11T14:30:00.000Z',
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

function build(races: TimelineInput[], over: Partial<CommandCentreInput> = {}) {
  return buildCommandCentre({
    now: NOW,
    feedState: 'ready',
    statusPollError: false,
    scoped: true,
    races,
    ...over,
  });
}

/* -------------------------------- badge ----------------------------------- */

test('GREEN: all locked/settled/fresh — no reasons shown', () => {
  const view = build([settledRace(), upcomingRace()]);
  assert.equal(view.badge, 'green');
  assert.deepEqual(view.badgeReasons, []);
});

test('not-yet-due races ALONE never change the badge (expected, not a gap)', () => {
  const view = build([upcomingRace({ race_id: 'a' }), upcomingRace({ race_id: 'b', off_time: '2026-07-11T15:05:00.000Z' })]);
  assert.equal(view.badge, 'green');
  assert.equal(view.locks.notYetDue, 2);
});

test('RED: lock missing (post-off, no official row)', () => {
  const view = build([
    settledRace({ race_id: 'gone', lockedDecisionStatus: null }), // off passed, no lock
  ]);
  assert.equal(view.badge, 'red');
  assert.equal(view.locks.lockMissing, 1);
  assert.match(view.badgeReasons.join(' '), /LOCK MISSING/);
});

test('RED: no run available at lock', () => {
  const view = build([settledRace({ lockedDecisionStatus: 'no_run_available' })]);
  assert.equal(view.badge, 'red');
  assert.equal(view.locks.noRunAvailable, 1);
  assert.match(view.badgeReasons.join(' '), /no model run available at lock/);
});

test('RED: data feed failed; RED: scoped day with zero racecards', () => {
  const failed = build([settledRace()], { feedState: 'error' });
  assert.equal(failed.badge, 'red');
  assert.equal(failed.health.platformFeed, 'failed');

  const empty = build([], { scoped: true });
  assert.equal(empty.badge, 'red');
  assert.match(empty.badgeReasons.join(' '), /no racecards loaded/);

  // Unscoped homepage with zero races is NOT accused (nothing selected yet).
  const unscoped = build([], { scoped: false });
  assert.equal(unscoped.badge, 'green');
});

test('AMBER: stale odds on an UPCOMING race only — a finished day is never stale', () => {
  const staleUpcoming = build([
    upcomingRace({ oddsUpdatedAt: '2026-07-11T13:00:00.000Z' }), // 60m old now
  ]);
  assert.equal(staleUpcoming.badge, 'amber');
  assert.equal(staleUpcoming.health.oddsStale, true);
  assert.match(staleUpcoming.badgeReasons.join(' '), /stale odds on 1 upcoming/);

  // The same odds age on a SETTLED race (fresh as-of its off) stays green.
  const finishedDay = build([settledRace()]);
  assert.equal(finishedDay.health.oddsStale, false);
  assert.equal(finishedDay.badge, 'green');
});

test('AMBER: stale odds still counts inside the t-minus window (minutes from the off)', () => {
  // Off in 8 minutes -> raceState 't-minus-10', NOT 'upcoming'; staleness must
  // still matter (it matters MORE this close to the off).
  const view = build([
    upcomingRace({
      off_time: new Date(NOW + 8 * 60_000).toISOString(),
      oddsUpdatedAt: '2026-07-11T13:00:00.000Z', // 60m old
    }),
  ]);
  assert.equal(view.badge, 'amber');
  assert.equal(view.health.oddsStale, true);
});

test('AMBER: result still pending >15m after the off; not before', () => {
  const slow = build([
    settledRace({
      race_id: 'slow',
      status: null,
      resultTime: null,
      off_time: new Date(NOW - RESULT_PENDING_SLOW_MS - 60_000).toISOString(),
      lockedDecisionStatus: 'locked_pick',
    }),
  ]);
  assert.equal(slow.badge, 'amber');
  assert.match(slow.badgeReasons.join(' '), /pending >15m/);

  const recent = build([
    settledRace({
      race_id: 'recent',
      status: null,
      resultTime: null,
      off_time: new Date(NOW - 5 * 60_000).toISOString(), // off 5m ago
      lockedDecisionStatus: 'locked_pick',
    }),
  ]);
  assert.equal(recent.badge, 'green');
  assert.equal(recent.results.pending, 1);
});

test('AMBER: status poll erroring while cards are fine', () => {
  const view = build([settledRace()], { statusPollError: true });
  assert.equal(view.badge, 'amber');
  assert.match(view.badgeReasons.join(' '), /status poll/);
});

test('RED outranks AMBER when both kinds of reasons exist', () => {
  const view = build(
    [
      settledRace({ race_id: 'gone', lockedDecisionStatus: null }), // red
      upcomingRace({ oddsUpdatedAt: '2026-07-11T13:00:00.000Z' }), // amber
    ],
  );
  assert.equal(view.badge, 'red');
  assert.match(view.badgeReasons.join(' '), /LOCK MISSING/);
});

/* ----------------------------- counts + labels ----------------------------- */

test('lock counts: locked / not-yet-due / missing / no-run all reported', () => {
  const view = build([
    settledRace({ race_id: 'a', lockedDecisionStatus: 'locked_pick' }),
    settledRace({ race_id: 'b', lockedDecisionStatus: 'locked_no_bet' }),
    settledRace({ race_id: 'c', lockedDecisionStatus: null }), // missing
    upcomingRace({ race_id: 'd' }), // not yet due
  ]);
  assert.equal(view.locks.races, 4);
  assert.equal(view.locks.locked, 2);
  assert.equal(view.locks.lockMissing, 1);
  assert.equal(view.locks.notYetDue, 1);
  assert.equal(view.locks.noRunAvailable, 0);
});

test('next lock due: earliest T-minus-5 target among not-yet-due races', () => {
  const view = build([
    upcomingRace({ race_id: 'later', off_time: '2026-07-11T15:05:00.000Z' }),
    upcomingRace({ race_id: 'sooner', off_time: '2026-07-11T14:30:00.000Z' }),
  ]);
  // Earliest off 14:30 -> capture target 14:25 -> 25 minutes from NOW (14:00).
  assert.equal(view.locks.nextLockDueLabel, 'in 25m');
});

test('next lock due: "due now" once the target has passed; null when nothing is due', () => {
  const inWindow = build([
    upcomingRace({ off_time: '2026-07-11T14:03:00.000Z' }), // target 13:58 < NOW, off ahead
  ]);
  assert.equal(inWindow.locks.nextLockDueLabel, 'due now');

  const allDone = build([settledRace()]);
  assert.equal(allDone.locks.nextLockDueLabel, null);
});

test('results ops: settled/pending counts and last-result age', () => {
  const view = build([
    settledRace(),
    settledRace({
      race_id: 'pending',
      status: null,
      resultTime: null,
      off_time: new Date(NOW - 5 * 60_000).toISOString(),
    }),
    upcomingRace(),
  ]);
  assert.equal(view.results.settled, 1);
  assert.equal(view.results.pending, 1);
  assert.equal(view.results.lastResultLabel, '50m ago'); // 13:10 -> 14:00
  assert.equal(view.health.resultsLabel, '50m ago');
});

test('health labels: platform feed ok, racecards count, freshest odds/model ages', () => {
  const view = build([settledRace(), upcomingRace()]);
  assert.equal(view.health.platformFeed, 'ok');
  assert.equal(view.health.racecards, 2);
  assert.equal(view.health.oddsLabel, '2m ago'); // freshest across races
  assert.equal(view.health.modelLabel, '2m ago');
});

/* --------------------------- safety source scans --------------------------- */

test('command-centre lib is pure: no DB / fs / env / network, no writes', () => {
  const src = readFileSync('src/lib/commandCentre.ts', 'utf8');
  assert.equal(/supabaseAdmin|node:fs|process\.env|\bfetch\s*\(/.test(src), false);
  assert.equal(/\.(insert|update|upsert|delete)\s*\(/.test(src), false);
});

test('panel component is presentational only: no fetch/forms/buttons/writes', () => {
  const src = readFileSync('src/components/CommandCentrePanel.tsx', 'utf8');
  assert.equal(/fetch\(|supabaseAdmin|\/api\//.test(src), false);
  assert.equal(/<form|<button|onClick|onSubmit|--commit/.test(src), false);
});

test('homepage renders the panel at the top from already-loaded data', () => {
  const src = readFileSync('src/app/page.tsx', 'utf8');
  assert.match(src, /buildCommandCentre/);
  assert.match(src, /<CommandCentrePanel view=\{commandCentre\} \/>/);
});
