/**
 * Unit tests for the LOCAL / MANUAL GenAI note-intake scaffold
 * (src/lib/genaiSourceReview.ts) plus read-only source-scan guards on the pure
 * module + CLI.
 *
 * The validation + render are pure and deterministic, so no DB / network / files
 * are needed (beyond reading the checked-in fixture + sources for the scans). The
 * scans lock down the task's rules: this intake never calls GenAI/external APIs,
 * never scrapes, never writes the DB, never exposes `--commit`, never touches the
 * model/staking/recommendation path, and never predicts a winner.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EXCERPT_MAX_CHARS,
  LONG_NOTE_WARN_CHARS,
  KNOWN_LICENCE_STATUSES,
  SUPPORTED_NOTE_SOURCE_TYPES,
  GENAI_SHADOW_REMINDER,
  isHttpUrl,
  detectCopyrightMarkers,
  coerceNotes,
  assessGenaiNoteSource,
  renderGenaiNotePreview,
} from '../src/lib/genaiSourceReview';

/** Em dash used by the module for missing values. */
const DASH = '\u2014';

/** A valid baseline note document; override only what a test needs. */
function baseSource(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_document_id: 'doc-1',
    source_type: 'operator_observation',
    source_label: 'Operator notes',
    source_url: 'https://example.com/x',
    licence_status: 'manual',
    retrieved_at: '2026-06-19T09:00:00Z',
    race_date: '2026-06-19',
    course: 'Ascot',
    race_name: 'Example Handicap',
    raw_note_text: 'Synthetic short note. Ground easy after overnight rain.',
    notes: [{ topic: 'going', text: 'Ground easy.' }, 'Strong pace likely.'],
    ...over,
  };
}

/* ------------------------------ valid input ------------------------------- */

test('a valid manual note source passes and is ready for extraction', () => {
  const a = assessGenaiNoteSource(baseSource());
  assert.deepEqual(a.errors, []);
  assert.equal(a.licence_policy, 'accepted');
  assert.equal(a.ready_for_extraction, true);
  assert.equal(a.course, 'Ascot');
  assert.equal(a.source_type, 'operator_observation');
});

test('manual / public_allowed / licensed are all accepted', () => {
  for (const lic of ['manual', 'public_allowed', 'licensed']) {
    const a = assessGenaiNoteSource(baseSource({ licence_status: lic }));
    assert.equal(a.licence_policy, 'accepted', lic);
    assert.equal(a.ready_for_extraction, true, lic);
  }
});

test('all four source_type values are recognised', () => {
  for (const t of ['manual_note', 'operator_observation', 'public_note', 'licensed_note']) {
    const a = assessGenaiNoteSource(baseSource({ source_type: t }));
    assert.equal(a.source_type, t, t);
    assert.ok(!a.warnings.some((w) => /source_type/i.test(w)), t);
  }
  assert.deepEqual(
    [...SUPPORTED_NOTE_SOURCE_TYPES].sort(),
    ['licensed_note', 'manual_note', 'operator_observation', 'public_note'],
  );
});

/* ------------------------------- licence ---------------------------------- */

test('unknown licence is flagged (warning) and fails safe (not ready)', () => {
  const a = assessGenaiNoteSource(baseSource({ licence_status: 'unknown' }));
  assert.equal(a.licence_policy, 'flagged');
  assert.equal(a.ready_for_extraction, false);
  assert.deepEqual(a.errors, []); // soft flag, not a hard error
  assert.ok(a.warnings.some((w) => /unknown/i.test(w)));
});

test('an unsupported / missing licence value is rejected as a hard error', () => {
  for (const lic of ['scraped', 'paywalled', 'pirated', '']) {
    const a = assessGenaiNoteSource(baseSource({ licence_status: lic }));
    assert.equal(a.licence_policy, 'unsupported', lic);
    assert.equal(a.ready_for_extraction, false, lic);
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

test('a non-http(s) source_url is rejected (unsupported URL format)', () => {
  for (const url of ['ftp://x.com', 'javascript:alert(1)', 'notaurl', 'file:///etc']) {
    const a = assessGenaiNoteSource(baseSource({ source_url: url }));
    assert.ok(a.errors.some((e) => /source_url/i.test(e)), url);
    assert.equal(a.ready_for_extraction, false, url);
  }
});

test('a valid http(s) source_url is kept; omitting it is fine', () => {
  for (const url of ['http://x.com', 'https://x.com/path?q=1']) {
    const a = assessGenaiNoteSource(baseSource({ source_url: url }));
    assert.equal(a.source_url, url);
    assert.ok(!a.errors.some((e) => /source_url/i.test(e)));
  }
  const noUrl = assessGenaiNoteSource(baseSource({ source_url: undefined }));
  assert.equal(noUrl.source_url, null);
  assert.equal(noUrl.ready_for_extraction, true);
});

/* ----------------------------- required fields ---------------------------- */

test('missing raw_note_text is rejected', () => {
  for (const v of ['', '   ', undefined]) {
    const a = assessGenaiNoteSource(baseSource({ raw_note_text: v }));
    assert.ok(a.errors.some((e) => /raw_note_text/i.test(e)));
    assert.equal(a.ready_for_extraction, false);
  }
});

test('missing core identity fields are rejected', () => {
  for (const field of ['source_document_id', 'source_label', 'race_date', 'course']) {
    const a = assessGenaiNoteSource(baseSource({ [field]: undefined }));
    assert.ok(a.errors.some((e) => e.includes(field)), field);
    assert.equal(a.ready_for_extraction, false, field);
  }
});

test('a non-object input is handled safely (no throw, hard error)', () => {
  for (const bad of [null, 42, 'a string', ['array'], true]) {
    const a = assessGenaiNoteSource(bad);
    assert.ok(a.errors.length > 0);
    assert.equal(a.ready_for_extraction, false);
  }
});

/* ------------------------- copyright / excerpt-only ----------------------- */

test('copyright / paywall markers in raw_note_text are rejected', () => {
  for (const marker of ['© 2026 The Paper', 'All Rights Reserved', 'subscribe to read', 'paywall']) {
    const a = assessGenaiNoteSource(baseSource({ raw_note_text: `Some note. ${marker}` }));
    assert.ok(a.errors.some((e) => /copyright|paywall/i.test(e)), marker);
    assert.equal(a.ready_for_extraction, false, marker);
  }
  assert.deepEqual(detectCopyrightMarkers('clean original note'), []);
  assert.ok(detectCopyrightMarkers('All rights reserved').length > 0);
});

test('a long note warns and is stored as a short excerpt only (never full text)', () => {
  const full = 'X'.repeat(LONG_NOTE_WARN_CHARS + 500);
  const a = assessGenaiNoteSource(baseSource({ raw_note_text: full }));
  assert.ok(a.warnings.some((w) => /long/i.test(w)));
  // The stored excerpt is truncated to the cap (+ ellipsis), never the full text.
  assert.ok((a.raw_note_excerpt ?? '').length <= EXCERPT_MAX_CHARS + 1);
  assert.notEqual(a.raw_note_excerpt, full);
  const md = renderGenaiNotePreview(a);
  assert.equal(md.includes(full), false); // the full article never reaches the preview
});

/* --------------------------------- notes ---------------------------------- */

test('coerceNotes accepts strings + {text|note|reference}, truncates, drops junk', () => {
  const notes = coerceNotes([
    'plain ref',
    { text: 'with topic', topic: 'going' },
    { note: 'from note key' },
    { reference: 'from reference key', label: 'pace' },
    { nope: 'ignored' },
    42,
    null,
  ]);
  assert.equal(notes.length, 4);
  assert.equal(notes[0].reference, 'plain ref');
  assert.equal(notes[1].topic, 'going');
  assert.equal(notes[3].topic, 'pace');
  assert.deepEqual(coerceNotes('not-an-array'), []);
});

/* --------------------------------- render --------------------------------- */

test('render is deterministic and contains all required sections', () => {
  const a = assessGenaiNoteSource(baseSource());
  const md1 = renderGenaiNotePreview(a);
  const md2 = renderGenaiNotePreview(a);
  assert.equal(md1, md2);
  for (const section of [
    '## Source summary',
    '## Licence / source policy',
    '## Race',
    '## Note excerpts (short only)',
    '## Readiness',
    '## Warnings',
  ]) {
    assert.ok(md1.includes(section), section);
  }
  assert.ok(md1.includes('Ready for extraction: Yes'));
  assert.ok(md1.trimEnd().endsWith(GENAI_SHADOW_REMINDER));
});

test('render uses the em dash for missing optional values', () => {
  const a = assessGenaiNoteSource(baseSource({ race_name: undefined, source_url: undefined, retrieved_at: undefined }));
  const md = renderGenaiNotePreview(a);
  assert.ok(md.includes(`- Race: ${DASH}`));
  assert.ok(md.includes(`- URL: ${DASH}`));
});

test('the shadow-only reminder is present and never reads as a prediction or bet', () => {
  const md = renderGenaiNotePreview(assessGenaiNoteSource(baseSource()));
  assert.match(md, /shadow-only/i);
  assert.match(md, /not betting advice/i);
  // No winner-prediction / bet-instruction phrasing in the rendered preview.
  assert.equal(
    /\bwill win\b|\bpredicted winner\b|\bwinning selection\b|\bwe predict\b|\bback\b.{0,20}\bto win\b/i.test(md),
    false,
  );
});

/* ------------------------------- the fixture ------------------------------ */

test('the checked-in example fixture is valid and ready', () => {
  const fixture = JSON.parse(readFileSync('data/race-notes/example.json', 'utf8'));
  const a = assessGenaiNoteSource(fixture);
  assert.deepEqual(a.errors, []);
  assert.equal(a.ready_for_extraction, true);
  assert.equal(a.course, 'Ascot');
  assert.ok(a.notes.length > 0);
  assert.deepEqual([...KNOWN_LICENCE_STATUSES].sort(), ['licensed', 'manual', 'public_allowed', 'unknown']);
});

/* --------------------- read-only guards (source scans) -------------------- */

test('the source module is inert: no DB, fs, env, network, scraping, or GenAI', () => {
  const lib = readFileSync('src/lib/genaiSourceReview.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs|require\(['"]fs/.test(lib), false);
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/\bfetch\s*\(/.test(lib), false);
  assert.equal(/cheerio|puppeteer|playwright|jsdom|axios/i.test(lib), false);
  assert.equal(/openai|anthropic|generativelanguage|@google\/genai/i.test(lib), false);
  // No model / staking / ranking / recommendation / bet-placement coupling.
  assert.equal(/bettingEngine|modelProbabilities|kellyStake|scoreRaceRunners/.test(lib), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/.test(lib), false);
});

test('the CLI is local-file only: no DB, network, scraping, GenAI, or --commit', () => {
  const cli = readFileSync('scripts/genaiPrepareNotes.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(cli), false);
  assert.equal(/\bfetch\s*\(/.test(cli), false);
  assert.equal(/--commit/.test(cli), false);
  assert.equal(/cheerio|puppeteer|playwright|jsdom|axios/i.test(cli), false);
  assert.equal(/openai|anthropic|generativelanguage|@google\/genai/i.test(cli), false);
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(cli), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/.test(cli), false);
  // Reads/writes local files only.
  assert.match(cli, /from 'node:fs'/);
});
