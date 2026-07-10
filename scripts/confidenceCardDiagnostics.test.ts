/**
 * Tests for the read-only race-card -> confidence-diagnostic mapping
 * (src/lib/confidenceCardDiagnostics.ts), the dashboard's "why this
 * confidence?" panel. Proves the mapping is pure/null-safe, that it reuses
 * `confidenceDiagnostics.ts`'s components verbatim (no drift from
 * `npm run confidence:audit`), and includes a fixture close to the
 * Newmarket 2026-07-10 audit finding: OK data, low market completeness, no
 * tipster consensus, original label LOW -> diagnostic overall MEDIUM,
 * limited by market. Also proves the module is genuinely display-only (no
 * DB/fs/network, no writes).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildConfidenceInputsFromCard,
  cardConfidenceDiagnostic,
  type ConfidenceCardInput,
} from '../src/lib/confidenceCardDiagnostics';

const NOW_MS = Date.parse('2026-07-10T14:00:00.000Z');

/** A baseline card with a fresh, complete-market, non-handicap pick. */
function card(over: Partial<ConfidenceCardInput> = {}): ConfidenceCardInput {
  return {
    race_id: 'race-1',
    off_time: '2026-07-10T14:30:00.000Z',
    race_name: 'Test Stakes',
    isHandicap: false,
    latestOddsSnapshotTime: '2026-07-10T13:59:00.000Z',
    modelPick: {
      horse_name: 'Test Pick',
      confidence_label: 'medium',
      ev: 0.06,
      model_prob: 0.3,
      market_prob: 0.2,
      odds: 4.0,
    },
    runners: [{ ev: 0.06 }, { ev: -0.02 }, { ev: -0.1 }],
    observability: {
      runQuality: 'OK',
      tipsterModelAlignment: { alignment_label: 'ALIGNED' },
      marketCompleteness: 1,
    },
    ...over,
  };
}

/* ------------------------- buildConfidenceInputsFromCard ------------------ */

test('maps market completeness, handicap flag, and separation straight through', () => {
  const inputs = buildConfidenceInputsFromCard(card(), NOW_MS);
  assert.equal(inputs.market_completeness, 1);
  assert.equal(inputs.is_handicap, false);
  assert.ok(inputs.model_market_separation !== null);
  assert.ok(Math.abs((inputs.model_market_separation ?? 0) - 0.1) < 1e-9);
  assert.equal(inputs.field_size, 3);
  assert.equal(inputs.pick_odds, 4.0);
  assert.equal(inputs.odds_stale, false);
  assert.equal(inputs.has_reviewed_context, false);
});

test('similar_ev is computed from the runner field via detectSimilarEv', () => {
  const clustered = buildConfidenceInputsFromCard(
    card({ runners: [{ ev: 0.05 }, { ev: 0.051 }, { ev: 0.049 }] }),
    NOW_MS,
  );
  assert.equal(clustered.similar_ev, true);

  const separated = buildConfidenceInputsFromCard(
    card({ runners: [{ ev: 0.2 }, { ev: 0.01 }, { ev: -0.05 }] }),
    NOW_MS,
  );
  assert.equal(separated.similar_ev, false);
});

test('odds_stale: true once the snapshot exceeds the freshness threshold', () => {
  const fresh = buildConfidenceInputsFromCard(
    card({ latestOddsSnapshotTime: '2026-07-10T13:59:30.000Z' }),
    NOW_MS,
  );
  assert.equal(fresh.odds_stale, false);

  const stale = buildConfidenceInputsFromCard(
    card({ latestOddsSnapshotTime: '2026-07-10T10:00:00.000Z' }),
    NOW_MS,
  );
  assert.equal(stale.odds_stale, true);

  // Unknown snapshot time -> never accuse "fresh" without evidence.
  const unknown = buildConfidenceInputsFromCard(card({ latestOddsSnapshotTime: null }), NOW_MS);
  assert.equal(unknown.odds_stale, true);
});

test('no pick: odds_stale left null (nothing to evaluate), never fabricated', () => {
  const inputs = buildConfidenceInputsFromCard(card({ modelPick: null }), NOW_MS);
  assert.equal(inputs.odds_stale, null);
  assert.equal(inputs.pick_odds, null);
});

test('tipster alignment label read from observability; missing -> null (never a negative)', () => {
  const aligned = buildConfidenceInputsFromCard(card(), NOW_MS);
  assert.equal(aligned.tipster_alignment_label, 'ALIGNED');

  const missing = buildConfidenceInputsFromCard(
    card({ observability: { runQuality: 'OK' } }),
    NOW_MS,
  );
  assert.equal(missing.tipster_alignment_label, null);
});

test('data_quality_flags is always [] (not currently surfaced on the card) -- documented limitation', () => {
  const inputs = buildConfidenceInputsFromCard(card(), NOW_MS);
  assert.deepEqual(inputs.data_quality_flags, []);
});

/* ----------------------------- cardConfidenceDiagnostic -------------------- */

test('no model pick: returns null (nothing to explain), never fabricates a diagnostic', () => {
  assert.equal(cardConfidenceDiagnostic(card({ modelPick: null }), NOW_MS), null);
});

test('strong card: reuses buildRaceDiagnostic verbatim -> HIGH-leaning components, original label preserved', () => {
  const diag = cardConfidenceDiagnostic(card(), NOW_MS);
  assert.ok(diag);
  assert.equal(diag.original_confidence_label, 'medium');
  assert.equal(diag.data.level, 'high');
  assert.equal(diag.market.level, 'high');
  assert.equal(diag.tipster.level, 'high');
  assert.equal(diag.race_type.level, 'high');
});

test('Newmarket 2026-07-10 audit fixture: OK data, mid market completeness, no tipster consensus, original LOW -> diagnostic MEDIUM, limited by market', () => {
  const c = card({
    modelPick: {
      horse_name: 'Some Runner',
      confidence_label: 'low',
      ev: 0.03,
      model_prob: 0.18,
      market_prob: 0.13,
      odds: 6.5,
    },
    runners: [{ ev: 0.03 }, { ev: -0.01 }, { ev: -0.08 }],
    observability: {
      runQuality: 'OK',
      tipsterModelAlignment: null, // NO_TIPSTER_CONSENSUS -> unknown, not negative
      marketCompleteness: 0.85, // near-complete (>= 0.80) but short of the 0.95 HIGH floor
    },
  });
  const diag = cardConfidenceDiagnostic(c, NOW_MS);
  assert.ok(diag);
  assert.equal(diag.original_confidence_label, 'low');
  assert.equal(diag.market.level, 'medium');
  assert.equal(diag.tipster.level, 'unknown'); // absence, never a negative
  assert.equal(diag.data.level, 'high');
  assert.equal(diag.overall.level, 'medium'); // weakest KNOWN component (market), tipster excluded
  assert.match(diag.overall.reason, /market/);
});

/* --------------------------- safety source scans --------------------------- */

test('the card-diagnostics mapping has no DB / fs / env / network access, and no writes', () => {
  const src = readFileSync('src/lib/confidenceCardDiagnostics.ts', 'utf8');
  assert.equal(/supabaseAdmin|node:fs|process\.env|\bfetch\s*\(/.test(src), false);
  assert.equal(/\.(insert|update|upsert|delete)\s*\(/.test(src), false);
});
