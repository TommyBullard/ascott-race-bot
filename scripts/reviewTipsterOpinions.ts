/**
 * CLI: review extracted tipster OPINIONS against today's real runners.
 *
 * `tipsters:review-opinions` reads the opinions CSV, matches each runner to a
 * REAL runner in the target date/course races (read-only DB), and reports what
 * is matched / unmatched / unsupported / unknown-licence / eligible / blocked.
 * It also writes an `*-approved.csv` in the existing `import:tipster-selections`
 * format containing ONLY rows that are BOTH `review_status = approved` AND
 * eligible (matched + permitted licence + evidence + a real `selection` + a
 * permitted, non-synthetic source). Everything else is blocked from model-active
 * use.
 *
 * READ-ONLY: it issues only `select` reads, writes only the local `*-approved.csv`,
 * never the database, never the model, never a bet. Credentials are never logged.
 *
 * Usage:
 *   npm run tipsters:review-opinions -- --file data/tipster-opinions-2026-06-19-ascot.csv
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse, normalizeHorseName } from '../src/lib/raceSync';
import {
  parseOpinionRows,
  parseOpinionCsv,
  reviewOpinions,
  buildApprovedSelectionCsv,
} from '../src/lib/tipsterOpinions';
import { parseRegistryCsv } from '../src/lib/tipsterSourceRegistry';
import {
  isManualReviewHeader,
  parseManualReviewCsv,
  buildManualReviewReport,
} from '../src/lib/tipsterManualReview';

function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      /* next */
    }
  }
}

function parseArgs(argv: readonly string[]): { file?: string; date?: string; course?: string; registry?: string } {
  const args: { file?: string; date?: string; course?: string; registry?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = (argv[++i] ?? '').trim();
    else if (argv[i] === '--date') args.date = (argv[++i] ?? '').trim();
    else if (argv[i] === '--course') args.course = (argv[++i] ?? '').trim();
    else if (argv[i] === '--registry') args.registry = (argv[++i] ?? '').trim();
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('Usage: npm run tipsters:review-opinions -- --file <opinions.csv> [--date YYYY-MM-DD] [--course <name>]');
    process.exitCode = 1;
    return;
  }

  let text: string;
  try {
    text = readFileSync(args.file, 'utf8');
  } catch (err) {
    console.error(`Failed to read "${args.file}": ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  // Manual-review CSV (the operator's capture sheet) has its own header. Detect
  // it and run a PURE, READ-ONLY report: counts only, no DB, no writes, no import.
  const header = parseOpinionCsv(text).header;
  if (isManualReviewHeader(header)) {
    const mrRows = parseManualReviewCsv(text);
    const mr = buildManualReviewReport(mrRows);
    console.log(
      `Tipster MANUAL-REVIEW report (read-only) — ${mrRows[0]?.date || '?'} · ${mrRows[0]?.course || 'all courses'}`,
    );
    console.log('========================================================================');
    console.log(`Total rows                 : ${mr.total}`);
    console.log(`  pending                  : ${mr.pending}`);
    console.log(`  approved                 : ${mr.approved}`);
    console.log(`  rejected                 : ${mr.rejected}`);
    console.log(`  blocked (paid/login/unk) : ${mr.blocked}`);
    console.log(`  missing runner_name      : ${mr.missingRunnerName}`);
    console.log(`  missing race_name/time   : ${mr.missingRaceNameOrTime}`);
    console.log(`  missing evidence_excerpt : ${mr.missingEvidence}`);
    console.log(`  unknown/blocked licence  : ${mr.unknownOrBlockedLicence}`);
    console.log(`  model_active_eligible    : ${mr.modelActiveEligible}`);
    console.log(`  likely matchable         : ${mr.likelyMatchable}`);
    console.log(`  PR-family rows           : ${mr.prFamily}`);
    if (args.registry) {
      try {
        const reg = parseRegistryCsv(readFileSync(args.registry, 'utf8'));
        const byLabel = new Map(reg.map((r) => [r.source_label.toLowerCase().trim(), r.source_access_class]));
        console.log('\nSource access class (from registry):');
        for (const label of [...new Set(mrRows.map((r) => r.source_label))]) {
          console.log(`  - ${label}: ${byLabel.get(label.toLowerCase().trim()) ?? 'not-in-registry'}`);
        }
      } catch {
        console.log(`\n(registry "${args.registry}" could not be read — access class omitted)`);
      }
    }
    console.log('\n(read-only) Nothing imported, no database writes, no model run, no bets.');
    console.log(
      'Next: manually fill + approve rows, then build data/tipster-opinions-2026-06-19-ascot-approved.csv (import format).',
    );
    return;
  }

  const rows = parseOpinionRows(text);
  if (rows.length === 0) {
    console.error('No opinion rows found. Nothing to review.');
    process.exitCode = 1;
    return;
  }

  loadEnv();
  const date = args.date ?? rows.find((r) => r.date)?.date ?? '';
  const course = args.course ?? rows.find((r) => r.course)?.course ?? '';
  const wantCourse = course ? normalizeCourse(course) : null;

  // Read-only: today's races -> their runners -> a normalised name set.
  const matchedNames = new Set<string>();
  if (date) {
    const { data: raceRows } = await supabaseAdmin
      .from('races')
      .select('id, course')
      .eq('meeting_date', date);
    const raceIds = (raceRows ?? [])
      .filter((r) => !wantCourse || (r.course ? normalizeCourse(r.course) : '') === wantCourse)
      .map((r) => r.id);
    for (const raceId of raceIds) {
      const { data: runnerRows } = await supabaseAdmin
        .from('runners')
        .select('horse_name')
        .eq('race_id', raceId);
      for (const r of runnerRows ?? []) {
        if (r.horse_name) matchedNames.add(normalizeHorseName(r.horse_name));
      }
    }
  }

  const report = reviewOpinions(rows, matchedNames);

  console.log(`Tipster opinion review (read-only) — ${date || '?'} · ${course || 'all courses'}`);
  console.log('========================================================================');
  console.log(`Opinions: ${report.total}`);
  console.log(`  matched runners        : ${report.matched}`);
  console.log(`  unmatched runners      : ${report.unmatched}`);
  console.log(`  unknown-licence rows   : ${report.unknownLicence}`);
  console.log(`  unsupported sources    : ${report.unsupportedSources}`);
  console.log(`  rows without evidence  : ${report.withoutEvidence}`);
  console.log(`  synthetic profiles     : ${report.syntheticProfiles}`);
  console.log(`  eligible for approval  : ${report.eligibleForApproval}`);
  console.log(`  approved + model-active: ${report.approvedModelActive}`);
  console.log(`  blocked from model-use : ${report.blockedFromModelActive}`);
  console.log(`  correlation-capped     : ${report.correlationCapped}`);
  for (const w of report.correlationWarnings) console.log(`  PR-family warning: ${w}`);

  // Optional: per-source access class from the registry (read-only).
  if (args.registry) {
    try {
      const reg = parseRegistryCsv(readFileSync(args.registry, 'utf8'));
      const byLabel = new Map(reg.map((r) => [r.source_label.toLowerCase().trim(), r.source_access_class]));
      const labels = [...new Set(rows.map((r) => r.source_label))];
      console.log('\nSource access class (from registry):');
      for (const label of labels) {
        const cls = byLabel.get(label.toLowerCase().trim()) ?? 'not-in-registry';
        console.log(`  - ${label}: ${cls}`);
      }
    } catch {
      console.log(`\n(registry "${args.registry}" could not be read — access class omitted)`);
    }
  }

  // Show why blocked rows are blocked (first 20).
  const blocked = report.perRow.filter((p) => !p.classification.modelActive);
  if (blocked.length > 0) {
    console.log('\nBlocked rows (not model-active):');
    for (const { row, classification } of blocked.slice(0, 20)) {
      console.log(`  - ${row.runner_name} [${row.source_label}]: ${classification.blockReasons.join('; ') || 'not approved yet'}`);
    }
  }

  // Write the approved selections CSV (only approved + eligible rows).
  const approvedPath = args.file.replace(/\.csv$/i, '') + '-approved.csv';
  mkdirSync(dirname(approvedPath), { recursive: true });
  writeFileSync(approvedPath, buildApprovedSelectionCsv(report), 'utf8');
  console.log(`\nApproved selections CSV (${report.approvedModelActive} row(s)) -> ${approvedPath}`);
  console.log('Import only when it contains REAL approved rows:');
  console.log(`  npm run import:tipster-selections -- --file ${approvedPath} --commit`);
  console.log('(read-only) No database writes, no model run, no bets.');
}

main().catch((err) => {
  console.error(`tipsters:review-opinions failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
