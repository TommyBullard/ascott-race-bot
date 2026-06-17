/**
 * CLI (LOCAL, SHADOW-ONLY): validate / normalise an already-provided GenAI
 * note-extraction JSON and render a Markdown preview. Phase 3 of the autonomous
 * race-day workflow.
 *
 * It reads a LOCAL input file, validates the source document + extracted features
 * against the shadow-layer schema, prints a clear operator summary, writes a
 * deterministic Markdown preview, and optionally writes a normalised JSON file.
 *
 * STRICTLY LOCAL + READ-ONLY-TO-THE-MODEL. It calls NO external API (no GenAI,
 * no Racing API, no Betfair), makes NO database access, and never influences the
 * model: extracted features are shadow-only (model_active must be false). The
 * only writes are the local preview/JSON files. It prints no secrets.
 *
 * Usage:
 *   npm run extract:notes -- --input data/note-extractions/example-notes.json --output reports/note-extraction-preview.md
 *   npm run extract:notes -- --input <in.json> --output <preview.md> --json <normalised.json>
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  parseExtractNotesArgs,
  validateNoteExtraction,
  renderNoteExtractionMarkdown,
} from '../src/lib/noteFeatureExtraction';

function main(): void {
  const args = parseExtractNotesArgs(process.argv.slice(2));
  if (!args.input) {
    console.error(
      'Usage: npm run extract:notes -- --input <file.json> [--output <preview.md>] [--json <normalised.json>]\n' +
        '(local + shadow-only; no external API, no database, never model-active).',
    );
    process.exitCode = 1;
    return;
  }

  // Read the LOCAL input file only. No network, no database.
  let rawText: string;
  try {
    rawText = readFileSync(args.input, 'utf8');
  } catch (err) {
    console.error(`Failed to read input file "${args.input}": ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    console.error(`Input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const result = validateNoteExtraction(parsed);

  console.log(`GenAI note-extraction preview (SHADOW) — input ${args.input}`);
  console.log(`  external API calls: none · database writes: none · model_active: false (shadow-only)`);
  console.log(`  validation: ${result.ok ? 'PASS' : 'FAIL'} · errors: ${result.errors.length} · warnings: ${result.warnings.length}`);

  if (result.warnings.length > 0) {
    console.log('  warnings:');
    for (const w of result.warnings) console.log(`    - ${w.path}: ${w.message}`);
  }

  if (!result.ok || !result.normalized) {
    console.error('  errors:');
    for (const e of result.errors) console.error(`    - ${e.path}: ${e.message}`);
    console.error('\nRefusing to render a preview: fix the extraction input and retry. Nothing was written.');
    process.exitCode = 1;
    return;
  }

  const markdown = renderNoteExtractionMarkdown(result.normalized);

  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, markdown, 'utf8');
    console.log(`  preview written: ${args.output}`);
  } else {
    console.log('\n' + markdown);
  }

  if (args.jsonOut) {
    mkdirSync(dirname(args.jsonOut), { recursive: true });
    writeFileSync(args.jsonOut, JSON.stringify(result.normalized, null, 2) + '\n', 'utf8');
    console.log(`  normalised JSON written: ${args.jsonOut}`);
  }

  console.log(
    `  features: ${result.normalized.extracted_features.length} (all model_active: false, review-pending until approved)`,
  );
}

main();
