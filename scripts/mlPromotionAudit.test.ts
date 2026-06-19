/**
 * Tests for the OFFLINE ML promotion audit.
 *
 * Proves: the verdict DEFAULTS TO NO-GO (small sample / no edge), the readiness
 * gate only flips to a ramp candidate when every hard gate passes, segment and
 * feature-hint maths are deterministic, and the CLI + lib are offline + read-
 * only (no DB, no network, no ML library, no model/staking/betting imports).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseCsv,
  parseAuditRows,
  groupAuditByRace,
  pickModel,
  pickFavourite,
  buildBaselineStats,
  noBetGateProxy,
  featureImportanceHints,
  buildReadiness,
  buildMlPromotionAudit,
  renderMlPromotionAuditMarkdown,
  buildPromotionAuditPath,
  type BaselineStats,
} from '../src/lib/mlPromotionAudit';

// Two synthetic races. Model agrees with market in R1; in R2 the model pick (E)
// differs from the favourite (D) and the model pick wins — so the model "beats"
// the market on this tiny sample, which must STILL be NO-GO (sample < 100).
const HEADER =
  'race_id,runner_id,race_date,course,pre_off_odds,market_rank_pre_off,model_prob_pre_off,model_rank_pre_off,ev_pre_off,confidence,data_quality,tipster_alignment,tipster_support_share,finish_pos,won,placed';
const ROWS = [
  'R1,A,2026-06-16,Ascot,2.0,1,0.5,1,0.1,0.2,OK,NO_TIPSTER_CONSENSUS,0,1,1,1',
  'R1,B,2026-06-16,Ascot,4.0,2,0.3,2,0.05,0.5,OK,NO_TIPSTER_CONSENSUS,0,2,0,1',
  'R1,C,2026-06-16,Ascot,8.0,3,0.2,3,-0.2,0.2,DEGRADED,NO_TIPSTER_CONSENSUS,0,3,0,0',
  'R2,D,2026-06-17,Ascot,3.0,1,0.30,2,0.0,0.5,OK,DIVERGENT,0.5,5,0,0',
  'R2,E,2026-06-17,Ascot,5.0,2,0.45,1,0.2,0.8,DEGRADED,DIVERGENT,0.5,1,1,1',
  'R2,F,2026-06-17,Ascot,10.0,3,0.25,3,-0.1,0.1,DEGRADED,DIVERGENT,0,4,0,1',
];
const CSV = [HEADER, ...ROWS].join('\n') + '\n';

function audit() {
  return buildMlPromotionAudit(parseCsv(CSV), 'test.csv', '2026-06-19T00:00:00Z');
}

test('parse + picks: model_rank=1 and market_rank=1 are selected per race', () => {
  const rows = parseAuditRows(parseCsv(CSV));
  assert.equal(rows.length, 6);
  const races = groupAuditByRace(rows);
  assert.equal(pickModel(races.get('R1')!)!.runner_id, 'A');
  assert.equal(pickModel(races.get('R2')!)!.runner_id, 'E'); // model pick differs from fav
  assert.equal(pickFavourite(races.get('R2')!)!.runner_id, 'D');
});

test('baselines: win + place/top-4 + ROI are computed; model differs from favourite', () => {
  const a = audit();
  const model = a.baselines.find((b) => b.id === 'model_rank')!;
  const fav = a.baselines.find((b) => b.id === 'market_favourite')!;

  // Model picks A + E (both won): 100% strike / top-4 / place; ROI = (1 + 4) / 2 = 250%.
  assert.equal(model.winners, 2);
  assert.equal(model.strike_rate, 100);
  assert.equal(model.top4_rate, 100);
  assert.equal(model.place_rate, 100);
  assert.equal(Math.round(model.roi), 250);

  // Favourite picks A + D (one won): 50% strike, ROI 0%.
  assert.equal(fav.winners, 1);
  assert.equal(fav.strike_rate, 50);
  assert.equal(Math.round(fav.roi), 0);
});

test('verdict DEFAULTS to NO-GO on a tiny sample even when the model "beats" the market', () => {
  const a = audit();
  assert.equal(a.verdict, 'NO-GO (remain shadow)');
  assert.equal(a.sample_too_small, true);
  assert.ok(a.readiness_score >= 0 && a.readiness_score < 70);
  assert.ok(a.gate_reasons.some((r) => /Sample too small/i.test(r)));
});

test('segments: confidence / data-quality / tipster-consensus / no-bet-gate are split', () => {
  const a = audit();
  // Model picks A (conf 0.2 low, OK, NO_TIPSTER_CONSENSUS) and E (conf 0.8 high, DEGRADED, DIVERGENT).
  assert.deepEqual(a.confidence_segments.map((s) => s.segment), ['low', 'high']);
  assert.deepEqual(a.data_quality_segments.map((s) => s.segment), ['OK', 'DEGRADED']);
  assert.deepEqual(
    a.tipster_consensus_segments.map((s) => s.segment).sort(),
    ['DIVERGENT', 'NO_TIPSTER_CONSENSUS'],
  );
  // Both model picks have ev > 0 → both gate-pass.
  assert.equal(a.no_bet_gate_segments.length, 1);
  assert.match(a.no_bet_gate_segments[0].segment, /gate-pass/);
  assert.equal(a.no_bet_gate_segments[0].picks, 2);
});

test('no-bet-gate proxy: ev > 0 passes, ev <= 0 / unknown blocks', () => {
  const row = (ev: number | null) => ({ ev }) as Parameters<typeof noBetGateProxy>[0];
  assert.match(noBetGateProxy(row(0.2)), /gate-pass/);
  assert.match(noBetGateProxy(row(0)), /gate-block/);
  assert.match(noBetGateProxy(row(-0.1)), /gate-block/);
  assert.match(noBetGateProxy(row(null)), /gate-block/);
});

test('feature hints: deterministic association (model_prob higher for winners)', () => {
  const a = audit();
  const mp = a.feature_hints.find((h) => h.feature === 'model_prob_pre_off')!;
  assert.ok(mp.separation !== null && mp.separation > 0); // winners average a higher model_prob
  assert.equal(mp.top_pick_strike, 100); // the top model_prob runner won both races
  // It is an association hint only — never a trained importance.
  assert.ok(a.feature_hints.length >= 3);
});

test('readiness: NO-GO when sample small or no edge', () => {
  const base = (over: Partial<BaselineStats>): BaselineStats => ({
    id: 'x', name: 'x', races_with_pick: 21, settled: 21, winners: 8,
    strike_rate: 38, top4_rate: 60, place_rate: 55, roi: 50, profit_loss: 8, ...over,
  });
  const r = buildReadiness({
    settledRaces: 21,
    leakagePass: true,
    brier: 0.05,
    model: base({ strike_rate: 38, roi: 50, top4_rate: 60 }),
    favourite: base({ strike_rate: 38, roi: 50, top4_rate: 60 }), // identical → no edge
  });
  assert.equal(r.verdict, 'NO-GO (remain shadow)');
  assert.ok(r.score < 70);
  assert.ok(r.gate_reasons.length > 0);
});

test('readiness: ramp candidate ONLY when every hard gate passes (large sample + edge)', () => {
  const base = (over: Partial<BaselineStats>): BaselineStats => ({
    id: 'x', name: 'x', races_with_pick: 120, settled: 120, winners: 50,
    strike_rate: 40, top4_rate: 60, place_rate: 55, roi: 10, profit_loss: 12, ...over,
  });
  const r = buildReadiness({
    settledRaces: 120, // clears the 100-race minimum
    leakagePass: true,
    brier: 0.05,
    model: base({ strike_rate: 45, roi: 20, top4_rate: 70 }), // strictly beats market on all three
    favourite: base({ strike_rate: 40, roi: 10, top4_rate: 60 }),
  });
  assert.equal(r.verdict, 'RAMP CANDIDATE (still gated)');
  assert.ok(r.score >= 70);
  assert.equal(r.gate_reasons.length, 0);
});

test('render: deterministic markdown with verdict, readiness, segments, hints', () => {
  const md = renderMlPromotionAuditMarkdown(audit());
  assert.match(md, /# ML promotion audit/);
  assert.match(md, /## Verdict/);
  assert.match(md, /NO-GO \(remain shadow\)/);
  assert.match(md, /ML readiness score/);
  assert.match(md, /No-bet-gate performance/);
  assert.match(md, /Feature-importance hints/);
  assert.match(md, /Persisted production recommendation: \*\*unavailable\*\*/);
  // Determinism: same input → same output.
  assert.equal(md, renderMlPromotionAuditMarkdown(audit()));
});

test('path builder: reports/ml-promotion-audit-<range>-<course>.md', () => {
  assert.equal(
    buildPromotionAuditPath(['2026-06-16', '2026-06-18'], ['Ascot']),
    'reports/ml-promotion-audit-2026-06-16-to-2026-06-18-ascot.md',
  );
});

/* -------------------------------------------------------------------------- */
/* Source scans — offline + read-only + no model/staking/betting              */
/* -------------------------------------------------------------------------- */

test('lib is offline + read-only: no DB / network / ML lib / engine imports', () => {
  const src = readFileSync('src/lib/mlPromotionAudit.ts', 'utf8');
  assert.doesNotMatch(src, /supabaseAdmin|from '\.\/supabaseAdmin'/);
  assert.doesNotMatch(src, /fetch\(|api\.openai\.com|https?:\/\//);
  assert.doesNotMatch(src, /@tensorflow|onnxruntime|brain\.js|require\(/);
  assert.doesNotMatch(src, /bettingEngine|modelProbabilities|runModelForRace|kellyStake|scoreRaceRunners/);
  assert.doesNotMatch(src, /placeOrder|placeBet|submitOrder/);
  assert.match(src, /NO-GO/); // verdict defaults to NO-GO
});

test('CLI is offline + read-only: only local file I/O, no DB / network / model run', () => {
  const src = readFileSync('scripts/mlPromotionAudit.ts', 'utf8');
  assert.doesNotMatch(src, /supabaseAdmin|fetch\(|api\.openai\.com/);
  assert.doesNotMatch(src, /runModelForRace|bettingEngine|kellyStake|placeOrder|placeBet/);
  assert.doesNotMatch(src, /--commit|--live/); // no write/commit/live flags at all
  assert.match(src, /readFileSync/); // reads a local CSV
  assert.match(src, /writeFileSync/); // writes only a local Markdown report
});
