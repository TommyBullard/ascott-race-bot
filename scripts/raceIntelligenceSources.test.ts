/**
 * Unit tests for the LOCAL / MANUAL Race Intelligence source scaffold
 * (src/lib/raceIntelligenceSources.ts) plus read-only source-scan guards on the
 * pure module + CLI.
 *
 * The validation + render are pure and deterministic, so no DB / network / files
 * are needed (beyond reading the checked-in fixture + sources for the scans). The
 * scans lock down the task's rules: this scaffold never calls GenAI/external
 * APIs, never scrapes, never writes the DB, never exposes `--commit`, and never
 * predicts a winner. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EXCERPT_MAX_CHARS,
  LONG_NOTE_WARN_CHARS,
  KNOWN_LICENCE_STATUSES,
  isHttpUrl,
  detectCopyrightMarkers,
  coerceNotes,
  assessRaceIntelligenceSource,
  renderRaceIntelligencePreview,
} from '../src/lib/raceIntelligenceSources';

/** Em dash used by the module for missing values. */
const DASH = '\u2014';

/** A valid baseline source document; override only what a test needs. */
function baseSource(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_document_id: 'doc-1',
    source_type: 'operator_observation',
    source_label: 'Operator notes',
    source_url: 'https://example.com/x',
    licence_status: 'manual',
    retrieved_at: '2026-06-17T09:00:00Z',
    race_date: '2026-06-17',
    course: 'Ascot',
    race_name: 'Queen Mary Stakes',
    raw_note_text: 'Synthetic short note. Ground easy after overnight rain.',
    notes: [{ topic: 'going', text: 'Ground easy.' }, 'Strong pace likely.'],
    ...over,
  };
}

/* ------------------------------ valid input ------------------------------- */

test('a valid manual source passes and is ready for extraction', () => {
  const a = assessRaceIntelligenceSource(baseSource());
  assert.deepEqual(a.errors, []);
  assert.equal(a.licence_policy, 'accepted');
  assert.equal(a.readyForExtraction, true);
  assert.equal(a.course, 'Ascot');
});

test('manual / public_allowed / licensed are all accepted', () => {
  for (const lic of ['manual', 'public_allowed', 'licensed']) {
    const a = assessRaceIntelligenceSource(baseSource({ licence_status: lic }));
    assert.equal(a.licence_policy, 'accepted', lic);
    assert.equal(a.readyForExtraction, true, lic);
  }
});

/* ------------------------------- licence ---------------------------------- */

test('unknown licence is flagged (warning) and fails safe (not ready)', () => {
  const a = assessRaceIntelligenceSource(baseSource({ licence_status: 'unknown' }));
  assert.equal(a.licence_policy, 'flagged');
  assert.equal(a.readyForExtraction, false);
  assert.deepEqual(a.errors, []); // soft flag, not a hard error
  assert.ok(a.warnings.some((w) => /unknown/i.test(w)));
});

test('an unsupported licence value is rejected as a hard error', () => {
  for (const lic of ['scraped', 'paywalled', 'pirated', '']) {
    const a = assessRaceIntelligenceSource(baseSource({ licence_status: lic }));
    assert.equal(a.licence_policy, 'unsupported', lic);
    assert.equal(a.readyForExtraction, false, lic);
    assert.ok(a.errors.some((e) => /licence_status/i.test(e)), lic);
  }
});

/* -------------------------------- source url ------------------------------ */

test('isHttpUrl accepts http(s) and rejects everything else', () => {
  assert.equal(isHttpUrl('http://x.com'), true);
  assert.equal(isHttpUrl('https://x.com/path?q=1'), true);
  assert.equal(isHttpUrl('ftp://x.com'), false);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('file:///etc/passwd'), false);
  assert.equal(isHttpUrl('x.com'), false);
  assert.equal(isHttpUrl('/relative'), false);
});

test('a non-http(s) source_url is rejected', () => {
  for (const url of ['ftp://x.com', 'javascript:alert(1)', 'notaurl', 'file:///etc']) {
    const a = assessRaceIntelligenceSource(baseSource({ source_url: url }));
    assert.ok(a.errors.some((e) => /source_url/i.test(e)), url);
    assert.equal(a.readyForExtraction, false, url);
  }
});

test('a valid http(s) source_url is kept', () => {
  for (const url of ['http://x.com', 'https://x.com/path?q=1']) {
    const a = assessRaceIntelligenceSource(baseSource({ source_url: url }));
    assert.equal(a.source_url, url);
    assert.ok(!a.errors.some((e) => /source_url/i.test(e)));
  }
});

/* ----------------------------- required fields ---------------------------- */

test('missing raw_note_text is rejected', () => {
  for (const v of ['', '   ', undefined]) {
    const a = assessRaceIntelligenceSource(baseSource({ raw_note_text: v }));
    assert.ok(a.errors.some((e) => /raw_note_text/i.test(e)));
    assert.equal(a.readyForExtraction, false);
  }
});

test('missing core required fields are rejected', () => {
  for (const field of ['source_document_id', 'source_label', 'race_date', 'course']) {
    const a = assessRaceIntelligenceSource(baseSource({ [field]: '' }));
    assert.ok(a.errors.some((e) => e.toLowerCase().includes(field)), field);
    assert.equal(a.readyForExtraction, false, field);
  }
});

test('non-object input is handled safely (no throw, hard error)', () => {
  for (const bad of [null, undefined, 'a string', 42, []]) {
    const a = assessRaceIntelligenceSource(bad);
    assert.ok(a.errors.length > 0);
    assert.equal(a.readyForExtraction, false);
  }
});

/* --------------------------- copyright / excerpts ------------------------- */

test('copyright / paywall markers reject the document', () => {
  for (const marker of [
    '\u00a9 2026 Acme Media',
    'All Rights Reserved',
    'this text is copyright Acme',
    'Subscribe to read the rest of this article',
    'content behind a paywall',
  ]) {
    const a = assessRaceIntelligenceSource(baseSource({ raw_note_text: `Note ${marker}` }));
    assert.ok(a.errors.some((e) => /copyright|paywall/i.test(e)), marker);
    assert.equal(a.readyForExtraction, false, marker);
  }
});

test('detectCopyrightMarkers returns the markers it finds (and none otherwise)', () => {
  assert.deepEqual(detectCopyrightMarkers('a clean original note'), []);
  assert.ok(detectCopyrightMarkers('All Rights Reserved here').length > 0);
});

test('a long raw_note_text warns and is echoed as a truncated excerpt only', () => {
  const longNote = `UNIQUEHEAD ${'y'.repeat(LONG_NOTE_WARN_CHARS + 500)}`;
  const a = assessRaceIntelligenceSource(baseSource({ raw_note_text: longNote }));
  assert.ok(a.warnings.some((w) => /long/i.test(w)));
  assert.ok((a.raw_note_excerpt ?? '').length <= EXCERPT_MAX_CHARS + 1); // +1 for ellipsis
  assert.ok((a.raw_note_excerpt ?? '').endsWith('\u2026'));
  // The preview never reproduces the full note (excerpt only).
  const md = renderRaceIntelligencePreview(a);
  assert.equal(md.includes('y'.repeat(EXCERPT_MAX_CHARS + 50)), false);
});

/* -------------------------------- notes ----------------------------------- */

test('coerceNotes handles strings + objects and drops junk', () => {
  const notes = coerceNotes([
    'plain string',
    { topic: 'going', text: 'object note' },
    { note: 'alt key note' },
    { reference: 'reference key note' },
    42,
    null,
    {},
  ]);
  assert.equal(notes.length, 4);
  assert.equal(notes[0].reference, 'plain string');
  assert.equal(notes[0].topic, null);
  assert.equal(notes[1].topic, 'going');
  assert.equal(notes[1].reference, 'object note');
});

/* ------------------------------ date format ------------------------------- */

test('a non-YYYY-MM-DD race_date warns but does not hard-reject', () => {
  const a = assessRaceIntelligenceSource(baseSource({ race_date: '17/06/2026' }));
  assert.ok(a.warnings.some((w) => /YYYY-MM-DD/.test(w)));
  assert.ok(!a.errors.some((e) => /race_date/i.test(e)));
  assert.equal(a.readyForExtraction, true);
});

/* ------------------------------- rendering -------------------------------- */

test('renderRaceIntelligencePreview is deterministic', () => {
  const a = assessRaceIntelligenceSource(baseSource());
  const b = assessRaceIntelligenceSource(baseSource());
  assert.equal(renderRaceIntelligencePreview(a), renderRaceIntelligencePreview(b));
  assert.equal(renderRaceIntelligencePreview(a), renderRaceIntelligencePreview(a));
});

test('missing optional values render as the em dash', () => {
  const a = assessRaceIntelligenceSource({
    source_document_id: 'd',
    source_label: 'l',
    licence_status: 'manual',
    race_date: '2026-06-17',
    course: 'Ascot',
    raw_note_text: 'note',
  });
  const md = renderRaceIntelligencePreview(a);
  assert.match(md, new RegExp(`URL: ${DASH}`));
  assert.match(md, new RegExp(`Retrieved at: ${DASH}`));
  assert.match(md, new RegExp(`Race: ${DASH}`));
});

test('the preview is shadow-only and makes no winner prediction', () => {
  const md = renderRaceIntelligencePreview(assessRaceIntelligenceSource(baseSource()));
  assert.match(md, /shadow-only/i);
  assert.match(md, /not betting advice/i);
  // No affirmative prediction language.
  assert.equal(
    /\bwill win\b|\bpredicted winner\b|\bwinning selection\b|\bwe predict\b|\bback\b.{0,20}\bto win\b/i.test(md),
    false,
  );
});

/* ------------------------------- the fixture ------------------------------ */

test('the checked-in example fixture is valid and ready', () => {
  const fixture = JSON.parse(
    readFileSync('data/race-intelligence/example-source-notes.json', 'utf8'),
  );
  const a = assessRaceIntelligenceSource(fixture);
  assert.deepEqual(a.errors, []);
  assert.equal(a.readyForExtraction, true);
  assert.equal(a.course, 'Ascot');
  assert.ok(a.notes.length > 0);
  assert.deepEqual([...KNOWN_LICENCE_STATUSES].sort(), ['licensed', 'manual', 'public_allowed', 'unknown']);
});

/* --------------------- read-only guards (source scans) -------------------- */

test('the source module is inert: no DB, fs, env, network, scraping, or GenAI', () => {
  const lib = readFileSync('src/lib/raceIntelligenceSources.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs|require\(['"]fs/.test(lib), false);
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/\bfetch\s*\(/.test(lib), false);
  assert.equal(/cheerio|puppeteer|playwright|jsdom|axios/i.test(lib), false);
  assert.equal(/openai|anthropic|generativelanguage|@google\/genai/i.test(lib), false);
});

test('the CLI is local-file only: no DB, network, scraping, GenAI, or --commit', () => {
  const cli = readFileSync('scripts/prepareRaceIntelligence.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(cli), false);
  assert.equal(/\bfetch\s*\(/.test(cli), false);
  assert.equal(/--commit/.test(cli), false);
  assert.equal(/cheerio|puppeteer|playwright|jsdom|axios/i.test(cli), false);
  assert.equal(/openai|anthropic|generativelanguage|@google\/genai/i.test(cli), false);
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(cli), false);
  // Reads/writes local files only.
  assert.match(cli, /from 'node:fs'/);
});
