/**
 * Unit tests for the pure data-quality assessor (src/lib/modelDataQuality.ts).
 *
 * No DB or network: synthetic already-loaded inputs. These lock down which
 * flags fire (and only when their proving data is present), plus stable,
 * de-duplicated ordering. The assessor is the single source of
 * `model_runs.data_quality_flags`.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessDataQuality,
  evaluateRunQuality,
  determineModelAdjustments,
  formatDataQualitySummary,
  getFlagSeverity,
  DATA_QUALITY_FLAG,
  DEFAULT_FLAG_SEVERITY,
  ODDS_REFRESH_INTERVAL_MS,
  STALE_ODDS_THRESHOLD_MS,
  type DataQualityInput,
} from '../src/lib/modelDataQuality';

/** A complete, clean input that produces NO flags. Override per test. */
function cleanInput(over: Partial<DataQualityInput> = {}): DataQualityInput {
  return {
    declaredRunnerCount: 8,
    pricedRunnerIds: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'],
    hasMarketSnapshot: true,
    snapshotAgeMs: 0,
    tipsterSelectionRunnerIds: ['r1'], // matches a priced runner
    ...over,
  };
}

test('clean input -> no flags', () => {
  assert.deepEqual(assessDataQuality(cleanInput()).flags, []);
});

// (1)
test('no tipster selections -> NO_TIPSTER_SELECTIONS', () => {
  assert.deepEqual(
    assessDataQuality(cleanInput({ tipsterSelectionRunnerIds: [] })).flags,
    ['NO_TIPSTER_SELECTIONS'],
  );
});

// (2)
test('no market snapshot -> NO_MARKET_SNAPSHOT', () => {
  assert.deepEqual(
    assessDataQuality(cleanInput({ hasMarketSnapshot: false })).flags,
    ['NO_MARKET_SNAPSHOT'],
  );
});

// (3)
test('stale odds -> STALE_ODDS (only when age exceeds the threshold)', () => {
  assert.deepEqual(
    assessDataQuality(cleanInput({ snapshotAgeMs: STALE_ODDS_THRESHOLD_MS + 1 }))
      .flags,
    ['STALE_ODDS'],
  );
  // Exactly at the threshold is NOT stale.
  assert.deepEqual(
    assessDataQuality(cleanInput({ snapshotAgeMs: STALE_ODDS_THRESHOLD_MS })).flags,
    [],
  );
});

// STALE threshold is defined RELATIVE to the polling cadence.
test('STALE_ODDS threshold = 2 x ODDS_REFRESH_INTERVAL_MS (5 min default)', () => {
  assert.equal(ODDS_REFRESH_INTERVAL_MS, 300_000);
  assert.equal(STALE_ODDS_THRESHOLD_MS, 2 * ODDS_REFRESH_INTERVAL_MS);
  assert.equal(STALE_ODDS_THRESHOLD_MS, 600_000);
});

test('stale odds boundary: below interval no flag; one interval no flag; just over two intervals flags', () => {
  // Fresh / within a single refresh interval -> not stale.
  assert.deepEqual(
    assessDataQuality(cleanInput({ snapshotAgeMs: ODDS_REFRESH_INTERVAL_MS - 1 }))
      .flags,
    [],
  );
  // Exactly one interval (a single missed refresh is tolerated) -> not stale.
  assert.deepEqual(
    assessDataQuality(cleanInput({ snapshotAgeMs: ODDS_REFRESH_INTERVAL_MS }))
      .flags,
    [],
  );
  // Exactly at two intervals (= threshold) -> NOT stale (strictly greater-than).
  assert.deepEqual(
    assessDataQuality(cleanInput({ snapshotAgeMs: 2 * ODDS_REFRESH_INTERVAL_MS }))
      .flags,
    [],
  );
  // Just over two intervals -> stale.
  assert.deepEqual(
    assessDataQuality(
      cleanInput({ snapshotAgeMs: 2 * ODDS_REFRESH_INTERVAL_MS + 1 }),
    ).flags,
    ['STALE_ODDS'],
  );
});

test('stale odds: custom staleOddsThresholdMs config overrides the default', () => {
  // A tighter threshold flags an age the default would tolerate.
  assert.deepEqual(
    assessDataQuality(cleanInput({ snapshotAgeMs: 60_000 }), {
      staleOddsThresholdMs: 30_000,
    }).flags,
    ['STALE_ODDS'],
  );
});

// (4)
test('missing runner odds -> MISSING_RUNNER_ODDS (declared > priced)', () => {
  // 7 of 8 priced: completeness 0.875 >= 0.8, so only MISSING fires.
  assert.deepEqual(
    assessDataQuality(
      cleanInput({ pricedRunnerIds: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'] }),
    ).flags,
    ['MISSING_RUNNER_ODDS'],
  );
});

// (5)
test('low completeness -> LOW_MARKET_COMPLETENESS (with MISSING_RUNNER_ODDS)', () => {
  // 5 of 8 priced = 0.625 < 0.8.
  assert.deepEqual(
    assessDataQuality(
      cleanInput({ pricedRunnerIds: ['r1', 'r2', 'r3', 'r4', 'r5'] }),
    ).flags,
    ['MISSING_RUNNER_ODDS', 'LOW_MARKET_COMPLETENESS'],
  );
});

// (6)
test('no priced runners -> NO_PRICED_RUNNERS', () => {
  // declared unknown so completeness/missing are not assessed; isolates the flag.
  assert.deepEqual(
    assessDataQuality({
      declaredRunnerCount: null,
      pricedRunnerIds: [],
      hasMarketSnapshot: true,
      snapshotAgeMs: 0,
      tipsterSelectionRunnerIds: [],
    }).flags,
    ['NO_PRICED_RUNNERS', 'NO_TIPSTER_SELECTIONS'],
  );
});

// (7)
test('tipster selections unmatched -> TIPSTER_SELECTIONS_UNMATCHED', () => {
  assert.deepEqual(
    assessDataQuality(cleanInput({ tipsterSelectionRunnerIds: ['not-in-field'] }))
      .flags,
    ['TIPSTER_SELECTIONS_UNMATCHED'],
  );
});

test('low runner count -> LOW_RUNNER_COUNT (declared below threshold)', () => {
  assert.deepEqual(
    assessDataQuality(
      cleanInput({ declaredRunnerCount: 1, pricedRunnerIds: ['r1'] }),
    ).flags,
    ['LOW_RUNNER_COUNT'],
  );
});

test('unknown declared count -> completeness/missing/low-count NOT assessed (no fabrication)', () => {
  assert.deepEqual(
    assessDataQuality({
      declaredRunnerCount: null,
      pricedRunnerIds: ['r1'],
      hasMarketSnapshot: true,
      snapshotAgeMs: 0,
      tipsterSelectionRunnerIds: ['r1'],
    }).flags,
    [],
  );
  // unknown snapshot age -> STALE not assessed either.
  assert.deepEqual(
    assessDataQuality(cleanInput({ snapshotAgeMs: null })).flags,
    [],
  );
});

// (8)
test('flags are de-duplicated and stable in canonical order', () => {
  const { flags } = assessDataQuality({
    declaredRunnerCount: 10,
    pricedRunnerIds: ['r1'], // 1 of 10 -> MISSING + LOW_COMPLETENESS
    hasMarketSnapshot: true,
    snapshotAgeMs: STALE_ODDS_THRESHOLD_MS + 60_000, // STALE
    tipsterSelectionRunnerIds: ['z'], // unmatched
  });
  assert.deepEqual(flags, [
    'MISSING_RUNNER_ODDS',
    'LOW_MARKET_COMPLETENESS',
    'STALE_ODDS',
    'TIPSTER_SELECTIONS_UNMATCHED',
  ]);
  // No duplicates.
  assert.equal(flags.length, new Set(flags).size);
});

// --- metrics ----------------------------------------------------------------

test('metrics: computed from a complete input (completeness, counts, odds age)', () => {
  const { metrics } = assessDataQuality(
    cleanInput({
      declaredRunnerCount: 8,
      pricedRunnerIds: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'], // 6 of 8
      snapshotAgeMs: 90_000,
    }),
  );
  assert.equal(metrics.declared_runner_count, 8);
  assert.equal(metrics.priced_runner_count, 6);
  assert.equal(metrics.market_completeness, 0.75);
  assert.equal(metrics.odds_age_ms, 90_000);
});

test('metrics: full completeness = 1 when every declared runner is priced', () => {
  const { metrics } = assessDataQuality(cleanInput()); // 8 of 8, age 0
  assert.equal(metrics.market_completeness, 1);
  assert.equal(metrics.priced_runner_count, 8);
  assert.equal(metrics.declared_runner_count, 8);
  assert.equal(metrics.odds_age_ms, 0); // 0 is a real age, not "missing"
});

test('metrics: no priced runners -> completeness 0 (declared known), priced 0', () => {
  const { metrics } = assessDataQuality(
    cleanInput({ declaredRunnerCount: 5, pricedRunnerIds: [] }),
  );
  assert.equal(metrics.priced_runner_count, 0);
  assert.equal(metrics.declared_runner_count, 5);
  assert.equal(metrics.market_completeness, 0);
});

test('metrics: missing inputs -> null (no fabrication)', () => {
  const { metrics } = assessDataQuality({
    declaredRunnerCount: null, // unknown
    pricedRunnerIds: ['r1', 'r2'],
    hasMarketSnapshot: true,
    snapshotAgeMs: null, // unknown
    tipsterSelectionRunnerIds: [],
  });
  // Completeness/declared cannot be computed without a declared count.
  assert.equal(metrics.market_completeness, null);
  assert.equal(metrics.declared_runner_count, null);
  // Priced count is always known; odds age is null when the snapshot age is.
  assert.equal(metrics.priced_runner_count, 2);
  assert.equal(metrics.odds_age_ms, null);
});

test('metrics: declared count of 0 -> completeness null (no divide-by-zero)', () => {
  const { metrics } = assessDataQuality({
    declaredRunnerCount: 0,
    pricedRunnerIds: [],
    hasMarketSnapshot: true,
    snapshotAgeMs: 1000,
    tipsterSelectionRunnerIds: [],
  });
  assert.equal(metrics.market_completeness, null);
  assert.equal(metrics.declared_runner_count, 0); // echoed faithfully
  assert.equal(metrics.priced_runner_count, 0);
  assert.equal(metrics.odds_age_ms, 1000);
});

// --- evaluateRunQuality -----------------------------------------------------

test('evaluateRunQuality: OK when no degrading flags', () => {
  assert.equal(evaluateRunQuality([]), 'OK');
  // NO_TIPSTER_SELECTIONS / TIPSTER_SELECTIONS_UNMATCHED do not degrade quality.
  assert.equal(evaluateRunQuality(['NO_TIPSTER_SELECTIONS']), 'OK');
  assert.equal(evaluateRunQuality(['TIPSTER_SELECTIONS_UNMATCHED']), 'OK');
  assert.equal(evaluateRunQuality(['LOW_RUNNER_COUNT']), 'OK');
});

test('evaluateRunQuality: DEGRADED on missing odds / low completeness', () => {
  assert.equal(evaluateRunQuality(['MISSING_RUNNER_ODDS']), 'DEGRADED');
  assert.equal(evaluateRunQuality(['LOW_MARKET_COMPLETENESS']), 'DEGRADED');
});

test('evaluateRunQuality: STALE on stale odds', () => {
  assert.equal(evaluateRunQuality(['STALE_ODDS']), 'STALE');
});

test('evaluateRunQuality: INVALID on no priced runners / no market snapshot', () => {
  assert.equal(evaluateRunQuality(['NO_PRICED_RUNNERS']), 'INVALID');
  assert.equal(evaluateRunQuality(['NO_MARKET_SNAPSHOT']), 'INVALID');
});

test('evaluateRunQuality: priority INVALID > STALE > DEGRADED > OK (mixed flags)', () => {
  // INVALID wins over everything.
  assert.equal(
    evaluateRunQuality([
      'NO_PRICED_RUNNERS',
      'STALE_ODDS',
      'MISSING_RUNNER_ODDS',
    ]),
    'INVALID',
  );
  assert.equal(
    evaluateRunQuality(['NO_MARKET_SNAPSHOT', 'LOW_MARKET_COMPLETENESS']),
    'INVALID',
  );
  // STALE wins over DEGRADED.
  assert.equal(
    evaluateRunQuality(['STALE_ODDS', 'MISSING_RUNNER_ODDS']),
    'STALE',
  );
  assert.equal(
    evaluateRunQuality(['LOW_MARKET_COMPLETENESS', 'STALE_ODDS']),
    'STALE',
  );
  // DEGRADED wins over OK-only flags.
  assert.equal(
    evaluateRunQuality(['MISSING_RUNNER_ODDS', 'NO_TIPSTER_SELECTIONS']),
    'DEGRADED',
  );
});

test('evaluateRunQuality: verdict is order-independent', () => {
  assert.equal(
    evaluateRunQuality(['MISSING_RUNNER_ODDS', 'STALE_ODDS', 'NO_PRICED_RUNNERS']),
    'INVALID',
  );
  assert.equal(
    evaluateRunQuality(['NO_PRICED_RUNNERS', 'STALE_ODDS', 'MISSING_RUNNER_ODDS']),
    'INVALID',
  );
});

// --- determineModelAdjustments ----------------------------------------------

test('determineModelAdjustments: no flags -> no adjustments, no notes', () => {
  assert.deepEqual(determineModelAdjustments([]), {
    suppressStaking: false,
    reduceConfidence: false,
    notes: [],
  });
});

test('determineModelAdjustments: non-triggering flags -> no adjustments', () => {
  // These flags exist but drive neither rule.
  assert.deepEqual(
    determineModelAdjustments([
      'NO_TIPSTER_SELECTIONS',
      'TIPSTER_SELECTIONS_UNMATCHED',
      'LOW_RUNNER_COUNT',
      'NO_MARKET_SNAPSHOT',
    ]),
    { suppressStaking: false, reduceConfidence: false, notes: [] },
  );
});

test('determineModelAdjustments: suppressStaking on LOW_MARKET_COMPLETENESS or NO_PRICED_RUNNERS', () => {
  const low = determineModelAdjustments(['LOW_MARKET_COMPLETENESS']);
  assert.equal(low.suppressStaking, true);
  assert.equal(low.reduceConfidence, false);
  assert.deepEqual(low.notes, [
    'Suppressing staking: market completeness is below the safe threshold.',
  ]);

  const none = determineModelAdjustments(['NO_PRICED_RUNNERS']);
  assert.equal(none.suppressStaking, true);
  assert.equal(none.reduceConfidence, false);
  assert.deepEqual(none.notes, [
    'Suppressing staking: no priced runners in the field.',
  ]);
});

test('determineModelAdjustments: reduceConfidence on STALE_ODDS or MISSING_RUNNER_ODDS', () => {
  const stale = determineModelAdjustments(['STALE_ODDS']);
  assert.equal(stale.suppressStaking, false);
  assert.equal(stale.reduceConfidence, true);
  assert.deepEqual(stale.notes, [
    'Reducing confidence: latest odds snapshot is stale.',
  ]);

  const missing = determineModelAdjustments(['MISSING_RUNNER_ODDS']);
  assert.equal(missing.suppressStaking, false);
  assert.equal(missing.reduceConfidence, true);
  assert.deepEqual(missing.notes, [
    'Reducing confidence: at least one runner lacks usable odds.',
  ]);
});

test('determineModelAdjustments: both rules fire together (one flag each)', () => {
  const r = determineModelAdjustments(['LOW_MARKET_COMPLETENESS', 'STALE_ODDS']);
  assert.equal(r.suppressStaking, true);
  assert.equal(r.reduceConfidence, true);
  assert.deepEqual(r.notes, [
    'Suppressing staking: market completeness is below the safe threshold.',
    'Reducing confidence: latest odds snapshot is stale.',
  ]);
});

test('determineModelAdjustments: all four triggering flags -> stable note order, deduped booleans', () => {
  const r = determineModelAdjustments([
    // intentionally out of canonical order to prove order-independence
    'MISSING_RUNNER_ODDS',
    'NO_PRICED_RUNNERS',
    'STALE_ODDS',
    'LOW_MARKET_COMPLETENESS',
  ]);
  assert.equal(r.suppressStaking, true);
  assert.equal(r.reduceConfidence, true);
  // Notes follow the fixed rule order, not the input order.
  assert.deepEqual(r.notes, [
    'Suppressing staking: no priced runners in the field.',
    'Suppressing staking: market completeness is below the safe threshold.',
    'Reducing confidence: latest odds snapshot is stale.',
    'Reducing confidence: at least one runner lacks usable odds.',
  ]);
});

// --- getFlagSeverity --------------------------------------------------------

test('getFlagSeverity: critical for unusable-market flags', () => {
  assert.equal(getFlagSeverity(DATA_QUALITY_FLAG.NO_PRICED_RUNNERS), 'critical');
  assert.equal(getFlagSeverity(DATA_QUALITY_FLAG.NO_MARKET_SNAPSHOT), 'critical');
});

test('getFlagSeverity: warning for degraded-market flags', () => {
  assert.equal(
    getFlagSeverity(DATA_QUALITY_FLAG.LOW_MARKET_COMPLETENESS),
    'warning',
  );
  assert.equal(getFlagSeverity(DATA_QUALITY_FLAG.MISSING_RUNNER_ODDS), 'warning');
  assert.equal(getFlagSeverity(DATA_QUALITY_FLAG.STALE_ODDS), 'warning');
  // LOW_RUNNER_COUNT is not in the original spec list; classified warning.
  assert.equal(getFlagSeverity(DATA_QUALITY_FLAG.LOW_RUNNER_COUNT), 'warning');
});

test('getFlagSeverity: info for tipster flags', () => {
  assert.equal(getFlagSeverity(DATA_QUALITY_FLAG.NO_TIPSTER_SELECTIONS), 'info');
  assert.equal(
    getFlagSeverity(DATA_QUALITY_FLAG.TIPSTER_SELECTIONS_UNMATCHED),
    'info',
  );
});

test('getFlagSeverity: every known flag maps to a defined severity', () => {
  for (const flag of Object.values(DATA_QUALITY_FLAG)) {
    assert.ok(
      ['critical', 'warning', 'info'].includes(getFlagSeverity(flag)),
      `flag ${flag} has a valid severity`,
    );
  }
});

test('getFlagSeverity: unknown/foreign input -> safe default (info)', () => {
  assert.equal(DEFAULT_FLAG_SEVERITY, 'info');
  assert.equal(getFlagSeverity('SOMETHING_NEW'), 'info');
  assert.equal(getFlagSeverity(''), 'info');
  assert.equal(getFlagSeverity('no_priced_runners'), 'info'); // case-sensitive
});

// --- formatDataQualitySummary -----------------------------------------------

test('formatDataQualitySummary: full data uses metrics for detail (matches example)', () => {
  const lines = formatDataQualitySummary(
    ['LOW_MARKET_COMPLETENESS', 'STALE_ODDS', 'NO_TIPSTER_SELECTIONS'],
    {
      market_completeness: 0.72,
      odds_age_ms: 252_000, // 4.2 minutes
      declared_runner_count: 10,
      priced_runner_count: 7,
    },
  );
  assert.deepEqual(lines, [
    '\u26A0 Low market completeness (0.72)',
    '\u26A0 Stale odds (4.2 min old)',
    '\u2139 No tipster selections',
  ]);
});

test('formatDataQualitySummary: critical flag uses the critical glyph', () => {
  assert.deepEqual(formatDataQualitySummary(['NO_PRICED_RUNNERS']), [
    '\u26D4 No priced runners',
  ]);
});

test('formatDataQualitySummary: partial data -> detail omitted safely (no fabrication)', () => {
  // Metrics object present but the needed fields are null/absent.
  assert.deepEqual(
    formatDataQualitySummary(['LOW_MARKET_COMPLETENESS', 'STALE_ODDS'], {
      market_completeness: null,
      odds_age_ms: null,
      declared_runner_count: null,
      priced_runner_count: 0,
    }),
    ['\u26A0 Low market completeness', '\u26A0 Stale odds'],
  );
  // Metrics omitted entirely -> labels only.
  assert.deepEqual(formatDataQualitySummary(['STALE_ODDS']), [
    '\u26A0 Stale odds',
  ]);
});

test('formatDataQualitySummary: MISSING_RUNNER_ODDS detail uses priced/declared when present', () => {
  assert.deepEqual(
    formatDataQualitySummary(['MISSING_RUNNER_ODDS'], {
      declared_runner_count: 8,
      priced_runner_count: 6,
      market_completeness: 0.75,
      odds_age_ms: null,
    }),
    ['\u26A0 Missing runner odds (6/8 priced)'],
  );
});

test('formatDataQualitySummary: empty / null flags -> empty array', () => {
  assert.deepEqual(formatDataQualitySummary([]), []);
  assert.deepEqual(formatDataQualitySummary(null), []);
  assert.deepEqual(formatDataQualitySummary(undefined), []);
});

test('formatDataQualitySummary: unknown flag is rendered (info glyph, raw label)', () => {
  assert.deepEqual(formatDataQualitySummary(['SOMETHING_NEW']), [
    '\u2139 SOMETHING_NEW',
  ]);
});
