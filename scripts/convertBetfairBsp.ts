/**
 * ONE-OFF converter: Betfair BSP results CSV -> historical-races import JSON.
 *
 * Reads a downloaded Betfair SP win file (e.g. dwbfpricesukwin01062026.csv) and
 * produces the JSON that `npm run load:races` consumes. PURE mapping lives in
 * `src/lib/betfairBsp.ts`; this script only does file I/O + reporting.
 *
 * DRY RUN BY DEFAULT: prints the detected column mapping, a conversion summary,
 * skip reasons, and a preview of the first emitted race. It writes a file ONLY
 * when you pass `--out <path>`. It NEVER touches the database (that is a
 * separate, also-guarded step: `npm run load:races`).
 *
 * NO FABRICATION: every value is taken from the CSV; missing data is null/omitted.
 * Non-runners are flagged, and void/dead-heat markets are skipped, not invented.
 *
 * Usage:
 *   npm run convert:bsp -- --file dwbfpricesukwin01062026.csv                 # dry run
 *   npm run convert:bsp -- --file dwbfpricesukwin01062026.csv --out data/historical-races.json
 *   npm run convert:bsp -- --file <csv> --quote ppwap                         # realistic quote
 *   (optional)            --country GB
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  convertBspToImport,
  parseCsv,
  resolveColumns,
  ESSENTIAL_COLUMNS,
  type QuoteSource,
} from '../src/lib/betfairBsp';

interface Args {
  file?: string;
  out?: string;
  quote: QuoteSource;
  country: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { quote: 'bsp', country: 'GB' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--quote') {
      const v = argv[++i];
      if (v === 'bsp' || v === 'ppwap') args.quote = v;
      else {
        console.error(`Invalid --quote "${v}" (expected bsp|ppwap).`);
        process.exit(1);
      }
    } else if (a === '--country') args.country = argv[++i] ?? 'GB';
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error(
      'Usage: npm run convert:bsp -- --file <betfair_bsp.csv> [--out <path.json>] ' +
        '[--quote bsp|ppwap] [--country GB]',
    );
    process.exit(1);
  }

  let text: string;
  try {
    text = readFileSync(args.file, 'utf8');
  } catch (err) {
    console.error(`Failed to read ${args.file}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const parsed = parseCsv(text);

  console.log('');
  console.log('=== Betfair BSP -> historical import converter ===');
  console.log(`File: ${args.file}`);
  console.log(`Mode: ${args.out ? `WRITE -> ${args.out}` : 'DRY RUN (no file written)'}`);
  console.log(`Quote source: ${args.quote}${args.quote === 'bsp' ? ' (OPTIMISTIC — BSP is only known after the off)' : ''}`);
  console.log('');

  // Transparency: show how the file's header mapped to logical columns.
  const cols = resolveColumns(parsed.header);
  console.log('Detected columns:');
  for (const key of ['eventId', 'eventDt', 'menuHint', 'eventName', 'selectionName', 'winLose', 'bsp', 'ppwap'] as const) {
    const essential = (ESSENTIAL_COLUMNS as string[]).includes(key);
    const found = cols[key];
    console.log(`  ${key.padEnd(14)} ${found ? `-> "${found}"` : `(not found)${essential ? ' [REQUIRED]' : ''}`}`);
  }
  console.log('');

  let result;
  try {
    result = convertBspToImport(parsed, { quoteSource: args.quote, fallbackCountry: args.country });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const s = result.summary;
  console.log(
    `Rows: ${s.totalRows} | races found: ${s.racesFound} | emitted: ${s.racesEmitted} | ` +
      `skipped: ${s.racesSkipped}`,
  );
  console.log(
    `  runners emitted: ${s.runnersEmitted} (non-runners: ${s.nonRunners}) | ` +
      `void/abandoned skipped: ${s.voidMarkets} | dead heats skipped: ${s.deadHeats} | ` +
      `winners missing BSP: ${s.winnersMissingBsp}`,
  );

  if (s.skipped.length > 0) {
    console.log('');
    console.log(`Skipped races (${s.skipped.length}):`);
    for (const sk of s.skipped.slice(0, 20)) console.log(`  - [${sk.reason}] ${sk.label}`);
    if (s.skipped.length > 20) console.log(`  ... and ${s.skipped.length - 20} more`);
  }

  if (result.warnings.length > 0) {
    console.log('');
    console.log(`Warnings (${result.warnings.length}):`);
    for (const w of result.warnings.slice(0, 20)) console.log(`  - ${w}`);
    if (result.warnings.length > 20) console.log(`  ... and ${result.warnings.length - 20} more`);
  }

  // Preview the first emitted race so the mapping can be eyeballed.
  const preview = result.import.races[0];
  if (preview) {
    console.log('');
    console.log('Preview (first emitted race):');
    console.log(JSON.stringify(preview, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
  }

  if (!args.out) {
    console.log('');
    console.log('DRY RUN — no file written. Re-run with --out <path.json> to write,');
    console.log('then validate/load with: npm run load:races -- --file <path.json>');
    return;
  }

  if (result.import.races.length === 0) {
    console.error('\nRefusing to write: 0 races emitted.');
    process.exit(1);
  }

  const payload = {
    _note:
      'Generated from a Betfair BSP file by scripts/convertBetfairBsp.ts. ' +
      `quote_type reflects --quote=${args.quote}. ` +
      'Only the winner has finish_pos=1 (BSP files carry win/lose, not full order). ' +
      'No tipster_selections (Path A: engine validation on market prices only).',
    ...result.import,
  };
  try {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error(`Failed to write ${args.out}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  console.log('');
  console.log(`Wrote ${result.import.races.length} race(s) -> ${args.out}`);
  console.log(`Next: npm run load:races -- --file ${args.out}   (dry run; add --commit to write to DB)`);
}

main();
