/**
 * Betting-engine regression tests.
 *
 * Two scenarios pin the engine's headline behaviors. They drive the REAL
 * pipeline through the shared harness in `scenarios.ts` (no Supabase / env),
 * using Node's built-in test runner + assertions (zero extra dependencies).
 *
 * Run with:  npm test
 *
 * Fails if:
 *   - Scenario 1 does not pick Horse D
 *   - Scenario 1 confidence is not HIGH
 *   - Scenario 2 stake is not the 0.1% floor
 *   - Scenario 2 confidence is not LOW
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runScenario,
  DEFAULT_BANKROLL,
  STAKE_FLOOR_FRACTION,
  SCENARIO_1_RUNNERS,
  SCENARIO_1_TIPSTERS,
  SCENARIO_2_RUNNERS,
  SCENARIO_2_TIPSTERS,
  SCENARIO_3_RUNNERS,
  SCENARIO_3_TIPSTERS,
  SCENARIO_4_RUNNERS,
  SCENARIO_4_ALIASED_TIPSTERS,
  SCENARIO_4_DEDUPED_TIPSTERS,
  SCENARIO_4_DISTINCT_TIPSTERS,
  SCENARIO_5_RUNNERS,
  SCENARIO_5_TIPSTERS,
} from './scenarios';

test('Scenario 1: strong tipsters beat the crowded favourite', () => {
  const result = runScenario(SCENARIO_1_RUNNERS, SCENARIO_1_TIPSTERS);

  assert.ok(result.pick, 'engine should return a pick');

  // FAIL if the pick is not Horse D.
  assert.equal(
    result.pick.name,
    'Horse D',
    `expected pick "Horse D", got "${result.pick.name}"`,
  );

  // FAIL if confidence is not HIGH.
  assert.equal(
    result.confidenceLabel,
    'high',
    `expected HIGH confidence, got "${result.confidenceLabel}" (score ${result.confidence.toFixed(4)})`,
  );

  // The crowded favourite (Horse A) must have been faded, not selected.
  assert.notEqual(
    result.pick.name,
    'Horse A',
    'crowded favourite should not be selected',
  );
});

test('Scenario 2: no-value race stakes the minimum floor with LOW confidence', () => {
  const result = runScenario(SCENARIO_2_RUNNERS, SCENARIO_2_TIPSTERS);

  assert.ok(result.pick, 'engine should still return a pick');

  // A bet is taken (tiny +EV), so the stake must be positive...
  assert.ok(result.stake > 0, 'stake should be positive');

  // ...and FAIL if it is not clamped to the 0.1% floor (no overbetting).
  const floor = STAKE_FLOOR_FRACTION * DEFAULT_BANKROLL;
  assert.ok(
    Math.abs(result.stake - floor) < 1e-9,
    `expected stake at floor ${floor}, got ${result.stake}`,
  );

  // FAIL if confidence is not LOW.
  assert.equal(
    result.confidenceLabel,
    'low',
    `expected LOW confidence, got "${result.confidenceLabel}" (score ${result.confidence.toFixed(4)})`,
  );
});

test('Scenario 3: a justified favourite is still selected, +EV, not suppressed', () => {
  const result = runScenario(SCENARIO_3_RUNNERS, SCENARIO_3_TIPSTERS);

  assert.ok(result.pick, 'engine should return a pick');

  // FAIL if the strong-backed favourite is not selected.
  assert.equal(
    result.pick.name,
    'Horse A',
    `expected the justified favourite "Horse A", got "${result.pick.name}"`,
  );

  // FAIL if its EV is not positive.
  assert.ok(
    result.pick.ev > 0,
    `expected positive EV, got ${(result.pick.ev * 100).toFixed(2)}%`,
  );

  // FAIL if the anti-crowd bias suppressed it: a justified favourite should be
  // lifted ABOVE its market-implied probability, not pushed below.
  assert.ok(
    result.pick.model > result.pick.market,
    `anti-crowd bias suppressed the favourite: model ${result.pick.model.toFixed(4)} <= market ${result.pick.market.toFixed(4)}`,
  );

  // FAIL if the stake is not above the floor (a real bet, not a token stake).
  const floor = STAKE_FLOOR_FRACTION * DEFAULT_BANKROLL;
  assert.ok(
    result.stake > floor,
    `expected stake above floor ${floor}, got ${result.stake}`,
  );
});

test('Scenario 4: duplicate aliases do not inflate support (match deduped)', () => {
  const aliased = runScenario(SCENARIO_4_RUNNERS, SCENARIO_4_ALIASED_TIPSTERS);
  const deduped = runScenario(SCENARIO_4_RUNNERS, SCENARIO_4_DEDUPED_TIPSTERS);

  assert.ok(aliased.pick && deduped.pick, 'both variants should return a pick');

  // FAIL if the aliased variant selects a different horse than the deduped one.
  assert.equal(
    aliased.pick.name,
    deduped.pick.name,
    `aliased pick "${aliased.pick.name}" should match deduped pick "${deduped.pick.name}"`,
  );

  // FAIL if per-runner weighted support or model probability differ: three
  // aliases of one tipster must collapse to a single backer.
  const EPS = 1e-12;
  for (const a of aliased.rows) {
    const d = deduped.rows.find((r) => r.id === a.id)!;
    assert.ok(
      Math.abs(a.weighted - d.weighted) < EPS,
      `weighted support for ${a.name} differs: aliased ${a.weighted} vs deduped ${d.weighted}`,
    );
    assert.ok(
      Math.abs(a.model - d.model) < EPS,
      `model probability for ${a.name} differs: aliased ${a.model} vs deduped ${d.model}`,
    );
  }

  // FAIL if downstream confidence/stake were inflated by the duplicates.
  assert.ok(
    Math.abs(aliased.confidence - deduped.confidence) < EPS,
    `confidence differs: aliased ${aliased.confidence} vs deduped ${deduped.confidence}`,
  );
  assert.ok(
    Math.abs(aliased.stake - deduped.stake) < EPS,
    `stake differs: aliased ${aliased.stake} vs deduped ${deduped.stake}`,
  );

  // Guard against a vacuous pass: three GENUINELY distinct tipsters on the same
  // horse must add strictly MORE support than the single deduped backer. If
  // this fails, the dedup is collapsing real, separate tipsters too.
  const distinct = runScenario(
    SCENARIO_4_RUNNERS,
    SCENARIO_4_DISTINCT_TIPSTERS,
  );
  const dedupedD = deduped.rows.find((r) => r.id === 'D')!.weighted;
  const distinctD = distinct.rows.find((r) => r.id === 'D')!.weighted;
  assert.ok(
    distinctD > dedupedD + 1e-9,
    `dedup is not load-bearing: distinct support ${distinctD} not greater than deduped ${dedupedD}`,
  );
});

test('Scenario 5: a withdrawn top pick is voided and the field re-evaluated', () => {
  // Snapshot the tipster inputs to prove the void path mutates nothing.
  const tipstersBefore = JSON.stringify(SCENARIO_5_TIPSTERS);

  // --- Before the withdrawal: the engine has a clear top pick. ---
  const original = runScenario(SCENARIO_5_RUNNERS, SCENARIO_5_TIPSTERS);
  assert.ok(original.pick, 'engine should return an original pick');
  // Deterministic anchor: fail loudly if the selection logic regresses.
  assert.equal(
    original.pick.name,
    'Horse D',
    `expected original top pick "Horse D", got "${original.pick.name}"`,
  );

  const voidedId = SCENARIO_5_RUNNERS.find(
    (r) => r.name === original.pick!.name,
  )!.id;
  const voidedBackers = SCENARIO_5_TIPSTERS.filter(
    (t) => t.pick === voidedId,
  ).map((t) => t.id);
  assert.ok(
    voidedBackers.length > 0,
    'the voided runner should have had at least one backing tipster',
  );

  // --- Withdraw the top pick: remove it from the field. The tipster pool
  //     (global priors) is left intact, so the voided selections simply point
  //     at a runner no longer in the field. ---
  const reducedRunners = SCENARIO_5_RUNNERS.filter((r) => r.id !== voidedId);
  const revised = runScenario(reducedRunners, SCENARIO_5_TIPSTERS);

  // (1) The original selection is void: the engine no longer recommends it.
  assert.ok(revised.pick, 'engine should still return a pick after withdrawal');
  assert.notEqual(
    revised.pick.name,
    original.pick.name,
    'voided runner must not remain the recommendation',
  );

  // (2) The withdrawn runner is excluded from the field entirely.
  assert.equal(
    revised.rows.length,
    original.rows.length - 1,
    'field should shrink by exactly one runner',
  );
  assert.ok(
    revised.rows.every((r) => r.id !== voidedId),
    `voided runner ${voidedId} must not appear in the re-evaluated field`,
  );

  // (3) Market probabilities are renormalised over the survivors: they still
  //     sum to 1, and each survivor's share strictly increases (the withdrawn
  //     runner's market mass is redistributed).
  const EPS = 1e-9;
  const marketSum = revised.rows.reduce((s, r) => s + r.market, 0);
  assert.ok(
    Math.abs(marketSum - 1) < 1e-6,
    `survivor market probabilities should sum to 1, got ${marketSum}`,
  );
  for (const row of revised.rows) {
    const before = original.rows.find((r) => r.id === row.id)!;
    assert.ok(
      row.market > before.market + EPS,
      `market prob for ${row.name} should increase after withdrawal: ${before.market} -> ${row.market}`,
    );
  }

  // (4) A fresh recommendation is produced from the surviving field.
  assert.ok(
    reducedRunners.some((r) => r.name === revised.pick!.name),
    'new recommendation must be a surviving runner',
  );
  // Deterministic anchor for the new pick.
  assert.equal(
    revised.pick.name,
    'Horse B',
    `expected new top pick "Horse B", got "${revised.pick.name}"`,
  );

  // (5) No negative tipster update from the voided selection. The engine has no
  //     settlement write-path, so priors/weights must be untouched: every
  //     tipster's weight is identical before and after (in particular, no
  //     voided backer is penalised), and the input array is not mutated.
  for (const [id, weightBefore] of original.tipsterWeights) {
    const weightAfter = revised.tipsterWeights.get(id);
    assert.ok(
      weightAfter !== undefined &&
        Math.abs(weightAfter - weightBefore) < EPS,
      `tipster ${id} weight changed by the void: ${weightBefore} -> ${weightAfter}`,
    );
  }
  for (const backerId of voidedBackers) {
    assert.ok(
      revised.tipsterWeights.has(backerId),
      `voided backer ${backerId} should still exist in the pool (not purged/penalised)`,
    );
  }
  assert.equal(
    JSON.stringify(SCENARIO_5_TIPSTERS),
    tipstersBefore,
    'runScenario must not mutate the tipster inputs',
  );
});
