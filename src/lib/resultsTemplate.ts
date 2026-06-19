/**
 * Pure helpers for the LOCAL "manual results CSV template" generator
 * (scripts/resultsTemplate.ts).
 *
 * For days where automated settlement is unavailable (the Racing API
 * `/v1/results` Standard plan is blocked, and the Basic/Free `today` endpoints
 * only cover the current day), the supported fallback is the operator-curated
 * manual results CSV consumed by `import:results`. This module builds a TEMPLATE
 * of that CSV — one row per stored runner, with the identity columns pre-filled
 * and the result columns left BLANK for the operator to fill by hand.
 *
 * It is deliberately inert: NO database access, NO network, NO writes, NO model
 * maths, staking, ranking, or recommendation logic. The CLI reads stored
 * races/runners and writes only a local CSV + a companion Markdown guide; it
 * settles nothing and mutates nothing. Pure + deterministic given its inputs.
 *
 * The column order MATCHES the `import:results` contract exactly so the filled
 * template imports cleanly:
 *   required: date, course, off_time, horse_name, finish_pos
 *   optional: sp_decimal, bsp_decimal, runner_status
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Required + optional CSV columns, in the exact order import:results expects. */
export const TEMPLATE_COLUMNS = [
  'date',
  'course',
  'off_time',
  'horse_name',
  'finish_pos',
  'sp_decimal',
  'bsp_decimal',
  'runner_status',
] as const;

/** Columns the template PRE-FILLS from stored data. */
export const PREFILLED_COLUMNS = ['date', 'course', 'off_time', 'horse_name'] as const;

/** Columns the template leaves BLANK for the operator to fill. */
export const BLANK_COLUMNS = ['finish_pos', 'sp_decimal', 'bsp_decimal', 'runner_status'] as const;

/** The mandatory operator warning printed + written on every template. */
export const TEMPLATE_WARNING =
  'Dry template only — fill finish_pos manually, then run import:results dry-run before --commit.';

/* -------------------------------------------------------------------------- */
/* Arguments + paths                                                          */
/* -------------------------------------------------------------------------- */

export interface TemplateArgs {
  date?: string;
  course?: string;
  output?: string;
  errors: string[];
}

/** True only for a real, strictly-formatted YYYY-MM-DD calendar date. Pure. */
export function isValidIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Parses `--date` (required), `--course`, `--output`. Collects errors. Pure. */
export function parseTemplateArgs(argv: readonly string[]): TemplateArgs {
  let date: string | undefined;
  let course: string | undefined;
  let output: string | undefined;
  const errors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const v = (argv[++i] ?? '').trim();
      if (v) date = v;
    } else if (a === '--course') {
      const v = (argv[++i] ?? '').trim();
      if (v) course = v;
    } else if (a === '--output') {
      const v = (argv[++i] ?? '').trim();
      if (v) output = v;
    }
  }
  if (!date) errors.push('Missing required --date YYYY-MM-DD.');
  else if (!isValidIsoDate(date)) errors.push(`Invalid --date "${date}" (expected a real YYYY-MM-DD date).`);
  return { date, course, output, errors };
}

/** Canonical course slug (matches every report-path builder in the project). */
export function slugifyCourse(course?: string | null): string {
  return (course ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Builds the default CSV path `data/results-<date>[-<course-slug>].csv`. Pure. */
export function buildTemplatePath(date: string, course?: string | null): string {
  const slug = slugifyCourse(course);
  return slug ? `data/results-${date}-${slug}.csv` : `data/results-${date}.csv`;
}

/** Builds the companion Markdown path next to the CSV. Pure. */
export function buildCompanionPath(csvPath: string): string {
  return /\.csv$/i.test(csvPath) ? csvPath.replace(/\.csv$/i, '.README.md') : `${csvPath}.README.md`;
}

/* -------------------------------------------------------------------------- */
/* CSV building                                                               */
/* -------------------------------------------------------------------------- */

/** RFC-4180 cell escaping: quote when the value has a comma, quote, or newline. */
export function escapeCsvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Formats a stored race off-time (ISO, UTC) to "HH:MM" UTC, or "" when absent. */
export function formatOffTimeUtc(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** One stored runner with its race context (read-only inputs). */
export interface TemplateRunner {
  /** The race's stored off-time (ISO, UTC). */
  offTime: string | null;
  horseName: string;
  /** Saddlecloth / runner number for ordering, or null. */
  saddlecloth: number | null;
}

export interface TemplateInput {
  date: string;
  course: string;
  runners: TemplateRunner[];
}

/** A fully-built template row (identity pre-filled; result columns blank). */
export interface TemplateRow {
  date: string;
  course: string;
  off_time: string;
  horse_name: string;
  finish_pos: '';
  sp_decimal: '';
  bsp_decimal: '';
  runner_status: '';
}

function offMs(iso: string | null): number {
  const ms = Date.parse(iso ?? '');
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Builds one template row per runner, deterministically ordered by race off-time
 * (earliest first; unknown last), then saddlecloth number (ascending; unknown
 * last), then horse name. Pure; never mutates the input.
 */
export function buildTemplateRows(input: TemplateInput): TemplateRow[] {
  const sorted = [...input.runners].sort((a, b) => {
    const am = offMs(a.offTime);
    const bm = offMs(b.offTime);
    if (am !== bm) return am - bm;
    const as = typeof a.saddlecloth === 'number' && Number.isFinite(a.saddlecloth) ? a.saddlecloth : Number.POSITIVE_INFINITY;
    const bs = typeof b.saddlecloth === 'number' && Number.isFinite(b.saddlecloth) ? b.saddlecloth : Number.POSITIVE_INFINITY;
    if (as !== bs) return as - bs;
    return a.horseName.localeCompare(b.horseName);
  });
  return sorted.map((r) => ({
    date: input.date,
    course: input.course,
    off_time: formatOffTimeUtc(r.offTime),
    horse_name: r.horseName,
    finish_pos: '',
    sp_decimal: '',
    bsp_decimal: '',
    runner_status: '',
  }));
}

/** Renders the template rows as a CSV string (header + one row per runner). Pure. */
export function renderTemplateCsv(rows: readonly TemplateRow[]): string {
  const lines: string[] = [TEMPLATE_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(
      TEMPLATE_COLUMNS.map((col) => escapeCsvCell(String(row[col] ?? ''))).join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

/* -------------------------------------------------------------------------- */
/* Companion Markdown guide                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Builds the companion Markdown guide explaining how to fill the template and
 * import it safely. Deterministic. Pure.
 */
export function buildTemplateReadme(meta: {
  date: string;
  course: string | null;
  csvPath: string;
  raceCount: number;
  runnerCount: number;
}): string {
  const lines: string[] = [];
  lines.push(`# Manual results template — ${meta.course ?? '(all courses)'} ${meta.date}`);
  lines.push('');
  lines.push(`> **${TEMPLATE_WARNING}**`);
  lines.push('');
  lines.push(
    `This template has **${meta.runnerCount} runner row(s)** across **${meta.raceCount} race(s)**, ` +
      'one row per stored runner. The identity columns are pre-filled from the database; ' +
      'fill the result columns by hand.',
  );
  lines.push('');
  lines.push('## Columns');
  lines.push('');
  lines.push('| Column | Fill? | Notes |');
  lines.push('| --- | --- | --- |');
  lines.push('| `date` | pre-filled | Meeting date (YYYY-MM-DD). Do not change. |');
  lines.push('| `course` | pre-filled | Stored course label. Do not change. |');
  lines.push('| `off_time` | pre-filled | Stored off-time in **UTC** (HH:MM). Do not change — it is matched against the DB. |');
  lines.push('| `horse_name` | pre-filled | Stored horse name. Do not change — it is matched exactly. |');
  lines.push('| `finish_pos` | **YOU FILL** | Finishing position as a positive integer (1 = winner). Leave blank for non-finishers (or set `runner_status`). |');
  lines.push('| `sp_decimal` | optional | Starting price as a decimal > 1.0 (e.g. 4.5). Leave blank if unknown. |');
  lines.push('| `bsp_decimal` | optional | Betfair SP as a decimal > 1.0. Leave blank if unknown. |');
  lines.push('| `runner_status` | optional | e.g. `PU`, `F`, `non-runner`. Leave blank for normal runners. |');
  lines.push('');
  lines.push('## How to fill it');
  lines.push('');
  lines.push('1. Open the CSV and enter `finish_pos` for each runner from the official result.');
  lines.push('2. Exactly **one** runner per race should have `finish_pos` = 1 (the winner).');
  lines.push('3. Optionally add `sp_decimal` / `bsp_decimal` / `runner_status`. Never invent values — leave blank if unknown.');
  lines.push('4. Do not edit `date`, `course`, `off_time`, or `horse_name` (they are used to match stored rows).');
  lines.push('');
  lines.push('## Import it (dry-run first, then commit)');
  lines.push('');
  lines.push('```');
  lines.push(`npm run import:results -- --file ${meta.csvPath}            # dry run (writes nothing)`);
  lines.push(`npm run import:results -- --file ${meta.csvPath} --commit   # writes finish_pos + marks settled`);
  lines.push('```');
  lines.push('');
  lines.push(
    'The importer is conservative: it never overwrites an existing result with a blank, ' +
      'skips unmatched/ambiguous rows, refuses races with duplicate or multiple winners, and ' +
      'only marks a race settled when a winner (finish_pos = 1) is present. Always read the ' +
      'dry-run output before running `--commit`.',
  );
  lines.push('');
  lines.push('---');
  lines.push('Local operator helper. No database writes, no settlement, no betting — decision-support only.');
  lines.push('');
  return lines.join('\n');
}
