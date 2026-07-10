/**
 * Unit tests for the pure live lock-coverage helpers (src/lib/lockCoverage.ts)
 * — Newmarket rebuild Phase 6A — plus the timeline/proof-panel integration of
 * the new per-race lock status.
 *
 * No DB, no network, no wall clock: injected `now` values exercise the
 * not-locked-yet vs LOCK-MISSING boundary (inclusive at the off), the coverage
 * summary maths, the row formatting/tone, and that the timeline entries and
 * proof panel carry the new signal. A source scan proves the module is pure.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  deriveRaceLockStatus,
  summarizeLockCoverage,
  formatLockCoverageValue,
  lockCoverageTone,
  LOCK_STATUS_LABEL,
  LOCK_STATUS_TONE,
  type RaceLockStatus,
} from '../src/lib/lockCoverage';
import { buildRaceDayTimeline } from '../src/lib/raceDayTimeline';
import { buildProofPanelView } from '../src/lib/proofPanel';

const OFF = '2026-07-10T15:00:00.000Z';
const OFF_MS = Date.parse(OFF);

/* --------------------------- per-race derivation -------------------------- */

test('deriveRaceLockStatus: official statuses pass through verbatim', () => {
  for (const s of ['locked_pick', 'locked_no_bet', 'no_run_available'] as const) {
    assert.equal(deriveRaceLockStatus(s, OFF, OFF_MS + 999_999), s);
    assert.equal(deriveRaceLockStatus(s, null, 0), s); // even with unknown off
  }
});

test('deriveRaceLockStatus: null before/at the off -> not_locked_yet (never "missing" early)', () => {
  assert.equal(deriveRaceLockStatus(null, OFF, OFF_MS - 60 * 60_000), 'not_locked_yet');
  // In-window (T-5 .. off) nulls stay "not locked yet" — the job may still write.
  assert.equal(deriveRaceLockStatus(null, OFF, OFF_MS - 2 * 60_000), 'not_locked_yet');
  // Exactly AT the off: still the lock CLI's last safe moment (inclusive).
  assert.equal(deriveRaceLockStatus(null, OFF, OFF_MS), 'not_locked_yet');
});

test('deriveRaceLockStatus: null after the off -> lock_missing (window passed, a fact)', () => {
  assert.equal(deriveRaceLockStatus(null, OFF, OFF_MS + 1), 'lock_missing');
  assert.equal(deriveRaceLockStatus(undefined, OFF, OFF_MS + 60 * 60_000), 'lock_missing');
});

test('deriveRaceLockStatus: unknown/unparseable off -> not_locked_yet (never accused)', () => {
  assert.equal(deriveRaceLockStatus(null, null, Number.MAX_SAFE_INTEGER), 'not_locked_yet');
  assert.equal(deriveRaceLockStatus(null, 'nonsense', OFF_MS), 'not_locked_yet');
});

test('deriveRaceLockStatus: an unknown decision_status string is treated as no lock', () => {
  assert.equal(deriveRaceLockStatus('settled', OFF, OFF_MS + 1), 'lock_missing');
  assert.equal(deriveRaceLockStatus('', OFF, OFF_MS - 1), 'not_locked_yet');
});

/* ----------------------------- coverage summary --------------------------- */

test('summarizeLockCoverage: counts + 5/7 -> 71.4%', () => {
  const s = summarizeLockCoverage([
    'locked_pick', 'locked_pick', 'locked_pick',
    'locked_no_bet', 'locked_no_bet',
    'lock_missing', 'lock_missing',
  ]);
  assert.deepEqual(s, {
    races: 7,
    locked: 5,
    coveragePct: 71.4,
    lockedPick: 3,
    lockedNoBet: 2,
    noRunAvailable: 0,
    lockMissing: 2,
    notLockedYet: 0,
  });
});

test('summarizeLockCoverage: empty day -> zeros (no divide-by-zero)', () => {
  const s = summarizeLockCoverage([]);
  assert.equal(s.races, 0);
  assert.equal(s.coveragePct, 0);
});

test('formatLockCoverageValue + tones', () => {
  const s = summarizeLockCoverage([
    'locked_pick', 'locked_no_bet', 'lock_missing', 'not_locked_yet',
  ]);
  assert.equal(
    formatLockCoverageValue(s),
    '2/4 locked (50.0%) · pick 1 · no-bet 1 · no-run 0 · MISSING 1 · not yet 1',
  );
  assert.equal(lockCoverageTone(s), 'warn'); // missing -> warn
  assert.equal(
    lockCoverageTone(summarizeLockCoverage(['locked_pick', 'locked_no_bet'])),
    'ok', // fully locked -> ok
  );
  assert.equal(
    lockCoverageTone(summarizeLockCoverage(['locked_pick', 'not_locked_yet'])),
    'neutral', // pending locks, nothing wrong -> neutral
  );
  assert.equal(
    lockCoverageTone(summarizeLockCoverage(['locked_pick', 'no_run_available'])),
    'warn', // a lock with no run available is degraded -> warn
  );
});

test('labels + tones cover every status; no-bet is ok (a valid decision)', () => {
  const statuses: RaceLockStatus[] = [
    'locked_pick', 'locked_no_bet', 'no_run_available', 'not_locked_yet', 'lock_missing',
  ];
  for (const s of statuses) {
    assert.ok(LOCK_STATUS_LABEL[s].length > 0);
    assert.ok(['ok', 'warn', 'neutral'].includes(LOCK_STATUS_TONE[s]));
  }
  assert.equal(LOCK_STATUS_LABEL.lock_missing, 'LOCK MISSING');
  assert.equal(LOCK_STATUS_TONE.locked_no_bet, 'ok');
  assert.equal(LOCK_STATUS_TONE.lock_missing, 'warn');
});

/* --------------------------- panel integration ---------------------------- */

test('timeline entries carry lockStatus (locked verbatim; null classified by time)', () => {
  const entries = buildRaceDayTimeline(
    [
      { race_id: 'a', off_time: OFF, lockedDecisionStatus: 'locked_pick' },
      { race_id: 'b', off_time: OFF, lockedDecisionStatus: null },
    ],
    OFF_MS + 1,
  );
  assert.equal(entries[0].lockStatus, 'locked_pick');
  assert.equal(entries[1].lockStatus, 'lock_missing');
  // Back-compat: an input without the new field still classifies by time.
  const legacy = buildRaceDayTimeline([{ race_id: 'c', off_time: OFF }], OFF_MS - 1);
  assert.equal(legacy[0].lockStatus, 'not_locked_yet');
});

test('proof panel renders the locks row when lock statuses are supplied', () => {
  const race = (lockStatus: RaceLockStatus) => ({
    offTime: OFF,
    fieldSize: 8,
    latestOddsSnapshotTime: OFF,
    latestModelRunTime: OFF,
    hasModelRun: true,
    status: null,
    finishPosAvailable: false,
    lockStatus,
  });
  const view = buildProofPanelView({
    date: '2026-07-10',
    course: 'Newmarket',
    now: OFF_MS,
    races: [race('locked_pick'), race('lock_missing')],
    runnersCount: 16,
  });
  const row = view.rows.find((r) => r.label === 'Official T-minus-5 locks');
  assert.ok(row, 'locks row missing from proof panel');
  assert.match(row.value, /1\/2 locked \(50\.0%\)/);
  assert.match(row.value, /MISSING 1/);
  assert.equal(row.tone, 'warn');
});

test('proof panel omits the locks row when no lock statuses are supplied (never guessed)', () => {
  const view = buildProofPanelView({
    date: '2026-07-10',
    course: 'Newmarket',
    now: OFF_MS,
    races: [
      {
        offTime: OFF,
        fieldSize: 8,
        latestOddsSnapshotTime: OFF,
        latestModelRunTime: OFF,
        hasModelRun: true,
        status: null,
        finishPosAvailable: false,
      },
    ],
    runnersCount: 8,
  });
  assert.equal(view.rows.some((r) => r.label === 'Official T-minus-5 locks'), false);
});

/* ------------------------------- purity scan ------------------------------ */

test('lockCoverage module is pure (no DB / fs / env / network / writes)', () => {
  const src = readFileSync('src/lib/lockCoverage.ts', 'utf8');
  assert.equal(/supabaseAdmin|node:fs|process\.env|\bfetch\s*\(/.test(src), false);
  assert.equal(/\.(insert|update|upsert|delete)\s*\(/.test(src), false);
});
