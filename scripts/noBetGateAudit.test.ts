/**
 * Unit tests for the pure no-bet gate research helpers (src/lib/noBetGateAudit.ts)
 * and a read-only guard for the script (scripts/noBetGateAudit.ts).
 *
 * No DB, no network, no secrets: synthetic races exercise gate matching, the
 * simulation (skipped races excluded from P/L, winners/losers counted, ROI
 * recomputed via the shared `summarizeModelPerformance`), the sample-size
 * warning, the deterministic per-race gate lists, and the deterministic Markdown.
 * Source scans prove the audit performs no DB writes, calls no external API, and
 * never activates a production gate. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseGateAuditArgs,
  buildGateAuditPath,
  GATE_DEFINITIONS,
  gatesSkippingRace,
  buildGateSimulation,
  buildAllGateSimulations,
  renderGateAuditMarkdown,
  MIN_SAMPLE_FOR_PROMOTION,
  type GateRaceInput,
} from '../src/lib/noBetGateAudit';

function race(over: Partial<GateRaceInput> = {}): GateRaceInput {
  return {
    race_id: 'r1',
    off_time: '2026-06-16T13:30:00.000Z',
    race_name: 'Race 1',
    model_pick_name: 'Pick',
    confidence_label: 'Low',
    run_quality: 'OK',
    tipster_alignment_label: null,
    field_size: 8,
    similar_ev: null,
    race_type_confidence_low: null,
    has_pick: true,
    has_result: true,
    won: false,
    odds: 5,
    stake: 1,
    ev: 0.1,
    winner_name: 'Someone',
    ...over,
  };
}

function gate(id: string) {
  const g = GATE_DEFINITIONS.find((x) => x.id === id);
  if (!g) throw new Error(`unknown gate ${id}`);
  return g;
}

/* ------------------------------ gate matching ----------------------------- */

test('gate matching: LOW confidence only (unknown never skips)', () => {
  const g = gate('low_only');
  assert.equal(g.matches(race({ confidence_label: 'Low' })), true);
  assert.equal(g.matches(race({ confidence_label: 'Medium' })), false);
  assert.equal(g.matches(race({ confidence_label: null })), false);
});

test('gate matching: LOW + DIVERGENT', () => {
  const g = gate('low_divergent');
  assert.equal(g.matches(race({ confidence_label: 'Low', tipster_alignment_label: 'DIVERGENT' })), true);
  assert.equal(g.matches(race({ confidence_label: 'Low', tipster_alignment_label: 'ALIGNED' })), false);
  assert.equal(g.matches(race({ confidence_label: 'Medium', tipster_alignment_label: 'DIVERGENT' })), false);
});

test('gate matching: LOW + NO_TIPSTER_CONSENSUS', () => {
  const g = gate('low_no_consensus');
  assert.equal(g.matches(race({ confidence_label: 'Low', tipster_alignment_label: 'NO_TIPSTER_CONSENSUS' })), true);
  assert.equal(g.matches(race({ confidence_label: 'Low', tipster_alignment_label: 'DIVERGENT' })), false);
});

test('gate matching: LOW + DEGRADED', () => {
  const g = gate('low_degraded');
  assert.equal(g.matches(race({ confidence_label: 'Low', run_quality: 'DEGRADED' })), true);
  assert.equal(g.matches(race({ confidence_label: 'Low', run_quality: 'OK' })), false);
});

test('gate matching: LOW + large field / similar EV / low race-type (unknown never skips)', () => {
  assert.equal(gate('low_large_field').matches(race({ confidence_label: 'Low', field_size: 20 })), true);
  assert.equal(gate('low_large_field').matches(race({ confidence_label: 'Low', field_size: 8 })), false);
  assert.equal(gate('low_similar_ev').matches(race({ confidence_label: 'Low', similar_ev: true })), true);
  assert.equal(gate('low_similar_ev').matches(race({ confidence_label: 'Low', similar_ev: null })), false);
  assert.equal(gate('low_race_type_low').matches(race({ confidence_label: 'Low', race_type_confidence_low: true })), true);
  assert.equal(gate('low_race_type_low').matches(race({ confidence_label: 'Low', race_type_confidence_low: null })), false);
});

test('gate matching: strict caution = LOW AND (DIVERGENT OR NO_CONSENSUS OR DEGRADED)', () => {
  const g = gate('strict_caution');
  assert.equal(g.matches(race({ confidence_label: 'Low', tipster_alignment_label: 'DIVERGENT', run_quality: 'OK' })), true);
  assert.equal(g.matches(race({ confidence_label: 'Low', tipster_alignment_label: 'NO_TIPSTER_CONSENSUS', run_quality: 'OK' })), true);
  assert.equal(g.matches(race({ confidence_label: 'Low', tipster_alignment_label: 'ALIGNED', run_quality: 'DEGRADED' })), true);
  assert.equal(g.matches(race({ confidence_label: 'Low', tipster_alignment_label: 'ALIGNED', run_quality: 'OK' })), false);
  assert.equal(g.matches(race({ confidence_label: 'Medium', tipster_alignment_label: 'DIVERGENT', run_quality: 'DEGRADED' })), false);
});

/* ------------------------------- simulation ------------------------------- */

test('buildGateSimulation: skipped races excluded from simulated P/L; winners/losers counted; ROI correct', () => {
  const picks = [
    race({ race_id: 'A', confidence_label: 'Low', tipster_alignment_label: 'DIVERGENT', won: false, has_result: true, odds: 5, stake: 1 }),
    race({ race_id: 'B', confidence_label: 'High', tipster_alignment_label: 'ALIGNED', won: true, has_result: true, odds: 4, stake: 1 }),
  ];
  const sim = buildGateSimulation(gate('low_divergent'), picks);
  assert.equal(sim.races_skipped, 1);
  assert.equal(sim.races_kept, 1);
  assert.equal(sim.losers_skipped, 1);
  assert.equal(sim.winners_skipped, 0);
  assert.equal(sim.winners_kept, 1);
  assert.equal(sim.original_pl, 2); // A loss(-1) + B win(3)
  assert.equal(sim.simulated_pl, 3); // B only
  assert.equal(sim.pl_delta, 1);
  assert.equal(sim.original_staked, 2);
  assert.equal(sim.remaining_staked, 1);
  assert.equal(sim.original_roi, 100);
  assert.equal(sim.simulated_roi, 300);
  assert.equal(sim.verdict, 'improved');
});

test('buildGateSimulation: a skipped winner is counted and removed from P/L (can worsen the sample)', () => {
  const picks = [
    race({ race_id: 'A', confidence_label: 'Low', tipster_alignment_label: 'DIVERGENT', won: true, has_result: true, odds: 5, stake: 1 }),
    race({ race_id: 'B', confidence_label: 'High', won: false, has_result: true, odds: 3, stake: 1 }),
  ];
  const sim = buildGateSimulation(gate('low_divergent'), picks);
  assert.equal(sim.winners_skipped, 1);
  assert.equal(sim.original_pl, 3); // A win(4) + B loss(-1)
  assert.equal(sim.simulated_pl, -1); // B only
  assert.equal(sim.verdict, 'worsened');
});

test('no-bet races are excluded from simulation and from gate skip lists', () => {
  const noBet = race({ race_id: 'C', has_pick: false, confidence_label: null, won: false, has_result: false, odds: null, stake: null });
  assert.deepEqual(gatesSkippingRace(noBet), []);
  const sims = buildAllGateSimulations([noBet]);
  assert.equal(sims[0].races_skipped, 0);
  assert.equal(sims[0].races_kept, 0);
  assert.equal(sims[0].original_pl, 0);
});

test('sample_too_small: flagged when settled bets are below the promotion floor', () => {
  const sim = buildGateSimulation(gate('low_only'), [race({ has_result: true })]);
  assert.equal(sim.sample_too_small, true); // 1 << 100
  assert.ok(MIN_SAMPLE_FOR_PROMOTION >= 100);
});

test('gatesSkippingRace: deterministic and in GATE_DEFINITIONS order', () => {
  const r = race({
    confidence_label: 'Low',
    tipster_alignment_label: 'DIVERGENT',
    run_quality: 'DEGRADED',
    field_size: 20,
    similar_ev: true,
    race_type_confidence_low: true,
  });
  const ids = gatesSkippingRace(r);
  assert.deepEqual(gatesSkippingRace(r), ids); // stable
  assert.equal(ids[0], 'low_only');
  assert.ok(ids.includes('strict_caution'));
  const orderIndex = ids.map((id) => GATE_DEFINITIONS.findIndex((g) => g.id === id));
  assert.deepEqual(orderIndex, [...orderIndex].sort((a, b) => a - b));
});

test('buildAllGateSimulations: one result per gate, in definition order', () => {
  const sims = buildAllGateSimulations([race()]);
  assert.equal(sims.length, GATE_DEFINITIONS.length);
  assert.deepEqual(sims.map((s) => s.gate_id), GATE_DEFINITIONS.map((g) => g.id));
});

/* ------------------------------- args/path -------------------------------- */

test('parseGateAuditArgs + buildGateAuditPath', () => {
  assert.equal(parseGateAuditArgs(['--date', '2026-06-16', '--course', 'Ascot']).date, '2026-06-16');
  assert.equal(parseGateAuditArgs(['--date', 'bad']).date, undefined);
  assert.equal(buildGateAuditPath('2026-06-16', 'Ascot'), 'reports/no-bet-gate-audit-2026-06-16-ascot.md');
  assert.equal(buildGateAuditPath('2026-06-16'), 'reports/no-bet-gate-audit-2026-06-16.md');
});

/* ------------------------------- render ----------------------------------- */

test('renderGateAuditMarkdown: deterministic + research-only caveats + all gates', () => {
  const report = { date: '2026-06-16', course: 'Ascot', generatedAt: 'g', races: [race()] };
  assert.equal(renderGateAuditMarkdown(report), renderGateAuditMarkdown(report));
  const md = renderGateAuditMarkdown(report);
  assert.match(md, /# No-bet gate research audit/);
  assert.match(md, /too small to approve any gate/i);
  assert.match(md, /out-of-sample/i);
  assert.match(md, /not betting advice/i);
  assert.match(md, /### LOW confidence only/);
  assert.match(md, /## Per-race detail/);
});

test('render: missing values render as em dash; no-bet outcome shown', () => {
  const r = race({
    model_pick_name: null,
    winner_name: null,
    confidence_label: null,
    run_quality: null,
    tipster_alignment_label: null,
    field_size: null,
    has_pick: false,
    has_result: false,
    stake: null,
    odds: null,
  });
  const md = renderGateAuditMarkdown({ date: 'd', course: null, generatedAt: 'g', races: [r] });
  assert.match(md, /No bet/);
  assert.match(md, /\u2014/);
});

/* ----------------------- read-only / no-API / no-activation guards -------- */

test('no production gate activation: neither file imports the live model / suppression', () => {
  const lib = readFileSync('src/lib/noBetGateAudit.ts', 'utf8');
  assert.equal(/runModelForRace|applyStakeSuppression|kellyStake|determineModelAdjustments/.test(lib), false);
  const script = readFileSync('scripts/noBetGateAudit.ts', 'utf8');
  assert.equal(/runModelForRace|applyStakeSuppression|kellyStake/.test(script), false);
});

test('no DB writes: the audit script issues only reads (no insert/update/upsert/delete/rpc)', () => {
  const src = readFileSync('scripts/noBetGateAudit.ts', 'utf8');
  assert.equal(/\.insert\s*\(/.test(src), false);
  assert.equal(/\.update\s*\(/.test(src), false);
  assert.equal(/\.upsert\s*\(/.test(src), false);
  assert.equal(/\.delete\s*\(/.test(src), false);
  assert.equal(/\.rpc\s*\(/.test(src), false);
});

test('no external API: the audit script calls no Racing API / Betfair / fetch', () => {
  const src = readFileSync('scripts/noBetGateAudit.ts', 'utf8');
  assert.equal(/\bfetch\s*\(|createRacingApiClient|getResults|BetfairClient|axios/.test(src), false);
});

test('no DB / no network / no env: the pure module is self-contained', () => {
  const lib = readFileSync('src/lib/noBetGateAudit.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs/.test(lib), false);
  assert.equal(/\bfetch\s*\(|process\.env/.test(lib), false);
});
