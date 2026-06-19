/**
 * Unit tests for the pure live race-day status module (src/lib/raceDayStatus.ts)
 * plus read-only source-scan guards on the dashboard wiring.
 *
 * The derivation functions are pure and deterministic given an injected `now`,
 * so no DB / network is needed. The source scans lock down the task's safety
 * rules: the dashboard never writes to the DB, never exposes `--commit`, never
 * places bets, and the pre-off model-run selection is preserved. Run with:
 *   npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  RACE_DAY_REFRESH_MS,
  T_MINUS_10_MS,
  T_MINUS_5_MS,
  OFF_WINDOW_MS,
  isSettled,
  deriveRaceState,
  deriveResultStatus,
  raceStateBadge,
  resultStatusBadge,
  captureStatusBadge,
  isPreOffRun,
  deriveCaptureStatus,
  selectNextRace,
  buildRaceWarningChips,
  type RaceState,
  type ResultStatus,
} from '../src/lib/raceDayStatus';

/** Em dash used for unknown / not-applicable labels in the module. */
const DASH = '\u2014';

/** A fixed clock so every windowed derivation is deterministic. */
const NOW = Date.parse('2026-06-17T14:00:00Z');
/** Build an ISO off time `mins` minutes from NOW (negative = already past). */
function offIso(minsFromNow: number): string {
  return new Date(NOW + minsFromNow * 60_000).toISOString();
}

/* --------------------------- refresh cadence ------------------------------ */

test('RACE_DAY_REFRESH_MS sits inside the requested 30-60s window', () => {
  assert.ok(RACE_DAY_REFRESH_MS >= 30_000, 'at least 30s');
  assert.ok(RACE_DAY_REFRESH_MS <= 60_000, 'at most 60s');
});

test('window constants are the expected durations', () => {
  assert.equal(T_MINUS_10_MS, 10 * 60_000);
  assert.equal(T_MINUS_5_MS, 5 * 60_000);
  assert.equal(OFF_WINDOW_MS, 5 * 60_000);
});

/* ----------------------------- isSettled ---------------------------------- */

test('isSettled: only the "result" status (case/space-insensitive) is settled', () => {
  assert.equal(isSettled('result'), true);
  assert.equal(isSettled('  RESULT '), true);
  assert.equal(isSettled('upcoming'), false);
  assert.equal(isSettled('off'), false);
  assert.equal(isSettled(null), false);
  assert.equal(isSettled(undefined), false);
  assert.equal(isSettled(''), false);
});

/* --------------------------- deriveRaceState ------------------------------ */

test('deriveRaceState: upcoming / T-10 / T-5 / off / result-pending / settled', () => {
  // > 10m out -> upcoming
  assert.equal(deriveRaceState({ offTime: offIso(15), now: NOW }), 'upcoming');
  // (5m, 10m] -> t-minus-10
  assert.equal(deriveRaceState({ offTime: offIso(8), now: NOW }), 't-minus-10');
  // (0, 5m] -> t-minus-5
  assert.equal(deriveRaceState({ offTime: offIso(3), now: NOW }), 't-minus-5');
  // [off, off+5m) -> off
  assert.equal(deriveRaceState({ offTime: offIso(-1), now: NOW }), 'off');
  assert.equal(deriveRaceState({ offTime: offIso(0), now: NOW }), 'off');
  // >= off+5m, not resulted -> result-pending
  assert.equal(deriveRaceState({ offTime: offIso(-10), now: NOW }), 'result-pending');
  // status 'result' -> settled (regardless of the clock)
  assert.equal(
    deriveRaceState({ offTime: offIso(5), now: NOW, status: 'result' }),
    'settled',
  );
});

test('deriveRaceState: window boundaries are inclusive on the right edges', () => {
  // exactly 10m out -> still t-minus-10 (not upcoming)
  assert.equal(deriveRaceState({ offTime: offIso(10), now: NOW }), 't-minus-10');
  // exactly 5m out -> still t-minus-5 (not t-minus-10)
  assert.equal(deriveRaceState({ offTime: offIso(5), now: NOW }), 't-minus-5');
  // exactly off+5m -> result-pending (off window is closed at +5m)
  assert.equal(deriveRaceState({ offTime: offIso(-5), now: NOW }), 'result-pending');
});

test('deriveRaceState: missing / unparseable off time -> unknown', () => {
  assert.equal(deriveRaceState({ offTime: null, now: NOW }), 'unknown');
  assert.equal(deriveRaceState({ offTime: undefined, now: NOW }), 'unknown');
  assert.equal(deriveRaceState({ offTime: 'not-a-date', now: NOW }), 'unknown');
  // ...but a settled status still wins even without a parseable off time.
  assert.equal(
    deriveRaceState({ offTime: null, now: NOW, status: 'result' }),
    'settled',
  );
});

test('deriveRaceState: a settled race stays settled even far past the off', () => {
  // Post-off time must NOT change a settled verdict (settled is status-driven).
  const farAfter = NOW + 6 * 60 * 60_000;
  assert.equal(
    deriveRaceState({ offTime: offIso(-120), now: farAfter, status: 'result' }),
    'settled',
  );
});

/* -------------------------- deriveResultStatus ---------------------------- */

test('deriveResultStatus: none -> pending -> settled, derivable from stored state', () => {
  // before/around the off -> no result expected yet
  assert.equal(deriveResultStatus({ offTime: offIso(15), now: NOW }), 'none');
  assert.equal(deriveResultStatus({ offTime: offIso(-1), now: NOW }), 'none');
  // well past the off, no recorded result -> pending
  assert.equal(deriveResultStatus({ offTime: offIso(-10), now: NOW }), 'pending');
  // recorded result -> settled
  assert.equal(
    deriveResultStatus({ offTime: offIso(-10), now: NOW, status: 'result' }),
    'settled',
  );
});

test('deriveResultStatus: unparseable off time -> unknown (no fabricated status)', () => {
  assert.equal(deriveResultStatus({ offTime: null, now: NOW }), 'unknown');
  assert.equal(deriveResultStatus({ offTime: 'nope', now: NOW }), 'unknown');
});

test('deriveResultStatus never claims "settle-ready" (not derivable from DB state)', () => {
  // Exhaustively: only none/pending/settled/unknown are ever returned.
  const allowed: ResultStatus[] = ['none', 'pending', 'settled', 'unknown'];
  for (const mins of [-200, -10, -5, -1, 0, 3, 8, 15, 600]) {
    for (const status of [null, 'upcoming', 'off', 'result']) {
      const got = deriveResultStatus({ offTime: offIso(mins), now: NOW, status });
      assert.ok(allowed.includes(got), `unexpected result status: ${got}`);
      assert.notEqual(got as string, 'settle-ready');
    }
  }
});

/* ------------------------------- isPreOffRun ------------------------------ */

test('isPreOffRun: run at/at-before the off is pre-off; after is not', () => {
  const off = offIso(0);
  assert.equal(isPreOffRun(offIso(-5), off), true); // before
  assert.equal(isPreOffRun(off, off), true); // exactly at off (<=)
  assert.equal(isPreOffRun(offIso(2), off), false); // after the off
});

test('isPreOffRun: missing / unparseable inputs cannot confirm pre-off -> false', () => {
  assert.equal(isPreOffRun(null, offIso(0)), false);
  assert.equal(isPreOffRun(offIso(0), null), false);
  assert.equal(isPreOffRun('x', offIso(0)), false);
  assert.equal(isPreOffRun(offIso(0), 'x'), false);
});

/* --------------------------- deriveCaptureStatus -------------------------- */

test('deriveCaptureStatus: captured / post-off-only / missing / unknown', () => {
  // no run at all
  assert.equal(
    deriveCaptureStatus({ hasModelRun: false, runTime: null, offTime: offIso(0) }),
    'missing',
  );
  // pre-off run shown -> captured
  assert.equal(
    deriveCaptureStatus({ hasModelRun: true, runTime: offIso(-6), offTime: offIso(0) }),
    'captured',
  );
  // only a post-off run exists -> pre-off capture missing (shown, not trusted)
  assert.equal(
    deriveCaptureStatus({ hasModelRun: true, runTime: offIso(3), offTime: offIso(0) }),
    'post-off-only',
  );
  // run exists but off time unknown -> cannot tell
  assert.equal(
    deriveCaptureStatus({ hasModelRun: true, runTime: offIso(0), offTime: null }),
    'unknown',
  );
});

/* ------------------------------- badges ----------------------------------- */

test('raceStateBadge: stable labels + tones for every state', () => {
  const cases: Array<[RaceState, string, string]> = [
    ['upcoming', 'Upcoming', 'neutral'],
    ['t-minus-10', 'T\u221210', 'warn'],
    ['t-minus-5', 'T\u22125', 'warn'],
    ['off', 'Off', 'pos'],
    ['result-pending', 'Result pending', 'warn'],
    ['settled', 'Settled', 'pos'],
    ['unknown', 'Unknown', 'neutral'],
  ];
  for (const [state, label, tone] of cases) {
    const badge = raceStateBadge(state);
    assert.equal(badge.label, label);
    assert.equal(badge.tone, tone);
  }
});

test('resultStatusBadge: pending/settled labelled; none renders an em dash', () => {
  assert.deepEqual(resultStatusBadge('settled'), { label: 'Settled', tone: 'pos' });
  assert.deepEqual(resultStatusBadge('pending'), { label: 'Result pending', tone: 'warn' });
  assert.deepEqual(resultStatusBadge('none'), { label: DASH, tone: 'neutral' });
  assert.deepEqual(resultStatusBadge('unknown'), { label: 'Unknown', tone: 'neutral' });
});

test('captureStatusBadge: a post-off-only run is flagged as a missing pre-off run', () => {
  assert.equal(captureStatusBadge('captured').label, 'Pre-off run captured');
  assert.equal(captureStatusBadge('captured').tone, 'pos');
  assert.equal(captureStatusBadge('post-off-only').label, 'Pre-off run missing');
  assert.equal(captureStatusBadge('post-off-only').tone, 'warn');
  assert.equal(captureStatusBadge('missing').label, 'No model run');
  assert.equal(captureStatusBadge('unknown').label, 'Unknown');
});

/* ----------------------------- determinism -------------------------------- */

test('derivations are deterministic for identical inputs', () => {
  const input = { offTime: offIso(8), now: NOW, status: null };
  assert.equal(deriveRaceState(input), deriveRaceState(input));
  assert.equal(deriveResultStatus(input), deriveResultStatus(input));
  assert.deepEqual(
    raceStateBadge(deriveRaceState(input)),
    raceStateBadge(deriveRaceState(input)),
  );
});

/* --------------------- read-only guards (source scans) -------------------- */

test('the pure status module has no imports and no DB / fs / network / env access', () => {
  const lib = readFileSync('src/lib/raceDayStatus.ts', 'utf8');
  // Zero imports keeps it a pure, dependency-free presentation helper.
  assert.equal(/^\s*import\s/m.test(lib), false);
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs/.test(lib), false);
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/\bfetch\s*\(/.test(lib), false);
});

test('the dashboard page never writes to the database', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.equal(/\.insert\s*\(/.test(page), false);
  assert.equal(/\.upsert\s*\(/.test(page), false);
  assert.equal(/\.update\s*\(/.test(page), false);
  assert.equal(/\.delete\s*\(/.test(page), false);
  assert.equal(/\.rpc\s*\(/.test(page), false);
  assert.equal(/supabaseAdmin/.test(page), false);
});

test('the dashboard page only issues read-only fetches (no mutating HTTP methods)', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.equal(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(page), false);
});

test('the dashboard page never exposes --commit or a bet-placement action', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.equal(/--commit/.test(page), false);
  assert.equal(/placeOrder|placeBet|placeOrders|submitOrder/i.test(page), false);
});

test('the dashboard page renders the live-mode indicator and safety banner', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.match(page, /Live mode/);
  assert.match(page, /Decision-support only/);
  assert.match(page, /RACE_DAY_REFRESH_MS/);
});

test('raceData still selects pre-off runs for historical races (pre-off preserved)', () => {
  const rd = readFileSync('src/lib/raceData.ts', 'utf8');
  // The historical/off/settled card uses the latest valid PRE-OFF run; a post-off
  // rerun on stale odds must not supersede it for display.
  assert.match(rd, /isHistoricalRaceView/);
  assert.match(rd, /\.lte\('run_time'/);
  // The read-only result signal is surfaced (status + official_result_time).
  assert.match(rd, /official_result_time/);
});

/* ---------------------------- selectNextRace ------------------------------ */

test('selectNextRace: picks the soonest race still in the future', () => {
  const races = [
    { off_time: offIso(-30), status: null },
    { off_time: offIso(40), status: null },
    { off_time: offIso(10), status: null },
  ];
  assert.equal(selectNextRace(races, NOW)?.off_time, offIso(10));
});

test('selectNextRace: prefers an upcoming race regardless of input order', () => {
  const races = [
    { off_time: offIso(50) },
    { off_time: offIso(5) },
    { off_time: offIso(-5) },
  ];
  assert.equal(selectNextRace(races, NOW)?.off_time, offIso(5));
});

test('selectNextRace: falls back to the latest race once all are off/settled', () => {
  const races = [
    { off_time: offIso(-60), status: 'result' },
    { off_time: offIso(-10), status: 'result' },
    { off_time: offIso(-30), status: 'result' },
  ];
  assert.equal(selectNextRace(races, NOW)?.off_time, offIso(-10));
});

test('selectNextRace: null for empty or all-unparseable off times', () => {
  assert.equal(selectNextRace([], NOW), null);
  assert.equal(selectNextRace([{ off_time: null }, { off_time: 'nope' }], NOW), null);
});

/* -------------------------- buildRaceWarningChips ------------------------- */

test('buildRaceWarningChips: LOW confidence raises a warn chip (any casing)', () => {
  for (const lbl of ['Low', 'low', 'LOW', ' low ']) {
    const chips = buildRaceWarningChips({ confidenceLabel: lbl });
    assert.ok(
      chips.some((c) => c.label === 'Low confidence' && c.tone === 'warn'),
      lbl,
    );
  }
  assert.deepEqual(buildRaceWarningChips({ confidenceLabel: 'High' }), []);
  assert.deepEqual(buildRaceWarningChips({ confidenceLabel: null }), []);
});

test('buildRaceWarningChips: degraded/stale/invalid data raises a warn chip', () => {
  for (const rq of ['DEGRADED', 'degraded', 'STALE', 'INVALID']) {
    const chips = buildRaceWarningChips({ runQuality: rq });
    assert.ok(chips.some((c) => /data$/.test(c.label) && c.tone === 'warn'), rq);
  }
  assert.deepEqual(buildRaceWarningChips({ runQuality: 'OK' }), []);
});

test('buildRaceWarningChips: NO_TIPSTER_CONSENSUS raises a chip', () => {
  const chips = buildRaceWarningChips({ alignmentLabel: 'NO_TIPSTER_CONSENSUS' });
  assert.ok(chips.some((c) => c.label === 'No tipster consensus'));
  assert.deepEqual(buildRaceWarningChips({ alignmentLabel: 'ALIGNED' }), []);
});

test('buildRaceWarningChips: combines all, is empty when none, deterministic', () => {
  const input = {
    confidenceLabel: 'Low',
    runQuality: 'DEGRADED',
    alignmentLabel: 'NO_TIPSTER_CONSENSUS',
  };
  const chips = buildRaceWarningChips(input);
  assert.equal(chips.length, 3);
  assert.deepEqual(buildRaceWarningChips(input), chips);
  assert.deepEqual(buildRaceWarningChips({}), []);
});

test('the dashboard renders the sticky Next race header + warning chips (read-only)', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.match(page, /function NextRacePanel/);
  assert.match(page, /selectNextRace/);
  assert.match(page, /buildRaceWarningChips/);
  assert.match(page, /LOW confidence|warningChips/);
});
