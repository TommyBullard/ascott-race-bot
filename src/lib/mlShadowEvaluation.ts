/**
 * Pure helpers for the OFFLINE ML shadow-evaluation baseline
 * (scripts/mlEvaluate.ts). Phase 7 of the autonomous race-day workflow.
 *
 * This reads the existing `export:training-data` CSV and produces a deterministic
 * evaluation report comparing a market-only baseline, the current rules/model
 * signals, and a few simple shadow-score baselines. It TRAINS NOTHING, persists
 * nothing, and is strictly DECISION-SUPPORT / SHADOW: no ML model is made active,
 * no live recommendation or stake changes, and no edge is claimed.
 *
 * Everything here is pure and deterministic: CSV parsing, the leakage check,
 * grouping, the baseline picks, the metrics (Brier, log loss, calibration), and
 * the Markdown rendering. There is no database access, no network, no external ML
 * library, and no mutation. Nothing is fabricated: missing values are null/unknown
 * and render as an em dash. Result/label columns are used as LABELS only and are
 * forbidden from the feature set (a leakage check enforces this).
 */

import {
  summarizeModelPerformance,
  type RecommendationOutcome,
} from './modelPerformance';
import { LABEL_COLUMNS } from './trainingExport';

const DASH = '\u2014';

/** Minimum settled races before any evaluation could be taken seriously. */
export const MIN_SAMPLE_RACES = 100;

/**
 * Columns that must NEVER appear in the feature set (post-race / outcome /
 * payout leakage). They may be used as labels / analysis outputs only.
 */
export const LEAKAGE_COLUMNS: readonly string[] = [
  'finish_pos',
  'won',
  'placed',
  'sp_decimal',
  'bsp_decimal',
  'result',
  'winner',
  'post_off',
  'final_position',
  'payout',
  'profit_loss',
];

/**
 * Columns that — if present — let us identify the PERSISTED production
 * recommendation (and its stake) per race. The standard training-data export
 * carries none of these, so the persisted-recommendation baseline is reported as
 * unavailable rather than fabricated.
 */
export const PERSISTED_RECOMMENDATION_COLUMNS: readonly string[] = [
  'is_recommendation',
  'recommended',
  'recommendation_rank',
  'recommendation_type',
  'stake_amount',
];

/**
 * Shown wherever a shadow model baseline could be mistaken for the live betting
 * record. Production recommendations are EV/stake driven and gated — they are
 * NOT simply `model_rank_pre_off = 1`.
 */
export const NOT_PRODUCTION_RECORD_NOTE =
  'This is not the production recommendation record. Production recommendation ' +
  'performance is reported separately by /api/accuracy performance.';

/** Shown when the export lacks the fields to identify persisted recommendations. */
export const PERSISTED_RECOMMENDATION_UNAVAILABLE_NOTE =
  'Persisted recommendation baseline: unavailable in this export; use ' +
  '/api/accuracy performance or report:day.';

/* -------------------------------------------------------------------------- */
/* CSV parsing (RFC 4180, pure)                                               */
/* -------------------------------------------------------------------------- */

/** A parsed CSV: the header plus one record object per data row. */
export interface ParsedCsv {
  header: string[];
  rows: Record<string, string>[];
}

/**
 * Parses RFC 4180 CSV text: quoted fields, embedded commas/quotes/newlines, and
 * doubled quotes. Returns the header and one record per row (missing trailing
 * cells become empty strings). Pure; tolerant of CRLF and a trailing newline.
 */
export function parseCsv(text: string): ParsedCsv {
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let started = false; // whether the current row has any content

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      started = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
      started = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (started || field !== '' || row.length > 0) {
        row.push(field);
        records.push(row);
      }
      field = '';
      row = [];
      started = false;
    } else {
      field += c;
      started = true;
    }
  }
  if (started || field !== '' || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  if (records.length === 0) return { header: [], rows: [] };
  const header = records[0];
  const rows = records.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => {
      obj[h] = r[idx] ?? '';
    });
    return obj;
  });
  return { header, rows };
}

/* -------------------------------------------------------------------------- */
/* Leakage check                                                              */
/* -------------------------------------------------------------------------- */

/** The result of the feature/label split + leakage check. */
export interface LeakageCheck {
  feature_columns: string[];
  label_columns: string[];
  /** Feature columns that are actually leakage (post-race) columns. */
  leakage_violations: string[];
  status: 'PASS' | 'FAIL';
}

/**
 * Splits the header into labels (the known export label columns present) and
 * features (everything else), then flags any feature column that is a known
 * leakage column. PASS only when no leakage column is used as a feature. Pure.
 */
export function checkLeakage(header: readonly string[]): LeakageCheck {
  const labelSet = new Set<string>(LABEL_COLUMNS);
  const leakageSet = new Set<string>(LEAKAGE_COLUMNS);
  const label_columns = header.filter((h) => labelSet.has(h));
  const feature_columns = header.filter((h) => !labelSet.has(h));
  const leakage_violations = feature_columns.filter((h) => leakageSet.has(h));
  return {
    feature_columns,
    label_columns,
    leakage_violations,
    status: leakage_violations.length === 0 ? 'PASS' : 'FAIL',
  };
}

/* -------------------------------------------------------------------------- */
/* Typed rows + grouping                                                      */
/* -------------------------------------------------------------------------- */

/** A typed runner row (numeric coercion; missing -> null, never fabricated). */
export interface RunnerRow {
  race_id: string;
  runner_id: string;
  race_date: string | null;
  course: string | null;
  pre_off_odds: number | null;
  model_prob: number | null;
  model_rank: number | null;
  ev: number | null;
  confidence: number | null;
  won: boolean | null;
  placed: boolean | null;
  finish_pos: number | null;
  // Persisted-recommendation identifiers (absent in the standard export -> null).
  is_recommendation: boolean | null;
  recommendation_rank: number | null;
  stake_amount: number | null;
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

/** Coerces parsed CSV rows into typed {@link RunnerRow}s. Pure. */
export function parseRunnerRows(parsed: ParsedCsv): RunnerRow[] {
  return parsed.rows.map((r) => ({
    race_id: strOrNull(r.race_id) ?? '',
    runner_id: strOrNull(r.runner_id) ?? '',
    race_date: strOrNull(r.race_date),
    course: strOrNull(r.course),
    pre_off_odds: numOrNull(r.pre_off_odds),
    model_prob: numOrNull(r.model_prob_pre_off),
    model_rank: numOrNull(r.model_rank_pre_off),
    ev: numOrNull(r.ev_pre_off),
    confidence: numOrNull(r.confidence),
    won: bool01OrNull(r.won),
    placed: bool01OrNull(r.placed),
    finish_pos: numOrNull(r.finish_pos),
    is_recommendation: bool01OrNull(r.is_recommendation ?? r.recommended),
    recommendation_rank: numOrNull(r.recommendation_rank),
    stake_amount: numOrNull(r.stake_amount),
  }));
}

/** Groups rows by race_id, preserving first-seen order. Pure. */
export function groupByRace(rows: readonly RunnerRow[]): Map<string, RunnerRow[]> {
  const map = new Map<string, RunnerRow[]>();
  for (const row of rows) {
    const list = map.get(row.race_id);
    if (list) list.push(row);
    else map.set(row.race_id, [row]);
  }
  return map;
}

/** A race has a result when some runner is recorded as a winner. */
function raceSettled(rows: readonly RunnerRow[]): boolean {
  return rows.some((r) => r.won === true);
}

/* -------------------------------------------------------------------------- */
/* Baseline picks (pure)                                                      */
/* -------------------------------------------------------------------------- */

/** Picks the shortest-priced runner (market favourite). Tie-break by id. */
export function pickMarketFavourite(rows: readonly RunnerRow[]): RunnerRow | null {
  return (
    rows
      .filter((r) => r.pre_off_odds != null && r.pre_off_odds > 1)
      .slice()
      .sort((a, b) => a.pre_off_odds! - b.pre_off_odds! || a.runner_id.localeCompare(b.runner_id))[0] ?? null
  );
}

/** Picks model_rank_pre_off === 1, else the highest model probability. */
export function pickModelRank(rows: readonly RunnerRow[]): RunnerRow | null {
  const ranked = rows.find((r) => r.model_rank === 1);
  if (ranked) return ranked;
  return (
    rows
      .filter((r) => r.model_prob != null)
      .slice()
      .sort((a, b) => b.model_prob! - a.model_prob! || a.runner_id.localeCompare(b.runner_id))[0] ?? null
  );
}

/** Picks the highest exported EV. Tie-break by id. */
export function pickHighestEv(rows: readonly RunnerRow[]): RunnerRow | null {
  return (
    rows
      .filter((r) => r.ev != null)
      .slice()
      .sort((a, b) => b.ev! - a.ev! || a.runner_id.localeCompare(b.runner_id))[0] ?? null
  );
}

/* -------------------------------------------------------------------------- */
/* Persisted production recommendation (only if the export carries it)        */
/* -------------------------------------------------------------------------- */

/** Whether the export carries fields to identify the persisted recommendation. */
export interface PersistedRecommendationAvailability {
  available: boolean;
  columns_found: string[];
  has_stake: boolean;
}

/**
 * Detects whether the export has the columns needed to identify the PERSISTED
 * production recommendation (a recommendation flag/rank), and whether a stake
 * column is present. The standard training-data export carries none of these,
 * so this normally reports `available: false`. Pure.
 */
export function detectPersistedRecommendation(
  header: readonly string[],
): PersistedRecommendationAvailability {
  const present = new Set(header);
  const columns_found = PERSISTED_RECOMMENDATION_COLUMNS.filter((c) => present.has(c));
  const available =
    present.has('is_recommendation') || present.has('recommended') || present.has('recommendation_rank');
  return { available, columns_found, has_stake: present.has('stake_amount') };
}

/**
 * Picks the persisted production recommendation for a race when the export
 * carries it: a `recommendation_rank === 1` row, else a flagged
 * `is_recommendation` row. Returns null when neither is present. Pure.
 */
export function pickPersistedRecommendation(rows: readonly RunnerRow[]): RunnerRow | null {
  const ranked = rows.find((r) => r.recommendation_rank === 1);
  if (ranked) return ranked;
  return rows.find((r) => r.is_recommendation === true) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Baseline performance (reuses summarizeModelPerformance)                    */
/* -------------------------------------------------------------------------- */

/** A baseline's flat-stake (1 unit) evaluation over its per-race picks. */
export interface BaselineResult {
  id: string;
  name: string;
  description: string;
  races_with_pick: number;
  settled: number;
  winners: number;
  strike_rate: number;
  roi: number;
  profit_loss: number;
}

function toOutcome(pick: RunnerRow): RecommendationOutcome {
  // Flat 1-unit stake at the pre-off odds; settled iff the race result is known.
  return { settled: pick.won != null, won: pick.won === true, odds: pick.pre_off_odds, stake: 1, ev: pick.ev };
}

/** Builds a baseline result from its per-race picks. Pure. */
export function buildBaselineResult(
  id: string,
  name: string,
  description: string,
  picks: readonly RunnerRow[],
): BaselineResult {
  const perf = summarizeModelPerformance(picks.map(toOutcome));
  return {
    id,
    name,
    description,
    races_with_pick: picks.length,
    settled: perf.settled_count,
    winners: perf.winners,
    strike_rate: perf.strike_rate,
    roi: perf.roi,
    profit_loss: perf.profit_loss,
  };
}

/** A flat or staked recommendation outcome (uses stake_amount when present). */
function toRecommendationOutcome(pick: RunnerRow): RecommendationOutcome {
  const stake = pick.stake_amount != null && pick.stake_amount > 0 ? pick.stake_amount : 1;
  return { settled: pick.won != null, won: pick.won === true, odds: pick.pre_off_odds, stake, ev: pick.ev };
}

/** The persisted-recommendation section: available + computed, or unavailable. */
export interface PersistedRecommendationReport {
  available: boolean;
  columns_found: string[];
  has_stake: boolean;
  baseline: BaselineResult | null;
}

/**
 * Builds the persisted production-recommendation baseline ONLY when the export
 * carries the identifying columns; otherwise returns `available: false` with no
 * fabricated numbers (callers render the "use /api/accuracy performance or
 * report:day" note instead). Reuses summarizeModelPerformance. Pure.
 */
export function buildPersistedRecommendationReport(
  racesMap: ReadonlyMap<string, RunnerRow[]>,
  header: readonly string[],
): PersistedRecommendationReport {
  const availability = detectPersistedRecommendation(header);
  if (!availability.available) {
    return {
      available: false,
      columns_found: availability.columns_found,
      has_stake: availability.has_stake,
      baseline: null,
    };
  }
  const picks = [...racesMap.values()]
    .map(pickPersistedRecommendation)
    .filter((p): p is RunnerRow => p !== null);
  const perf = summarizeModelPerformance(picks.map(toRecommendationOutcome));
  const baseline: BaselineResult = {
    id: 'persisted_recommendation',
    name: 'Persisted recommendation baseline',
    description: availability.has_stake
      ? 'Exported persisted production recommendation per race, staked by stake_amount.'
      : 'Exported persisted production recommendation per race (flat 1 unit; no stake_amount column).',
    races_with_pick: picks.length,
    settled: perf.settled_count,
    winners: perf.winners,
    strike_rate: perf.strike_rate,
    roi: perf.roi,
    profit_loss: perf.profit_loss,
  };
  return {
    available: true,
    columns_found: availability.columns_found,
    has_stake: availability.has_stake,
    baseline,
  };
}

/* -------------------------------------------------------------------------- */
/* Probability quality: Brier, log loss, calibration (pure)                   */
/* -------------------------------------------------------------------------- */

/** One probability prediction paired with its 0/1 outcome. */
export interface Prediction {
  p: number;
  won: number;
}

/**
 * Per-race normalised market-implied predictions over SETTLED races only:
 * `p = (1/odds) / Σ(1/odds)` for priced runners, with `won` = 1 for the winner.
 * Pure.
 */
export function marketImpliedPredictions(racesMap: ReadonlyMap<string, RunnerRow[]>): Prediction[] {
  const preds: Prediction[] = [];
  for (const rows of racesMap.values()) {
    if (!raceSettled(rows)) continue;
    const priced = rows.filter((r) => r.pre_off_odds != null && r.pre_off_odds > 1);
    const sumImplied = priced.reduce((s, r) => s + 1 / r.pre_off_odds!, 0);
    if (sumImplied <= 0) continue;
    for (const r of priced) {
      preds.push({ p: 1 / r.pre_off_odds! / sumImplied, won: r.won === true ? 1 : 0 });
    }
  }
  return preds;
}

/** Brier score = mean((p − won)^2). Null for an empty set. Pure. */
export function brierScore(preds: readonly Prediction[]): number | null {
  if (preds.length === 0) return null;
  let sum = 0;
  for (const { p, won } of preds) sum += (p - won) ** 2;
  return sum / preds.length;
}

/** Log loss with probability clamping (handles p = 0 / 1 safely). Pure. */
export function logLoss(preds: readonly Prediction[], eps = 1e-15): number | null {
  if (preds.length === 0) return null;
  let sum = 0;
  for (const { p, won } of preds) {
    const cp = Math.min(Math.max(p, eps), 1 - eps);
    sum += won * Math.log(cp) + (1 - won) * Math.log(1 - cp);
  }
  return -sum / preds.length;
}

/** One calibration bucket: predicted-probability range vs actual win rate. */
export interface CalibrationBucket {
  range: string;
  count: number;
  mean_predicted: number | null;
  actual_rate: number | null;
}

/** Bins predictions into `nBuckets` equal-width probability buckets. Pure. */
export function calibrationBuckets(preds: readonly Prediction[], nBuckets = 5): CalibrationBucket[] {
  const buckets = Array.from({ length: nBuckets }, (_, i) => ({
    lower: i / nBuckets,
    upper: (i + 1) / nBuckets,
    count: 0,
    sumP: 0,
    wins: 0,
  }));
  for (const { p, won } of preds) {
    let idx = Math.floor(p * nBuckets);
    if (idx < 0) idx = 0;
    if (idx >= nBuckets) idx = nBuckets - 1;
    buckets[idx].count += 1;
    buckets[idx].sumP += p;
    buckets[idx].wins += won;
  }
  return buckets.map((b) => ({
    range: `${b.lower.toFixed(2)}-${b.upper.toFixed(2)}`,
    count: b.count,
    mean_predicted: b.count > 0 ? b.sumP / b.count : null,
    actual_rate: b.count > 0 ? b.wins / b.count : null,
  }));
}

/* -------------------------------------------------------------------------- */
/* Odds-band + confidence-band performance (pure)                             */
/* -------------------------------------------------------------------------- */

/** Odds bands (matching the project's backtest convention). */
export function oddsBand(odds: number | null): string {
  if (odds == null || !Number.isFinite(odds)) return 'unknown';
  if (odds < 3.0) return '<3.0';
  if (odds <= 8.0) return '3.0-8.0';
  return '>8.0';
}

/** Confidence bands from the numeric confidence score (0..1, documented). */
export function confidenceBand(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'unknown';
  if (value < 0.34) return 'low';
  if (value < 0.67) return 'medium';
  return 'high';
}

/** A per-band strike/ROI breakdown. */
export interface BandRow {
  band: string;
  picks: number;
  settled: number;
  winners: number;
  strike_rate: number;
  roi: number;
}

const BAND_ORDER: Record<string, number> = {
  '<3.0': 0,
  '3.0-8.0': 1,
  '>8.0': 2,
  low: 0,
  medium: 1,
  high: 2,
  unknown: 9,
};

function bandRows(picks: readonly RunnerRow[], bandOf: (r: RunnerRow) => string): BandRow[] {
  const groups = new Map<string, RunnerRow[]>();
  for (const p of picks) {
    const b = bandOf(p);
    const list = groups.get(b);
    if (list) list.push(p);
    else groups.set(b, [p]);
  }
  return [...groups.entries()]
    .map(([band, list]) => {
      const perf = summarizeModelPerformance(list.map(toOutcome));
      return {
        band,
        picks: list.length,
        settled: perf.settled_count,
        winners: perf.winners,
        strike_rate: perf.strike_rate,
        roi: perf.roi,
      };
    })
    .sort((a, b) => (BAND_ORDER[a.band] ?? 5) - (BAND_ORDER[b.band] ?? 5) || a.band.localeCompare(b.band));
}

/** Odds-band performance for a set of picks. Pure. */
export function oddsBandPerformance(picks: readonly RunnerRow[]): BandRow[] {
  return bandRows(picks, (r) => oddsBand(r.pre_off_odds));
}

/** Confidence-band performance for a set of picks. Pure. */
export function confidenceBandPerformance(picks: readonly RunnerRow[]): BandRow[] {
  return bandRows(picks, (r) => confidenceBand(r.confidence));
}

/* -------------------------------------------------------------------------- */
/* Report assembly (pure)                                                     */
/* -------------------------------------------------------------------------- */

/** The full evaluation report payload. */
export interface MlEvaluationReport {
  input_path: string;
  generatedAt: string;
  leakage: LeakageCheck;
  race_count: number;
  runner_count: number;
  settled_race_count: number;
  dates: string[];
  courses: string[];
  baselines: BaselineResult[];
  brier: number | null;
  log_loss: number | null;
  calibration: CalibrationBucket[];
  odds_bands: BandRow[];
  confidence_bands: BandRow[];
  persisted_recommendation: PersistedRecommendationReport;
  sample_too_small: boolean;
}

/** Builds the full evaluation report from a parsed CSV. Pure; deterministic. */
export function buildMlEvaluationReport(
  parsed: ParsedCsv,
  inputPath: string,
  generatedAt: string,
): MlEvaluationReport {
  const leakage = checkLeakage(parsed.header);
  const rows = parseRunnerRows(parsed);
  const racesMap = groupByRace(rows);
  const races = [...racesMap.values()];
  const settledRaceCount = races.filter(raceSettled).length;

  const favPicks = races.map(pickMarketFavourite).filter((p): p is RunnerRow => p !== null);
  const modelPicks = races.map(pickModelRank).filter((p): p is RunnerRow => p !== null);
  const evPicks = races.map(pickHighestEv).filter((p): p is RunnerRow => p !== null);

  const baselines = [
    buildBaselineResult('market_favourite', 'Market favourite', 'Pick the shortest-priced runner per race.', favPicks),
    buildBaselineResult(
      'model_rank',
      'Model-rank baseline (not production recommendation)',
      'Pick model_rank_pre_off = 1 (else highest model_prob). Top model probability/rank only — NOT the persisted production recommendation.',
      modelPicks,
    ),
    buildBaselineResult('ev_highest', 'Highest EV', 'Pick the highest exported ev_pre_off per race.', evPicks),
  ];

  const preds = marketImpliedPredictions(racesMap);

  const dates = [...new Set(rows.map((r) => r.race_date).filter((d): d is string => d !== null))].sort();
  const courses = [...new Set(rows.map((r) => r.course).filter((c): c is string => c !== null))].sort();

  return {
    input_path: inputPath,
    generatedAt,
    leakage,
    race_count: races.length,
    runner_count: rows.length,
    settled_race_count: settledRaceCount,
    dates,
    courses,
    baselines,
    brier: brierScore(preds),
    log_loss: logLoss(preds),
    calibration: calibrationBuckets(preds),
    odds_bands: oddsBandPerformance(favPicks),
    confidence_bands: confidenceBandPerformance(modelPicks),
    persisted_recommendation: buildPersistedRecommendationReport(racesMap, parsed.header),
    sample_too_small: settledRaceCount < MIN_SAMPLE_RACES,
  };
}

/* -------------------------------------------------------------------------- */
/* Output path                                                                */
/* -------------------------------------------------------------------------- */

/** Builds `reports/ml-shadow-evaluation-<dates>[-<course-slug|all>].md`. Pure. */
export function buildMlEvaluationPath(dates: readonly string[], courses: readonly string[]): string {
  let datePart = 'dataset';
  if (dates.length === 1) datePart = dates[0];
  else if (dates.length > 1) datePart = `${dates[0]}-to-${dates[dates.length - 1]}`;

  let coursePart = 'all';
  if (courses.length === 1) {
    coursePart =
      courses[0]
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'all';
  } else if (courses.length > 1) {
    coursePart = 'multi';
  }
  return `reports/ml-shadow-evaluation-${datePart}-${coursePart}.md`;
}

/* -------------------------------------------------------------------------- */
/* Markdown rendering (pure, deterministic)                                   */
/* -------------------------------------------------------------------------- */

function orDash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return DASH;
  return String(value);
}
function fmtPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  const sign = value > 0 ? '+' : value < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}
function fmtFixed(value: number | null, dp: number): string {
  return value === null || !Number.isFinite(value) ? DASH : value.toFixed(dp);
}
function fmtPoints(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  const sign = value > 0 ? '+' : value < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(value).toFixed(2)}pt`;
}

function renderBandTable(title: string, rows: readonly BandRow[]): string {
  const lines = [`### ${title}`, ''];
  if (rows.length === 0) {
    lines.push(`_${DASH} (no data)_`);
    return lines.join('\n');
  }
  lines.push('| Band | Picks | Settled | Winners | Strike | ROI |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    lines.push(`| ${r.band} | ${r.picks} | ${r.settled} | ${r.winners} | ${fmtPct(r.strike_rate)} | ${fmtPct(r.roi)} |`);
  }
  return lines.join('\n');
}

/**
 * Renders the full ML shadow-evaluation report as deterministic Markdown. Pure:
 * the same report object always yields the same string. It states plainly that
 * no model is trained or activated, that this is offline shadow evaluation only,
 * and (GO/NO-GO) that no ML model may be promoted without large out-of-sample
 * evaluation. Missing values render as an em dash.
 */
export function renderMlEvaluationMarkdown(report: MlEvaluationReport): string {
  const blocks: string[] = [];

  blocks.push('# ML shadow evaluation (offline baseline — no model trained)');
  blocks.push(
    [
      `Input: ${report.input_path}`,
      `Generated: ${report.generatedAt}`,
      `Races: ${report.race_count} · runners: ${report.runner_count} · settled races: ${report.settled_race_count}`,
    ].join('  \n'),
  );
  blocks.push(
    [
      '> Offline / shadow evaluation only. This trains NO model, persists nothing,',
      '> activates no ML, and changes no live recommendation or stake. It compares a',
      '> market-only baseline with the current model signals and simple deterministic',
      '> baselines over an EXPORTED dataset. No edge is claimed; this is not betting',
      '> advice.',
    ].join('\n'),
  );

  // 1. Executive summary.
  const fav = report.baselines.find((b) => b.id === 'market_favourite');
  const model = report.baselines.find((b) => b.id === 'model_rank');
  blocks.push(
    [
      '## 1. Executive summary',
      '',
      `- Dataset: ${report.race_count} race(s), ${report.runner_count} runner(s), ${report.settled_race_count} settled.`,
      `- Market favourite strike rate: ${fav ? fmtPct(fav.strike_rate) : DASH}.`,
      `- Model-rank baseline strike rate: ${model ? fmtPct(model.strike_rate) : DASH}; ROI: ${model ? fmtPct(model.roi) : DASH} (shadow model-rank baseline — NOT the production recommendation).`,
      `- ${NOT_PRODUCTION_RECORD_NOTE}`,
      `- Leakage check: ${report.leakage.status}.`,
      report.sample_too_small
        ? `- ⚠️ Sample is far too small (${report.settled_race_count} settled < ${MIN_SAMPLE_RACES}); results are not evidence of anything.`
        : '- Sample meets the minimum race count for a first read (still requires out-of-sample testing).',
    ].join('\n'),
  );

  // 2. Input file and leakage check.
  blocks.push(
    [
      '## 2. Input file and leakage check',
      '',
      `- Input: ${report.input_path}`,
      `- Leakage check: **${report.leakage.status}**`,
      `- Label columns (used as labels only): ${report.leakage.label_columns.length ? report.leakage.label_columns.join(', ') : DASH}`,
      `- Feature columns: ${report.leakage.feature_columns.length ? report.leakage.feature_columns.join(', ') : DASH}`,
      report.leakage.leakage_violations.length
        ? `- ⛔ Leakage violations (post-race columns used as features): ${report.leakage.leakage_violations.join(', ')}`
        : '- No leakage columns are used as features.',
    ].join('\n'),
  );

  // 3. Dataset summary.
  blocks.push(
    [
      '## 3. Dataset summary',
      '',
      `- Dates: ${report.dates.length ? report.dates.join(', ') : DASH}`,
      `- Courses: ${report.courses.length ? report.courses.join(', ') : DASH}`,
      `- Races: ${report.race_count}`,
      `- Runners: ${report.runner_count}`,
      `- Settled races: ${report.settled_race_count}`,
    ].join('\n'),
  );

  // 4. Baseline comparison.
  const baselineLines = [
    '## 4. Baseline comparison',
    '',
    '| Baseline | Rule | Races | Settled | Winners | Strike | ROI | P/L |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const b of report.baselines) {
    baselineLines.push(
      `| ${b.name} | ${b.description} | ${b.races_with_pick} | ${b.settled} | ${b.winners} | ` +
        `${fmtPct(b.strike_rate)} | ${fmtPct(b.roi)} | ${fmtPoints(b.profit_loss)} |`,
    );
  }
  baselineLines.push('');
  baselineLines.push('_Flat 1-unit stakes at the exported pre-off odds; settled races only count toward strike/ROI._');
  baselineLines.push('');
  baselineLines.push(`> ${NOT_PRODUCTION_RECORD_NOTE}`);
  baselineLines.push(
    '> The “Model-rank baseline” above is the top model probability/rank runner, which is NOT how the ' +
      'production recommendation is chosen (production recommendations are EV/stake driven and gated).',
  );
  baselineLines.push('');
  const pr = report.persisted_recommendation;
  if (pr.available && pr.baseline) {
    const b = pr.baseline;
    baselineLines.push(
      `- **${b.name}** (${b.description}): ${b.races_with_pick} race pick(s), ${b.settled} settled, ` +
        `${b.winners} winner(s), strike ${fmtPct(b.strike_rate)}, ROI ${fmtPct(b.roi)}, P/L ${fmtPoints(b.profit_loss)}.`,
    );
  } else {
    baselineLines.push(`- ${PERSISTED_RECOMMENDATION_UNAVAILABLE_NOTE}`);
  }
  blocks.push(baselineLines.join('\n'));

  // 5. Calibration / probability quality.
  const calLines = [
    '## 5. Calibration / probability quality (market-implied)',
    '',
    `- Brier score: ${fmtFixed(report.brier, 4)} (lower is better; null when no settled priced races)`,
    `- Log loss: ${fmtFixed(report.log_loss, 4)}`,
    '',
  ];
  if (report.calibration.every((b) => b.count === 0)) {
    calLines.push('_— (no settled, priced predictions to calibrate)_');
  } else {
    calLines.push('| Prob bucket | Count | Mean predicted | Actual win rate |');
    calLines.push('| --- | --- | --- | --- |');
    for (const b of report.calibration) {
      calLines.push(`| ${b.range} | ${b.count} | ${fmtFixed(b.mean_predicted, 3)} | ${fmtFixed(b.actual_rate, 3)} |`);
    }
  }
  blocks.push(calLines.join('\n'));

  // 6. Odds-band performance (market favourite picks).
  blocks.push(
    ['## 6. Odds-band performance', '', '_Market-favourite picks grouped by the pick\u2019s odds band._', '', renderBandTable('Odds bands', report.odds_bands)].join('\n'),
  );

  // 7. Confidence-band performance (model-rank picks).
  blocks.push(
    [
      '## 7. Confidence-band performance',
      '',
      '_Model-rank picks grouped by the pick\u2019s confidence score (low <0.34, medium <0.67, high otherwise)._',
      '',
      renderBandTable('Confidence bands', report.confidence_bands),
    ].join('\n'),
  );

  // 8. Warnings and limitations.
  blocks.push(
    [
      '## 8. Warnings and limitations',
      '',
      report.sample_too_small
        ? `- ⚠️ Sample far too small (${report.settled_race_count} settled races < ${MIN_SAMPLE_RACES}); every figure above is anecdotal.`
        : '- Sample meets the minimum race count, but a single meeting/range is still not out-of-sample.',
      report.leakage.status === 'FAIL'
        ? '- ⛔ Leakage detected — do not trust any metric until the feature set is cleaned.'
        : '- No leakage detected in the feature set.',
      '- Market-implied probabilities are normalised per race (overround removed); they are not a model.',
      '- No model was trained, tuned, or persisted; these are fixed deterministic baselines.',
      '- Do not optimise on a single day/meeting; that would be overfitting.',
    ].join('\n'),
  );

  // 9. GO / NO-GO.
  blocks.push(
    [
      '## 9. GO / NO-GO',
      '',
      '- **NO-GO for promotion.** No ML model may be promoted to production (or made model-active) on this evaluation.',
      '- Promotion requires large, out-of-sample, leakage-free evaluation across many meetings, with calibration and ROI that beat the market-only baseline — none of which a single dataset can show.',
      '- This scaffold is decision-support / research only. It is not betting advice and claims no edge.',
    ].join('\n'),
  );

  return blocks.join('\n\n') + '\n';
}
