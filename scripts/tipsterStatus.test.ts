/**
 * Unit tests for the pure tipster-status copy helper
 * (src/lib/tipsterStatus.ts).
 *
 * No DB, no network: these assert the plain-language lines the dashboard shows
 * for the current tipster state across the no-selections / has-selections /
 * pending-candidates / tables-absent cases, and that the helper never mutates
 * its input. The helper only formats server-provided counts — it computes no
 * model value. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTipsterStatusLines,
  type TipsterStatusSummary,
} from '../src/lib/tipsterStatus';

/** A summary with sensible all-zero defaults. */
function summary(overrides: Partial<TipsterStatusSummary> = {}): TipsterStatusSummary {
  return {
    approvedSelections: 0,
    candidatesPending: 0,
    candidatesApproved: 0,
    candidatesRejected: 0,
    ...overrides,
  };
}

test('no approved selections -> market-only line + no-consensus clarifier', () => {
  const lines = buildTipsterStatusLines(summary({ approvedSelections: 0 }));
  assert.ok(lines.some((l) => l.includes('market-only')));
  assert.ok(lines.some((l) => l.includes('No approved tipster selections')));
  assert.ok(lines.some((l) => l.includes('No tipster consensus')));
});

test('pending candidates -> "not model-active until approved" line', () => {
  const lines = buildTipsterStatusLines(summary({ candidatesPending: 3 }));
  assert.ok(
    lines.some(
      (l) => l.includes('3 candidate tips pending review') && l.includes('NOT model-active'),
    ),
  );
});

test('singular candidate is pluralised correctly', () => {
  const lines = buildTipsterStatusLines(summary({ candidatesPending: 1 }));
  assert.ok(lines.some((l) => l.includes('1 candidate tip pending review')));
  assert.equal(lines.some((l) => l.includes('1 candidate tips')), false);
});

test('zero pending candidates -> "No candidate tips are pending review."', () => {
  const lines = buildTipsterStatusLines(summary({ candidatesPending: 0 }));
  assert.ok(lines.some((l) => l.includes('No candidate tips are pending review')));
});

test('approved selections present -> "feeding the model", no market-only/clarifier', () => {
  const lines = buildTipsterStatusLines(
    summary({ approvedSelections: 5, candidatesPending: 0 }),
  );
  assert.ok(lines.some((l) => l.includes('5 approved tipster selections feeding the model')));
  assert.equal(lines.some((l) => l.includes('market-only')), false);
  assert.equal(lines.some((l) => l.includes('No tipster consensus')), false);
});

test('one approved selection is singular', () => {
  const lines = buildTipsterStatusLines(summary({ approvedSelections: 1 }));
  assert.ok(lines.some((l) => l.includes('1 approved tipster selection feeding the model')));
  assert.equal(lines.some((l) => l.includes('1 approved tipster selections')), false);
});

test('candidate table absent (null) -> no candidate line, still explains market-only', () => {
  const lines = buildTipsterStatusLines({
    approvedSelections: 0,
    candidatesPending: null,
    candidatesApproved: null,
    candidatesRejected: null,
  });
  assert.ok(lines.some((l) => l.includes('market-only')));
  // No candidate line when the count is unavailable.
  assert.equal(lines.some((l) => l.includes('candidate tip')), false);
});

test('selections table absent (null) -> market-only setup line, no crash', () => {
  const lines = buildTipsterStatusLines({
    approvedSelections: null,
    candidatesPending: null,
    candidatesApproved: null,
    candidatesRejected: null,
  });
  assert.ok(lines.length >= 1);
  assert.ok(lines.some((l) => l.includes('market-only')));
  // With approvedSelections null we do NOT assert the zero-specific clarifier.
  assert.equal(lines.some((l) => l.includes('No tipster consensus')), false);
});

test('does not mutate its input', () => {
  const input = summary({ approvedSelections: 2, candidatesPending: 4 });
  const snapshot = JSON.stringify(input);
  buildTipsterStatusLines(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('always returns at least the model-mode line', () => {
  for (const approved of [null, 0, 1, 99]) {
    const lines = buildTipsterStatusLines(
      summary({ approvedSelections: approved as number | null }),
    );
    assert.ok(lines.length >= 1);
  }
});
