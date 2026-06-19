/**
 * Tests for the OFFLINE, SHADOW-ONLY comparison layer + the production-path
 * separation guarantee.
 *
 * Proves the agreement helper classifies every model/market/ML combination, the
 * per-race comparison + warnings + persisted picks report are built correctly,
 * the report is always `model_active:false`, the dashboard panel shows the
 * regular pick AND the ML shadow pick side by side, and — critically — the
 * PRODUCTION recommendation/model/staking code never imports or reads the ML
 * shadow modules, changes no EV/staking, and places no bet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseCsv } from '../src/lib/mlShadowEvaluation';
import { trainShadowModel } from '../src/lib/mlShadowModel';
import { buildMlAgreement, ML_SHADOW_LABELS } from '../src/lib/mlAgreement';
import {
  buildShadowComparison,
  buildShadowWarnings,
  buildMlShadowPicksReport,
  parseMlShadowPicksReport,
  renderShadowComparisonMarkdown,
  buildMlShadowPicksPath,
  buildMlShadowComparisonPath,
} from '../src/lib/mlShadowComparison';

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

function trainedModel() {
  const parsed = parseCsv(CSV);
  const { model } = trainShadowModel(parsed, { from: '2026-06-16', to: '2026-06-17', course: 'Ascot' });
  if (!model) throw new Error('model should train');
  return model;
}

test('agreement: all three agree', () => {
  const a = buildMlAgreement('X', 'X', 'X');
  assert.equal(a.all_three_agree, true);
  assert.equal(a.all_three_disagree, false);
  assert.equal(a.badge, 'all_agree');
});

test('agreement: ML agrees with regular only', () => {
  const a = buildMlAgreement('X', 'Y', 'X');
  assert.equal(a.ml_agrees_with_regular_pick, true);
  assert.equal(a.ml_agrees_with_market_favourite, false);
  assert.equal(a.badge, 'ml_agrees_regular');
});

test('agreement: ML agrees with market favourite only', () => {
  const a = buildMlAgreement('X', 'Y', 'Y');
  assert.equal(a.ml_agrees_with_market_favourite, true);
  assert.equal(a.badge, 'ml_agrees_market');
});

test('agreement: ML differs from both (all three disagree)', () => {
  const a = buildMlAgreement('X', 'Y', 'Z');
  assert.equal(a.all_three_disagree, true);
  assert.equal(a.badge, 'ml_differs_from_both');
});

test('agreement: regular==market but ML differs -> not all-disagree', () => {
  const a = buildMlAgreement('X', 'X', 'Z');
  assert.equal(a.regular_agrees_with_market_favourite, true);
  assert.equal(a.all_three_disagree, false);
  assert.equal(a.badge, 'ml_differs_from_both');
});

test('agreement: unknown ML pick yields the unknown badge', () => {
  const a = buildMlAgreement('X', 'Y', null);
  assert.equal(a.badge, 'unknown');
  assert.equal(a.ml_agrees_with_regular_pick, false);
});

test('per-race comparison derives regular pick, market favourite, and ML pick', () => {
  const model = trainedModel();
  const comps = buildShadowComparison(model, parseCsv(CSV));
  assert.equal(comps.length, 2);
  const a = comps.find((c) => c.race_id === 'A')!;
  assert.equal(a.regular_model_pick_name, 'Alpha'); // model_rank_pre_off == 1
  assert.equal(a.market_favourite_name, 'Alpha'); // market_rank_pre_off == 1
  assert.ok(a.ml_pick);
  assert.equal(a.ranked.length, 3);
});

test('warnings: small sample fires; data-differs fires on a different course', () => {
  const model = trainedModel();
  const same = buildShadowWarnings(model, 'Ascot');
  assert.equal(same.small_sample, true);
  assert.equal(same.data_differs, false);
  const diff = buildShadowWarnings(model, 'Newmarket');
  assert.equal(diff.data_differs, true);
  assert.match(diff.data_differs_text ?? '', /Newmarket/);
});

test('persisted picks report is always model_active:false and round-trips', () => {
  const model = trainedModel();
  const report = buildMlShadowPicksReport(model, parseCsv(CSV), '2026-06-19', 'Ascot', '2026-06-19T00:00:00Z');
  assert.equal(report.model_active, false);
  assert.equal(report.races.length, 2);
  assert.match(report.disclaimer, /not model-active/i);
  const round = parseMlShadowPicksReport(JSON.stringify(report));
  assert.ok(round);
  assert.equal(round.races.length, 2);
  // A report claiming to be active must be rejected.
  assert.equal(parseMlShadowPicksReport(JSON.stringify({ ...report, model_active: true })), null);
});

test('markdown render shows the side-by-side table + the shadow labels', () => {
  const model = trainedModel();
  const report = buildMlShadowPicksReport(model, parseCsv(CSV), '2026-06-19', 'Ascot', '2026-06-19T00:00:00Z');
  const md = renderShadowComparisonMarkdown(report);
  assert.match(md, /Regular model pick/);
  assert.match(md, /ML shadow pick/);
  assert.match(md, /Market favourite/);
  assert.match(md, /not model-active/i);
});

test('deterministic report paths', () => {
  assert.equal(buildMlShadowPicksPath('2026-06-19', 'Ascot'), 'reports/ml-shadow-picks-2026-06-19-ascot.json');
  assert.equal(buildMlShadowComparisonPath('2026-06-19', 'Ascot'), 'reports/ml-shadow-comparison-2026-06-19-ascot.md');
  assert.equal(buildMlShadowPicksPath('2026-06-19', null), 'reports/ml-shadow-picks-2026-06-19.json');
});

/* ---- production-path separation + safety scans ---------------------------- */

const PRODUCTION_FILES = [
  'src/app/api/recommendations/route.ts',
  'src/lib/raceData.ts',
  'src/lib/runModelForRace.ts',
  'src/lib/bettingEngine.ts',
  'src/lib/modelProbabilities.ts',
  'src/app/api/run-model/route.ts',
];

test('PRODUCTION recommendation/model/staking code never imports ML shadow modules', () => {
  const ML_IMPORT = /mlShadow|mlAgreement|MlShadowComparison|shadow-comparison|predictShadow|trainShadowModel/;
  for (const file of PRODUCTION_FILES) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, ML_IMPORT, `${file} must not reference ML shadow modules`);
  }
});

test('ML shadow libs + CLIs change no staking/EV and place no bet', () => {
  const files = [
    'src/lib/mlShadowModel.ts',
    'src/lib/mlShadowComparison.ts',
    'src/lib/mlAgreement.ts',
    'scripts/trainShadowModel.ts',
    'scripts/predictShadow.ts',
    'scripts/compareShadow.ts',
    'src/app/api/ml/shadow-comparison/route.ts',
  ];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /placeOrder|placeBet|submitOrder|sendOrder/i, `${file} placement`);
    assert.doesNotMatch(src, /kellyStake|runModelForRace|modelProbabilities|calculateEV|bettingEngine/, `${file} engine`);
  }
});

test('shadow endpoint is read-only and never model-active', () => {
  const route = readFileSync('src/app/api/ml/shadow-comparison/route.ts', 'utf8');
  assert.doesNotMatch(route, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  assert.match(route, /model_active: false/);
});

test('dashboard panel shows the regular pick AND the ML shadow pick + labels', () => {
  const panel = readFileSync('src/components/MlShadowComparisonPanel.tsx', 'utf8');
  assert.match(panel, /Regular model pick/);
  assert.match(panel, /ML shadow pick/);
  assert.match(panel, /Market favourite/);
  // The three mandatory shadow labels are present via the shared constant.
  assert.equal(ML_SHADOW_LABELS.notModelActive, 'ML shadow pick — not model-active');
  assert.equal(ML_SHADOW_LABELS.researchOnly, 'Research only');
  assert.equal(ML_SHADOW_LABELS.noEffect, 'Does not affect staking or recommendations');
  // The page renders the panel.
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.match(page, /MlShadowComparisonPanel/);
});
