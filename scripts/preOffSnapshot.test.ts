/**
 * Unit tests for the pure pre-off snapshot helpers (src/lib/preOffSnapshot.ts).
 *
 * No DB, no network, no secrets, no file writes: synthetic snapshot inputs
 * exercise argument parsing, the report path, the per-race warnings, and the
 * deterministic Markdown rendering. The selection rule (latest run <= off_time,
 * ignore post-off runs) is the pure `selectPreOffRun`, exercised here to mirror
 * what the script does. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectPreOffRun } from '../src/lib/modelPerformance';
import {
  parsePreOffSnapshotArgs,
  buildPreOffSnapshotPath,
  buildRaceSnapshotWarnings,
  renderPreOffSnapshotMarkdown,
  PRE_OFF_FAR_BEFORE_OFF_MS,
  type RaceSnapshot,
  type PreOffSnapshotReport,
} from '../src/lib/preOffSnapshot';

/** A complete RaceSnapshot with sensible defaults for terse tests. */
function race(over: Partial<RaceSnapshot> = {}): RaceSnapshot {
  return {
    race_id: 'r1',
    race_name: 'Test Stakes',
    course: 'Ascot',
    off_time: '2026-06-16T16:00:00Z',
    selected_run_id: 'run-preoff',
    selected_run_time: '2026-06-16T15:55:00Z',
    selected_run_is_current: false,
    post_off_run_count: 0,
    pick: {
      horse_name: 'Puturhandstogether',
      odds: 9.6,
      ev: 0.166,
      model_prob: 0.18,
      market_prob: 0.1,
      stake: 1.2,
      confidence_label: 'Low',
    },
    favourite: {
      horse_name: 'Reaching High',
      odds: 3.15,
      ev: -0.05,
      model_prob: 0.2,
      market_prob: 0.31,
    },
    alternatives: [
      { horse_name: 'Bunting', odds: 21, ev: -0.009, model_prob: 0.04, market_prob: 0.05 },
    ],
    run_quality: 'DEGRADED',
    data_quality_flags: ['MISSING_RUNNER_ODDS'],
    data_quality_short_summary: 'Missing runner odds, 19/20 priced',
    tipster_short_summary: 'Tipsters prefer a different runner',
    tipster_alignment_label: 'DIVERGENT',
    ...over,
  };
}

/* ------------------------------- arg parsing ------------------------------ */

test('parsePreOffSnapshotArgs: parses --date and --course', () => {
  const args = parsePreOffSnapshotArgs(['--date', '2026-06-16', '--course', 'Ascot']);
  assert.equal(args.date, '2026-06-16');
  assert.equal(args.course, 'Ascot');
});

test('parsePreOffSnapshotArgs: rejects a malformed date (leaves date undefined)', () => {
  assert.equal(parsePreOffSnapshotArgs(['--date', '16-06-2026']).date, undefined);
  assert.equal(parsePreOffSnapshotArgs(['--date', 'today']).date, undefined);
  assert.equal(parsePreOffSnapshotArgs(['--date']).date, undefined);
});

test('parsePreOffSnapshotArgs: course optional; order-independent', () => {
  const a = parsePreOffSnapshotArgs(['--course', 'Royal Ascot', '--date', '2026-06-16']);
  assert.equal(a.date, '2026-06-16');
  assert.equal(a.course, 'Royal Ascot');
  assert.equal(parsePreOffSnapshotArgs(['--date', '2026-06-16']).course, undefined);
});

/* ------------------------------- report path ------------------------------ */

test('buildPreOffSnapshotPath: slugifies course into a filesystem-safe path', () => {
  assert.equal(
    buildPreOffSnapshotPath('2026-06-16', 'Ascot'),
    'reports/pre-off-snapshot-2026-06-16-ascot.md',
  );
  assert.equal(
    buildPreOffSnapshotPath('2026-06-16', 'Royal Ascot'),
    'reports/pre-off-snapshot-2026-06-16-royal-ascot.md',
  );
});

test('buildPreOffSnapshotPath: omits the course when absent/empty', () => {
  assert.equal(buildPreOffSnapshotPath('2026-06-16'), 'reports/pre-off-snapshot-2026-06-16.md');
  assert.equal(buildPreOffSnapshotPath('2026-06-16', '  '), 'reports/pre-off-snapshot-2026-06-16.md');
});

/* --------------------------- selection (mirrors script) ------------------- */

test('snapshot selection: latest run <= off_time is chosen', () => {
  const chosen = selectPreOffRun(
    [
      { run_id: 'early', run_time: '2026-06-16T15:30:00Z' },
      { run_id: 'final', run_time: '2026-06-16T15:58:00Z' },
    ],
    '2026-06-16T16:00:00Z',
  );
  assert.equal(chosen?.run_id, 'final');
});

test('snapshot selection: post-off runs are ignored', () => {
  const chosen = selectPreOffRun(
    [
      { run_id: 'preoff', run_time: '2026-06-16T15:55:00Z' },
      { run_id: 'postoff', run_time: '2026-06-16T19:15:00Z' },
    ],
    '2026-06-16T16:00:00Z',
  );
  assert.equal(chosen?.run_id, 'preoff');
});

/* -------------------------------- warnings -------------------------------- */

test('warnings: no pre-off run is flagged', () => {
  const w = buildRaceSnapshotWarnings(
    race({ selected_run_id: null, selected_run_time: null, selected_run_is_current: null }),
  );
  assert.equal(w.noPreOffRun, true);
});

test('warnings: a selected run far before off time is flagged', () => {
  // 30 minutes before off (> 15 min threshold).
  const w = buildRaceSnapshotWarnings(
    race({ selected_run_time: '2026-06-16T15:30:00Z', off_time: '2026-06-16T16:00:00Z' }),
  );
  assert.equal(w.farBeforeOff, true);
});

test('warnings: a run just before off time is NOT flagged as far-before', () => {
  // 5 minutes before off (< 15 min threshold).
  const w = buildRaceSnapshotWarnings(
    race({ selected_run_time: '2026-06-16T15:55:00Z', off_time: '2026-06-16T16:00:00Z' }),
  );
  assert.equal(w.farBeforeOff, false);
});

test('warnings: the far-before threshold is exactly 15 minutes (boundary is not "far")', () => {
  const off = '2026-06-16T16:00:00Z';
  const atThreshold = new Date(new Date(off).getTime() - PRE_OFF_FAR_BEFORE_OFF_MS).toISOString();
  assert.equal(
    buildRaceSnapshotWarnings(race({ selected_run_time: atThreshold, off_time: off })).farBeforeOff,
    false, // strictly greater than the threshold triggers it
  );
});

test('warnings: post-off runs that were ignored are flagged', () => {
  const w = buildRaceSnapshotWarnings(race({ post_off_run_count: 3 }));
  assert.equal(w.postOffRunsIgnored, true);
});

/* ----------------------------- markdown render ---------------------------- */

const REPORT: PreOffSnapshotReport = {
  date: '2026-06-16',
  course: 'Ascot',
  generatedAt: '2026-06-16T20:00:00.000Z', // fixed -> deterministic
  races: [race()],
};

test('render: includes race meta, selected run, and the pick', () => {
  const md = renderPreOffSnapshotMarkdown(REPORT);
  assert.match(md, /# Pre-off race-day snapshot — 2026-06-16/);
  assert.match(md, /Selected pre-off run: run-preoff/);
  assert.match(md, /Selected run status: superseded/);
  assert.match(md, /Pick: Puturhandstogether/);
  assert.match(md, /Confidence: Low/);
});

test('render: a no-bet selected run renders as "No bet", not a fabricated pick', () => {
  const md = renderPreOffSnapshotMarkdown({
    ...REPORT,
    races: [race({ pick: null })],
  });
  assert.match(md, /No bet \(the selected pre-off run made no rank-1 recommendation\)\./);
});

test('render: a race with no pre-off run shows the no-run warning', () => {
  const md = renderPreOffSnapshotMarkdown({
    ...REPORT,
    races: [
      race({
        selected_run_id: null,
        selected_run_time: null,
        selected_run_is_current: null,
        pick: null,
        favourite: null,
        alternatives: [],
        run_quality: null,
        data_quality_flags: [],
        data_quality_short_summary: null,
        tipster_short_summary: null,
        tipster_alignment_label: null,
      }),
    ],
  });
  assert.match(md, /No pre-off model run exists for this race/);
});

test('render: post-off ignored runs surface a warning with the count', () => {
  const md = renderPreOffSnapshotMarkdown({ ...REPORT, races: [race({ post_off_run_count: 2 })] });
  assert.match(md, /2 post-off run\(s\) exist but were ignored/);
});

test('render: never fabricates — missing numbers render as an em dash', () => {
  const md = renderPreOffSnapshotMarkdown({
    ...REPORT,
    races: [
      race({
        pick: {
          horse_name: 'Mystery',
          odds: null,
          ev: null,
          model_prob: null,
          market_prob: null,
          stake: null,
          confidence_label: null,
        },
      }),
    ],
  });
  assert.match(md, /Odds: \u2014/);
  assert.match(md, /EV: \u2014/);
  assert.match(md, /Stake: \u2014/);
});

test('render: output is DETERMINISTIC for the same report', () => {
  const a = renderPreOffSnapshotMarkdown(REPORT);
  const b = renderPreOffSnapshotMarkdown(REPORT);
  assert.equal(a, b);
});

test('render: empty race list yields a stable "no races" report', () => {
  const md = renderPreOffSnapshotMarkdown({ ...REPORT, races: [] });
  assert.match(md, /_No races matched the given date\/course\._/);
  // Still deterministic.
  assert.equal(md, renderPreOffSnapshotMarkdown({ ...REPORT, races: [] }));
});

test('render: does not leak env/secret-looking content (sanity)', () => {
  const md = renderPreOffSnapshotMarkdown(REPORT);
  assert.doesNotMatch(md, /SERVICE_ROLE|SUPABASE_|CRON_SECRET|eyJ[A-Za-z0-9_-]{10,}/);
});
