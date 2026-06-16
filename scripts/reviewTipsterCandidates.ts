/**
 * Tipster source registry + candidate review queue operator tool (Phase 4A).
 *
 * A safe, auditable way to manage automated/semi-automated tipster intelligence
 * WITHOUT scraping and WITHOUT blindly trusting sources. It never calls a model,
 * never changes staking, and never approves anything automatically.
 *
 * Two cooperating tables (created by
 * supabase/migrations/20260616000000_tipster_source_registry_and_candidates.sql):
 *
 *   - `tipster_source_registry`  : the allow-list of tipster sources. A source is
 *     registered first and stays UNAPPROVED until an operator approves it.
 *   - `tipster_selection_candidates` : raw, as-captured picks awaiting review.
 *     Candidates NEVER affect the model — only an explicit per-candidate approval
 *     resolves the pick to a real race + runner and writes it into the existing
 *     `tipster_selections` table that the model reads.
 *
 * SAFETY:
 *   - READ-ONLY BY DEFAULT (dry run). Write commands print what they WOULD do and
 *     write NOTHING unless `--commit` is passed.
 *   - Approval is gated: a candidate can only be approved when its source is
 *     registered AND approved, and when its race + runner resolve unambiguously
 *     from existing DB rows (mirroring the conservative CSV importer). Unresolved
 *     or unvetted candidates are refused, never guessed.
 *   - Inserts into `tipster_selections` use upsert + ignoreDuplicates on the
 *     unique index (race_id, runner_id, raw_tipster_name), so approving the same
 *     pick twice never double-counts it in tipster consensus.
 *
 * Usage:
 *   # Sources
 *   npm run review:tipster-candidates -- --list-sources
 *   npm run review:tipster-candidates -- --add-source \
 *     --source-label racing-post-tips --source-name "Racing Post — Tips" \
 *     --source-url https://www.racingpost.com/tips/ --commit
 *   npm run review:tipster-candidates -- --approve-source racing-post-tips --commit
 *
 *   # Candidates
 *   npm run review:tipster-candidates -- --list-candidates --status pending
 *   npm run review:tipster-candidates -- --add-candidate \
 *     --meeting-date 2026-06-16 --course Ascot --off-time 14:30 \
 *     --horse "Some Horse" --tipster "Some Tipster" \
 *     --source-label racing-post-tips --commit
 *   npm run review:tipster-candidates -- --approve-candidate <id> --commit
 *   npm run review:tipster-candidates -- --reject-candidate <id> --note "off the pace" --commit
 *
 * REQUIRES SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env.local` (or `.env`).
 * Credentials are never logged.
 */

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse, normalizeHorseName } from '../src/lib/raceSync';
import { matchRunnerId, type MatchableRunner } from '../src/lib/runnerMatch';
import { resolveCanonicalTipster } from '../src/lib/raceData';
import {
  canApproveCandidate,
  canonicalOffTimeIso,
  composeOffTimeIso,
  isCandidateStatus,
  mapApprovedCandidateToSelection,
  validateCandidate,
  validateSourceInput,
  type RegistrySource,
} from '../src/lib/tipsterCandidates';

const SOURCE_REGISTRY_TABLE = 'tipster_source_registry';
const CANDIDATES_TABLE = 'tipster_selection_candidates';
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

type Command =
  | 'list-candidates'
  | 'add-candidate'
  | 'approve-candidate'
  | 'reject-candidate'
  | 'list-sources'
  | 'add-source'
  | 'approve-source';

interface Args {
  command: Command | null;
  /** id (approve/reject candidate) or label (approve source). */
  commandValue?: string;
  commit: boolean;
  // Filters (list-candidates).
  status?: string;
  source?: string;
  // add-candidate fields.
  meetingDate?: string;
  course?: string;
  offTime?: string;
  horse?: string;
  tipster?: string;
  affiliation?: string;
  // Provenance / source fields.
  sourceLabel?: string;
  sourceUrl?: string;
  sourceName?: string;
  // Review note.
  note?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: null, commit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--list-candidates':
        args.command = 'list-candidates';
        break;
      case '--add-candidate':
        args.command = 'add-candidate';
        break;
      case '--approve-candidate':
        args.command = 'approve-candidate';
        args.commandValue = argv[++i];
        break;
      case '--reject-candidate':
        args.command = 'reject-candidate';
        args.commandValue = argv[++i];
        break;
      case '--list-sources':
        args.command = 'list-sources';
        break;
      case '--add-source':
        args.command = 'add-source';
        break;
      case '--approve-source':
        args.command = 'approve-source';
        args.commandValue = argv[++i];
        break;
      case '--commit':
        args.commit = true;
        break;
      case '--status':
        args.status = argv[++i];
        break;
      case '--source':
        args.source = argv[++i];
        break;
      case '--meeting-date':
        args.meetingDate = argv[++i];
        break;
      case '--course':
        args.course = argv[++i];
        break;
      case '--off-time':
        args.offTime = argv[++i];
        break;
      case '--horse':
        args.horse = argv[++i];
        break;
      case '--tipster':
        args.tipster = argv[++i];
        break;
      case '--affiliation':
        args.affiliation = argv[++i];
        break;
      case '--source-label':
        args.sourceLabel = argv[++i];
        break;
      case '--source-url':
        args.sourceUrl = argv[++i];
        break;
      case '--source-name':
        args.sourceName = argv[++i];
        break;
      case '--note':
        args.note = argv[++i];
        break;
      default:
        break;
    }
  }
  return args;
}

const USAGE = [
  'Usage:',
  '  Sources:',
  '    --list-sources',
  '    --add-source --source-label <label> --source-name <name> [--source-url <url>] [--note <text>] --commit',
  '    --approve-source <label> --commit',
  '  Candidates:',
  '    --list-candidates [--status pending|approved|rejected] [--source <label>]',
  '    --add-candidate --meeting-date YYYY-MM-DD --course <name> --off-time HH:MM',
  '                    --horse <name> --tipster <name> [--affiliation <text>]',
  '                    [--source-label <label>] [--source-url <url>] [--source-name <name>] --commit',
  '    --approve-candidate <id> --commit',
  '    --reject-candidate <id> [--note <text>] --commit',
  '',
  'All write commands are DRY-RUN unless --commit is passed.',
].join('\n');

interface CandidateRow {
  id: string;
  meeting_date: string | null;
  course: string | null;
  off_time: string | null;
  horse_name: string;
  tipster_name: string;
  raw_affiliation: string | null;
  source_label: string | null;
  source_url: string | null;
  source_name: string | null;
  status: string;
  race_id: string | null;
  runner_id: string | null;
  tipster_id: string | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === null) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  loadEnv();

  switch (args.command) {
    case 'list-sources':
      await listSources();
      return;
    case 'add-source':
      await addSource(args);
      return;
    case 'approve-source':
      await approveSource(args);
      return;
    case 'list-candidates':
      await listCandidates(args);
      return;
    case 'add-candidate':
      await addCandidate(args);
      return;
    case 'approve-candidate':
      await approveCandidate(args);
      return;
    case 'reject-candidate':
      await rejectCandidate(args);
      return;
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** READ-ONLY: lists every registered source with its approval state. */
async function listSources(): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from(SOURCE_REGISTRY_TABLE)
    .select('source_label, source_name, source_url, is_approved, created_at')
    .order('source_label', { ascending: true });
  if (error) {
    throw new Error(`source registry lookup failed: ${error.message}`);
  }

  const rows = (data ?? []) as {
    source_label: string;
    source_name: string;
    source_url: string | null;
    is_approved: boolean;
  }[];

  console.log(`Tipster source registry (${rows.length} source(s)):\n`);
  if (rows.length === 0) {
    console.log('  (none registered yet — add one with --add-source)');
    return;
  }
  for (const row of rows) {
    const flag = row.is_approved ? '[APPROVED]' : '[unapproved]';
    const url = row.source_url ? ` ${row.source_url}` : '';
    console.log(`  ${flag} ${row.source_label} — ${row.source_name}${url}`);
  }
}

/** Adds a source to the registry, ALWAYS unapproved. Needs --commit to write. */
async function addSource(args: Args): Promise<void> {
  const result = validateSourceInput({
    source_label: args.sourceLabel,
    source_name: args.sourceName,
    source_url: args.sourceUrl,
    notes: args.note,
  });
  if (!result.ok || result.source === null) {
    console.error('Cannot add source:');
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  const source = result.source;
  console.log(
    `Add source "${source.source_label}" (${source.source_name}) — ` +
      `${args.commit ? 'COMMIT' : 'DRY RUN'}. It will be UNAPPROVED until you ` +
      'run --approve-source.',
  );

  if (!args.commit) {
    console.log('\n(dry run) Nothing written. Re-run with --commit to insert.');
    return;
  }

  const { error } = await supabaseAdmin.from(SOURCE_REGISTRY_TABLE).insert({
    source_label: source.source_label,
    source_name: source.source_name,
    source_url: source.source_url,
    notes: source.notes,
    is_approved: false,
  });
  if (error) {
    throw new Error(`failed to add source: ${error.message}`);
  }
  console.log(`\nRegistered source "${source.source_label}" (unapproved).`);
}

/** Approves a registered source. Operator-driven; needs --commit to write. */
async function approveSource(args: Args): Promise<void> {
  const label = (args.commandValue ?? '').trim();
  if (label === '') {
    console.error('--approve-source requires a <label>.');
    process.exitCode = 1;
    return;
  }

  const { data, error } = await supabaseAdmin
    .from(SOURCE_REGISTRY_TABLE)
    .select('source_label, is_approved')
    .eq('source_label', label)
    .limit(1);
  if (error) {
    throw new Error(`source lookup failed: ${error.message}`);
  }
  const row = (data ?? [])[0] as { source_label: string; is_approved: boolean } | undefined;
  if (!row) {
    console.error(
      `No source "${label}" in the registry. Add it first with --add-source.`,
    );
    process.exitCode = 1;
    return;
  }
  if (row.is_approved) {
    console.log(`Source "${label}" is already approved. Nothing to do.`);
    return;
  }

  console.log(`Approve source "${label}" — ${args.commit ? 'COMMIT' : 'DRY RUN'}.`);
  if (!args.commit) {
    console.log('\n(dry run) Nothing written. Re-run with --commit to approve.');
    return;
  }

  const { error: updError } = await supabaseAdmin
    .from(SOURCE_REGISTRY_TABLE)
    .update({ is_approved: true, approved_at: new Date().toISOString() })
    .eq('source_label', label);
  if (updError) {
    throw new Error(`failed to approve source: ${updError.message}`);
  }
  console.log(`\nApproved source "${label}". Its pending candidates can now be approved.`);
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** READ-ONLY: lists candidates, optionally filtered by status and/or source. */
async function listCandidates(args: Args): Promise<void> {
  if (args.status !== undefined && !isCandidateStatus(args.status)) {
    console.error('--status must be one of: pending, approved, rejected.');
    process.exitCode = 1;
    return;
  }

  let query = supabaseAdmin
    .from(CANDIDATES_TABLE)
    .select(
      'id, meeting_date, course, off_time, horse_name, tipster_name, source_label, status, created_at',
    )
    .order('created_at', { ascending: true });
  if (args.status !== undefined) query = query.eq('status', args.status);
  if (args.source !== undefined && args.source.trim() !== '') {
    query = query.eq('source_label', args.source.trim());
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`candidate lookup failed: ${error.message}`);
  }

  const rows = (data ?? []) as {
    id: string;
    meeting_date: string | null;
    course: string | null;
    off_time: string | null;
    horse_name: string;
    tipster_name: string;
    source_label: string | null;
    status: string;
  }[];

  const filterNote = [
    args.status ? `status=${args.status}` : '',
    args.source ? `source=${args.source}` : '',
  ]
    .filter((s) => s !== '')
    .join(' ');
  console.log(
    `Tipster selection candidates${filterNote ? ` (${filterNote})` : ''}: ` +
      `${rows.length} row(s)\n`,
  );
  if (rows.length === 0) {
    console.log('  (no candidates match)');
    return;
  }
  for (const row of rows) {
    const when = `${row.meeting_date ?? '?'} ${row.off_time ?? '?'}`;
    const src = row.source_label ?? '(no source)';
    console.log(
      `  [${row.status}] ${row.id}\n` +
        `      ${when} ${row.course ?? '?'} — ${row.horse_name} (tipster: ${row.tipster_name}; source: ${src})`,
    );
  }
}

/** Adds a candidate to the queue (status pending). Needs --commit to write. */
async function addCandidate(args: Args): Promise<void> {
  const result = validateCandidate({
    meeting_date: args.meetingDate,
    course: args.course,
    off_time: args.offTime,
    horse_name: args.horse,
    tipster_name: args.tipster,
    raw_affiliation: args.affiliation,
    source_label: args.sourceLabel,
    source_url: args.sourceUrl,
    source_name: args.sourceName,
  });
  if (!result.ok || result.candidate === null) {
    console.error('Cannot add candidate:');
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  const candidate = result.candidate;
  console.log(
    `Add candidate: ${candidate.meeting_date} ${candidate.off_time} ` +
      `${candidate.course} — ${candidate.horse_name} (tipster: ${candidate.tipster_name}) ` +
      `— ${args.commit ? 'COMMIT' : 'DRY RUN'}. It will be PENDING review.`,
  );
  if (candidate.source_label === null) {
    console.log(
      '  note: no --source-label given; this candidate cannot be approved until ' +
        'it is linked to a registered, approved source.',
    );
  }

  if (!args.commit) {
    console.log('\n(dry run) Nothing written. Re-run with --commit to insert.');
    return;
  }

  const { error } = await supabaseAdmin.from(CANDIDATES_TABLE).insert({
    meeting_date: candidate.meeting_date,
    course: candidate.course,
    off_time: candidate.off_time,
    horse_name: candidate.horse_name,
    tipster_name: candidate.tipster_name,
    raw_affiliation: candidate.raw_affiliation,
    source_label: candidate.source_label,
    source_url: candidate.source_url,
    source_name: candidate.source_name,
    status: 'pending',
  });
  if (error) {
    throw new Error(`failed to add candidate: ${error.message}`);
  }
  console.log('\nAdded candidate (pending review).');
}

/**
 * Approves ONE candidate by id: verifies its source is approved, resolves the
 * race + runner unambiguously, then writes it into `tipster_selections` and
 * marks the candidate approved. Refuses (never guesses) when anything is
 * unresolved or unvetted. Needs --commit to write.
 */
async function approveCandidate(args: Args): Promise<void> {
  const id = (args.commandValue ?? '').trim();
  if (id === '') {
    console.error('--approve-candidate requires a candidate <id>.');
    process.exitCode = 1;
    return;
  }

  const candidate = await fetchCandidate(id);
  if (!candidate) {
    console.error(`No candidate with id ${id}.`);
    process.exitCode = 1;
    return;
  }

  // 1. Trust gate: the source must be registered AND approved.
  const source = await fetchRegistrySource(candidate.source_label);
  const eligibility = canApproveCandidate(
    { status: candidate.status, source_label: candidate.source_label },
    source,
  );
  if (!eligibility.ok) {
    console.error(`Cannot approve candidate ${id}:`);
    for (const r of eligibility.reasons) console.error(`  - ${r}`);
    process.exitCode = 1;
    return;
  }

  // 2. Resolve the race (no fabrication — mirrors the CSV importer).
  const offTimeIso =
    candidate.meeting_date && candidate.off_time
      ? composeOffTimeIso(candidate.meeting_date, candidate.off_time)
      : null;
  if (!offTimeIso) {
    console.error(
      `Cannot approve candidate ${id}: meeting_date/off_time do not form a valid instant ` +
        `(${candidate.meeting_date ?? '?'} ${candidate.off_time ?? '?'}).`,
    );
    process.exitCode = 1;
    return;
  }

  const race = await resolveRace(candidate.meeting_date as string, candidate.course ?? '', offTimeIso);
  if (race.status !== 'resolved' || !race.raceId) {
    console.error(
      `Cannot approve candidate ${id}: ${race.status} race for ` +
        `"${candidate.course ?? ''}" ${candidate.meeting_date} ${candidate.off_time}.`,
    );
    process.exitCode = 1;
    return;
  }

  // 3. Resolve the runner unambiguously within that race.
  const runners = race.runners ?? [];
  const sameNameCount = runners.filter(
    (rn) => normalizeHorseName(rn.horse_name) === normalizeHorseName(candidate.horse_name),
  ).length;
  const runnerId = matchRunnerId(runners, candidate.horse_name);
  if (runnerId === null) {
    const why = sameNameCount > 1 ? 'ambiguous' : 'no matching';
    console.error(
      `Cannot approve candidate ${id}: ${why} runner "${candidate.horse_name}" in the race.`,
    );
    process.exitCode = 1;
    return;
  }

  // 4. Resolve the canonical tipster (read-only; null is allowed and preserved).
  const affiliation =
    candidate.raw_affiliation && candidate.raw_affiliation.trim() !== ''
      ? candidate.raw_affiliation
      : undefined;
  const tipsterResolution = await resolveCanonicalTipster(candidate.tipster_name, affiliation);
  const tipsterId =
    tipsterResolution.tipster_id === null ? null : String(tipsterResolution.tipster_id);

  // 5. Map to the selection insert (pure guard: approved + resolved only).
  const selection = mapApprovedCandidateToSelection({
    status: 'approved',
    race_id: race.raceId,
    runner_id: runnerId,
    tipster_id: tipsterId,
    tipster_name: candidate.tipster_name,
    raw_affiliation: candidate.raw_affiliation,
    source_label: candidate.source_label,
  });

  console.log(
    `Approve candidate ${id} -> tipster_selections — ${args.commit ? 'COMMIT' : 'DRY RUN'}\n` +
      `  race_id=${selection.race_id} runner_id=${selection.runner_id} ` +
      `tipster_id=${selection.tipster_id ?? 'null'} source_label=${selection.source_label ?? 'null'}`,
  );

  if (!args.commit) {
    console.log('\n(dry run) Nothing written. Re-run with --commit to approve.');
    return;
  }

  // 6. Insert into tipster_selections (idempotent on the unique index).
  const { error: insError } = await supabaseAdmin
    .from(TIPSTER_SELECTIONS_TABLE)
    .upsert([selection], {
      onConflict: 'race_id,runner_id,raw_tipster_name',
      ignoreDuplicates: true,
    });
  if (insError) {
    throw new Error(`tipster_selections upsert failed: ${insError.message}`);
  }

  // 7. Mark the candidate approved (with the resolved references for audit).
  const { error: updError } = await supabaseAdmin
    .from(CANDIDATES_TABLE)
    .update({
      status: 'approved',
      race_id: selection.race_id,
      runner_id: selection.runner_id,
      tipster_id: selection.tipster_id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (updError) {
    throw new Error(`failed to mark candidate approved: ${updError.message}`);
  }
  console.log('\nApproved. The next model run will read this selection.');
}

/** Rejects a pending candidate (records an optional note). Needs --commit. */
async function rejectCandidate(args: Args): Promise<void> {
  const id = (args.commandValue ?? '').trim();
  if (id === '') {
    console.error('--reject-candidate requires a candidate <id>.');
    process.exitCode = 1;
    return;
  }

  const candidate = await fetchCandidate(id);
  if (!candidate) {
    console.error(`No candidate with id ${id}.`);
    process.exitCode = 1;
    return;
  }
  if (candidate.status !== 'pending') {
    console.error(
      `Cannot reject candidate ${id}: status is "${candidate.status}", expected "pending".`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Reject candidate ${id} — ${args.commit ? 'COMMIT' : 'DRY RUN'}.`);
  if (!args.commit) {
    console.log('\n(dry run) Nothing written. Re-run with --commit to reject.');
    return;
  }

  const { error } = await supabaseAdmin
    .from(CANDIDATES_TABLE)
    .update({
      status: 'rejected',
      review_notes: args.note && args.note.trim() !== '' ? args.note.trim() : null,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) {
    throw new Error(`failed to reject candidate: ${error.message}`);
  }
  console.log('\nRejected. This candidate will never enter tipster_selections.');
}

// ---------------------------------------------------------------------------
// DB helpers (read-only resolution; write paths are inline above)
// ---------------------------------------------------------------------------

/** Fetches a single candidate row by id, or null when absent. */
async function fetchCandidate(id: string): Promise<CandidateRow | null> {
  const { data, error } = await supabaseAdmin
    .from(CANDIDATES_TABLE)
    .select(
      'id, meeting_date, course, off_time, horse_name, tipster_name, raw_affiliation, source_label, source_url, source_name, status, race_id, runner_id, tipster_id',
    )
    .eq('id', id)
    .limit(1);
  if (error) {
    throw new Error(`candidate lookup failed: ${error.message}`);
  }
  const row = (data ?? [])[0] as CandidateRow | undefined;
  return row ?? null;
}

/** Fetches the registry row for a source_label, or null when not registered. */
async function fetchRegistrySource(
  label: string | null,
): Promise<RegistrySource | null> {
  const trimmed = (label ?? '').trim();
  if (trimmed === '') return null;
  const { data, error } = await supabaseAdmin
    .from(SOURCE_REGISTRY_TABLE)
    .select('source_label, is_approved')
    .eq('source_label', trimmed)
    .limit(1);
  if (error) {
    throw new Error(`source lookup failed: ${error.message}`);
  }
  const row = (data ?? [])[0] as { source_label: string; is_approved: boolean } | undefined;
  if (!row) return null;
  return { source_label: String(row.source_label), is_approved: Boolean(row.is_approved) };
}

interface ResolvedRace {
  status: 'resolved' | 'unmatched' | 'ambiguous';
  raceId?: string;
  runners?: MatchableRunner[];
}

/**
 * Resolves a race by meeting_date + normalised course + canonical off-time
 * instant, then loads its runners. Read-only; mirrors the CSV importer's
 * conservative matching so approval never invents a race.
 */
async function resolveRace(
  meetingDate: string,
  course: string,
  offTimeIso: string,
): Promise<ResolvedRace> {
  const wantCourse = normalizeCourse(course);
  const { data, error } = await supabaseAdmin
    .from(RACES_TABLE)
    .select('id, course, off_time')
    .eq('meeting_date', meetingDate);
  if (error) {
    throw new Error(`races lookup failed for ${meetingDate}: ${error.message}`);
  }

  const dayRaces = ((data ?? []) as {
    id: string | number;
    course: string;
    off_time: string | null;
  }[]).map((row) => ({
    id: String(row.id),
    course: row.course,
    off_time: row.off_time,
  }));

  const matches = dayRaces.filter(
    (row) =>
      normalizeCourse(row.course) === wantCourse &&
      canonicalOffTimeIso(row.off_time) === offTimeIso,
  );

  if (matches.length === 0) return { status: 'unmatched' };
  if (matches.length > 1) return { status: 'ambiguous' };

  const raceId = matches[0].id;
  return { status: 'resolved', raceId, runners: await fetchRunners(raceId) };
}

/** Loads the declared runners for a race as matcher inputs. Read-only. */
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
