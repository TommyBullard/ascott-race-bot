/**
 * Tests for the pre-off decision-support validation
 * (src/lib/preOffValidation.ts, scripts/preOffValidation.ts).
 *
 * The aggregator, parser, verdict, invariants and rendering are PURE, so they
 * are tested with injected resolved-race fixtures — no Supabase, no model, no
 * I/O. The verdict is an EVIDENCE-QUALITY judgement and must NEVER depend on the
 * model beating the market (asserted explicitly). Plus source scans proving the
 * CLI is strictly SELECT-only. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MIN_EV_HONESTY_SAMPLE,
  MIN_SETTLED_DECISIONS,
  aggregatePreOffValidation,
  buildPreOffValidationJsonPath,
  buildPreOffValidationMarkdownPath,
  canonicalLimitations,
  checkPreOffInvariants,
  courseSlug,
  isValidIsoDate,
  parsePreOffValidationArgs,
  renderPreOffValidationConsole,
  renderPreOffValidationMarkdown,
  type PreOffValidationReport,
  type ResolvedPreOffRace,
} from '../src/lib/preOffValidation';
import { MIN_CALIBRATION_SAMPLES } from '../src/lib/mlCalibration';

const META = { from: '2026-07-01', to: '2026-07-31', course: null, generatedAtIso: '2026-08-01T00:00:00.000Z' };
const OFF = '2026-07-15T14:00:00.000Z';
const RUN = '2026-07-15T13:55:00.000Z'; // pre-off

/* -------------------------------------------------------------------------- */
/* Argument parsing (pure; before any I/O)                                    */
/* -------------------------------------------------------------------------- */

test('1. isValidIsoDate accepts real calendar dates and rejects impossible ones', () => {
  assert.equal(isValidIsoDate('2026-07-27'), true);
  assert.equal(isValidIsoDate('2024-02-29'), true);
  assert.equal(isValidIsoDate('2026-02-29'), false);
  assert.equal(isValidIsoDate('2026-13-01'), false);
  assert.equal(isValidIsoDate('2026-7-4'), false);
  assert.equal(isValidIsoDate(''), false);
});

test('2. --from and --to are mandatory (no implicit window)', () => {
  assert.match((parsePreOffValidationArgs([]) as { error: string }).error, /missing required --from/);
  assert.match((parsePreOffValidationArgs(['--from', '2026-07-01']) as { error: string }).error, /missing required --to/);
});

test('3. malformed / impossible dates and from>to are rejected', () => {
  assert.match((parsePreOffValidationArgs(['--from', 'x', '--to', '2026-07-31']) as { error: string }).error, /invalid --from/);
  assert.match((parsePreOffValidationArgs(['--from', '2026-02-30', '--to', '2026-07-31']) as { error: string }).error, /invalid --from/);
  assert.match((parsePreOffValidationArgs(['--from', '2026-08-01', '--to', '2026-07-31']) as { error: string }).error, /later than/);
});

test('4. blank course, unknown flags and --commit are rejected', () => {
  assert.match((parsePreOffValidationArgs(['--from', '2026-07-01', '--to', '2026-07-31', '--course', '  ']) as { error: string }).error, /must not be blank/);
  assert.match((parsePreOffValidationArgs(['--from', '2026-07-01', '--to', '2026-07-31', '--force']) as { error: string }).error, /unknown flag/);
  assert.match((parsePreOffValidationArgs(['--from', '2026-07-01', '--to', '2026-07-31', '--commit']) as { error: string }).error, /READ-ONLY/);
});

test('5. a valid invocation parses all fields', () => {
  const p = parsePreOffValidationArgs(['--from', '2026-07-01', '--to', '2026-07-31', '--course', 'Galway', '--report', '--json']);
  assert.equal(p.ok, true);
  assert.deepEqual((p as { args: unknown }).args, { from: '2026-07-01', to: '2026-07-31', course: 'Galway', report: true, json: true });
});

test('6. report paths are deterministic and scope-specific', () => {
  assert.equal(buildPreOffValidationMarkdownPath('2026-07-01', '2026-07-31', null), 'reports/pre-off-validation-2026-07-01-to-2026-07-31-all-courses.md');
  assert.equal(buildPreOffValidationMarkdownPath('2026-07-01', '2026-07-31', 'Royal Ascot'), 'reports/pre-off-validation-2026-07-01-to-2026-07-31-royal-ascot.md');
  assert.equal(buildPreOffValidationJsonPath('2026-07-01', '2026-07-31', 'Galway'), 'reports/pre-off-validation-2026-07-01-to-2026-07-31-galway.json');
  assert.equal(courseSlug(null), 'all-courses');
  assert.equal(courseSlug('Down Royal'), 'down-royal');
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function race(opts: {
  id: string;
  runners: { model: number | null; market: number | null }[];
  winnerIdx: number | null;
  pickIdx: number | null;
  odds?: number | null;
  stake?: number | null;
  ev?: number | null;
  confidence?: string | null;
  course?: string;
  hasRun?: boolean;
  selectedRunTime?: string | null;
}): ResolvedPreOffRace {
  const settled = opts.winnerIdx !== null;
  const winnerId = settled ? `${opts.id}-r${opts.winnerIdx}` : null;
  const runners = opts.runners.map((r, i) => ({
    runner_id: `${opts.id}-r${i}`,
    model_prob: r.model,
    market_prob: r.market,
    finish_pos: settled ? (i === opts.winnerIdx ? 1 : 2) : null,
  }));
  const hasRun = opts.hasRun ?? true;
  return {
    race_id: opts.id,
    course: opts.course ?? 'Galway',
    off_time: OFF,
    has_pre_off_run: hasRun,
    selected_run_time: hasRun ? (opts.selectedRunTime ?? RUN) : null,
    settled,
    winner_runner_id: winnerId,
    runners: hasRun ? runners : [],
    pick:
      hasRun && opts.pickIdx !== null
        ? { runner_id: `${opts.id}-r${opts.pickIdx}`, odds: opts.odds ?? 3, stake: opts.stake ?? 1, ev: opts.ev ?? 0.1, confidence_label: opts.confidence ?? 'high' }
        : null,
  };
}

function manyRaces(n: number): ResolvedPreOffRace[] {
  return Array.from({ length: n }, (_, i) =>
    race({
      id: `g${i}`,
      runners: [{ model: 0.5, market: 0.5 }, { model: 0.3, market: 0.3 }, { model: 0.2, market: 0.2 }],
      winnerIdx: i % 3 === 0 ? 0 : 1,
      pickIdx: 0,
      confidence: i % 2 === 0 ? 'high' : 'low',
      ev: i % 4 === 0 ? 0.2 : -0.1,
      odds: i % 3 === 0 ? 2 : 6,
      course: i % 2 === 0 ? 'Galway' : 'Cork',
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Verdict semantics (the mandated correction)                                */
/* -------------------------------------------------------------------------- */

test('7. thin sample -> INSUFFICIENT_EVIDENCE, never a fabricated pass', () => {
  const r = aggregatePreOffValidation([race({ id: 'g0', runners: [{ model: 0.5, market: 0.5 }], winnerIdx: 0, pickIdx: 0 })], META);
  assert.equal(r.verdict, 'INSUFFICIENT_EVIDENCE');
  assert.equal(r.model_calibration.sufficientSample, false);
});

test('8. VERDICT CORRECTION: a model calibrating WORSE than the market still PASSES', () => {
  // model_prob mis-calibrated (0.9 everywhere), market well-calibrated. Sufficient sample, no invariant/read issues.
  const races = Array.from({ length: 120 }, (_, i) =>
    race({
      id: `g${i}`,
      runners: [{ model: 0.9, market: 0.5 }, { model: 0.9, market: 0.3 }, { model: 0.9, market: 0.2 }],
      winnerIdx: i % 2 === 0 ? 0 : 1,
      pickIdx: 0,
      confidence: 'high',
    }),
  );
  const r = aggregatePreOffValidation(races, META);
  assert.equal(r.verdict, 'PASS'); // NOT REVIEW — market comparison must not gate the verdict
  assert.equal(r.model_vs_market_calibration, 'model_worse');
  assert.equal(r.descriptive_signals.market_comparison, 'unfavourable');
  assert.equal(r.invariant_violations.length, 0);
});

test('9. VERDICT CORRECTION: negative decision ROI does not, by itself, block PASS', () => {
  // Every pick loses (pick never the winner) -> negative ROI, but evidence complete.
  const races = Array.from({ length: 120 }, (_, i) =>
    race({
      id: `g${i}`,
      runners: [{ model: 0.5, market: 0.5 }, { model: 0.3, market: 0.3 }],
      winnerIdx: 1, // winner is runner 1
      pickIdx: 0, // pick runner 0 -> always loses
      confidence: 'high',
    }),
  );
  const r = aggregatePreOffValidation(races, META);
  assert.ok(r.decision_performance.roi < 0);
  assert.equal(r.verdict, 'PASS'); // ROI sign is descriptive, not a gate
  assert.equal(r.descriptive_signals.decision_roi_sign, 'unfavourable');
});

test('10. read errors -> REVIEW (evidence incomplete), never silently zeroed', () => {
  const r = aggregatePreOffValidation(manyRaces(120), { ...META, readErrors: 2 });
  assert.equal(r.verdict, 'REVIEW');
  assert.equal(r.coverage.read_errors, 2);
});

test('11. a pre-off boundary LEAKAGE (post-off selected run) -> FAIL', () => {
  const races = manyRaces(120);
  races[0] = { ...races[0], selected_run_time: '2026-07-15T14:05:00.000Z' }; // AFTER off
  const r = aggregatePreOffValidation(races, META);
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.invariant_violations.some((v) => /LEAKAGE/.test(v)));
});

test('12. a clean, sufficient, complete range PASSES', () => {
  const r = aggregatePreOffValidation(manyRaces(120), META);
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.invariant_violations.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Coverage, pending, no-bet                                                  */
/* -------------------------------------------------------------------------- */

test('13. coverage counts pre-off runs / settled / pending / no-run', () => {
  const races = [
    race({ id: 'a', runners: [{ model: 0.6, market: 0.5 }], winnerIdx: 0, pickIdx: 0 }),
    race({ id: 'b', runners: [{ model: 0.4, market: 0.5 }], winnerIdx: null, pickIdx: 0 }),
    race({ id: 'c', runners: [], winnerIdx: 0, pickIdx: null, hasRun: false }),
  ];
  const c = aggregatePreOffValidation(races, META).coverage;
  assert.equal(c.races_in_scope, 3);
  assert.equal(c.races_with_pre_off_run, 2);
  assert.equal(c.settled_races_with_pre_off_run, 1);
  assert.equal(c.pending_races_with_pre_off_run, 1);
  assert.equal(c.races_without_pre_off_run, 1);
});

test('14. pending races never counted as losses; no-bet counted, never as loss', () => {
  const d = aggregatePreOffValidation([
    race({ id: 'a', runners: [{ model: 0.6, market: 0.5 }], winnerIdx: 0, pickIdx: 0 }),
    race({ id: 'b', runners: [{ model: 0.4, market: 0.5 }], winnerIdx: null, pickIdx: 0 }),
    race({ id: 'c', runners: [{ model: 0.6, market: 0.5 }], winnerIdx: 0, pickIdx: null }),
  ], META).decision_performance;
  assert.equal(d.settled_count, 1);
  assert.equal(d.pending_count, 1);
  assert.equal(d.losers, 0);
  assert.equal(d.no_bet_races, 1);
});

/* -------------------------------------------------------------------------- */
/* Ranking (top-1/2/3, model + market, agreement, ties)                       */
/* -------------------------------------------------------------------------- */

test('15. ranking computes top-1/2/3 for model AND market, monotonic', () => {
  const r = aggregatePreOffValidation(manyRaces(60), META).ranking;
  assert.equal(r.measured, true);
  for (const s of [r.model, r.market]) {
    assert.ok(s.top1 !== null && s.top2 !== null && s.top3 !== null);
    assert.ok((s.top2 as number) >= (s.top1 as number));
    assert.ok((s.top3 as number) >= (s.top2 as number));
  }
});

test('16. top-1 model accuracy is the winner-is-highest-model_prob rate', () => {
  // Runner 0 (model 0.5) is always top; it wins every 3rd of 60 races.
  const r = aggregatePreOffValidation(manyRaces(60), META).ranking;
  assert.equal(r.model.races, 60);
  assert.equal(r.model.top1, (20 / 60) * 100);
});

test('17. model-vs-market agreement matrix is filled (both/model/market/neither)', () => {
  const a = aggregatePreOffValidation(manyRaces(60), META).ranking.agreement;
  assert.equal(a.races, 60);
  assert.equal(a.both + a.model_only + a.market_only + a.neither, 60);
});

test('18. score ties are handled deterministically by runner id', () => {
  // Two runners with equal model_prob; winner is r1 (lexicographically larger id).
  const races = Array.from({ length: 120 }, (_, i) =>
    race({ id: `g${i}`, runners: [{ model: 0.5, market: 0.5 }, { model: 0.5, market: 0.4 }], winnerIdx: 1, pickIdx: 0 }),
  );
  const r = aggregatePreOffValidation(races, META).ranking;
  // r0 wins the tie (smaller id) so the winner r1 is always rank 2 -> top1 = 0, top2 = 100.
  assert.equal(r.model.top1, 0);
  assert.equal(r.model.top2, 100);
});

/* -------------------------------------------------------------------------- */
/* Market baseline + calibration                                              */
/* -------------------------------------------------------------------------- */

test('19. market favourite strike measured; market ROI explicitly NOT MEASURED', () => {
  const r = aggregatePreOffValidation(manyRaces(60), META).market_baseline;
  assert.equal(r.favourite_races, 60);
  assert.equal(r.favourite_wins, 20);
  assert.equal(r.roi_measured, false);
});

test('20. model + market calibration computed from stored per-runner probs', () => {
  const r = aggregatePreOffValidation(manyRaces(60), META);
  assert.equal(r.model_calibration.n, 180);
  assert.equal(r.market_baseline.calibration.n, 180);
  assert.ok(r.model_calibration.brier !== null && r.market_baseline.calibration.brier !== null);
});

/* -------------------------------------------------------------------------- */
/* Segmentation + NOT MEASURED layers                                         */
/* -------------------------------------------------------------------------- */

test('21. segments cover confidence / course / odds-band / EV; small ones stay visible', () => {
  const r = aggregatePreOffValidation(manyRaces(60), META).segments;
  assert.deepEqual(r.by_confidence.map((b) => b.label).sort(), ['HIGH', 'LOW']);
  assert.deepEqual(r.by_course.map((b) => b.label).sort(), ['Cork', 'Galway']);
  assert.ok(r.by_odds_band.some((b) => b.label === '<3.0'));
  assert.ok(r.by_ev.some((b) => b.label === 'EV_POSITIVE'));
});

test('22. handicap / field-size / country / official / each-way / drawdown are explicitly NOT MEASURED', () => {
  const r = aggregatePreOffValidation(manyRaces(60), META);
  assert.equal(r.segments.by_handicap.measured, false);
  assert.equal(r.segments.by_field_size.measured, false);
  assert.equal(r.segments.by_country.measured, false);
  assert.equal(r.official_locked_layer.measured, false);
  assert.equal(r.each_way.measured, false);
  assert.equal(r.chronological_drawdown.measured, false);
  assert.ok(r.not_measured.some((s) => /official locked/.test(s)));
  assert.ok(r.not_measured.some((s) => /market-baseline ROI/.test(s)));
});

test('23. the diagnostic layer never merges official locked figures', () => {
  const r = aggregatePreOffValidation(manyRaces(60), META);
  assert.equal(r.layer, 'diagnostic');
  assert.equal(r.official_locked_layer.measured, false);
  assert.equal(r.invariant_violations.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Invariants directly                                                        */
/* -------------------------------------------------------------------------- */

test('24. checkPreOffInvariants catches inconsistent counts and out-of-range calibration', () => {
  const good = aggregatePreOffValidation(manyRaces(120), META);
  const partial = { ...good } as unknown as Parameters<typeof checkPreOffInvariants>[0];
  assert.deepEqual(checkPreOffInvariants(partial, manyRaces(120)), []);
  // Tamper: winners exceed settled decisions.
  const bad = { ...good, decision_performance: { ...good.decision_performance, winners: good.decision_performance.settled_count + 5 } } as unknown as Parameters<typeof checkPreOffInvariants>[0];
  assert.ok(checkPreOffInvariants(bad, manyRaces(120)).some((v) => /winners.*>.*settled/.test(v)));
});

test('25. constants are the documented thresholds', () => {
  assert.equal(MIN_SETTLED_DECISIONS, 50);
  assert.equal(MIN_EV_HONESTY_SAMPLE, 30);
  assert.equal(MIN_CALIBRATION_SAMPLES, 100);
});

test('26. the report is deterministic for the same input', () => {
  const races = manyRaces(60);
  assert.equal(JSON.stringify(aggregatePreOffValidation(races, META)), JSON.stringify(aggregatePreOffValidation(races, META)));
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

test('27. rendering shows verdict, ranking, NOT MEASURED, and the non-gating statement', () => {
  const r = aggregatePreOffValidation(manyRaces(120), META);
  const con = renderPreOffValidationConsole(r).join('\n');
  const md = renderPreOffValidationMarkdown(r);
  assert.match(con, new RegExp(`Evidence-quality verdict: ${r.verdict}`));
  assert.match(con, /Descriptive signals \(NOT gating the verdict\)/);
  assert.match(md, /## Ranking/);
  assert.match(md, /Market ROI: NOT MEASURED/);
  assert.match(md, /Official locked-decision layer/);
  assert.match(md, /does NOT depend on them, on ROI, or on the model beating the market/);
  assert.match(md, /no bet was placed/i);
});

test('28. a FAIL renders the invariant violations', () => {
  const races = manyRaces(120);
  races[0] = { ...races[0], selected_run_time: '2026-07-15T15:00:00.000Z' };
  const md = renderPreOffValidationMarkdown(aggregatePreOffValidation(races, META));
  assert.match(md, /## Invariant violations \(verdict = FAIL\)/);
});

test('29. rendered output never claims winner prediction or a profit promise', () => {
  const md = renderPreOffValidationMarkdown(aggregatePreOffValidation(manyRaces(60), META));
  assert.doesNotMatch(md, /guaranteed|sure thing|profit promise|will win/i);
});

/* -------------------------------------------------------------------------- */
/* Presentation correction: diagnostic/official wording + NOT-MEASURED dedup  */
/* -------------------------------------------------------------------------- */

/** A thin fixture whose not_measured[] also carries the sample-based items. */
const THIN = [race({ id: 'g0', runners: [{ model: 0.5, market: 0.5 }], winnerIdx: 0, pickIdx: 0 })];

test('P1. Markdown heading says DIAGNOSTIC, not official', () => {
  const md = renderPreOffValidationMarkdown(aggregatePreOffValidation(manyRaces(60), META));
  assert.match(md, /## Diagnostic pre-off decision performance/);
  assert.doesNotMatch(md, /## Decision performance \(official/);
  assert.doesNotMatch(md, /official pre-off rank-1 picks/i);
});

test('P2. console never calls the diagnostic decisions official (only the locked layer is "official")', () => {
  const con = renderPreOffValidationConsole(aggregatePreOffValidation(manyRaces(60), META)).join('\n');
  for (const l of con.split('\n').filter((x) => /official/i.test(x))) {
    assert.match(l, /lock/i, `a console line mentioning "official" must be about the locked layer: ${l}`);
  }
});

test('P3. JSON layer labels are unambiguous (diagnostic; official layer separate & NOT MEASURED)', () => {
  const r = aggregatePreOffValidation(manyRaces(60), META);
  assert.equal(r.layer, 'diagnostic');
  assert.equal(r.official_locked_layer.measured, false);
  assert.ok('decision_performance' in r);
  assert.equal('official_decision_performance' in (r as unknown as Record<string, unknown>), false);
});

test('P4. official locked history is explicitly separate in the output', () => {
  const md = renderPreOffValidationMarkdown(aggregatePreOffValidation(manyRaces(60), META));
  assert.match(md, /Official locked-decision layer/);
  assert.match(md, /report:locked/);
  assert.match(md, /NOT official locked decisions/);
});

test('P5. each logical NOT MEASURED item appears EXACTLY ONCE in Markdown; distinct preserved', () => {
  const md = renderPreOffValidationMarkdown(aggregatePreOffValidation(THIN, META));
  const section = md.slice(md.indexOf('## Layers / dimensions NOT MEASURED'), md.indexOf('## Descriptive signals'));
  const once = (re: RegExp) => assert.equal((section.match(re) ?? []).length, 1, `${re} should appear once`);
  for (const re of [
    /Official locked-decision layer/,
    /\*\*Each-way\*\*/,
    /Chronological drawdown/,
    /Segmentation by handicap/,
    /Segmentation by field size/,
    /Segmentation by country/,
    /market-baseline ROI/i,
  ]) once(re);
  // The combined handicap/field-size/country duplicate string is NOT re-rendered.
  assert.doesNotMatch(section, /segmentation by handicap \/ field-size \/ country/i);
  // Distinct sample-based limitation preserved for a thin sample.
  assert.match(section, /model calibration reliability/);
  assert.match(section, /decision-quality description/);
});

test('P6. each logical NOT MEASURED item appears EXACTLY ONCE in console', () => {
  const con = renderPreOffValidationConsole(aggregatePreOffValidation(THIN, META)).join('\n');
  for (const re of [/Official locked-decision layer/, /Each-way:/, /Chronological drawdown/, /Segmentation by handicap/, /market-baseline ROI/i]) {
    assert.equal((con.match(re) ?? []).length, 1, `${re} should appear once in console`);
  }
  assert.doesNotMatch(con, /segmentation by handicap \/ field-size \/ country/i);
});

test('P7-P8. canonicalLimitations is deterministic, dedupes by logical dimension, preserves distinct', () => {
  const r = aggregatePreOffValidation(THIN, META);
  const a = canonicalLimitations(r);
  assert.deepEqual(a, canonicalLimitations(r)); // deterministic
  const labels = a.filter((x) => x.label).map((x) => x.label as string);
  assert.deepEqual([...new Set(labels)].length, labels.length); // no duplicate labels
  assert.ok(a.some((x) => /market-baseline ROI/i.test(x.detail))); // dynamic preserved
  assert.ok(a.some((x) => /model calibration reliability/.test(x.detail)));
  // Exactly one entry per logical dimension (6 typed + market ROI + 2 sample-based = 9 for a thin fixture).
  assert.equal(a.length, 9);
});

test('P9-P10. Markdown and JSON remain deterministic', () => {
  const races = manyRaces(60);
  const r1 = aggregatePreOffValidation(races, META);
  const r2 = aggregatePreOffValidation(races, META);
  assert.equal(renderPreOffValidationMarkdown(r1), renderPreOffValidationMarkdown(r2));
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

test('P11-P16. rendering does NOT mutate the object; metrics/verdict/coverage/ranking/calibration/segments unchanged', () => {
  const r = aggregatePreOffValidation(manyRaces(120), META);
  const before = JSON.stringify(r);
  renderPreOffValidationMarkdown(r);
  renderPreOffValidationConsole(r);
  assert.equal(JSON.stringify(r), before); // object untouched by rendering
  // JSON not_measured[] stays COMPLETE (still holds the pre-dedup canonical + combined strings).
  assert.ok(r.not_measured.some((s) => /official locked/.test(s)));
  assert.ok(r.not_measured.some((s) => /handicap \/ field-size \/ country/.test(s)));
  // Metrics/verdict/coverage/ranking/calibration/segments are the known values.
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.coverage.races_in_scope, 120);
  assert.equal(r.model_calibration.n, 360);
  assert.equal(r.market_baseline.calibration.n, 360);
  assert.ok(r.ranking.model.top1 !== null && r.ranking.market.top1 !== null);
  assert.deepEqual(r.segments.by_course.map((b) => b.label).sort(), ['Cork', 'Galway']);
});

/* -------------------------------------------------------------------------- */
/* Read-only boundary (source scans)                                          */
/* -------------------------------------------------------------------------- */

const LIB = () => readFileSync('src/lib/preOffValidation.ts', 'utf8');
const CLI = () => readFileSync('scripts/preOffValidation.ts', 'utf8');

test('30. the CLI never calls a production scoring function', () => {
  const cli = CLI();
  for (const fn of ['scoreRaceRunners', 'runModelForRace', 'refreshModelForMeeting', 'runModelForMeetingRaces']) {
    assert.doesNotMatch(cli, new RegExp(`${fn}\\s*\\(`), `CLI calls ${fn}`);
  }
});

test('31. the CLI issues no write/mutation to the database', () => {
  const cli = CLI();
  assert.doesNotMatch(cli, /\.insert\(|\.upsert\(|\.update\(|\.delete\(/);
  assert.doesNotMatch(cli, /\.rpc\(/);
  assert.match(cli, /\.select\(/);
});

test('32. the CLI calls no provider client and imports no scoring/settlement module', () => {
  const cli = CLI();
  assert.doesNotMatch(cli, /createRacingApiClient\(|syncOddsFromBetfair\(|syncRacecards\(|syncResults\(|settleRace\(/);
  assert.doesNotMatch(cli, /from '\.\.\/src\/lib\/(liveSync|racingApi|runModelForRace|bettingEngine)'/);
});

test('33. the pure lib performs no I/O and no database access', () => {
  const lib = LIB();
  assert.doesNotMatch(lib, /\bfetch\(|node:fs|node:child_process|supabaseAdmin|\.from\(|\.rpc\(|process\.env/);
});

test('34. no betting or order-placement functionality is introduced', () => {
  for (const src of [LIB(), CLI()]) assert.doesNotMatch(src, /placeBet|placeOrder|createOrder|placeInstruction|\/betting\/rest/i);
});

test('35. the CLI validates input BEFORE any database or filesystem access (within main)', () => {
  const cli = CLI();
  const main = cli.slice(cli.indexOf('async function main'));
  const parseAt = main.indexOf('parsePreOffValidationArgs(');
  const guardReturnAt = main.indexOf('process.exitCode = 1;');
  const dbUseAt = main.indexOf('supabaseAdmin');
  const fsWriteAt = main.indexOf('writeFileSync(');
  assert.ok(parseAt >= 0 && parseAt < guardReturnAt && guardReturnAt < dbUseAt, 'parse + fail-fast precede any DB use');
  assert.ok(parseAt < fsWriteAt, 'parse precedes any write');
});

test('36. the CLI counts read errors (never silently zeroed) and passes them to the aggregator', () => {
  const cli = CLI();
  assert.match(cli, /readErrors\s*\+=\s*1/);
  assert.match(cli, /readErrors,?\s*\n?\s*\}\)/);
});

// The report shape is exported and stable for JSON consumers.
const _typecheck: PreOffValidationReport['verdict'] = 'PASS';
void _typecheck;
