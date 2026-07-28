/**
 * Pre-off decision-support validation — pure aggregation, verdict and rendering.
 *
 * Backs the SELECT-ONLY `validate:pre-off` command. From ALREADY-PERSISTED
 * evidence only, it builds a reproducible EVIDENCE-QUALITY scorecard of the
 * production model's pre-off DIAGNOSTIC layer: coverage, ranking accuracy
 * (top-1/2/3, model + market), probability calibration, a market baseline,
 * decision ROI/strike/no-bet, confidence/course/odds-band/EV segments and
 * stored-EV honesty.
 *
 * VERDICT SEMANTICS (evidence quality, NOT profitability):
 *   - PASS: required reads succeeded, the strict pre-off/as-of boundary is
 *     proven, required evidence is complete, settled-sample thresholds are met,
 *     no invariant is violated, and output is deterministic.
 *   - REVIEW: meaningful evidence is unavailable/ambiguous WITHOUT a fatal
 *     boundary failure (e.g. some scoped races could not be read).
 *   - INSUFFICIENT_EVIDENCE: valid evidence but the settled/calibration sample
 *     is below the required thresholds.
 *   - FAIL: leakage, a query failure surfaced to the aggregator, an impossible
 *     state, an unprovable pre-off boundary, or an invariant violation.
 * The verdict NEVER depends on the model calibrating better than the market, on
 * ROI, on any profitability threshold, or on a promotion decision. Model-vs-
 * market is SEPARATE descriptive evidence only.
 *
 * The DIAGNOSTIC layer here is kept SEPARATE from the OFFICIAL locked-decision
 * history (`report:locked` / `lockedReport.ts`); the official layer is reported
 * NOT MEASURED here, never merged into these figures.
 *
 * IT NEVER runs, re-scores, or persists a model, and performs NO I/O. Reuses
 * `calibrateBinary` etc. (`mlCalibration.ts`), `summarizeModelPerformance`
 * (`modelPerformance.ts`) and `bandOf` (`backtestStats.ts`). Decision-support
 * only — nothing here places a bet.
 */

import {
  MIN_CALIBRATION_SAMPLES,
  calibrateBinary,
  type CalibrationReport,
  type CalibrationSample,
} from './mlCalibration';
import {
  summarizeModelPerformance,
  type ModelPerformance,
  type RecommendationOutcome,
} from './modelPerformance';
import { bandOf } from './backtestStats';

export const PRE_OFF_VALIDATION_SCHEMA_VERSION = 2;

/** Minimum SETTLED decisions before the evidence sample is deemed sufficient. */
export const MIN_SETTLED_DECISIONS = 50;
/** Minimum settled positive-EV picks before EV honesty is described (else NOT_MEASURED). */
export const MIN_EV_HONESTY_SAMPLE = 30;

/* -------------------------------------------------------------------------- */
/* Input shape (already resolved by the CLI from stored rows)                 */
/* -------------------------------------------------------------------------- */

export interface ResolvedRunnerScore {
  runner_id: string;
  /** Stored model probability, or null. calibrateBinary drops values outside [0,1]. */
  model_prob: number | null;
  /** Stored market (implied) probability, or null. */
  market_prob: number | null;
  /** Recorded finishing position, or null when unsettled. */
  finish_pos: number | null;
}

export interface ResolvedPick {
  runner_id: string;
  odds: number | null;
  stake: number | null;
  ev: number | null;
  confidence_label: string | null;
}

export interface ResolvedPreOffRace {
  race_id: string;
  course: string | null;
  /** Scheduled off time (for the pre-off boundary invariant). */
  off_time: string | null;
  /** True when a run with `run_time <= off_time` existed (via selectPreOffRun). */
  has_pre_off_run: boolean;
  /** The selected pre-off run's `run_time` (for the boundary invariant), or null. */
  selected_run_time: string | null;
  settled: boolean;
  winner_runner_id: string | null;
  runners: ResolvedRunnerScore[];
  pick: ResolvedPick | null;
}

/* -------------------------------------------------------------------------- */
/* Output shape                                                               */
/* -------------------------------------------------------------------------- */

export type OverallVerdict = 'PASS' | 'REVIEW' | 'INSUFFICIENT_EVIDENCE' | 'FAIL';
/** Descriptive quality signal — NEVER an input to the overall verdict. */
export type DescriptiveSignal = 'favourable' | 'unfavourable' | 'not_measured';
/** Descriptive model-vs-market calibration comparison — NEVER gating. */
export type MarketComparison = 'model_better' | 'model_equal' | 'model_worse' | 'unavailable';

export interface CoverageBlock {
  races_in_scope: number;
  races_with_pre_off_run: number;
  settled_races_with_pre_off_run: number;
  pending_races_with_pre_off_run: number;
  races_without_pre_off_run: number;
  /** Scoped races the CLI could not read (isolated failures) — forces REVIEW. */
  read_errors: number;
}

export interface RankingAccuracy {
  /** Settled races where the winner had a usable probability (so a rank exists). */
  races: number;
  /** top-K = P(winner rank <= K) * 100, or null when races = 0. */
  top1: number | null;
  top2: number | null;
  top3: number | null;
}

export interface RankingBlock {
  measured: boolean;
  model: RankingAccuracy;
  market: RankingAccuracy;
  /** Model vs market top-1 agreement over races eligible for BOTH. */
  agreement: { races: number; both: number; model_only: number; market_only: number; neither: number };
}

export interface BandPerformance {
  label: string;
  performance: ModelPerformance;
}

export interface MarketBaseline {
  calibration: CalibrationReport;
  favourite_races: number;
  favourite_wins: number;
  favourite_strike_rate: number | null;
  /** market ROI is deliberately not computed (no tradeable stored price). */
  roi_measured: false;
}

export interface NotMeasuredBlock {
  measured: false;
  reason: string;
}

export interface PreOffValidationReport {
  schema_version: number;
  from: string;
  to: string;
  course: string | null;
  generated_at: string;
  read_only: true;
  database_mutated: false;
  layer: 'diagnostic';
  coverage: CoverageBlock;
  ranking: RankingBlock;
  decision_performance: ModelPerformance;
  model_calibration: CalibrationReport;
  market_baseline: MarketBaseline;
  /** Descriptive only — does NOT change the verdict. */
  model_vs_market_calibration: MarketComparison;
  segments: {
    by_confidence: BandPerformance[];
    by_course: BandPerformance[];
    by_odds_band: BandPerformance[];
    by_ev: BandPerformance[];
    by_handicap: NotMeasuredBlock;
    by_field_size: NotMeasuredBlock;
    by_country: NotMeasuredBlock;
  };
  /** Official locked-decision layer is evaluated separately, never merged here. */
  official_locked_layer: NotMeasuredBlock;
  each_way: NotMeasuredBlock;
  chronological_drawdown: NotMeasuredBlock;
  /** Descriptive quality signals — reported, but NEVER gating the verdict. */
  descriptive_signals: {
    model_calibration_quality: DescriptiveSignal;
    market_comparison: DescriptiveSignal;
    decision_roi_sign: DescriptiveSignal;
    confidence_ordering: DescriptiveSignal;
    ev_honesty: DescriptiveSignal;
  };
  not_measured: string[];
  invariant_violations: string[];
  verdict: OverallVerdict;
  notes: string[];
}

/* -------------------------------------------------------------------------- */
/* Argument parsing (pure; validated BEFORE any I/O)                          */
/* -------------------------------------------------------------------------- */

export interface PreOffValidationArgs {
  from: string;
  to: string;
  course: string | null;
  report: boolean;
  json: boolean;
}

export type ParseArgsResult =
  | { ok: true; args: PreOffValidationArgs }
  | { ok: false; error: string };

/** Strict `YYYY-MM-DD` calendar validation, leap-year aware, no `Date` use. Pure. */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= dim[month - 1];
}

/**
 * Parses argv strictly. NO implicit window: `--from` and `--to` are mandatory.
 * Rejects malformed/impossible dates, from>to, a blank course, unknown flags,
 * and `--commit`. Pure — safe before any DB/filesystem/provider/model access.
 */
export function parsePreOffValidationArgs(argv: readonly string[]): ParseArgsResult {
  let from: string | null = null;
  let to: string | null = null;
  let course: string | null = null;
  let report = false;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from') {
      from = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--to') {
      to = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--course') {
      course = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--report') {
      report = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--commit') {
      return { ok: false, error: 'this command is READ-ONLY and has no --commit flag' };
    } else {
      return { ok: false, error: `unknown flag ${arg}` };
    }
  }

  if (from === null) return { ok: false, error: 'missing required --from YYYY-MM-DD' };
  if (to === null) return { ok: false, error: 'missing required --to YYYY-MM-DD' };
  if (!isValidIsoDate(from)) return { ok: false, error: `invalid --from "${from}" (expected a real YYYY-MM-DD)` };
  if (!isValidIsoDate(to)) return { ok: false, error: `invalid --to "${to}" (expected a real YYYY-MM-DD)` };
  if (from > to) return { ok: false, error: `--from (${from}) is later than --to (${to})` };
  if (course !== null && course.trim() === '') return { ok: false, error: '--course must not be blank' };

  return { ok: true, args: { from, to, course, report, json } };
}

/** Deterministic, scope-specific report stems (never overwrite another scope). Pure. */
export function courseSlug(course: string | null): string {
  if (!course) return 'all-courses';
  const slug = course
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'course' : slug;
}

export function buildPreOffValidationStem(from: string, to: string, course: string | null): string {
  return `reports/pre-off-validation-${from}-to-${to}-${courseSlug(course)}`;
}
export function buildPreOffValidationMarkdownPath(from: string, to: string, course: string | null): string {
  return `${buildPreOffValidationStem(from, to, course)}.md`;
}
export function buildPreOffValidationJsonPath(from: string, to: string, course: string | null): string {
  return `${buildPreOffValidationStem(from, to, course)}.json`;
}

/* -------------------------------------------------------------------------- */
/* Small pure helpers                                                         */
/* -------------------------------------------------------------------------- */

function outcomeForPick(race: ResolvedPreOffRace): RecommendationOutcome {
  const pick = race.pick as ResolvedPick;
  return {
    settled: race.settled,
    won: race.settled && pick.runner_id === race.winner_runner_id,
    odds: pick.odds,
    stake: pick.stake,
    ev: pick.ev,
  };
}

function marketFavourite(race: ResolvedPreOffRace): ResolvedRunnerScore | null {
  let best: ResolvedRunnerScore | null = null;
  for (const r of race.runners) {
    if (typeof r.market_prob !== 'number' || !Number.isFinite(r.market_prob)) continue;
    if (best === null || r.market_prob > (best.market_prob as number) ||
        (r.market_prob === best.market_prob && r.runner_id < best.runner_id)) {
      best = r;
    }
  }
  return best;
}

function confidenceBandKey(label: string | null): string {
  const l = (label ?? '').trim().toLowerCase();
  if (l === 'high') return 'HIGH';
  if (l === 'medium') return 'MEDIUM';
  if (l === 'low') return 'LOW';
  return 'UNLABELLED';
}

/**
 * The winner's 1-based rank in the descending-probability order of the runners
 * that have a usable probability, with a deterministic id tie-break. Returns
 * null when the winner has no usable probability (so no rank exists). Pure.
 */
function winnerRank(race: ResolvedPreOffRace, prob: (r: ResolvedRunnerScore) => number | null): number | null {
  const winner = race.runners.find((r) => r.runner_id === race.winner_runner_id);
  if (!winner) return null;
  const wp = prob(winner);
  if (typeof wp !== 'number' || !Number.isFinite(wp)) return null;
  let rank = 1;
  for (const r of race.runners) {
    if (r.runner_id === winner.runner_id) continue;
    const p = prob(r);
    if (typeof p !== 'number' || !Number.isFinite(p)) continue;
    // A runner outranks the winner if strictly higher prob, or equal prob with a
    // lexicographically smaller id (deterministic tie handling).
    if (p > wp || (p === wp && r.runner_id < winner.runner_id)) rank += 1;
  }
  return rank;
}

function rankingAccuracy(ranks: number[]): RankingAccuracy {
  const n = ranks.length;
  const rate = (k: number): number | null => (n === 0 ? null : (ranks.filter((r) => r <= k).length / n) * 100);
  return { races: n, top1: rate(1), top2: rate(2), top3: rate(3) };
}

function segmentBands(
  entries: readonly { key: string; outcome: RecommendationOutcome }[],
  order?: readonly string[],
): BandPerformance[] {
  const buckets = new Map<string, RecommendationOutcome[]>();
  for (const e of entries) (buckets.get(e.key) ?? buckets.set(e.key, []).get(e.key)!).push(e.outcome);
  const keys = order ? order.filter((k) => buckets.has(k)) : [...buckets.keys()].sort();
  return keys.map((k) => ({ label: k, performance: summarizeModelPerformance(buckets.get(k)!, 0) }));
}

/* -------------------------------------------------------------------------- */
/* Invariants (executable production checks; a violation -> FAIL)             */
/* -------------------------------------------------------------------------- */

/** Verifies the report's internal consistency + the pre-off boundary. Pure. */
export function checkPreOffInvariants(
  report: Omit<PreOffValidationReport, 'invariant_violations' | 'verdict' | 'notes'>,
  races: readonly ResolvedPreOffRace[],
): string[] {
  const v: string[] = [];
  const c = report.coverage;
  const nonNeg = (label: string, x: number): void => {
    if (!Number.isInteger(x) || x < 0) v.push(`${label} is not a non-negative integer (${x})`);
  };
  nonNeg('races_in_scope', c.races_in_scope);
  nonNeg('races_with_pre_off_run', c.races_with_pre_off_run);
  nonNeg('settled_races_with_pre_off_run', c.settled_races_with_pre_off_run);
  nonNeg('read_errors', c.read_errors);

  if (c.settled_races_with_pre_off_run > c.races_with_pre_off_run) v.push('settled_races_with_pre_off_run > races_with_pre_off_run');
  if (c.races_with_pre_off_run > c.races_in_scope) v.push('races_with_pre_off_run > races_in_scope');

  const d = report.decision_performance;
  if (d.winners < 0 || d.settled_count < 0) v.push('decision winners/settled_count negative');
  if (d.winners > d.settled_count) v.push(`winners (${d.winners}) > settled decisions (${d.settled_count})`);
  if (d.settled_count > c.settled_races_with_pre_off_run) v.push('settled decisions exceed settled races with a pre-off run');
  if (d.total_staked < 0) v.push('total_staked is negative (invalid ROI denominator)');

  // Ranking monotonicity (both series), where measured.
  for (const [name, r] of [['model', report.ranking.model], ['market', report.ranking.market]] as const) {
    const { top1, top2, top3 } = r;
    if (top1 !== null && top2 !== null && top2 + 1e-9 < top1) v.push(`${name} top2 (${top2}) < top1 (${top1})`);
    if (top2 !== null && top3 !== null && top3 + 1e-9 < top2) v.push(`${name} top3 (${top3}) < top2 (${top2})`);
  }

  // Calibration: bins reconcile with n; observed/predicted within [0,1].
  for (const [name, cal] of [['model', report.model_calibration], ['market', report.market_baseline.calibration]] as const) {
    const binSum = cal.bins.reduce((a, b) => a + b.n, 0);
    if (binSum !== cal.n) v.push(`${name} calibration bins (${binSum}) do not reconcile with n (${cal.n})`);
    for (const b of cal.bins) {
      if (b.obsRate !== null && (b.obsRate < 0 || b.obsRate > 1)) v.push(`${name} bin ${b.bin} obsRate out of [0,1]`);
      if (b.predMean !== null && (b.predMean < 0 || b.predMean > 1)) v.push(`${name} bin ${b.bin} predMean out of [0,1]`);
    }
    if (cal.meanObserved !== null && (cal.meanObserved < 0 || cal.meanObserved > 1)) v.push(`${name} meanObserved out of [0,1]`);
  }

  // Winner-label validity + pre-off boundary (no post-off run selected → no leakage).
  for (const race of races) {
    if (race.settled !== (race.winner_runner_id !== null)) {
      v.push(`race ${race.race_id}: settled flag inconsistent with winner presence`);
    }
    if (race.has_pre_off_run) {
      if (!race.selected_run_time) {
        v.push(`race ${race.race_id}: has_pre_off_run but no selected_run_time`);
      } else if (race.off_time) {
        const runMs = Date.parse(race.selected_run_time);
        const offMs = Date.parse(race.off_time);
        if (Number.isFinite(runMs) && Number.isFinite(offMs) && runMs > offMs) {
          v.push(`race ${race.race_id}: LEAKAGE — selected run is post-off (run ${race.selected_run_time} > off ${race.off_time})`);
        }
      }
    }
  }

  // Diagnostic/official separation: the official layer must remain NOT MEASURED here.
  if (report.official_locked_layer.measured !== false) v.push('official locked layer must remain separate (NOT MEASURED) in the diagnostic scorecard');

  return v;
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

export function aggregatePreOffValidation(
  races: readonly ResolvedPreOffRace[],
  meta: { from: string; to: string; course: string | null; generatedAtIso: string; readErrors?: number },
): PreOffValidationReport {
  const readErrors = meta.readErrors ?? 0;
  const withRun = races.filter((r) => r.has_pre_off_run);
  const settledWithRun = withRun.filter((r) => r.settled);

  // --- Decision performance --------------------------------------------------
  const decisionOutcomes: RecommendationOutcome[] = [];
  let noBetRaces = 0;
  for (const race of withRun) {
    if (race.pick) decisionOutcomes.push(outcomeForPick(race));
    else noBetRaces += 1;
  }
  const decisionPerformance = summarizeModelPerformance(decisionOutcomes, noBetRaces);

  // --- Calibration + favourite ----------------------------------------------
  const modelSamples: CalibrationSample[] = [];
  const marketSamples: CalibrationSample[] = [];
  let favouriteRaces = 0;
  let favouriteWins = 0;
  const modelRanks: number[] = [];
  const marketRanks: number[] = [];
  const agree = { races: 0, both: 0, model_only: 0, market_only: 0, neither: 0 };
  for (const race of settledWithRun) {
    for (const r of race.runners) {
      const won: 0 | 1 = r.finish_pos === 1 ? 1 : 0;
      if (typeof r.model_prob === 'number') modelSamples.push({ prob: r.model_prob, outcome: won });
      if (typeof r.market_prob === 'number') marketSamples.push({ prob: r.market_prob, outcome: won });
    }
    const fav = marketFavourite(race);
    if (fav) {
      favouriteRaces += 1;
      if (fav.runner_id === race.winner_runner_id) favouriteWins += 1;
    }
    const mRank = winnerRank(race, (r) => r.model_prob);
    const kRank = winnerRank(race, (r) => r.market_prob);
    if (mRank !== null) modelRanks.push(mRank);
    if (kRank !== null) marketRanks.push(kRank);
    if (mRank !== null && kRank !== null) {
      agree.races += 1;
      const m1 = mRank === 1;
      const k1 = kRank === 1;
      if (m1 && k1) agree.both += 1;
      else if (m1) agree.model_only += 1;
      else if (k1) agree.market_only += 1;
      else agree.neither += 1;
    }
  }
  const modelCalibration = calibrateBinary(modelSamples);
  const marketCalibration = calibrateBinary(marketSamples);

  // --- Segments --------------------------------------------------------------
  const confEntries = withRun.filter((r) => r.pick).map((r) => ({ key: confidenceBandKey(r.pick!.confidence_label), outcome: outcomeForPick(r) }));
  const courseEntries = withRun.filter((r) => r.pick).map((r) => ({ key: (r.course ?? 'unknown').trim() || 'unknown', outcome: outcomeForPick(r) }));
  const oddsEntries = withRun.filter((r) => r.pick).map((r) => ({
    key: typeof r.pick!.odds === 'number' && Number.isFinite(r.pick!.odds) && r.pick!.odds > 0 ? bandOf(r.pick!.odds) : 'ODDS_UNKNOWN',
    outcome: outcomeForPick(r),
  }));
  const evEntries = withRun.filter((r) => r.pick).map((r) => {
    const ev = r.pick!.ev;
    const key = typeof ev !== 'number' || !Number.isFinite(ev) ? 'EV_UNKNOWN' : ev > 0 ? 'EV_POSITIVE' : 'EV_NON_POSITIVE';
    return { key, outcome: outcomeForPick(r) };
  });

  const notMeasured: string[] = [];
  const notes: string[] = [];

  // --- Descriptive signals (NEVER gate the verdict) --------------------------
  const settledDecisions = decisionPerformance.settled_count;

  let marketComparison: MarketComparison = 'unavailable';
  if (modelCalibration.brier !== null && marketCalibration.brier !== null &&
      modelCalibration.sufficientSample && marketCalibration.sufficientSample) {
    marketComparison = modelCalibration.brier < marketCalibration.brier ? 'model_better'
      : modelCalibration.brier === marketCalibration.brier ? 'model_equal' : 'model_worse';
  }

  const high = segmentBands(confEntries, ['HIGH', 'MEDIUM', 'LOW', 'UNLABELLED']).find((b) => b.label === 'HIGH')?.performance;
  const low = segmentBands(confEntries, ['HIGH', 'MEDIUM', 'LOW', 'UNLABELLED']).find((b) => b.label === 'LOW')?.performance;
  const evPos = segmentBands(evEntries, ['EV_POSITIVE', 'EV_NON_POSITIVE', 'EV_UNKNOWN']).find((b) => b.label === 'EV_POSITIVE')?.performance;

  const descriptive = {
    model_calibration_quality: (modelCalibration.sufficientSample && modelCalibration.ece !== null
      ? (modelCalibration.ece <= 0.05 ? 'favourable' : 'unfavourable')
      : 'not_measured') as DescriptiveSignal,
    market_comparison: (marketComparison === 'unavailable' ? 'not_measured'
      : marketComparison === 'model_worse' ? 'unfavourable' : 'favourable') as DescriptiveSignal,
    decision_roi_sign: (settledDecisions >= MIN_SETTLED_DECISIONS
      ? (decisionPerformance.roi >= 0 ? 'favourable' : 'unfavourable')
      : 'not_measured') as DescriptiveSignal,
    confidence_ordering: (high && low && high.settled_count >= MIN_SETTLED_DECISIONS && low.settled_count >= MIN_SETTLED_DECISIONS
      ? (high.strike_rate >= low.strike_rate ? 'favourable' : 'unfavourable')
      : 'not_measured') as DescriptiveSignal,
    ev_honesty: (evPos && evPos.settled_count >= MIN_EV_HONESTY_SAMPLE
      ? (evPos.roi >= 0 ? 'favourable' : 'unfavourable')
      : 'not_measured') as DescriptiveSignal,
  };

  // --- Explicit NOT MEASURED (schema cannot support / separate layer) --------
  notMeasured.push('official locked-decision layer (evaluated separately by report:locked; kept separate from the diagnostic scorecard)');
  notMeasured.push('market-baseline ROI (stored market_prob is an implied probability, not a tradeable price)');
  notMeasured.push('segmentation by handicap / field-size / country (the SELECT does not fetch these stored fields; the fix is to add reliable stored fields, else leave NOT MEASURED — never inferred from strings)');
  notMeasured.push('exact each-way validation (place count / fraction / applicable price / settled-runner / non-runner / dead-heat terms are not stored)');
  notMeasured.push('chronological maximum drawdown (per-bet chronological ordering is not established in this range aggregation)');
  if (!modelCalibration.sufficientSample) {
    notMeasured.push(`model calibration reliability (only ${modelCalibration.n} runner-samples; need >= ${MIN_CALIBRATION_SAMPLES})`);
  }
  if (settledDecisions < MIN_SETTLED_DECISIONS) {
    notMeasured.push(`decision-quality description (only ${settledDecisions} settled decisions; need >= ${MIN_SETTLED_DECISIONS})`);
  }

  notes.push('Verdict is an EVIDENCE-QUALITY judgement (completeness / boundary / thresholds / invariants) — NOT profitability and NOT a model-beats-market test. Model-vs-market and all quality signals are descriptive only.');
  notes.push('Diagnostic pre-off layer only; the official locked-decision history is separate (report:locked). Decision-support usefulness only — no bet is placed and no betting capability exists here.');

  const notMeasuredBlock = (reason: string): NotMeasuredBlock => ({ measured: false, reason });

  const partial: Omit<PreOffValidationReport, 'invariant_violations' | 'verdict' | 'notes'> = {
    schema_version: PRE_OFF_VALIDATION_SCHEMA_VERSION,
    from: meta.from,
    to: meta.to,
    course: meta.course,
    generated_at: meta.generatedAtIso,
    read_only: true,
    database_mutated: false,
    layer: 'diagnostic',
    coverage: {
      races_in_scope: races.length,
      races_with_pre_off_run: withRun.length,
      settled_races_with_pre_off_run: settledWithRun.length,
      pending_races_with_pre_off_run: withRun.length - settledWithRun.length,
      races_without_pre_off_run: races.length - withRun.length,
      read_errors: readErrors,
    },
    ranking: {
      measured: modelRanks.length > 0,
      model: rankingAccuracy(modelRanks),
      market: rankingAccuracy(marketRanks),
      agreement: agree,
    },
    decision_performance: decisionPerformance,
    model_calibration: modelCalibration,
    market_baseline: {
      calibration: marketCalibration,
      favourite_races: favouriteRaces,
      favourite_wins: favouriteWins,
      favourite_strike_rate: favouriteRaces > 0 ? (favouriteWins / favouriteRaces) * 100 : null,
      roi_measured: false,
    },
    model_vs_market_calibration: marketComparison,
    segments: {
      by_confidence: segmentBands(confEntries, ['HIGH', 'MEDIUM', 'LOW', 'UNLABELLED']),
      by_course: segmentBands(courseEntries),
      by_odds_band: segmentBands(oddsEntries, ['<3.0', '3.0-8.0', '>8.0', 'ODDS_UNKNOWN']),
      by_ev: segmentBands(evEntries, ['EV_POSITIVE', 'EV_NON_POSITIVE', 'EV_UNKNOWN']),
      by_handicap: notMeasuredBlock('handicap flag not fetched by the SELECT (never inferred from strings)'),
      by_field_size: notMeasuredBlock('field-size band not derived in this slice'),
      by_country: notMeasuredBlock('country not fetched by the SELECT (never inferred from strings)'),
    },
    official_locked_layer: notMeasuredBlock('official locked_race_decisions are evaluated by report:locked; this diagnostic scorecard keeps the layers separate'),
    each_way: notMeasuredBlock('each-way terms (place count/fraction/price/dead-heat/non-runner) are not stored'),
    chronological_drawdown: notMeasuredBlock('reliable per-bet chronological ordering is not established here'),
    descriptive_signals: descriptive,
    not_measured: notMeasured,
  };

  // --- Invariants -> verdict (evidence quality only) -------------------------
  const invariantViolations = checkPreOffInvariants(partial, races);

  let verdict: OverallVerdict;
  if (invariantViolations.length > 0) {
    verdict = 'FAIL';
  } else if (readErrors > 0) {
    verdict = 'REVIEW'; // scoped races unread -> evidence incomplete, non-fatal
    notes.push(`${readErrors} scoped race(s) could not be read; evidence is incomplete for this range.`);
  } else if (settledDecisions < MIN_SETTLED_DECISIONS || !modelCalibration.sufficientSample) {
    verdict = 'INSUFFICIENT_EVIDENCE';
  } else {
    verdict = 'PASS';
  }

  return { ...partial, invariant_violations: invariantViolations, verdict, notes };
}

/* -------------------------------------------------------------------------- */
/* Rendering (deterministic; no secrets)                                      */
/* -------------------------------------------------------------------------- */

function pct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)}%`;
}
function num(v: number | null): string {
  return v === null ? '—' : String(Math.round(v * 10000) / 10000);
}

/** One NOT-MEASURED limitation for rendering: an optional typed label + detail. */
export interface CanonicalLimitation {
  label: string | null;
  detail: string;
}

/**
 * Maps a free-text `not_measured` entry to a stable LOGICAL key, so a vaguer
 * duplicate can be deduped against the canonical typed-block explanation. Pure.
 */
function classifyLimitation(nm: string): string {
  const s = nm.toLowerCase();
  if (s.includes('official locked')) return 'official_locked_layer';
  if (s.includes('each-way')) return 'each_way';
  if (s.includes('drawdown')) return 'chronological_drawdown';
  if (s.includes('handicap') || s.includes('field-size') || s.includes('country')) return 'segmentation_umbrella';
  if (s.includes('market-baseline roi')) return 'market_roi';
  return nm; // unique by content (e.g. sample-based reliability / decision-quality)
}

/**
 * The single, deterministic, DEDUPLICATED list of NOT-MEASURED limitations for
 * rendering — each logical dimension exactly once, preferring the detailed
 * typed-block explanation over any vaguer `not_measured` duplicate. It does NOT
 * mutate the evidence object (the JSON `not_measured` array stays complete); it
 * only canonicalises at the rendering boundary. Pure.
 */
export function canonicalLimitations(r: PreOffValidationReport): CanonicalLimitation[] {
  const out: CanonicalLimitation[] = [];
  const seen = new Set<string>();
  const add = (key: string, label: string | null, detail: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label, detail });
  };
  // Canonical typed dimensions first (most detailed), in a fixed order.
  add('official_locked_layer', 'Official locked-decision layer', r.official_locked_layer.reason);
  add('each_way', 'Each-way', r.each_way.reason);
  add('chronological_drawdown', 'Chronological drawdown', r.chronological_drawdown.reason);
  add('segmentation_handicap', 'Segmentation by handicap', r.segments.by_handicap.reason);
  add('segmentation_field_size', 'Segmentation by field size', r.segments.by_field_size.reason);
  add('segmentation_country', 'Segmentation by country', r.segments.by_country.reason);
  // The combined handicap/field-size/country string in `not_measured` is a vaguer
  // duplicate of the three specific blocks above — mark its umbrella key seen.
  seen.add('segmentation_umbrella');
  // Dynamic evidence-object limitations (market ROI, sample-based), deduped.
  for (const nm of r.not_measured) add(classifyLimitation(nm), null, nm);
  return out;
}

function renderLimitationMarkdown(l: CanonicalLimitation): string {
  return l.label ? `- **${l.label}** — ${l.detail}.` : `- ${l.detail}`;
}
function renderLimitationConsole(l: CanonicalLimitation): string {
  return l.label ? `  - ${l.label}: ${l.detail}` : `  - ${l.detail}`;
}

export function renderPreOffValidationConsole(r: PreOffValidationReport): string[] {
  const lines: string[] = [];
  lines.push(`Pre-off decision-support validation (DIAGNOSTIC layer) — ${r.from} to ${r.to} — ${r.course ?? 'all courses'}`);
  lines.push('READ ONLY / AS-OF OFF — stored evidence only; no model re-score, no database mutation.');
  lines.push('');
  lines.push(`Evidence-quality verdict: ${r.verdict}`);
  if (r.invariant_violations.length > 0) {
    lines.push('INVARIANT VIOLATIONS (verdict = FAIL):');
    for (const v of r.invariant_violations) lines.push(`  - ${v}`);
  }
  lines.push('');
  const c = r.coverage;
  lines.push(`Coverage: scope ${c.races_in_scope} · pre-off run ${c.races_with_pre_off_run} · settled ${c.settled_races_with_pre_off_run} · no run ${c.races_without_pre_off_run} · read errors ${c.read_errors}`);
  const rk = r.ranking;
  lines.push(`Ranking (winner in top-K): model ${pct(rk.model.top1)}/${pct(rk.model.top2)}/${pct(rk.model.top3)} (n=${rk.model.races}) · market ${pct(rk.market.top1)}/${pct(rk.market.top2)}/${pct(rk.market.top3)} (n=${rk.market.races})`);
  lines.push(`  agreement (top-1): both ${rk.agreement.both} · model-only ${rk.agreement.model_only} · market-only ${rk.agreement.market_only} · neither ${rk.agreement.neither} (n=${rk.agreement.races})`);
  const d = r.decision_performance;
  lines.push(`Decision (pre-off rank-1 picks): settled ${d.settled_count} · strike ${pct(d.strike_rate)} · ROI ${pct(d.roi)} · P/L ${num(d.profit_loss)} · no-bet ${d.no_bet_races}`);
  const m = r.model_calibration;
  const mk = r.market_baseline.calibration;
  lines.push(`Calibration model: n ${m.n} · Brier ${num(m.brier)} · logLoss ${num(m.logLoss)} · ECE ${num(m.ece)} · exp ${num(m.meanPredicted)} vs obs ${num(m.meanObserved)}`);
  lines.push(`Calibration market: n ${mk.n} · Brier ${num(mk.brier)} · favourite strike ${pct(r.market_baseline.favourite_strike_rate)} · market ROI NOT MEASURED`);
  lines.push(`Model vs market calibration (descriptive): ${r.model_vs_market_calibration}`);
  lines.push('');
  lines.push('Descriptive signals (NOT gating the verdict):');
  for (const [k, val] of Object.entries(r.descriptive_signals)) lines.push(`  ${k.padEnd(26)} ${val}`);
  lines.push('');
  lines.push('NOT MEASURED (each logical dimension once):');
  for (const lim of canonicalLimitations(r)) lines.push(renderLimitationConsole(lim));
  lines.push('');
  for (const note of r.notes) lines.push(note);
  return lines;
}

function bandTable(title: string, bands: BandPerformance[]): string[] {
  const out = [`### ${title}`, '', '| Band | Settled | Strike | ROI | Avg EV |', '| --- | --- | --- | --- | --- |'];
  if (bands.length === 0) out.push('| (none) | — | — | — | — |');
  for (const b of bands) {
    const p = b.performance;
    const thin = p.settled_count > 0 && p.settled_count < 30 ? ' _(insufficient)_' : '';
    out.push(`| ${b.label}${thin} | ${p.settled_count} | ${pct(p.strike_rate)} | ${pct(p.roi)} | ${num(p.average_ev)} |`);
  }
  out.push('');
  return out;
}

export function renderPreOffValidationMarkdown(r: PreOffValidationReport): string {
  const L: string[] = [];
  L.push(`# Pre-off decision-support validation — ${r.from} to ${r.to} — ${r.course ?? 'all courses'}`);
  L.push('');
  L.push(`Generated: ${r.generated_at}`);
  L.push('');
  L.push('**READ ONLY / AS-OF OFF.** Built from STORED evidence only (per-runner `model_prob`/`market_prob`,');
  L.push('stored rank-1 recommendations, recorded finishing positions). No model was run or re-scored; no odds');
  L.push('were fetched; no results were imported; no database row was mutated. This is the DIAGNOSTIC pre-off');
  L.push('layer; the official locked-decision history is evaluated separately (`report:locked`).');
  L.push('');
  L.push(`- Scope: ${r.course ?? 'all courses'}, ${r.from} → ${r.to}`);
  L.push(`- Schema version: ${r.schema_version}`);
  L.push(`- **Evidence-quality verdict: ${r.verdict}**`);
  L.push('');
  if (r.invariant_violations.length > 0) {
    L.push('## Invariant violations (verdict = FAIL)');
    L.push('');
    for (const v of r.invariant_violations) L.push(`- ${v}`);
    L.push('');
  }
  const c = r.coverage;
  L.push('## Coverage');
  L.push('');
  L.push('| Metric | Value |');
  L.push('| --- | --- |');
  L.push(`| Races in scope | ${c.races_in_scope} |`);
  L.push(`| With a pre-off run | ${c.races_with_pre_off_run} |`);
  L.push(`| Settled (with pre-off run) | ${c.settled_races_with_pre_off_run} |`);
  L.push(`| Pending (with pre-off run) | ${c.pending_races_with_pre_off_run} |`);
  L.push(`| No pre-off run | ${c.races_without_pre_off_run} |`);
  L.push(`| Read errors | ${c.read_errors} |`);
  L.push('');
  const rk = r.ranking;
  L.push('## Ranking (does the model rank the winner highly?)');
  L.push('');
  L.push('| Series | n | Top-1 | Top-2 | Top-3 |');
  L.push('| --- | --- | --- | --- | --- |');
  L.push(`| model_prob | ${rk.model.races} | ${pct(rk.model.top1)} | ${pct(rk.model.top2)} | ${pct(rk.model.top3)} |`);
  L.push(`| market_prob | ${rk.market.races} | ${pct(rk.market.top1)} | ${pct(rk.market.top2)} | ${pct(rk.market.top3)} |`);
  L.push('');
  L.push(`Top-1 agreement (n=${rk.agreement.races}): both ${rk.agreement.both}, model-only ${rk.agreement.model_only}, market-only ${rk.agreement.market_only}, neither ${rk.agreement.neither}. Ties resolved deterministically by runner id.`);
  L.push('');
  const d = r.decision_performance;
  L.push('## Diagnostic pre-off decision performance');
  L.push('');
  L.push('_Stored diagnostic rank-1 recommendations (NOT official locked decisions — those come only from `locked_race_decisions` and are evaluated separately by `report:locked`)._');
  L.push('');
  L.push('| Settled | Winners | Strike | ROI | P/L | No-bet | Avg EV |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  L.push(`| ${d.settled_count} | ${d.winners} | ${pct(d.strike_rate)} | ${pct(d.roi)} | ${num(d.profit_loss)} | ${d.no_bet_races} | ${num(d.average_ev)} |`);
  L.push('');
  L.push('_Diagnostic P/L uses STORED recommendation odds/stake only; a win pays `stake*(odds-1)`, a loss `-stake`; pending races are never losses. Not betting advice._');
  L.push('');
  L.push('## Probability calibration');
  L.push('');
  L.push('| Series | n | Brier | logLoss | ECE | MCE | mean pred | mean obs |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  const m = r.model_calibration;
  const mk = r.market_baseline.calibration;
  L.push(`| model_prob | ${m.n} | ${num(m.brier)} | ${num(m.logLoss)} | ${num(m.ece)} | ${num(m.mce)} | ${num(m.meanPredicted)} | ${num(m.meanObserved)} |`);
  L.push(`| market_prob (baseline) | ${mk.n} | ${num(mk.brier)} | ${num(mk.logLoss)} | ${num(mk.ece)} | ${num(mk.mce)} | ${num(mk.meanPredicted)} | ${num(mk.meanObserved)} |`);
  L.push('');
  L.push(`Market favourite strike: ${pct(r.market_baseline.favourite_strike_rate)} (${r.market_baseline.favourite_wins}/${r.market_baseline.favourite_races}). ` +
    `**Market ROI: NOT MEASURED** (no tradeable stored price). Model-vs-market calibration (descriptive, non-gating): **${r.model_vs_market_calibration}**.`);
  L.push('');
  L.push('### Model reliability diagram');
  L.push('');
  L.push('| Bin | Range | Pred mean | Obs rate | n |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const b of m.bins) L.push(`| ${b.bin} | ${b.lo}–${b.hi} | ${num(b.predMean)} | ${num(b.obsRate)} | ${b.n} |`);
  L.push('');
  L.push('## Segments');
  L.push('');
  L.push(...bandTable('By confidence', r.segments.by_confidence));
  L.push(...bandTable('By course', r.segments.by_course));
  L.push(...bandTable('By odds band', r.segments.by_odds_band));
  L.push(...bandTable('By stored-EV sign', r.segments.by_ev));
  L.push('_Small segments are shown and flagged `(insufficient)`, never silently dropped._');
  L.push('');
  L.push('## Layers / dimensions NOT MEASURED');
  L.push('');
  L.push('_Each logical limitation appears exactly once (the JSON `not_measured` array remains complete)._');
  L.push('');
  for (const lim of canonicalLimitations(r)) L.push(renderLimitationMarkdown(lim));
  L.push('');
  L.push('## Descriptive signals (NOT part of the verdict)');
  L.push('');
  L.push('| Signal | Finding |');
  L.push('| --- | --- |');
  for (const [k, v] of Object.entries(r.descriptive_signals)) L.push(`| ${k} | ${v} |`);
  L.push('');
  L.push('_These describe the model; the PASS/REVIEW/INSUFFICIENT/FAIL verdict does NOT depend on them, on ROI, or on the model beating the market._');
  L.push('');
  L.push('## Notes & honesty');
  L.push('');
  for (const note of r.notes) L.push(`- ${note}`);
  L.push('');
  L.push('Decision-support only — no bet was placed and no betting capability exists here.');
  L.push('');
  return L.join('\n');
}
