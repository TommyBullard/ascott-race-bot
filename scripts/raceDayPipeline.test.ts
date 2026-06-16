/**
 * Unit tests for the pure race-day pipeline helpers
 * (src/lib/raceDayPipeline.ts).
 *
 * No network, no DB: synthetic argv + bodies verify argument parsing, the
 * date->day mapping (today/tomorrow/neither), URL building, odds-count reading,
 * and summary formatting. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePipelineArgs,
  dayParamForDate,
  buildUrl,
  buildPipelineUrls,
  dashboardUrl,
  readOddsCounts,
  formatPipelineSummary,
  shouldRunModelAfterCron,
  ODDS_FAILED_SKIP_MESSAGE,
  type PipelineSummary,
} from '../src/lib/raceDayPipeline';

test('parsePipelineArgs: date + course + commit + base-url (trailing slash stripped)', () => {
  const a = parsePipelineArgs([
    '--date', '2026-06-16', '--course', 'Ascot', '--commit',
    '--base-url', 'http://localhost:3001/',
  ]);
  assert.equal(a.date, '2026-06-16');
  assert.equal(a.course, 'Ascot');
  assert.equal(a.commit, true);
  assert.equal(a.baseUrl, 'http://localhost:3001');
});

test('parsePipelineArgs: defaults (dry, no commit, localhost:3000)', () => {
  const a = parsePipelineArgs(['--date', '2026-06-16', '--dry-run']);
  assert.equal(a.commit, false);
  assert.equal(a.dryRun, true);
  assert.equal(a.allowStale, false);
  assert.equal(a.baseUrl, 'http://localhost:3000');
  assert.equal(a.course, undefined);
});

test('parsePipelineArgs: --allow-stale sets allowStale; default false', () => {
  assert.equal(
    parsePipelineArgs(['--date', '2026-06-16', '--commit', '--allow-stale']).allowStale,
    true,
  );
  assert.equal(parsePipelineArgs(['--date', '2026-06-16', '--commit']).allowStale, false);
});

test('shouldRunModelAfterCron: odds gates the model run (--allow-stale overrides)', () => {
  // odds failed => model skipped
  assert.equal(shouldRunModelAfterCron('failed', false), false);
  // odds failed + --allow-stale => model allowed
  assert.equal(shouldRunModelAfterCron('failed', true), true);
  // racecards failed but odds ok => model allowed (decision only consults odds)
  assert.equal(shouldRunModelAfterCron('ok', false), true);
  // defensive: a 'skipped' odds step is treated like not-ok
  assert.equal(shouldRunModelAfterCron('skipped', false), false);
  assert.equal(shouldRunModelAfterCron('skipped', true), true);
});

test('ODDS_FAILED_SKIP_MESSAGE: exact operator wording', () => {
  assert.equal(
    ODDS_FAILED_SKIP_MESSAGE,
    'Skipping model run because odds refresh failed. Start the dev server or pass --allow-stale to override.',
  );
});

test('parsePipelineArgs: invalid/missing date -> undefined; blank course ignored', () => {
  assert.equal(parsePipelineArgs([]).date, undefined);
  assert.equal(parsePipelineArgs(['--date', 'soon']).date, undefined);
  assert.equal(parsePipelineArgs(['--course', '   ']).course, undefined);
});

test('dayParamForDate: today / tomorrow / neither (UTC)', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  assert.equal(dayParamForDate('2026-06-15', now), 'today');
  assert.equal(dayParamForDate('2026-06-16', now), 'tomorrow');
  assert.equal(dayParamForDate('2026-06-17', now), null);
  assert.equal(dayParamForDate('2026-06-14', now), null);
  // Month rollover.
  assert.equal(dayParamForDate('2026-07-01', new Date('2026-06-30T23:00:00Z')), 'tomorrow');
});

test('buildUrl: composes query, omitting null/empty params, encoding values', () => {
  assert.equal(
    buildUrl('http://localhost:3000', '/api/cron/odds', { date: '2026-06-16' }),
    'http://localhost:3000/api/cron/odds?date=2026-06-16',
  );
  assert.equal(
    buildUrl('http://localhost:3000', '/api/cron/racecards', { day: 'tomorrow' }),
    'http://localhost:3000/api/cron/racecards?day=tomorrow',
  );
  // Empty/null params dropped; no trailing '?'.
  assert.equal(
    buildUrl('http://localhost:3000', '/x', { a: undefined, b: '', c: null }),
    'http://localhost:3000/x',
  );
});

test('dashboardUrl: date + optional course', () => {
  assert.equal(
    dashboardUrl('http://localhost:3000', '2026-06-16', 'Ascot'),
    'http://localhost:3000/?date=2026-06-16&course=Ascot',
  );
  assert.equal(
    dashboardUrl('http://localhost:3000', '2026-06-16'),
    'http://localhost:3000/?date=2026-06-16',
  );
});

test('dashboardUrl: separates params with a literal "&", never "&amp;"', () => {
  const url = dashboardUrl('http://localhost:3000', '2026-06-16', 'Ascot');
  assert.ok(url.includes('&'), 'expected a literal ampersand');
  assert.ok(!url.includes('&amp;'), 'must not HTML-escape the ampersand');
  assert.equal(url, 'http://localhost:3000/?date=2026-06-16&course=Ascot');
});

test('buildPipelineUrls: today -> racecards built; neither -> racecards null', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const today = buildPipelineUrls('http://localhost:3000', '2026-06-15', 'Ascot', now);
  assert.equal(today.dayParam, 'today');
  assert.equal(today.racecardsUrl, 'http://localhost:3000/api/cron/racecards?day=today');
  assert.equal(today.oddsUrl, 'http://localhost:3000/api/cron/odds?date=2026-06-15');
  assert.equal(today.dashboardUrl, 'http://localhost:3000/?date=2026-06-15&course=Ascot');

  const tomorrow = buildPipelineUrls('http://localhost:3000', '2026-06-16', undefined, now);
  assert.equal(tomorrow.dayParam, 'tomorrow');
  assert.equal(tomorrow.racecardsUrl, 'http://localhost:3000/api/cron/racecards?day=tomorrow');
  assert.equal(tomorrow.dashboardUrl, 'http://localhost:3000/?date=2026-06-16');

  const neither = buildPipelineUrls('http://localhost:3000', '2026-06-20', 'Ascot', now);
  assert.equal(neither.dayParam, null);
  assert.equal(neither.racecardsUrl, null); // racecards refresh skipped
  assert.equal(neither.oddsUrl, 'http://localhost:3000/api/cron/odds?date=2026-06-20'); // odds still built
});

test('readOddsCounts: reads numeric fields, null-safe (missing -> 0, never fabricated)', () => {
  assert.deepEqual(
    readOddsCounts({
      racesConsidered: 33,
      marketsMatched: 33,
      snapshotsWritten: 33,
      quotesWritten: 235,
    }),
    { races_considered: 33, markets_matched: 33, snapshots_written: 33, quotes_written: 235 },
  );
  assert.deepEqual(readOddsCounts(null), {
    races_considered: 0, markets_matched: 0, snapshots_written: 0, quotes_written: 0,
  });
  assert.deepEqual(readOddsCounts({ marketsMatched: 'x' }), {
    races_considered: 0, markets_matched: 0, snapshots_written: 0, quotes_written: 0,
  });
});

test('formatPipelineSummary: one line per field + dashboard URL last', () => {
  const summary: PipelineSummary = {
    racecards: 'ok',
    odds: 'ok',
    races_considered: 33,
    markets_matched: 33,
    snapshots_written: 33,
    quotes_written: 235,
    model_races_found: 7,
    model_races_run: 7,
    recommendations_created: 5,
    no_bet_races: 2,
    skipped_post_off: 0,
    skipped_resulted: 0,
    failures: 0,
  };
  const lines = formatPipelineSummary(summary, 'http://localhost:3000/?date=2026-06-16&course=Ascot');
  assert.equal(lines.length, 14); // 13 fields + dashboard_url
  assert.ok(lines.some((l) => l.includes('racecards: ok')));
  assert.ok(lines.some((l) => l.includes('recommendations_created: 5')));
  assert.equal(lines[lines.length - 1], '  dashboard_url: http://localhost:3000/?date=2026-06-16&course=Ascot');
});
