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
    matchedToday: null,
    scopeLabel: null,
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
      (l) => l.includes('3 candidate opinions pending review') && l.includes('NOT model-active'),
    ),
  );
});

test('singular candidate is pluralised correctly', () => {
  const lines = buildTipsterStatusLines(summary({ candidatesPending: 1 }));
  assert.ok(lines.some((l) => l.includes('1 candidate opinion pending review')));
  assert.equal(lines.some((l) => l.includes('1 candidate opinions')), false);
});

test('zero pending candidates -> "No candidate opinions are pending review."', () => {
  const lines = buildTipsterStatusLines(summary({ candidatesPending: 0 }));
  assert.ok(lines.some((l) => l.includes('No candidate opinions are pending review')));
});

test('approved on record but matchedToday unknown -> "on record (across all dates)"', () => {
  const lines = buildTipsterStatusLines(
    summary({ approvedSelections: 5, matchedToday: null, candidatesPending: 0 }),
  );
  assert.ok(lines.some((l) => l.includes('5 approved tipster selections on record (across all dates)')));
  assert.equal(lines.some((l) => l.includes('feeding the model.')), false);
});

test('stale historical selections are NOT counted as current-day support', () => {
  // 5 approved on record, but NONE matched to today's scope -> market-only today.
  const lines = buildTipsterStatusLines(
    summary({ approvedSelections: 5, matchedToday: 0, scopeLabel: 'Ascot 2026-06-19', candidatesPending: 0 }),
  );
  assert.ok(lines.some((l) => l.includes('NONE are matched to Ascot 2026-06-19')));
  assert.ok(lines.some((l) => l.includes('market-only')));
  assert.ok(lines.some((l) => l.includes('Historical selections do not feed other days')));
  assert.ok(lines.some((l) => l.includes('No tipster consensus')));
});

test('matched selections today -> "model-active for those races"', () => {
  const lines = buildTipsterStatusLines(
    summary({ approvedSelections: 7, matchedToday: 2, scopeLabel: 'Ascot 2026-06-19', candidatesPending: 0 }),
  );
  assert.ok(lines.some((l) => l.includes('2 tipster selections matched to Ascot 2026-06-19 and model-active')));
  assert.equal(lines.some((l) => l.includes('market-only')), false);
});

test('review-blocked (rejected) opinions surface a never-model-active line', () => {
  const lines = buildTipsterStatusLines(summary({ candidatesRejected: 4 }));
  assert.ok(lines.some((l) => l.includes('4 opinions review-blocked (rejected)')));
});

test('candidate table absent (null) -> no candidate line, still explains market-only', () => {
  const lines = buildTipsterStatusLines({
    approvedSelections: 0,
    matchedToday: null,
    scopeLabel: null,
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
    matchedToday: null,
    scopeLabel: null,
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
