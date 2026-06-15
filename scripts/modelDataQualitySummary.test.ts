/**
 * Unit tests for the read-only data-quality summary builder
 * (src/lib/modelDataQualitySummary.ts).
 *
 * No DB or network: synthetic inputs. These lock down the human-readable lines,
 * metric formatting (minutes 1dp, completeness 2dp), the confidence-change and
 * suppression lines, stable de-duplicated ordering, safe omission of missing
 * metrics (no fabrication), and the one-line short summary. Pure — inputs are
 * never mutated. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDataQualitySummary,
  type DataQualitySummaryMetrics,
} from '../src/lib/modelDataQualitySummary';

const OK_ICON = '\u2705';
const WARN_ICON = '\u26A0';
const INFO_ICON = '\u2139';
const SUPPRESS_ICON = '\u{1F6D1}';
const CONF_ICON = '\u{1F4C9}';

function metrics(
  over: Partial<DataQualitySummaryMetrics> = {},
): DataQualitySummaryMetrics {
  return {
    market_completeness: null,
    priced_runner_count: 0,
    declared_runner_count: null,
    odds_age_ms: null,
    ...over,
  };
}

const noAdjust = {
  suppressStaking: false,
  reduceConfidence: false,
  notes: [],
};

test('clean input -> "✅ Data quality: OK" only', () => {
  const r = buildDataQualitySummary([], metrics(), 'OK');
  assert.deepEqual(r.summary, [`${OK_ICON} Data quality: OK`]);
  assert.equal(r.short_summary, 'OK');
  assert.equal(r.run_quality, 'OK');
});

test('LOW_MARKET_COMPLETENESS -> completeness formatted to 2dp', () => {
  const r = buildDataQualitySummary(
    ['LOW_MARKET_COMPLETENESS'],
    metrics({ market_completeness: 0.72, declared_runner_count: 10, priced_runner_count: 7 }),
    'DEGRADED',
  );
  assert.deepEqual(r.summary, [
    `${WARN_ICON} Data quality: DEGRADED`,
    `${WARN_ICON} Low market completeness (0.72)`,
  ]);
});

test('STALE_ODDS -> odds age formatted to minutes (1dp)', () => {
  const r = buildDataQualitySummary(
    ['STALE_ODDS'],
    metrics({ odds_age_ms: 738_000 }), // 12.3 min
    'STALE',
  );
  assert.deepEqual(r.summary, [
    `${WARN_ICON} Data quality: STALE`,
    `${WARN_ICON} Stale odds (12.3 min old)`,
  ]);
});

test('info flag uses the info marker', () => {
  const r = buildDataQualitySummary(['NO_TIPSTER_SELECTIONS'], metrics(), 'OK');
  assert.deepEqual(r.summary, [
    `${OK_ICON} Data quality: OK`,
    `${INFO_ICON} No tipster selections`,
  ]);
});

test('multiple flags -> stable order, de-duplicated', () => {
  const r = buildDataQualitySummary(
    [
      'LOW_MARKET_COMPLETENESS',
      'STALE_ODDS',
      'LOW_MARKET_COMPLETENESS', // duplicate
      'NO_TIPSTER_SELECTIONS',
    ],
    metrics({
      market_completeness: 0.5,
      odds_age_ms: 600_000,
      declared_runner_count: 8,
      priced_runner_count: 4,
    }),
    'DEGRADED',
  );
  assert.deepEqual(r.summary, [
    `${WARN_ICON} Data quality: DEGRADED`,
    `${WARN_ICON} Low market completeness (0.50)`,
    `${WARN_ICON} Stale odds (10.0 min old)`,
    `${INFO_ICON} No tipster selections`,
  ]);
});

test('missing metrics -> detail omitted safely (no fabrication)', () => {
  const r = buildDataQualitySummary(
    ['LOW_MARKET_COMPLETENESS', 'STALE_ODDS'],
    metrics(), // all null
    'DEGRADED',
  );
  assert.deepEqual(r.summary, [
    `${WARN_ICON} Data quality: DEGRADED`,
    `${WARN_ICON} Low market completeness`,
    `${WARN_ICON} Stale odds`,
  ]);
});

test('confidence change -> shows base → adjusted (2dp), only when they differ', () => {
  const changed = buildDataQualitySummary(
    [],
    metrics(),
    'OK',
    0.64, // adjusted
    0.78, // base
    noAdjust,
  );
  assert.ok(
    changed.summary.includes(`${CONF_ICON} Confidence adjusted: 0.78 \u2192 0.64`),
  );

  // Equal base/adjusted -> no confidence line.
  const same = buildDataQualitySummary([], metrics(), 'OK', 0.8, 0.8, noAdjust);
  assert.ok(!same.summary.some((l) => l.startsWith(CONF_ICON)));

  // Missing one value -> no confidence line (no fabrication).
  const missing = buildDataQualitySummary([], metrics(), 'OK', 0.64, undefined);
  assert.ok(!missing.summary.some((l) => l.startsWith(CONF_ICON)));
});

test('suppressStaking -> includes a suppression message with reason', () => {
  const r = buildDataQualitySummary(
    ['LOW_MARKET_COMPLETENESS'],
    metrics({ market_completeness: 0.4, declared_runner_count: 10, priced_runner_count: 4 }),
    'DEGRADED',
    undefined,
    undefined,
    { suppressStaking: true, reduceConfidence: false, notes: [] },
  );
  assert.ok(
    r.summary.includes(
      `${SUPPRESS_ICON} Staking suppressed due to low market completeness`,
    ),
  );

  // No-priced-runners reason.
  const noPriced = buildDataQualitySummary(
    ['NO_PRICED_RUNNERS'],
    metrics({ priced_runner_count: 0, declared_runner_count: 8 }),
    'INVALID',
    undefined,
    undefined,
    { suppressStaking: true, reduceConfidence: false, notes: [] },
  );
  assert.ok(
    noPriced.summary.includes(
      `${SUPPRESS_ICON} Staking suppressed due to no priced runners`,
    ),
  );
});

test('short_summary summarises the verdict + top issues', () => {
  const r = buildDataQualitySummary(
    ['LOW_MARKET_COMPLETENESS', 'STALE_ODDS'],
    metrics({ market_completeness: 0.72, odds_age_ms: 600_000 }),
    'DEGRADED',
  );
  assert.equal(
    r.short_summary,
    'DEGRADED \u2014 Low market completeness (0.72), Stale odds (10.0 min old)',
  );
});

test('empty edge case -> safe output; inputs are not mutated', () => {
  const flags: string[] = [];
  const m = metrics();
  const r = buildDataQualitySummary(flags, m, 'OK');
  assert.deepEqual(r.summary, [`${OK_ICON} Data quality: OK`]);
  assert.equal(r.short_summary, 'OK');
  // No mutation of the caller's inputs.
  assert.deepEqual(flags, []);
  assert.deepEqual(m, metrics());
});
