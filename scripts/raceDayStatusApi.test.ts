/**
 * Unit tests for the read-only race-day status API builder
 * (src/lib/raceDayStatusApi.ts) plus read-only source-scan guards on the route.
 *
 * The builder is pure + deterministic given an injected `now`, so no DB / network
 * is needed. The scans lock down the task's rules: the endpoint is read-only,
 * never writes the DB, never calls an external API, never exposes a commit/write
 * control, and never places a bet. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  isValidIsoDate,
  buildRaceDayStatus,
  type StatusCardInput,
  type PerformanceInputLike,
} from '../src/lib/raceDayStatusApi';

/** Fixed clock AFTER all the fixture races (so they read as settled/past). */
const NOW = Date.parse('2026-06-17T18:30:00Z');

function card(over: Partial<StatusCardInput> = {}): StatusCardInput {
  return {
    race_id: 'r1',
    off_time: '2026-06-17T13:30:00Z',
    race_name: 'Queen Mary Stakes',
    course: 'Ascot',
    status: 'result',
    result_time: '2026-06-17T13:35:00Z',
    oddsUpdatedAt: '2026-06-17T13:22:00Z',
    modelUpdatedAt: '2026-06-17T13:22:30Z',
    hasModelRun: true,
    runQuality: 'OK',
    confidenceLabel: 'Low',
    modelPick: { runner_id: 'a', horse_name: 'Alta Regina', odds: 5.7, finish_pos: 6 },
    favourite: { runner_id: 'a', horse_name: 'Alta Regina', odds: 5.7, finish_pos: 6 },
    ...over,
  };
}

const PERF: PerformanceInputLike = {
  recommendations_total: 7,
  settled_count: 7,
  pending_count: 0,
  winners: 2,
  losers: 5,
  profit_loss: 1.1685,
  roi: 15.7,
  evaluationMode: 'pre_off',
};

function build(over: Partial<Parameters<typeof buildRaceDayStatus>[0]> = {}) {
  return buildRaceDayStatus({
    date: '2026-06-17',
    course: 'Ascot',
    now: NOW,
    cards: [card()],
    performance: PERF,
    ...over,
  });
}

/* ------------------------------ date validation --------------------------- */

test('isValidIsoDate accepts real YYYY-MM-DD and rejects everything else', () => {
  assert.equal(isValidIsoDate('2026-06-17'), true);
  assert.equal(isValidIsoDate('2026-13-01'), false);
  assert.equal(isValidIsoDate('2026-02-30'), false);
  assert.equal(isValidIsoDate('17-06-2026'), false);
  assert.equal(isValidIsoDate('2026/06/17'), false);
  assert.equal(isValidIsoDate(''), false);
  assert.equal(isValidIsoDate(null), false);
  assert.equal(isValidIsoDate(undefined), false);
});

/* -------------------------------- safety ---------------------------------- */

test('safety flags are readOnly true / autoBetting false / uiCommitAllowed false', () => {
  assert.deepEqual(build().safety, {
    readOnly: true,
    autoBetting: false,
    uiCommitAllowed: false,
  });
});

/* ------------------------------ performance ------------------------------- */

test('performance summary is passed through; null -> zeros + pre_off', () => {
  assert.deepEqual(build().performance, {
    recommendations_total: 7,
    settled_count: 7,
    pending_count: 0,
    winners: 2,
    losers: 5,
    profit_loss: 1.1685,
    roi: 15.7,
    evaluationMode: 'pre_off',
  });

  const empty = build({ performance: null }).performance;
  assert.equal(empty.recommendations_total, 0);
  assert.equal(empty.settled_count, 0);
  assert.equal(empty.evaluationMode, 'pre_off');
});

/* ------------------------------- next race -------------------------------- */

test('next race is the soonest upcoming, with pick/favourite/confidence/quality', () => {
  const upcoming = card({
    race_id: 'up',
    off_time: new Date(NOW + 20 * 60_000).toISOString(),
    status: null,
    result_time: null,
    confidenceLabel: 'High',
    runQuality: 'DEGRADED',
    modelPick: { runner_id: 'x', horse_name: 'Xena', odds: 3.0, finish_pos: null },
    favourite: { runner_id: 'y', horse_name: 'Yas', odds: 2.5, finish_pos: null },
  });
  const r = build({ cards: [card(), upcoming] });
  assert.equal(r.nextRace?.race_id, 'up');
  assert.equal(r.nextRace?.race_state, 'upcoming');
  assert.equal(r.nextRace?.model_pick?.horse_name, 'Xena');
  assert.equal(r.nextRace?.market_favourite?.horse_name, 'Yas');
  assert.equal(r.nextRace?.confidence, 'High');
  assert.equal(r.nextRace?.data_quality, 'DEGRADED');
  assert.equal(r.nextRace?.result_status, 'none');
});

/* ------------------------- race states + freshness ------------------------ */

test('races include state, result, settled flag + finish pos, and freshness labels', () => {
  const r = build();
  assert.equal(r.races.length, 1);
  const e = r.races[0];
  assert.equal(e.race_state, 'settled');
  assert.equal(e.result_status, 'settled');
  assert.equal(e.settled, true);
  assert.equal(e.model_pick_finish_pos, 6); // surfaced for settled races
  assert.equal(e.model_pick?.horse_name, 'Alta Regina');
  assert.equal(e.market_favourite?.horse_name, 'Alta Regina');
  assert.equal(typeof e.freshness.odds, 'string');
  assert.equal(typeof e.freshness.model, 'string');
  assert.equal(typeof e.freshness.odds_stale, 'boolean');
  assert.match(e.freshness.odds, /ago|just now|unknown/);
});

test('settled races use the pre-off model decision (finish hidden until settled)', () => {
  // evaluationMode passes through as pre_off; a pending race hides the finish.
  assert.equal(build().performance.evaluationMode, 'pre_off');

  const pending = build({
    cards: [card({ status: null, result_time: null })],
  });
  const e = pending.races[0];
  assert.equal(e.settled, false);
  assert.equal(e.result_status, 'pending');
  assert.equal(e.model_pick_finish_pos, null); // not shown pre-settlement
});

/* ------------------------------ next action ------------------------------- */

test('operator next action is included (all-settled day -> all-settled)', () => {
  const r = build();
  assert.equal(typeof r.nextAction.kind, 'string');
  assert.equal(typeof r.nextAction.headline, 'string');
  assert.equal(r.nextAction.kind, 'all-settled');
});

/* ------------------------- shape / determinism ---------------------------- */

test('output shape + generatedAt are deterministic', () => {
  const input = {
    date: '2026-06-17',
    course: 'Ascot',
    now: NOW,
    cards: [card()],
    performance: PERF,
  };
  assert.deepEqual(buildRaceDayStatus(input), buildRaceDayStatus(input));
  assert.equal(buildRaceDayStatus(input).generatedAt, new Date(NOW).toISOString());

  const r = buildRaceDayStatus(input);
  assert.deepEqual(Object.keys(r).sort(), [
    'course',
    'date',
    'generatedAt',
    'nextAction',
    'nextRace',
    'performance',
    'races',
    'safety',
  ]);
  assert.deepEqual(Object.keys(r.safety).sort(), [
    'autoBetting',
    'readOnly',
    'uiCommitAllowed',
  ]);
  assert.deepEqual(Object.keys(r.performance).sort(), [
    'evaluationMode',
    'losers',
    'pending_count',
    'profit_loss',
    'recommendations_total',
    'roi',
    'settled_count',
    'winners',
  ]);
});

test('a missing course is handled (course null, races still built)', () => {
  const r = build({ course: null });
  assert.equal(r.course, null);
  assert.equal(r.races.length, 1);
});

/* --------------------- read-only guards (source scans) -------------------- */

test('the status builder is pure (no DB, fs, env, network, commit, bets)', () => {
  const lib = readFileSync('src/lib/raceDayStatusApi.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs/.test(lib), false);
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/\bfetch\s*\(/.test(lib), false);
  assert.equal(/--commit/.test(lib), false);
  assert.equal(/placeOrder|placeBet|submitOrder/i.test(lib), false);
});

test('the API route is read-only (no writes, no external API, no commit, no bets)', () => {
  const route = readFileSync('src/app/api/race-day/status/route.ts', 'utf8');
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(route), false);
  assert.equal(/--commit/.test(route), false);
  assert.equal(/placeOrder|placeBet|submitOrder/i.test(route), false);
  assert.equal(/\bfetch\s*\(/.test(route), false); // no direct external API call
  // reads via shared read-only helpers, validates the date, exposes safety flags
  assert.match(route, /computeModelPerformance/);
  assert.match(route, /fetchRaceCard/);
  assert.match(route, /buildRaceDayStatus/);
  assert.match(route, /isValidIsoDate/);
  assert.match(route, /status: 400/);
});
