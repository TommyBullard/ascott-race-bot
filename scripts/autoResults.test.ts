/**
 * Unit tests for the pure automated result-settlement helpers
 * (src/lib/autoResults.ts) and a read-only guard for the script
 * (scripts/autoResults.ts).
 *
 * No DB, no network, no secrets: synthetic audits exercise the source-status
 * classification, the strict settlement safety gate, the manual fallback command
 * + message, and the deterministic operator summary. One test feeds the manual
 * importer's own `detectRaceConflicts` / `raceHasWinner` into the safety gate to
 * prove the standards align. Sanity tests scan the source to prove the tool
 * performs no DB writes (SELECT-only reads via Supabase, never mutations). Run:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { detectRaceConflicts, raceHasWinner } from './importResultsCsv';
import {
  parseAutoResultsArgs,
  mapResultsAccessCategory,
  isSourceAvailable,
  isPlanBlocked,
  evaluateSettlementSafety,
  buildManualImportCommand,
  renderAutoResultsSummary,
  FALLBACK_REQUIRED_MESSAGE,
  RESULTS_SOURCE_LABEL,
  type SettlementAudit,
  type AutoResultsReport,
} from '../src/lib/autoResults';

/** A clean, committable audit; override individual fields to test each gate. */
function cleanAudit(over: Partial<SettlementAudit> = {}): SettlementAudit {
  return {
    source_status: 'available',
    results_official_confirmed: true,
    partial: false,
    unmatched_races: 0,
    unmatched_runners: 0,
    ambiguous_rows: 0,
    has_winner: true,
    duplicate_winner_conflict: false,
    would_overwrite_nonnull_with_null: false,
    ...over,
  };
}

/** A plan-blocked dry-run report (mirrors the script's current-plan output). */
function report(over: Partial<AutoResultsReport> = {}): AutoResultsReport {
  const safety = evaluateSettlementSafety(cleanAudit({ source_status: 'plan_blocked' }));
  return {
    date: '2026-06-16',
    course: 'Ascot',
    source_attempted: RESULTS_SOURCE_LABEL,
    source_status: 'plan_blocked',
    status_detail: 'BLOCKER: Standard Plan required',
    commit_requested: false,
    audit: null,
    safety,
    fallback_required: !safety.canCommit,
    manual_import_command: buildManualImportCommand('2026-06-16', 'Ascot'),
    ...over,
  };
}

/* --------------------------- status classification ------------------------ */

test('mapResultsAccessCategory: plan-block, missing creds, unauthorized, rate-limited, unknown', () => {
  assert.equal(mapResultsAccessCategory('standard_plan_required'), 'plan_blocked');
  assert.equal(mapResultsAccessCategory('missing_credentials'), 'missing_credentials');
  assert.equal(mapResultsAccessCategory('unauthorized'), 'unauthorized');
  assert.equal(mapResultsAccessCategory('rate_limited'), 'rate_limited');
  assert.equal(mapResultsAccessCategory('other'), 'unavailable');
  assert.equal(mapResultsAccessCategory('something-new'), 'unavailable'); // unknown -> safe
});

test('isSourceAvailable / isPlanBlocked', () => {
  assert.equal(isSourceAvailable('available'), true);
  assert.equal(isSourceAvailable('plan_blocked'), false);
  assert.equal(isPlanBlocked('plan_blocked'), true);
  assert.equal(isPlanBlocked('available'), false);
});

/* ------------------------------- arg parsing ------------------------------ */

test('parseAutoResultsArgs: date/course/commit; dry-run by default; blank ignored', () => {
  const a = parseAutoResultsArgs(['--date', '2026-06-16', '--course', 'Ascot', '--commit']);
  assert.equal(a.date, '2026-06-16');
  assert.equal(a.course, 'Ascot');
  assert.equal(a.commit, true);

  const b = parseAutoResultsArgs(['--date', '2026-06-16']);
  assert.equal(b.commit, false); // dry-run by default
  assert.equal(b.course, undefined);

  assert.equal(parseAutoResultsArgs(['--course', '   ', '--date', '2026-06-16']).course, undefined);
});

/* --------------------------- fallback messaging --------------------------- */

test('FALLBACK_REQUIRED_MESSAGE: exact operator wording', () => {
  assert.equal(FALLBACK_REQUIRED_MESSAGE, 'automated results unavailable \u2014 manual CSV fallback required');
});

test('buildManualImportCommand: matches the importer file convention; slugs course', () => {
  assert.equal(
    buildManualImportCommand('2026-06-16', 'Ascot'),
    'npm run import:results -- --file data/results-2026-06-16-ascot.csv',
  );
  assert.equal(
    buildManualImportCommand('2026-06-16', 'Royal Ascot'),
    'npm run import:results -- --file data/results-2026-06-16-royal-ascot.csv',
  );
  assert.equal(
    buildManualImportCommand('2026-06-16'),
    'npm run import:results -- --file data/results-2026-06-16.csv',
  );
});

/* ------------------------------ safety gate ------------------------------- */

test('evaluateSettlementSafety: a clean, available, official audit allows commit', () => {
  const s = evaluateSettlementSafety(cleanAudit());
  assert.equal(s.canCommit, true);
  assert.deepEqual(s.blockers, []);
});

test('evaluateSettlementSafety: plan-blocked source refuses commit (fallback required)', () => {
  const s = evaluateSettlementSafety(cleanAudit({ source_status: 'plan_blocked' }));
  assert.equal(s.canCommit, false);
  assert.ok(s.blockers.some((b) => /plan_blocked/.test(b)));
});

test('evaluateSettlementSafety: missing_credentials source refuses commit (safe)', () => {
  assert.equal(evaluateSettlementSafety(cleanAudit({ source_status: 'missing_credentials' })).canCommit, false);
});

test('evaluateSettlementSafety: unavailable source refuses commit (safe)', () => {
  assert.equal(evaluateSettlementSafety(cleanAudit({ source_status: 'unavailable' })).canCommit, false);
});

test('evaluateSettlementSafety: refuses when unmatched runners exist', () => {
  const s = evaluateSettlementSafety(cleanAudit({ unmatched_runners: 2 }));
  assert.equal(s.canCommit, false);
  assert.ok(s.blockers.some((b) => /unmatched_runners/.test(b)));
});

test('evaluateSettlementSafety: refuses when ambiguous rows exist', () => {
  const s = evaluateSettlementSafety(cleanAudit({ ambiguous_rows: 1 }));
  assert.equal(s.canCommit, false);
  assert.ok(s.blockers.some((b) => /ambiguous_rows/.test(b)));
});

test('evaluateSettlementSafety: refuses when unmatched races exist', () => {
  assert.equal(evaluateSettlementSafety(cleanAudit({ unmatched_races: 1 })).canCommit, false);
});

test('evaluateSettlementSafety: refuses when there is no winner', () => {
  const s = evaluateSettlementSafety(cleanAudit({ has_winner: false }));
  assert.equal(s.canCommit, false);
  assert.ok(s.blockers.some((b) => /no winner/.test(b)));
});

test('evaluateSettlementSafety: refuses on a duplicate winner conflict', () => {
  const s = evaluateSettlementSafety(cleanAudit({ duplicate_winner_conflict: true }));
  assert.equal(s.canCommit, false);
  assert.ok(s.blockers.some((b) => /duplicate winner/.test(b)));
});

test('evaluateSettlementSafety: refuses partial / unconfirmed results', () => {
  assert.equal(evaluateSettlementSafety(cleanAudit({ partial: true })).canCommit, false);
  assert.equal(evaluateSettlementSafety(cleanAudit({ results_official_confirmed: false })).canCommit, false);
});

test('evaluateSettlementSafety: refuses overwriting a non-null result with null', () => {
  const s = evaluateSettlementSafety(cleanAudit({ would_overwrite_nonnull_with_null: true }));
  assert.equal(s.canCommit, false);
  assert.ok(s.blockers.some((b) => /overwrite a non-null/.test(b)));
});

test('evaluateSettlementSafety: commit allowed ONLY when official/confirmed and clean', () => {
  assert.equal(evaluateSettlementSafety(cleanAudit()).canCommit, true);
  // Flipping any single gate refuses commit:
  assert.equal(evaluateSettlementSafety(cleanAudit({ results_official_confirmed: false })).canCommit, false);
  assert.equal(evaluateSettlementSafety(cleanAudit({ has_winner: false })).canCommit, false);
  assert.equal(evaluateSettlementSafety(cleanAudit({ partial: true })).canCommit, false);
});

/* -------------------- reuse of the importer safety logic ------------------ */

test('reuse: importer detectRaceConflicts / raceHasWinner feed the same safety decision', () => {
  // Two winners -> the importer flags a conflict AND a winner is present.
  const twoWinners = [
    { runnerId: 'a', finishPos: 1 },
    { runnerId: 'b', finishPos: 1 },
    { runnerId: 'c', finishPos: 3 },
  ];
  assert.equal(detectRaceConflicts(twoWinners).conflicted, true);
  assert.equal(raceHasWinner(twoWinners), true);
  const conflictAudit = cleanAudit({
    has_winner: raceHasWinner(twoWinners),
    duplicate_winner_conflict: detectRaceConflicts(twoWinners).reasons.some((r) => /finish_pos=1/.test(r)),
  });
  assert.equal(evaluateSettlementSafety(conflictAudit).canCommit, false); // duplicate winner blocks

  // A single clean winner -> no conflict + a winner -> allowed (rest clean).
  const oneWinner = [
    { runnerId: 'a', finishPos: 1 },
    { runnerId: 'b', finishPos: 2 },
  ];
  assert.equal(detectRaceConflicts(oneWinner).conflicted, false);
  assert.equal(raceHasWinner(oneWinner), true);
  assert.equal(evaluateSettlementSafety(cleanAudit({ has_winner: true, duplicate_winner_conflict: false })).canCommit, true);

  // No winner -> the importer reports no winner -> refused.
  const noWinner = [{ runnerId: 'a', finishPos: 2 }];
  assert.equal(raceHasWinner(noWinner), false);
  assert.equal(evaluateSettlementSafety(cleanAudit({ has_winner: false })).canCommit, false);
});

/* -------------------------- operator summary render ----------------------- */

test('render: includes date/course/source/status and the fallback + manual command', () => {
  const out = renderAutoResultsSummary(report());
  assert.match(out, /date: 2026-06-16/);
  assert.match(out, /course: Ascot/);
  assert.match(out, /result source attempted: The Racing API \/v1\/results/);
  assert.match(out, /source status: plan_blocked/);
  assert.match(out, /automated results unavailable \u2014 manual CSV fallback required/);
  assert.match(out, /manual fallback: npm run import:results -- --file data\/results-2026-06-16-ascot\.csv/);
  assert.match(out, /commit allowed: no/);
});

test('render: a clean, allowed report shows no fallback line', () => {
  const audit = cleanAudit();
  const safety = evaluateSettlementSafety(audit);
  const out = renderAutoResultsSummary(
    report({ source_status: 'available', audit, safety, fallback_required: false, status_detail: null }),
  );
  assert.equal(/manual CSV fallback required/.test(out), false);
  assert.match(out, /commit allowed: yes/);
});

test('render: a missing audit renders an em dash, never fabricated', () => {
  const out = renderAutoResultsSummary(report({ audit: null }));
  assert.match(out, /dry-run audit: \u2014 \(no official result payload available\)/);
});

test('render: is deterministic (same report -> identical string)', () => {
  const r = report();
  assert.equal(renderAutoResultsSummary(r), renderAutoResultsSummary(r));
});

test('render: does not leak env/secret-looking content (sanity)', () => {
  const out = renderAutoResultsSummary(report());
  assert.equal(/SERVICE_ROLE|BEGIN [A-Z ]*PRIVATE KEY|SUPABASE_URL|CRON_SECRET|RACING_API_KEY/.test(out), false);
});

/* ----------------------- read-only guards (source scan) ------------------- */

test('no DB writes: the auto-results script performs SELECT-only reads, never mutations', () => {
  const src = readFileSync('scripts/autoResults.ts', 'utf8');
  assert.equal(/\.insert\s*\(/.test(src), false);
  assert.equal(/\.update\s*\(/.test(src), false);
  assert.equal(/\.upsert\s*\(/.test(src), false);
  assert.equal(/\.delete\s*\(/.test(src), false);
  assert.equal(/\.rpc\s*\(/.test(src), false);
  // It DOES read (SELECT-only) to match results to stored races/runners.
  assert.ok(/\.select\s*\(/.test(src));
});

test('no DB access: the pure helper module never imports a DB client, fs, or env', () => {
  const src = readFileSync('src/lib/autoResults.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(src), false);
  assert.equal(/node:fs/.test(src), false);
  assert.equal(/process\.env/.test(src), false);
});
