/**
 * Pure helpers for the LOCAL / MANUAL GenAI note-intake workflow.
 *
 * This is the EVIDENCE-PREP stage that turns operator-supplied LOCAL notes into a
 * safe, reviewable preview BEFORE any (separate, not-yet-active) GenAI commentary
 * step. It is deliberately inert and shadow-only:
 *   - NO network, NO scraping, NO GenAI/LLM calls, NO database access.
 *   - NO model maths, staking, ranking, recommendation, or bet-placement logic.
 *   - It only validates a local JSON document, applies a licence/copyright policy,
 *     and renders a deterministic Markdown PREVIEW of short references/excerpts.
 *
 * It NEVER predicts a winner and is NOT betting advice. Given the same input,
 * every function returns the same output, so the whole module is unit-testable
 * without any I/O. Missing values surface as the em dash "—".
 *
 * It feeds the shadow-only GenAI commentary layer (docs/GENAI_SHADOW_COMMENTARY.md)
 * only AFTER an operator reviews the preview; nothing here makes GenAI active.
 */

/** Em dash used for unknown / missing values. */
const DASH = '\u2014';

/** The recognised provenance types for a note source document. */
export type GenaiNoteSourceType =
  | 'manual_note'
  | 'operator_observation'
  | 'public_note'
  | 'licensed_note';

/** The recognised licence states for a note source document. */
export type GenaiLicenceStatus = 'manual' | 'public_allowed' | 'licensed' | 'unknown';

/** Source types this intake understands. */
export const SUPPORTED_NOTE_SOURCE_TYPES: readonly GenaiNoteSourceType[] = [
  'manual_note',
  'operator_observation',
  'public_note',
  'licensed_note',
];

/** Licence states that are safe to mark "ready for extraction". */
export const ACCEPTED_LICENCE_STATUSES: readonly GenaiLicenceStatus[] = [
  'manual',
  'public_allowed',
  'licensed',
];

/** All licence states recognised here ('unknown' is valid but fails safe). */
export const KNOWN_LICENCE_STATUSES: readonly GenaiLicenceStatus[] = [
  'manual',
  'public_allowed',
  'licensed',
  'unknown',
];

/** Max characters of `raw_note_text` echoed into the preview (excerpt only). */
export const EXCERPT_MAX_CHARS = 280;
/** Max characters echoed per individual note reference. */
export const NOTE_REFERENCE_MAX_CHARS = 200;
/** Above this length `raw_note_text` is flagged as possibly a full article. */
export const LONG_NOTE_WARN_CHARS = 2000;

/**
 * Lowercased substrings that strongly suggest copied / paywalled / full-article
 * content. If any appears in `raw_note_text` the document is REJECTED with a
 * reminder to supply a short original excerpt or reference instead — we never
 * store a full copyrighted article.
 */
export const COPYRIGHT_MARKERS: readonly string[] = [
  '\u00a9', // ©
  '(c)',
  'all rights reserved',
  'rights reserved',
  'copyright',
  'subscribe to read',
  'subscribers only',
  'subscriber only',
  'paywall',
  'terms of use',
  'login to continue',
  'sign in to read',
];

/** Static reminder shown on every preview. Never a prediction. */
export const GENAI_SHADOW_REMINDER =
  'Reminder: this is shadow-only evidence preparation for a future GenAI ' +
  'commentary step. It is not a prediction, does not pick a winner, does not ' +
  'affect recommendations or staking, and is not betting advice. No GenAI/LLM ' +
  'call is made at this stage.';

/** A short, truncated note reference (never the full note). */
export interface GenaiPreparedNote {
  reference: string;
  topic: string | null;
}

/** Whether/why a licence state is acceptable. */
export type LicencePolicy = 'accepted' | 'flagged' | 'unsupported';

/** The full, serialisable assessment of one local note source document. */
export interface GenaiNoteAssessment {
  source_document_id: string | null;
  source_type: GenaiNoteSourceType | null;
  source_label: string | null;
  source_url: string | null;
  licence_status: GenaiLicenceStatus | null;
  licence_policy: LicencePolicy;
  retrieved_at: string | null;
  race_date: string | null;
  course: string | null;
  race_name: string | null;
  /** Short excerpt of `raw_note_text` only — never the full text. */
  raw_note_excerpt: string | null;
  notes: GenaiPreparedNote[];
  /** True only when there are no hard errors AND the licence is accepted. */
  ready_for_extraction: boolean;
  /** Hard rejections (the document is not usable as-is). */
  errors: string[];
  /** Soft flags (usable, but review before extraction). */
  warnings: string[];
}

/** True for a non-null, non-array object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Returns a trimmed non-empty string for `value`, else null. */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Truncates `text` to `max` chars, appending an ellipsis when shortened. */
function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}\u2026`;
}

/** True when `url` is a well-formed http(s) URL. */
export function isHttpUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Returns the copyright/paywall markers present in `text` (lowercased match). */
export function detectCopyrightMarkers(text: string): string[] {
  const lower = text.toLowerCase();
  return COPYRIGHT_MARKERS.filter((m) => lower.includes(m));
}

/** Coerces an unknown `notes` value into short, truncated references. */
export function coerceNotes(raw: unknown): GenaiPreparedNote[] {
  if (!Array.isArray(raw)) return [];
  const out: GenaiPreparedNote[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const ref = asString(item);
      if (ref) out.push({ reference: truncate(ref, NOTE_REFERENCE_MAX_CHARS), topic: null });
    } else if (isPlainObject(item)) {
      const text = asString(item.text) ?? asString(item.note) ?? asString(item.reference);
      if (text) {
        out.push({
          reference: truncate(text, NOTE_REFERENCE_MAX_CHARS),
          topic: asString(item.topic) ?? asString(item.label),
        });
      }
    }
  }
  return out;
}

/**
 * Validates + normalises one local note source document into a serialisable
 * {@link GenaiNoteAssessment}. Never throws and never performs I/O.
 *
 * Policy:
 *  - Required: source_document_id, source_label, race_date, course, raw_note_text.
 *  - licence_status: accepted (manual/public_allowed/licensed) -> eligible;
 *    'unknown' -> flagged warning + not ready (fails safe); anything else /
 *    missing -> unsupported hard error.
 *  - source_url, when present, must be http(s) or it is rejected.
 *  - raw_note_text containing copyright/paywall markers is rejected (excerpt-only).
 *  - ready_for_extraction = no hard errors AND licence accepted.
 */
export function assessGenaiNoteSource(raw: unknown): GenaiNoteAssessment {
  const errors: string[] = [];
  const warnings: string[] = [];

  const obj = isPlainObject(raw) ? raw : {};
  if (!isPlainObject(raw)) {
    errors.push('Input is not a JSON object describing a note source document.');
  }

  const source_document_id = asString(obj.source_document_id);
  if (!source_document_id) errors.push('Missing required field: source_document_id.');

  const source_label = asString(obj.source_label);
  if (!source_label) errors.push('Missing required field: source_label.');

  const race_date = asString(obj.race_date);
  if (!race_date) {
    errors.push('Missing required field: race_date.');
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(race_date)) {
    warnings.push(`race_date "${race_date}" is not in YYYY-MM-DD form.`);
  }

  const course = asString(obj.course);
  if (!course) errors.push('Missing required field: course.');

  // Source type: recognised set, else a soft warning (still usable).
  const rawSourceType = asString(obj.source_type);
  const source_type = SUPPORTED_NOTE_SOURCE_TYPES.includes(
    rawSourceType as GenaiNoteSourceType,
  )
    ? (rawSourceType as GenaiNoteSourceType)
    : null;
  if (rawSourceType && !source_type) {
    warnings.push(
      `Unrecognised source_type "${rawSourceType}". Expected one of: ${SUPPORTED_NOTE_SOURCE_TYPES.join(', ')}.`,
    );
  } else if (!rawSourceType) {
    warnings.push('Missing source_type.');
  }

  // Licence policy.
  const rawLicence = asString(obj.licence_status);
  let licence_status: GenaiLicenceStatus | null = null;
  let licence_policy: LicencePolicy = 'unsupported';
  if (rawLicence && (KNOWN_LICENCE_STATUSES as readonly string[]).includes(rawLicence)) {
    licence_status = rawLicence as GenaiLicenceStatus;
    if ((ACCEPTED_LICENCE_STATUSES as readonly string[]).includes(rawLicence)) {
      licence_policy = 'accepted';
    } else {
      // 'unknown' — valid value but fails safe.
      licence_policy = 'flagged';
      warnings.push('licence_status is "unknown" — not ready for extraction until confirmed.');
    }
  } else {
    licence_policy = 'unsupported';
    errors.push(
      `Unsupported licence_status "${rawLicence ?? ''}". Expected one of: ${KNOWN_LICENCE_STATUSES.join(', ')}.`,
    );
  }

  // Optional source URL: must be http(s) when present (reject unsupported formats).
  const rawUrl = asString(obj.source_url);
  let source_url: string | null = null;
  if (rawUrl) {
    if (isHttpUrl(rawUrl)) {
      source_url = rawUrl;
    } else {
      errors.push('source_url must be an http(s) URL (unsupported URL format rejected).');
    }
  }

  // Raw note text: required; copyright/paywall markers reject; excerpt only.
  const rawNote = asString(obj.raw_note_text);
  let raw_note_excerpt: string | null = null;
  if (!rawNote) {
    errors.push('Missing required field: raw_note_text.');
  } else {
    const markers = detectCopyrightMarkers(rawNote);
    if (markers.length > 0) {
      errors.push(
        'raw_note_text contains copyright/paywall markers — supply a short original excerpt or reference, not a full copied article.',
      );
    }
    if (rawNote.length > LONG_NOTE_WARN_CHARS) {
      warnings.push(
        'raw_note_text is long — ensure this is your own note or a short excerpt, not a full copied article.',
      );
    }
    raw_note_excerpt = truncate(rawNote, EXCERPT_MAX_CHARS);
  }

  const notes = coerceNotes(obj.notes);

  const retrieved_at = asString(obj.retrieved_at);
  const race_name = asString(obj.race_name);

  const ready_for_extraction = errors.length === 0 && licence_policy === 'accepted';

  return {
    source_document_id,
    source_type,
    source_label,
    source_url,
    licence_status,
    licence_policy,
    retrieved_at,
    race_date,
    course,
    race_name,
    raw_note_excerpt,
    notes,
    ready_for_extraction,
    errors,
    warnings,
  };
}

/** Renders a value or the em dash when null/empty. */
function orDash(value: string | null): string {
  return value && value.trim() !== '' ? value : DASH;
}

/**
 * Renders a deterministic Markdown preview of an assessment. No timestamps, no
 * randomness, excerpt/reference text only — and always closes with the
 * shadow-only / not-a-prediction reminder. Pure.
 */
export function renderGenaiNotePreview(assessment: GenaiNoteAssessment): string {
  const lines: string[] = [];

  lines.push('# GenAI Note Intake — Source Preview');
  lines.push('');
  lines.push('## Source summary');
  lines.push(`- Document ID: ${orDash(assessment.source_document_id)}`);
  lines.push(`- Source type: ${orDash(assessment.source_type)}`);
  lines.push(`- Label: ${orDash(assessment.source_label)}`);
  lines.push(`- URL: ${orDash(assessment.source_url)}`);
  lines.push(`- Retrieved at: ${orDash(assessment.retrieved_at)}`);
  lines.push('');
  lines.push('## Licence / source policy');
  lines.push(`- Licence status: ${orDash(assessment.licence_status)}`);
  lines.push(`- Policy verdict: ${assessment.licence_policy}`);
  lines.push('');
  lines.push('## Race');
  lines.push(`- Date: ${orDash(assessment.race_date)}`);
  lines.push(`- Course: ${orDash(assessment.course)}`);
  lines.push(`- Race: ${orDash(assessment.race_name)}`);
  lines.push('');
  lines.push('## Note excerpts (short only)');
  lines.push(
    assessment.raw_note_excerpt ? `> ${assessment.raw_note_excerpt}` : `> ${DASH}`,
  );
  if (assessment.notes.length > 0) {
    for (const note of assessment.notes) {
      const topic = note.topic ? `[${note.topic}] ` : '';
      lines.push(`- ${topic}${note.reference}`);
    }
  } else {
    lines.push(`- ${DASH}`);
  }
  lines.push('');
  lines.push('## Readiness');
  lines.push(`- Ready for extraction: ${assessment.ready_for_extraction ? 'Yes' : 'No'}`);
  lines.push('');
  lines.push('## Issues');
  if (assessment.errors.length > 0) {
    for (const e of assessment.errors) lines.push(`- ${e}`);
  } else {
    lines.push('- None');
  }
  lines.push('');
  lines.push('## Warnings');
  if (assessment.warnings.length > 0) {
    for (const w of assessment.warnings) lines.push(`- ${w}`);
  } else {
    lines.push('- None');
  }
  lines.push('');
  lines.push('---');
  lines.push(GENAI_SHADOW_REMINDER);
  lines.push('');

  return lines.join('\n');
}
