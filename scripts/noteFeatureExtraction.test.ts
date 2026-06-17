/**
 * Unit tests for the pure shadow-only note-extraction helpers
 * (src/lib/noteFeatureExtraction.ts) and content checks for the prompt template.
 *
 * No DB, no network, no secrets, no GenAI: synthetic extraction inputs exercise
 * the schema validation, normalisation (missing -> unknown), the evidence
 * requirement, the forbidden-field rejection (winner/probability/staking), the
 * model_active=false rule, and the deterministic Markdown rendering. Source scans
 * prove the CLI + module make no DB writes and call no external API, and that the
 * prompt template carries the extraction-only / no-winner-prediction rules.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  validateNoteExtraction,
  renderNoteExtractionMarkdown,
  parseExtractNotesArgs,
  isHttpUrl,
  classifyForbiddenKey,
  DEFAULT_REVIEW_STATUS,
} from '../src/lib/noteFeatureExtraction';

/** A valid feature; override individual fields to test each rule. */
function validFeature(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runner_name: 'EXAMPLE Runner (SYNTHETIC)',
    ground_signal: 'positive',
    distance_signal: 'unknown',
    draw_signal: 'unknown',
    race_type_risk: 'medium',
    volatility_risk: 'low',
    value_case_strength: 'weak',
    likely_winner_case_strength: 'none',
    each_way_case_strength: 'weak',
    concern_flags: ['example_flag'],
    evidence: [{ feature: 'ground_signal', quote_or_reference: 'loves the ground' }],
    extraction_confidence: 0.5,
    model_active: false,
    review_status: 'pending',
    ...over,
  };
}

/** A valid input document; override to test each rule. */
function validInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_document_id: 'doc-1',
    source_label: 'example-synthetic',
    source_url: 'https://example.com/notes',
    race_date: '2026-06-16',
    course: 'Example Downs (SYNTHETIC)',
    race_name: 'EXAMPLE Race',
    raw_note_text: 'SYNTHETIC example note text.',
    extracted_features: [validFeature()],
    ...over,
  };
}

/* ------------------------------ happy path -------------------------------- */

test('valid extraction passes with no errors', () => {
  const r = validateNoteExtraction(validInput());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.ok(r.normalized);
  assert.equal(r.normalized.extracted_features.length, 1);
  assert.equal(r.normalized.extracted_features[0].model_active, false);
});

test('the example fixture validates cleanly and is all shadow (model_active=false)', () => {
  const raw = JSON.parse(readFileSync('data/note-extractions/example-notes.json', 'utf8'));
  const r = validateNoteExtraction(raw);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.normalized!.extracted_features.every((f) => f.model_active === false), true);
});

test('a non-object input is rejected', () => {
  assert.equal(validateNoteExtraction(null).ok, false);
  assert.equal(validateNoteExtraction('a string').ok, false);
  assert.equal(validateNoteExtraction([]).ok, false);
});

/* --------------------------- normalisation -------------------------------- */

test('missing optional signals normalise to unknown; missing arrays to []', () => {
  const feature = { runner_name: 'X', extraction_confidence: 0.5, evidence: [], model_active: false };
  const r = validateNoteExtraction(validInput({ extracted_features: [feature] }));
  assert.equal(r.ok, true);
  const f = r.normalized!.extracted_features[0];
  assert.equal(f.ground_signal, 'unknown');
  assert.equal(f.market_support_signal, 'unknown');
  assert.equal(f.race_type_risk, 'unknown');
  assert.equal(f.value_case_strength, 'unknown');
  assert.deepEqual(f.concern_flags, []);
  assert.deepEqual(f.evidence, []);
});

test('an invalid signal value is rejected, not silently coerced', () => {
  const r = validateNoteExtraction(validInput({ extracted_features: [validFeature({ ground_signal: 'maybe' })] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /ground_signal/.test(e.path)));
});

/* ------------------------------ evidence ---------------------------------- */

test('a non-unknown signal without evidence is rejected', () => {
  const feature = validFeature({ ground_signal: 'positive', evidence: [] });
  const r = validateNoteExtraction(validInput({ extracted_features: [feature] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /ground_signal/.test(e.path) && /evidence/.test(e.message)));
});

test('unknown signals require no evidence', () => {
  const feature = { runner_name: 'X', extraction_confidence: 0.5, evidence: [], model_active: false };
  assert.equal(validateNoteExtraction(validInput({ extracted_features: [feature] })).ok, true);
});

/* ------------------------- shadow-safety rules ---------------------------- */

test('model_active = true is rejected', () => {
  const r = validateNoteExtraction(validInput({ extracted_features: [validFeature({ model_active: true })] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /model_active/.test(e.path)));
});

test('a winner-prediction field is rejected (top-level and per-feature)', () => {
  const top = validateNoteExtraction(validInput({ winner_prediction: 'EXAMPLE Runner' }));
  assert.equal(top.ok, false);
  assert.ok(top.errors.some((e) => /winner_prediction/.test(e.path)));

  const feat = validateNoteExtraction(
    validInput({ extracted_features: [validFeature({ predicted_winner: true })] }),
  );
  assert.equal(feat.ok, false);
  assert.ok(feat.errors.some((e) => /predicted_winner/.test(e.path)));
});

test('probability and staking fields are rejected', () => {
  assert.equal(
    validateNoteExtraction(validInput({ extracted_features: [validFeature({ win_probability: 0.3 })] })).ok,
    false,
  );
  assert.equal(
    validateNoteExtraction(validInput({ extracted_features: [validFeature({ stake_amount: 2 })] })).ok,
    false,
  );
  assert.equal(
    validateNoteExtraction(validInput({ extracted_features: [validFeature({ ev: 0.1 })] })).ok,
    false,
  );
});

test('legitimate likely_winner_case_strength is NOT rejected (allowed-key skip)', () => {
  const r = validateNoteExtraction(
    validInput({ extracted_features: [validFeature({ likely_winner_case_strength: 'strong' })] }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.normalized!.extracted_features[0].likely_winner_case_strength, 'strong');
});

test('a non-http(s) source_url is rejected', () => {
  assert.equal(validateNoteExtraction(validInput({ source_url: 'ftp://example.com/x' })).ok, false);
  assert.equal(validateNoteExtraction(validInput({ source_url: 'javascript:alert(1)' })).ok, false);
});

test('extraction_confidence outside 0..1 or non-finite is rejected', () => {
  assert.equal(validateNoteExtraction(validInput({ extracted_features: [validFeature({ extraction_confidence: 1.5 })] })).ok, false);
  assert.equal(validateNoteExtraction(validInput({ extracted_features: [validFeature({ extraction_confidence: -0.1 })] })).ok, false);
  assert.equal(validateNoteExtraction(validInput({ extracted_features: [validFeature({ extraction_confidence: 'high' })] })).ok, false);
});

test('raw_note_text and runner_name are required', () => {
  const noText = validateNoteExtraction(validInput({ raw_note_text: '' }));
  assert.equal(noText.ok, false);
  assert.ok(noText.errors.some((e) => /raw_note_text/.test(e.path)));

  const noName = validateNoteExtraction(validInput({ extracted_features: [validFeature({ runner_name: '' })] }));
  assert.equal(noName.ok, false);
  assert.ok(noName.errors.some((e) => /runner_name/.test(e.path)));
});

/* ---------------------------- review status ------------------------------- */

test('review_status defaults to pending when omitted', () => {
  const feature = validFeature();
  delete feature.review_status;
  const r = validateNoteExtraction(validInput({ extracted_features: [feature] }));
  assert.equal(r.ok, true);
  assert.equal(r.normalized!.extracted_features[0].review_status, 'pending');
  assert.equal(DEFAULT_REVIEW_STATUS, 'pending');
});

test('an invalid review_status is rejected', () => {
  assert.equal(
    validateNoteExtraction(validInput({ extracted_features: [validFeature({ review_status: 'maybe' })] })).ok,
    false,
  );
});

/* ------------------------------- helpers ---------------------------------- */

test('isHttpUrl: only http/https', () => {
  assert.equal(isHttpUrl('https://x.com'), true);
  assert.equal(isHttpUrl('http://x.com'), true);
  assert.equal(isHttpUrl('ftp://x.com'), false);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('not a url'), false);
});

test('classifyForbiddenKey: flags winner / probability / staking patterns', () => {
  assert.equal(classifyForbiddenKey('winner_prediction'), 'winner_prediction');
  assert.equal(classifyForbiddenKey('predicted_winner'), 'winner_prediction');
  assert.equal(classifyForbiddenKey('win_probability'), 'probability');
  assert.equal(classifyForbiddenKey('model_prob'), 'probability');
  assert.equal(classifyForbiddenKey('odds'), 'probability');
  assert.equal(classifyForbiddenKey('stake_amount'), 'staking');
  assert.equal(classifyForbiddenKey('kelly_fraction'), 'staking');
  assert.equal(classifyForbiddenKey('concern_flags'), null);
  assert.equal(classifyForbiddenKey('ground_signal'), null);
});

test('parseExtractNotesArgs: input/output/json paths; blanks ignored', () => {
  const a = parseExtractNotesArgs(['--input', 'in.json', '--output', 'out.md', '--json', 'norm.json']);
  assert.equal(a.input, 'in.json');
  assert.equal(a.output, 'out.md');
  assert.equal(a.jsonOut, 'norm.json');
  assert.equal(parseExtractNotesArgs(['--input', '   ']).input, undefined);
});

/* ----------------------------- markdown render ---------------------------- */

test('rendered Markdown is deterministic and shadow-labelled', () => {
  const r = validateNoteExtraction(validInput());
  const md1 = renderNoteExtractionMarkdown(r.normalized!);
  const md2 = renderNoteExtractionMarkdown(r.normalized!);
  assert.equal(md1, md2);
  assert.match(md1, /SHADOW \u2014 not model-active/);
  assert.match(md1, /model_active: false/);
  assert.match(md1, /predict winners/);
});

test('render: missing values show as em dash / unknown, never fabricated', () => {
  const minimal = { runner_name: 'X', extraction_confidence: 0.5, evidence: [], model_active: false };
  const r = validateNoteExtraction(
    validInput({ source_document_id: undefined, course: undefined, off_time: undefined, source_url: undefined, extracted_features: [minimal] }),
  );
  assert.equal(r.ok, true);
  const md = renderNoteExtractionMarkdown(r.normalized!);
  assert.match(md, /source_document_id: \u2014/);
  assert.match(md, /off_time: \u2014/);
  assert.match(md, /ground_signal: unknown/);
  assert.match(md, /concern_flags: \u2014/);
});

/* ----------------------- read-only / no-API guards ------------------------ */

test('no DB writes / no external API: the CLI makes no Supabase or network calls', () => {
  const cli = readFileSync('scripts/extractNotes.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(cli), false);
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(cli), false);
  assert.equal(/\bfetch\s*\(|axios|createRacingApiClient|getResults|BetfairClient/.test(cli), false);
});

test('no DB / no network / no env: the pure module is self-contained', () => {
  const lib = readFileSync('src/lib/noteFeatureExtraction.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs/.test(lib), false);
  assert.equal(/\bfetch\s*\(|process\.env/.test(lib), false);
});

/* ------------------------------ prompt template --------------------------- */

test('the prompt template states the extraction-only / no-winner-prediction rules', () => {
  const prompt = readFileSync('prompts/genai-note-extraction.md', 'utf8');
  assert.match(prompt, /never predict the winner/i);
  assert.match(prompt, /Extract structured features only/i);
  assert.match(prompt, /Preserve unknowns/i);
  assert.match(prompt, /evidence/i);
  assert.match(prompt, /Strict JSON only/i);
  assert.match(prompt, /Never invent missing facts/i);
  assert.match(prompt, /No betting advice/i);
  assert.match(prompt, /`model_active` is always `false`/i);
});
