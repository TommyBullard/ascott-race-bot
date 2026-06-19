/**
 * Pure helpers for the MANUAL-REVIEW tipster-opinion workflow (2026-06-19 Ascot).
 *
 * The manual-review CSV is the operator's human-in-the-loop capture sheet: one
 * row per public/licensed SOURCE, filled in by hand after personally opening a
 * public, non-paywalled, non-login page. This module parses that sheet and
 * produces a READ-ONLY review report (counts only). It is strictly compliant:
 *
 *   - NO SCRAPING / NO NETWORK / NO DB / NO I/O. Pure parsing + counting.
 *   - NO FABRICATION. It never invents a runner, race, or opinion; empty cells
 *     stay empty and are reported as "missing".
 *   - NOTHING MODEL-ACTIVE BY DEFAULT. Rows default to review_status=pending and
 *     model_active_eligible=false; paid/login or unknown-licence rows are flagged
 *     blocked and can never be model-active here.
 *   - Nothing changes model probability, EV, staking, ranking, recommendations,
 *     and nothing places a bet.
 */

import { parseOpinionCsv } from './tipsterOpinions';

/** The exact manual-review CSV header (column order is significant). */
export const MANUAL_REVIEW_COLUMNS = [
  'date',
  'course',
  'race_time',
  'race_name',
  'source_label',
  'tipster_name',
  'source_url',
  'published_at',
  'runner_name',
  'opinion_type',
  'confidence',
  'evidence_excerpt',
  'licence_status',
  'source_access_class',
  'correlation_group',
  'duplicate_family_signal',
  'model_active_eligible',
  'review_status',
  'notes',
] as const;

export type ManualReviewColumn = (typeof MANUAL_REVIEW_COLUMNS)[number];

/** One manual-review row (all cells verbatim strings; never coerced/guessed). */
export type ManualReviewRow = Record<ManualReviewColumn, string>;

/** Licence values under which a row MAY (once approved) become model-active. */
const PERMITTED_LICENCES = new Set(['manual', 'public_allowed', 'licensed']);

/** Access classes that are paid/login → always blocked from model-active here. */
const BLOCKED_ACCESS_CLASSES = new Set(['paid_login', 'login_unknown']);

/** The canonical correlation group for the duplicated PR family. */
export const PR_FAMILY_GROUP = 'PR_family';

/** The exact header line, for an equality check. Pure. */
export function manualReviewHeaderLine(): string {
  return MANUAL_REVIEW_COLUMNS.join(',');
}

/** True when a CSV's header is the manual-review header (order-tolerant). Pure. */
export function isManualReviewHeader(header: readonly string[]): boolean {
  const got = new Set(header.map((h) => h.trim().toLowerCase()));
  if (got.size !== MANUAL_REVIEW_COLUMNS.length) return false;
  return MANUAL_REVIEW_COLUMNS.every((c) => got.has(c));
}

/** Parses manual-review CSV text into rows keyed by column name. Pure. */
export function parseManualReviewCsv(text: string): ManualReviewRow[] {
  const parsed = parseOpinionCsv(text);
  return parsed.rows.map((rec) => {
    const row = {} as ManualReviewRow;
    for (const col of MANUAL_REVIEW_COLUMNS) row[col] = (rec[col] ?? '').trim();
    return row;
  });
}

/** A truthy boolean cell (true/1/yes), else false. Pure. */
export function parseBoolCell(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/** True when the row's licence is unknown/blocked (not a permitted licence). Pure. */
export function rowHasUnknownOrBlockedLicence(row: ManualReviewRow): boolean {
  return !PERMITTED_LICENCES.has(row.licence_status.trim().toLowerCase());
}

/**
 * True when the row is blocked from model-active use: a paid/login access class,
 * OR an unknown/blocked licence. Such rows can never be imported here. Pure.
 */
export function manualReviewRowBlocked(row: ManualReviewRow): boolean {
  const access = row.source_access_class.trim().toLowerCase();
  return BLOCKED_ACCESS_CLASSES.has(access) || rowHasUnknownOrBlockedLicence(row);
}

/** True when the row belongs to the duplicated PR family. Pure. */
export function isPrFamilyRow(row: ManualReviewRow): boolean {
  return row.correlation_group.trim().toLowerCase() === PR_FAMILY_GROUP.toLowerCase();
}

/**
 * True when a row could plausibly match a runner once approved: it has a runner
 * name, a race reference (time or name), an evidence excerpt, is not blocked, and
 * is not rejected. Heuristic only — no DB lookup, never a guess. Pure.
 */
export function manualReviewRowLikelyMatchable(row: ManualReviewRow): boolean {
  return (
    row.runner_name.trim() !== '' &&
    (row.race_time.trim() !== '' || row.race_name.trim() !== '') &&
    row.evidence_excerpt.trim() !== '' &&
    row.review_status.trim().toLowerCase() !== 'rejected' &&
    !manualReviewRowBlocked(row)
  );
}

/** The read-only manual-review report (counts only; imports nothing). */
export interface ManualReviewReport {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  blocked: number;
  missingRunnerName: number;
  missingRaceNameOrTime: number;
  missingEvidence: number;
  unknownOrBlockedLicence: number;
  modelActiveEligible: number;
  likelyMatchable: number;
  prFamily: number;
}

/** Builds the manual-review report from parsed rows. Pure; never writes. */
export function buildManualReviewReport(rows: readonly ManualReviewRow[]): ManualReviewReport {
  const report: ManualReviewReport = {
    total: rows.length,
    pending: 0,
    approved: 0,
    rejected: 0,
    blocked: 0,
    missingRunnerName: 0,
    missingRaceNameOrTime: 0,
    missingEvidence: 0,
    unknownOrBlockedLicence: 0,
    modelActiveEligible: 0,
    likelyMatchable: 0,
    prFamily: 0,
  };
  for (const row of rows) {
    const status = row.review_status.trim().toLowerCase();
    if (status === 'approved') report.approved += 1;
    else if (status === 'rejected') report.rejected += 1;
    else report.pending += 1;

    if (manualReviewRowBlocked(row)) report.blocked += 1;
    if (row.runner_name.trim() === '') report.missingRunnerName += 1;
    if (row.race_time.trim() === '' && row.race_name.trim() === '') report.missingRaceNameOrTime += 1;
    if (row.evidence_excerpt.trim() === '') report.missingEvidence += 1;
    if (rowHasUnknownOrBlockedLicence(row)) report.unknownOrBlockedLicence += 1;
    if (parseBoolCell(row.model_active_eligible)) report.modelActiveEligible += 1;
    if (manualReviewRowLikelyMatchable(row)) report.likelyMatchable += 1;
    if (isPrFamilyRow(row)) report.prFamily += 1;
  }
  return report;
}
