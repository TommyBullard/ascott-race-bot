/**
 * Pure helpers for the read-only ML training-data export (scripts/exportTrainingData.ts).
 *
 * The export produces one CSV ROW PER RUNNER from stored data only: the model's
 * FINAL PRE-OFF run (the latest `model_runs` row with `run_time <= off_time`),
 * the pre-race race/runner attributes, and the official result LABELS. It is the
 * read-only foundation for any future ML work — it never calls the model, never
 * fetches live odds, never imports results, and never writes to the database.
 *
 * LEAKAGE SAFETY is the central concern. Columns are split into two clearly
 * separated, independently-testable groups:
 *   - {@link FEATURE_COLUMNS}: PRE-RACE-KNOWN inputs only (race/runner attributes,
 *     pre-off odds, pre-off model probability / ranks / EV / confidence, and the
 *     pre-off data-quality + tipster observability).
 *   - {@link LABEL_COLUMNS}: POST-RACE outcomes only (finish_pos, won, placed,
 *     SP and BSP). These are NEVER part of the feature set.
 * In particular the final BSP is a LABEL only; post-off odds and any post-race
 * text are never emitted as features.
 *
 * Everything here is PURE and DETERMINISTIC: argument parsing, the output path,
 * the probability-rank derivation, the win/place label derivation, and the CSV
 * rendering. There is NO database access, NO network, NO model maths / staking /
 * ranking / tipster-weighting change, and NO mutation. Nothing is fabricated: a
 * missing value renders as an EMPTY cell, never an invented number or "null".
 */

import { getTipsterConsensusFromConfig } from './modelRunConfigReaders';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Highest finishing position counted as a "place" label. Actual place terms vary
 * by field size and are not stored, so a top-3 finish is used as a documented,
 * conservative approximation (matching the end-of-day report).
 */
export const PLACE_MAX_POSITION = 3;

/* -------------------------------------------------------------------------- */
/* Arguments + output path                                                    */
/* -------------------------------------------------------------------------- */

/** Parsed CLI options for the export script. */
export interface TrainingExportArgs {
  /** Inclusive range start (YYYY-MM-DD); undefined when missing/invalid. */
  from?: string;
  /** Inclusive range end (YYYY-MM-DD); undefined when missing/invalid. */
  to?: string;
  /** Optional course filter (verbatim; normalised by the caller for matching). */
  course?: string;
}

/**
 * Parses argv (already sliced past `node script`). `--from` / `--to` each require
 * a strict YYYY-MM-DD value (anything else leaves them undefined so the caller
 * can error out); `--course` is taken verbatim (trimmed). Pure; read-only.
 */
export function parseTrainingExportArgs(
  argv: readonly string[],
): TrainingExportArgs {
  const args: TrainingExportArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') {
      const value = (argv[++i] ?? '').trim();
      if (DATE_RE.test(value)) args.from = value;
    } else if (a === '--to') {
      const value = (argv[++i] ?? '').trim();
      if (DATE_RE.test(value)) args.to = value;
    } else if (a === '--course') {
      const value = (argv[++i] ?? '').trim();
      if (value !== '') args.course = value;
    }
  }
  return args;
}

/**
 * Builds the deterministic export path:
 *   `data/exports/training-data-<from>-to-<to>[-<course-slug>].csv`
 * The course is slugified (lower-cased, non-alphanumerics collapsed to `-`) so
 * the filename is filesystem-safe; an empty/missing course is omitted. Pure.
 */
export function buildTrainingExportPath(
  from: string,
  to: string,
  course?: string | null,
): string {
  const slug = (course ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = `data/exports/training-data-${from}-to-${to}`;
  return slug ? `${base}-${slug}.csv` : `${base}.csv`;
}

/* -------------------------------------------------------------------------- */
/* Row shape                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One runner's training row. Feature fields are pre-race-known; label fields are
 * post-race outcomes. Fields that the schema does not persist (e.g. race_type,
 * age) are typed `null` and always render blank — never fabricated.
 */
export interface TrainingRunnerRow {
  /* ---- pre-race FEATURES ---- */
  race_id: string;
  runner_id: string;
  /** Meeting date (YYYY-MM-DD), or null. */
  race_date: string | null;
  course: string | null;
  off_time: string | null;
  race_name: string | null;
  /** Not persisted in the current schema -> always null/blank. */
  race_type: string | null;
  is_handicap: boolean | null;
  field_size: number | null;
  runner_name: string | null;
  draw: number | null;
  /** Not persisted in the current schema -> always null/blank. */
  age: number | null;
  /** Carried weight in lbs (`runners.weight_lbs`), or null. */
  weight: number | null;
  official_rating: number | null;
  trainer: string | null;
  jockey: string | null;
  /** Priced odds at the pre-off snapshot the model used (NOT BSP, NOT post-off). */
  pre_off_odds: number | null;
  /** Market rank (1 = shortest) derived from pre-off market probability. */
  market_rank_pre_off: number | null;
  model_prob_pre_off: number | null;
  /** Model rank (1 = highest) derived from pre-off model probability. */
  model_rank_pre_off: number | null;
  ev_pre_off: number | null;
  /** Per-runner pre-off model confidence score, or null. */
  confidence: number | null;
  /** Run-level data-quality verdict (OK/DEGRADED/...), or null. */
  data_quality: string | null;
  /** Run-level data-quality flags (verbatim), never fabricated. */
  data_quality_flags: string[];
  /** Run-level tipster/model alignment label, or null. */
  tipster_alignment: string | null;
  /** Per-runner tipster support share (0..1), or null when unavailable. */
  tipster_support_share: number | null;

  /* ---- post-race LABELS ---- */
  finish_pos: number | null;
  won: boolean | null;
  placed: boolean | null;
  sp_decimal: number | null;
  /** Betfair SP — a LABEL ONLY, never an input feature. */
  bsp_decimal: number | null;
}

/* -------------------------------------------------------------------------- */
/* Label + rank derivation (pure)                                             */
/* -------------------------------------------------------------------------- */

/** True for a finite number. */
function isFiniteNum(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Whether the runner won, derived from its finishing position:
 *   - null finish_pos -> null (unknown; never assumed lost),
 *   - finish_pos === 1 -> true, else false.
 * Pure.
 */
export function deriveWon(finishPos: number | null): boolean | null {
  return finishPos === null ? null : finishPos === 1;
}

/**
 * Whether the runner placed (top {@link PLACE_MAX_POSITION}), derived from its
 * finishing position: null finish_pos -> null; otherwise 1..max -> true.
 * Pure.
 */
export function derivePlaced(finishPos: number | null): boolean | null {
  if (finishPos === null) return null;
  return Number.isFinite(finishPos) && finishPos >= 1 && finishPos <= PLACE_MAX_POSITION;
}

/**
 * Assigns 1-based ranks to runners by a probability, highest first. Runners with
 * a non-finite probability are omitted (their rank is unknown -> null at the
 * lookup site). Ties break by `runner_id` ascending, so the result is fully
 * deterministic regardless of input order. Pure; does not mutate the input.
 */
export function computeProbRanks(
  runners: ReadonlyArray<{ runner_id: string; prob: number | null }>,
): Map<string, number> {
  const ranked = runners
    .filter((r) => isFiniteNum(r.prob))
    .slice()
    .sort((a, b) => b.prob! - a.prob! || a.runner_id.localeCompare(b.runner_id));
  const ranks = new Map<string, number>();
  ranked.forEach((r, i) => ranks.set(r.runner_id, i + 1));
  return ranks;
}

/**
 * Extracts per-runner tipster support shares from a run's `config_json`
 * (`tipster_consensus.runner_support[]`). Returns a map of `runner_id` ->
 * support share (a finite number) for entries that carry one; missing/malformed
 * data yields an empty map (so the column renders blank). Pure; never throws.
 */
export function extractTipsterSupportShares(
  configJson: unknown,
): Map<string, number> {
  const shares = new Map<string, number>();
  const consensus = getTipsterConsensusFromConfig(configJson);
  const support = consensus?.runner_support;
  if (!Array.isArray(support)) return shares;
  for (const entry of support) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const id = row.runner_id;
    const share = row.support_share;
    if (
      (typeof id === 'string' || typeof id === 'number') &&
      typeof share === 'number' &&
      Number.isFinite(share)
    ) {
      shares.set(String(id), share);
    }
  }
  return shares;
}

/* -------------------------------------------------------------------------- */
/* CSV columns + rendering (pure, deterministic, leakage-segregated)          */
/* -------------------------------------------------------------------------- */

/** Renders a string cell (CSV-escaped); null/undefined -> blank. */
function strCell(value: string | null | undefined): string {
  return escapeCsvCell(value ?? '');
}

/** Renders a numeric cell; non-finite/null -> blank. */
function numCell(value: number | null | undefined): string {
  return isFiniteNum(value) ? String(value) : '';
}

/** Renders a boolean cell as 1/0; null/undefined -> blank. */
function boolCell(value: boolean | null | undefined): string {
  return value === null || value === undefined ? '' : value ? '1' : '0';
}

/** Renders a string-list cell joined by `;` (never the CSV comma); empty -> blank. */
function listCell(value: readonly string[] | null | undefined): string {
  return value && value.length > 0 ? escapeCsvCell(value.join(';')) : '';
}

/**
 * Escapes a single CSV cell per RFC 4180: a value containing a comma, double
 * quote, or newline is wrapped in double quotes with internal quotes doubled.
 * Pure.
 */
export function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * The pre-race FEATURE columns, paired with their accessors. The header and each
 * row are generated from this single source, so they can never drift out of
 * alignment. Contains NO result/label fields (enforced by tests).
 */
const FEATURE_ACCESSORS: ReadonlyArray<
  readonly [string, (row: TrainingRunnerRow) => string]
> = [
  ['race_id', (r) => strCell(r.race_id)],
  ['runner_id', (r) => strCell(r.runner_id)],
  ['race_date', (r) => strCell(r.race_date)],
  ['course', (r) => strCell(r.course)],
  ['off_time', (r) => strCell(r.off_time)],
  ['race_name', (r) => strCell(r.race_name)],
  ['race_type', (r) => strCell(r.race_type)],
  ['is_handicap', (r) => boolCell(r.is_handicap)],
  ['field_size', (r) => numCell(r.field_size)],
  ['runner_name', (r) => strCell(r.runner_name)],
  ['draw', (r) => numCell(r.draw)],
  ['age', (r) => numCell(r.age)],
  ['weight', (r) => numCell(r.weight)],
  ['official_rating', (r) => numCell(r.official_rating)],
  ['trainer', (r) => strCell(r.trainer)],
  ['jockey', (r) => strCell(r.jockey)],
  ['pre_off_odds', (r) => numCell(r.pre_off_odds)],
  ['market_rank_pre_off', (r) => numCell(r.market_rank_pre_off)],
  ['model_prob_pre_off', (r) => numCell(r.model_prob_pre_off)],
  ['model_rank_pre_off', (r) => numCell(r.model_rank_pre_off)],
  ['ev_pre_off', (r) => numCell(r.ev_pre_off)],
  ['confidence', (r) => numCell(r.confidence)],
  ['data_quality', (r) => strCell(r.data_quality)],
  ['data_quality_flags', (r) => listCell(r.data_quality_flags)],
  ['tipster_alignment', (r) => strCell(r.tipster_alignment)],
  ['tipster_support_share', (r) => numCell(r.tipster_support_share)],
];

/**
 * The post-race LABEL columns, paired with their accessors. Kept strictly
 * separate from {@link FEATURE_ACCESSORS}; the final BSP lives here only.
 */
const LABEL_ACCESSORS: ReadonlyArray<
  readonly [string, (row: TrainingRunnerRow) => string]
> = [
  ['finish_pos', (r) => numCell(r.finish_pos)],
  ['won', (r) => boolCell(r.won)],
  ['placed', (r) => boolCell(r.placed)],
  ['sp_decimal', (r) => numCell(r.sp_decimal)],
  ['bsp_decimal', (r) => numCell(r.bsp_decimal)],
];

/** The pre-race feature column names, in CSV order. */
export const FEATURE_COLUMNS: readonly string[] = FEATURE_ACCESSORS.map(
  ([name]) => name,
);

/** The post-race label column names, in CSV order. */
export const LABEL_COLUMNS: readonly string[] = LABEL_ACCESSORS.map(
  ([name]) => name,
);

/** All CSV columns in order: every feature first, then every label. */
export const ALL_COLUMNS: readonly string[] = [
  ...FEATURE_COLUMNS,
  ...LABEL_COLUMNS,
];

/** Renders one row's cells in column order (features then labels). Pure. */
function renderRowCells(row: TrainingRunnerRow): string {
  const cells = [
    ...FEATURE_ACCESSORS.map(([, accessor]) => accessor(row)),
    ...LABEL_ACCESSORS.map(([, accessor]) => accessor(row)),
  ];
  return cells.join(',');
}

/**
 * Renders the full training CSV deterministically: a header row of
 * {@link ALL_COLUMNS} followed by one line per input row, in the given order.
 * Pure: the same rows always produce the same string. Missing values are blank
 * cells; nothing is fabricated. The caller is responsible for ordering rows
 * deterministically before rendering.
 */
export function renderTrainingCsv(
  rows: readonly TrainingRunnerRow[],
): string {
  const header = ALL_COLUMNS.join(',');
  const lines = rows.map(renderRowCells);
  return [header, ...lines].join('\n') + '\n';
}
