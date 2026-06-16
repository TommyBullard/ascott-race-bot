/**
 * Pure logic for the tipster source registry + candidate review queue (Phase 4A).
 *
 * This module is the SINGLE SOURCE of the validation and mapping rules that keep
 * the candidate queue safe and auditable. It performs NO I/O, NO DB access, and
 * NO mutation, so every rule below is unit-testable without a database.
 *
 * The safety guarantees encoded here:
 *   - Candidates are validated before they enter the queue, and never
 *     fabricated: a row with missing/ill-formed required fields is rejected, not
 *     guessed.
 *   - A candidate can only be mapped into a live `tipster_selections` row when it
 *     is BOTH approved AND fully resolved (race + runner). `mapApprovedCandidate
 *     ToSelection` throws otherwise, so a pending/rejected/unresolved candidate
 *     can never silently become a live selection that the model reads.
 *   - Approval requires the candidate's source to be registered AND approved in
 *     `tipster_source_registry` (`canApproveCandidate`), so picks never enter the
 *     model from an unvetted feed. Nothing is approved automatically.
 *
 * The candidate table keeps source_label / source_url / source_name for full
 * provenance; the existing `tipster_selections` table only has a `source_label`
 * provenance column, so the mapping carries the label across and the richer
 * provenance stays on the candidate row for audit.
 */

/** The three review states a candidate can be in. */
export type CandidateStatus = 'pending' | 'approved' | 'rejected';

/** All valid review states, in workflow order. */
export const CANDIDATE_STATUSES: readonly CandidateStatus[] = [
  'pending',
  'approved',
  'rejected',
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;

/** Trims a possibly-missing string; empty/blank becomes null. */
function trimOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Narrows an unknown value to one of the three valid review states. */
export function isCandidateStatus(value: unknown): value is CandidateStatus {
  return (
    typeof value === 'string' &&
    (CANDIDATE_STATUSES as readonly string[]).includes(value)
  );
}

/** A raw, as-captured candidate before it is validated/normalised. */
export interface RawCandidateInput {
  meeting_date?: string | null;
  course?: string | null;
  off_time?: string | null;
  horse_name?: string | null;
  tipster_name?: string | null;
  raw_affiliation?: string | null;
  source_label?: string | null;
  source_url?: string | null;
  source_name?: string | null;
}

/** A validated candidate, with whitespace trimmed and blanks normalised. */
export interface NormalizedCandidate {
  meeting_date: string;
  course: string;
  off_time: string;
  horse_name: string;
  tipster_name: string;
  raw_affiliation: string | null;
  source_label: string | null;
  source_url: string | null;
  source_name: string | null;
}

/** Result of validating a raw candidate. `candidate` is null when not ok. */
export interface CandidateValidationResult {
  ok: boolean;
  problems: string[];
  candidate: NormalizedCandidate | null;
}

/**
 * Validates a raw candidate destined for the review queue and returns the
 * normalised row (or the problems). Required fields mirror the CSV importer
 * (meeting_date YYYY-MM-DD, course, off_time HH:MM, horse_name, tipster_name) so
 * a candidate carries everything needed to resolve a real race + runner at
 * approval time. Provenance fields (source_label/url/name) are optional and are
 * preserved verbatim "if available" — never invented. Pure; never throws.
 */
export function validateCandidate(input: RawCandidateInput): CandidateValidationResult {
  const meeting_date = (input.meeting_date ?? '').trim();
  const course = (input.course ?? '').trim();
  const off_time = (input.off_time ?? '').trim();
  const horse_name = (input.horse_name ?? '').trim();
  const tipster_name = (input.tipster_name ?? '').trim();

  const problems: string[] = [];
  if (!DATE_RE.test(meeting_date)) problems.push('meeting_date must be YYYY-MM-DD');
  if (course === '') problems.push('course is required');
  if (!TIME_RE.test(off_time)) problems.push('off_time must be HH:MM');
  if (horse_name === '') problems.push('horse_name is required');
  if (tipster_name === '') problems.push('tipster_name is required');

  if (problems.length > 0) {
    return { ok: false, problems, candidate: null };
  }

  return {
    ok: true,
    problems: [],
    candidate: {
      meeting_date,
      course,
      off_time,
      horse_name,
      tipster_name,
      raw_affiliation: trimOrNull(input.raw_affiliation),
      source_label: trimOrNull(input.source_label),
      source_url: trimOrNull(input.source_url),
      source_name: trimOrNull(input.source_name),
    },
  };
}

/** A raw source-registry entry before validation. */
export interface RawSourceInput {
  source_label?: string | null;
  source_name?: string | null;
  source_url?: string | null;
  notes?: string | null;
}

/** A validated, normalised source-registry entry (always unapproved on add). */
export interface NormalizedSource {
  source_label: string;
  source_name: string;
  source_url: string | null;
  notes: string | null;
}

/** Result of validating a source-registry entry. */
export interface SourceValidationResult {
  ok: boolean;
  problems: string[];
  source: NormalizedSource | null;
}

/**
 * Validates a source-registry entry. `source_label` and `source_name` are
 * required; `source_url`/`notes` are optional. Note this never sets an approval
 * flag — a freshly added source is always unapproved until an operator approves
 * it explicitly. Pure; never throws.
 */
export function validateSourceInput(input: RawSourceInput): SourceValidationResult {
  const source_label = (input.source_label ?? '').trim();
  const source_name = (input.source_name ?? '').trim();

  const problems: string[] = [];
  if (source_label === '') problems.push('source_label is required');
  if (source_name === '') problems.push('source_name is required');

  if (problems.length > 0) {
    return { ok: false, problems, source: null };
  }

  return {
    ok: true,
    problems: [],
    source: {
      source_label,
      source_name,
      source_url: trimOrNull(input.source_url),
      notes: trimOrNull(input.notes),
    },
  };
}

/** The registry row this module reasons about when deciding approval. */
export interface RegistrySource {
  source_label: string;
  is_approved: boolean;
}

/** A candidate as far as the approval-eligibility decision is concerned. */
export interface ApprovalCandidateView {
  status: string;
  source_label?: string | null;
}

/** Whether a candidate may be approved, with human-readable reasons if not. */
export interface ApprovalEligibility {
  ok: boolean;
  reasons: string[];
}

/**
 * Pure decision: may this candidate be approved into `tipster_selections`?
 *
 * Requires that the candidate is still `pending`, names a source, and that the
 * source is present in the registry AND approved. Resolving the race/runner is a
 * separate (I/O) step performed by the approval script; this only governs the
 * trust gate. Pass `source = null` when the candidate's label is not registered.
 * Pure; never throws.
 */
export function canApproveCandidate(
  candidate: ApprovalCandidateView,
  source: RegistrySource | null,
): ApprovalEligibility {
  const reasons: string[] = [];

  if (candidate.status !== 'pending') {
    reasons.push(`candidate status is "${candidate.status}", expected "pending"`);
  }

  const label = (candidate.source_label ?? '').trim();
  if (label === '') {
    reasons.push(
      'candidate has no source_label; only registered, approved sources can be approved',
    );
  } else if (source === null) {
    reasons.push(`source "${label}" is not registered in tipster_source_registry`);
  } else if (!source.is_approved) {
    reasons.push(`source "${label}" is registered but not approved`);
  }

  return { ok: reasons.length === 0, reasons };
}

/** A candidate that has been resolved (race + runner) and is being approved. */
export interface ApprovedCandidateForMapping {
  status: string;
  race_id: string | null;
  runner_id: string | null;
  tipster_id: string | null;
  tipster_name: string;
  raw_affiliation: string | null;
  source_label: string | null;
}

/** The exact insert shape for a `tipster_selections` row. */
export interface TipsterSelectionInsert {
  race_id: string;
  runner_id: string;
  tipster_id: string | null;
  raw_tipster_name: string;
  raw_affiliation: string | null;
  source_label: string | null;
}

/**
 * Maps an APPROVED, fully-resolved candidate to a `tipster_selections` insert
 * row. This is the ONLY sanctioned candidate -> live-selection transform, and it
 * is deliberately strict:
 *
 *   - Throws unless `status === 'approved'`, so a pending or rejected candidate
 *     can never become a live selection (the model reads `tipster_selections`).
 *   - Throws unless both `race_id` and `runner_id` are resolved, so an
 *     unresolved candidate is never inserted with fabricated references.
 *
 * Only `source_label` carries across (the sole provenance column on
 * `tipster_selections`); the candidate's source_url/source_name stay on the
 * candidate row for audit. Pure; the only side effect is throwing on misuse.
 */
export function mapApprovedCandidateToSelection(
  candidate: ApprovedCandidateForMapping,
): TipsterSelectionInsert {
  if (candidate.status !== 'approved') {
    throw new Error(
      `Cannot map candidate with status "${candidate.status}" to a selection; ` +
        'must be "approved".',
    );
  }

  const race_id = (candidate.race_id ?? '').trim();
  const runner_id = (candidate.runner_id ?? '').trim();
  const raw_tipster_name = (candidate.tipster_name ?? '').trim();

  if (race_id === '') {
    throw new Error('Cannot map candidate to a selection without a resolved race_id.');
  }
  if (runner_id === '') {
    throw new Error('Cannot map candidate to a selection without a resolved runner_id.');
  }
  if (raw_tipster_name === '') {
    throw new Error('Cannot map candidate to a selection without a tipster_name.');
  }

  return {
    race_id,
    runner_id,
    tipster_id: candidate.tipster_id,
    raw_tipster_name,
    raw_affiliation: trimOrNull(candidate.raw_affiliation),
    source_label: trimOrNull(candidate.source_label),
  };
}

/** Composes the UTC off-time instant from meeting_date + HH:MM, or null. */
export function composeOffTimeIso(
  meetingDate: string,
  offTime: string,
): string | null {
  const hhmm = offTime.trim().padStart(5, '0');
  const ms = Date.parse(`${meetingDate}T${hhmm}:00Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Canonicalises a DB timestamp to a comparable ISO instant, or null. */
export function canonicalOffTimeIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
