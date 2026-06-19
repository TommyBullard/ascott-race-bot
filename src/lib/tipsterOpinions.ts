/**
 * Source-compliant tipster OPINION ingestion (pure core).
 *
 * Turns operator-curated, licence-aware tipster OPINIONS (from allowed sources
 * only) into reviewable rows, and converts ONLY approved + eligible ones into
 * the `tipster_selections` CSV the existing importer consumes. Everything here is
 * pure + deterministic: CSV parse/serialise, evidence-grounding, the eligibility
 * gate, and the review report. No I/O, no network, no model maths.
 *
 * COMPLIANCE INVARIANTS (enforced by construction + tests):
 *   - NO SCRAPING. This module reads structured LOCAL notes only; it never
 *     fetches a URL. Disallowed sources (paywalled / logged-in / ToS-prohibited)
 *     are policy-flagged and can never become model-active.
 *   - NO FABRICATION. Every opinion MUST carry an `evidence_excerpt`; when the
 *     note's `source_text` is present the excerpt MUST be a verbatim substring of
 *     it (grounding), so an extractor (deterministic or GenAI) cannot invent a
 *     pick. Ungrounded / evidence-less opinions are dropped, never guessed.
 *   - UNKNOWN ≠ MODEL-ACTIVE. An opinion with `licence_status = unknown`, an
 *     unmatched runner, a non-`selection` type, or `review_status ≠ approved`
 *     is BLOCKED from becoming a `tipster_selection`.
 *   - SHADOW STRATEGY PROFILES (e.g. "What Would Jon Vine Do") are labelled
 *     synthetic and can never be treated as a real sourced tipster without
 *     evidence.
 *   - Nothing here changes model probability, EV, staking, ranking, or
 *     recommendations, and nothing places a bet.
 */

import { normalizeHorseName } from './raceSync';
import { correlationGroupOf, correlationMemberOf, type CorrelationGroup } from './tipsterSourceRegistry';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type OpinionType =
  | 'selection'
  | 'positive'
  | 'negative'
  | 'each_way_interest'
  | 'danger'
  | 'no_strong_view';

export type OpinionConfidence = 'low' | 'medium' | 'high' | 'unknown';

export type LicenceStatus = 'manual' | 'public_allowed' | 'licensed' | 'unknown';

export type OpinionReviewStatus = 'pending' | 'approved' | 'rejected';

export const OPINION_TYPES: readonly OpinionType[] = [
  'selection',
  'positive',
  'negative',
  'each_way_interest',
  'danger',
  'no_strong_view',
];
export const OPINION_CONFIDENCES: readonly OpinionConfidence[] = ['low', 'medium', 'high', 'unknown'];
export const LICENCE_STATUSES: readonly LicenceStatus[] = ['manual', 'public_allowed', 'licensed', 'unknown'];
export const REVIEW_STATUSES: readonly OpinionReviewStatus[] = ['pending', 'approved', 'rejected'];

/** Licences under which an opinion MAY become model-active. `unknown` is excluded. */
export const MODEL_ACTIVE_LICENCES: readonly LicenceStatus[] = ['manual', 'public_allowed', 'licensed'];

/** Only this opinion type represents a backing pick convertible to a selection. */
export const SELECTION_OPINION_TYPE: OpinionType = 'selection';

/** The opinions CSV column order (header). */
export const OPINION_COLUMNS = [
  'date',
  'course',
  'race_name',
  'off_time',
  'source_label',
  'tipster_name',
  'runner_name',
  'opinion_type',
  'confidence',
  'evidence_excerpt',
  'source_url',
  'licence_status',
  'review_status',
  'model_active_eligible',
  'notes',
] as const;

/** One ingested tipster opinion row. */
export interface TipsterOpinionRow {
  date: string;
  course: string;
  race_name: string;
  off_time: string;
  source_label: string;
  tipster_name: string;
  runner_name: string;
  opinion_type: OpinionType;
  confidence: OpinionConfidence;
  evidence_excerpt: string;
  source_url: string;
  licence_status: LicenceStatus;
  notes: string;
  review_status: OpinionReviewStatus;
  /** Operator-set flag: this row passed eligibility and may be imported. */
  model_active_eligible: boolean;
}

/* -------------------------------------------------------------------------- */
/* Source policy                                                              */
/* -------------------------------------------------------------------------- */

/** A registered source profile (in-code policy; never a scraper target). */
export interface SourceProfile {
  /** Match key (lowercased substring of source_label / tipster_name). */
  key: string;
  /** Human description. */
  description: string;
  /** Whether this source may ever be model-active (with evidence + approval). */
  allowedModelActive: boolean;
  /** A synthetic strategy heuristic, not a real sourced tipster. */
  synthetic: boolean;
}

/**
 * In-code source policy. Real, permitted sources may be model-active WITH
 * evidence + approval. "Racing Post" is allowed ONLY as a licensed / manual-
 * excerpt source (short excerpts), never as a scraper. "What Would Jon Vine Do"
 * is a SYNTHETIC strategy profile — shadow-only until backtested, never a real
 * tipster unless real, permitted Jon Vine tips are supplied with evidence.
 */
export const SOURCE_PROFILES: readonly SourceProfile[] = [
  { key: 'operator', description: 'First-party operator notes / own observations', allowedModelActive: true, synthetic: false },
  { key: 'manual', description: 'Operator manual notes', allowedModelActive: true, synthetic: false },
  { key: 'licensed', description: 'Licensed API / feed notes', allowedModelActive: true, synthetic: false },
  { key: 'public_allowed', description: 'Public page explicitly allowed for reuse', allowedModelActive: true, synthetic: false },
  { key: 'racing post', description: 'Racing Post — licensed / short manual excerpt only (NEVER scraped)', allowedModelActive: true, synthetic: false },
  { key: 'what would jon vine do', description: 'Synthetic strategy heuristic (shadow-only until backtested)', allowedModelActive: false, synthetic: true },
  { key: 'jon vine strategy', description: 'Synthetic strategy heuristic (shadow-only until backtested)', allowedModelActive: false, synthetic: true },
];

/** Substrings that indicate a disallowed (paywalled / private) acquisition path. */
export const DISALLOWED_SOURCE_PATTERNS: readonly string[] = [
  'paywall',
  'subscriber',
  'members area',
  'logged-in',
  'login required',
  'scraped',
  'scrape',
];

/** Looks up the best-matching source profile for a label/name. Pure. */
export function matchSourceProfile(sourceLabel: string, tipsterName: string): SourceProfile | null {
  const hay = `${sourceLabel} ${tipsterName}`.toLowerCase();
  // Prefer the most specific (longest key) match.
  const matches = SOURCE_PROFILES.filter((p) => hay.includes(p.key)).sort((a, b) => b.key.length - a.key.length);
  return matches[0] ?? null;
}

/** True when the source label/url/notes signal a disallowed acquisition path. Pure. */
export function looksDisallowed(row: Pick<TipsterOpinionRow, 'source_label' | 'source_url' | 'notes'>): boolean {
  const hay = `${row.source_label} ${row.source_url} ${row.notes}`.toLowerCase();
  return DISALLOWED_SOURCE_PATTERNS.some((p) => hay.includes(p));
}

/* -------------------------------------------------------------------------- */
/* CSV (RFC 4180, pure)                                                       */
/* -------------------------------------------------------------------------- */

interface ParsedCsv {
  header: string[];
  rows: Record<string, string>[];
}

/** Parses RFC 4180 CSV text (quoted fields, commas/newlines, doubled quotes). Pure. */
export function parseOpinionCsv(text: string): ParsedCsv {
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
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
  const header = records[0].map((h) => h.trim());
  const rows = records.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => {
      obj[h] = r[idx] ?? '';
    });
    return obj;
  });
  return { header, rows };
}

/** Quotes a CSV field when it contains a comma, quote, or newline. Pure. */
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Serialises opinion rows to CSV text (header + rows). Pure. */
export function serializeOpinionCsv(rows: readonly TipsterOpinionRow[]): string {
  const lines = [OPINION_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(OPINION_COLUMNS.map((c) => csvCell(String(r[c] ?? ''))).join(','));
  }
  return lines.join('\n') + '\n';
}

function asEnum<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  const v = (value ?? '').trim().toLowerCase() as T;
  return allowed.includes(v) ? v : fallback;
}

/** Coerces a parsed CSV record into a typed opinion row (lenient; never throws). Pure. */
export function toOpinionRow(rec: Record<string, string>): TipsterOpinionRow {
  return {
    date: (rec.date ?? '').trim(),
    course: (rec.course ?? '').trim(),
    race_name: (rec.race_name ?? '').trim(),
    off_time: (rec.off_time ?? '').trim(),
    source_label: (rec.source_label ?? '').trim(),
    tipster_name: (rec.tipster_name ?? '').trim(),
    runner_name: (rec.runner_name ?? '').trim(),
    opinion_type: asEnum(rec.opinion_type, OPINION_TYPES, 'no_strong_view'),
    confidence: asEnum(rec.confidence, OPINION_CONFIDENCES, 'unknown'),
    evidence_excerpt: (rec.evidence_excerpt ?? '').trim(),
    source_url: (rec.source_url ?? '').trim(),
    licence_status: asEnum(rec.licence_status, LICENCE_STATUSES, 'unknown'),
    notes: (rec.notes ?? '').trim(),
    review_status: asEnum(rec.review_status, REVIEW_STATUSES, 'pending'),
    model_active_eligible: (rec.model_active_eligible ?? '').trim().toLowerCase() === 'true',
  };
}

/** Parses opinion CSV text into typed rows. Pure. */
export function parseOpinionRows(text: string): TipsterOpinionRow[] {
  return parseOpinionCsv(text).rows.map(toOpinionRow);
}

/* -------------------------------------------------------------------------- */
/* Evidence grounding                                                         */
/* -------------------------------------------------------------------------- */

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * True when `excerpt` is a verbatim (whitespace-insensitive) substring of
 * `sourceText`. This is the anti-fabrication gate: an opinion's evidence must
 * actually appear in the supplied local note. Pure.
 */
export function isGroundedInSource(excerpt: string, sourceText: string | null | undefined): boolean {
  const ex = normalizeText(excerpt);
  if (ex === '') return false;
  if (sourceText == null || sourceText.trim() === '') return true; // no source text to check against
  return normalizeText(sourceText).includes(ex);
}

/* -------------------------------------------------------------------------- */
/* Deterministic extraction from LOCAL notes                                  */
/* -------------------------------------------------------------------------- */

/** One opinion inside a local note (structured by the operator / GenAI prep). */
export interface NoteOpinion {
  race_name?: string;
  off_time?: string;
  runner_name: string;
  opinion_type?: string;
  confidence?: string;
  evidence_excerpt: string;
  notes?: string;
}

/** A local tipster note (NEVER fetched — supplied as a local file). */
export interface TipsterNote {
  date: string;
  course: string;
  source_label: string;
  tipster_name: string;
  licence_status?: string;
  source_url?: string;
  /** The local note text the excerpts must be grounded in (optional). */
  source_text?: string;
  opinions: NoteOpinion[];
}

/** The local notes file the extractor consumes. */
export interface TipsterNotesFile {
  notes: TipsterNote[];
}

/** Counters reported by the extractor. */
export interface ExtractionAudit {
  notes_read: number;
  opinions_read: number;
  opinions_emitted: number;
  skipped_no_evidence: number;
  skipped_ungrounded: number;
  skipped_no_runner: number;
  unknown_licence_rows: number;
  synthetic_source_rows: number;
}

export interface ExtractionResult {
  rows: TipsterOpinionRow[];
  audit: ExtractionAudit;
  /** Human-readable per-skip reasons (for the CLI log). */
  warnings: string[];
}

/**
 * Deterministically converts LOCAL structured notes into PENDING opinion rows.
 * Drops (never guesses) any opinion lacking an `evidence_excerpt`, any excerpt
 * not grounded in the note's `source_text`, and any opinion with no runner name.
 * Every emitted row is `review_status = 'pending'`. Pure; no I/O, no network.
 */
export function extractOpinions(file: TipsterNotesFile): ExtractionResult {
  const rows: TipsterOpinionRow[] = [];
  const warnings: string[] = [];
  const audit: ExtractionAudit = {
    notes_read: 0,
    opinions_read: 0,
    opinions_emitted: 0,
    skipped_no_evidence: 0,
    skipped_ungrounded: 0,
    skipped_no_runner: 0,
    unknown_licence_rows: 0,
    synthetic_source_rows: 0,
  };

  for (const note of file.notes ?? []) {
    audit.notes_read += 1;
    const licence = asEnum(note.licence_status ?? '', LICENCE_STATUSES, 'unknown');
    const profile = matchSourceProfile(note.source_label ?? '', note.tipster_name ?? '');
    for (const op of note.opinions ?? []) {
      audit.opinions_read += 1;
      const runner = (op.runner_name ?? '').trim();
      const excerpt = (op.evidence_excerpt ?? '').trim();
      if (runner === '') {
        audit.skipped_no_runner += 1;
        warnings.push(`Skipped an opinion with no runner_name (source "${note.source_label}").`);
        continue;
      }
      if (excerpt === '') {
        audit.skipped_no_evidence += 1;
        warnings.push(`Skipped "${runner}" — no evidence_excerpt (never guessed).`);
        continue;
      }
      if (!isGroundedInSource(excerpt, note.source_text)) {
        audit.skipped_ungrounded += 1;
        warnings.push(`Skipped "${runner}" — evidence_excerpt is not present in the note source_text (ungrounded).`);
        continue;
      }
      if (licence === 'unknown') audit.unknown_licence_rows += 1;
      if (profile?.synthetic) audit.synthetic_source_rows += 1;

      rows.push({
        date: (note.date ?? '').trim(),
        course: (note.course ?? '').trim(),
        race_name: (op.race_name ?? '').trim(),
        off_time: (op.off_time ?? '').trim(),
        source_label: (note.source_label ?? '').trim(),
        tipster_name: (note.tipster_name ?? '').trim(),
        runner_name: runner,
        opinion_type: asEnum(op.opinion_type ?? '', OPINION_TYPES, 'no_strong_view'),
        confidence: asEnum(op.confidence ?? '', OPINION_CONFIDENCES, 'unknown'),
        evidence_excerpt: excerpt,
        source_url: (note.source_url ?? '').trim(),
        // A synthetic strategy profile can never claim a real licence.
        licence_status: profile?.synthetic ? 'unknown' : licence,
        notes: (op.notes ?? '').trim(),
        review_status: 'pending', // extraction NEVER approves
        model_active_eligible: false, // never eligible until reviewed + matched
      });
      audit.opinions_emitted += 1;
    }
  }
  return { rows, audit, warnings };
}

/* -------------------------------------------------------------------------- */
/* Review + eligibility gate                                                  */
/* -------------------------------------------------------------------------- */

/** Per-row review classification. */
export interface OpinionClassification {
  runnerMatched: boolean;
  hasEvidence: boolean;
  licenceAllowed: boolean;
  isSelection: boolean;
  sourceAllowed: boolean;
  synthetic: boolean;
  /** Eligible to become model-active IF approved. */
  eligible: boolean;
  /** Approved AND eligible → becomes a `tipster_selection`. */
  modelActive: boolean;
  blockReasons: string[];
}

/**
 * Classifies one opinion against the eligibility gate, given whether its runner
 * matched a real runner in the target race set. Pure; no I/O.
 */
export function classifyOpinion(
  row: TipsterOpinionRow,
  runnerMatched: boolean,
): OpinionClassification {
  const hasEvidence = row.evidence_excerpt.trim() !== '';
  const licenceAllowed = MODEL_ACTIVE_LICENCES.includes(row.licence_status);
  const isSelection = row.opinion_type === SELECTION_OPINION_TYPE;
  const profile = matchSourceProfile(row.source_label, row.tipster_name);
  const synthetic = profile?.synthetic === true;
  const sourceAllowed = !looksDisallowed(row) && !synthetic && (profile?.allowedModelActive ?? true);

  const blockReasons: string[] = [];
  if (!runnerMatched) blockReasons.push('runner not matched to a real runner');
  if (!hasEvidence) blockReasons.push('no evidence_excerpt');
  if (!licenceAllowed) blockReasons.push(`licence "${row.licence_status}" not permitted for model-active`);
  if (!isSelection) blockReasons.push(`opinion_type "${row.opinion_type}" is context, not a backing selection`);
  if (synthetic) blockReasons.push('synthetic strategy profile (shadow-only until backtested)');
  if (looksDisallowed(row)) blockReasons.push('source signals a disallowed acquisition path');

  const eligible = runnerMatched && hasEvidence && licenceAllowed && isSelection && sourceAllowed;
  if (eligible && row.review_status === 'approved' && !row.model_active_eligible) {
    blockReasons.push('model_active_eligible flag not set to true');
  }
  const modelActive = eligible && row.review_status === 'approved' && row.model_active_eligible === true;
  return { runnerMatched, hasEvidence, licenceAllowed, isSelection, sourceAllowed, synthetic, eligible, modelActive, blockReasons };
}

/** One row's review result. */
export interface OpinionReviewRowResult {
  row: TipsterOpinionRow;
  classification: OpinionClassification;
}

/** The full review report. */
export interface OpinionReviewReport {
  total: number;
  matched: number;
  unmatched: number;
  unknownLicence: number;
  unsupportedSources: number;
  withoutEvidence: number;
  syntheticProfiles: number;
  eligibleForApproval: number;
  approvedModelActive: number;
  blockedFromModelActive: number;
  /** Rows demoted because a correlation family was already represented. */
  correlationCapped: number;
  /** Human-readable correlation-cap warnings (PR family duplicate notes). */
  correlationWarnings: string[];
  perRow: OpinionReviewRowResult[];
}

/**
 * Caps correlation-family duplicates: when ≥2 members of a correlation group are
 * model-active, ONLY the family representative stays model-active; the rest are
 * demoted to diagnostic/shadow — so a family is never counted as several
 * independent votes. Mutates the passed classifications. Returns the cap count +
 * warnings.
 */
function applyCorrelationCap(perRow: readonly OpinionReviewRowResult[]): {
  capped: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  let capped = 0;
  const families = new Map<
    string,
    { group: CorrelationGroup; members: Set<string>; rows: OpinionReviewRowResult[] }
  >();
  for (const pr of perRow) {
    if (!pr.classification.modelActive) continue;
    const group = correlationGroupOf(pr.row.tipster_name) ?? correlationGroupOf(pr.row.source_label);
    const member = correlationMemberOf(pr.row.tipster_name) ?? correlationMemberOf(pr.row.source_label);
    if (!group || !member) continue;
    let entry = families.get(group.group);
    if (!entry) {
      entry = { group, members: new Set(), rows: [] };
      families.set(group.group, entry);
    }
    entry.members.add(member);
    entry.rows.push(pr);
  }
  for (const entry of families.values()) {
    if (entry.members.size < 2) continue; // only cap when 2+ distinct family sources are present
    const keep = entry.members.has(entry.group.representative)
      ? entry.group.representative
      : [...entry.members][0];
    for (const pr of entry.rows) {
      const member = correlationMemberOf(pr.row.tipster_name) ?? correlationMemberOf(pr.row.source_label);
      if (member !== keep) {
        pr.classification.modelActive = false;
        pr.classification.blockReasons.push(
          `correlation-family duplicate (${entry.group.group}): capped to representative "${keep}"`,
        );
        capped += 1;
      }
    }
    warnings.push(
      `${entry.group.group}: ${entry.members.size} correlated sources present → counted as ONE ` +
        `(representative "${keep}"); the rest are diagnostic/shadow.`,
    );
  }
  return { capped, warnings };
}

/**
 * Builds the review report for a set of opinions against a set of real runner
 * names (already normalised by {@link normalizeHorseName}). Applies the
 * correlation-family cap so a family never counts as multiple votes. Pure; no I/O.
 */
export function reviewOpinions(
  rows: readonly TipsterOpinionRow[],
  matchedRunnerNames: ReadonlySet<string>,
): OpinionReviewReport {
  const perRow: OpinionReviewRowResult[] = rows.map((row) => ({
    row,
    classification: classifyOpinion(row, matchedRunnerNames.has(normalizeHorseName(row.runner_name))),
  }));

  // Cap correlation families BEFORE tallying (so demoted rows count as blocked).
  const { capped, warnings } = applyCorrelationCap(perRow);

  let matched = 0;
  let unmatched = 0;
  let unknownLicence = 0;
  let unsupportedSources = 0;
  let withoutEvidence = 0;
  let syntheticProfiles = 0;
  let eligibleForApproval = 0;
  let approvedModelActive = 0;
  let blockedFromModelActive = 0;
  for (const { row, classification: c } of perRow) {
    if (c.runnerMatched) matched += 1;
    else unmatched += 1;
    if (row.licence_status === 'unknown') unknownLicence += 1;
    if (!c.sourceAllowed) unsupportedSources += 1;
    if (!c.hasEvidence) withoutEvidence += 1;
    if (c.synthetic) syntheticProfiles += 1;
    if (c.eligible) eligibleForApproval += 1;
    if (c.modelActive) approvedModelActive += 1;
    else blockedFromModelActive += 1;
  }

  return {
    total: rows.length,
    matched,
    unmatched,
    unknownLicence,
    unsupportedSources,
    withoutEvidence,
    syntheticProfiles,
    eligibleForApproval,
    approvedModelActive,
    blockedFromModelActive,
    correlationCapped: capped,
    correlationWarnings: warnings,
    perRow,
  };
}

/* -------------------------------------------------------------------------- */
/* Opinions → tipster_selections CSV (only approved + eligible rows)          */
/* -------------------------------------------------------------------------- */

/** The header the existing `import:tipster-selections` importer expects. */
export const SELECTION_CSV_COLUMNS = [
  'meeting_date',
  'course',
  'off_time',
  'horse_name',
  'tipster_name',
  'raw_affiliation',
  'source_label',
] as const;

/**
 * Builds the `tipster_selections` import CSV from ONLY approved + model-active
 * opinions (per {@link reviewOpinions}). Rows that are unmatched, unknown-
 * licence, evidence-less, non-selection, synthetic, or not approved are EXCLUDED
 * — they can never reach the importer. Pure.
 */
export function buildApprovedSelectionCsv(report: OpinionReviewReport): string {
  const lines = [SELECTION_CSV_COLUMNS.join(',')];
  for (const { row, classification } of report.perRow) {
    if (!classification.modelActive) continue;
    const cells = [
      row.date,
      row.course,
      row.off_time,
      row.runner_name,
      row.tipster_name,
      row.source_label, // raw_affiliation
      row.source_label,
    ];
    lines.push(cells.map((c) => csvCell(String(c ?? ''))).join(','));
  }
  return lines.join('\n') + '\n';
}
