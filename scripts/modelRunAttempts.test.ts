/**
 * Unit tests for the skipped model-run attempt logger (src/lib/modelRunAttempts.ts).
 *
 * No DB or network: these assert the structured entry shape, the bounded
 * in-memory store, and that the logger emits a structured `console.warn` without
 * touching any database. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildModelRunAttempt,
  clearModelRunAttempts,
  getModelRunAttempts,
  logSkippedModelRun,
  recordModelRunAttempt,
} from '../src/lib/modelRunAttempts';

test('buildModelRunAttempt: structured { race_id, reason, timestamp }', () => {
  const now = new Date('2026-06-15T12:00:00.000Z');
  assert.deepEqual(buildModelRunAttempt('race-1', 'NO_MARKET_SNAPSHOT', now), {
    race_id: 'race-1',
    reason: 'NO_MARKET_SNAPSHOT',
    timestamp: '2026-06-15T12:00:00.000Z',
  });
  // Default `now` is a valid ISO timestamp.
  const attempt = buildModelRunAttempt('race-2', 'NO_PRICED_RUNNERS');
  assert.ok(!Number.isNaN(Date.parse(attempt.timestamp)));
});

test('in-memory store: record + read + clear', () => {
  clearModelRunAttempts();
  assert.deepEqual(getModelRunAttempts(), []);

  recordModelRunAttempt(buildModelRunAttempt('r1', 'NO_PRICED_RUNNERS'));
  recordModelRunAttempt(buildModelRunAttempt('r2', 'NO_MARKET_SNAPSHOT'));
  const stored = getModelRunAttempts();
  assert.equal(stored.length, 2);
  assert.equal(stored[0].race_id, 'r1');
  assert.equal(stored[1].reason, 'NO_MARKET_SNAPSHOT');

  // getModelRunAttempts returns a copy (mutating it does not affect the store).
  (stored as unknown[]).push({});
  assert.equal(getModelRunAttempts().length, 2);

  clearModelRunAttempts();
  assert.deepEqual(getModelRunAttempts(), []);
});

test('in-memory store: bounded to the retention cap (newest kept)', () => {
  clearModelRunAttempts();
  for (let i = 0; i < 130; i++) {
    recordModelRunAttempt(buildModelRunAttempt(`r${i}`, 'NO_PRICED_RUNNERS'));
  }
  const stored = getModelRunAttempts();
  assert.equal(stored.length, 100); // MAX_RETAINED_ATTEMPTS
  assert.equal(stored[0].race_id, 'r30'); // oldest 30 trimmed
  assert.equal(stored[stored.length - 1].race_id, 'r129');
  clearModelRunAttempts();
});

test('logSkippedModelRun: records + warns a structured entry, returns it', () => {
  clearModelRunAttempts();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const now = new Date('2026-06-15T09:30:00.000Z');
    const attempt = logSkippedModelRun('race-9', 'NO_PRICED_RUNNERS', now);

    // Returned + recorded.
    assert.deepEqual(attempt, {
      race_id: 'race-9',
      reason: 'NO_PRICED_RUNNERS',
      timestamp: '2026-06-15T09:30:00.000Z',
    });
    assert.deepEqual(getModelRunAttempts(), [attempt]);

    // Emitted exactly one warning whose payload is the structured JSON entry.
    assert.equal(warnings.length, 1);
    const payload = warnings[0][warnings[0].length - 1];
    assert.deepEqual(JSON.parse(String(payload)), attempt);
  } finally {
    console.warn = originalWarn;
    clearModelRunAttempts();
  }
});
