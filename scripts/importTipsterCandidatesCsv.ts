/**
 * Manual "hot tipster" candidate CSV importer (Phase 4B).
 *
 * Bulk-captures proven / in-form tipsters and their picks into the REVIEW QUEUE
 * (`tipster_selection_candidates`) from an operator-curated CSV. It is the fast
 * path for getting picks INTO review — it is deliberately NOT a way to make them
 * model-active:
 *
 *   - WRITES CANDIDATES ONLY. Every row is inserted with `status = 'pending'`
 *     into `tipster_selection_candidates`. It NEVER writes `tipster_selections`
 *     (the table the model reads) and NEVER approves anything. A captured pick
 *     has zero effect on the model until you approve it through the review
 *     workflow (scripts/reviewTipsterCandidates.ts).
 *   - READ-ONLY BY DEFAULT (dry run). Writes NOTHING unless `--commit` is passed,
 *     and REFUSES to commit while any field still contains placeholder "EXAMPLE"
 *     text (so the template can't be inserted by accident).
 *   - NEVER FABRICATES. Race/runner resolution is EXACT + normalised only (date +
 *     normalised course + UTC off-time for the race; exact normalised horse name
 *     for the runner). Resolution is computed only as a DIAGNOSTIC so you can see
 *     what will resolve at approval time — it does NOT gate capture. Unmatched or
 *     ambiguous rows are still captured as pending candidates (they "stay in
 *     review"), never guessed and never auto-approved.
 *   - PRESERVES PROVENANCE + EVIDENCE. source_label (required) plus optional
 *     source_name / source_url / proof_url / confidence_text / evidence_confidence
 *     / notes are stored verbatim on the candidate for audit.
 *
 * It does NOT scrape, does NOT call any GenAI, and changes NO model maths or
 * staking.
 *
 * CSV columns (header row required):
 *   required: date (YYYY-MM-DD), course, off_time (HH:MM), horse_name,
 *             tipster_name, source_label
 *   optional: race_name, source_name, source_url, proof_url, confidence_text,
 *             evidence_confidence (high|medium|low), notes
 *
 * IMPORTANT — off_time is the race's STORED off time, which is UTC (e.g. a 2:30pm
 * BST Royal Ascot race is stored as 13:30). Use the time shown by the dashboard
 * or `npm run import:tipster-selections -- --list-races --date <date>`.
 *
 * Usage:
 *   npm run import:tipster-candidates -- --file data/hot-tipsters.csv           # dry run
 *   npm run import:tipster-candidates -- --file data/hot-tipsters.csv --commit  # writes candidates
 *
 * REQUIRES SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env.local` (or `.env`),
 * and the Phase 4B migration applied before `--commit`. Credentials are never
 * logged.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse, normalizeHorseName } from '../src/lib/raceSync';
import { matchRunnerId, type MatchableRunner } from '../src/lib/runnerMatch';
import {
  validateCandidate,
  composeOffTimeIso,
  canonicalOffTimeIso,
} from '../src/lib/tipsterCandidates';

const CANDIDATES_TABLE = 'tipster_selection_candidates';
const RACES_TABLE = 'races';
const RUNNERS_TABLE = 'runners';

const REQUIRED_COLUMNS = [
  'date',
  'course',
  'off_time',
  'horse_name',
  'tipster_name',
  'source_label',
] as const;
const OPTIONAL_COLUMNS = [
  'race_name',
  'source_name',
  'source_url',
  'proof_url',
  'confidence_text',
  'evidence_confidence',
  'notes',
] as const;

const PLACEHOLDER_RE = /EXAMPLE/i;

/** Accepted evidence_confidence values (operator's assessment of the evidence). */
export const EVIDENCE_CONFIDENCE_VALUES = ['high', 'medium', 'low'] as const;
export type EvidenceConfidence = (typeof EVIDENCE_CONFIDENCE_VALUES)[number];

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

/** Trims a possibly-missing string; empty/blank becomes null. Pure. */
function trimOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Result of validating an optional `evidence_confidence` cell. */
export interface EvidenceConfidenceResult {
  ok: boolean;
  value: EvidenceConfidence | null;
}

/**
 * Validates the optional `evidence_confidence` cell: blank -> null (not given);
 * `high`/`medium`/`low` (case-insensitive) -> the normalised value; anything
 * else -> not ok (the caller reports + skips the row). Pure.
 */
export function normalizeEvidenceConfidence(
  value: string | null | undefined,
): EvidenceConfidenceResult {
  const t = (value ?? '').trim().toLowerCase();
  if (t === '') return { ok: true, value: null };
  if ((EVIDENCE_CONFIDENCE_VALUES as readonly string[]).includes(t)) {
    return { ok: true, value: t as EvidenceConfidence };
  }
  return { ok: false, value: null };
}

/** True for a non-blank value that looks like an http(s) URL. Pure. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

/** A raw candidate-import row, as read from the CSV (all cells are strings). */
export interface RawCandidateImportRow {
  date: string;
  course: string;
  off_time: string;
  horse_name: string;
  tipster_name: string;
  source_label: string;
  race_name: string;
  source_name: string;
  source_url: string;
  proof_url: string;
  confidence_text: string;
  evidence_confidence: string;
  notes: string;
}

/** A validated, normalised candidate-import row ready to map + resolve. */
export interface NormalizedCandidateImportRow {
  meetingDate: string;
  course: string;
  offTime: string;
  offTimeIso: string;
  horseName: string;
  tipsterName: string;
  sourceLabel: string;
  raceName: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
  proofUrl: string | null;
  confidenceText: string | null;
  evidenceConfidence: EvidenceConfidence | null;
  notes: string | null;
}

/** Result of validating one raw candidate-import row. `row` is null when not ok. */
export interface CandidateImportValidation {
  ok: boolean;
  problems: string[];
  row: NormalizedCandidateImportRow | null;
}

/**
 * Validates + normalises a raw candidate-import row (Phase 4B). The five core
 * fields (date/course/off_time/horse_name/tipster_name) are validated by the
 * shared {@link validateCandidate}; on top of that this requires a non-blank
 * `source_label` (every captured pick must be attributable), validates the
 * optional `evidence_confidence` against high/medium/low, and requires any
 * supplied `source_url` / `proof_url` to look like an http(s) URL. Pure; never
 * throws and never fabricates (missing optional -> null).
 */
export function validateCandidateImportRow(
  raw: RawCandidateImportRow,
): CandidateImportValidation {
  // Core 5 required fields via the shared Phase 4A validator.
  const core = validateCandidate({
    meeting_date: raw.date,
    course: raw.course,
    off_time: raw.off_time,
    horse_name: raw.horse_name,
    tipster_name: raw.tipster_name,
  });
  const problems = [...core.problems];

  // Phase 4B: source_label is required (provenance is mandatory for capture).
  const sourceLabel = (raw.source_label ?? '').trim();
  if (sourceLabel === '') problems.push('source_label is required');

  // Optional URL fields, when present, must look like URLs.
  const sourceUrl = (raw.source_url ?? '').trim();
  if (sourceUrl !== '' && !isHttpUrl(sourceUrl)) {
    problems.push('source_url must be an http(s) URL');
  }
  const proofUrl = (raw.proof_url ?? '').trim();
  if (proofUrl !== '' && !isHttpUrl(proofUrl)) {
    problems.push('proof_url must be an http(s) URL');
  }

  // Optional evidence_confidence must be high/medium/low when present.
  const evidence = normalizeEvidenceConfidence(raw.evidence_confidence);
  if (!evidence.ok) {
    problems.push('evidence_confidence must be one of: high, medium, low');
  }

  const offTimeIso =
    core.candidate !== null
      ? composeOffTimeIso(core.candidate.meeting_date, core.candidate.off_time)
      : null;
  if (core.candidate !== null && offTimeIso === null) {
    problems.push('date/off_time do not form a valid instant');
  }

  if (problems.length > 0 || core.candidate === null || offTimeIso === null) {
    return { ok: false, problems, row: null };
  }

  return {
    ok: true,
    problems: [],
    row: {
      meetingDate: core.candidate.meeting_date,
      course: core.candidate.course,
      offTime: core.candidate.off_time,
      offTimeIso,
      horseName: core.candidate.horse_name,
      tipsterName: core.candidate.tipster_name,
      sourceLabel,
      raceName: trimOrNull(raw.race_name),
      sourceName: trimOrNull(raw.source_name),
      sourceUrl: trimOrNull(raw.source_url),
      proofUrl: trimOrNull(raw.proof_url),
      confidenceText: trimOrNull(raw.confidence_text),
      evidenceConfidence: evidence.value,
      notes: trimOrNull(raw.notes),
    },
  };
}

/** The `tipster_selection_candidates` insert payload for a captured pick. */
export interface CandidateInsert {
  meeting_date: string;
  course: string;
  off_time: string;
  horse_name: string;
  tipster_name: string;
  source_label: string;
  race_name: string | null;
  source_name: string | null;
  source_url: string | null;
  proof_url: string | null;
  confidence_text: string | null;
  evidence_confidence: string | null;
  notes: string | null;
  status: 'pending';
}

/**
 * Maps a validated import row to the candidate insert object. Always
 * `status = 'pending'` — this importer never approves and never sets
 * race_id/runner_id/tipster_id (those are resolved + written only at approval
 * time by the review workflow). Pure; does not mutate its input.
 */
export function buildCandidateInsert(
  row: NormalizedCandidateImportRow,
): CandidateInsert {
  return {
    meeting_date: row.meetingDate,
    course: row.course,
    off_time: row.offTime,
    horse_name: row.horseName,
    tipster_name: row.tipsterName,
    source_label: row.sourceLabel,
    race_name: row.raceName,
    source_name: row.sourceName,
    source_url: row.sourceUrl,
    proof_url: row.proofUrl,
    confidence_text: row.confidenceText,
    evidence_confidence: row.evidenceConfidence,
    notes: row.notes,
    status: 'pending',
  };
}

/** A candidate day-race row for pure race resolution. */
export interface CandidateRaceRow {
  id: string;
  course: string;
  off_time: string | null;
}

/** Outcome of resolving a row to a race/runner (diagnostic only). */
export type ResolutionStatus = 'resolved' | 'unmatched' | 'ambiguous';

/**
 * Pure race resolution: among a day's races, find the one whose normalised
 * course AND canonical off-time instant both equal the row's. Exactly one ->
 * resolved; zero -> unmatched; several -> ambiguous (never guessed). Diagnostic
 * only — it does not gate candidate capture. Pure.
 */
export function matchCandidateRace(
  dayRaces: readonly CandidateRaceRow[],
  course: string,
  offTimeIso: string,
): { status: ResolutionStatus; raceId: string | null } {
  const wantCourse = normalizeCourse(course);
  const matches = dayRaces.filter(
    (r) =>
      normalizeCourse(r.course) === wantCourse &&
      canonicalOffTimeIso(r.off_time) === offTimeIso,
  );
  if (matches.length === 0) return { status: 'unmatched', raceId: null };
  if (matches.length > 1) return { status: 'ambiguous', raceId: null };
  return { status: 'resolved', raceId: matches[0].id };
}

/**
 * Pure runner resolution within a matched race: exact normalised horse-name
 * match to exactly one runner -> resolved; zero -> unmatched; two normalising to
 * the same name -> ambiguous (never guessed). Diagnostic only. Pure.
 */
export function resolveCandidateRunner(
  runners: readonly MatchableRunner[],
  horseName: string,
): { status: ResolutionStatus; runnerId: string | null } {
  const target = normalizeHorseName(horseName);
  const sameNameCount = runners.filter(
    (r) => normalizeHorseName(r.horse_name) === target,
  ).length;
  const runnerId = matchRunnerId(runners, horseName);
  if (runnerId !== null) return { status: 'resolved', runnerId };
  if (sameNameCount > 1) return { status: 'ambiguous', runnerId: null };
  return { status: 'unmatched', runnerId: null };
}

/** A natural dedupe key for a row, so the same pick is not captured twice. Pure. */
export function candidateDedupeKey(row: NormalizedCandidateImportRow): string {
  return [
    row.meetingDate,
    normalizeCourse(row.course),
    row.offTimeIso,
    normalizeHorseName(row.horseName),
    row.tipsterName.trim().toLowerCase(),
    row.sourceLabel.trim().toLowerCase(),
  ].join('|');
}

/** The audit counters reported as the import summary (req 9). */
export interface CandidateImportAudit {
  rows_read: number;
  candidates_valid: number;
  races_resolved: number;
  runners_resolved: number;
  ambiguous: number;
  unmatched: number;
  skipped: number;
}

/** A fresh, all-zero audit. Pure. */
export function newAudit(): CandidateImportAudit {
  return {
    rows_read: 0,
    candidates_valid: 0,
    races_resolved: 0,
    runners_resolved: 0,
    ambiguous: 0,
    unmatched: 0,
    skipped: 0,
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
// I/O (resolution diagnostics + writes; not imported by tests)
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

interface ResolvedRaceCache {
  status: ResolutionStatus;
  raceId: string | null;
  runners: MatchableRunner[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { file, commit } = args;

  if (!file) {
    console.error(
      'Usage:\n' +
        '  npm run import:tipster-candidates -- --file <path.csv> [--commit]\n' +
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
  const resolutionNotes: string[] = [];
  let hasPlaceholder = false;

  const dataRows = parsed.slice(1).filter((cells) => !isBlankRow(cells));
  audit.rows_read = dataRows.length;

  // Per-day race cache + per-race runner cache for resolution diagnostics.
  const racesByDate = new Map<string, CandidateRaceRow[]>();
  const raceResolutionCache = new Map<string, ResolvedRaceCache>();
  const seenKeys = new Set<string>();
  const batch: CandidateInsert[] = [];

  for (let r = 0; r < dataRows.length; r++) {
    const cells = dataRows[r];
    const lineNo = r + 2; // 1-based, +1 for the header row

    const raw: RawCandidateImportRow = {
      date: cell(cells, 'date'),
      course: cell(cells, 'course'),
      off_time: cell(cells, 'off_time'),
      horse_name: cell(cells, 'horse_name'),
      tipster_name: cell(cells, 'tipster_name'),
      source_label: cell(cells, 'source_label'),
      race_name: cell(cells, 'race_name'),
      source_name: cell(cells, 'source_name'),
      source_url: cell(cells, 'source_url'),
      proof_url: cell(cells, 'proof_url'),
      confidence_text: cell(cells, 'confidence_text'),
      evidence_confidence: cell(cells, 'evidence_confidence'),
      notes: cell(cells, 'notes'),
    };

    for (const value of Object.values(raw)) {
      if (PLACEHOLDER_RE.test(value)) hasPlaceholder = true;
    }

    const validation = validateCandidateImportRow(raw);
    if (!validation.ok || validation.row === null) {
      audit.skipped++;
      skipReasons.push(`line ${lineNo}: ${validation.problems.join('; ')}`);
      continue;
    }

    // Within-CSV dedupe (no DB unique index exists on candidates).
    const key = candidateDedupeKey(validation.row);
    if (seenKeys.has(key)) {
      audit.skipped++;
      skipReasons.push(`line ${lineNo}: duplicate row in CSV (same pick + source)`);
      continue;
    }
    seenKeys.add(key);

    audit.candidates_valid++;
    batch.push(buildCandidateInsert(validation.row));

    // Resolution DIAGNOSTIC (read-only; never gates capture).
    const resolved = await resolveRaceDiag(
      racesByDate,
      raceResolutionCache,
      validation.row,
    );
    if (resolved.status === 'unmatched') {
      audit.unmatched++;
      resolutionNotes.push(
        `line ${lineNo}: race not found yet for ${validation.row.course} ` +
          `${validation.row.meetingDate} ${validation.row.offTime} (stays pending)`,
      );
      continue;
    }
    if (resolved.status === 'ambiguous') {
      audit.ambiguous++;
      resolutionNotes.push(
        `line ${lineNo}: ambiguous race for ${validation.row.course} ` +
          `${validation.row.meetingDate} ${validation.row.offTime} (stays pending)`,
      );
      continue;
    }

    audit.races_resolved++;
    const runner = resolveCandidateRunner(resolved.runners, validation.row.horseName);
    if (runner.status === 'resolved') {
      audit.runners_resolved++;
    } else if (runner.status === 'ambiguous') {
      audit.ambiguous++;
      resolutionNotes.push(
        `line ${lineNo}: ambiguous horse "${validation.row.horseName}" in race (stays pending)`,
      );
    } else {
      audit.unmatched++;
      resolutionNotes.push(
        `line ${lineNo}: horse "${validation.row.horseName}" not in race yet (stays pending)`,
      );
    }
  }

  printSummary(audit, commit, hasPlaceholder, { skipReasons, resolutionNotes });

  // Commit gate: never write while placeholder text remains.
  if (commit && hasPlaceholder) {
    console.error(
      '\nRefusing to --commit: placeholder "EXAMPLE" text is present. ' +
        'Replace it with real operator-curated picks first.',
    );
    process.exitCode = 1;
    return;
  }

  if (!commit) {
    console.log(
      '\n(dry run) No candidates written. Re-run with --commit to insert ' +
        `${batch.length} pending candidate(s) for review.`,
    );
    return;
  }

  if (batch.length === 0) {
    console.log('\nNothing to insert.');
    return;
  }

  const { error } = await supabaseAdmin.from(CANDIDATES_TABLE).insert(batch);
  if (error) {
    throw new Error(`tipster_selection_candidates insert failed: ${error.message}`);
  }
  console.log(
    `\nCaptured ${batch.length} pending candidate(s). Review + approve with ` +
      '`npm run review:tipster-candidates`. Nothing is model-active until approved.',
  );
}

/**
 * Resolves a row's race (cached per day + per key) and loads that race's runners
 * once, for the read-only resolution diagnostic. Never writes.
 */
async function resolveRaceDiag(
  racesByDate: Map<string, CandidateRaceRow[]>,
  cache: Map<string, ResolvedRaceCache>,
  row: NormalizedCandidateImportRow,
): Promise<ResolvedRaceCache> {
  const wantCourse = normalizeCourse(row.course);
  const key = `${row.meetingDate}|${wantCourse}|${row.offTimeIso}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let dayRaces = racesByDate.get(row.meetingDate);
  if (!dayRaces) {
    const { data, error } = await supabaseAdmin
      .from(RACES_TABLE)
      .select('id, course, off_time')
      .eq('meeting_date', row.meetingDate);
    if (error) {
      throw new Error(`races lookup failed for ${row.meetingDate}: ${error.message}`);
    }
    dayRaces = ((data ?? []) as CandidateRaceRow[]).map((d) => ({
      id: String(d.id),
      course: d.course,
      off_time: d.off_time,
    }));
    racesByDate.set(row.meetingDate, dayRaces);
  }

  const match = matchCandidateRace(dayRaces, row.course, row.offTimeIso);
  let result: ResolvedRaceCache;
  if (match.status === 'resolved' && match.raceId) {
    result = { status: 'resolved', raceId: match.raceId, runners: await fetchRunners(match.raceId) };
  } else {
    result = { status: match.status, raceId: null, runners: [] };
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
  return ((data ?? []) as { id: string | number; horse_name: string }[]).map((d) => ({
    id: d.id,
    horse_name: d.horse_name,
  }));
}

/** Prints the audit summary (the 7 required counts) plus reported detail. */
function printSummary(
  audit: CandidateImportAudit,
  commit: boolean,
  hasPlaceholder: boolean,
  detail: { skipReasons: string[]; resolutionNotes: string[] },
): void {
  console.log(`Hot tipster candidate import — ${commit ? 'COMMIT' : 'DRY RUN'}`);
  console.log('Audit summary:');
  console.log(`  rows_read: ${audit.rows_read}`);
  console.log(`  candidates_valid: ${audit.candidates_valid}`);
  console.log(`  races_resolved: ${audit.races_resolved}`);
  console.log(`  runners_resolved: ${audit.runners_resolved}`);
  console.log(`  ambiguous: ${audit.ambiguous}`);
  console.log(`  unmatched: ${audit.unmatched}`);
  console.log(`  skipped: ${audit.skipped}`);
  if (hasPlaceholder) {
    console.log('  placeholder_example_present: true');
  }

  if (detail.skipReasons.length > 0) {
    console.log('\nSkipped rows (validation / duplicates):');
    for (const reason of detail.skipReasons) console.log(`  - ${reason}`);
  }
  if (detail.resolutionNotes.length > 0) {
    console.log('\nResolution diagnostics (captured anyway — stay in review):');
    for (const note of detail.resolutionNotes) console.log(`  - ${note}`);
  }
  console.log(
    '\nAll captured rows are PENDING candidates. They are NOT model-active until ' +
      'approved via `npm run review:tipster-candidates`.',
  );
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
