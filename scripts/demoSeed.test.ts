/**
 * Unit tests for the pure demo-seed builders + guard (src/lib/demoSeed.ts).
 *
 * No DB, no network: assert the synthetic data shape, the runner-count clamp,
 * and that the safety guard rejects any non-synthetic name. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDemoName,
  clampRunnerCount,
  buildDemoRunnerSpecs,
  buildDemoTipsterSpecs,
  assertAllSynthetic,
  DEMO_RUNNER_MIN,
  DEMO_RUNNER_MAX,
} from '../src/lib/demoSeed';

test('isDemoName: true only when DEMO/SYNTHETIC present (case-insensitive)', () => {
  assert.equal(isDemoName('DEMO Runner 1 (SYNTHETIC)'), true);
  assert.equal(isDemoName('synthetic horse'), true);
  assert.equal(isDemoName('demo'), true);
  assert.equal(isDemoName('Frankel'), false);
  assert.equal(isDemoName(''), false);
  assert.equal(isDemoName(undefined), false);
  assert.equal(isDemoName(null), false);
});

test('clampRunnerCount: clamps into [6, 8], defaults to max on bad input', () => {
  assert.equal(clampRunnerCount(6), 6);
  assert.equal(clampRunnerCount(7), 7);
  assert.equal(clampRunnerCount(8), 8);
  assert.equal(clampRunnerCount(3), DEMO_RUNNER_MIN);
  assert.equal(clampRunnerCount(99), DEMO_RUNNER_MAX);
  assert.equal(clampRunnerCount(7.9), 7); // floored
  assert.equal(clampRunnerCount(undefined), DEMO_RUNNER_MAX);
  assert.equal(clampRunnerCount(Number.NaN), DEMO_RUNNER_MAX);
});

test('buildDemoRunnerSpecs: synthetic names + plausible distinct odds > 1', () => {
  const specs = buildDemoRunnerSpecs(8);
  assert.equal(specs.length, 8);
  for (const s of specs) {
    assert.equal(isDemoName(s.horse_name), true);
    assert.ok(s.odds_decimal > 1, `odds ${s.odds_decimal} should be > 1`);
  }
  // Names are unique and odds are unique (a real-ish ladder).
  assert.equal(new Set(specs.map((s) => s.horse_name)).size, 8);
  assert.equal(new Set(specs.map((s) => s.odds_decimal)).size, 8);
  // Count is clamped through the builder too.
  assert.equal(buildDemoRunnerSpecs(3).length, DEMO_RUNNER_MIN);
  assert.equal(buildDemoRunnerSpecs(50).length, DEMO_RUNNER_MAX);
});

test('buildDemoRunnerSpecs: deterministic (same shape on every call)', () => {
  assert.deepEqual(buildDemoRunnerSpecs(6), buildDemoRunnerSpecs(6));
});

test('buildDemoTipsterSpecs: 3 tipsters, every name synthetic', () => {
  const tipsters = buildDemoTipsterSpecs();
  assert.equal(tipsters.length, 3);
  for (const t of tipsters) {
    assert.equal(isDemoName(t.canonical_name), true);
    assert.equal(isDemoName(t.affiliation), true);
  }
});

test('assertAllSynthetic: passes for synthetic names, throws otherwise', () => {
  assert.doesNotThrow(() =>
    assertAllSynthetic(['DEMO Downs (SYNTHETIC)', 'DEMO Runner 1 (SYNTHETIC)']),
  );
  assert.throws(
    () => assertAllSynthetic(['DEMO Downs (SYNTHETIC)', 'Ascot']),
    /not marked DEMO\/SYNTHETIC: Ascot/,
  );
});
