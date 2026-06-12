/**
 * Unit tests for the backtest comparison math (src/lib/backtestStats).
 *
 * Pure, synthetic rows only — no DB, no network. These lock down the strike
 * rate / ROI / P&L / max-drawdown / odds-band aggregation so the comparison
 * table is trustworthy even when the database has no settled races to exercise
 * it live. They assert the math, not any real betting result.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bandOf,
  maxDrawdown,
  summarize,
  type Evaluated,
} from '../src/lib/backtestStats';

const APPROX = 1e-9;
const close = (a: number, b: number, eps = APPROX) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

function bet(over: Partial<Evaluated>): Evaluated {
  return {
    raceId: 'r',
    pickOdds: 4,
    pickPositiveEV: false,
    won: false,
    profit: -1,
    band: '3.0-8.0',
    ...over,
  };
}

test('bandOf: boundaries 3.0 and 8.0 fall in the middle band', () => {
  assert.equal(bandOf(2.99), '<3.0');
  assert.equal(bandOf(3.0), '3.0-8.0');
  assert.equal(bandOf(8.0), '3.0-8.0');
  assert.equal(bandOf(8.01), '>8.0');
});

test('maxDrawdown: peak-to-trough of cumulative P/L, never negative', () => {
  assert.equal(maxDrawdown([]), 0);
  assert.equal(maxDrawdown([2, 3, 4]), 0); // monotonically rising
  // curve: +2, +1, -3 (cum 2,3,0) -> peak 3, trough 0 => dd 3
  close(maxDrawdown([2, 1, -3]), 3);
  // -1,-1,-1,+5 (cum -1,-2,-3,2) peak 0 -> trough -3 => dd 3
  close(maxDrawdown([-1, -1, -1, 5]), 3);
  // single losing bet: cum -1, peak 0 => dd 1
  close(maxDrawdown([-1]), 1);
});

test('summarize: overall strike rate, P/L, ROI, +EV count', () => {
  const evaluated: Evaluated[] = [
    bet({ won: true, profit: 3, band: '3.0-8.0', pickPositiveEV: true }),
    bet({ won: false, profit: -1, band: '<3.0' }),
    bet({ won: false, profit: -1, band: '>8.0' }),
    bet({ won: true, profit: 1.5, band: '<3.0', pickPositiveEV: true }),
  ];
  const s = summarize('TEST', evaluated);
  assert.equal(s.label, 'TEST');
  assert.equal(s.n, 4);
  assert.equal(s.wins, 2);
  close(s.strikeRatePct as number, 50);
  close(s.profit, 2.5); // 3 - 1 - 1 + 1.5
  close(s.roiPct as number, (2.5 / 4) * 100);
  assert.equal(s.positiveEv, 2);
});

test('summarize: empty -> null rates (not NaN), zero counts', () => {
  const s = summarize('EMPTY', []);
  assert.equal(s.n, 0);
  assert.equal(s.wins, 0);
  assert.equal(s.strikeRatePct, null);
  assert.equal(s.roiPct, null);
  assert.equal(s.profit, 0);
  assert.equal(s.maxDrawdown, 0);
  for (const b of s.bands) {
    assert.equal(b.races, 0);
    assert.equal(b.strikeRatePct, null);
    assert.equal(b.roiPct, null);
  }
});

test('summarize: per-band breakdown isolates each odds band', () => {
  const evaluated: Evaluated[] = [
    bet({ won: true, profit: 1.4, band: '<3.0' }),
    bet({ won: false, profit: -1, band: '<3.0' }),
    bet({ won: true, profit: 5, band: '>8.0' }),
  ];
  const s = summarize('BANDS', evaluated);
  const byBand = new Map(s.bands.map((b) => [b.band, b]));

  const short = byBand.get('<3.0')!;
  assert.equal(short.races, 2);
  assert.equal(short.wins, 1);
  close(short.strikeRatePct as number, 50);
  close(short.profit, 0.4);
  close(short.roiPct as number, (0.4 / 2) * 100);

  const mid = byBand.get('3.0-8.0')!;
  assert.equal(mid.races, 0);
  assert.equal(mid.strikeRatePct, null);

  const high = byBand.get('>8.0')!;
  assert.equal(high.races, 1);
  close(high.roiPct as number, 500);
});

test('summarize: drawdown reflects bet order', () => {
  // Win then lose-lose-lose: cum 3,2,1,0 -> dd from peak 3 = 3.
  const s = summarize('DD', [
    bet({ won: true, profit: 3 }),
    bet({ profit: -1 }),
    bet({ profit: -1 }),
    bet({ profit: -1 }),
  ]);
  close(s.maxDrawdown, 3);
  close(s.profit, 0);
});
