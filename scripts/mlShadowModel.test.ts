/**
 * Tests for the OFFLINE, SHADOW-ONLY candidate ML model.
 *
 * Proves the mandatory leakage check refuses post-race/outcome feature columns
 * (so training never sees an outcome), training is fully deterministic for a
 * fixed seed, prediction yields one ranked list per race, in-sample metrics are
 * finite, the small-sample flag fires, `model_active` is always false, and the
 * lib does no I/O / network / DB / betting work.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseCsv } from '../src/lib/mlShadowEvaluation';
import {
  trainShadowModel,
  checkFeatureLeakage,
  predictProb,
  scoreRace,
  groupByRace,
  parseModel,
  serializeModel,
  isSmallSample,
  labelValue,
  SHADOW_FEATURE_COLUMNS,
} from '../src/lib/mlShadowModel';

/** A tiny, deterministic leakage-safe training CSV (2 races, won as 0/1). */
const CSV = [
  'race_id,runner_id,runner_name,course,off_time,race_name,field_size,is_handicap,pre_off_odds,market_rank_pre_off,model_prob_pre_off,model_rank_pre_off,ev_pre_off,confidence,finish_pos,won,placed,sp_decimal,bsp_decimal',
  'A,A1,Alpha,Ascot,2026-06-16T13:30:00+00:00,Race A,3,0,2.0,1,0.55,1,0.10,0.6,1,1,1,2.0,2.1',
  'A,A2,Bravo,Ascot,2026-06-16T13:30:00+00:00,Race A,3,0,4.0,2,0.30,2,0.05,0.4,3,0,1,4.0,4.2',
  'A,A3,Cosmo,Ascot,2026-06-16T13:30:00+00:00,Race A,3,0,9.0,3,0.15,3,-0.20,0.2,5,0,0,9.0,9.5',
  'B,B1,Delta,Ascot,2026-06-17T14:00:00+00:00,Race B,3,1,1.8,1,0.60,1,0.12,0.7,1,1,1,1.8,1.9',
  'B,B2,Echo,Ascot,2026-06-17T14:00:00+00:00,Race B,3,1,5.0,2,0.25,2,0.02,0.35,2,0,1,5.0,5.1',
  'B,B3,Foxtrot,Ascot,2026-06-17T14:00:00+00:00,Race B,3,1,11.0,3,0.15,3,-0.30,0.2,6,0,0,11.0,12.0',
  '',
].join('\n');

test('leakage check rejects any post-race / outcome feature column', () => {
  for (const bad of ['won', 'finish_pos', 'placed', 'bsp_decimal', 'sp_decimal']) {
    const chk = checkFeatureLeakage(['model_prob_pre_off', bad]);
    assert.equal(chk.passed, false, `${bad} should be forbidden`);
    assert.ok(chk.forbidden.includes(bad));
  }
  // The default feature set is clean.
  assert.equal(checkFeatureLeakage([...SHADOW_FEATURE_COLUMNS]).passed, true);
});

test('training REFUSES to train when a label column is requested as a feature', () => {
  const parsed = parseCsv(CSV);
  const result = trainShadowModel(parsed, { featureColumns: ['model_prob_pre_off', 'won'] });
  assert.equal(result.model, null);
  assert.equal(result.leakage.passed, false);
  assert.match(result.error ?? '', /[Ll]eakage/);
});

test('won label parses from numeric 0/1 cells (export format)', () => {
  const parsed = parseCsv(CSV);
  assert.equal(labelValue(parsed.rows[0]), 1); // Alpha won
  assert.equal(labelValue(parsed.rows[1]), 0); // Bravo lost
});

test('training is fully deterministic for a fixed seed', () => {
  const parsed = parseCsv(CSV);
  const a = trainShadowModel(parsed, { seed: 7, course: 'Ascot' }).model;
  const b = trainShadowModel(parsed, { seed: 7, course: 'Ascot' }).model;
  assert.ok(a && b);
  assert.deepEqual(a.weights, b.weights);
  assert.equal(a.bias, b.bias);
  assert.deepEqual(a.standardization, b.standardization);
});

test('model_active is always false and metadata is populated', () => {
  const parsed = parseCsv(CSV);
  const { model } = trainShadowModel(parsed, { from: '2026-06-16', to: '2026-06-17', course: 'Ascot' });
  assert.ok(model);
  assert.equal(model.model_active, false);
  assert.equal(model.label, 'won');
  assert.equal(model.race_count, 2);
  assert.equal(model.settled_race_count, 2);
  assert.ok(model.feature_columns.length > 0);
  assert.equal(model.leakage_check.passed, true);
  assert.equal(model.training_date_range.from, '2026-06-16');
});

test('prediction returns one ranked list per race (ranks 1..n, sorted desc)', () => {
  const parsed = parseCsv(CSV);
  const { model } = trainShadowModel(parsed, {});
  assert.ok(model);
  const groups = groupByRace(parsed.rows);
  assert.equal(groups.size, 2);
  for (const [, records] of groups) {
    const ranked = scoreRace(model, records);
    assert.equal(ranked.length, 3);
    assert.deepEqual(ranked.map((r) => r.ml_rank), [1, 2, 3]);
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(ranked[i - 1].ml_prob >= ranked[i].ml_prob, 'sorted by prob desc');
    }
  }
});

test('predicted probabilities are valid in [0,1]', () => {
  const parsed = parseCsv(CSV);
  const { model } = trainShadowModel(parsed, {});
  assert.ok(model);
  for (const r of parsed.rows) {
    const p = predictProb(model, r);
    assert.ok(p >= 0 && p <= 1 && Number.isFinite(p));
  }
});

test('in-sample metrics are finite and the small-sample flag fires', () => {
  const parsed = parseCsv(CSV);
  const { model } = trainShadowModel(parsed, {});
  assert.ok(model);
  assert.ok(Number.isFinite(model.evaluation.in_sample_brier ?? NaN));
  assert.ok(Number.isFinite(model.evaluation.in_sample_log_loss ?? NaN));
  assert.equal(isSmallSample(model), true); // 2 races << 100
});

test('serialise/parse round-trips and parse rejects an active model', () => {
  const parsed = parseCsv(CSV);
  const { model } = trainShadowModel(parsed, {});
  assert.ok(model);
  const round = parseModel(serializeModel(model));
  assert.ok(round);
  assert.deepEqual(round.weights, model.weights);
  // A model claiming to be active must be rejected.
  const tampered = serializeModel(model).replace('"model_active": false', '"model_active": true');
  assert.equal(parseModel(tampered), null);
  assert.equal(parseModel('{ not json'), null);
});

test('shadow model lib does no I/O / network / DB / betting work', () => {
  const src = readFileSync('src/lib/mlShadowModel.ts', 'utf8');
  assert.doesNotMatch(src, /supabaseAdmin|node:fs|readFileSync|writeFileSync|fetch\(|axios/);
  assert.doesNotMatch(src, /kellyStake|bettingEngine|placeOrder|placeBet|submitOrder/i);
  // Never claims to be production-active.
  assert.doesNotMatch(src, /model_active:\s*true/);
});
