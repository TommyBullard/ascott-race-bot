/**
 * Unit tests for the shared pipeline cycle (src/lib/raceDayPipelineRunner.ts).
 *
 * No network or DB: the cron caller, races lookup, and per-race model runner are
 * injected as fakes. These lock the odds-gating + summary assembly that BOTH
 * pipeline:day and pipeline:watch rely on. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runPipelineCommitCycle,
  type PipelineRunnerDeps,
  type CronCallResult,
} from '../src/lib/raceDayPipelineRunner';
import type { MeetingRace } from '../src/lib/modelDayRun';

// 2026-06-16 is "today" relative to this now, so a racecards URL is built.
const NOW = new Date('2026-06-16T09:00:00Z');
const DATE = '2026-06-16';

function meetingRaces(): MeetingRace[] {
  return [
    { id: 'r1', course: 'Ascot', off_time: '2026-06-16T13:30:00Z', race_name: 'A' },
    { id: 'r2', course: 'Ascot', off_time: '2026-06-16T14:05:00Z', race_name: 'B' },
  ];
}

/** Builds deps with a cron caller keyed on URL substring + spies. */
function makeDeps(over: {
  racecards?: CronCallResult;
  odds?: CronCallResult;
  rows?: MeetingRace[];
  runOne?: PipelineRunnerDeps['runOneRace'];
}): { deps: PipelineRunnerDeps; calls: { cron: string[]; fetchRaceRowsCalled: boolean } } {
  const calls = { cron: [] as string[], fetchRaceRowsCalled: false };
  const deps: PipelineRunnerDeps = {
    callCron: async (url: string) => {
      calls.cron.push(url);
      if (url.includes('/api/cron/racecards')) {
        return over.racecards ?? { ok: true, body: { ok: true, tier: 'basic', racesInserted: 2, runnersInserted: 10 } };
      }
      return over.odds ?? { ok: true, body: { ok: true, racesConsidered: 2, marketsMatched: 2, snapshotsWritten: 2, quotesWritten: 14 } };
    },
    fetchRaceRows: async () => {
      calls.fetchRaceRowsCalled = true;
      return over.rows ?? meetingRaces();
    },
    runOneRace: over.runOne ?? (async () => ({ scored: 8, recommended: 1 })),
    log: () => {},
    errorLog: () => {},
  };
  return { deps, calls };
}

test('cycle: odds ok -> model runs, summary assembled', async () => {
  const { deps, calls } = makeDeps({});
  const result = await runPipelineCommitCycle(deps, {
    date: DATE, course: 'Ascot', baseUrl: 'http://localhost:3000', allowStale: false, now: NOW,
  });
  assert.equal(result.racecards, 'ok');
  assert.equal(result.odds, 'ok');
  assert.equal(result.modelRan, true);
  assert.equal(calls.fetchRaceRowsCalled, true);
  assert.equal(result.summary.model_races_found, 2);
  assert.equal(result.summary.model_races_run, 2);
  assert.equal(result.summary.recommendations_created, 2);
  assert.equal(result.summary.markets_matched, 2);
  assert.equal(result.summary.quotes_written, 14);
  assert.equal(result.dashboardUrl, 'http://localhost:3000/?date=2026-06-16&course=Ascot');
});

test('cycle: odds failed -> model SKIPPED (races never fetched)', async () => {
  const { deps, calls } = makeDeps({ odds: { ok: false, body: { ok: false } } });
  const result = await runPipelineCommitCycle(deps, {
    date: DATE, course: 'Ascot', baseUrl: 'http://localhost:3000', allowStale: false, now: NOW,
  });
  assert.equal(result.odds, 'failed');
  assert.equal(result.modelRan, false);
  assert.equal(calls.fetchRaceRowsCalled, false);
  assert.equal(result.summary.model_races_found, 0);
  assert.equal(result.summary.model_races_run, 0);
  assert.equal(result.summary.recommendations_created, 0);
});

test('cycle: odds failed + allowStale -> model runs', async () => {
  const { deps, calls } = makeDeps({ odds: { ok: false, body: { ok: false } } });
  const result = await runPipelineCommitCycle(deps, {
    date: DATE, course: 'Ascot', baseUrl: 'http://localhost:3000', allowStale: true, now: NOW,
  });
  assert.equal(result.odds, 'failed');
  assert.equal(result.modelRan, true);
  assert.equal(calls.fetchRaceRowsCalled, true);
  assert.equal(result.summary.model_races_run, 2);
});

test('cycle: racecards failed but odds ok -> model still runs', async () => {
  const { deps } = makeDeps({ racecards: { ok: false, body: { ok: false } } });
  const result = await runPipelineCommitCycle(deps, {
    date: DATE, course: 'Ascot', baseUrl: 'http://localhost:3000', allowStale: false, now: NOW,
  });
  assert.equal(result.racecards, 'failed');
  assert.equal(result.odds, 'ok');
  assert.equal(result.modelRan, true);
  assert.equal(result.summary.model_races_run, 2);
});

test('cycle: failures from a thrown model run are counted, batch continues', async () => {
  const { deps } = makeDeps({
    runOne: async (id: string) => {
      if (id === 'r1') throw new Error('boom');
      return { scored: 5, recommended: 0 };
    },
  });
  const result = await runPipelineCommitCycle(deps, {
    date: DATE, course: 'Ascot', baseUrl: 'http://localhost:3000', allowStale: false, now: NOW,
  });
  assert.equal(result.summary.model_races_found, 2);
  assert.equal(result.summary.model_races_run, 1);
  assert.equal(result.summary.failures, 1);
  assert.equal(result.summary.no_bet_races, 1); // r2 ran with 0 recommendations
});
