/**
 * Tests for the compliant MANUAL-REVIEW tipster dataset workflow (2026-06-19).
 *
 * Proves the capture sheet has the exact required header, every captured row
 * defaults to pending + not-eligible with no fabricated runner/race, source-audit
 * rows are never model-active, the PR family is tagged + flagged as one
 * duplicated group, paid/login sources are blocked, the approved example can
 * never be imported, and neither the lib nor the CLI introduces scraping/network,
 * model-maths, staking, or betting code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MANUAL_REVIEW_COLUMNS,
  manualReviewHeaderLine,
  isManualReviewHeader,
  parseManualReviewCsv,
  buildManualReviewReport,
  manualReviewRowBlocked,
  manualReviewRowLikelyMatchable,
  isPrFamilyRow,
  parseBoolCell,
  type ManualReviewRow,
} from '../src/lib/tipsterManualReview';

const MR_CSV = readFileSync('data/tipster-opinions-2026-06-19-ascot-manual-review.csv', 'utf8');
const AUDIT = JSON.parse(readFileSync('data/tipster-source-audit-2026-06-19-ascot.json', 'utf8'));
const APPROVED_EXAMPLE = readFileSync('data/tipster-opinions-2026-06-19-ascot-approved.example.csv', 'utf8');

test('manual-review CSV has EXACTLY the required header', () => {
  const firstLine = MR_CSV.split(/\r?\n/)[0];
  assert.equal(firstLine, manualReviewHeaderLine());
  assert.equal(
    firstLine,
    'date,course,race_time,race_name,source_label,tipster_name,source_url,published_at,runner_name,opinion_type,confidence,evidence_excerpt,licence_status,source_access_class,correlation_group,duplicate_family_signal,model_active_eligible,review_status,notes',
  );
});

test('every captured row defaults to pending + not eligible, with NO fabricated tips', () => {
  const rows = parseManualReviewCsv(MR_CSV);
  assert.ok(rows.length >= 14);
  for (const r of rows) {
    assert.equal(r.review_status, 'pending');
    assert.equal(parseBoolCell(r.model_active_eligible), false);
    assert.equal(r.runner_name, ''); // no invented runner
    assert.equal(r.race_name, ''); // no invented race
    assert.equal(r.evidence_excerpt, ''); // no invented evidence
  }
});

test('manual-review report counts the empty template honestly', () => {
  const rows = parseManualReviewCsv(MR_CSV);
  const report = buildManualReviewReport(rows);
  assert.equal(report.total, rows.length);
  assert.equal(report.pending, rows.length);
  assert.equal(report.approved, 0);
  assert.equal(report.modelActiveEligible, 0);
  assert.equal(report.likelyMatchable, 0);
  assert.equal(report.missingRunnerName, rows.length);
  assert.equal(report.blocked, rows.length); // unknown licence until verified
});

test('source-audit rows are NEVER model-active', () => {
  assert.equal(AUDIT.model_active, false);
  assert.ok(Array.isArray(AUDIT.sources) && AUDIT.sources.length >= 17);
  for (const s of AUDIT.sources) {
    assert.equal(s.usable_for_model_review, false, `${s.source_label} must not be usable`);
    assert.ok(['manual_required', 'blocked_login', 'no_current_tips_found'].includes(s.checked_status));
  }
});

test('PR family is tagged correlation_group=PR_family and flagged as one duplicated group', () => {
  const pr = AUDIT.sources.find((s: { source_label: string }) => s.source_label === 'PR family');
  assert.ok(pr, 'audit must include a PR family row');
  assert.equal(pr.correlation_group, 'PR_family');
  assert.equal(pr.duplicate_family_signal, true);
  assert.equal(pr.usable_for_model_review, false);
  // The helper recognises a PR_family row.
  const row = { correlation_group: 'PR_family' } as ManualReviewRow;
  assert.equal(isPrFamilyRow(row), true);
});

test('paid/login sources are blocked / manual-only', () => {
  const rows = parseManualReviewCsv(MR_CSV);
  const times = rows.find((r) => r.source_label === 'The Times Rob Wright')!;
  assert.equal(times.source_access_class, 'paid_login');
  assert.equal(manualReviewRowBlocked(times), true);
  // Audit marks paywalled/login pools as blocked_login.
  for (const label of ['The Times / Rob Wright', 'Core Tipstrr-style pool', 'PR family']) {
    const s = AUDIT.sources.find((x: { source_label: string }) => x.source_label === label);
    assert.ok(s, `audit must include ${label}`);
    assert.equal(s.checked_status, 'blocked_login');
    assert.equal(s.usable_for_model_review, false);
  }
});

test('a fully-verified, approved, permitted row becomes likely matchable', () => {
  const rows = parseManualReviewCsv(MR_CSV);
  const verified: ManualReviewRow = {
    ...rows[0],
    runner_name: 'Some Horse',
    race_time: '14:30',
    race_name: 'Albany Stakes',
    evidence_excerpt: 'strongly fancied',
    licence_status: 'public_allowed',
    source_access_class: 'media_public',
    review_status: 'approved',
    model_active_eligible: 'true',
  };
  assert.equal(manualReviewRowBlocked(verified), false);
  assert.equal(manualReviewRowLikelyMatchable(verified), true);
});

test('approved EXAMPLE file can never be imported by accident', () => {
  const dataLines = APPROVED_EXAMPLE.split(/\r?\n/).filter(
    (l) => l.trim() !== '' && !l.startsWith('#') && !l.startsWith('meeting_date'),
  );
  assert.ok(dataLines.length > 0, 'example must have at least one data row');
  // Every data row contains EXAMPLE -> the importer's placeholder guard blocks commit.
  for (const l of dataLines) assert.match(l, /EXAMPLE/);
  // It uses the importer's header so the operator sees the right format.
  assert.match(APPROVED_EXAMPLE, /meeting_date,course,off_time,horse_name,tipster_name,raw_affiliation,source_label/);
});

test('header detection distinguishes the manual-review sheet from other CSVs', () => {
  assert.equal(isManualReviewHeader([...MANUAL_REVIEW_COLUMNS]), true);
  assert.equal(isManualReviewHeader(['date', 'course', 'race_name', 'off_time']), false);
});

test('manual-review lib introduces NO scraping / network / DB / IO', () => {
  const lib = readFileSync('src/lib/tipsterManualReview.ts', 'utf8');
  assert.doesNotMatch(lib, /fetch\(|axios|node-fetch|XMLHttpRequest|puppeteer|playwright|https?:\/\//);
  assert.doesNotMatch(lib, /supabaseAdmin|node:fs|readFileSync|writeFileSync/);
});

test('manual-review lib + review CLI change no model maths / staking and place no bet', () => {
  for (const file of ['src/lib/tipsterManualReview.ts', 'scripts/reviewTipsterOpinions.ts']) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /kellyStake|bettingEngine|modelProbabilities|calculateEV|runModelForRace/);
    assert.doesNotMatch(src, /placeOrder|placeBet|submitOrder|sendOrder/i);
  }
});
