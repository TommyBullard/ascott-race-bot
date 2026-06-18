/**
 * Unit tests for the pure cron-heartbeat shaping + summary
 * (src/lib/cronHeartbeat.ts). No DB — `recordCronRun` (I/O) is not exercised.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCronRunRecord,
  summarizeCronHealth,
  type CronRunRow,
} from '../src/lib/cronHeartbeat';

test('buildCronRunRecord: shapes timing, ok, counts, and a secret-safe error', () => {
  const started = new Date('2026-06-18T14:00:00Z');
  const finished = new Date('2026-06-18T14:00:03Z');
  const rec = buildCronRunRecord({
    job: 'odds',
    startedAt: started,
    finishedAt: finished,
    ok: true,
    httpStatus: 200,
    counts: { snapshotsWritten: 12, quotesWritten: 84, junk: 'x' },
  });
  assert.equal(rec.job, 'odds');
  assert.equal(rec.duration_ms, 3000);
  assert.equal(rec.ok, true);
  assert.equal(rec.http_status, 200);
  assert.deepEqual(rec.counts, { snapshotsWritten: 12, quotesWritten: 84 }); // non-numbers dropped
  assert.equal(rec.error, null);
});

test('buildCronRunRecord: error reduces to its message; duration never negative', () => {
  const rec = buildCronRunRecord({
    job: 'results',
    startedAt: new Date('2026-06-18T14:00:05Z'),
    finishedAt: new Date('2026-06-18T14:00:00Z'), // earlier -> clamp to 0
    ok: false,
    error: new Error('Racing API 403 plan_blocked'),
  });
  assert.equal(rec.ok, false);
  assert.equal(rec.duration_ms, 0);
  assert.equal(rec.error, 'Racing API 403 plan_blocked');
  assert.equal(rec.counts, null);
});

test('summarizeCronHealth: newest run wins per job; OK/FAIL tracked separately', () => {
  const rows: CronRunRow[] = [
    { job: 'odds', finished_at: '2026-06-18T13:50:00Z', ok: true },
    { job: 'odds', finished_at: '2026-06-18T13:55:00Z', ok: false }, // newest odds = failed
    { job: 'odds', finished_at: '2026-06-18T13:45:00Z', ok: true },
    { job: 'results', finished_at: '2026-06-18T13:58:00Z', ok: true },
    { job: 'bad', finished_at: null, ok: true }, // ignored (no timestamp)
  ];
  const sum = summarizeCronHealth(rows);

  const odds = sum.jobs.find((j) => j.job === 'odds')!;
  assert.equal(odds.lastStatus, 'failed');
  assert.equal(odds.lastFailMs, Date.parse('2026-06-18T13:55:00Z'));
  assert.equal(odds.lastOkMs, Date.parse('2026-06-18T13:50:00Z')); // most recent OK

  assert.equal(sum.lastCronOkMs.odds, Date.parse('2026-06-18T13:50:00Z'));
  assert.equal(sum.lastCronFailMs.odds, Date.parse('2026-06-18T13:55:00Z'));
  assert.equal(sum.lastCronOkMs.results, Date.parse('2026-06-18T13:58:00Z'));
  assert.equal(sum.lastCronFailMs.results, undefined);
  assert.equal(sum.jobs.find((j) => j.job === 'bad'), undefined);
});

test('summarizeCronHealth: empty input -> empty maps (no fabrication)', () => {
  const sum = summarizeCronHealth([]);
  assert.deepEqual(sum.jobs, []);
  assert.deepEqual(sum.lastCronOkMs, {});
  assert.deepEqual(sum.lastCronFailMs, {});
});
