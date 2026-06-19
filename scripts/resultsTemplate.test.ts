/**
 * Unit tests for the LOCAL manual-results CSV template generator
 * (src/lib/resultsTemplate.ts) plus read-only source-scan guards on the pure
 * module + CLI.
 *
 * The build + render are pure and deterministic, so no DB / network / files are
 * needed (beyond reading the sources for the scans). These lock the task's
 * rules: the template includes every runner, uses the exact import:results
 * columns, orders deterministically by race off-time then runner number/name,
 * leaves the result columns blank, and the generator writes NO database rows.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseTemplateArgs,
  isValidIsoDate,
  buildTemplatePath,
  buildCompanionPath,
  escapeCsvCell,
  formatOffTimeUtc,
  buildTemplateRows,
  renderTemplateCsv,
  buildTemplateReadme,
  TEMPLATE_COLUMNS,
  TEMPLATE_WARNING,
  BLANK_COLUMNS,
  type TemplateRunner,
  type TemplateInput,
} from '../src/lib/resultsTemplate';

function input(over: Partial<TemplateInput> = {}): TemplateInput {
  const runners: TemplateRunner[] = [
    { offTime: '2026-06-18T14:40:00Z', horseName: 'Charlie', saddlecloth: 2 },
    { offTime: '2026-06-18T13:30:00Z', horseName: 'Bravo', saddlecloth: 5 },
    { offTime: '2026-06-18T13:30:00Z', horseName: 'Alpha', saddlecloth: 1 },
    { offTime: '2026-06-18T14:40:00Z', horseName: 'Delta', saddlecloth: null },
  ];
  return { date: '2026-06-18', course: 'Ascot', runners, ...over };
}

/* ------------------------------ args + paths ------------------------------ */

test('parseTemplateArgs: requires a valid --date; keeps --course + --output', () => {
  const ok = parseTemplateArgs(['--date', '2026-06-18', '--course', 'Ascot', '--output', 'data/x.csv']);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.course, 'Ascot');
  assert.equal(ok.output, 'data/x.csv');
  assert.ok(parseTemplateArgs([]).errors.length > 0);
  assert.ok(parseTemplateArgs(['--date', '2026-13-40']).errors.some((e) => /Invalid --date/.test(e)));
  assert.equal(isValidIsoDate('2026-06-18'), true);
  assert.equal(isValidIsoDate('2026-02-30'), false);
});

test('path builders are slug-stable and companion is sibling .README.md', () => {
  assert.equal(buildTemplatePath('2026-06-18', 'Ascot'), 'data/results-2026-06-18-ascot.csv');
  assert.equal(buildTemplatePath('2026-06-18', null), 'data/results-2026-06-18.csv');
  assert.equal(buildCompanionPath('data/results-2026-06-18-ascot.csv'), 'data/results-2026-06-18-ascot.README.md');
  assert.equal(buildCompanionPath('data/custom'), 'data/custom.README.md');
});

/* ------------------------------- columns ---------------------------------- */

test('the columns match the import:results contract exactly (required then optional)', () => {
  assert.deepEqual(
    [...TEMPLATE_COLUMNS],
    ['date', 'course', 'off_time', 'horse_name', 'finish_pos', 'sp_decimal', 'bsp_decimal', 'runner_status'],
  );
});

/* --------------------------- includes all runners ------------------------- */

test('the template includes one row per runner with identity pre-filled, results blank', () => {
  const rows = buildTemplateRows(input());
  assert.equal(rows.length, 4); // every runner present
  for (const row of rows) {
    assert.equal(row.date, '2026-06-18');
    assert.equal(row.course, 'Ascot');
    assert.notEqual(row.horse_name, '');
    assert.match(row.off_time, /^\d{2}:\d{2}$/);
    for (const blank of BLANK_COLUMNS) {
      assert.equal(row[blank], '', `${blank} must be blank`);
    }
  }
});

/* ------------------------ deterministic ordering -------------------------- */

test('rows are ordered by race off-time, then saddlecloth, then horse name', () => {
  const rows = buildTemplateRows(input());
  // 13:30 race first (Alpha #1 then Bravo #5), then 14:40 race (Charlie #2 then Delta no-number).
  assert.deepEqual(
    rows.map((r) => r.horse_name),
    ['Alpha', 'Bravo', 'Charlie', 'Delta'],
  );
  // Deterministic across calls + does not mutate the input.
  const snapshot = JSON.parse(JSON.stringify(input().runners));
  const i = input();
  buildTemplateRows(i);
  assert.deepEqual(i.runners, snapshot);
  assert.deepEqual(buildTemplateRows(input()), buildTemplateRows(input()));
});

test('runners with no saddlecloth sort after numbered ones; unknown off-time sorts last', () => {
  const rows = buildTemplateRows(
    input({
      runners: [
        { offTime: null, horseName: 'NoTime', saddlecloth: 1 },
        { offTime: '2026-06-18T13:30:00Z', horseName: 'Zeta', saddlecloth: null },
        { offTime: '2026-06-18T13:30:00Z', horseName: 'Yan', saddlecloth: 3 },
      ],
    }),
  );
  assert.deepEqual(rows.map((r) => r.horse_name), ['Yan', 'Zeta', 'NoTime']);
});

/* ------------------------------- formatting ------------------------------- */

test('formatOffTimeUtc renders stored UTC HH:MM (matches the importer) or blank', () => {
  assert.equal(formatOffTimeUtc('2026-06-18T13:30:00Z'), '13:30');
  assert.equal(formatOffTimeUtc('2026-06-18T09:05:00Z'), '09:05');
  assert.equal(formatOffTimeUtc(null), '');
  assert.equal(formatOffTimeUtc('not-a-date'), '');
});

test('escapeCsvCell quotes commas / quotes / newlines', () => {
  assert.equal(escapeCsvCell('Alpha'), 'Alpha');
  assert.equal(escapeCsvCell('a,b'), '"a,b"');
  assert.equal(escapeCsvCell('a"b'), '"a""b"');
  assert.equal(escapeCsvCell('a\nb'), '"a\nb"');
});

/* --------------------------------- render --------------------------------- */

test('renderTemplateCsv emits the header + one line per runner, all result cells blank', () => {
  const csv = renderTemplateCsv(buildTemplateRows(input()));
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[0], 'date,course,off_time,horse_name,finish_pos,sp_decimal,bsp_decimal,runner_status');
  assert.equal(lines.length, 5); // header + 4 runners
  // Each data line ends with the four blank result columns (",,," at the tail).
  for (const line of lines.slice(1)) {
    assert.match(line, /,,,,$/);
  }
});

test('a horse name with a comma is CSV-escaped in the rendered output', () => {
  const csv = renderTemplateCsv(
    buildTemplateRows(input({ runners: [{ offTime: '2026-06-18T13:30:00Z', horseName: 'Smith, Jr', saddlecloth: 1 }] })),
  );
  assert.match(csv, /"Smith, Jr"/);
});

/* --------------------------- companion markdown --------------------------- */

test('the companion README explains the columns + carries the mandatory warning', () => {
  const md = buildTemplateReadme({ date: '2026-06-18', course: 'Ascot', csvPath: 'data/results-2026-06-18-ascot.csv', raceCount: 7, runnerCount: 124 });
  assert.ok(md.includes(TEMPLATE_WARNING));
  assert.match(md, /finish_pos/);
  assert.match(md, /1 = winner/);
  assert.match(md, /import:results -- --file data\/results-2026-06-18-ascot\.csv/);
  assert.match(md, /dry run/i);
  // Deterministic.
  assert.equal(
    md,
    buildTemplateReadme({ date: '2026-06-18', course: 'Ascot', csvPath: 'data/results-2026-06-18-ascot.csv', raceCount: 7, runnerCount: 124 }),
  );
});

test('the warning makes clear it is a dry template requiring a manual fill + dry-run', () => {
  assert.match(TEMPLATE_WARNING, /Dry template only/);
  assert.match(TEMPLATE_WARNING, /fill finish_pos manually/);
  assert.match(TEMPLATE_WARNING, /dry-run before/);
});

/* --------------------- read-only guards (source scans) -------------------- */

test('the template module is pure: no DB, fs, env, network, engines, or settlement writes', () => {
  const lib = readFileSync('src/lib/resultsTemplate.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs|require\(['"]fs/.test(lib), false);
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/\bfetch\s*\(/.test(lib), false);
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(lib), false);
  assert.equal(/bettingEngine|modelProbabilities|kellyStake|scoreRaceRunners|runModelForRace/.test(lib), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/.test(lib), false);
});

test('the template CLI writes NO database rows and never settles or commits', () => {
  const cli = readFileSync('scripts/resultsTemplate.ts', 'utf8');
  // No DB mutations of any kind (read-only SELECT only).
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(cli), false);
  // Never marks a race settled / writes a result.
  assert.equal(/status:\s*'result'|official_result_time|finish_pos:/.test(cli), false);
  // Does not pass a commit flag or place bets.
  assert.equal(/--commit/.test(cli), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/.test(cli), false);
  // Reads stored state + writes only local files.
  assert.match(cli, /supabaseAdmin/);
  assert.match(cli, /\.select\(/);
  assert.match(cli, /from 'node:fs'/);
});
