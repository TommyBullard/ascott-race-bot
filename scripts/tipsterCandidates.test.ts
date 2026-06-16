/**
 * Unit tests for the pure tipster source-registry + candidate-queue logic
 * (src/lib/tipsterCandidates.ts).
 *
 * No DB, no network: synthetic data exercises candidate validation, the
 * approval-eligibility gate, and the approved-candidate -> tipster_selections
 * mapping. These lock in the safety guarantees that keep candidates out of the
 * model until an operator approves a pick from an approved source. Run:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANDIDATE_STATUSES,
  isCandidateStatus,
  validateCandidate,
  validateSourceInput,
  canApproveCandidate,
  mapApprovedCandidateToSelection,
  composeOffTimeIso,
  canonicalOffTimeIso,
  type ApprovedCandidateForMapping,
} from '../src/lib/tipsterCandidates';

// ---------------------------------------------------------------------------
// validateCandidate
// ---------------------------------------------------------------------------

test('validateCandidate: a complete candidate validates and normalises', () => {
  const result = validateCandidate({
    meeting_date: '2026-06-16',
    course: '  Ascot ',
    off_time: '14:30',
    horse_name: '  Some Horse ',
    tipster_name: ' Some Tipster ',
    raw_affiliation: '  Stable A ',
    source_label: ' racing-post-tips ',
    source_url: ' https://example.com/tips ',
    source_name: ' Racing Post ',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.candidate, {
    meeting_date: '2026-06-16',
    course: 'Ascot',
    off_time: '14:30',
    horse_name: 'Some Horse',
    tipster_name: 'Some Tipster',
    raw_affiliation: 'Stable A',
    source_label: 'racing-post-tips',
    source_url: 'https://example.com/tips',
    source_name: 'Racing Post',
  });
});

test('validateCandidate: optional provenance is null when absent or blank', () => {
  const result = validateCandidate({
    meeting_date: '2026-06-16',
    course: 'Ascot',
    off_time: '14:30',
    horse_name: 'Some Horse',
    tipster_name: 'Some Tipster',
    raw_affiliation: '   ',
    // source_* omitted entirely
  });
  assert.equal(result.ok, true);
  assert.equal(result.candidate?.raw_affiliation, null);
  assert.equal(result.candidate?.source_label, null);
  assert.equal(result.candidate?.source_url, null);
  assert.equal(result.candidate?.source_name, null);
});

test('validateCandidate: each missing/ill-formed required field is reported', () => {
  const result = validateCandidate({
    meeting_date: '16/06/2026', // wrong shape
    course: '   ', // blank
    off_time: '2.30pm', // wrong shape
    horse_name: '', // blank
    tipster_name: '', // blank
  });
  assert.equal(result.ok, false);
  assert.equal(result.candidate, null);
  assert.ok(result.problems.some((p) => p.includes('meeting_date')));
  assert.ok(result.problems.some((p) => p.includes('course')));
  assert.ok(result.problems.some((p) => p.includes('off_time')));
  assert.ok(result.problems.some((p) => p.includes('horse_name')));
  assert.ok(result.problems.some((p) => p.includes('tipster_name')));
});

test('validateCandidate: does not mutate its input', () => {
  const input = {
    meeting_date: '2026-06-16',
    course: ' Ascot ',
    off_time: '14:30',
    horse_name: ' Horse ',
    tipster_name: ' Tipster ',
  };
  const snapshot = JSON.stringify(input);
  validateCandidate(input);
  assert.equal(JSON.stringify(input), snapshot);
});

// ---------------------------------------------------------------------------
// validateSourceInput
// ---------------------------------------------------------------------------

test('validateSourceInput: label + name required; url/notes optional', () => {
  const ok = validateSourceInput({
    source_label: ' racing-post-tips ',
    source_name: ' Racing Post ',
    source_url: ' https://example.com ',
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.source, {
    source_label: 'racing-post-tips',
    source_name: 'Racing Post',
    source_url: 'https://example.com',
    notes: null,
  });

  const missingLabel = validateSourceInput({ source_name: 'X' });
  assert.equal(missingLabel.ok, false);
  assert.ok(missingLabel.problems.some((p) => p.includes('source_label')));

  const missingName = validateSourceInput({ source_label: 'x' });
  assert.equal(missingName.ok, false);
  assert.ok(missingName.problems.some((p) => p.includes('source_name')));
});

// ---------------------------------------------------------------------------
// canApproveCandidate
// ---------------------------------------------------------------------------

test('canApproveCandidate: pending + registered approved source -> ok', () => {
  const result = canApproveCandidate(
    { status: 'pending', source_label: 'src' },
    { source_label: 'src', is_approved: true },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
});

test('canApproveCandidate: non-pending status is refused', () => {
  for (const status of ['approved', 'rejected', 'weird']) {
    const result = canApproveCandidate(
      { status, source_label: 'src' },
      { source_label: 'src', is_approved: true },
    );
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('status')));
  }
});

test('canApproveCandidate: missing source_label is refused', () => {
  const result = canApproveCandidate({ status: 'pending', source_label: '  ' }, null);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('no source_label')));
});

test('canApproveCandidate: unregistered source is refused', () => {
  const result = canApproveCandidate({ status: 'pending', source_label: 'src' }, null);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('not registered')));
});

test('canApproveCandidate: registered but unapproved source is refused', () => {
  const result = canApproveCandidate(
    { status: 'pending', source_label: 'src' },
    { source_label: 'src', is_approved: false },
  );
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('not approved')));
});

// ---------------------------------------------------------------------------
// mapApprovedCandidateToSelection
// ---------------------------------------------------------------------------

const approvedBase: ApprovedCandidateForMapping = {
  status: 'approved',
  race_id: 'race-1',
  runner_id: 'runner-1',
  tipster_id: 'tipster-1',
  tipster_name: ' Some Tipster ',
  raw_affiliation: ' Stable A ',
  source_label: ' racing-post-tips ',
};

test('mapApprovedCandidateToSelection: maps an approved, resolved candidate', () => {
  const selection = mapApprovedCandidateToSelection(approvedBase);
  assert.deepEqual(selection, {
    race_id: 'race-1',
    runner_id: 'runner-1',
    tipster_id: 'tipster-1',
    raw_tipster_name: 'Some Tipster',
    raw_affiliation: 'Stable A',
    source_label: 'racing-post-tips',
  });
  // Only source_label carries across — no source_url/source_name on selections.
  assert.equal('source_url' in selection, false);
  assert.equal('source_name' in selection, false);
});

test('mapApprovedCandidateToSelection: null tipster_id and blank affiliation are preserved as null', () => {
  const selection = mapApprovedCandidateToSelection({
    ...approvedBase,
    tipster_id: null,
    raw_affiliation: '   ',
    source_label: '   ',
  });
  assert.equal(selection.tipster_id, null);
  assert.equal(selection.raw_affiliation, null);
  assert.equal(selection.source_label, null);
});

test('mapApprovedCandidateToSelection: refuses a candidate that is not approved', () => {
  for (const status of ['pending', 'rejected', '']) {
    assert.throws(
      () => mapApprovedCandidateToSelection({ ...approvedBase, status }),
      /must be "approved"/,
    );
  }
});

test('mapApprovedCandidateToSelection: refuses an unresolved race or runner', () => {
  assert.throws(
    () => mapApprovedCandidateToSelection({ ...approvedBase, race_id: null }),
    /race_id/,
  );
  assert.throws(
    () => mapApprovedCandidateToSelection({ ...approvedBase, race_id: '  ' }),
    /race_id/,
  );
  assert.throws(
    () => mapApprovedCandidateToSelection({ ...approvedBase, runner_id: null }),
    /runner_id/,
  );
  assert.throws(
    () => mapApprovedCandidateToSelection({ ...approvedBase, runner_id: '' }),
    /runner_id/,
  );
});

test('mapApprovedCandidateToSelection: refuses a missing tipster_name', () => {
  assert.throws(
    () => mapApprovedCandidateToSelection({ ...approvedBase, tipster_name: '   ' }),
    /tipster_name/,
  );
});

// ---------------------------------------------------------------------------
// Off-time helpers + status guards
// ---------------------------------------------------------------------------

test('composeOffTimeIso: composes a UTC instant and pads single-digit hours', () => {
  assert.equal(composeOffTimeIso('2026-06-16', '14:30'), '2026-06-16T14:30:00.000Z');
  assert.equal(composeOffTimeIso('2026-06-16', '9:05'), '2026-06-16T09:05:00.000Z');
  assert.equal(composeOffTimeIso('2026-06-16', 'not-a-time'), null);
  assert.equal(composeOffTimeIso('not-a-date', '14:30'), null);
});

test('canonicalOffTimeIso: canonicalises or returns null', () => {
  assert.equal(canonicalOffTimeIso('2026-06-16T14:30:00+00:00'), '2026-06-16T14:30:00.000Z');
  assert.equal(canonicalOffTimeIso(null), null);
  assert.equal(canonicalOffTimeIso(undefined), null);
  assert.equal(canonicalOffTimeIso('nope'), null);
});

test('isCandidateStatus + CANDIDATE_STATUSES: only the three states are valid', () => {
  assert.deepEqual([...CANDIDATE_STATUSES], ['pending', 'approved', 'rejected']);
  assert.equal(isCandidateStatus('pending'), true);
  assert.equal(isCandidateStatus('approved'), true);
  assert.equal(isCandidateStatus('rejected'), true);
  assert.equal(isCandidateStatus('PENDING'), false);
  assert.equal(isCandidateStatus(''), false);
  assert.equal(isCandidateStatus(null), false);
  assert.equal(isCandidateStatus(undefined), false);
});
