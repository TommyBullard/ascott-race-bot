/**
 * Unit tests for the read-only result-settlement status module
 * (src/lib/settlementStatus.ts) plus read-only source-scan guards on the panel
 * and dashboard wiring.
 *
 * Pure + deterministic given an injected `now`. The scans lock down the task's
 * rules: the settlement display is read-only — the website never commits, never
 * writes the DB, never calls an external API, never exposes `--commit`, and adds
 * no write button. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SETTLEMENT_READONLY_NOTE,
  deriveSettlementStatus,
  settlementStatusBadge,
  buildSettlementView,
  type SettlementStatus,
} from '../src/lib/settlementStatus';

const NOW = Date.parse('2026-06-17T18:30:00Z');
function offIso(minsFromNow: number): string {
  return new Date(NOW + minsFromNow * 60_000).toISOString();
}

/* ------------------------- status derivation ------------------------------ */

test('a resulted race is settled', () => {
  assert.equal(deriveSettlementStatus({ offTime: offIso(-120), now: NOW, status: 'result' }), 'settled');
  // settled wins even with a provided signal.
  assert.equal(
    deriveSettlementStatus({ offTime: offIso(-120), now: NOW, status: 'result', providedStatus: 'blocked' }),
    'settled',
  );
});

test('a finished, unsettled race with no signal is pending', () => {
  assert.equal(deriveSettlementStatus({ offTime: offIso(-30), now: NOW, status: null }), 'pending');
});

test('an upcoming race / unknown off time is unknown', () => {
  assert.equal(deriveSettlementStatus({ offTime: offIso(30), now: NOW, status: null }), 'unknown');
  assert.equal(deriveSettlementStatus({ offTime: null, now: NOW, status: null }), 'unknown');
  assert.equal(deriveSettlementStatus({ offTime: 'bad', now: NOW, status: null }), 'unknown');
});

test('settle-ready and blocked/conflict render only when provided', () => {
  assert.equal(
    deriveSettlementStatus({ offTime: offIso(-30), now: NOW, status: null, providedStatus: 'settle-ready' }),
    'settle-ready',
  );
  assert.equal(
    deriveSettlementStatus({ offTime: offIso(-30), now: NOW, status: null, providedStatus: 'blocked' }),
    'blocked',
  );
  // "conflict" maps to blocked.
  assert.equal(
    deriveSettlementStatus({ offTime: offIso(-30), now: NOW, status: null, providedStatus: 'conflict' }),
    'blocked',
  );
  // an unrecognised signal is ignored (falls through to derivation).
  assert.equal(
    deriveSettlementStatus({ offTime: offIso(-30), now: NOW, status: null, providedStatus: 'weird' }),
    'pending',
  );
});

/* ------------------------------- view-model ------------------------------- */

const FIELD = [
  { horse_name: 'Winner Horse', finish_pos: 1 },
  { horse_name: 'Runner Up', finish_pos: 2 },
  { horse_name: 'Model Pick Horse', finish_pos: 6 },
];

test('settled race surfaces the winner + model pick finishing position', () => {
  const view = buildSettlementView({
    offTime: offIso(-30),
    now: NOW,
    status: 'result',
    runners: FIELD,
    modelPickFinishPos: 6,
  });
  assert.equal(view.status, 'settled');
  assert.equal(view.settled, true);
  assert.equal(view.winnerName, 'Winner Horse');
  assert.equal(view.modelPickFinish, 6);
});

test('a non-settled race hides the winner + finish position', () => {
  const view = buildSettlementView({
    offTime: offIso(-30),
    now: NOW,
    status: null,
    runners: FIELD,
    modelPickFinishPos: 6,
  });
  assert.equal(view.status, 'pending');
  assert.equal(view.settled, false);
  assert.equal(view.winnerName, null);
  assert.equal(view.modelPickFinish, null);
});

test('a stored free-result note is surfaced; blank -> null', () => {
  assert.equal(
    buildSettlementView({ offTime: offIso(-30), now: NOW, status: 'result', freeResultNote: 'Free result matched.' }).freeResultNote,
    'Free result matched.',
  );
  assert.equal(
    buildSettlementView({ offTime: offIso(-30), now: NOW, status: 'result', freeResultNote: '   ' }).freeResultNote,
    null,
  );
});

/* -------------------------------- badges ---------------------------------- */

test('settlementStatusBadge: stable labels + tones', () => {
  const cases: Array<[SettlementStatus, string, string]> = [
    ['settled', 'Settled', 'pos'],
    ['settle-ready', 'Settle-ready', 'warn'],
    ['pending', 'Pending', 'warn'],
    ['blocked', 'Blocked / conflict', 'neg'],
    ['unknown', 'Unknown', 'neutral'],
  ];
  for (const [status, label, tone] of cases) {
    const b = settlementStatusBadge(status);
    assert.equal(b.label, label);
    assert.equal(b.tone, tone);
  }
});

test('the read-only disclaimer is present and makes no betting/commit claim', () => {
  assert.match(SETTLEMENT_READONLY_NOTE, /read-only/i);
  assert.equal(/--commit/.test(SETTLEMENT_READONLY_NOTE), false);
  assert.equal(/placeOrder|placeBet|auto-?bet/i.test(SETTLEMENT_READONLY_NOTE), false);
});

/* ------------------------------ determinism ------------------------------- */

test('buildSettlementView is deterministic for identical inputs', () => {
  const input = {
    offTime: offIso(-30),
    now: NOW,
    status: 'result',
    runners: FIELD,
    modelPickFinishPos: 6,
  };
  assert.deepEqual(buildSettlementView(input), buildSettlementView(input));
});

/* --------------------- read-only guards (source scans) -------------------- */

test('the settlement module is pure with no DB / fs / env / network / commit / bets', () => {
  const lib = readFileSync('src/lib/settlementStatus.ts', 'utf8');
  assert.equal(/^\s*import\s/m.test(lib), false);
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs/.test(lib), false);
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/\bfetch\s*\(/.test(lib), false);
  assert.equal(/--commit/.test(lib), false);
  assert.equal(/placeOrder|placeBet|submitOrder/i.test(lib), false);
});

test('the settlement panel is presentational: no fetch, DB, write methods, button, or commit', () => {
  const panel = readFileSync('src/components/SettlementStatusPanel.tsx', 'utf8');
  assert.equal(/\bfetch\s*\(/.test(panel), false);
  assert.equal(/supabaseAdmin/.test(panel), false);
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(panel), false);
  assert.equal(/--commit/.test(panel), false);
  assert.equal(/placeOrder|placeBet|submitOrder/i.test(panel), false);
  assert.equal(/<button|onClick/i.test(panel), false); // no write controls
});

test('the dashboard renders the read-only settlement panel', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.match(page, /SettlementStatusPanel/);
  assert.match(page, /buildSettlementView/);
  assert.equal(/--commit/.test(page), false);
});
