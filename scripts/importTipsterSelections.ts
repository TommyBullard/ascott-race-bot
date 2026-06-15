/**
 * Manual CSV importer for tipster_selections (Batch K1a).
 *
 * Populates `tipster_selections` from an OPERATOR-CURATED, ToS-compliant CSV of
 * real tipster picks. It is deliberately conservative and auditable:
 *
 *   - READ-ONLY BY DEFAULT (dry run). It writes NOTHING unless `--commit` is
 *     passed, and it REFUSES to commit while any field still contains
 *     placeholder "EXAMPLE" text (so the template can't be inserted by accident).
 *   - NEVER FABRICATES. A row is only insertable when its race AND runner are
 *     resolved unambiguously from existing DB rows. Unmatched/ambiguous race or
 *     horse -> the row is SKIPPED and reported, never guessed. A tipster name
 *     that cannot be resolved to a canonical tipster is stored with
 *     `tipster_id = null` (the verbatim raw name is kept for audit).
 *   - IDEMPOTENT. Inserts use upsert + ignoreDuplicates on the unique index
 *     (race_id, runner_id, raw_tipster_name), so re-importing the same pick
 *     never double-counts it in tipster consensus. Requires the migration
 *     supabase/migrations/20260615020000_tipster_selections_idempotency.sql.
 *   - It does NOT run the model. The next scheduled/manual model run consumes
 *     the new selections (append-only model history handles re-runs).
 *
 * CSV columns (header row required):
 *   required: meeting_date (YYYY-MM-DD), course, off_time (HH:MM),
 *             horse_name, tipster_name
 *   optional: raw_affiliation, source_label
 *
 * Race resolution: the off time is composed as `<meeting_date>T<HH:MM>:00Z`
 * (UTC), matching the repo's existing convention (resolveOffTime in raceSync).
 * Among the day's races, a race matches when its normalised course
 * (normalizeCourse) AND its canonicalised off-time instant both equal the row's.
 *
 * Usage:
 *   npm run import:tipster-selections -- --file data/tipster-selections.csv
 *   npm run import:tipster-selections -- --file data/tipster-selections.csv --commit
 *
 * REQUIRES SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env.local` (or `.env`).
 * Credentials are never logged.
 */

import { readFileSync } from 'node:fs';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse, normalizeHorseName } from '../src/lib/raceSync';
import { matchRunnerId, type MatchableRunner } from '../src/lib/runnerMatch';
import { resolveCanonicalTipster } from '../src/lib/raceData';
import {
  availableRunnerNames,
  buildFixCsvSection,
  formatRaceListingLines,
  summarizeNearbyRaces,
  type DiagRaceRow,
} from '../src/lib/tipsterImportDiagnostics';

const TIPSTER_SELECTIONS_TABLE = 'tipster_selections';
const RACES_TABLE = 'races';
const RUNNERS_TABLE = 'runners';

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

interface Args {
  file?: string;
  commit: boolean;
  /** Read-only listing mode: print candidate races (no CSV needed). */
  listRaces: boolean;
  /** YYYY-MM-DD filter for --list-races (defaults to today, UTC). */
  date?: string;
  /** Course filter for --list-races (normalised match). */
  course?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { commit: false, listRaces: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.commit = true;
    else if (a === '--list-races') args.listRaces = true;
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--course') args.course = argv[++i];
  }
  return args;
}

const REQUIRED_COLUMNS = [
  'meeting_date',
  'course',
  'off_time',
  'horse_name',
  'tipster_name',
] as const;
const OPTIONAL_COLUMNS = ['raw_affiliation', 'source_label'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;
const PLACEHOLDER_RE = /EXAMPLE/i;

/** Parsed counters reported as the audit summary. */
interface Audit {
  rows_read: number;
  rows_validated: number;
  rows_insertable: number;
  rows_inserted_or_would_insert: number;
  skipped_missing_required: number;
  skipped_unmatched_race: number;
  skipped_ambiguous_race: number;
  skipped_unmatched_horse: number;
  skipped_ambiguous_horse: number;
  tipsters_resolved: number;
  tipsters_unresolved: number;
  duplicate_rows_ignored_or_would_ignore: number;
}

function newAudit(): Audit {
  return {
    rows_read: 0,
    rows_validated: 0,
    rows_insertable: 0,
    rows_inserted_or_would_insert: 0,
    skipped_missing_required: 0,
    skipped_unmatched_race: 0,
    skipped_ambiguous_race: 0,
    skipped_unmatched_horse: 0,
    skipped_ambiguous_horse: 0,
    tipsters_resolved: 0,
    tipsters_unresolved: 0,
    duplicate_rows_ignored_or_would_ignore: 0,
  };
}

/**
 * Minimal RFC-4180 CSV parser: handles quoted fields, escaped quotes (""), and
 * commas/newlines inside quotes. Returns rows of raw string cells. Pure.
 */
function parseCsv(text: string): string[][] {
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

/** True when a row is entirely empty (e.g. a blank trailing line). */
function isBlankRow(cells: string[]): boolean {
  return cells.every((c) => c.trim() === '');
}

/** Composes the UTC off-time instant from meeting_date + HH:MM, or null. */
function composeOffTimeIso(meetingDate: string, offTime: string): string | null {
  const hhmm = offTime.trim().padStart(5, '0');
  const ms = Date.parse(`${meetingDate}T${hhmm}:00Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Canonicalises a DB timestamp to a comparable ISO instant, or null. */
function canonicalIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
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
  /** Existing `${runner_id}|${raw_tipster_name}` keys already in the DB. */
  existingKeys?: Set<string>;
}

/** A prepared row ready to persist into tipster_selections. */
interface PreparedRow {
  race_id: string;
  runner_id: string;
  tipster_id: string | null;
  raw_tipster_name: string;
  raw_affiliation: string | null;
  source_label: string | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { file, commit } = args;

  // Read-only listing mode: print candidate races for a date/course and exit.
  // Needs no CSV and never writes.
  if (args.listRaces) {
    loadEnv();
    await listRacesMode(args);
    return;
  }

  if (!file) {
    console.error(
      'Usage:\n' +
        '  npm run import:tipster-selections -- --file <path.csv> [--commit]\n' +
        '  npm run import:tipster-selections -- --list-races [--date YYYY-MM-DD] [--course <name>]',
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
  let hasPlaceholder = false;

  // Read-only diagnostic collections (Batch K1b): captured from data the matcher
  // already fetched, to help the operator fix their CSV. They never change
  // matching and are only printed in dry-run output.
  const unmatchedHorseDiags: { line: number; horse: string; available: string[] }[] = [];
  const unmatchedRaceDiags: {
    line: number;
    course: string;
    date: string;
    offTime: string;
  }[] = [];

  // Per-day race cache and per-name tipster cache to avoid repeat lookups.
  const racesByDate = new Map<string, RaceRow[]>();
  const raceResolutionCache = new Map<string, ResolvedRace>();
  const tipsterCache = new Map<string, string | null>();

  // Unique rows to (would-)insert, plus the within-CSV dedupe set.
  const batch: PreparedRow[] = [];
  const seenInCsv = new Set<string>();

  const dataRows = parsed.slice(1).filter((cells) => !isBlankRow(cells));
  audit.rows_read = dataRows.length;

  for (let r = 0; r < dataRows.length; r++) {
    const cells = dataRows[r];
    const lineNo = r + 2; // 1-based, +1 for the header row

    const meetingDate = cell(cells, 'meeting_date');
    const course = cell(cells, 'course');
    const offTime = cell(cells, 'off_time');
    const horseName = cell(cells, 'horse_name');
    const tipsterName = cell(cells, 'tipster_name');
    const rawAffiliation = cell(cells, 'raw_affiliation');
    const sourceLabel = cell(cells, 'source_label');

    // Track placeholder text anywhere in the row (blocks --commit later).
    for (const value of [
      meetingDate,
      course,
      offTime,
      horseName,
      tipsterName,
      rawAffiliation,
      sourceLabel,
    ]) {
      if (PLACEHOLDER_RE.test(value)) hasPlaceholder = true;
    }

    // 1. Required-field validation.
    const problems: string[] = [];
    if (!DATE_RE.test(meetingDate)) problems.push('meeting_date must be YYYY-MM-DD');
    if (course === '') problems.push('course is required');
    if (!TIME_RE.test(offTime)) problems.push('off_time must be HH:MM');
    if (horseName === '') problems.push('horse_name is required');
    if (tipsterName === '') problems.push('tipster_name is required');

    const offTimeIso = problems.length === 0 ? composeOffTimeIso(meetingDate, offTime) : null;
    if (problems.length === 0 && offTimeIso === null) {
      problems.push('off_time/meeting_date do not form a valid instant');
    }

    if (problems.length > 0) {
      audit.skipped_missing_required++;
      skipReasons.push(`line ${lineNo}: ${problems.join('; ')}`);
      continue;
    }
    audit.rows_validated++;

    // 2. Resolve the race (cached). Off-time instant is non-null here.
    const resolved = await resolveRace(
      racesByDate,
      raceResolutionCache,
      meetingDate,
      course,
      offTimeIso as string,
    );
    if (resolved.status === 'unmatched') {
      audit.skipped_unmatched_race++;
      skipReasons.push(`line ${lineNo}: no race for ${course} ${meetingDate} ${offTime}`);
      unmatchedRaceDiags.push({ line: lineNo, course, date: meetingDate, offTime });
      continue;
    }
    if (resolved.status === 'ambiguous') {
      audit.skipped_ambiguous_race++;
      skipReasons.push(
        `line ${lineNo}: ambiguous race for ${course} ${meetingDate} ${offTime}`,
      );
      continue;
    }

    // 3. Match the horse to a single runner in that race.
    const runners = resolved.runners ?? [];
    const sameNameCount = runners.filter(
      (rn) => normalizeHorseName(rn.horse_name) === normalizeHorseName(horseName),
    ).length;
    const runnerId = matchRunnerId(runners, horseName);
    if (runnerId === null) {
      if (sameNameCount > 1) {
        audit.skipped_ambiguous_horse++;
        skipReasons.push(`line ${lineNo}: ambiguous horse "${horseName}" in race`);
      } else {
        audit.skipped_unmatched_horse++;
        skipReasons.push(`line ${lineNo}: no runner "${horseName}" in race`);
      }
      // Capture the race's actual runner names (verbatim) so the operator can
      // see what was available. Read-only; does not affect matching.
      unmatchedHorseDiags.push({
        line: lineNo,
        horse: horseName,
        available: availableRunnerNames(runners),
      });
      continue;
    }

    // Race + runner resolved -> the row is insertable.
    audit.rows_insertable++;

    // 4. Dedupe within the CSV and against rows already in the DB.
    const dupeKey = `${runnerId}|${tipsterName}`;
    const fullKey = `${resolved.raceId}|${dupeKey}`;
    if (seenInCsv.has(fullKey) || resolved.existingKeys?.has(dupeKey)) {
      audit.duplicate_rows_ignored_or_would_ignore++;
      continue;
    }
    seenInCsv.add(fullKey);

    // 5. Resolve the tipster (read-only; null when unresolved/ambiguous).
    const tipsterId = await resolveTipsterId(tipsterCache, tipsterName, rawAffiliation);
    if (tipsterId === null) audit.tipsters_unresolved++;
    else audit.tipsters_resolved++;

    batch.push({
      race_id: resolved.raceId as string,
      runner_id: runnerId,
      tipster_id: tipsterId,
      raw_tipster_name: tipsterName,
      raw_affiliation: rawAffiliation === '' ? null : rawAffiliation,
      source_label: sourceLabel === '' ? null : sourceLabel,
    });
    audit.rows_inserted_or_would_insert++;
  }

  printSummary(audit, skipReasons, commit, hasPlaceholder);

  // Commit gate: never write while placeholder text remains.
  if (commit && hasPlaceholder) {
    console.error(
      '\nRefusing to --commit: placeholder "EXAMPLE" text is present. ' +
        'Replace it with real operator-curated data first.',
    );
    process.exitCode = 1;
    return;
  }

  if (!commit) {
    printDryRunDiagnostics({
      unmatchedHorseDiags,
      unmatchedRaceDiags,
      racesByDate,
      audit,
    });
    console.log('\n(dry run) No rows written. Re-run with --commit to insert.');
    return;
  }

  if (batch.length === 0) {
    console.log('\nNothing to insert.');
    return;
  }

  const { error } = await supabaseAdmin
    .from(TIPSTER_SELECTIONS_TABLE)
    .upsert(batch, {
      onConflict: 'race_id,runner_id,raw_tipster_name',
      ignoreDuplicates: true,
    });
  if (error) {
    throw new Error(`tipster_selections upsert failed: ${error.message}`);
  }
  console.log(`\nInserted up to ${batch.length} selection row(s) (duplicates ignored).`);
}

/**
 * Resolves a race by meeting_date + normalised course + canonical off-time
 * instant, caching the day's races and the per-key resolution. On a resolved
 * race it also loads that race's runners and existing selection keys (once).
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
    dayRaces = ((data ?? []) as RaceRow[]).map((row) => ({
      id: String(row.id),
      course: row.course,
      off_time: row.off_time,
    }));
    racesByDate.set(meetingDate, dayRaces);
  }

  const matches = dayRaces.filter(
    (row) =>
      normalizeCourse(row.course) === wantCourse &&
      canonicalIso(row.off_time) === offTimeIso,
  );

  let result: ResolvedRace;
  if (matches.length === 0) {
    result = { status: 'unmatched' };
  } else if (matches.length > 1) {
    result = { status: 'ambiguous' };
  } else {
    const raceId = matches[0].id;
    result = {
      status: 'resolved',
      raceId,
      runners: await fetchRunners(raceId),
      existingKeys: await fetchExistingKeys(raceId),
    };
  }
  cache.set(key, result);
  return result;
}

/** Loads the priced/declared runners for a race as matcher inputs. */
async function fetchRunners(raceId: string): Promise<MatchableRunner[]> {
  const { data, error } = await supabaseAdmin
    .from(RUNNERS_TABLE)
    .select('id, horse_name')
    .eq('race_id', raceId);
  if (error) {
    throw new Error(`runners lookup failed for race ${raceId}: ${error.message}`);
  }
  return ((data ?? []) as { id: string | number; horse_name: string }[]).map((row) => ({
    id: row.id,
    horse_name: row.horse_name,
  }));
}

/** Loads existing `${runner_id}|${raw_tipster_name}` keys already in the DB. */
async function fetchExistingKeys(raceId: string): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from(TIPSTER_SELECTIONS_TABLE)
    .select('runner_id, raw_tipster_name')
    .eq('race_id', raceId);
  if (error) {
    throw new Error(
      `existing selections lookup failed for race ${raceId}: ${error.message}`,
    );
  }
  const keys = new Set<string>();
  for (const row of (data ?? []) as { runner_id: string | number; raw_tipster_name: string }[]) {
    keys.add(`${String(row.runner_id)}|${row.raw_tipster_name}`);
  }
  return keys;
}

/** Resolves a raw tipster name to a canonical id (or null), cached. Read-only. */
async function resolveTipsterId(
  cache: Map<string, string | null>,
  rawName: string,
  rawAffiliation: string,
): Promise<string | null> {
  const affiliation = rawAffiliation === '' ? undefined : rawAffiliation;
  const key = `${rawName.toLowerCase()}|${(affiliation ?? '').toLowerCase()}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const resolution = await resolveCanonicalTipster(rawName, affiliation);
  const id = resolution.tipster_id === null ? null : String(resolution.tipster_id);
  cache.set(key, id);
  return id;
}

/** Prints the audit summary (and skip reasons) without exposing any secrets. */
function printSummary(
  audit: Audit,
  skipReasons: string[],
  commit: boolean,
  hasPlaceholder: boolean,
): void {
  console.log(`Tipster selection import — ${commit ? 'COMMIT' : 'DRY RUN'}`);
  console.log('Audit summary:');
  for (const [k, v] of Object.entries(audit)) {
    console.log(`  ${k}: ${v}`);
  }
  if (hasPlaceholder) {
    console.log('  placeholder_example_present: true');
  }
  if (skipReasons.length > 0) {
    console.log('\nSkipped rows:');
    for (const reason of skipReasons) {
      console.log(`  - ${reason}`);
    }
  }
}

/**
 * Prints READ-ONLY dry-run diagnostics (Batch K1b): for each unmatched race,
 * nearby races on the same date (no auto-matching); for each unmatched horse,
 * the race's actual runner names; then an actionable "Fix your CSV" section.
 * All data was already fetched during matching — nothing here queries or writes,
 * and no secrets are printed.
 */
function printDryRunDiagnostics(ctx: {
  unmatchedHorseDiags: { line: number; horse: string; available: string[] }[];
  unmatchedRaceDiags: { line: number; course: string; date: string; offTime: string }[];
  racesByDate: Map<string, RaceRow[]>;
  audit: Audit;
}): void {
  const { unmatchedHorseDiags, unmatchedRaceDiags, racesByDate, audit } = ctx;

  if (unmatchedRaceDiags.length > 0) {
    console.log('\nUnmatched races (informational only — never auto-matched):');
    for (const d of unmatchedRaceDiags) {
      console.log(`  line ${d.line}: "${d.course}" ${d.date} ${d.offTime}`);
      const dayRaces = racesByDate.get(d.date) ?? [];
      if (dayRaces.length === 0) {
        console.log(`    no races found on ${d.date}.`);
        continue;
      }
      const nearby = summarizeNearbyRaces(dayRaces, d.course, normalizeCourse);
      if (nearby.sameCourseOffTimes.length > 0) {
        console.log(
          `    same course, available off-times: ${nearby.sameCourseOffTimes.join(', ')}`,
        );
      }
      if (nearby.otherCourses.length > 0) {
        console.log(`    other courses on ${d.date}: ${nearby.otherCourses.join(', ')}`);
      }
    }
  }

  if (unmatchedHorseDiags.length > 0) {
    console.log('\nUnmatched horses (informational only — never auto-matched):');
    for (const d of unmatchedHorseDiags) {
      console.log(`  line ${d.line}: "${d.horse}" — available runners:`);
      if (d.available.length === 0) {
        console.log('    (no runners recorded for this race)');
      } else {
        for (const name of d.available) {
          console.log(`    - ${name}`);
        }
      }
    }
  }

  console.log('\nFix your CSV:');
  for (const fix of buildFixCsvSection(audit)) {
    console.log(`  - ${fix}`);
  }
}

/**
 * READ-ONLY listing mode: prints candidate races for a date (default today,
 * UTC), optionally filtered by course, with each race's runner count — so an
 * operator can copy the exact course/off_time their CSV needs. SELECT only;
 * writes nothing.
 */
async function listRacesMode(args: Args): Promise<void> {
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(date)) {
    console.error(`--date must be YYYY-MM-DD (got "${date}").`);
    process.exitCode = 1;
    return;
  }

  const { data, error } = await supabaseAdmin
    .from(RACES_TABLE)
    .select('id, course, off_time, race_name')
    .eq('meeting_date', date);
  if (error) {
    throw new Error(`races lookup failed for ${date}: ${error.message}`);
  }

  let races = ((data ?? []) as {
    id: string | number;
    course: string;
    off_time: string | null;
    race_name: string | null;
  }[]).map((r) => ({
    id: String(r.id),
    course: r.course,
    off_time: r.off_time,
    race_name: r.race_name,
  }));

  // Optional course filter using the same normaliser the importer matches with
  // (a display filter only — it does not change matching semantics).
  if (args.course && args.course.trim() !== '') {
    const want = normalizeCourse(args.course);
    races = races.filter((r) => normalizeCourse(r.course) === want);
  }

  // Runner counts per race: one read-only query, counted in memory.
  const countByRace = new Map<string, number>();
  const raceIds = races.map((r) => r.id);
  if (raceIds.length > 0) {
    const { data: runnerData, error: runnersError } = await supabaseAdmin
      .from(RUNNERS_TABLE)
      .select('race_id')
      .in('race_id', raceIds);
    if (runnersError) {
      throw new Error(`runners lookup failed for ${date}: ${runnersError.message}`);
    }
    for (const row of (runnerData ?? []) as { race_id: string | number }[]) {
      const key = String(row.race_id);
      countByRace.set(key, (countByRace.get(key) ?? 0) + 1);
    }
  }

  const diagRaces: DiagRaceRow[] = races.map((r) => ({
    ...r,
    runner_count: countByRace.get(r.id) ?? 0,
  }));

  const courseNote = args.course ? ` course~"${args.course}"` : '';
  console.log(`Races on ${date}${courseNote} (read-only listing):\n`);
  for (const listLine of formatRaceListingLines(diagRaces)) {
    console.log(listLine);
  }
  console.log(`\n${diagRaces.length} race(s).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
