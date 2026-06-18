/**
 * Unit tests for the race-day health engine (src/lib/raceDayHealth.ts).
 *
 * No I/O. Synthetic meetings drive every phase (no_races / pre / racing / post)
 * and the stale/stalled freshness transitions, locking the monitoring verdicts
 * and the operator action the health dashboard renders. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessRaceDayHealth,
  type HealthInput,
  type HealthStage,
} from '../src/lib/raceDayHealth';

const MIN = 60_000;
const NOW = new Date('2026-06-18T14:00:00Z');
const nowMs = NOW.getTime();

function stage(h: ReturnType<typeof assessRaceDayHealth>, s: HealthStage) {
  return h.stages.find((x) => x.stage === s)!;
}

/** A racing-phase meeting: one race off 5 min ago (awaiting), one in 20 min. */
function racingInput(over: Partial<HealthInput> = {}): HealthInput {
  return {
    now: NOW,
    races: [
      { offTimeMs: nowMs - 5 * MIN, status: 'scheduled' },
      { offTimeMs: nowMs + 20 * MIN, status: 'scheduled' },
    ],
    latestOddsMs: nowMs - 2 * MIN,
    latestModelMs: nowMs - 2 * MIN,
    ...over,
  };
}

test('no_races -> IDLE system, racecards STALLED only when racing/pre', () => {
  const h = assessRaceDayHealth({ now: NOW, races: [], latestOddsMs: null, latestModelMs: null });
  assert.equal(h.phase, 'no_races');
  assert.equal(h.systemStatus, 'IDLE');
  assert.equal(stage(h, 'racecards').status, 'IDLE');
  assert.equal(h.action.headline, 'No meeting loaded');
});

test('racing + all fresh -> HEALTHY and a positive monitor action', () => {
  const h = assessRaceDayHealth(racingInput());
  assert.equal(h.phase, 'racing');
  assert.equal(h.systemStatus, 'HEALTHY');
  assert.equal(stage(h, 'odds').status, 'FRESH');
  assert.equal(stage(h, 'model').status, 'FRESH');
  assert.equal(stage(h, 'racecards').status, 'FRESH');
  assert.equal(h.action.tone, 'pos');
});

test('stale odds -> DEGRADED; stalled odds -> STALLED with a warn action', () => {
  const degraded = assessRaceDayHealth(racingInput({ latestOddsMs: nowMs - 15 * MIN }));
  assert.equal(stage(degraded, 'odds').status, 'STALE');
  assert.equal(degraded.systemStatus, 'DEGRADED');

  const stalled = assessRaceDayHealth(racingInput({ latestOddsMs: nowMs - 30 * MIN }));
  assert.equal(stage(stalled, 'odds').status, 'STALLED');
  assert.equal(stalled.systemStatus, 'STALLED');
  assert.equal(stalled.action.headline, 'Odds refresh stalled');
  assert.equal(stalled.action.tone, 'warn');
});

test('missing odds during racing is STALLED (a dead cron is surfaced, not hidden)', () => {
  const h = assessRaceDayHealth(racingInput({ latestOddsMs: null }));
  assert.equal(stage(h, 'odds').status, 'STALLED');
});

test('model lagging the latest odds is flagged STALE even if recent', () => {
  // Odds just now, model 11m old -> model FRESH absolutely but 11m behind odds
  // (> MODEL_LAG_MS) -> STALE with the lag detail.
  const h = assessRaceDayHealth(racingInput({ latestOddsMs: nowMs, latestModelMs: nowMs - 11 * MIN }));
  const m = stage(h, 'model');
  assert.equal(m.status, 'STALE');
  assert.match(m.detail, /behind the latest odds/);
});

test('settlement overdue: a started race long unsettled -> results STALLED', () => {
  const h = assessRaceDayHealth({
    now: NOW,
    races: [{ offTimeMs: nowMs - 50 * MIN, status: 'scheduled' }], // 50m past off, unsettled
    latestOddsMs: nowMs - 2 * MIN,
    latestModelMs: nowMs - 2 * MIN,
  });
  assert.equal(stage(h, 'results').status, 'STALLED');
  assert.equal(h.action.headline, 'Settlement overdue');
});

test('post phase: all settled -> reports action, results FRESH', () => {
  const h = assessRaceDayHealth({
    now: NOW,
    races: [{ offTimeMs: nowMs - 60 * MIN, status: 'result' }],
    latestOddsMs: nowMs - 60 * MIN,
    latestModelMs: nowMs - 60 * MIN,
  });
  assert.equal(h.phase, 'post');
  assert.equal(stage(h, 'results').status, 'FRESH');
  assert.equal(h.action.headline, 'All races settled');
});

test('pre phase: cards loaded but first off far away -> odds/model IDLE', () => {
  const h = assessRaceDayHealth({
    now: NOW,
    races: [{ offTimeMs: nowMs + 4 * 60 * MIN, status: 'scheduled' }], // 4h away
    latestOddsMs: null,
    latestModelMs: null,
  });
  assert.equal(h.phase, 'pre');
  assert.equal(stage(h, 'odds').status, 'IDLE');
  assert.equal(stage(h, 'model').status, 'IDLE');
  assert.equal(h.action.tone, 'neutral');
});

test('a FAILED cron heartbeat is surfaced in the action detail', () => {
  const h = assessRaceDayHealth(
    racingInput({
      latestOddsMs: nowMs - 30 * MIN, // stalled odds
      lastCronFailMs: { odds: nowMs - 4 * MIN },
      lastCronOkMs: { odds: nowMs - 30 * MIN },
    }),
  );
  assert.match(h.action.detail, /last odds cron FAILED/);
});
