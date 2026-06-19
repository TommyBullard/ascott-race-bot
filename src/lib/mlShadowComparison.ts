/**
 * OFFLINE, SHADOW-ONLY comparison between the candidate ML model, the regular
 * production model pick, and the market favourite.
 *
 * RESEARCH / DECISION-SUPPORT ONLY. None of this changes the production model
 * probability, EV, staking, confidence, the no-bet gate, or any recommendation,
 * and it places/suggests no bet. The agreement helpers and warnings are PURE and
 * deterministic; the file reads/writes live in the CLIs and the (separate,
 * read-only) dashboard endpoint. Nothing is fabricated — a missing pick is null
 * and never compared as if known.
 */

import {
  type ShadowModel,
  type ShadowScoredRunner,
  scoreRace,
  groupByRace,
  isSmallSample,
  MIN_SHADOW_TRAINING_RACES,
} from './mlShadowModel';
import type { ParsedCsv } from './mlShadowEvaluation';
import {
  ML_SHADOW_LABELS,
  buildMlAgreement,
  type MlAgreement,
  type MlAgreementBadge,
} from './mlAgreement';

export { ML_SHADOW_LABELS, buildMlAgreement };
export type { MlAgreement, MlAgreementBadge };

/** Display warnings attached to a shadow comparison (never alarming, honest). */
export interface MlShadowWarnings {
  small_sample: boolean;
  small_sample_text: string | null;
  data_differs: boolean;
  data_differs_text: string | null;
}

/**
 * Builds the small-sample + data-mismatch warnings for a prediction race. Pure.
 * `raceCourse` is compared to the model's training course; race type is not
 * persisted, so only the course is checked (and that caveat is surfaced).
 */
export function buildShadowWarnings(
  model: Pick<ShadowModel, 'settled_race_count' | 'course'>,
  raceCourse: string | null,
): MlShadowWarnings {
  const small = isSmallSample(model);
  const sameCourse =
    model.course == null ||
    raceCourse == null ||
    model.course.trim().toLowerCase() === raceCourse.trim().toLowerCase();
  return {
    small_sample: small,
    small_sample_text: small
      ? `Small training sample (${model.settled_race_count} settled races < ${MIN_SHADOW_TRAINING_RACES}); treat the ML shadow pick as low-confidence research only.`
      : null,
    data_differs: !sameCourse,
    data_differs_text: !sameCourse
      ? `Race course (${raceCourse ?? '—'}) differs from the model's training course (${model.course ?? '—'}); race type is not stored, so type drift cannot be checked.`
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Per-race comparison (offline report, derived from the features CSV)        */
/* -------------------------------------------------------------------------- */

/** One race's full shadow comparison row (offline report shape). */
export interface ShadowRaceComparison {
  race_id: string;
  off_time: string | null;
  race_name: string | null;
  field_size: number | null;
  /** Regular model pick = the model_rank_pre_off == 1 runner (a proxy display). */
  regular_model_pick_name: string | null;
  market_favourite_name: string | null;
  ml_pick: ShadowScoredRunner | null;
  ranked: ShadowScoredRunner[];
  agreement: MlAgreement;
  warnings: MlShadowWarnings;
}

/** A finite number from a CSV cell, else null. */
function num(v: string | undefined): number | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Picks the runner name whose `rankColumn` equals 1 (min); else null. Pure. */
function pickByRank(
  records: readonly Record<string, string>[],
  rankColumn: string,
): string | null {
  let best: { rank: number; name: string | null } | null = null;
  for (const r of records) {
    const rank = num(r[rankColumn]);
    if (rank === null) continue;
    if (best === null || rank < best.rank) {
      best = { rank, name: (r.runner_name ?? '').trim() || null };
    }
  }
  return best?.name ?? null;
}

/**
 * Builds the per-race shadow comparison from the features CSV + trained model.
 * Regular pick = model_rank_pre_off==1; market favourite = market_rank_pre_off==1;
 * ML pick = the top shadow-ranked runner. Pure; deterministic.
 */
export function buildShadowComparison(
  model: ShadowModel,
  parsed: ParsedCsv,
): ShadowRaceComparison[] {
  const out: ShadowRaceComparison[] = [];
  for (const [raceId, records] of groupByRace(parsed.rows)) {
    const ranked = scoreRace(model, records);
    const mlPick = ranked.length > 0 ? ranked[0] : null;
    const regularPick = pickByRank(records, 'model_rank_pre_off');
    const marketFav = pickByRank(records, 'market_rank_pre_off');
    const first = records[0] ?? {};
    const raceCourse = (first.course ?? '').trim() || null;
    out.push({
      race_id: raceId,
      off_time: (first.off_time ?? '').trim() || null,
      race_name: (first.race_name ?? '').trim() || null,
      field_size: num(first.field_size),
      regular_model_pick_name: regularPick,
      market_favourite_name: marketFav,
      ml_pick: mlPick,
      ranked,
      agreement: buildMlAgreement(regularPick, marketFav, mlPick?.runner_name ?? null),
      warnings: buildShadowWarnings(model, raceCourse),
    });
  }
  out.sort((a, b) => offKey(a.off_time) - offKey(b.off_time));
  return out;
}

function offKey(off: string | null): number {
  if (!off) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(off);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/* -------------------------------------------------------------------------- */
/* Persisted ML shadow picks report (what the dashboard endpoint reads)       */
/* -------------------------------------------------------------------------- */

/** One race entry in the persisted ML shadow picks JSON. */
export interface MlShadowRacePick {
  race_id: string;
  off_time: string | null;
  race_name: string | null;
  field_size: number | null;
  ml_pick: ShadowScoredRunner | null;
  ranked: ShadowScoredRunner[];
  regular_model_pick_name: string | null;
  market_favourite_name: string | null;
  agreement: MlAgreement;
  warnings: MlShadowWarnings;
}

/** The persisted ML shadow picks report (local JSON; read-only overlay). */
export interface MlShadowPicksReport {
  generated_at: string;
  date: string | null;
  course: string | null;
  /** ALWAYS false — the shadow output is never production-active. */
  model_active: false;
  model: {
    trained_at: string;
    training_date_range: { from: string | null; to: string | null };
    settled_count: number;
    settled_race_count: number;
    feature_columns: string[];
    label: string;
    small_sample: boolean;
    in_sample_brier: number | null;
    in_sample_log_loss: number | null;
    in_sample_top1_race_hit_rate: number | null;
  };
  races: MlShadowRacePick[];
  disclaimer: string;
}

/** Builds the persisted picks report from a model + features CSV. Pure. */
export function buildMlShadowPicksReport(
  model: ShadowModel,
  parsed: ParsedCsv,
  date: string | null,
  course: string | null,
  generatedAt: string,
): MlShadowPicksReport {
  const comparisons = buildShadowComparison(model, parsed);
  return {
    generated_at: generatedAt,
    date,
    course,
    model_active: false,
    model: {
      trained_at: model.trained_at,
      training_date_range: model.training_date_range,
      settled_count: model.settled_count,
      settled_race_count: model.settled_race_count,
      feature_columns: model.feature_columns,
      label: model.label,
      small_sample: isSmallSample(model),
      in_sample_brier: model.evaluation.in_sample_brier,
      in_sample_log_loss: model.evaluation.in_sample_log_loss,
      in_sample_top1_race_hit_rate: model.evaluation.in_sample_top1_race_hit_rate,
    },
    races: comparisons.map((c) => ({
      race_id: c.race_id,
      off_time: c.off_time,
      race_name: c.race_name,
      field_size: c.field_size,
      ml_pick: c.ml_pick,
      ranked: c.ranked,
      regular_model_pick_name: c.regular_model_pick_name,
      market_favourite_name: c.market_favourite_name,
      agreement: c.agreement,
      warnings: c.warnings,
    })),
    disclaimer:
      `${ML_SHADOW_LABELS.notModelActive}. ${ML_SHADOW_LABELS.researchOnly}. ${ML_SHADOW_LABELS.noEffect}.`,
  };
}

/** Parses + validates a persisted picks report; null on any problem. Pure. */
export function parseMlShadowPicksReport(text: string): MlShadowPicksReport | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const r = obj as Record<string, unknown>;
  if (r.model_active !== false) return null;
  if (!Array.isArray(r.races)) return null;
  return obj as MlShadowPicksReport;
}

/* -------------------------------------------------------------------------- */
/* Paths + markdown                                                            */
/* -------------------------------------------------------------------------- */

/** Slugifies a course for a filesystem-safe filename (mirrors the export). */
function slug(course: string | null | undefined): string {
  return (course ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Deterministic path for the persisted ML shadow PICKS JSON. Pure. */
export function buildMlShadowPicksPath(date: string, course?: string | null): string {
  const s = slug(course);
  const base = `reports/ml-shadow-picks-${date}`;
  return s ? `${base}-${s}.json` : `${base}.json`;
}

/** Deterministic path for the ML shadow COMPARISON markdown. Pure. */
export function buildMlShadowComparisonPath(date: string, course?: string | null): string {
  const s = slug(course);
  const base = `reports/ml-shadow-comparison-${date}`;
  return s ? `${base}-${s}.md` : `${base}.md`;
}

const DASH = '\u2014';

function fmtPct(p: number | null | undefined): string {
  return typeof p === 'number' && Number.isFinite(p) ? `${(p * 100).toFixed(1)}%` : DASH;
}

function fmtNum(n: number | null | undefined, dp = 3): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(dp) : DASH;
}

/** Renders the human-readable comparison Markdown report. Pure. */
export function renderShadowComparisonMarkdown(report: MlShadowPicksReport): string {
  const lines: string[] = [];
  lines.push(`# ML shadow comparison ${DASH} ${report.date ?? '?'}${report.course ? ` · ${report.course}` : ''}`);
  lines.push('');
  lines.push(`> ${report.disclaimer}`);
  lines.push('');
  lines.push('## Candidate model');
  lines.push('');
  lines.push(`- Trained: ${report.model.trained_at}`);
  lines.push(`- Training range: ${report.model.training_date_range.from ?? DASH} to ${report.model.training_date_range.to ?? DASH}`);
  lines.push(`- Settled training rows: ${report.model.settled_count} across ${report.model.settled_race_count} settled races${report.model.small_sample ? ' (SMALL SAMPLE — low confidence)' : ''}`);
  lines.push(`- Features: ${report.model.feature_columns.join(', ')}`);
  lines.push(`- Label: ${report.model.label}`);
  lines.push(`- In-sample Brier: ${fmtNum(report.model.in_sample_brier)} · log loss: ${fmtNum(report.model.in_sample_log_loss)} · top-1 race hit: ${fmtPct(report.model.in_sample_top1_race_hit_rate)} (in-sample fit, not out-of-sample skill)`);
  lines.push('');
  lines.push('## Side-by-side');
  lines.push('');
  lines.push('| Off | Race | Regular model pick | ML shadow pick (prob) | Market favourite | Agreement |');
  lines.push('| --- | ---- | ------------------ | --------------------- | ---------------- | --------- |');
  for (const r of report.races) {
    const ml = r.ml_pick ? `${r.ml_pick.runner_name ?? DASH} (${fmtPct(r.ml_pick.ml_prob)})` : DASH;
    lines.push(
      `| ${r.off_time ?? DASH} | ${r.race_name ?? DASH} | ${r.regular_model_pick_name ?? DASH} | ${ml} | ${r.market_favourite_name ?? DASH} | ${r.agreement.badge_label} |`,
    );
  }
  lines.push('');
  const warned = report.races.find((r) => r.warnings.small_sample || r.warnings.data_differs);
  if (warned) {
    lines.push('## Warnings');
    lines.push('');
    if (warned.warnings.small_sample_text) lines.push(`- ${warned.warnings.small_sample_text}`);
    if (warned.warnings.data_differs_text) lines.push(`- ${warned.warnings.data_differs_text}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push(
    'The ML shadow pick is research/decision-support only. It is NOT model-active and does not ' +
      'change production probabilities, EV, staking, confidence, the no-bet gate, or any recommendation. ' +
      'No bet is placed or suggested. The regular model pick remains the only recommendation.',
  );
  lines.push('');
  return lines.join('\n');
}
