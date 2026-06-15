/**
 * Unit tests for the pure append-only model-history helpers
 * (src/lib/modelRunHistory.ts) used by Batch C.
 *
 * No DB or network: these assert the supersession marker/patch and the
 * id-selection logic — the deterministic pieces the producer (runModelForRace)
 * shares with the read paths. The unchanged model-math fixtures (scenarios.test
 * / backtest.test) cover that the probability/staking math is untouched by this
 * batch; the readers' inline `is_current` filter is covered by typecheck +
 * manual verification (see the batch summary).
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSupersedePatch,
  currentMarker,
  selectRunIdsToSupersede,
} from '../src/lib/modelRunHistory';

// (1) New rows are stamped current.
test('currentMarker stamps new rows is_current = true / superseded_at = null', () => {
  assert.deepEqual(currentMarker(), { is_current: true, superseded_at: null });
});

// (2) Superseded rows get is_current = false and a superseded_at timestamp.
test('buildSupersedePatch marks is_current = false and sets superseded_at', () => {
  const now = new Date('2026-06-15T12:00:00.000Z');
  assert.deepEqual(buildSupersedePatch(now), {
    is_current: false,
    superseded_at: '2026-06-15T12:00:00.000Z',
  });

  // Default `now` is the wall clock — still a valid ISO timestamp.
  const patch = buildSupersedePatch();
  assert.equal(patch.is_current, false);
  assert.ok(!Number.isNaN(Date.parse(patch.superseded_at)));
});

// Identifying which rows to supersede (UPDATE, never delete). The producer
// inserts the new run first, then supersedes the OTHER current runs by passing
// the new run id as the exclude (see the exclude test below). With no exclude,
// every supplied id is returned; ids are normalised to strings.
test('selectRunIdsToSupersede returns all current run ids (normalised) by default', () => {
  assert.deepEqual(selectRunIdsToSupersede(['a', 'b', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(selectRunIdsToSupersede([1, 2, 3]), ['1', '2', '3']);
  assert.deepEqual(selectRunIdsToSupersede([]), []);
});

// Insert-new-then-supersede-others: the just-inserted run id is excluded, so
// only the older current runs are superseded and the new run stays current.
test('selectRunIdsToSupersede excludes the just-inserted current run id', () => {
  assert.deepEqual(selectRunIdsToSupersede(['new', 'old1', 'old2'], 'new'), [
    'old1',
    'old2',
  ]);
  assert.deepEqual(selectRunIdsToSupersede([1, 2, 3], 2), ['1', '3']);
});
