/**
 * Unit tests for the pure confidence-decomposition helpers
 * (src/lib/confidenceDiagnostics.ts) and a read-only guard for the script.
 *
 * No DB, no network, no secrets: synthetic inputs exercise each component
 * derivation (data / market / tipster / contextual / race-type / execution), the
 * weakest-link overall (which never inflates), the summary counts + repeated
 * low-confidence causes, and the deterministic Markdown. Source scans prove the
 * audit performs no DB writes and calls no external API, and that the original
 * model confidence is shown verbatim (never overwritten). Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseConfidenceAuditArgs,
  buildConfidenceAuditPath,
  detectSimilarEv,
  deriveDataConfidence,
  deriveMarketConfidence,
  deriveTipsterConfidence,
  deriveContextualConfidence,
  deriveRaceTypeConfidence,
  deriveExecutionConfidence,
  buildRaceDiagnostic,
  summarizeConfidenceAudit,
  renderConfidenceAuditMarkdown,
  type ConfidenceInputs,
  type RaceConfidenceInput,
  type ConfidenceAuditReport,
} from '../src/lib/confidenceDiagnostics';

function inputs(over: Partial<ConfidenceInputs> = {}): ConfidenceInputs {
  return {
    run_quality: 'OK',
    data_quality_flags: [],
    tipster_alignment_label: null,
    market_completeness: null,
    field_size: null,
    similar_ev: null,
    model_market_separation: null,
    pick_odds: 5,
    odds_stale: false,
    is_handicap: null,
    has_reviewed_context: false,
    ...over,
  };
}

function raceInput(over: Partial<RaceConfidenceInput> = {}): RaceConfidenceInput {
  return {
    race_id: 'r1',
    off_time: '2026-06-16T13:30:00.000Z',
    race_name: 'Race 1',
    model_pick_name: 'Pick',
    original_confidence_label: 'Low',
    inputs: inputs(),
    ...over,
  };
}

/* ------------------------------ data ------------------------------------- */

test('deriveDataConfidence: OK -> high, DEGRADED -> medium, STALE/INVALID -> low, missing -> unknown', () => {
  assert.equal(deriveDataConfidence(inputs({ run_quality: 'OK', data_quality_flags: [] })).level, 'high');
  assert.equal(deriveDataConfidence(inputs({ run_quality: 'DEGRADED' })).level, 'medium');
  assert.equal(deriveDataConfidence(inputs({ run_quality: 'STALE' })).level, 'low');
  assert.equal(deriveDataConfidence(inputs({ run_quality: 'INVALID' })).level, 'low');
  assert.equal(deriveDataConfidence(inputs({ run_quality: null })).level, 'unknown');
});

test('deriveDataConfidence: OK but MISSING_RUNNER_ODDS lowers it to medium', () => {
  const c = deriveDataConfidence(inputs({ run_quality: 'OK', data_quality_flags: ['MISSING_RUNNER_ODDS'] }));
  assert.equal(c.level, 'medium');
  assert.match(c.reason, /missing runner odds/i);
});

test('deriveDataConfidence: a critical flag forces low', () => {
  assert.equal(deriveDataConfidence(inputs({ run_quality: 'OK', data_quality_flags: ['NO_MARKET_SNAPSHOT'] })).level, 'low');
});

/* ------------------------------ market ----------------------------------- */

test('deriveMarketConfidence: low completeness or similar EV -> low; clear separation -> high; none -> unknown', () => {
  assert.equal(deriveMarketConfidence(inputs({ market_completeness: 0.5 })).level, 'low');
  assert.equal(deriveMarketConfidence(inputs({ similar_ev: true, market_completeness: 1 })).level, 'low');
  assert.equal(
    deriveMarketConfidence(inputs({ market_completeness: 1, model_market_separation: 0.1, similar_ev: false })).level,
    'high',
  );
  assert.equal(
    deriveMarketConfidence(inputs({ market_completeness: null, field_size: null, similar_ev: null, model_market_separation: null })).level,
    'unknown',
  );
});

test('detectSimilarEv: clustered EVs -> true; spread -> false; <2 finite -> false', () => {
  assert.equal(detectSimilarEv([0.019, 0.019, 0.019]), true);
  assert.equal(detectSimilarEv([0.5, 0.1, 0.02]), false);
  assert.equal(detectSimilarEv([0.019]), false);
  assert.equal(detectSimilarEv([null, null]), false);
});

/* ------------------------------ tipster ---------------------------------- */

test('deriveTipsterConfidence: ALIGNED high, PARTIALLY medium, DIVERGENT low, NO_CONSENSUS/NO_REC unknown', () => {
  assert.equal(deriveTipsterConfidence('ALIGNED').level, 'high');
  assert.equal(deriveTipsterConfidence('PARTIALLY_ALIGNED').level, 'medium');
  assert.equal(deriveTipsterConfidence('DIVERGENT').level, 'low');
  assert.equal(deriveTipsterConfidence('NO_TIPSTER_CONSENSUS').level, 'unknown');
  assert.equal(deriveTipsterConfidence('NO_RECOMMENDATION').level, 'unknown');
  assert.equal(deriveTipsterConfidence(null).level, 'unknown');
});

/* ----------------------------- contextual -------------------------------- */

test('deriveContextualConfidence: defaults to unknown (shadow only, not model-active)', () => {
  const c = deriveContextualConfidence(false);
  assert.equal(c.level, 'unknown');
  assert.match(c.reason, /not model-active/i);
});

/* ----------------------------- race type --------------------------------- */

test('deriveRaceTypeConfidence: large-field handicap low; smaller handicap medium; small non-handicap high; missing unknown', () => {
  assert.equal(deriveRaceTypeConfidence(inputs({ is_handicap: true, field_size: 20 })).level, 'low');
  assert.equal(deriveRaceTypeConfidence(inputs({ is_handicap: true, field_size: 8 })).level, 'medium');
  assert.equal(deriveRaceTypeConfidence(inputs({ is_handicap: false, field_size: 8 })).level, 'high');
  assert.equal(deriveRaceTypeConfidence(inputs({ is_handicap: false, field_size: 20 })).level, 'medium'); // large field is volatile
  assert.equal(deriveRaceTypeConfidence(inputs({ is_handicap: null, field_size: null })).level, 'unknown');
});

/* ----------------------------- execution --------------------------------- */

test('deriveExecutionConfidence: missing/stale odds -> low; fresh -> high; unknown staleness -> medium', () => {
  assert.equal(deriveExecutionConfidence(inputs({ pick_odds: null })).level, 'low');
  assert.equal(deriveExecutionConfidence(inputs({ pick_odds: 5, odds_stale: true })).level, 'low');
  assert.equal(deriveExecutionConfidence(inputs({ pick_odds: 5, odds_stale: false })).level, 'high');
  assert.equal(deriveExecutionConfidence(inputs({ pick_odds: 5, odds_stale: null })).level, 'medium');
});

/* --------------------------- per-race diagnostic ------------------------- */

test('buildRaceDiagnostic: overall is weakest-link (never inflates); unknown components warn', () => {
  const d = buildRaceDiagnostic(
    raceInput({
      inputs: inputs({ run_quality: 'OK', tipster_alignment_label: 'DIVERGENT', pick_odds: 5, odds_stale: false, is_handicap: false, field_size: 8 }),
    }),
  );
  assert.equal(d.data.level, 'high');
  assert.equal(d.tipster.level, 'low');
  assert.equal(d.overall.level, 'low'); // weakest link, cannot inflate above tipster=low
  assert.match(d.overall.reason, /weakest-link/);
  assert.ok(d.warnings.some((w) => /contextual_confidence is unknown/.test(w)));
});

test('buildRaceDiagnostic: the original confidence label is preserved verbatim (read-only)', () => {
  assert.equal(buildRaceDiagnostic(raceInput({ original_confidence_label: 'Low' })).original_confidence_label, 'Low');
  assert.equal(buildRaceDiagnostic(raceInput({ original_confidence_label: 'Medium' })).original_confidence_label, 'Medium');
});

/* ------------------------------- summary --------------------------------- */

test('summarizeConfidenceAudit: counts labels + components; surfaces repeated low causes', () => {
  const diags = [
    buildRaceDiagnostic(raceInput({ original_confidence_label: 'Low', inputs: inputs({ run_quality: 'OK', pick_odds: null }) })), // data high, execution low
    buildRaceDiagnostic(raceInput({ original_confidence_label: 'Low', inputs: inputs({ run_quality: 'STALE', pick_odds: null }) })), // data low, execution low
  ];
  const s = summarizeConfidenceAudit(diags);
  assert.equal(s.original_label_counts.low, 2);
  assert.equal(s.component_counts.execution.low, 2);
  assert.ok(s.repeated_low_causes.some((c) => c.label === 'execution' && c.count === 2));
  assert.equal(s.low_label_but_data_ok, 1); // race 1 (data high)
  assert.equal(s.low_label_data_degraded, 1); // race 2 (data low)
});

test('summarizeConfidenceAudit: original LOW with DIVERGENT / no-consensus tipsters is counted', () => {
  const diags = [
    buildRaceDiagnostic(raceInput({ original_confidence_label: 'Low', inputs: inputs({ tipster_alignment_label: 'DIVERGENT' }) })),
    buildRaceDiagnostic(raceInput({ original_confidence_label: 'Low', inputs: inputs({ tipster_alignment_label: 'NO_TIPSTER_CONSENSUS' }) })),
    buildRaceDiagnostic(raceInput({ original_confidence_label: 'High', inputs: inputs({ tipster_alignment_label: 'DIVERGENT' }) })), // not a low label
  ];
  assert.equal(summarizeConfidenceAudit(diags).low_label_tipster_divergent, 2);
});

/* ------------------------------- args/path ------------------------------- */

test('parseConfidenceAuditArgs + buildConfidenceAuditPath', () => {
  assert.equal(parseConfidenceAuditArgs(['--date', '2026-06-16', '--course', 'Ascot']).date, '2026-06-16');
  assert.equal(parseConfidenceAuditArgs(['--date', 'bad']).date, undefined);
  assert.equal(buildConfidenceAuditPath('2026-06-16', 'Ascot'), 'reports/confidence-audit-2026-06-16-ascot.md');
  assert.equal(buildConfidenceAuditPath('2026-06-16'), 'reports/confidence-audit-2026-06-16.md');
});

/* ------------------------------- render ---------------------------------- */

test('renderConfidenceAuditMarkdown: deterministic + display-only banner + all components', () => {
  const report: ConfidenceAuditReport = {
    date: '2026-06-16',
    course: 'Ascot',
    generatedAt: '2026-06-16T20:00:00.000Z',
    races: [raceInput()],
  };
  assert.equal(renderConfidenceAuditMarkdown(report), renderConfidenceAuditMarkdown(report));
  const md = renderConfidenceAuditMarkdown(report);
  assert.match(md, /# Confidence decomposition audit/);
  assert.match(md, /does not change the model/i);
  assert.match(md, /## Summary/);
  assert.match(md, /data_confidence:/);
  assert.match(md, /overall diagnostic:/);
});

test('render: the original confidence is shown verbatim, never overwritten', () => {
  const md = renderConfidenceAuditMarkdown({ date: 'd', course: null, generatedAt: 'g', races: [raceInput({ original_confidence_label: 'Medium' })] });
  assert.match(md, /Original confidence \(unchanged\): Medium/);
});

test('render: missing pick + underivable components render as em dash / unknown', () => {
  const r = raceInput({
    model_pick_name: null,
    original_confidence_label: null,
    inputs: inputs({
      run_quality: null,
      tipster_alignment_label: null,
      pick_odds: null,
      is_handicap: null,
      field_size: null,
      market_completeness: null,
      similar_ev: null,
      model_market_separation: null,
      odds_stale: null,
    }),
  });
  const md = renderConfidenceAuditMarkdown({ date: '2026-06-16', course: null, generatedAt: 'x', races: [r] });
  assert.match(md, /- Model pick: \u2014/);
  assert.match(md, /- Original confidence \(unchanged\): \u2014/);
  assert.match(md, /data_confidence: unknown/);
  assert.match(md, /contextual_confidence: unknown/);
});

/* ----------------------- read-only / no-API guards ------------------------ */

test('no DB writes: the audit script issues only reads (no insert/update/upsert/delete/rpc)', () => {
  const src = readFileSync('scripts/confidenceAudit.ts', 'utf8');
  assert.equal(/\.insert\s*\(/.test(src), false);
  assert.equal(/\.update\s*\(/.test(src), false);
  assert.equal(/\.upsert\s*\(/.test(src), false);
  assert.equal(/\.delete\s*\(/.test(src), false);
  assert.equal(/\.rpc\s*\(/.test(src), false);
});

test('no external API: the audit script calls no Racing API / Betfair / fetch', () => {
  const src = readFileSync('scripts/confidenceAudit.ts', 'utf8');
  assert.equal(/\bfetch\s*\(|createRacingApiClient|getResults|BetfairClient|axios/.test(src), false);
});

test('no DB / no network / no env: the pure module is self-contained', () => {
  const lib = readFileSync('src/lib/confidenceDiagnostics.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs/.test(lib), false);
  assert.equal(/\bfetch\s*\(|process\.env/.test(lib), false);
});
