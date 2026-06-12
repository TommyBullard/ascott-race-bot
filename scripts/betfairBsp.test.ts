/**
 * Unit tests for the Betfair BSP -> historical import converter
 * (src/lib/betfairBsp). Pure, synthetic CSV fixtures — no file or network I/O.
 *
 * These lock down the INTEGRITY-critical mapping: winner-only finish_pos,
 * non-runner handling, void/dead-heat skipping, the optimistic-quote default,
 * header-driven column detection, and that converted output passes the loader's
 * own validator. They assert the rules, not any real race.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCsv,
  resolveColumns,
  toPrice,
  parseWinLose,
  parseEventDt,
  parseMenuHint,
  convertBspToImport,
} from '../src/lib/betfairBsp';
import { validateImport } from '../src/lib/historicalRaceLoader';

const HEADER =
  'SP_ID,EVENT_DT,EVENT_ID,MENU_HINT,EVENT_NAME,SELECTION_ID,SELECTION_NAME,WIN_LOSE,BSP,PPWAP';

/** Builds a CSV from the shared header + body lines. */
function csv(...lines: string[]): string {
  return [HEADER, ...lines].join('\n') + '\n';
}

// --- primitive parsers -----------------------------------------------------

test('parseCsv: header + records, and quoted fields with embedded commas', () => {
  const text = 'A,B,C\n1,"hello, world",3\n4,5,6\n';
  const { header, rows } = parseCsv(text);
  assert.deepEqual(header, ['A', 'B', 'C']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].B, 'hello, world');
  assert.equal(rows[1].C, '6');
});

test('toPrice: > 1 only; blank/0/<=1/non-numeric -> null', () => {
  assert.equal(toPrice('3.5'), 3.5);
  assert.equal(toPrice('1.01'), 1.01);
  assert.equal(toPrice(''), null);
  assert.equal(toPrice('0'), null);
  assert.equal(toPrice('1'), null); // 1.0 is not a real exchange price
  assert.equal(toPrice('abc'), null);
  assert.equal(toPrice(undefined), null);
});

test('parseWinLose: 1/W/win are winners; 0/blank are not', () => {
  assert.equal(parseWinLose('1'), true);
  assert.equal(parseWinLose('1.0'), true);
  assert.equal(parseWinLose('W'), true);
  assert.equal(parseWinLose('WINNER'), true);
  assert.equal(parseWinLose('0'), false);
  assert.equal(parseWinLose(''), false);
  assert.equal(parseWinLose(undefined), false);
});

test('parseEventDt: DD-MM-YYYY HH:MM and ISO fallback; invalid -> null', () => {
  assert.deepEqual(parseEventDt('01-06-2026 14:30'), {
    meetingDate: '2026-06-01',
    offTime: '2026-06-01T14:30:00Z',
  });
  assert.deepEqual(parseEventDt('2026-06-01 14:30:00'), {
    meetingDate: '2026-06-01',
    offTime: '2026-06-01T14:30:00Z',
  });
  assert.equal(parseEventDt('not a date'), null);
  assert.equal(parseEventDt(''), null);
});

test('parseMenuHint: splits country/course, strips trailing date, keeps (AW)', () => {
  assert.deepEqual(parseMenuHint('GB / Ascot 1st Jun', 'GB'), {
    country: 'GB',
    course: 'Ascot',
  });
  assert.deepEqual(parseMenuHint('IRE / Cork (AW) 23rd December', 'GB'), {
    country: 'IRE',
    course: 'Cork (AW)',
  });
  // No slash -> fall back to provided country, whole string is the course.
  assert.deepEqual(parseMenuHint('Newmarket', 'GB'), {
    country: 'GB',
    course: 'Newmarket',
  });
});

test('resolveColumns: case-insensitive header mapping', () => {
  const { header } = parseCsv('event_dt,Menu_Hint,EVENT_NAME,selection_name,win_lose,bsp\n');
  const cols = resolveColumns(header);
  assert.equal(cols.eventDt, 'event_dt');
  assert.equal(cols.menuHint, 'Menu_Hint');
  assert.equal(cols.selectionName, 'selection_name');
  assert.equal(cols.bsp, 'bsp');
  assert.equal(cols.eventId, undefined);
});

// --- conversion ------------------------------------------------------------

const MIXED = csv(
  // E1: normal, 1 winner (Alpha), 1 loser (Bravo)
  '1,01-06-2026 14:30,E1,GB / Ascot 1st Jun,1430 1m Stks,s1,Alpha,1,3.5,3.4',
  '2,01-06-2026 14:30,E1,GB / Ascot 1st Jun,1430 1m Stks,s2,Bravo,0,2.5,2.6',
  // E2: handicap; winner Delta, loser Charlie, non-runner Echo (blank BSP)
  '3,01-06-2026 15:00,E2,GB / Lingfield (AW) 1st Jun,1500 6f Hcap,s3,Charlie,0,4.0,4.1',
  '4,01-06-2026 15:00,E2,GB / Lingfield (AW) 1st Jun,1500 6f Hcap,s4,Delta,1,2.0,2.1',
  '5,01-06-2026 15:00,E2,GB / Lingfield (AW) 1st Jun,1500 6f Hcap,s5,Echo,0,,',
  // E3: dead heat (2 winners) -> skipped
  '6,01-06-2026 15:30,E3,GB / Ascot 1st Jun,1530 5f Stks,s6,Foxtrot,1,3.0,3.0',
  '7,01-06-2026 15:30,E3,GB / Ascot 1st Jun,1530 5f Stks,s7,Golf,1,3.0,3.0',
  // E4: void (0 winners) -> skipped
  '8,01-06-2026 16:00,E4,GB / Ascot 1st Jun,1600 2m Hcap,s8,Hotel,0,5.0,5.0',
  '9,01-06-2026 16:00,E4,GB / Ascot 1st Jun,1600 2m Hcap,s9,India,0,6.0,6.0',
);

test('convertBspToImport: emits 1-winner races, skips dead heats + voids', () => {
  const { import: imp, summary } = convertBspToImport(parseCsv(MIXED));
  assert.equal(summary.racesFound, 4);
  assert.equal(summary.racesEmitted, 2);
  assert.equal(summary.racesSkipped, 2);
  assert.equal(summary.deadHeats, 1);
  assert.equal(summary.voidMarkets, 1);
  assert.equal(summary.nonRunners, 1);
  assert.equal(imp.races.length, 2);

  const [e1, e2] = imp.races;
  assert.equal(e1.course, 'Ascot');
  assert.equal(e1.country, 'GB');
  assert.equal(e1.handicap, false);
  assert.equal(e1.meeting_date, '2026-06-01');
  assert.equal(e1.off_time, '2026-06-01T14:30:00Z');
  assert.equal(e1.quote_type, 'bsp_optimistic');
  assert.equal(e1.source_label, 'betfair_bsp');

  const alpha = e1.runners.find((r) => r.horse_name === 'Alpha')!;
  assert.equal(alpha.finish_pos, 1);
  assert.equal(alpha.odds_decimal, 3.5); // quote defaults to BSP
  assert.equal(alpha.bsp_decimal, 3.5);
  assert.equal(alpha.sp_decimal, undefined); // not in BSP file -> never invented
  assert.equal(alpha.status, 'ran');

  const bravo = e1.runners.find((r) => r.horse_name === 'Bravo')!;
  assert.equal(bravo.finish_pos, undefined); // loser: finishing order unknown
  assert.equal(bravo.odds_decimal, 2.5);

  // E2 is a handicap (race name contains "Hcap"); Echo is a non-runner.
  assert.equal(e2.handicap, true);
  const echo = e2.runners.find((r) => r.horse_name === 'Echo')!;
  assert.equal(echo.status, 'non_runner');
  assert.equal(echo.odds_decimal, undefined);
  assert.equal(echo.bsp_decimal, undefined);
  assert.equal(echo.finish_pos, undefined);
});

test('convertBspToImport: --quote ppwap uses PPWAP as the pre-race quote', () => {
  const { import: imp } = convertBspToImport(parseCsv(MIXED), { quoteSource: 'ppwap' });
  const alpha = imp.races[0].runners.find((r) => r.horse_name === 'Alpha')!;
  assert.equal(alpha.odds_decimal, 3.4); // PPWAP
  assert.equal(alpha.bsp_decimal, 3.5); // BSP still recorded for settlement
  assert.equal(imp.races[0].quote_type, 'ppwap');
});

test('convertBspToImport: winner missing BSP is flagged but race still emitted', () => {
  const text = csv(
    '1,02-06-2026 14:00,E5,GB / York 2nd Jun,1400 1m Stks,sA,Kilo,1,,',
    '2,02-06-2026 14:00,E5,GB / York 2nd Jun,1400 1m Stks,sB,Lima,0,2.0,2.0',
  );
  const { import: imp, summary, warnings } = convertBspToImport(parseCsv(text));
  assert.equal(summary.racesEmitted, 1);
  assert.equal(summary.winnersMissingBsp, 1);
  assert.ok(warnings.some((w) => w.includes('winner has no BSP')));
  const kilo = imp.races[0].runners.find((r) => r.horse_name === 'Kilo')!;
  assert.equal(kilo.status, 'ran'); // winner is never a non-runner
  assert.equal(kilo.finish_pos, 1);
  assert.equal(kilo.bsp_decimal, undefined);
  assert.equal(kilo.odds_decimal, undefined);
});

test('convertBspToImport: groups by composite key when EVENT_ID is absent', () => {
  const header =
    'EVENT_DT,MENU_HINT,EVENT_NAME,SELECTION_NAME,WIN_LOSE,BSP\n';
  const body = [
    '01-06-2026 14:30,GB / Ascot 1st Jun,1430 1m Stks,Alpha,1,3.5',
    '01-06-2026 14:30,GB / Ascot 1st Jun,1430 1m Stks,Bravo,0,2.5',
  ].join('\n');
  const { summary, import: imp } = convertBspToImport(parseCsv(header + body));
  assert.equal(summary.racesFound, 1);
  assert.equal(imp.races.length, 1);
  assert.equal(imp.races[0].runners.length, 2);
});

test('convertBspToImport: throws when an essential column is missing', () => {
  // No BSP column.
  const text = 'EVENT_DT,MENU_HINT,EVENT_NAME,SELECTION_NAME,WIN_LOSE\n01-06-2026 14:30,GB / Ascot 1st Jun,R,Alpha,1\n';
  assert.throws(() => convertBspToImport(parseCsv(text)), /missing required column/i);
});

test('convertBspToImport: output passes the loader validator and counts', () => {
  const { import: imp, summary } = convertBspToImport(parseCsv(MIXED));
  const result = validateImport(imp);
  assert.deepEqual(result.errors, []);
  assert.equal(result.hasPlaceholder, false);
  // Both emitted races have a priced field + exactly one winner -> countable.
  assert.equal(result.countable, summary.racesEmitted);
});
