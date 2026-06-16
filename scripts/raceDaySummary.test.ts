/**
 * Unit tests for the dashboard top-summary selection (src/lib/raceDaySummary.ts).
 *
 * These lock the fix for the legacy accuracy mismatch: when the dashboard is
 * scoped to a meeting day/course, the header summary must use the corrected
 * race-day `performance` (pre-off evaluated), NOT the global lifetime
 * `accuracy`. Pure; no DB, no React, no secrets.  Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasRaceDayScope,
  selectDashboardSummary,
  type LifetimeAccuracyLike,
  type RaceDayPerformanceLike,
} from '../src/lib/raceDaySummary';

/** The mismatched fixtures from the incident: lifetime 4 settled vs race-day 7. */
const LIFETIME: LifetimeAccuracyLike = {
  racesSettled: 4,
  winners: 2, // deliberately != performance.winners to prove it is not used
  strikeRatePct: 50,
  profitPoints: -4,
  roiPct: -25,
  computedAt: '2026-06-16T20:00:00.000Z',
};

const RACE_DAY: RaceDayPerformanceLike = {
  settled_count: 7,
  winners: 0,
  strike_rate: 0,
  profit_loss: -20.476750534158164,
  roi: -100,
  computedAt: '2026-06-16T20:00:00.000Z',
  evaluationMode: 'pre_off',
};

/* ------------------------------ hasRaceDayScope --------------------------- */

test('hasRaceDayScope: true for ?date / ?day / ?course (leading ? optional)', () => {
  assert.equal(hasRaceDayScope('?date=2026-06-16'), true);
  assert.equal(hasRaceDayScope('date=2026-06-16&course=Ascot'), true);
  assert.equal(hasRaceDayScope('?day=tomorrow'), true);
  assert.equal(hasRaceDayScope('?course=Ascot'), true);
});

test('hasRaceDayScope: false for empty / unrelated / missing query', () => {
  assert.equal(hasRaceDayScope(''), false);
  assert.equal(hasRaceDayScope(null), false);
  assert.equal(hasRaceDayScope(undefined), false);
  assert.equal(hasRaceDayScope('?foo=bar'), false);
  assert.equal(hasRaceDayScope('?date='), false); // present but empty -> not scoped
  assert.equal(hasRaceDayScope('?course=%20'), false); // whitespace only
});

/* --------------------------- selectDashboardSummary ----------------------- */

test('scoped: summary uses race-day performance (settled/winners/profit_loss/roi), not legacy accuracy', () => {
  const summary = selectDashboardSummary(LIFETIME, RACE_DAY, true);
  assert.ok(summary);
  assert.equal(summary.source, 'race_day');
  // From performance, NOT accuracy:
  assert.equal(summary.settled, 7); // performance.settled_count, not accuracy.racesSettled (4)
  assert.equal(summary.winners, 0); // performance.winners, not accuracy.winners (2)
  assert.equal(summary.profitLoss, -20.476750534158164); // performance.profit_loss, not accuracy.profitPoints (-4)
  assert.equal(summary.roiPct, -100); // performance.roi, not accuracy.roiPct (-25)
  assert.equal(summary.strikeRatePct, 0); // performance.strike_rate
});

test('scoped: the legacy accuracy object does NOT override the race-day performance summary', () => {
  const summary = selectDashboardSummary(LIFETIME, RACE_DAY, true);
  assert.ok(summary);
  // None of the legacy accuracy figures leak into a scoped summary.
  assert.notEqual(summary.settled, LIFETIME.racesSettled);
  assert.notEqual(summary.profitLoss, LIFETIME.profitPoints);
  assert.notEqual(summary.winners, LIFETIME.winners);
  assert.notEqual(summary.roiPct, LIFETIME.roiPct);
});

test('scoped: race-day summary surfaces performance.evaluationMode = "pre_off" (the value /api/accuracy returns)', () => {
  const summary = selectDashboardSummary(LIFETIME, RACE_DAY, true);
  assert.ok(summary);
  assert.equal(summary.evaluationMode, 'pre_off');
});

test('scoped: evaluationMode defaults to "pre_off" when an older performance payload omits it', () => {
  const legacyPayload: RaceDayPerformanceLike = { ...RACE_DAY };
  delete legacyPayload.evaluationMode;
  const summary = selectDashboardSummary(LIFETIME, legacyPayload, true);
  assert.ok(summary);
  assert.equal(summary.evaluationMode, 'pre_off');
});

test('unscoped: summary uses the lifetime accuracy (global record), evaluationMode null', () => {
  const summary = selectDashboardSummary(LIFETIME, RACE_DAY, false);
  assert.ok(summary);
  assert.equal(summary.source, 'lifetime');
  assert.equal(summary.settled, 4); // accuracy.racesSettled
  assert.equal(summary.winners, 2); // accuracy.winners
  assert.equal(summary.profitLoss, -4); // accuracy.profitPoints
  assert.equal(summary.roiPct, -25); // accuracy.roiPct
  assert.equal(summary.evaluationMode, null);
});

test('scoped but no performance yet: falls back to lifetime accuracy (no crash)', () => {
  const summary = selectDashboardSummary(LIFETIME, null, true);
  assert.ok(summary);
  assert.equal(summary.source, 'lifetime');
  assert.equal(summary.settled, 4);
});

test('neither block present: null (the bar renders nothing)', () => {
  assert.equal(selectDashboardSummary(null, null, true), null);
  assert.equal(selectDashboardSummary(null, null, false), null);
});
