/**
 * Tests for the historical race-card run selection (Task B of the dashboard fix).
 *
 * `fetchRaceCard` decides WHICH model run to display per race using two pure
 * pieces, exercised here without a DB:
 *   1. `isHistoricalRaceView(race, now)` — the branch decision: a race already
 *      OFF or RESULTED is historical → show the final PRE-OFF run; an upcoming
 *      race is live → keep the current (`is_current`) run.
 *   2. `selectPreOffRun(runs, off_time)` — the pick: the latest run with
 *      `run_time <= off_time`. This mirrors the SQL the card query runs for a
 *      historical race (`.lte('run_time', off_time).order(run_time desc).limit 1`),
 *      so a post-off stale rerun that became `is_current` is ignored.
 *
 * Together these prove a historical card shows the final pre-off recommendation,
 * not the post-off no-bet `is_current` run, while live cards are unchanged.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isHistoricalRaceView } from '../src/lib/modelRunGuard';
import { selectPreOffRun } from '../src/lib/modelPerformance';

// Fixed "now": well after the Day-1 races have gone off.
const NOW = new Date('2026-06-16T20:00:00.000Z');

/** A model run candidate carrying whether it was the live current row. */
interface CardRun {
  run_id: string;
  run_time: string;
  is_current: boolean;
}

/* --------------------------- isHistoricalRaceView ------------------------- */

test('isHistoricalRaceView: a resulted race is historical (show pre-off run)', () => {
  assert.equal(
    isHistoricalRaceView({ off_time: '2026-06-16T16:00:00Z', status: 'result' }, NOW),
    true,
  );
});

test('isHistoricalRaceView: a race already past its off time is historical', () => {
  assert.equal(
    isHistoricalRaceView({ off_time: '2026-06-16T16:00:00Z', status: 'open' }, NOW),
    true,
  );
});

test('isHistoricalRaceView: an UPCOMING race is NOT historical (live/current preserved)', () => {
  const soon = new Date('2026-06-16T15:00:00.000Z'); // before the 16:00 off
  assert.equal(
    isHistoricalRaceView({ off_time: '2026-06-16T16:00:00Z', status: 'open' }, soon),
    false,
  );
});

test('isHistoricalRaceView: unknown off time + non-result status is NOT historical', () => {
  assert.equal(isHistoricalRaceView({ off_time: null, status: null }, NOW), false);
  assert.equal(isHistoricalRaceView({ off_time: '', status: 'open' }, NOW), false);
});

/* --------------- historical card chooses the pre-off run ------------------ */

test('historical card: chooses the latest pre-off run, NOT the post-off is_current run', () => {
  // The post-off rerun is the current row, but it is after the off time.
  const runs: CardRun[] = [
    { run_id: 'preoff', run_time: '2026-06-16T15:55:00Z', is_current: false },
    { run_id: 'postoff', run_time: '2026-06-16T19:15:00Z', is_current: true },
  ];
  const off = '2026-06-16T16:00:00Z';

  assert.equal(isHistoricalRaceView({ off_time: off, status: 'result' }, NOW), true);
  const chosen = selectPreOffRun(runs, off);
  assert.equal(chosen?.run_id, 'preoff'); // the superseded pre-off run, not the current post-off run
});

test('historical card: a post-off NO-BET run does not hide a valid pre-off recommendation', () => {
  // Model the live failure: the pre-off run carried a rec; the post-off rerun
  // (current) had none. The displayed run must be the pre-off run, so its rec
  // (loaded by run id downstream) is shown — the card is NOT a no-bet.
  const recByRun = new Map<string, string>([['preoff', 'Puturhandstogether']]); // postoff has none
  const runs: CardRun[] = [
    { run_id: 'preoff', run_time: '2026-06-16T15:55:00Z', is_current: false },
    { run_id: 'postoff', run_time: '2026-06-16T19:15:00Z', is_current: true },
  ];
  const off = '2026-06-16T16:00:00Z';

  const chosen = selectPreOffRun(runs, off);
  assert.equal(chosen?.run_id, 'preoff');
  // The displayed run has a recommendation -> the card shows a pick, not no-bet.
  assert.equal(recByRun.get(chosen!.run_id), 'Puturhandstogether');
  assert.notEqual(chosen?.run_id, 'postoff'); // never the no-bet post-off run
});

test('historical card: the three final Ascot races select their pre-off pick run', () => {
  const finals = [
    { label: '17:00', off: '2026-06-16T16:00:00Z', preoff: 'r5-preoff', pick: 'Puturhandstogether' },
    { label: '17:35', off: '2026-06-16T16:35:00Z', preoff: 'r6-preoff', pick: 'Haatem' },
    { label: '18:10', off: '2026-06-16T17:10:00Z', preoff: 'r7-preoff', pick: 'Sing Us A Song' },
  ];
  for (const { label, off, preoff } of finals) {
    const runs: CardRun[] = [
      { run_id: preoff, run_time: new Date(new Date(off).getTime() - 4 * 60_000).toISOString(), is_current: false },
      { run_id: `${preoff}-postoff`, run_time: '2026-06-16T19:15:00Z', is_current: true },
    ];
    assert.equal(isHistoricalRaceView({ off_time: off, status: 'result' }, NOW), true, `${label}: historical`);
    const chosen = selectPreOffRun(runs, off);
    assert.equal(chosen?.run_id, preoff, `${label}: selects the pre-off run`);
  }
});

/* --------------------- live/upcoming card unchanged ----------------------- */

test('live card: an upcoming race is not historical, so the current run is used (unchanged)', () => {
  // Upcoming race relative to `soon`; the latest run is also the current run.
  const soon = new Date('2026-06-16T15:50:00.000Z');
  const off = '2026-06-16T16:00:00Z';
  assert.equal(isHistoricalRaceView({ off_time: off, status: 'open' }, soon), false);

  // For an upcoming race every run is pre-off anyway, so pre-off selection and
  // the current run agree — there is no divergence to introduce.
  const runs: CardRun[] = [
    { run_id: 'earlier', run_time: '2026-06-16T15:40:00Z', is_current: false },
    { run_id: 'current', run_time: '2026-06-16T15:49:00Z', is_current: true },
  ];
  const current = runs.filter((r) => r.is_current).sort((a, b) => b.run_time.localeCompare(a.run_time))[0];
  const preOff = selectPreOffRun(runs, off);
  assert.equal(current.run_id, 'current');
  assert.equal(preOff?.run_id, 'current'); // agree for an upcoming race
});
