/**
 * CLI: extract tipster OPINIONS from LOCAL notes into a reviewable CSV.
 *
 * `tipsters:extract-opinions` reads a LOCAL JSON notes file (structured,
 * operator- or GenAI-PREPARED) and writes the opinions CSV. It is the safe
 * extraction GATE:
 *
 *   - LOCAL FILES ONLY. It never fetches a URL, never scrapes, never bypasses a
 *     paywall, and never browses. It reads exactly the file you pass.
 *   - EVIDENCE-GROUNDED, NEVER GUESSES. Every opinion must carry an
 *     `evidence_excerpt`; when a note includes `source_text`, the excerpt must be
 *     a verbatim substring of it. Ungrounded / evidence-less opinions are
 *     dropped — the tool never invents a selection (so a model cannot fabricate
 *     one either). It does NOT call OpenAI to guess picks.
 *   - PENDING ON OUTPUT. Every emitted row is `review_status = 'pending'` with an
 *     unknown licence kept as `unknown` (blocked from model-active until a human
 *     reviews it). Synthetic strategy profiles (e.g. "What Would Jon Vine Do")
 *     are labelled and never treated as a real sourced tipster.
 *
 * Usage:
 *   npm run tipsters:extract-opinions -- --input data/tipster-notes-2026-06-19-ascot.json \
 *     --output data/tipster-opinions-2026-06-19-ascot.csv
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  extractOpinions,
  serializeOpinionCsv,
  type TipsterNotesFile,
} from '../src/lib/tipsterOpinions';

function parseArgs(argv: readonly string[]): { input?: string; output?: string } {
  const args: { input?: string; output?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') args.input = (argv[++i] ?? '').trim();
    else if (argv[i] === '--output') args.output = (argv[++i] ?? '').trim();
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output) {
    console.error(
      'Usage: npm run tipsters:extract-opinions -- --input <notes.json> --output <opinions.csv>\n' +
        '(LOCAL files only; no scraping, no paywall bypass, no OpenAI guessing; every opinion needs evidence.)',
    );
    process.exitCode = 1;
    return;
  }

  let raw: string;
  try {
    raw = readFileSync(args.input, 'utf8');
  } catch (err) {
    console.error(`Failed to read local notes file "${args.input}": ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  let file: TipsterNotesFile;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as TipsterNotesFile).notes)) {
      throw new Error('expected { "notes": [ ... ] }');
    }
    file = parsed as TipsterNotesFile;
  } catch (err) {
    console.error(`Invalid notes JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const { rows, audit, warnings } = extractOpinions(file);

  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, serializeOpinionCsv(rows), 'utf8');

  console.log(`Tipster opinion extraction (LOCAL only; no scraping; evidence-grounded) -> ${args.output}`);
  console.log('Audit:');
  for (const [k, v] of Object.entries(audit)) console.log(`  ${k}: ${v}`);
  if (warnings.length > 0) {
    console.log('\nDropped (never guessed):');
    for (const w of warnings.slice(0, 50)) console.log(`  - ${w}`);
  }
  console.log(
    '\nAll rows are review_status=pending. Review next:\n' +
      `  npm run tipsters:review-opinions -- --file ${args.output}`,
  );
}

main();
