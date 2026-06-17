/**
 * Unit tests for the pure ML shadow-evaluation helpers (src/lib/mlShadowEvaluation.ts)
 * and a read-only / offline guard for the script (scripts/mlEvaluate.ts).
 *
 * No DB, no network, no secrets, no ML library: synthetic CSV + rows exercise CSV
 * parsing, the leakage check, the baseline picks, Brier / log loss / calibration,
 * deterministic strike/ROI (reusing summarizeModelPerformance), odds/confidence
 * banding, and the deterministic Markdown. Source scans prove the evaluator makes
 * no DB writes, no external API call, and trains/persists no model. The real
 * synthetic fixture is validated end-to-end. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseCsv,
  checkLeakage,
  parseRunnerRows,
  pickMarketFavourite,
  pickModelRank,
  pickHighestEv,
  buildBaselineResult,
  brierScore,
  logLoss,
  oddsBand,
  confidenceBand,
  oddsBandPerformance,
  confidenceBandPerformance,
  buildMlEvaluationReport,
  buildMlEvaluationPath,
  renderMlEvaluationMarkdown,
  detectPersistedRecommendation,
  pickPersistedRecommendation,
  NOT_PRODUCTION_RECORD_NOTE,
  PERSISTED_RECOMMENDATION_UNAVAILABLE_NOTE,
  type RunnerRow,
} from '../src/lib/mlShadowEvaluation';

const FIXTURE = 'data/exports/training-data.example.csv';

function row(over: Partial<RunnerRow> = {}): RunnerRow {
  return {
    race_id: 'r1',
    runner_id: 'a',
    race_date: '2026-06-16',
    course: 'Ascot',
    pre_off_odds: 3,
    model_prob: 0.3,
    model_rank: 2,
    ev: 0.1,
    confidence: 0.5,
    won: null,
    placed: null,
    finish_pos: null,
    is_recommendation: null,
    recommendation_rank: null,
    stake_amount: null,
    ...over,
  };
}

/* ------------------------------- CSV parsing ------------------------------ */

test('parseCsv: header + rows, quoted fields with embedded commas + doubled quotes', () => {
  const csv = 'a,b,c\n1,"x,y",3\n4,"he said ""hi""",6\n';
  const p = parseCsv(csv);
  assert.deepEqual(p.header, ['a', 'b', 'c']);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].b, 'x,y');
  assert.equal(p.rows[1].b, 'he said "hi"');
});

test('parseRunnerRows: blank cells become null (never fabricated)', () => {
  const parsed = parseCsv('race_id,runner_id,pre_off_odds,ev_pre_off,confidence,won\nr1,a,,,,\n');
  const rows = parseRunnerRows(parsed);
  assert.equal(rows[0].pre_off_odds, null);
  assert.equal(rows[0].ev, null);
  assert.equal(rows[0].confidence, null);
  assert.equal(rows[0].won, null);
});

/* ------------------------------- leakage ---------------------------------- */

test('checkLeakage: labels vs features; a clean export header PASSes', () => {
  const header = ['race_id', 'runner_id', 'pre_off_odds', 'model_rank_pre_off', 'finish_pos', 'won', 'placed', 'sp_decimal', 'bsp_decimal'];
  const c = checkLeakage(header);
  assert.equal(c.status, 'PASS');
  assert.ok(c.label_columns.includes('won'));
  assert.ok(c.feature_columns.includes('pre_off_odds'));
  assert.equal(c.feature_columns.includes('won'), false); // a label, not a feature
});

test('checkLeakage: a leakage column used as a feature is FLAGGED (FAIL)', () => {
  const c = checkLeakage(['race_id', 'pre_off_odds', 'profit_loss', 'winner', 'post_off']);
  assert.equal(c.status, 'FAIL');
  assert.deepEqual([...c.leakage_violations].sort(), ['post_off', 'profit_loss', 'winner']);
});

/* ------------------------------- baselines -------------------------------- */

test('pickMarketFavourite: lowest pre_off_odds', () => {
  const rows = [row({ runner_id: 'a', pre_off_odds: 5 }), row({ runner_id: 'b', pre_off_odds: 2 }), row({ runner_id: 'c', pre_off_odds: 8 })];
  assert.equal(pickMarketFavourite(rows)?.runner_id, 'b');
});

test('pickModelRank: model_rank_pre_off === 1', () => {
  const rows = [row({ runner_id: 'a', model_rank: 2 }), row({ runner_id: 'b', model_rank: 1 }), row({ runner_id: 'c', model_rank: 3 })];
  assert.equal(pickModelRank(rows)?.runner_id, 'b');
});

test('pickHighestEv: highest ev_pre_off', () => {
  const rows = [row({ runner_id: 'a', ev: 0.1 }), row({ runner_id: 'b', ev: 0.3 }), row({ runner_id: 'c', ev: -0.1 })];
  assert.equal(pickHighestEv(rows)?.runner_id, 'b');
});

test('buildBaselineResult: deterministic strike/ROI at flat 1-unit stakes; pending excluded', () => {
  const picks = [
    row({ won: true, pre_off_odds: 4 }), // win: +3
    row({ won: false, pre_off_odds: 3 }), // loss: -1
    row({ won: null, pre_off_odds: 5 }), // pending: excluded from settled
  ];
  const b = buildBaselineResult('x', 'X', 'desc', picks);
  assert.equal(b.races_with_pick, 3);
  assert.equal(b.settled, 2);
  assert.equal(b.winners, 1);
  assert.equal(b.strike_rate, 50);
  assert.equal(b.profit_loss, 2);
  assert.equal(b.roi, 100);
  assert.deepEqual(buildBaselineResult('x', 'X', 'desc', picks), b);
});

/* ------------------------- probability quality ---------------------------- */

test('brierScore: mean squared error; null for empty', () => {
  assert.equal(brierScore([{ p: 1, won: 1 }, { p: 0, won: 0 }]), 0);
  assert.equal(brierScore([{ p: 0.5, won: 1 }]), 0.25);
  assert.equal(brierScore([]), null);
});

test('logLoss: clamps p so 0/1 never produce -Infinity; null for empty', () => {
  const ll = logLoss([{ p: 1, won: 1 }]);
  assert.ok(ll !== null && Number.isFinite(ll) && ll >= 0);
  const ll2 = logLoss([{ p: 0, won: 1 }]); // unclamped this is +Infinity
  assert.ok(ll2 !== null && Number.isFinite(ll2));
  assert.equal(logLoss([]), null);
});

/* ----------------------------- band grouping ------------------------------ */

test('oddsBand + confidenceBand thresholds', () => {
  assert.equal(oddsBand(2.5), '<3.0');
  assert.equal(oddsBand(3.0), '3.0-8.0');
  assert.equal(oddsBand(8.0), '3.0-8.0');
  assert.equal(oddsBand(8.5), '>8.0');
  assert.equal(oddsBand(null), 'unknown');
  assert.equal(confidenceBand(0.2), 'low');
  assert.equal(confidenceBand(0.5), 'medium');
  assert.equal(confidenceBand(0.9), 'high');
  assert.equal(confidenceBand(null), 'unknown');
});

test('oddsBandPerformance: groups picks by odds band', () => {
  const bands = oddsBandPerformance([
    row({ pre_off_odds: 2, won: true }),
    row({ pre_off_odds: 5, won: false }),
    row({ pre_off_odds: 12, won: false }),
    row({ pre_off_odds: null }),
  ]);
  const byBand = Object.fromEntries(bands.map((b) => [b.band, b.picks]));
  assert.equal(byBand['<3.0'], 1);
  assert.equal(byBand['3.0-8.0'], 1);
  assert.equal(byBand['>8.0'], 1);
  assert.equal(byBand['unknown'], 1);
});

test('confidenceBandPerformance: groups picks by confidence band', () => {
  const bands = confidenceBandPerformance([row({ confidence: 0.2 }), row({ confidence: 0.5 }), row({ confidence: 0.8 }), row({ confidence: null })]);
  const byBand = Object.fromEntries(bands.map((b) => [b.band, b.picks]));
  assert.equal(byBand['low'], 1);
  assert.equal(byBand['medium'], 1);
  assert.equal(byBand['high'], 1);
  assert.equal(byBand['unknown'], 1);
});

/* --------------------------- full report + path --------------------------- */

test('buildMlEvaluationReport: evaluates the synthetic fixture; leakage PASS; baselines computed', () => {
  const report = buildMlEvaluationReport(parseCsv(readFileSync(FIXTURE, 'utf8')), FIXTURE, '2026-06-16T20:00:00.000Z');
  assert.equal(report.leakage.status, 'PASS');
  assert.equal(report.race_count, 2);
  assert.equal(report.runner_count, 6);
  assert.equal(report.settled_race_count, 2);
  const fav = report.baselines.find((b) => b.id === 'market_favourite')!;
  const model = report.baselines.find((b) => b.id === 'model_rank')!;
  const ev = report.baselines.find((b) => b.id === 'ev_highest')!;
  assert.equal(fav.strike_rate, 50); // A won, D lost
  assert.equal(model.strike_rate, 100); // A won, E won
  assert.equal(ev.strike_rate, 100); // A won, E won
  assert.equal(report.sample_too_small, true); // 2 << 100
  assert.ok(report.brier !== null);
});

test('buildMlEvaluationPath: single date+course; range; missing; multi', () => {
  assert.equal(buildMlEvaluationPath(['2026-06-16'], ['Ascot']), 'reports/ml-shadow-evaluation-2026-06-16-ascot.md');
  assert.equal(buildMlEvaluationPath(['2026-06-16', '2026-06-18'], ['Ascot']), 'reports/ml-shadow-evaluation-2026-06-16-to-2026-06-18-ascot.md');
  assert.equal(buildMlEvaluationPath(['2026-06-16'], []), 'reports/ml-shadow-evaluation-2026-06-16-all.md');
  assert.equal(buildMlEvaluationPath(['2026-06-16'], ['A', 'B']), 'reports/ml-shadow-evaluation-2026-06-16-multi.md');
});

/* ------------------------------- render ----------------------------------- */

test('renderMlEvaluationMarkdown: deterministic + no-model banner + GO/NO-GO + leakage status', () => {
  const report = buildMlEvaluationReport(parseCsv(readFileSync(FIXTURE, 'utf8')), 'x.csv', 'g');
  const md = renderMlEvaluationMarkdown(report);
  assert.equal(md, renderMlEvaluationMarkdown(report));
  assert.match(md, /no model trained/i);
  assert.match(md, /## 9\. GO \/ NO-GO/);
  assert.match(md, /NO-GO for promotion/);
  assert.match(md, /Leakage check: \*\*PASS\*\*/);
  assert.match(md, /far too small/i);
});

test('render: a missing Brier (no settled priced races) renders as em dash', () => {
  const report = buildMlEvaluationReport(parseCsv('race_id,runner_id,pre_off_odds,won\nr1,a,3,\n'), 'x', 'g');
  const md = renderMlEvaluationMarkdown(report);
  assert.match(md, /Brier score: \u2014/);
});

/* --------------- production-recommendation distinction -------------------- */

test('detectPersistedRecommendation: standard export (no rec columns) -> unavailable', () => {
  const d = detectPersistedRecommendation(['race_id', 'runner_id', 'pre_off_odds', 'model_rank_pre_off', 'ev_pre_off', 'won']);
  assert.equal(d.available, false);
  assert.deepEqual(d.columns_found, []);
  assert.equal(d.has_stake, false);
});

test('detectPersistedRecommendation: rec flag + stake columns -> available', () => {
  const d = detectPersistedRecommendation(['race_id', 'is_recommendation', 'stake_amount', 'won']);
  assert.equal(d.available, true);
  assert.ok(d.columns_found.includes('is_recommendation'));
  assert.ok(d.columns_found.includes('stake_amount'));
  assert.equal(d.has_stake, true);
});

test('pickPersistedRecommendation: recommendation_rank=1, else is_recommendation flag, else null', () => {
  assert.equal(
    pickPersistedRecommendation([row({ runner_id: 'a', recommendation_rank: 2 }), row({ runner_id: 'b', recommendation_rank: 1 })])?.runner_id,
    'b',
  );
  assert.equal(
    pickPersistedRecommendation([row({ runner_id: 'a', is_recommendation: false }), row({ runner_id: 'b', is_recommendation: true })])?.runner_id,
    'b',
  );
  assert.equal(pickPersistedRecommendation([row({ is_recommendation: null, recommendation_rank: null })]), null);
});

test('model-rank baseline is explicitly labelled "(not production recommendation)"', () => {
  const report = buildMlEvaluationReport(parseCsv(readFileSync(FIXTURE, 'utf8')), FIXTURE, 'g');
  const model = report.baselines.find((b) => b.id === 'model_rank')!;
  assert.match(model.name, /not production recommendation/i);
});

test('report distinguishes model-rank baseline from persisted/production recommendation', () => {
  const report = buildMlEvaluationReport(parseCsv(readFileSync(FIXTURE, 'utf8')), FIXTURE, 'g');
  // The standard export cannot identify persisted recommendations -> not fabricated.
  assert.equal(report.persisted_recommendation.available, false);
  assert.equal(report.persisted_recommendation.baseline, null);
  const md = renderMlEvaluationMarkdown(report);
  assert.match(md, /Model-rank baseline \(not production recommendation\)/);
  // The not-production-record note appears in BOTH the exec summary and baseline section.
  const noteCount = md.split(NOT_PRODUCTION_RECORD_NOTE).length - 1;
  assert.ok(noteCount >= 2, `expected the not-production note at least twice, saw ${noteCount}`);
  // Persisted recommendation explicitly marked unavailable (never fabricated).
  assert.ok(md.includes(PERSISTED_RECOMMENDATION_UNAVAILABLE_NOTE));
});

test('persisted recommendation baseline computes when the export carries rec + stake columns', () => {
  const csv =
    'race_id,runner_id,pre_off_odds,is_recommendation,stake_amount,won\n' +
    'r1,a,4,1,2,1\n' + // recommended, stake 2, won -> +6
    'r1,b,3,0,0,0\n' +
    'r2,c,5,1,2,0\n' + // recommended, stake 2, lost -> -2
    'r2,d,2,0,0,1\n';
  const report = buildMlEvaluationReport(parseCsv(csv), 'rec.csv', 'g');
  assert.equal(report.persisted_recommendation.available, true);
  const b = report.persisted_recommendation.baseline!;
  assert.equal(b.id, 'persisted_recommendation');
  assert.equal(b.races_with_pick, 2);
  assert.equal(b.settled, 2);
  assert.equal(b.winners, 1);
  assert.equal(b.strike_rate, 50);
  assert.equal(b.profit_loss, 4); // +6 - 2
  const md = renderMlEvaluationMarkdown(report);
  assert.match(md, /Persisted recommendation baseline/);
  assert.doesNotMatch(md, /unavailable in this export/);
});

/* --------------------- offline / no-train / no-DB guards ------------------ */

test('no DB writes / no external API: the evaluator script + module are offline', () => {
  const script = readFileSync('scripts/mlEvaluate.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(script), false);
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(script), false);
  assert.equal(/\bfetch\s*\(|createRacingApiClient|getResults|BetfairClient|axios/.test(script), false);

  const lib = readFileSync('src/lib/mlShadowEvaluation.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs/.test(lib), false);
  assert.equal(/\bfetch\s*\(|process\.env/.test(lib), false);
});

test('no ML library / no training: neither file imports an ML lib, calls a trainer, or shells out', () => {
  const both = readFileSync('src/lib/mlShadowEvaluation.ts', 'utf8') + readFileSync('scripts/mlEvaluate.ts', 'utf8');
  assert.equal(/tensorflow|onnxruntime|brain\.js|sklearn|xgboost|child_process|\.fit\s*\(|\.train\s*\(/i.test(both), false);
});
