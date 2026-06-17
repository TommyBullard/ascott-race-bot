/**
 * Unit tests for the pure ML training-export helpers (src/lib/trainingExport.ts)
 * and a read-only guard for the script (scripts/exportTrainingData.ts).
 *
 * No DB, no network, no secrets: synthetic rows exercise argument parsing, the
 * output path, probability-rank derivation, win/place LABEL derivation, tipster
 * support-share extraction, CSV escaping, and the deterministic, leakage-safe CSV
 * rendering. The pre-off selection rule (latest run <= off_time, ignore post-off)
 * is the pure `selectPreOffRun`, exercised here to mirror what the script does.
 * Two sanity tests scan the source to prove the export performs no DB writes.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { selectPreOffRun } from '../src/lib/modelPerformance';
import {
  parseTrainingExportArgs,
  buildTrainingExportPath,
  computeProbRanks,
  extractTipsterSupportShares,
  deriveWon,
  derivePlaced,
  escapeCsvCell,
  renderTrainingCsv,
  FEATURE_COLUMNS,
  LABEL_COLUMNS,
  ALL_COLUMNS,
  type TrainingRunnerRow,
} from '../src/lib/trainingExport';

/** A complete TrainingRunnerRow with sensible (comma-free) defaults. */
function row(over: Partial<TrainingRunnerRow> = {}): TrainingRunnerRow {
  return {
    race_id: 'race-1',
    runner_id: 'r1',
    race_date: '2026-06-16',
    course: 'Ascot',
    off_time: '2026-06-16T16:00:00.000Z',
    race_name: 'Test Stakes',
    race_type: null,
    is_handicap: false,
    field_size: 8,
    runner_name: 'Test Horse',
    draw: 5,
    age: null,
    weight: 130,
    official_rating: 95,
    trainer: 'A Trainer',
    jockey: 'A Jockey',
    pre_off_odds: 4.5,
    market_rank_pre_off: 2,
    model_prob_pre_off: 0.22,
    model_rank_pre_off: 1,
    ev_pre_off: 0.12,
    confidence: 0.4,
    data_quality: 'OK',
    data_quality_flags: [],
    tipster_alignment: 'NO_RECOMMENDATION',
    tipster_support_share: null,
    finish_pos: null,
    won: null,
    placed: null,
    sp_decimal: null,
    bsp_decimal: null,
    ...over,
  };
}

/** Parses a comma-safe single-row CSV into a column->cell map (header + 1 line). */
function rowCells(csv: string): Record<string, string> {
  const [header, line] = csv.replace(/\n$/, '').split('\n');
  const cols = header.split(',');
  const vals = line.split(',');
  const rec: Record<string, string> = {};
  cols.forEach((c, i) => {
    rec[c] = vals[i] ?? '';
  });
  return rec;
}

/* ----------------------------- argument parsing --------------------------- */

test('parseTrainingExportArgs: parses --from, --to and --course', () => {
  const a = parseTrainingExportArgs(['--from', '2026-06-16', '--to', '2026-06-17', '--course', 'Ascot']);
  assert.equal(a.from, '2026-06-16');
  assert.equal(a.to, '2026-06-17');
  assert.equal(a.course, 'Ascot');
});

test('parseTrainingExportArgs: rejects malformed from/to dates (left undefined)', () => {
  const a = parseTrainingExportArgs(['--from', '16/06/2026', '--to', 'bad']);
  assert.equal(a.from, undefined);
  assert.equal(a.to, undefined);
});

test('parseTrainingExportArgs: course optional, trimmed, order-independent; blank ignored', () => {
  assert.equal(parseTrainingExportArgs(['--from', '2026-06-16', '--to', '2026-06-16']).course, undefined);
  assert.equal(
    parseTrainingExportArgs(['--course', '  Ascot ', '--to', '2026-06-16', '--from', '2026-06-16']).course,
    'Ascot',
  );
  assert.equal(
    parseTrainingExportArgs(['--from', '2026-06-16', '--to', '2026-06-16', '--course', '   ']).course,
    undefined,
  );
});

test('buildTrainingExportPath: range + optional course slug under data/exports/', () => {
  assert.equal(
    buildTrainingExportPath('2026-06-16', '2026-06-16', 'Ascot'),
    'data/exports/training-data-2026-06-16-to-2026-06-16-ascot.csv',
  );
  assert.equal(
    buildTrainingExportPath('2026-06-16', '2026-06-18', 'Royal Ascot'),
    'data/exports/training-data-2026-06-16-to-2026-06-18-royal-ascot.csv',
  );
  assert.equal(
    buildTrainingExportPath('2026-06-16', '2026-06-16'),
    'data/exports/training-data-2026-06-16-to-2026-06-16.csv',
  );
});

/* ------------------------- pre-off run selection -------------------------- */

test('selects the latest pre-off run (run_time <= off_time)', () => {
  const chosen = selectPreOffRun(
    [
      { run_id: 'early', run_time: '2026-06-16T15:30:00Z' },
      { run_id: 'final', run_time: '2026-06-16T15:58:00Z' },
    ],
    '2026-06-16T16:00:00Z',
  );
  assert.equal(chosen?.run_id, 'final');
});

test('ignores post-off runs (a later stale rerun never wins)', () => {
  const chosen = selectPreOffRun(
    [
      { run_id: 'preoff', run_time: '2026-06-16T15:55:00Z' },
      { run_id: 'postoff', run_time: '2026-06-16T19:15:00Z' },
    ],
    '2026-06-16T16:00:00Z',
  );
  assert.equal(chosen?.run_id, 'preoff');
});

/* ----------------------------- rank derivation ---------------------------- */

test('computeProbRanks: ranks by descending probability; ties by id; null prob omitted', () => {
  const ranks = computeProbRanks([
    { runner_id: 'b', prob: 0.3 },
    { runner_id: 'a', prob: 0.3 }, // tie -> id ascending: a before b
    { runner_id: 'c', prob: 0.5 },
    { runner_id: 'd', prob: null }, // not finite -> omitted
  ]);
  assert.equal(ranks.get('c'), 1);
  assert.equal(ranks.get('a'), 2);
  assert.equal(ranks.get('b'), 3);
  assert.equal(ranks.has('d'), false);
});

/* --------------------------- label derivation ----------------------------- */

test('deriveWon / derivePlaced: null finish -> null; 1 -> win+place; 3 -> place not win; 4 -> neither', () => {
  assert.equal(deriveWon(null), null);
  assert.equal(derivePlaced(null), null);
  assert.equal(deriveWon(1), true);
  assert.equal(derivePlaced(1), true);
  assert.equal(deriveWon(3), false);
  assert.equal(derivePlaced(3), true);
  assert.equal(deriveWon(4), false);
  assert.equal(derivePlaced(4), false);
});

test('extractTipsterSupportShares: reads runner_support; missing/malformed entries skipped', () => {
  const cfg = {
    tipster_consensus: {
      runner_support: [
        { runner_id: 'r1', support_share: 0.6 },
        { runner_id: 2, support_share: 0.4 }, // numeric id normalised to string
        { runner_id: 'r3' }, // no share -> skipped
        { support_share: 0.1 }, // no id -> skipped
        null, // skipped
      ],
    },
  };
  const m = extractTipsterSupportShares(cfg);
  assert.equal(m.get('r1'), 0.6);
  assert.equal(m.get('2'), 0.4);
  assert.equal(m.has('r3'), false);
  assert.equal(m.size, 2);
  assert.equal(extractTipsterSupportShares(null).size, 0);
  assert.equal(extractTipsterSupportShares({}).size, 0);
});

/* ------------------------------- CSV escaping ----------------------------- */

test('escapeCsvCell: quotes values with comma/quote/newline; leaves plain values', () => {
  assert.equal(escapeCsvCell('plain'), 'plain');
  assert.equal(escapeCsvCell('a,b'), '"a,b"');
  assert.equal(escapeCsvCell('a"b'), '"a""b"');
  assert.equal(escapeCsvCell('a\nb'), '"a\nb"');
});

/* ------------------------ leakage-safe column layout ---------------------- */

test('feature columns exclude every result label (no leakage of outcomes)', () => {
  for (const label of ['finish_pos', 'won', 'placed', 'sp_decimal', 'bsp_decimal']) {
    assert.equal(FEATURE_COLUMNS.includes(label), false);
  }
});

test('label columns are exactly the post-race outcomes and disjoint from features', () => {
  assert.deepEqual([...LABEL_COLUMNS], ['finish_pos', 'won', 'placed', 'sp_decimal', 'bsp_decimal']);
  const overlap = FEATURE_COLUMNS.filter((c) => LABEL_COLUMNS.includes(c));
  assert.deepEqual(overlap, []);
});

test('final BSP is a label only, never a feature, and is positioned after all features', () => {
  assert.equal(LABEL_COLUMNS.includes('bsp_decimal'), true);
  assert.equal(FEATURE_COLUMNS.includes('bsp_decimal'), false);
  const lastFeatureIdx = ALL_COLUMNS.indexOf(FEATURE_COLUMNS[FEATURE_COLUMNS.length - 1]);
  const bspIdx = ALL_COLUMNS.indexOf('bsp_decimal');
  assert.ok(bspIdx > lastFeatureIdx);
});

/* ------------------------------- CSV render ------------------------------- */

test('renderTrainingCsv: header is ALL_COLUMNS; empty export is header only', () => {
  const csv = renderTrainingCsv([]);
  assert.equal(csv, ALL_COLUMNS.join(',') + '\n');
});

test('renderTrainingCsv: one CSV row per runner row (plus the header)', () => {
  const csv = renderTrainingCsv([row({ runner_id: 'a' }), row({ runner_id: 'b' }), row({ runner_id: 'c' })]);
  const lines = csv.replace(/\n$/, '').split('\n');
  assert.equal(lines.length, 1 + 3); // header + one row per runner
});

test('renderTrainingCsv: a full row renders features then labels with correct formatting', () => {
  const csv = renderTrainingCsv([
    row({
      is_handicap: true,
      data_quality_flags: ['MISSING_RUNNER_ODDS', 'NO_TIPSTER_SELECTIONS'],
      tipster_support_share: 0.5,
      finish_pos: 1,
      won: true,
      placed: true,
      sp_decimal: 5.5,
      bsp_decimal: 6.0,
    }),
  ]);
  const cells = rowCells(csv);
  assert.equal(cells.is_handicap, '1');
  assert.equal(cells.data_quality_flags, 'MISSING_RUNNER_ODDS;NO_TIPSTER_SELECTIONS'); // joined by ; not ,
  assert.equal(cells.tipster_support_share, '0.5');
  assert.equal(cells.finish_pos, '1');
  assert.equal(cells.won, '1');
  assert.equal(cells.placed, '1');
  assert.equal(cells.sp_decimal, '5.5');
  assert.equal(cells.bsp_decimal, '6');
});

test('renderTrainingCsv: missing values render as blank cells, never fabricated', () => {
  const csv = renderTrainingCsv([
    row({
      race_type: null,
      age: null,
      draw: null,
      weight: null,
      official_rating: null,
      trainer: null,
      jockey: null,
      pre_off_odds: null,
      market_rank_pre_off: null,
      model_prob_pre_off: null,
      model_rank_pre_off: null,
      ev_pre_off: null,
      confidence: null,
      data_quality: null,
      data_quality_flags: [],
      tipster_alignment: null,
      tipster_support_share: null,
      finish_pos: null,
      won: null,
      placed: null,
      sp_decimal: null,
      bsp_decimal: null,
    }),
  ]);
  const cells = rowCells(csv);
  for (const col of [
    'race_type',
    'age',
    'draw',
    'weight',
    'tipster_support_share',
    'finish_pos',
    'won',
    'placed',
    'sp_decimal',
    'bsp_decimal',
  ]) {
    assert.equal(cells[col], '');
  }
  // never the literal string "null"
  assert.equal(/(^|,)null(,|$)/.test(csv), false);
});

test('renderTrainingCsv is deterministic (same rows -> identical string)', () => {
  const rows = [row({ runner_id: 'a' }), row({ runner_id: 'b' })];
  assert.equal(renderTrainingCsv(rows), renderTrainingCsv(rows));
});

test('leakage: result/BSP values appear only in label columns, never in a feature column', () => {
  const csv = renderTrainingCsv([row({ bsp_decimal: 9.9, finish_pos: 1, won: true })]);
  const cells = rowCells(csv);
  assert.equal(cells.bsp_decimal, '9.9');
  assert.equal(cells.finish_pos, '1');
  for (const f of FEATURE_COLUMNS) {
    assert.notEqual(cells[f], '9.9'); // the BSP value never leaks into a feature
  }
});

test('render: does not leak env/secret-looking content (sanity)', () => {
  const csv = renderTrainingCsv([row()]);
  assert.equal(/SERVICE_ROLE|BEGIN [A-Z ]*PRIVATE KEY|SUPABASE_URL|CRON_SECRET/.test(csv), false);
});

/* ----------------------- read-only guards (source scan) ------------------- */

test('no DB writes: the export script issues only reads (no insert/update/upsert/delete/rpc)', () => {
  const src = readFileSync('scripts/exportTrainingData.ts', 'utf8');
  assert.equal(/\.insert\s*\(/.test(src), false);
  assert.equal(/\.update\s*\(/.test(src), false);
  assert.equal(/\.upsert\s*\(/.test(src), false);
  assert.equal(/\.delete\s*\(/.test(src), false);
  assert.equal(/\.rpc\s*\(/.test(src), false);
});

test('no DB access: the pure helper module never imports a DB client, fs, or env', () => {
  const src = readFileSync('src/lib/trainingExport.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(src), false);
  assert.equal(/node:fs/.test(src), false);
  assert.equal(/process\.env/.test(src), false);
});
