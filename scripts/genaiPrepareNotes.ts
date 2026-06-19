/**
 * CLI (LOCAL, MANUAL): GenAI note intake. Turns an operator-supplied LOCAL JSON
 * note document into a deterministic Markdown PREVIEW (and an optional normalised
 * JSON), so it can LATER feed a separate, not-yet-active GenAI commentary step.
 *
 * STRICTLY LOCAL + INERT. It reads ONE local JSON file and writes local files
 * only. It makes NO database access, NO network calls, NO scraping, and NO
 * GenAI/LLM calls. It changes no model / staking / ranking / recommendation logic
 * and never predicts a winner — the output is shadow-only evidence prep, not
 * betting advice.
 *
 * Usage:
 *   npm run genai:prepare-notes -- --input data/race-notes/example.json \
 *     --output reports/genai-note-preview.md [--json reports/genai-note-preview.json]
 *
 * Exit code: 0 when the document is usable (it may carry soft warnings); 1 when
 * the input is unreadable / invalid JSON, or the document has hard errors.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  assessGenaiNoteSource,
  renderGenaiNotePreview,
} from '../src/lib/genaiSourceReview';

/** Parses `--input`, `--output` (Markdown) and optional `--json` (normalised). */
function parseArgs(argv: readonly string[]): {
  input?: string;
  output?: string;
  json?: string;
} {
  const args: { input?: string; output?: string; json?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') args.input = v;
    } else if (a === '--output') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') args.output = v;
    } else if (a === '--json') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') args.json = v;
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error(
      'Usage: npm run genai:prepare-notes -- --input <notes.json> [--output <preview.md>] [--json <normalised.json>]\n' +
        '(local-only intake; reads one local JSON note document, writes a Markdown preview; no DB, no network, no GenAI).',
    );
    process.exitCode = 1;
    return;
  }

  let text: string;
  try {
    text = readFileSync(args.input, 'utf8');
  } catch (err) {
    console.error(
      `Failed to read input file "${args.input}": ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error(
      `Input file "${args.input}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  const assessment = assessGenaiNoteSource(parsed);
  const markdown = renderGenaiNotePreview(assessment);

  // Write the Markdown preview (or print it when no --output is given).
  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, markdown, 'utf8');
    console.log(`GenAI note preview written (local only): ${args.output}`);
  } else {
    console.log(markdown);
  }

  // Optional normalised JSON (the serialisable assessment) for later extraction.
  if (args.json) {
    mkdirSync(dirname(args.json), { recursive: true });
    writeFileSync(args.json, `${JSON.stringify(assessment, null, 2)}\n`, 'utf8');
    console.log(`Normalised JSON written (local only): ${args.json}`);
  }

  console.log(
    `  ready for extraction: ${assessment.ready_for_extraction ? 'yes' : 'no'} · ` +
      `licence: ${assessment.licence_policy} · errors: ${assessment.errors.length} · warnings: ${assessment.warnings.length}`,
  );

  // Fail the command only when the document is unusable as-is (hard errors).
  if (assessment.errors.length > 0) {
    process.exitCode = 1;
  }
}

main();
