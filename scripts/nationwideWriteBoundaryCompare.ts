/**
 * CLI (READ-ONLY, no database at all): compare a before/after nationwide
 * write-boundary evidence pair.
 *
 * Reads two local JSON evidence files produced by
 * `npm run audit:nationwide-write-boundary -- … --report` and prints the
 * per-category delta with a PASS / REVIEW / FAIL verdict:
 *
 *   PASS   — every FORBIDDEN category has a conclusive ZERO delta.
 *   REVIEW — a category could not be conclusively compared (missing table,
 *            failed query, unscopable). A non-comparable category is NEVER
 *            treated as zero, so it can never silently produce a PASS.
 *   FAIL   — any forbidden category changed (an increase means the run wrote
 *            rows it must never write; a decrease is surfaced too, never
 *            silently passed), or the two files are structurally incompatible.
 *
 * Usage:
 *   npm run audit:nationwide-write-boundary:compare -- --before <path> --after <path> [--report] [--json]
 *
 * This command opens no database connection, calls no provider, runs no model,
 * performs no claim operation, and has no --commit flag. The only optional
 * write is the local Markdown comparison report under `reports/`.
 *
 * Decision-support only — nothing here places a bet.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildComparisonMarkdownPath,
  compareWriteBoundaryEvidence,
  renderComparisonConsole,
  renderComparisonMarkdown,
  WRITE_BOUNDARY_CATEGORIES,
  type WriteBoundaryEvidence,
} from '../src/lib/nationwideWriteBoundaryAudit';

export interface CompareArgs {
  before: string | null;
  after: string | null;
  report: boolean;
  json: boolean;
  error: string | null;
}

/** Pure argument parsing. Both paths are required; nothing is inferred. */
export function parseCompareArgs(argv: readonly string[]): CompareArgs {
  const out: CompareArgs = { before: null, after: null, report: false, json: false, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--before') {
      out.before = argv[i + 1] ?? null;
      i += 1;
      if (!out.before) out.error = '--before requires a file path';
    } else if (arg === '--after') {
      out.after = argv[i + 1] ?? null;
      i += 1;
      if (!out.after) out.error = '--after requires a file path';
    } else if (arg === '--report') {
      out.report = true;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--commit') {
      out.error = 'this command is read-only and has no --commit flag';
    } else if (arg.startsWith('--')) {
      out.error = `unknown flag ${arg}`;
    }
  }
  return out;
}

/**
 * Validates that a parsed object is a usable evidence snapshot. Pure. A file
 * that is not recognisable evidence is REJECTED rather than being coerced into
 * a comparison with zeros.
 */
export function parseEvidenceFile(raw: string, label: string): WriteBoundaryEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label}: not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${label}: not a JSON object`);
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.date !== 'string' || (obj.label !== 'before' && obj.label !== 'after')) {
    throw new Error(`${label}: missing a valid "date" and "label" — this is not a write-boundary evidence file`);
  }
  if (!Array.isArray(obj.categories)) throw new Error(`${label}: missing the "categories" array`);
  const ids = new Set((obj.categories as { id?: unknown }[]).map((c) => String(c?.id)));
  const missing = WRITE_BOUNDARY_CATEGORIES.filter((c) => !ids.has(c.id)).map((c) => c.id);
  if (missing.length > 0) {
    throw new Error(`${label}: evidence is missing categories: ${missing.join(', ')}`);
  }
  if (!Array.isArray(obj.invariant_violations)) throw new Error(`${label}: missing "invariant_violations"`);
  return parsed as WriteBoundaryEvidence;
}

const USAGE =
  'Usage: npm run audit:nationwide-write-boundary:compare -- --before <path> --after <path> [--report] [--json]\n' +
  '(Reads two local evidence JSON files. No database, no provider call, no model run, no claim operation,\n' +
  'no --commit flag.)';

function main(): void {
  const args = parseCompareArgs(process.argv.slice(2));
  if (args.error || !args.before || !args.after) {
    console.error(args.error ? `Error: ${args.error}\n\n${USAGE}` : USAGE);
    process.exitCode = 1;
    return;
  }

  let before: WriteBoundaryEvidence;
  let after: WriteBoundaryEvidence;
  try {
    before = parseEvidenceFile(readFileSync(args.before, 'utf8'), `--before (${args.before})`);
    after = parseEvidenceFile(readFileSync(args.after, 'utf8'), `--after (${args.after})`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const comparison = compareWriteBoundaryEvidence(before, after, new Date().toISOString());

  if (args.json) {
    console.log(JSON.stringify(comparison, null, 2));
  } else {
    for (const line of renderComparisonConsole(comparison)) console.log(line);
  }

  if (args.report) {
    const outPath = buildComparisonMarkdownPath(comparison.date);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, renderComparisonMarkdown(comparison), 'utf8');
    if (!args.json) console.log(`\nComparison written (no database was contacted): ${outPath}`);
  }

  if (comparison.verdict === 'FAIL') process.exitCode = 2;
  else if (comparison.verdict === 'REVIEW') process.exitCode = 3;
}

const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  }
}
