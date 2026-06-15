/**
 * Unit tests for the shared data-quality utilities (src/lib/dataQualityUtils.ts).
 *
 * Batch G1 consolidation: a single `isFiniteNumber` helper and a single
 * canonical `FLAG_LABEL` map. These tests lock down the helper's behaviour and
 * that every known flag has a (defined, non-empty) label. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isFiniteNumber, FLAG_LABEL } from '../src/lib/dataQualityUtils';
import { DATA_QUALITY_FLAG } from '../src/lib/modelDataQuality';

test('isFiniteNumber: true for finite numbers', () => {
  assert.equal(isFiniteNumber(0), true);
  assert.equal(isFiniteNumber(1.5), true);
  assert.equal(isFiniteNumber(-3), true);
  assert.equal(isFiniteNumber(1e10), true);
});

test('isFiniteNumber: false for NaN / Infinity', () => {
  assert.equal(isFiniteNumber(Number.NaN), false);
  assert.equal(isFiniteNumber(Number.POSITIVE_INFINITY), false);
  assert.equal(isFiniteNumber(Number.NEGATIVE_INFINITY), false);
});

test('isFiniteNumber: false for null / undefined', () => {
  assert.equal(isFiniteNumber(null), false);
  assert.equal(isFiniteNumber(undefined), false);
});

test('isFiniteNumber: false for strings and other types', () => {
  assert.equal(isFiniteNumber('5'), false);
  assert.equal(isFiniteNumber(''), false);
  assert.equal(isFiniteNumber({}), false);
  assert.equal(isFiniteNumber([]), false);
  assert.equal(isFiniteNumber(true), false);
});

test('FLAG_LABEL: every DATA_QUALITY_FLAG key has a non-empty label', () => {
  for (const flag of Object.values(DATA_QUALITY_FLAG)) {
    const label = FLAG_LABEL[flag];
    assert.equal(typeof label, 'string', `label for ${flag} is a string`);
    assert.ok(label.length > 0, `label for ${flag} is non-empty`);
  }
});

test('FLAG_LABEL: canonical STALE_ODDS wording is "Stale odds"', () => {
  assert.equal(FLAG_LABEL[DATA_QUALITY_FLAG.STALE_ODDS], 'Stale odds');
});

test('FLAG_LABEL: no labels beyond the known flags', () => {
  const known = new Set<string>(Object.values(DATA_QUALITY_FLAG));
  for (const key of Object.keys(FLAG_LABEL)) {
    assert.ok(known.has(key), `FLAG_LABEL key ${key} is a known flag`);
  }
});
