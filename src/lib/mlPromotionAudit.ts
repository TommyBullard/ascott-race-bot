/**
 * Pure helpers for the OFFLINE ML PROMOTION AUDIT (scripts/mlPromotionAudit.ts).
 *
 * This is the "should any ML / shadow model influence live recommendations yet?"
 * auditor. It reads an exported `export:training-data` CSV and produces a
 * deterministic, leakage-checked promotion verdict: per-baseline win + place /
 * top-4 rates, segment performance (confidence, data quality, tipster
 * consensus, no-bet gate), a calibration summary, deterministic feature-
 * importance HINTS, a 0-100 readiness score, and a GO / NO-GO recommendation.
 *
 * HARD INVARIANTS (enforced by construction + tests):
 *   - TRAINS NO MODEL, persists nothing, activates no ML, changes no live
 *     recommendation / probability / EV / stake / ranking, adds no betting.
 *   - DEFAULTS TO NO-GO. The verdict can only be a (cautious) ramp candidate
 *     when the settled sample clears {@link MIN_SAMPLE_RACES} AND the model
 *     strictly beats the market baseline AND calibration holds — otherwise it is
 *     NO-GO / remain shadow. Three days can never clear the gate.
 *   - NEVER FABRICATES. Missing values are null and render as an em dash; absent
 *     baselines (e.g. persisted recommendation) are reported unavailable.
 *
 * It reuses the tested pure helpers in {@link ./mlShadowEvaluation} for CSV
 * parsing, the leakage check, and the market-implied calibration maths, so the
 * calibration numbers match the existing shadow-evaluation report exactly.
 */

import {
  parseCsv,
  parseRunnerRows,
  groupByRace,
  marketImpliedPredictions,
  brierScore,
  logLoss,
  calibrationBuckets,
  checkLeakage,
  MIN_SAMPLE_RACES,
  type ParsedCsv,
  type CalibrationBucket,
  type LeakageCheck,
} from './mlShadowEvaluation';
import { summarizeModelPerformance, type RecommendationOutcome } from './modelPerformance';

export { parseCsv, MIN_SAMPLE_RACES };

const DASH = '\u2014';

/** Readiness score (0-100) at or above which a (cautious) ramp could be argued. */
export const RAMP_READINESS_THRESHOLD = 70;

/* -------------------------------------------------------------------------- */
/* Typed rows                                                                 */
/* -------------------------------------------------------------------------- */

/** A typed audit row (numeric coercion; missing -> null, never fabricated). */
export interface AuditRow {
  race_id: string;
  runner_id: string;
  race_date: string | null;
  course: string | null;
  odds: number | null;
  market_rank: number | null;
  model_prob: number | null;
  model_rank: number | null;
  ev: number | null;
  confidence: number | null;
  data_quality: string | null;
  tipster_alignment: string | null;
  tipster_support_share: number | null;
  won: boolean | null;
  placed: boolean | null;
  finish_pos: number | null;
}

function numOrNull(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function bool01OrNull(value: string | undefined): boolean | null {
  if (value === undefined || value.trim() === '') return null;
  if (value === '1') return true;
  if (value === '0') return false;
  return null;
}
function strOrNull(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value.trim();
}

/** Coerces parsed CSV rows into typed {@link AuditRow}s. Pure. */
export function parseAuditRows(parsed: ParsedCsv): AuditRow[] {
  return parsed.rows.map((r) => ({
    race_id: strOrNull(r.race_id) ?? '',
    runner_id: strOrNull(r.runner_id) ?? '',
    race_date: strOrNull(r.race_date),
    course: strOrNull(r.course),
    odds: numOrNull(r.pre_off_odds),
    market_rank: numOrNull(r.market_rank_pre_off),
    model_prob: numOrNull(r.model_prob_pre_off),
    model_rank: numOrNull(r.model_rank_pre_off),
    ev: numOrNull(r.ev_pre_off),
    confidence: numOrNull(r.confidence),
    data_quality: strOrNull(r.data_quality),
    tipster_alignment: strOrNull(r.tipster_alignment),
    tipster_support_share: numOrNull(r.tipster_support_share),
    won: bool01OrNull(r.won),
    placed: bool01OrNull(r.placed),
    finish_pos: numOrNull(r.finish_pos),
  }));
}

/** Groups audit rows by race_id, preserving first-seen order. Pure. */
export function groupAuditByRace(rows: readonly AuditRow[]): Map<string, AuditRow[]> {
  const map = new Map<string, AuditRow[]>();
  for (const row of rows) {
    const list = map.get(row.race_id);
    if (list) list.push(row);
    else map.set(row.race_id, [row]);
  }
  return map;
}

/* -------------------------------------------------------------------------- */
/* Per-race picks                                                             */
/* -------------------------------------------------------------------------- */

/** Model pick: model_rank === 1, else highest model_prob. Tie-break by id. */
export function pickModel(rows: readonly AuditRow[]): AuditRow | null {
  const ranked = rows.find((r) => r.model_rank === 1);
  if (ranked) return ranked;
  return (
    rows
      .filter((r) => r.model_prob != null)
      .slice()
      .sort((a, b) => b.model_prob! - a.model_prob! || a.runner_id.localeCompare(b.runner_id))[0] ?? null
  );
}

/** Market favourite: market_rank === 1, else shortest priced. Tie-break by id. */
export function pickFavourite(rows: readonly AuditRow[]): AuditRow | null {
  const ranked = rows.find((r) => r.market_rank === 1);
  if (ranked) return ranked;
  return (
    rows
      .filter((r) => r.odds != null && r.odds > 1)
      .slice()
      .sort((a, b) => a.odds! - b.odds! || a.runner_id.localeCompare(b.runner_id))[0] ?? null
  );
}

/** Highest exported EV. Tie-break by id. */
export function pickHighestEv(rows: readonly AuditRow[]): AuditRow | null {
  return (
    rows
      .filter((r) => r.ev != null)
      .slice()
      .sort((a, b) => b.ev! - a.ev! || a.runner_id.localeCompare(b.runner_id))[0] ?? null
  );
}

/* -------------------------------------------------------------------------- */
/* Baseline stats (win + place/top-4 + ROI)                                   */
/* -------------------------------------------------------------------------- */

/** A baseline's flat-stake (1 unit) win + place/top-4 evaluation. */
export interface BaselineStats {
  id: string;
  name: string;
  races_with_pick: number;
  settled: number;
  winners: number;
  strike_rate: number;
  top4_rate: number | null;
  place_rate: number | null;
  roi: number;
  profit_loss: number;
}

function toOutcome(pick: AuditRow): RecommendationOutcome {
  return { settled: pick.won != null, won: pick.won === true, odds: pick.odds, stake: 1, ev: pick.ev };
}

/** True when finish_pos is recorded in the top 4. */
function isTop4(pick: AuditRow): boolean {
  return pick.finish_pos != null && pick.finish_pos >= 1 && pick.finish_pos <= 4;
}

/** Builds win + place/top-4 + ROI stats for a set of per-race picks. Pure. */
export function buildBaselineStats(
  id: string,
  name: string,
  picks: readonly AuditRow[],
): BaselineStats {
  const perf = summarizeModelPerformance(picks.map(toOutcome));
  const settledPicks = picks.filter((p) => p.won != null);
  const top4 = settledPicks.filter(isTop4).length;
  const placedKnown = settledPicks.filter((p) => p.placed != null);
  const placed = placedKnown.filter((p) => p.placed === true).length;
  return {
    id,
    name,
    races_with_pick: picks.length,
    settled: perf.settled_count,
    winners: perf.winners,
    strike_rate: perf.strike_rate,
    top4_rate: settledPicks.length > 0 ? (top4 / settledPicks.length) * 100 : null,
    place_rate: placedKnown.length > 0 ? (placed / placedKnown.length) * 100 : null,
    roi: perf.roi,
    profit_loss: perf.profit_loss,
  };
}

/* -------------------------------------------------------------------------- */
/* Segment performance                                                        */
/* -------------------------------------------------------------------------- */

/** A per-segment strike / top-4 / ROI breakdown of the model picks. */
export interface SegmentRow {
  segment: string;
  picks: number;
  settled: number;
  winners: number;
  strike_rate: number;
  top4_rate: number | null;
  roi: number;
}

function segmentRows(
  picks: readonly AuditRow[],
  keyOf: (r: AuditRow) => string,
  order: readonly string[] = [],
): SegmentRow[] {
  const groups = new Map<string, AuditRow[]>();
  for (const p of picks) {
    const k = keyOf(p);
    const list = groups.get(k);
    if (list) list.push(p);
    else groups.set(k, [p]);
  }
  const rank = (s: string): number => {
    const i = order.indexOf(s);
    return i === -1 ? order.length + 1 : i;
  };
  return [...groups.entries()]
    .map(([segment, list]) => {
      const perf = summarizeModelPerformance(list.map(toOutcome));
      const settledPicks = list.filter((p) => p.won != null);
      const top4 = settledPicks.filter(isTop4).length;
      return {
        segment,
        picks: list.length,
        settled: perf.settled_count,
        winners: perf.winners,
        strike_rate: perf.strike_rate,
        top4_rate: settledPicks.length > 0 ? (top4 / settledPicks.length) * 100 : null,
        roi: perf.roi,
      };
    })
    .sort((a, b) => rank(a.segment) - rank(b.segment) || a.segment.localeCompare(b.segment));
}

/** Confidence band (0..1 numeric score). low <0.34, medium <0.67, high else. */
export function confidenceBand(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'unknown';
  if (value < 0.34) return 'low';
  if (value < 0.67) return 'medium';
  return 'high';
}

/**
 * The no-bet gate PROXY. The production gate suppresses a stake on several
 * grounds (non-positive EV, degraded/invalid data, low confidence, no tipster
 * consensus, stake-suppression). From this export we can only reconstruct the
 * EV arm cleanly, so the proxy is: gate passes when ev > 0. Documented as a
 * proxy, never as the production gate itself.
 */
export function noBetGateProxy(pick: AuditRow): 'gate-pass (ev>0)' | 'gate-block (ev<=0 / unknown)' {
  return pick.ev != null && pick.ev > 0 ? 'gate-pass (ev>0)' : 'gate-block (ev<=0 / unknown)';
}

/* -------------------------------------------------------------------------- */
/* Feature-importance HINTS (deterministic association, NOT trained)          */
/* -------------------------------------------------------------------------- */

/** A single feature-importance hint: how a signal separates winners. */
export interface FeatureHint {
  feature: string;
  mean_winners: number | null;
  mean_losers: number | null;
  separation: number | null;
  top_pick_strike: number | null;
  coverage: number;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Builds deterministic feature-importance HINTS. For each candidate signal it
 * compares the signal's mean for winners vs non-winners over settled runners and
 * the per-race strike rate of the runner that tops that signal. This is an
 * ASSOCIATION hint on a tiny sample — NOT a trained importance and NOT evidence
 * of an edge. Pure.
 */
export function featureImportanceHints(
  rows: readonly AuditRow[],
  racesMap: ReadonlyMap<string, AuditRow[]>,
): FeatureHint[] {
  const settled = rows.filter((r) => r.won != null);
  const signals: { feature: string; valueOf: (r: AuditRow) => number | null }[] = [
    { feature: 'model_prob_pre_off', valueOf: (r) => r.model_prob },
    { feature: 'market_implied (1/odds)', valueOf: (r) => (r.odds != null && r.odds > 1 ? 1 / r.odds : null) },
    { feature: 'confidence', valueOf: (r) => r.confidence },
    { feature: 'tipster_support_share', valueOf: (r) => r.tipster_support_share },
  ];

  return signals.map(({ feature, valueOf }) => {
    const winnerVals = settled.filter((r) => r.won === true).map(valueOf).filter((v): v is number => v != null);
    const loserVals = settled.filter((r) => r.won === false).map(valueOf).filter((v): v is number => v != null);
    const mw = mean(winnerVals);
    const ml = mean(loserVals);

    // Per-race strike of the runner that tops this signal.
    let topSettled = 0;
    let topWins = 0;
    for (const race of racesMap.values()) {
      const ranked = race
        .filter((r) => valueOf(r) != null)
        .slice()
        .sort((a, b) => (valueOf(b) as number) - (valueOf(a) as number) || a.runner_id.localeCompare(b.runner_id));
      const top = ranked[0];
      if (top && top.won != null) {
        topSettled += 1;
        if (top.won === true) topWins += 1;
      }
    }
    const coverage = winnerVals.length + loserVals.length;
    return {
      feature,
      mean_winners: mw,
      mean_losers: ml,
      separation: mw != null && ml != null ? mw - ml : null,
      top_pick_strike: topSettled > 0 ? (topWins / topSettled) * 100 : null,
      coverage,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Readiness score + verdict                                                  */
/* -------------------------------------------------------------------------- */

/** One scored component of the readiness score. */
export interface ReadinessComponent {
  name: string;
  points: number;
  max: number;
  detail: string;
}

/** The promotion verdict. */
export type PromotionVerdict = 'NO-GO (remain shadow)' | 'RAMP CANDIDATE (still gated)';

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Builds the deterministic 0-100 readiness score and verdict. The verdict is
 * NO-GO unless EVERY hard gate passes: settled sample ≥ MIN_SAMPLE_RACES, the
 * model strictly beats the market favourite on strike AND top-4 AND ROI, a
 * calibration (Brier) number exists, leakage PASS, and the score clears
 * {@link RAMP_READINESS_THRESHOLD}. Pure.
 */
export function buildReadiness(input: {
  settledRaces: number;
  leakagePass: boolean;
  brier: number | null;
  model: BaselineStats;
  favourite: BaselineStats;
}): {
  score: number;
  components: ReadinessComponent[];
  verdict: PromotionVerdict;
  gate_reasons: string[];
} {
  const { settledRaces, leakagePass, brier, model, favourite } = input;

  const sampleFrac = clamp01(settledRaces / MIN_SAMPLE_RACES);
  const sample: ReadinessComponent = {
    name: 'Sample adequacy',
    points: Math.round(sampleFrac * 35 * 10) / 10,
    max: 35,
    detail: `${settledRaces} settled / ${MIN_SAMPLE_RACES} minimum`,
  };

  const calPoints = brier != null ? Math.round(clamp01(1 - brier / 0.25) * 20 * 10) / 10 : 0;
  const calibration: ReadinessComponent = {
    name: 'Calibration present',
    points: calPoints,
    max: 20,
    detail: brier != null ? `Brier ${brier.toFixed(4)}` : 'no settled priced races',
  };

  const beatsStrike = model.strike_rate > favourite.strike_rate;
  const beatsRoi = model.roi > favourite.roi;
  const beatsTop4 =
    model.top4_rate != null && favourite.top4_rate != null && model.top4_rate > favourite.top4_rate;
  const edgeCount = [beatsStrike, beatsRoi, beatsTop4].filter(Boolean).length;
  const edge: ReadinessComponent = {
    name: 'Edge over market favourite',
    points: edgeCount * 10,
    max: 30,
    detail: `beats market on ${edgeCount}/3 of {strike, ROI, top-4}`,
  };

  const leakage: ReadinessComponent = {
    name: 'Leakage check',
    points: leakagePass ? 15 : 0,
    max: 15,
    detail: leakagePass ? 'PASS' : 'FAIL',
  };

  const components = [sample, calibration, edge, leakage];
  const score = Math.round(components.reduce((s, c) => s + c.points, 0) * 10) / 10;

  const gate_reasons: string[] = [];
  if (settledRaces < MIN_SAMPLE_RACES)
    gate_reasons.push(`Sample too small: ${settledRaces} settled < ${MIN_SAMPLE_RACES}.`);
  if (!(beatsStrike && beatsRoi && beatsTop4))
    gate_reasons.push('Model does not strictly beat the market favourite on strike AND ROI AND top-4.');
  if (brier == null) gate_reasons.push('No calibration (Brier) available.');
  if (!leakagePass) gate_reasons.push('Leakage check did not pass.');
  if (score < RAMP_READINESS_THRESHOLD)
    gate_reasons.push(`Readiness score ${score} < ${RAMP_READINESS_THRESHOLD}.`);

  const verdict: PromotionVerdict =
    gate_reasons.length === 0 ? 'RAMP CANDIDATE (still gated)' : 'NO-GO (remain shadow)';
  return { score, components, verdict, gate_reasons };
}

/* -------------------------------------------------------------------------- */
/* Report assembly                                                            */
/* -------------------------------------------------------------------------- */

/** The full promotion-audit payload. */
export interface MlPromotionAudit {
  input_path: string;
  generatedAt: string;
  leakage: LeakageCheck;
  dates: string[];
  courses: string[];
  race_count: number;
  runner_count: number;
  settled_race_count: number;
  sample_too_small: boolean;
  baselines: BaselineStats[];
  persisted_recommendation_available: boolean;
  brier: number | null;
  log_loss: number | null;
  calibration: CalibrationBucket[];
  confidence_segments: SegmentRow[];
  data_quality_segments: SegmentRow[];
  tipster_consensus_segments: SegmentRow[];
  no_bet_gate_segments: SegmentRow[];
  feature_hints: FeatureHint[];
  readiness_score: number;
  readiness_components: ReadinessComponent[];
  verdict: PromotionVerdict;
  gate_reasons: string[];
}

const CONFIDENCE_ORDER = ['low', 'medium', 'high', 'unknown'];
const DATA_QUALITY_ORDER = ['OK', 'DEGRADED', 'STALE', 'INVALID'];

/** Builds the full promotion audit from a parsed CSV. Pure; deterministic. */
export function buildMlPromotionAudit(
  parsed: ParsedCsv,
  inputPath: string,
  generatedAt: string,
): MlPromotionAudit {
  const leakage = checkLeakage(parsed.header);
  const rows = parseAuditRows(parsed);
  const racesMap = groupAuditByRace(rows);
  const races = [...racesMap.values()];
  const settledRaceCount = races.filter((r) => r.some((x) => x.won === true)).length;

  const modelPicks = races.map(pickModel).filter((p): p is AuditRow => p !== null);
  const favPicks = races.map(pickFavourite).filter((p): p is AuditRow => p !== null);
  const evPicks = races.map(pickHighestEv).filter((p): p is AuditRow => p !== null);

  const model = buildBaselineStats('model_rank', 'Model rank 1 (shadow — not production rec)', modelPicks);
  const favourite = buildBaselineStats('market_favourite', 'Market favourite', favPicks);
  const highestEv = buildBaselineStats('ev_highest', 'Highest EV', evPicks);
  const baselines = [favourite, model, highestEv];

  // Persisted production recommendation is not carried by the standard export.
  const persistedAvailable =
    parsed.header.includes('is_recommendation') ||
    parsed.header.includes('recommended') ||
    parsed.header.includes('recommendation_rank');

  // Calibration via the existing tested market-implied path (identical numbers).
  const runnerRows = parseRunnerRows(parsed);
  const runnerRacesMap = groupByRace(runnerRows);
  const preds = marketImpliedPredictions(runnerRacesMap);

  const dates = [...new Set(rows.map((r) => r.race_date).filter((d): d is string => d !== null))].sort();
  const courses = [...new Set(rows.map((r) => r.course).filter((c): c is string => c !== null))].sort();

  const readiness = buildReadiness({
    settledRaces: settledRaceCount,
    leakagePass: leakage.status === 'PASS',
    brier: brierScore(preds),
    model,
    favourite,
  });

  return {
    input_path: inputPath,
    generatedAt,
    leakage,
    dates,
    courses,
    race_count: races.length,
    runner_count: rows.length,
    settled_race_count: settledRaceCount,
    sample_too_small: settledRaceCount < MIN_SAMPLE_RACES,
    baselines,
    persisted_recommendation_available: persistedAvailable,
    brier: brierScore(preds),
    log_loss: logLoss(preds),
    calibration: calibrationBuckets(preds),
    confidence_segments: segmentRows(modelPicks, (r) => confidenceBand(r.confidence), CONFIDENCE_ORDER),
    data_quality_segments: segmentRows(modelPicks, (r) => r.data_quality ?? 'unknown', DATA_QUALITY_ORDER),
    tipster_consensus_segments: segmentRows(modelPicks, (r) => r.tipster_alignment ?? 'unknown'),
    no_bet_gate_segments: segmentRows(modelPicks, noBetGateProxy),
    feature_hints: featureImportanceHints(rows, racesMap),
    readiness_score: readiness.score,
    readiness_components: readiness.components,
    verdict: readiness.verdict,
    gate_reasons: readiness.gate_reasons,
  };
}

/** Builds `reports/ml-promotion-audit-<dates>[-<course>].md`. Pure. */
export function buildPromotionAuditPath(dates: readonly string[], courses: readonly string[]): string {
  let datePart = 'dataset';
  if (dates.length === 1) datePart = dates[0];
  else if (dates.length > 1) datePart = `${dates[0]}-to-${dates[dates.length - 1]}`;
  let coursePart = 'all';
  if (courses.length === 1) {
    coursePart =
      courses[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'all';
  } else if (courses.length > 1) {
    coursePart = 'multi';
  }
  return `reports/ml-promotion-audit-${datePart}-${coursePart}.md`;
}

/* -------------------------------------------------------------------------- */
/* Markdown rendering (pure, deterministic)                                   */
/* -------------------------------------------------------------------------- */

function fmtPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  const sign = value > 0 ? '+' : value < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}
function fmtNum(value: number | null, dp: number): string {
  return value === null || !Number.isFinite(value) ? DASH : value.toFixed(dp);
}
function fmtPoints(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  const sign = value > 0 ? '+' : value < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(value).toFixed(2)}pt`;
}

function renderSegmentTable(title: string, note: string, rows: readonly SegmentRow[]): string {
  const lines = [`### ${title}`, '', `_${note}_`, ''];
  if (rows.length === 0) {
    lines.push(`${DASH} (no data)`);
    return lines.join('\n');
  }
  lines.push('| Segment | Picks | Settled | Winners | Strike | Top-4 | ROI |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    lines.push(
      `| ${r.segment} | ${r.picks} | ${r.settled} | ${r.winners} | ${fmtPct(r.strike_rate)} | ${fmtPct(r.top4_rate)} | ${fmtPct(r.roi)} |`,
    );
  }
  return lines.join('\n');
}

/**
 * Renders the promotion audit as deterministic Markdown. Pure: the same audit
 * object always yields the same string. It states plainly that no model is
 * trained or activated and that the verdict defaults to NO-GO. Missing values
 * render as an em dash.
 */
export function renderMlPromotionAuditMarkdown(a: MlPromotionAudit): string {
  const b: string[] = [];

  b.push('# ML promotion audit (offline — no model trained, no live change)');
  b.push(
    [
      `Input: ${a.input_path}`,
      `Generated: ${a.generatedAt}`,
      `Dates: ${a.dates.join(', ') || DASH} · courses: ${a.courses.join(', ') || DASH}`,
      `Races: ${a.race_count} · runners: ${a.runner_count} · settled races: ${a.settled_race_count}`,
    ].join('  \n'),
  );
  b.push(
    [
      '> Offline promotion audit only. Trains NO model, persists nothing, activates',
      '> no ML, and changes no live recommendation, probability, EV, stake, or',
      '> ranking. Shadow recommendations only. Not betting advice; no edge claimed.',
    ].join('\n'),
  );

  // 0. Verdict up front.
  b.push(
    [
      '## Verdict',
      '',
      `- **${a.verdict}**`,
      `- ML readiness score: **${a.readiness_score} / 100** (ramp threshold ${RAMP_READINESS_THRESHOLD}).`,
      a.sample_too_small
        ? `- ⚠️ Sample-size warning: ${a.settled_race_count} settled races < ${MIN_SAMPLE_RACES}. Three days is structurally too small for promotion.`
        : `- Sample: ${a.settled_race_count} settled races.`,
      '- Gate reasons:',
      ...a.gate_reasons.map((r) => `  - ${r}`),
    ].join('\n'),
  );

  // 1. Readiness breakdown.
  b.push(
    [
      '## 1. Readiness score breakdown',
      '',
      '| Component | Points | Max | Detail |',
      '| --- | --- | --- | --- |',
      ...a.readiness_components.map((c) => `| ${c.name} | ${c.points} | ${c.max} | ${c.detail} |`),
    ].join('\n'),
  );

  // 2. Leakage.
  b.push(
    [
      '## 2. Leakage check',
      '',
      `- Status: **${a.leakage.status}**`,
      `- Label columns (labels only): ${a.leakage.label_columns.join(', ') || DASH}`,
      a.leakage.leakage_violations.length > 0
        ? `- ⚠️ Leakage violations: ${a.leakage.leakage_violations.join(', ')}`
        : '- No leakage columns are used as features.',
    ].join('\n'),
  );

  // 3. Baselines (win + place/top-4).
  b.push('## 3. Baseline comparison (win + place / top-4)');
  const baseLines = [
    '| Baseline | Races | Settled | Winners | Strike | Top-4 | Place | ROI | P/L |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const x of a.baselines) {
    baseLines.push(
      `| ${x.name} | ${x.races_with_pick} | ${x.settled} | ${x.winners} | ${fmtPct(x.strike_rate)} | ${fmtPct(x.top4_rate)} | ${fmtPct(x.place_rate)} | ${fmtPct(x.roi)} | ${fmtPoints(x.profit_loss)} |`,
    );
  }
  baseLines.push('');
  baseLines.push('_Flat 1-unit stakes at exported pre-off odds; settled picks only count toward strike / top-4 / ROI._');
  baseLines.push(
    a.persisted_recommendation_available
      ? '_Persisted production recommendation present in export and included above._'
      : '> Persisted production recommendation: **unavailable** in this export (no recommendation/stake columns). Use `/api/accuracy` performance or `report:day` for the real production record — it is EV/stake-gated and is NOT the model-rank row above.',
  );
  b.push(baseLines.join('\n'));

  // 4. Calibration.
  const calLines = [
    '## 4. Calibration summary (market-implied)',
    '',
    `- Brier score: ${fmtNum(a.brier, 4)} (lower is better)`,
    `- Log loss: ${fmtNum(a.log_loss, 4)}`,
    '',
    '| Prob bucket | Count | Mean predicted | Actual win rate |',
    '| --- | --- | --- | --- |',
  ];
  for (const c of a.calibration) {
    calLines.push(`| ${c.range} | ${c.count} | ${fmtNum(c.mean_predicted, 3)} | ${fmtNum(c.actual_rate, 3)} |`);
  }
  b.push(calLines.join('\n'));

  // 5. Segment performance.
  b.push('## 5. Confidence-band performance (model picks)');
  b.push(renderSegmentTable('Confidence', 'Low <0.34, medium <0.67, high otherwise.', a.confidence_segments));
  b.push('## 6. Degraded-data performance (model picks)');
  b.push(renderSegmentTable('Data quality', 'Model picks grouped by exported data_quality.', a.data_quality_segments));
  b.push('## 7. Tipster-consensus performance (model picks)');
  b.push(
    renderSegmentTable('Tipster alignment', 'Model picks grouped by exported tipster_alignment.', a.tipster_consensus_segments),
  );
  b.push('## 8. No-bet-gate performance (model picks)');
  b.push(
    renderSegmentTable(
      'No-bet gate (proxy)',
      'PROXY: gate passes when ev_pre_off > 0. The production gate also weighs data quality, confidence, consensus, and stake suppression — not fully reconstructable here.',
      a.no_bet_gate_segments,
    ),
  );

  // 9. Feature-importance hints.
  const fhLines = [
    '## 9. Feature-importance hints (association only — NOT trained)',
    '',
    '> Deterministic association on a tiny sample. NOT a trained importance and NOT',
    '> evidence of an edge. Bigger separation = the signal is higher for winners.',
    '',
    '| Feature | Mean (winners) | Mean (losers) | Separation | Top-pick strike | Coverage |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const h of a.feature_hints) {
    fhLines.push(
      `| ${h.feature} | ${fmtNum(h.mean_winners, 3)} | ${fmtNum(h.mean_losers, 3)} | ${fmtNum(h.separation, 3)} | ${fmtPct(h.top_pick_strike)} | ${h.coverage} |`,
    );
  }
  b.push(fhLines.join('\n'));

  // 10. Warnings.
  b.push(
    [
      '## 10. Warnings and limitations',
      '',
      `- ⚠️ ${a.settled_race_count} settled races is far below the ${MIN_SAMPLE_RACES}-race minimum; every figure is anecdotal.`,
      '- Single course (Ascot) and a 3-day window — do NOT optimise on this; that is overfitting.',
      '- Market-implied probabilities are normalised per race (overround removed); they are not a model.',
      '- No model was trained, tuned, or persisted; these are fixed deterministic baselines.',
      '- BSP is not populated in this export, so ROI uses SP/pre-off odds only.',
    ].join('\n'),
  );

  // 11. GO / NO-GO recommendation + next steps.
  b.push(
    [
      '## 11. Recommendation',
      '',
      `- **${a.verdict}.** No ML model may be promoted, made model-active, or allowed to influence`,
      '  live recommendations, EV, staking, or ranking on this evidence. Shadow only.',
      '- This audit changed nothing live. It is decision-support / research only.',
    ].join('\n'),
  );

  return b.join('\n\n') + '\n';
}
