/**
 * Unit tests for the pure helpers in the Racing API results-access probe
 * (scripts/probeRacingApiResultsAccess.ts).
 *
 * No DB, no network: importing the script does NOT run its `main()` (it is
 * guarded by an `import.meta.url` entry-point check), so these exercise only the
 * pure arg parsing, date validation, error categorisation, and result counting.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseProbeArgs,
  isValidIsoDate,
  categorizeResultsAccessError,
  countResults,
} from './probeRacingApiResultsAccess';

// ---------------------------------------------------------------------------
// parseProbeArgs
// ---------------------------------------------------------------------------

test('parseProbeArgs: reads --date and --region, splitting/normalising regions', () => {
  const args = parseProbeArgs(['--date', '2026-06-16', '--region', 'GB, ire ,gb']);
  assert.equal(args.date, '2026-06-16');
  // Lower-cased, trimmed, de-duplicated, order preserved.
  assert.deepEqual(args.regions, ['gb', 'ire']);
});

test('parseProbeArgs: defaults regions to gb,ire when --region is absent', () => {
  const args = parseProbeArgs(['--date', '2026-06-16']);
  assert.deepEqual(args.regions, ['gb', 'ire']);
});

test('parseProbeArgs: empty/whitespace --region falls back to the default', () => {
  const args = parseProbeArgs(['--date', '2026-06-16', '--region', '  ,  ']);
  assert.deepEqual(args.regions, ['gb', 'ire']);
});

test('parseProbeArgs: missing --date stays undefined (caller validates)', () => {
  const args = parseProbeArgs(['--region', 'gb']);
  assert.equal(args.date, undefined);
  assert.deepEqual(args.regions, ['gb']);
});

// ---------------------------------------------------------------------------
// isValidIsoDate
// ---------------------------------------------------------------------------

test('isValidIsoDate: accepts a real calendar date', () => {
  assert.equal(isValidIsoDate('2026-06-16'), true);
  assert.equal(isValidIsoDate('2026-02-28'), true);
});

test('isValidIsoDate: rejects wrong shapes and impossible dates', () => {
  assert.equal(isValidIsoDate('2026-6-16'), false); // not zero-padded
  assert.equal(isValidIsoDate('16-06-2026'), false); // wrong order
  assert.equal(isValidIsoDate('2026-13-01'), false); // month 13
  assert.equal(isValidIsoDate('2026-02-30'), false); // Feb 30 rolls over
  assert.equal(isValidIsoDate('not-a-date'), false);
  assert.equal(isValidIsoDate(''), false);
  assert.equal(isValidIsoDate(undefined), false);
  assert.equal(isValidIsoDate(null), false);
});

// ---------------------------------------------------------------------------
// categorizeResultsAccessError
// ---------------------------------------------------------------------------

test('categorizeResultsAccessError: detects "Standard Plan required" first', () => {
  // A real plan block arrives as a 401 whose body carries the plan message.
  const err = new Error(
    'Racing API 401 Unauthorized for /results — check ... {"detail":"Standard Plan required"}',
  );
  const info = categorizeResultsAccessError(err);
  assert.equal(info.category, 'standard_plan_required');
  assert.match(info.hint, /Standard Plan/i);
  assert.match(info.hint, /BLOCKER/);
});

test('categorizeResultsAccessError: missing env var -> missing_credentials', () => {
  const info = categorizeResultsAccessError(
    new Error('Missing environment variable: RACING_API_USER'),
  );
  assert.equal(info.category, 'missing_credentials');
});

test('categorizeResultsAccessError: a plain 401 -> unauthorized', () => {
  const info = categorizeResultsAccessError(
    new Error('Racing API 401 Unauthorized for /results — {"error":"bad key"}'),
  );
  assert.equal(info.category, 'unauthorized');
});

test('categorizeResultsAccessError: a 429 -> rate_limited', () => {
  const info = categorizeResultsAccessError(
    new Error('Racing API 429 rate-limited for /results — slow down'),
  );
  assert.equal(info.category, 'rate_limited');
});

test('categorizeResultsAccessError: anything else -> other', () => {
  assert.equal(categorizeResultsAccessError(new Error('fetch failed')).category, 'other');
  assert.equal(categorizeResultsAccessError('weird string').category, 'other');
  assert.equal(categorizeResultsAccessError(null).category, 'other');
});

// ---------------------------------------------------------------------------
// countResults
// ---------------------------------------------------------------------------

test('countResults: counts an array, null-safe for missing/empty', () => {
  assert.equal(countResults({ results: [{}, {}, {}] }), 3);
  assert.equal(countResults({ results: [] }), 0);
  assert.equal(countResults({ results: null }), 0);
  assert.equal(countResults({}), 0);
  assert.equal(countResults(null), 0);
  assert.equal(countResults(undefined), 0);
});
