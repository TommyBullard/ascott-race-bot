/**
 * CLI (OFFLINE, LOCAL): ML PROMOTION AUDIT.
 *
 * Reads an exported `export:training-data` CSV from a LOCAL path and writes a
 * deterministic Markdown promotion audit: per-baseline win + place/top-4 rates,
 * segment performance (confidence / data quality / tipster consensus / no-bet
 * gate), a calibration summary, feature-importance HINTS, a 0-100 readiness
 * score, and a GO / NO-GO verdict that DEFAULTS TO NO-GO.
 *
 * STRICTLY OFFLINE + READ-ONLY-TO-EVERYTHING-ELSE. It TRAINS NO model, persists
 * nothing, activates no ML, changes no live recommendation, probability, EV,
 * stake, or ranking, calls NO external API, uses NO ML library, and makes NO
 * database access. The only write is the local Markdown report.
 *
 * Usage:
 *   npm run ml:promotion-audit -- --input data/exports/training-data-2026-06-16-to-2026-06-18-ascot.csv
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  parseCsv,
  buildMlPromotionAudit,
  buildPromotionAuditPath,
  renderMlPromotionAuditMarkdown,
} from '../src/lib/mlPromotionAudit';

function parseArgs(argv: readonly string[]): { input?: string; output?: string } {
  const args: { input?: string; output?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') args.input = v;
    } else if (a === '--output') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') args.output = v;
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error(
      'Usage: npm run ml:promotion-audit -- --input <training-data.csv> [--output <report.md>]\n' +
        '(offline promotion audit; reads a local CSV, writes a Markdown report, trains no model, changes nothing live).',
    );
    process.exitCode = 1;
    return;
  }

  let text: string;
  try {
    text = readFileSync(args.input, 'utf8');
  } catch (err) {
    console.error(`Failed to read input file "${args.input}": ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const parsed = parseCsv(text);
  if (parsed.header.length === 0) {
    console.error('Input CSV is empty or has no header. Nothing to audit.');
    process.exitCode = 1;
    return;
  }

  const audit = buildMlPromotionAudit(parsed, args.input, new Date().toISOString());
  const markdown = renderMlPromotionAuditMarkdown(audit);

  const outPath = args.output ?? buildPromotionAuditPath(audit.dates, audit.courses);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, 'utf8');

  console.log(`ML promotion audit written (offline; no model trained, nothing live changed): ${outPath}`);
  console.log(
    `  verdict: ${audit.verdict} · readiness: ${audit.readiness_score}/100 · ` +
      `leakage: ${audit.leakage.status} · settled races: ${audit.settled_race_count}`,
  );
}

main();
