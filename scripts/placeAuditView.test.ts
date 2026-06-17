/**
 * Unit tests for the read-only place / each-way RESEARCH view
 * (src/lib/placeAuditView.ts) plus read-only source-scan guards on the pure
 * adapter, the dashboard panel, and its wiring into the page.
 *
 * The view is a thin, pure adapter over the existing `place:audit` helpers, so
 * the placed / won counts match the CLI report exactly and no DB / network is
 * needed. The scans lock down the task's rules: the summary is research-only,
 * never writes the DB, never computes a payout, never exposes `--commit`, never
 * places a bet, and the panel has no write controls. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  NOT_ADVICE_WARNING,
  NO_PAYOUT_WARNING,
  PLACE_SIMULATED_WARNING,
} from '../src/lib/placeAudit';
import {
  DEFAULT_PLACE_MARKER_LABEL,
  buildPlaceAuditView,
  researchPlaceMarkerLabel,
  type PlaceAuditCard,
} from '../src/lib/placeAuditView';

function runner(id: string, name: string, finish: number | null) {
  return { runner_id: id, horse_name: name, finish_pos: finish };
}

// Card A — model pick wins (1st), favourite places (2nd), one alt places (3rd).
const CARD_A: PlaceAuditCard = {
  race_id: 'A',
  off_time: '2026-06-17T14:00:00Z',
  race_name: 'Race A',
  course: 'Ascot',
  modelPick: runner('a', 'Alpha', 1),
  favourite: runner('b', 'Bravo', 2),
  alternatives: [runner('c', 'Charlie', 3), runner('d', 'Delta', 9)],
  runners: [
    runner('a', 'Alpha', 1),
    runner('b', 'Bravo', 2),
    runner('c', 'Charlie', 3),
    runner('d', 'Delta', 9),
    runner('e', 'Echo', 4),
  ],
  status: 'result',
  confidenceLabel: 'High',
  runQuality: 'OK',
};

// Card B — model pick lost but placed (3rd), favourite unplaced (5th), an
// alternative won (1st).
const CARD_B: PlaceAuditCard = {
  race_id: 'B',
  off_time: '2026-06-17T15:00:00Z',
  race_name: 'Race B',
  course: 'Ascot',
  modelPick: runner('m', 'Mike', 3),
  favourite: runner('n', 'November', 5),
  alternatives: [runner('o', 'Oscar', 1), runner('p', 'Papa', 8)],
  runners: [
    runner('o', 'Oscar', 1),
    runner('q', 'Quebec', 2),
    runner('m', 'Mike', 3),
    runner('r', 'Romeo', 4),
    runner('n', 'November', 5),
    runner('p', 'Papa', 8),
  ],
  status: 'result',
  confidenceLabel: 'Low',
  runQuality: 'DEGRADED',
};

// Card C — pending (no recorded result yet).
const CARD_C: PlaceAuditCard = {
  race_id: 'C',
  off_time: '2026-06-17T16:00:00Z',
  race_name: 'Race C',
  course: 'Ascot',
  modelPick: null,
  favourite: null,
  alternatives: [],
  runners: [],
  status: null,
};

/* ------------------------------- summary counts --------------------------- */

test('view counts model pick placed / won across the day', () => {
  const view = buildPlaceAuditView([CARD_B, CARD_A, CARD_C]); // out of order
  const s = view.summary;
  assert.equal(view.raceCount, 3);
  assert.equal(view.settledRaceCount, 2); // A + B settled, C pending
  assert.equal(view.hasSettledRaces, true);
  assert.equal(s.modelPickWon, 1); // A
  assert.equal(s.modelPickPlaced, 2); // A (1st) + B (3rd)
  assert.equal(s.modelPickLostButPlaced, 1); // B
});

test('view counts alternatives placed / won', () => {
  const s = buildPlaceAuditView([CARD_A, CARD_B, CARD_C]).summary;
  assert.equal(s.alternativesWon, 1); // B Oscar (1st)
  assert.equal(s.alternativesPlaced, 2); // A Charlie (3rd) + B Oscar (1st)
  assert.equal(s.racesWhereAlternativeWon, 1); // B
  assert.equal(s.racesWhereAlternativePlaced, 2); // A + B
});

test('view counts market favourite placed / won', () => {
  const s = buildPlaceAuditView([CARD_A, CARD_B, CARD_C]).summary;
  assert.equal(s.favouriteWon, 0); // Bravo 2nd, November 5th
  assert.equal(s.favouritePlaced, 1); // Bravo (2nd) within top-4; November (5th) not
});

test('the simulated place marker is configurable and defaults to top-4', () => {
  assert.equal(buildPlaceAuditView([CARD_A]).places, 4);
  assert.equal(buildPlaceAuditView([CARD_A]).placeMarkerLabel, 'Research top-4 marker');
  assert.equal(DEFAULT_PLACE_MARKER_LABEL, 'Research top-4 marker');

  assert.equal(researchPlaceMarkerLabel(null), 'Research top-4 marker'); // unknown -> default
  assert.equal(researchPlaceMarkerLabel(0), 'Research top-4 marker'); // invalid -> default
  assert.equal(researchPlaceMarkerLabel(3), 'Research top-3 marker');

  const top2 = buildPlaceAuditView([CARD_A], { places: 2 });
  assert.equal(top2.places, 2);
  assert.equal(top2.placeMarkerLabel, 'Research top-2 marker');
  assert.equal(top2.summary.favouritePlaced, 1); // Bravo 2nd still placed in top-2
});

test('a day with no settled races is flagged (counts not yet known)', () => {
  const view = buildPlaceAuditView([CARD_C]);
  assert.equal(view.raceCount, 1);
  assert.equal(view.settledRaceCount, 0);
  assert.equal(view.hasSettledRaces, false);
  assert.equal(view.summary.modelPickPlaced, 0);
});

test('an empty day yields a zero-race view (panel renders nothing)', () => {
  const view = buildPlaceAuditView([]);
  assert.equal(view.raceCount, 0);
  assert.equal(view.hasSettledRaces, false);
});

/* ------------------------------- disclaimers ------------------------------ */

test('the research disclaimers are always present', () => {
  const view = buildPlaceAuditView([CARD_A, CARD_B]);
  assert.deepEqual(view.warnings, [
    PLACE_SIMULATED_WARNING,
    NOT_ADVICE_WARNING,
    NO_PAYOUT_WARNING,
  ]);
  assert.match(view.warnings.join(' '), /SIMULATED/);
  assert.match(view.warnings.join(' '), /not betting advice/i);
  assert.match(view.warnings.join(' '), /No each-way payout/i);
});

/* ------------------------------- determinism ------------------------------ */

test('view construction is deterministic', () => {
  assert.deepEqual(
    buildPlaceAuditView([CARD_A, CARD_B, CARD_C]),
    buildPlaceAuditView([CARD_A, CARD_B, CARD_C]),
  );
});

/* --------------------- read-only guards (source scans) -------------------- */

test('the place-audit view module is pure (only depends on placeAudit; no DB/fs/env/network)', () => {
  const lib = readFileSync('src/lib/placeAuditView.ts', 'utf8');
  // Every import must resolve to the pure place-audit helpers — nothing else.
  const importSources = lib.match(/from\s+'[^']+'/g) ?? [];
  assert.ok(importSources.length > 0);
  for (const src of importSources) {
    assert.match(src, /'@\/lib\/placeAudit'/);
  }
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs/.test(lib), false);
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/\bfetch\s*\(/.test(lib), false);
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(lib), false);
  assert.equal(/--commit/.test(lib), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/i.test(lib), false);
  assert.equal(/bettingEngine|modelProbabilities|kellyStake|scoreRaceRunners/.test(lib), false);
  // No payout / monetary computation.
  assert.equal(/£\s*\d/.test(lib), false);
  assert.equal(/\b\d+(\.\d+)?\s*(pt|pts|points)\b/i.test(lib), false);
  assert.equal(/\bROI\b/.test(lib), false);
});

test('the place-audit panel is read-only (no fetch/DB/write controls, no payout, no orders)', () => {
  const panel = readFileSync('src/components/PlaceAuditPanel.tsx', 'utf8');
  assert.equal(/\bfetch\s*\(/.test(panel), false);
  assert.equal(/supabaseAdmin/.test(panel), false);
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(panel), false);
  assert.equal(/--commit/.test(panel), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/i.test(panel), false);
  // No interactive write controls.
  assert.equal(/<button/i.test(panel), false);
  assert.equal(/onClick/.test(panel), false);
  assert.equal(/<input/i.test(panel), false);
  assert.equal(/<form/i.test(panel), false);
  // No payout / monetary computation.
  assert.equal(/£\s*\d/.test(panel), false);
  assert.equal(/\b\d+(\.\d+)?\s*(pt|pts|points)\b/i.test(panel), false);
  assert.equal(/\bROI\b/.test(panel), false);
  // It surfaces the research disclaimers built by the view.
  assert.match(panel, /view\.warnings/);
});

test('the dashboard renders the place-audit panel and stays read-only', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.match(page, /buildPlaceAuditView/);
  assert.match(page, /<PlaceAuditPanel/);
  // The page itself never writes the DB, never exposes a commit flag, never
  // places a bet from the place-audit wiring.
  assert.equal(/--commit/.test(page), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/i.test(page), false);
});
