/**
 * Tests for the shared same-day result-settlement orchestration
 * (src/lib/todayResultsSettlement.ts).
 *
 * The network fallback (Basic `/v1/results/today` preferred, then Free
 * `/v1/results/today/free`) is exercised with a fake RacingApiClient (no network,
 * no DB). The today-fallback predicate is unit-tested, and a source scan proves
 * the lib is the SINGLE auto-writer: it writes ONLY commit-gated finish_pos +
 * race status, never SP/BSP, and never inserts/upserts/deletes/rpc. Run:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { RacingApiClient, ResultFreeRace } from '../src/lib/racingApi';
import {
  fetchTodayResultsWithFallback,
  pageTodayResults,
  shouldUseTodayFallback,
} from '../src/lib/todayResultsSettlement';

/** A minimal fake client: only the two today endpoints matter for these paths. */
function fakeClient(over: Partial<RacingApiClient>): RacingApiClient {
  return {
    getTodayResults: async () => ({ results: [], total: 0, limit: 100, skip: 0 }),
    getTodayFreeResults: async () => ({ results: [], total: 0, limit: 100, skip: 0 }),
    ...over,
  } as unknown as RacingApiClient;
}

function freeRace(over: Partial<ResultFreeRace> = {}): ResultFreeRace {
  return { race_id: 'rac_1', course: 'Ascot', date: '2026-06-19', off_dt: '2026-06-19T13:30:00+00:00', runners: [], ...over };
}

const planBlocked = new Error('Racing API 401 Unauthorized for /results — ... Standard Plan required ...');

/* ----------------------- preferred-then-fallback fetch -------------------- */

test('fetchTodayResultsWithFallback: Basic success wins; Free is NOT called', async () => {
  let freeCalled = false;
  const client = fakeClient({
    getTodayResults: async () => ({ results: [freeRace()], total: 1, limit: 100, skip: 0 }),
    getTodayFreeResults: async () => {
      freeCalled = true;
      return { results: [], total: 0, limit: 100, skip: 0 };
    },
  });
  const r = await fetchTodayResultsWithFallback(client, ['gb']);
  assert.equal(r.source, 'today_basic');
  assert.equal(r.label, 'The Racing API /v1/results/today');
  assert.equal(r.races.length, 1);
  assert.equal(freeCalled, false); // Basic succeeded -> Free never attempted
});

test('fetchTodayResultsWithFallback: Basic failure falls back to Free', async () => {
  const client = fakeClient({
    getTodayResults: async () => {
      throw planBlocked;
    },
    getTodayFreeResults: async () => ({ results: [freeRace()], total: 1, limit: 100, skip: 0 }),
  });
  const r = await fetchTodayResultsWithFallback(client, ['gb']);
  assert.equal(r.source, 'today_free');
  assert.equal(r.label, 'The Racing API /v1/results/today/free');
  assert.equal(r.races.length, 1);
});

test('fetchTodayResultsWithFallback: BOTH endpoints failing throws an aggregated error', async () => {
  const client = fakeClient({
    getTodayResults: async () => {
      throw new Error('basic boom');
    },
    getTodayFreeResults: async () => {
      throw new Error('free boom');
    },
  });
  await assert.rejects(
    () => fetchTodayResultsWithFallback(client, ['gb']),
    /today results unavailable \(basic: basic boom; free: free boom\)/,
  );
});

test('pageTodayResults: selects the Basic vs Free endpoint by source', async () => {
  let basicCalls = 0;
  let freeCalls = 0;
  const client = fakeClient({
    getTodayResults: async () => {
      basicCalls += 1;
      return { results: [freeRace()], total: 1, limit: 100, skip: 0 };
    },
    getTodayFreeResults: async () => {
      freeCalls += 1;
      return { results: [freeRace()], total: 1, limit: 100, skip: 0 };
    },
  });
  await pageTodayResults(client, ['gb'], 'today_basic');
  assert.equal(basicCalls, 1);
  assert.equal(freeCalls, 0);
  await pageTodayResults(client, ['gb'], 'today_free');
  assert.equal(freeCalls, 1);
});

/* --------------------------- fallback predicate --------------------------- */

test('shouldUseTodayFallback: only plan-blocked AND today triggers the fallback', () => {
  const today = new Date().toISOString().slice(0, 10);
  // plan-blocked + today -> fall back to the today endpoints
  assert.equal(shouldUseTodayFallback(planBlocked, today), true);
  // plan-blocked but NOT today -> the today endpoints cannot help (today-only)
  assert.equal(shouldUseTodayFallback(planBlocked, '2020-01-01'), false);
  // a non-plan-block error must NEVER be masked by the fallback
  assert.equal(shouldUseTodayFallback(new Error('network down'), today), false);
  // a rate-limit / 429 is not a plan block -> no fallback
  assert.equal(shouldUseTodayFallback(new Error('Racing API 429 rate-limited'), today), false);
});

/* ----------------------- read-only / write-guard scan --------------------- */

test('the shared settler writes ONLY commit-gated finish_pos / race-status; never SP/BSP', () => {
  const src = readFileSync('src/lib/todayResultsSettlement.ts', 'utf8');
  // No row creation/removal/RPC — only the two idempotent result updates.
  assert.equal(/\.insert\s*\(/.test(src), false);
  assert.equal(/\.upsert\s*\(/.test(src), false);
  assert.equal(/\.delete\s*\(/.test(src), false);
  assert.equal(/\.rpc\s*\(/.test(src), false);
  // SELECT reads exist; the only writes are commit-gated finish_pos + race status.
  assert.ok(/\.select\s*\(/.test(src));
  assert.match(src, /if \(params\.commit\)/);
  assert.match(src, /\.update\(\{ finish_pos: u\.finish_pos \}\)/);
  assert.match(src, /\.update\(\{ status: 'result', official_result_time: nowIso \}\)/);
  // never writes SP/BSP (the today tiers carry none; nothing is fabricated).
  assert.equal(/sp_decimal|bsp_decimal/.test(src), false);
});
