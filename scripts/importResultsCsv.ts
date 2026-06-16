/**
 * Manual results CSV importer (Phase 5A.1) — a SAFE fallback for settling race
 * results when the Racing API plan cannot read `/v1/results` (Standard plan).
 *
 * It writes official finishing positions (and optional SP/BSP/runner status) to
 * existing `runners`, and marks a `races` row settled, from an OPERATOR-CURATED
 * CSV. It deliberately mirrors the conservative tipster importer:
 *
 *   - READ-ONLY BY DEFAULT (dry run). Writes NOTHING unless `--commit` is passed,
 *     and REFUSES to commit while any field still contains placeholder "EXAMPLE"
 *     text (so a template can't be inserted by accident).
 *   - NEVER FABRICATES. A row is only applied when its race AND runner resolve
 *     unambiguously from existing DB rows (date + normalised course + off_time
 *     for the race; EXACT normalised horse name for the runner — no fuzzy match).
 *     Unmatched/ambiguous rows are SKIPPED and reported, never guessed.
 *   - NEVER NULLS OUT RESULTS. The per-runner patch only ever contains the
 *     fields the operator actually supplied, so an existing non-null finish_pos /
 *     SP / BSP is never overwritten with null.
 *   - REFUSES CONFLICTS. If a race has duplicate rows for the same runner, or
 *     more than one runner marked finish_pos=1, that race is refused (its rows
 *     are reported, not written) — the rest of the import still proceeds.
 *   - SETTLES ONLY WITH A WINNER. A race is marked status='result' (and
 *     official_result_time set to now, on --commit only) only when at least one
 *     of its imported runners has finish_pos=1.
 *
 * It does NOT call the Racing API, does NOT run the model, does NOT change model
 * math or staking, and does NOT place bets.
 *
 * CSV columns (header row required):
 *   required: date (YYYY-MM-DD), course, off_time (HH:MM), horse_name, finish_pos
 *   optional: sp_decimal, bsp_decimal, runner_status
 *
 * IMPORTANT — off_time is matched against the race's STORED off time, which is
 * UTC (e.g. a 2:30pm BST Royal Ascot race is stored as 13:30). Use the off_time
 * shown by the dashboard / the tipster importer's `--list-races`, not the local
 * wall-clock time, or the race will not match.
 *
 * Usage:
 *   npm run import:results -- --file data/results.csv            # dry run
 *   npm run import:results -- --file data/results.csv --commit   # writes
 *
 * REQUIRES SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env.local` (or `.env`).
 * Credentials are never logged.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse, normalizeHorseName } from '../src/lib/raceSync';
import { matchRunnerId, type MatchableRunner } from '../src/lib/runnerMatch';

const RACES_TABLE = 'races';
const RUNNERS_TABLE = 'runners';

const REQUIRED_COLUMNS = [
  'date',
  'course',
  'off_time',
  'horse_name',
  'finish_pos',
] as const;
const OPTIONAL_COLUMNS = ['sp_decimal', 'bsp_decimal', 'runner_status'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;
const PLACEHOLDER_RE = /EXAMPLE/i;

// ---------------------------------------------------------------------------
// PURE HELPERS (exported for unit tests; no I/O, no mutation)
// ---------------------------------------------------------------------------

/**
 * Minimal RFC-4180 CSV parser: handles quoted fields, escaped quotes (""), and
 * commas/newlines inside quotes. Returns rows of raw string cells. Pure.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

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
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  // Flush the final field/row when the file does not end with a newline.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** True when a row is entirely empty (e.g. a blank trailing line). Pure. */
export function isBlankRow(cells: readonly string[]): boolean {
  return cells.every((c) => c.trim() === '');
}

/**
 * Parses a finishing position: a positive integer (>= 1) or null. Blank,
 * non-numeric ("PU"/"F"), zero, negatives, and decimals all return null — never
 * coerced or invented. Pure.
 */
export function parseFinishPos(value: string | null | undefined): number | null {
  const t = (value ?? '').trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Composes the UTC off-time instant from date + HH:MM, or null. Pure. */
export function composeOffTimeIso(
  meetingDate: string,
  offTime: string,
): string | null {
  const hhmm = offTime.trim().padStart(5, '0');
  const ms = Date.parse(`${meetingDate}T${hhmm}:00Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Canonicalises a DB timestamp to a comparable ISO instant, or null. Pure. */
export function canonicalIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A candidate race row (one of the day's races) for pure match resolution. */
export interface CandidateRace {
  id: string;
  course: string;
  off_time: string | null;
}

/** Outcome of matching a CSV row to the day's races. */
export interface RaceMatchOutcome {
  status: 'resolved' | 'unmatched' | 'ambiguous';
  raceId: string | null;
}

/**
 * Pure race matching: among a day's candidate races, find the one whose
 * normalised course AND canonical off-time instant BOTH equal the row's.
 * Exactly one match resolves; zero -> unmatched; several -> ambiguous (never
 * guessed). `normalizeCourse` applies the Royal Ascot alias, so a CSV "Royal
 * Ascot" matches a stored "Ascot" race; matching is otherwise exact + normalised
 * only (no fuzzy match). Pure; no DB, no mutation.
 */
export function matchResultRace(
  dayRaces: readonly CandidateRace[],
  course: string,
  offTimeIso: string,
): RaceMatchOutcome {
  const wantCourse = normalizeCourse(course);
  const matches = dayRaces.filter(
    (r) =>
      normalizeCourse(r.course) === wantCourse &&
      canonicalIso(r.off_time) === offTimeIso,
  );
  if (matches.length === 0) return { status: 'unmatched', raceId: null };
  if (matches.length > 1) return { status: 'ambiguous', raceId: null };
  return { status: 'resolved', raceId: matches[0].id };
}

/** A raw results row, as read from the CSV (all cells are strings). */
export interface RawResultRow {
  date: string;
  course: string;
  off_time: string;
  horse_name: string;
  finish_pos: string;
  sp_decimal: string;
  bsp_decimal: string;
  runner_status: string;
}

/** A validated, normalised results row ready to resolve + apply. */
export interface NormalizedResultRow {
  meetingDate: string;
  course: string;
  offTime: string;
  offTimeIso: string;
  horseName: string;
  finishPos: number;
  spDecimal: number | null;
  bspDecimal: number | null;
  runnerStatus: string | null;
}

/** Result of validating one raw row. `row` is null when not ok. */
export interface ResultRowValidation {
  ok: boolean;
  problems: string[];
  row: NormalizedResultRow | null;
}

/**
 * Validates a price-like optional field: blank -> null (not supplied); a finite
 * decimal > 1 -> the number; anything else -> a problem (so bad data is reported,
 * never silently dropped or coerced). Pure.
 */
function validateOptionalPrice(
  value: string,
  label: string,
  problems: string[],
): number | null {
  const t = (value ?? '').trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 1) {
    problems.push(`${label} must be a decimal price > 1`);
    return null;
  }
  return n;
}

/**
 * Validates + normalises a raw results row. Required: date (YYYY-MM-DD), course,
 * off_time (HH:MM), horse_name, finish_pos (positive integer). Optional SP/BSP
 * must be a price > 1 when present; runner_status is free text. Pure; never
 * throws and never fabricates (missing optional -> null). Returns the problems
 * when invalid so the caller can report and skip the row.
 */
export function validateResultRow(raw: RawResultRow): ResultRowValidation {
  const meetingDate = (raw.date ?? '').trim();
  const course = (raw.course ?? '').trim();
  const offTime = (raw.off_time ?? '').trim();
  const horseName = (raw.horse_name ?? '').trim();

  const problems: string[] = [];
  if (!DATE_RE.test(meetingDate)) problems.push('date must be YYYY-MM-DD');
  if (course === '') problems.push('course is required');
  if (!TIME_RE.test(offTime)) problems.push('off_time must be HH:MM');
  if (horseName === '') problems.push('horse_name is required');

  const finishPos = parseFinishPos(raw.finish_pos);
  if (finishPos === null) problems.push('finish_pos must be a positive integer');

  const spDecimal = validateOptionalPrice(raw.sp_decimal, 'sp_decimal', problems);
  const bspDecimal = validateOptionalPrice(raw.bsp_decimal, 'bsp_decimal', problems);
  const runnerStatus = (raw.runner_status ?? '').trim() || null;

  const offTimeIso =
    problems.length === 0 ? composeOffTimeIso(meetingDate, offTime) : null;
  if (problems.length === 0 && offTimeIso === null) {
    problems.push('date/off_time do not form a valid instant');
  }

  if (problems.length > 0) {
    return { ok: false, problems, row: null };
  }

  return {
    ok: true,
    problems: [],
    row: {
      meetingDate,
      course,
      offTime,
      offTimeIso: offTimeIso as string,
      horseName,
      finishPos: finishPos as number,
      spDecimal,
      bspDecimal,
      runnerStatus,
    },
  };
}

/** The `runners` update payload — only ever the fields actually supplied. */
export interface RunnerResultPatch {
  finish_pos?: number;
  sp_decimal?: number;
  bsp_decimal?: number;
  runner_status?: string;
}

/**
 * Builds the per-runner update from a validated row. finish_pos is always set
 * (it is required); SP/BSP/status are included ONLY when supplied — so an
 * existing non-null value is never overwritten with null. Pure.
 */
export function buildRunnerResultPatch(row: NormalizedResultRow): RunnerResultPatch {
  const patch: RunnerResultPatch = { finish_pos: row.finishPos };
  if (row.spDecimal !== null) patch.sp_decimal = row.spDecimal;
  if (row.bspDecimal !== null) patch.bsp_decimal = row.bspDecimal;
  if (row.runnerStatus !== null) patch.runner_status = row.runnerStatus;
  return patch;
}

/** Minimal per-row shape the conflict detector reasons about. */
export interface RaceRowForConflict {
  runnerId: string;
  finishPos: number;
}

/** Whether a race's rows conflict, with human-readable reasons. */
export interface RaceConflictResult {
  conflicted: boolean;
  reasons: string[];
}

/**
 * Detects conflicts that must REFUSE a race (req 14): more than one runner
 * marked finish_pos=1, or the same runner appearing in more than one row
 * (duplicate horse rows). Pure; never throws.
 */
export function detectRaceConflicts(
  rows: readonly RaceRowForConflict[],
): RaceConflictResult {
  const reasons: string[] = [];

  const winners = rows.filter((r) => r.finishPos === 1).length;
  if (winners > 1) {
    reasons.push(`multiple runners marked finish_pos=1 (${winners})`);
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.runnerId)) duplicates.add(r.runnerId);
    seen.add(r.runnerId);
  }
  if (duplicates.size > 0) {
    reasons.push(`duplicate rows for the same runner (${duplicates.size})`);
  }

  return { conflicted: reasons.length > 0, reasons };
}

/** True when at least one row records the winner (finish_pos=1). Pure. */
export function raceHasWinner(rows: readonly { finishPos: number }[]): boolean {
  return rows.some((r) => r.finishPos === 1);
}

/** The audit counters reported as the import summary. */
export interface ResultsImportAudit {
  rows_read: number;
  races_matched: number;
  runners_matched: number;
  runners_updated: number;
  unmatched_races: number;
  unmatched_runners: number;
  ambiguous_rows: number;
  skipped_rows: number;
}

/** A fresh, all-zero audit. Pure. */
export function newAudit(): ResultsImportAudit {
  return {
    rows_read: 0,
    races_matched: 0,
    runners_matched: 0,
    runners_updated: 0,
    unmatched_races: 0,
    unmatched_runners: 0,
    ambiguous_rows: 0,
    skipped_rows: 0,
  };
}

/** Parsed CLI args. */
export interface Args {
  file?: string;
  commit: boolean;
}

/** Parses `--file <path>` and `--commit`. Pure. */
export function parseArgs(argv: string[]): Args {
  const args: Args = { commit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.commit = true;
    else if (a === '--file') args.file = argv[++i];
  }
  return args;
}

// ---------------------------------------------------------------------------
// I/O (resolution + writes; not imported by tests)
// ---------------------------------------------------------------------------

/** Loads env from .env.local then .env (first found wins). */
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Try the next; fall back to the shell environment.
    }
  }
}

interface RaceRow {
  id: string;
  course: string;
  off_time: string | null;
}

interface ResolvedRace {
  status: 'resolved' | 'unmatched' | 'ambiguous';
  raceId?: string;
  runners?: MatchableRunner[];
}

/** A validated row paired with its 1-based CSV line number. */
interface ValidatedRow {
  line: number;
  row: NormalizedResultRow;
}

/** A row that resolved to a unique race + runner, grouped per race. */
interface ResolvedRow {
  line: number;
  runnerId: string;
  row: NormalizedResultRow;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { file, commit } = args;

  if (!file) {
    console.error(
      'Usage:\n' +
        '  npm run import:results -- --file <path.csv> [--commit]\n' +
        `  CSV columns: ${REQUIRED_COLUMNS.join(', ')}` +
        ` (optional: ${OPTIONAL_COLUMNS.join(', ')})`,
    );
    process.exitCode = 1;
    return;
  }

  loadEnv();

  const text = readFileSync(file, 'utf8');
  const parsed = parseCsv(text);
  if (parsed.length === 0) {
    console.error(`No rows found in ${file}.`);
    process.exitCode = 1;
    return;
  }

  // Header validation.
  const header = parsed[0].map((h) => h.trim());
  const colIndex = new Map<string, number>();
  header.forEach((name, i) => {
    if (!colIndex.has(name)) colIndex.set(name, i);
  });
  const missingCols = REQUIRED_COLUMNS.filter((c) => !colIndex.has(c));
  if (missingCols.length > 0) {
    console.error(`CSV is missing required column(s): ${missingCols.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const cell = (cells: string[], name: string): string => {
    const idx = colIndex.get(name);
    return idx === undefined ? '' : (cells[idx] ?? '').trim();
  };

  const audit = newAudit();
  const skipReasons: string[] = [];
  const unmatchedRaceDetails: string[] = [];
  const unmatchedRunnerDetails: string[] = [];
  const refusedRaceDetails: string[] = [];
  let hasPlaceholder = false;

  const dataRows = parsed.slice(1).filter((cells) => !isBlankRow(cells));
  audit.rows_read = dataRows.length;

  // 1. Validate every row up front (pure).
  const validated: ValidatedRow[] = [];
  for (let r = 0; r < dataRows.length; r++) {
    const cells = dataRows[r];
    const lineNo = r + 2; // 1-based, +1 for the header row

    const raw: RawResultRow = {
      date: cell(cells, 'date'),
      course: cell(cells, 'course'),
      off_time: cell(cells, 'off_time'),
      horse_name: cell(cells, 'horse_name'),
      finish_pos: cell(cells, 'finish_pos'),
      sp_decimal: cell(cells, 'sp_decimal'),
      bsp_decimal: cell(cells, 'bsp_decimal'),
      runner_status: cell(cells, 'runner_status'),
    };

    for (const value of Object.values(raw)) {
      if (PLACEHOLDER_RE.test(value)) hasPlaceholder = true;
    }

    const validation = validateResultRow(raw);
    if (!validation.ok || validation.row === null) {
      audit.skipped_rows++;
      skipReasons.push(`line ${lineNo}: ${validation.problems.join('; ')}`);
      continue;
    }
    validated.push({ line: lineNo, row: validation.row });
  }

  // 2. Resolve race + runner for each validated row, grouping by race.
  const racesByDate = new Map<string, RaceRow[]>();
  const raceResolutionCache = new Map<string, ResolvedRace>();
  const perRace = new Map<string, ResolvedRow[]>();

  for (const { line, row } of validated) {
    const resolved = await resolveRace(
      racesByDate,
      raceResolutionCache,
      row.meetingDate,
      row.course,
      row.offTimeIso,
    );
    if (resolved.status === 'unmatched') {
      audit.unmatched_races++;
      unmatchedRaceDetails.push(
        `line ${line}: no race for ${row.course} ${row.meetingDate} ${row.offTime}`,
      );
      continue;
    }
    if (resolved.status === 'ambiguous') {
      audit.unmatched_races++;
      unmatchedRaceDetails.push(
        `line ${line}: ambiguous race (multiple match) for ${row.course} ${row.meetingDate} ${row.offTime}`,
      );
      continue;
    }

    const runners = resolved.runners ?? [];
    const target = normalizeHorseName(row.horseName);
    const sameNameCount = runners.filter(
      (rn) => normalizeHorseName(rn.horse_name) === target,
    ).length;
    const runnerId = matchRunnerId(runners, row.horseName);
    if (runnerId === null) {
      if (sameNameCount > 1) {
        audit.ambiguous_rows++;
        unmatchedRunnerDetails.push(
          `line ${line}: ambiguous horse "${row.horseName}" in race (matches ${sameNameCount})`,
        );
      } else {
        audit.unmatched_runners++;
        unmatchedRunnerDetails.push(
          `line ${line}: no runner "${row.horseName}" in race`,
        );
      }
      continue;
    }

    audit.runners_matched++;
    const raceId = resolved.raceId as string;
    const group = perRace.get(raceId) ?? [];
    group.push({ line, runnerId, row });
    perRace.set(raceId, group);
  }

  audit.races_matched = perRace.size;

  // 3. Per race: refuse conflicts; otherwise build the updates + settle flag.
  const runnerUpdates: { runnerId: string; patch: RunnerResultPatch }[] = [];
  const racesToSettle: string[] = [];

  for (const [raceId, rows] of perRace) {
    const conflicts = detectRaceConflicts(
      rows.map((r) => ({ runnerId: r.runnerId, finishPos: r.row.finishPos })),
    );
    if (conflicts.conflicted) {
      audit.ambiguous_rows += rows.length;
      refusedRaceDetails.push(
        `race ${raceId} (lines ${rows.map((r) => r.line).join(', ')}): ` +
          `${conflicts.reasons.join('; ')} — refused`,
      );
      continue;
    }

    for (const r of rows) {
      runnerUpdates.push({ runnerId: r.runnerId, patch: buildRunnerResultPatch(r.row) });
      audit.runners_updated++;
    }
    if (raceHasWinner(rows.map((r) => r.row))) {
      racesToSettle.push(raceId);
    }
  }

  printSummary(audit, commit, hasPlaceholder, {
    skipReasons,
    unmatchedRaceDetails,
    unmatchedRunnerDetails,
    refusedRaceDetails,
    racesToSettle: racesToSettle.length,
  });

  // Commit gate: never write while placeholder text remains.
  if (commit && hasPlaceholder) {
    console.error(
      '\nRefusing to --commit: placeholder "EXAMPLE" text is present. ' +
        'Replace it with real operator-curated results first.',
    );
    process.exitCode = 1;
    return;
  }

  if (!commit) {
    console.log(
      '\n(dry run) No rows written. Re-run with --commit to apply ' +
        `${runnerUpdates.length} runner update(s) and settle ${racesToSettle.length} race(s).`,
    );
    return;
  }

  if (runnerUpdates.length === 0) {
    console.log('\nNothing to update.');
    return;
  }

  // 4. Apply runner result updates (only the supplied fields — never nulls).
  for (const { runnerId, patch } of runnerUpdates) {
    const { error } = await supabaseAdmin
      .from(RUNNERS_TABLE)
      .update(patch)
      .eq('id', runnerId);
    if (error) throw new Error(`runner result update failed: ${error.message}`);
  }

  // 5. Mark settled races (status + official_result_time) — winner present only.
  const nowIso = new Date().toISOString();
  for (const raceId of racesToSettle) {
    const { error } = await supabaseAdmin
      .from(RACES_TABLE)
      .update({ status: 'result', official_result_time: nowIso })
      .eq('id', raceId);
    if (error) throw new Error(`race status update failed: ${error.message}`);
  }

  console.log(
    `\nUpdated ${runnerUpdates.length} runner(s); marked ${racesToSettle.length} race(s) settled.`,
  );
}

/**
 * Resolves a race by date + normalised course + canonical off-time instant,
 * caching the day's races and the per-key resolution. On a resolved race it
 * loads that race's runners (once). Read-only.
 */
async function resolveRace(
  racesByDate: Map<string, RaceRow[]>,
  cache: Map<string, ResolvedRace>,
  meetingDate: string,
  course: string,
  offTimeIso: string,
): Promise<ResolvedRace> {
  const wantCourse = normalizeCourse(course);
  const key = `${meetingDate}|${wantCourse}|${offTimeIso}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let dayRaces = racesByDate.get(meetingDate);
  if (!dayRaces) {
    const { data, error } = await supabaseAdmin
      .from(RACES_TABLE)
      .select('id, course, off_time')
      .eq('meeting_date', meetingDate);
    if (error) {
      throw new Error(`races lookup failed for ${meetingDate}: ${error.message}`);
    }
    dayRaces = ((data ?? []) as RaceRow[]).map((r) => ({
      id: String(r.id),
      course: r.course,
      off_time: r.off_time,
    }));
    racesByDate.set(meetingDate, dayRaces);
  }

  // Pure matching decision (course + off-time), then load runners on a hit.
  const outcome = matchResultRace(dayRaces, course, offTimeIso);
  let result: ResolvedRace;
  if (outcome.status === 'resolved' && outcome.raceId) {
    result = {
      status: 'resolved',
      raceId: outcome.raceId,
      runners: await fetchRunners(outcome.raceId),
    };
  } else {
    result = { status: outcome.status };
  }
  cache.set(key, result);
  return result;
}

/** Loads the runners for a race as matcher inputs. Read-only. */
async function fetchRunners(raceId: string): Promise<MatchableRunner[]> {
  const { data, error } = await supabaseAdmin
    .from(RUNNERS_TABLE)
    .select('id, horse_name')
    .eq('race_id', raceId);
  if (error) {
    throw new Error(`runners lookup failed for race ${raceId}: ${error.message}`);
  }
  return ((data ?? []) as { id: string | number; horse_name: string }[]).map((r) => ({
    id: r.id,
    horse_name: r.horse_name,
  }));
}

/** Prints the audit summary (the 8 required counts) plus reported detail. */
function printSummary(
  audit: ResultsImportAudit,
  commit: boolean,
  hasPlaceholder: boolean,
  detail: {
    skipReasons: string[];
    unmatchedRaceDetails: string[];
    unmatchedRunnerDetails: string[];
    refusedRaceDetails: string[];
    racesToSettle: number;
  },
): void {
  console.log(`Manual results import — ${commit ? 'COMMIT' : 'DRY RUN'}`);
  console.log('Audit summary:');
  console.log(`  rows_read: ${audit.rows_read}`);
  console.log(`  races_matched: ${audit.races_matched}`);
  console.log(`  runners_matched: ${audit.runners_matched}`);
  console.log(`  runners_updated: ${audit.runners_updated}`);
  console.log(`  unmatched_races: ${audit.unmatched_races}`);
  console.log(`  unmatched_runners: ${audit.unmatched_runners}`);
  console.log(`  ambiguous_rows: ${audit.ambiguous_rows}`);
  console.log(`  skipped_rows: ${audit.skipped_rows}`);
  console.log(`  races_to_settle: ${detail.racesToSettle}`);
  if (hasPlaceholder) {
    console.log('  placeholder_example_present: true');
  }

  if (detail.skipReasons.length > 0) {
    console.log('\nSkipped rows (validation):');
    for (const reason of detail.skipReasons) console.log(`  - ${reason}`);
  }
  if (detail.unmatchedRaceDetails.length > 0) {
    console.log('\nUnmatched races (never auto-matched):');
    for (const d of detail.unmatchedRaceDetails) console.log(`  - ${d}`);
  }
  if (detail.unmatchedRunnerDetails.length > 0) {
    console.log('\nUnmatched / ambiguous runners:');
    for (const d of detail.unmatchedRunnerDetails) console.log(`  - ${d}`);
  }
  if (detail.refusedRaceDetails.length > 0) {
    console.log('\nRefused races (conflicts — not written):');
    for (const d of detail.refusedRaceDetails) console.log(`  - ${d}`);
  }
}

/** Run only when invoked directly, so importing for tests triggers no I/O. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
