/**
 * Pure helpers for the SHADOW-ONLY GenAI note-extraction layer
 * (scripts/extractNotes.ts). Phase 3 of the autonomous race-day workflow.
 *
 * This module validates, normalises, and renders structured runner features that
 * were extracted (by a human or, later, a configured GenAI step) from manually
 * supplied or public/legal race/tipster notes. It is STRICTLY DECISION-SUPPORT
 * and SHADOW-ONLY:
 *   - it NEVER calls a model or an external API (no I/O at all here),
 *   - extracted features are NEVER model-active (model_active must be false),
 *   - it NEVER predicts winners and rejects any winner/probability/staking field,
 *   - missing or ambiguous evidence becomes `unknown` — it is never guessed.
 *
 * Everything here is pure and deterministic: schema constants, validation,
 * normalisation, evidence checks, argument parsing, and Markdown rendering. There
 * is no database access, no network, and no mutation. Nothing is fabricated: a
 * missing value normalises to `unknown` / `null` / `[]` and renders as an em dash.
 */

/* -------------------------------------------------------------------------- */
/* Schema constants                                                           */
/* -------------------------------------------------------------------------- */

/** Allowed tri-state signal values. */
export const SIGNAL_VALUES = ['positive', 'negative', 'unknown'] as const;
export type SignalValue = (typeof SIGNAL_VALUES)[number];

/** Allowed risk values. */
export const RISK_VALUES = ['low', 'medium', 'high', 'unknown'] as const;
export type RiskValue = (typeof RISK_VALUES)[number];

/** Allowed case-strength values. */
export const STRENGTH_VALUES = ['none', 'weak', 'medium', 'strong', 'unknown'] as const;
export type StrengthValue = (typeof STRENGTH_VALUES)[number];

/** Allowed review statuses. */
export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** review_status defaults to `pending` when omitted. */
export const DEFAULT_REVIEW_STATUS: ReviewStatus = 'pending';

/** The ten tri-state signal fields (positive/negative/unknown). */
export const SIGNAL_FIELDS = [
  'ground_signal',
  'distance_signal',
  'course_form_signal',
  'draw_signal',
  'pace_setup_signal',
  'trainer_form_signal',
  'jockey_signal',
  'recent_run_signal',
  'class_move_signal',
  'market_support_signal',
] as const;
export type SignalField = (typeof SIGNAL_FIELDS)[number];

/** The two risk fields (low/medium/high/unknown). */
export const RISK_FIELDS = ['race_type_risk', 'volatility_risk'] as const;
export type RiskField = (typeof RISK_FIELDS)[number];

/** The three case-strength fields (none/weak/medium/strong/unknown). */
export const STRENGTH_FIELDS = [
  'value_case_strength',
  'likely_winner_case_strength',
  'each_way_case_strength',
] as const;
export type StrengthField = (typeof STRENGTH_FIELDS)[number];

/** Keys allowed on a feature object (anything else is unexpected/forbidden). */
const ALLOWED_FEATURE_KEYS = new Set<string>([
  'runner_name',
  ...SIGNAL_FIELDS,
  ...RISK_FIELDS,
  ...STRENGTH_FIELDS,
  'concern_flags',
  'evidence',
  'extraction_confidence',
  'model_active',
  'review_status',
]);

/** Keys allowed on the top-level input object. */
const ALLOWED_INPUT_KEYS = new Set<string>([
  'source_document_id',
  'source_label',
  'source_url',
  'retrieved_at',
  'race_date',
  'course',
  'race_name',
  'off_time',
  'raw_note_text',
  'extracted_features',
]);

/* -------------------------------------------------------------------------- */
/* Normalised output types                                                    */
/* -------------------------------------------------------------------------- */

/** One evidence citation: which feature, and the quote/reference behind it. */
export interface EvidenceCitation {
  feature: string;
  quote_or_reference: string;
}

/** A fully-normalised, shadow-only runner feature record. */
export interface NormalizedFeature {
  runner_name: string;
  ground_signal: SignalValue;
  distance_signal: SignalValue;
  course_form_signal: SignalValue;
  draw_signal: SignalValue;
  pace_setup_signal: SignalValue;
  trainer_form_signal: SignalValue;
  jockey_signal: SignalValue;
  recent_run_signal: SignalValue;
  class_move_signal: SignalValue;
  market_support_signal: SignalValue;
  race_type_risk: RiskValue;
  volatility_risk: RiskValue;
  value_case_strength: StrengthValue;
  likely_winner_case_strength: StrengthValue;
  each_way_case_strength: StrengthValue;
  concern_flags: string[];
  evidence: EvidenceCitation[];
  extraction_confidence: number;
  /** Always false in the shadow phase (enforced by validation). */
  model_active: false;
  review_status: ReviewStatus;
}

/** The normalised extraction document (source metadata + features). */
export interface NormalizedExtraction {
  source_document_id: string | null;
  source_label: string | null;
  source_url: string | null;
  retrieved_at: string | null;
  race_date: string | null;
  course: string | null;
  race_name: string | null;
  off_time: string | null;
  raw_note_text: string;
  extracted_features: NormalizedFeature[];
}

/** A single validation finding (path + human-readable message). */
export interface ValidationIssue {
  path: string;
  message: string;
}

/** The result of validating + normalising a raw extraction input. */
export interface NoteExtractionValidation {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** The normalised document when there are no hard errors, else null. */
  normalized: NormalizedExtraction | null;
}

/* -------------------------------------------------------------------------- */
/* Small predicates                                                           */
/* -------------------------------------------------------------------------- */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** True only for an http(s) URL. Pure; tolerant of junk input. */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** A string when present and non-empty, else null (never fabricated). */
function optionalString(value: unknown): string | null {
  return isNonEmptyString(value) ? value.trim() : null;
}

/**
 * Classifies a key as a FORBIDDEN extraction field — a winner prediction, a
 * probability, or a staking field — or null when it is innocuous. Used to reject
 * any attempt to smuggle predictive/model-active data into the shadow layer.
 * Pure; only consulted for keys NOT in the allowed schema, so legitimate fields
 * like `likely_winner_case_strength` are never scanned.
 */
export function classifyForbiddenKey(
  key: string,
): 'winner_prediction' | 'probability' | 'staking' | null {
  const k = key.toLowerCase();
  if (/winner|predict|forecast|will_win/.test(k)) return 'winner_prediction';
  if (/probab|(^|_)prob($|_)|win_prob|odds/.test(k)) return 'probability';
  if (/stake|kelly|expected_value|(^|_)ev($|_)|bet_size/.test(k)) return 'staking';
  return null;
}

/**
 * Scans an object's keys: any key not in `allowed` that classifies as forbidden
 * is an ERROR; any other unexpected key is a WARNING. Pure; mutates the supplied
 * issue arrays only.
 */
function scanKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) continue;
    const forbidden = classifyForbiddenKey(key);
    if (forbidden) {
      errors.push({
        path: `${path}.${key}`,
        message: `forbidden ${forbidden} field is not allowed in a shadow extraction`,
      });
    } else {
      warnings.push({ path: `${path}.${key}`, message: 'unexpected field ignored' });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Validation + normalisation                                                 */
/* -------------------------------------------------------------------------- */

/** Validates one enum-valued field; missing -> `unknown`, invalid -> error. */
function normalizeEnum<T extends string>(
  raw: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  unknownValue: T,
  path: string,
  errors: ValidationIssue[],
): T {
  if (!(field in raw) || raw[field] === undefined || raw[field] === null) {
    return unknownValue; // missing -> unknown (never guessed)
  }
  const value = raw[field];
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  errors.push({
    path: `${path}.${field}`,
    message: `invalid value (expected one of: ${allowed.join(', ')})`,
  });
  return unknownValue;
}

/** Normalises the evidence array; malformed entries are reported, not kept. */
function normalizeEvidence(
  raw: unknown,
  path: string,
  errors: ValidationIssue[],
): EvidenceCitation[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push({ path: `${path}.evidence`, message: 'evidence must be an array' });
    return [];
  }
  const out: EvidenceCitation[] = [];
  raw.forEach((entry, i) => {
    if (
      isObject(entry) &&
      isNonEmptyString(entry.feature) &&
      isNonEmptyString(entry.quote_or_reference)
    ) {
      out.push({
        feature: entry.feature.trim(),
        quote_or_reference: entry.quote_or_reference.trim(),
      });
    } else {
      errors.push({
        path: `${path}.evidence[${i}]`,
        message: 'each evidence entry needs a non-empty feature and quote_or_reference',
      });
    }
  });
  return out;
}

/** Normalises concern_flags to a string array; missing -> []. */
function normalizeConcernFlags(
  raw: unknown,
  path: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push({ path: `${path}.concern_flags`, message: 'concern_flags must be an array' });
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (isNonEmptyString(entry)) out.push(entry.trim());
    else warnings.push({ path: `${path}.concern_flags`, message: 'dropped a non-string concern flag' });
  }
  return out;
}

/** True when the evidence array cites a non-empty quote for `feature`. */
function evidenceHasFeature(evidence: EvidenceCitation[], feature: string): boolean {
  return evidence.some((e) => e.feature === feature && e.quote_or_reference !== '');
}

/** Validates + normalises one feature object. Pushes issues; returns the record. */
function normalizeFeature(
  raw: unknown,
  index: number,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): NormalizedFeature | null {
  const path = `extracted_features[${index}]`;
  if (!isObject(raw)) {
    errors.push({ path, message: 'feature must be an object' });
    return null;
  }

  // Reject smuggled winner/probability/staking fields; warn on unexpected keys.
  scanKeys(raw, ALLOWED_FEATURE_KEYS, path, errors, warnings);

  // runner_name is required.
  const runner_name = optionalString(raw.runner_name);
  if (runner_name === null) {
    errors.push({ path: `${path}.runner_name`, message: 'runner_name is required' });
  }

  // model_active MUST be false in the shadow phase.
  if ('model_active' in raw && raw.model_active !== false) {
    errors.push({
      path: `${path}.model_active`,
      message: 'model_active must be false in the shadow phase',
    });
  }

  // review_status defaults to pending; invalid -> error.
  let review_status: ReviewStatus = DEFAULT_REVIEW_STATUS;
  if ('review_status' in raw && raw.review_status !== undefined && raw.review_status !== null) {
    if (typeof raw.review_status === 'string' && (REVIEW_STATUSES as readonly string[]).includes(raw.review_status)) {
      review_status = raw.review_status as ReviewStatus;
    } else {
      errors.push({
        path: `${path}.review_status`,
        message: `invalid review_status (expected one of: ${REVIEW_STATUSES.join(', ')})`,
      });
    }
  }

  // extraction_confidence: required, finite, within 0..1.
  let extraction_confidence = 0;
  if (!isFiniteNumber(raw.extraction_confidence)) {
    errors.push({
      path: `${path}.extraction_confidence`,
      message: 'extraction_confidence must be a finite number',
    });
  } else if (raw.extraction_confidence < 0 || raw.extraction_confidence > 1) {
    errors.push({
      path: `${path}.extraction_confidence`,
      message: 'extraction_confidence must be between 0 and 1',
    });
  } else {
    extraction_confidence = raw.extraction_confidence;
  }

  // Signals / risks / strengths: missing -> unknown; invalid -> error.
  const signals = {} as Record<SignalField, SignalValue>;
  for (const field of SIGNAL_FIELDS) {
    signals[field] = normalizeEnum(raw, field, SIGNAL_VALUES, 'unknown', path, errors);
  }
  const risks = {} as Record<RiskField, RiskValue>;
  for (const field of RISK_FIELDS) {
    risks[field] = normalizeEnum(raw, field, RISK_VALUES, 'unknown', path, errors);
  }
  const strengths = {} as Record<StrengthField, StrengthValue>;
  for (const field of STRENGTH_FIELDS) {
    strengths[field] = normalizeEnum(raw, field, STRENGTH_VALUES, 'unknown', path, errors);
  }

  const concern_flags = normalizeConcernFlags(raw.concern_flags, path, errors, warnings);
  const evidence = normalizeEvidence(raw.evidence, path, errors);

  // Every non-unknown SIGNAL must carry evidence; unknown signals do not.
  for (const field of SIGNAL_FIELDS) {
    if (signals[field] !== 'unknown' && !evidenceHasFeature(evidence, field)) {
      errors.push({
        path: `${path}.${field}`,
        message: `non-unknown signal "${signals[field]}" requires an evidence quote_or_reference`,
      });
    }
  }

  return {
    runner_name: runner_name ?? '',
    ...signals,
    ...risks,
    ...strengths,
    concern_flags,
    evidence,
    extraction_confidence,
    model_active: false,
    review_status,
  } as NormalizedFeature;
}

/**
 * Validates and normalises a raw note-extraction input (already JSON-parsed).
 * Returns the collected errors/warnings and, when there are no hard errors, the
 * normalised document. Pure; never throws; never fabricates — missing values
 * become `unknown` / `null` / `[]`. Enforces the shadow-layer safety rules:
 * model_active must be false, no winner/probability/staking fields, evidence for
 * every non-unknown signal, a finite 0..1 confidence, http(s) source_url, and a
 * required raw_note_text + per-feature runner_name.
 */
export function validateNoteExtraction(rawInput: unknown): NoteExtractionValidation {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!isObject(rawInput)) {
    errors.push({ path: '$', message: 'input must be a JSON object' });
    return { ok: false, errors, warnings, normalized: null };
  }

  scanKeys(rawInput, ALLOWED_INPUT_KEYS, '$', errors, warnings);

  // raw_note_text is required.
  const raw_note_text = isNonEmptyString(rawInput.raw_note_text)
    ? rawInput.raw_note_text
    : null;
  if (raw_note_text === null) {
    errors.push({ path: '$.raw_note_text', message: 'raw_note_text is required' });
  }

  // source_url, when provided, must be http(s).
  const sourceUrlRaw = rawInput.source_url;
  let source_url: string | null = null;
  if (sourceUrlRaw !== undefined && sourceUrlRaw !== null && sourceUrlRaw !== '') {
    if (typeof sourceUrlRaw === 'string' && isHttpUrl(sourceUrlRaw)) {
      source_url = sourceUrlRaw.trim();
    } else {
      errors.push({ path: '$.source_url', message: 'source_url must be an http(s) URL when provided' });
    }
  }

  // extracted_features must be an array (empty -> warning, still structurally ok).
  const features: NormalizedFeature[] = [];
  if (!Array.isArray(rawInput.extracted_features)) {
    errors.push({ path: '$.extracted_features', message: 'extracted_features must be an array' });
  } else {
    if (rawInput.extracted_features.length === 0) {
      warnings.push({ path: '$.extracted_features', message: 'no extracted features' });
    }
    rawInput.extracted_features.forEach((feature, i) => {
      const normalized = normalizeFeature(feature, i, errors, warnings);
      if (normalized) features.push(normalized);
    });
  }

  const ok = errors.length === 0;
  const normalized: NormalizedExtraction | null = ok
    ? {
        source_document_id: optionalString(rawInput.source_document_id),
        source_label: optionalString(rawInput.source_label),
        source_url,
        retrieved_at: optionalString(rawInput.retrieved_at),
        race_date: optionalString(rawInput.race_date),
        course: optionalString(rawInput.course),
        race_name: optionalString(rawInput.race_name),
        off_time: optionalString(rawInput.off_time),
        raw_note_text: raw_note_text ?? '',
        extracted_features: features,
      }
    : null;

  return { ok, errors, warnings, normalized };
}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

/** Parsed CLI options for the extraction preview tool. */
export interface ExtractNotesArgs {
  /** Local input JSON path (required by the caller). */
  input?: string;
  /** Optional Markdown preview output path. */
  output?: string;
  /** Optional normalised JSON output path. */
  jsonOut?: string;
}

/**
 * Parses argv (already sliced past `node script`). `--input` / `--output` /
 * `--json` take a path value; blanks are ignored. Pure; read-only.
 */
export function parseExtractNotesArgs(argv: readonly string[]): ExtractNotesArgs {
  const args: ExtractNotesArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') args.input = v;
    } else if (a === '--output') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') args.output = v;
    } else if (a === '--json') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') args.jsonOut = v;
    }
  }
  return args;
}

/* -------------------------------------------------------------------------- */
/* Markdown rendering (pure, deterministic)                                   */
/* -------------------------------------------------------------------------- */

const DASH = '\u2014';

/** Formats a value as text, or an em dash when null/empty. */
function orDash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return DASH;
  return String(value);
}

/** Renders the raw note text as a safe multi-line Markdown blockquote. */
function renderNoteBlockquote(text: string): string {
  const lines = text.split(/\r?\n/);
  return lines.map((line) => `> ${line}`).join('\n');
}

/** Renders one feature section deterministically. Pure. */
function renderFeatureSection(feature: NormalizedFeature): string {
  const lines: string[] = [];
  lines.push(`### ${feature.runner_name || '(unknown runner)'}`);
  lines.push('');
  lines.push(`- model_active: ${feature.model_active}`);
  lines.push(`- review_status: ${feature.review_status}`);
  lines.push(`- extraction_confidence: ${orDash(feature.extraction_confidence)}`);
  lines.push('');
  lines.push('Signals:');
  for (const field of SIGNAL_FIELDS) {
    lines.push(`- ${field}: ${feature[field]}`);
  }
  lines.push('');
  lines.push('Risk / case strength:');
  for (const field of RISK_FIELDS) {
    lines.push(`- ${field}: ${feature[field]}`);
  }
  for (const field of STRENGTH_FIELDS) {
    lines.push(`- ${field}: ${feature[field]}`);
  }
  lines.push('');
  lines.push(
    `- concern_flags: ${feature.concern_flags.length ? feature.concern_flags.join(', ') : DASH}`,
  );
  lines.push('- evidence:');
  if (feature.evidence.length === 0) {
    lines.push(`  - ${DASH}`);
  } else {
    for (const e of feature.evidence) {
      lines.push(`  - ${e.feature}: "${e.quote_or_reference}"`);
    }
  }
  return lines.join('\n');
}

/**
 * Renders the full extraction preview as deterministic Markdown. Pure: the same
 * normalised document always yields the same string. Shadow-only: a prominent
 * banner states the features are NOT model-active and never predict winners.
 * Missing values render as an em dash; nothing is fabricated.
 */
export function renderNoteExtractionMarkdown(doc: NormalizedExtraction): string {
  const blocks: string[] = [];

  blocks.push('# GenAI note-extraction preview (SHADOW — not model-active)');
  blocks.push(
    [
      '> Shadow layer: these structured features come from manually-supplied or',
      '> public/legal notes for REVIEW ONLY. They are NOT model-active, never',
      '> predict winners, and never influence probability, staking, or ranking.',
      '> Unknowns are preserved; missing values are not fabricated.',
    ].join('\n'),
  );

  blocks.push(
    [
      '## Source document',
      '',
      `- source_document_id: ${orDash(doc.source_document_id)}`,
      `- source_label: ${orDash(doc.source_label)}`,
      `- source_url: ${orDash(doc.source_url)}`,
      `- retrieved_at: ${orDash(doc.retrieved_at)}`,
      `- race_date: ${orDash(doc.race_date)}`,
      `- course: ${orDash(doc.course)}`,
      `- race_name: ${orDash(doc.race_name)}`,
      `- off_time: ${orDash(doc.off_time)}`,
      `- features: ${doc.extracted_features.length}`,
    ].join('\n'),
  );

  blocks.push(['### Raw note text', '', renderNoteBlockquote(doc.raw_note_text)].join('\n'));

  blocks.push(`## Extracted features (${doc.extracted_features.length})`);
  if (doc.extracted_features.length === 0) {
    blocks.push('_No extracted features._');
  } else {
    for (const feature of doc.extracted_features) {
      blocks.push(renderFeatureSection(feature));
    }
  }

  return blocks.join('\n\n') + '\n';
}
