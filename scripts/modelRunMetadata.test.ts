/**
 * Unit tests for the pure model-run metadata builder (src/lib/modelRunMetadata.ts).
 *
 * No DB or network: these assert the audit/versioning defaults and the
 * input-mode / data-quality-flag derivation, which is the only new behaviour
 * Batch B adds. `runModelForRace` simply writes this helper's output, so testing
 * the helper covers the metadata contract without a live service-role database.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildModelRunMetadata,
  DATA_QUALITY_FLAG,
  DEFAULT_MODEL_VERSION,
  DEFAULT_PROBABILITY_ENGINE_VERSION,
  DEFAULT_STAKING_ENGINE_VERSION,
} from '../src/lib/modelRunMetadata';

test('metadata defaults/constants exist and match the migration defaults', () => {
  assert.equal(DEFAULT_MODEL_VERSION, 'market-v1');
  assert.equal(DEFAULT_PROBABILITY_ENGINE_VERSION, 'market_implied_v1');
  assert.equal(DEFAULT_STAKING_ENGINE_VERSION, 'fractional_kelly_0_2_v1');
  assert.equal(DATA_QUALITY_FLAG.NO_TIPSTER_SELECTIONS, 'NO_TIPSTER_SELECTIONS');

  // A run with usable tipster support carries the default version tags.
  const meta = buildModelRunMetadata({ hasUsableTipsterSelections: true });
  assert.equal(meta.model_version, 'market-v1');
  assert.equal(meta.probability_engine_version, 'market_implied_v1');
  assert.equal(meta.staking_engine_version, 'fractional_kelly_0_2_v1');
  assert.deepEqual(meta.config_json, {});
});

test('missing tipster selections -> input_mode = market_only', () => {
  const meta = buildModelRunMetadata({ hasUsableTipsterSelections: false });
  assert.equal(meta.input_mode, 'market_only');
});

test("missing tipster selections -> data_quality_flags includes 'NO_TIPSTER_SELECTIONS'", () => {
  const meta = buildModelRunMetadata({ hasUsableTipsterSelections: false });
  assert.deepEqual(meta.data_quality_flags, ['NO_TIPSTER_SELECTIONS']);
});

test('usable tipster selections -> input_mode = market_plus_tipsters, no flags', () => {
  const meta = buildModelRunMetadata({ hasUsableTipsterSelections: true });
  assert.equal(meta.input_mode, 'market_plus_tipsters');
  assert.deepEqual(meta.data_quality_flags, []);
});

test('overrides are honoured; config_json defaults to {} and can be supplied', () => {
  const meta = buildModelRunMetadata({
    hasUsableTipsterSelections: true,
    modelVersion: 'experimental-v2',
    probabilityEngineVersion: 'logistic_v1',
    stakingEngineVersion: 'flat_stake_v1',
    config: { bankroll: 500 },
  });
  assert.equal(meta.model_version, 'experimental-v2');
  assert.equal(meta.probability_engine_version, 'logistic_v1');
  assert.equal(meta.staking_engine_version, 'flat_stake_v1');
  assert.deepEqual(meta.config_json, { bankroll: 500 });
});
