/**
 * Unit tests for the pure T-minus capture helpers (src/lib/tMinusCapture.ts) and
 * a read-only guard for the script (scripts/captureTMinus.ts).
 *
 * No DB, no network, no secrets: synthetic runs/captures exercise argument
 * parsing, the capture-target computation, the T-minus run selection (reusing
 * `selectPreOffRun`), the per-race warnings, the report path, and the
 * deterministic Markdown / JSON rendering. Two sanity tests scan the source to
 * prove the capture performs no DB writes. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseTMinusCaptureArgs,
  computeCaptureTargetTime,
  selectTMinusRun,
  buildTMinusCaptureWarnings,
  buildTMinusCapturePath,
  buildTMinusCaptureJson,
  renderTMinusCaptureMarkdown,
  DEFAULT_MINUTES_BEFORE,
  FAR_BEFORE_CAPTURE_MS,
  type TMinusRaceCapture,
  type TMinusCaptureReport,
} from '../src/lib/tMinusCapture';

const OFF = '2026-06-16T16:00:00.000Z';
const CAPTURE_TARGET = '2026-06-16T15:55:00.000Z'; // OFF - 5 min

/** A run candidate. */
function run(run_id: string, run_time: string) {
  return { run_id, run_time };
}

/** A complete TMinusRaceCapture with sensible defaults for terse tests. */
function race(over: Partial<TMinusRaceCapture> = {}): TMinusRaceCapture {
  return {
    race_id: 'race-1',
    race_name: 'Test Stakes',
    course: 'Ascot',
    off_time: OFF,
    capture_target_time: CAPTURE_TARGET,
    selected_run_id: 'run-1',
    selected_run_time: '2026-06-16T15:53:00.000Z',
    selected_run_is_current: false,
    later_pre_off_run_exists: false,
    post_off_run_count: 0,
    pick: {
      horse_name: 'Test Horse',
      odds: 4.5,
      ev: 0.12,
      model_prob: 0.22,
      market_prob: 0.22,
      stake: 1.0,
      confidence_label: 'Low',
    },
    favourite: { horse_name: 'Fav Horse', odds: 3.5, ev: 0.05, model_prob: 0.3, market_prob: 0.3 },
    alternatives: [],
    run_quality: 'OK',
    data_quality_flags: [],
    data_quality_short_summary: 'All good',
    tipster_short_summary: 'No tipster consensus',
    tipster_alignment_label: 'NO_RECOMMENDATION',
    ...over,
  };
}

/* ----------------------------- argument parsing --------------------------- */

test('parseTMinusCaptureArgs: parses --date, --course and --minutes-before', () => {
  const a = parseTMinusCaptureArgs(['--date', '2026-06-16', '--course', 'Ascot', '--minutes-before', '8']);
  assert.equal(a.date, '2026-06-16');
  assert.equal(a.course, 'Ascot');
  assert.equal(a.minutesBefore, 8);
});

test('parseTMinusCaptureArgs: defaults minutes-before to 5 when omitted', () => {
  const a = parseTMinusCaptureArgs(['--date', '2026-06-16', '--course', 'Ascot']);
  assert.equal(a.minutesBefore, DEFAULT_MINUTES_BEFORE);
  assert.equal(a.minutesBefore, 5);
});

test('parseTMinusCaptureArgs: rejects an invalid date (left undefined)', () => {
  assert.equal(parseTMinusCaptureArgs(['--date', '16-06-2026']).date, undefined);
  assert.equal(parseTMinusCaptureArgs(['--date', 'nope']).date, undefined);
});

test('parseTMinusCaptureArgs: rejects an invalid minutes-before (0, negative, decimal, non-numeric -> undefined)', () => {
  assert.equal(parseTMinusCaptureArgs(['--date', '2026-06-16', '--minutes-before', '0']).minutesBefore, undefined);
  assert.equal(parseTMinusCaptureArgs(['--date', '2026-06-16', '--minutes-before', '-3']).minutesBefore, undefined);
  assert.equal(parseTMinusCaptureArgs(['--date', '2026-06-16', '--minutes-before', '5.5']).minutesBefore, undefined);
  assert.equal(parseTMinusCaptureArgs(['--date', '2026-06-16', '--minutes-before', 'soon']).minutesBefore, undefined);
});

test('parseTMinusCaptureArgs: course optional, trimmed, order-independent; blank ignored', () => {
  assert.equal(parseTMinusCaptureArgs(['--date', '2026-06-16']).course, undefined);
  assert.equal(
    parseTMinusCaptureArgs(['--minutes-before', '5', '--course', '  Ascot ', '--date', '2026-06-16']).course,
    'Ascot',
  );
  assert.equal(parseTMinusCaptureArgs(['--date', '2026-06-16', '--course', '  ']).course, undefined);
});

/* --------------------------- capture target time -------------------------- */

test('computeCaptureTargetTime: off - minutes_before (UTC)', () => {
  assert.equal(computeCaptureTargetTime(OFF, 5), CAPTURE_TARGET);
  assert.equal(computeCaptureTargetTime(OFF, 10), '2026-06-16T15:50:00.000Z');
});

test('computeCaptureTargetTime: missing/unparseable off -> null (never fabricated)', () => {
  assert.equal(computeCaptureTargetTime(null, 5), null);
  assert.equal(computeCaptureTargetTime(undefined, 5), null);
  assert.equal(computeCaptureTargetTime('not-a-time', 5), null);
});

/* --------------------------- T-minus run selection ------------------------ */

test('selectTMinusRun: selects the latest run at or before the capture target', () => {
  const sel = selectTMinusRun(
    [
      run('a', '2026-06-16T15:50:00.000Z'),
      run('b', '2026-06-16T15:53:00.000Z'), // latest <= 15:55 -> chosen
      run('c', '2026-06-16T15:58:00.000Z'), // after capture target -> not chosen
    ],
    OFF,
    5,
  );
  assert.equal(sel.captureTargetTime, CAPTURE_TARGET);
  assert.equal(sel.selectedRunId, 'b');
  assert.equal(sel.selectedRunTime, '2026-06-16T15:53:00.000Z');
});

test('selectTMinusRun: ignores runs after the capture target even if still pre-off (reports laterPreOffRunExists)', () => {
  const sel = selectTMinusRun(
    [
      run('b', '2026-06-16T15:53:00.000Z'),
      run('c', '2026-06-16T15:58:00.000Z'), // after capture target, before off
    ],
    OFF,
    5,
  );
  assert.equal(sel.selectedRunId, 'b'); // NOT c
  assert.equal(sel.laterPreOffRunExists, true);
});

test('selectTMinusRun: ignores post-off runs (counts them, never selects them)', () => {
  const sel = selectTMinusRun(
    [
      run('b', '2026-06-16T15:53:00.000Z'),
      run('post1', '2026-06-16T16:05:00.000Z'),
      run('post2', '2026-06-16T19:30:00.000Z'),
    ],
    OFF,
    5,
  );
  assert.equal(sel.selectedRunId, 'b');
  assert.equal(sel.postOffRunCount, 2);
});

test('selectTMinusRun: no run at/before the capture target -> selectedRunId null', () => {
  const sel = selectTMinusRun(
    [
      run('c', '2026-06-16T15:58:00.000Z'), // later pre-off only
      run('post', '2026-06-16T16:30:00.000Z'),
    ],
    OFF,
    5,
  );
  assert.equal(sel.selectedRunId, null);
  assert.equal(sel.laterPreOffRunExists, true);
  assert.equal(sel.postOffRunCount, 1);
});

test('selectTMinusRun: missing off time -> all-empty selection (no capture run)', () => {
  const sel = selectTMinusRun([run('a', '2026-06-16T15:50:00.000Z')], null, 5);
  assert.deepEqual(sel, {
    captureTargetTime: null,
    selectedRunId: null,
    selectedRunTime: null,
    laterPreOffRunExists: false,
    postOffRunCount: 0,
  });
});

/* -------------------------------- warnings -------------------------------- */

test('buildTMinusCaptureWarnings: no capture run available', () => {
  const w = buildTMinusCaptureWarnings(
    race({ selected_run_id: null, selected_run_time: null, selected_run_is_current: null }),
  );
  assert.equal(w.noCaptureRun, true);
});

test('buildTMinusCaptureWarnings: selected run far before the capture target (>10 min)', () => {
  const farRunTime = new Date(new Date(CAPTURE_TARGET).getTime() - FAR_BEFORE_CAPTURE_MS - 60_000).toISOString();
  const w = buildTMinusCaptureWarnings(race({ selected_run_time: farRunTime }));
  assert.equal(w.farBeforeCapture, true);
});

test('buildTMinusCaptureWarnings: a run exactly 10 minutes before is NOT flagged (boundary)', () => {
  const atThreshold = new Date(new Date(CAPTURE_TARGET).getTime() - FAR_BEFORE_CAPTURE_MS).toISOString();
  const w = buildTMinusCaptureWarnings(race({ selected_run_time: atThreshold }));
  assert.equal(w.farBeforeCapture, false); // strictly greater than the margin triggers it
});

test('buildTMinusCaptureWarnings: later pre-off run + post-off runs ignored', () => {
  const w = buildTMinusCaptureWarnings(race({ later_pre_off_run_exists: true, post_off_run_count: 3 }));
  assert.equal(w.laterPreOffRunExists, true);
  assert.equal(w.postOffRunsIgnored, true);
});

/* ------------------------------- report path ------------------------------ */

test('buildTMinusCapturePath: minutes + date + optional course slug; md/json extensions', () => {
  assert.equal(buildTMinusCapturePath('2026-06-16', 5, 'Ascot'), 'reports/t-minus-5-capture-2026-06-16-ascot.md');
  assert.equal(
    buildTMinusCapturePath('2026-06-16', 5, 'Ascot', 'json'),
    'reports/t-minus-5-capture-2026-06-16-ascot.json',
  );
  assert.equal(buildTMinusCapturePath('2026-06-16', 8, 'Royal Ascot'), 'reports/t-minus-8-capture-2026-06-16-royal-ascot.md');
  assert.equal(buildTMinusCapturePath('2026-06-16', 5), 'reports/t-minus-5-capture-2026-06-16.md');
});

/* ----------------------------- markdown render ---------------------------- */

const REPORT: TMinusCaptureReport = {
  date: '2026-06-16',
  course: 'Ascot',
  minutes_before: 5,
  generatedAt: '2026-06-16T15:50:00.000Z', // fixed -> deterministic
  races: [race()],
};

test('render: includes the heading, capture target, and the later-pre-off line', () => {
  const md = renderTMinusCaptureMarkdown(REPORT);
  assert.match(md, /# T-minus-5 pre-race capture \u2014 2026-06-16/);
  assert.match(md, /- Capture target \(UTC\): 2026-06-16T15:55:00\.000Z/);
  assert.match(md, /- Later pre-off run exists: No/);
  assert.match(md, /- Pick: Test Horse/);
});

test('render: a no-capture-run race renders the no-capture line + warning', () => {
  const md = renderTMinusCaptureMarkdown({
    ...REPORT,
    races: [race({ selected_run_id: null, selected_run_time: null, selected_run_is_current: null, pick: null })],
  });
  assert.match(md, /No capture run available \(no model run at or before the capture target\)\./);
  assert.match(md, /No capture run available \(no model run at or before the capture target time\)\./);
});

test('render: a captured run with no recommendation renders as "No bet"', () => {
  const md = renderTMinusCaptureMarkdown({ ...REPORT, races: [race({ pick: null })] });
  assert.match(md, /No bet \(the captured run made no rank-1 recommendation\)\./);
});

test('render: later pre-off run + post-off runs surface their warnings', () => {
  const md = renderTMinusCaptureMarkdown({
    ...REPORT,
    races: [race({ later_pre_off_run_exists: true, post_off_run_count: 2 })],
  });
  assert.match(md, /A later pre-off run exists \(after the capture target but before the off\)/);
  assert.match(md, /2 post-off run\(s\) exist but were ignored/);
});

test('render: missing values render as an em dash, never invented', () => {
  const sparse = race({
    course: null,
    off_time: null,
    capture_target_time: null,
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
  });
  const md = renderTMinusCaptureMarkdown({ ...REPORT, races: [sparse] });
  assert.match(md, /- Course: \u2014/);
  assert.match(md, /- Capture target \(UTC\): \u2014/);
  assert.match(md, /- Data quality: \u2014/);
});

test('render: is deterministic (same report object -> identical string)', () => {
  assert.equal(renderTMinusCaptureMarkdown(REPORT), renderTMinusCaptureMarkdown(REPORT));
});

test('render: does not leak env/secret-looking content (sanity)', () => {
  const md = renderTMinusCaptureMarkdown(REPORT);
  assert.equal(/SERVICE_ROLE|BEGIN [A-Z ]*PRIVATE KEY|SUPABASE_URL|CRON_SECRET/.test(md), false);
});

/* ------------------------------- JSON render ------------------------------ */

test('buildTMinusCaptureJson: attaches per-race warnings and keeps missing values null', () => {
  const json = buildTMinusCaptureJson({
    ...REPORT,
    races: [race({ selected_run_id: null, selected_run_time: null, selected_run_is_current: null, pick: null, capture_target_time: null, off_time: null })],
  });
  assert.equal(json.minutes_before, 5);
  assert.equal(json.races.length, 1);
  assert.equal(json.races[0].selected_run_id, null); // null, not fabricated
  assert.equal(json.races[0].capture_target_time, null);
  assert.equal(json.races[0].warnings.noCaptureRun, true);
  // JSON view is serialisable and stable.
  assert.equal(JSON.stringify(json), JSON.stringify(buildTMinusCaptureJson({
    ...REPORT,
    races: [race({ selected_run_id: null, selected_run_time: null, selected_run_is_current: null, pick: null, capture_target_time: null, off_time: null })],
  })));
});

test('buildTMinusCaptureJson: does not mutate the input report', () => {
  const input: TMinusCaptureReport = { ...REPORT, races: [race()] };
  const before = JSON.stringify(input);
  buildTMinusCaptureJson(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal('warnings' in input.races[0], false); // warnings only on the JSON view
});

/* ----------------------- read-only guards (source scan) ------------------- */

test('no DB writes: the capture script issues only reads (no insert/update/upsert/delete/rpc)', () => {
  const src = readFileSync('scripts/captureTMinus.ts', 'utf8');
  assert.equal(/\.insert\s*\(/.test(src), false);
  assert.equal(/\.update\s*\(/.test(src), false);
  assert.equal(/\.upsert\s*\(/.test(src), false);
  assert.equal(/\.delete\s*\(/.test(src), false);
  assert.equal(/\.rpc\s*\(/.test(src), false);
});

test('no DB access: the pure helper module never imports a DB client, fs, or env', () => {
  const src = readFileSync('src/lib/tMinusCapture.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(src), false);
  assert.equal(/node:fs/.test(src), false);
  assert.equal(/process\.env/.test(src), false);
});
