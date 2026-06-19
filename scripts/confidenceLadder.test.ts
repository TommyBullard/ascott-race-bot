/**
 * Tests for the evidence-based confidence LADDER (display-only).
 *
 * Proves the upgrade rules are evidence-based and deterministic, that the hard
 * caps hold (stale odds / invalid-or-critical data / missing odds / suppression
 * can never be HIGH), that no-tipster-consensus alone does not force LOW, that
 * HIGH needs multiple positive signals, and that the ladder touches no staking /
 * betting / GenAI / ML and is wired into the dashboard for display only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  evaluateConfidenceLadder,
  cardConfidenceLadder,
  buildLadderSignalsFromCard,
  type LadderSignals,
  type LadderCardInput,
} from '../src/lib/confidenceLadder';

/** A baseline strong signal set (everything aligned) → HIGH. */
function strong(over: Partial<LadderSignals> = {}): LadderSignals {
  return {
    ev: 0.12,
    modelProb: 0.45,
    marketProb: 0.38,
    modelIsFavourite: true,
    modelIsMostLikely: true,
    runQuality: 'OK',
    oddsStale: false,
    marketCompleteness: 1,
    criticalDataFlags: [],
    missingRunnerOdds: false,
    fieldSize: 8,
    suppressed: false,
    tipsterAlignmentLabel: 'ALIGNED',
    stability: null,
    ...over,
  };
}

test('HIGH requires multiple positive signals (all aligned → HIGH)', () => {
  const r = evaluateConfidenceLadder(strong());
  assert.equal(r.label, 'HIGH');
  assert.ok(r.positives.length >= 5);
  assert.match(r.reason, /^HIGH because /);
});

test('stale odds cannot be HIGH (forced LOW)', () => {
  const r = evaluateConfidenceLadder(strong({ oddsStale: true }));
  assert.notEqual(r.label, 'HIGH');
  assert.equal(r.label, 'LOW');
  assert.match(r.reason, /stale odds/);
});

test('INVALID/STALE or critical data cannot be HIGH; DEGRADED caps at MEDIUM', () => {
  assert.equal(evaluateConfidenceLadder(strong({ runQuality: 'INVALID' })).label, 'LOW');
  assert.equal(evaluateConfidenceLadder(strong({ runQuality: 'STALE' })).label, 'LOW');
  assert.equal(
    evaluateConfidenceLadder(strong({ criticalDataFlags: ['NO_MARKET_SNAPSHOT'] })).label,
    'LOW',
  );
  const deg = evaluateConfidenceLadder(strong({ runQuality: 'DEGRADED' }));
  assert.notEqual(deg.label, 'HIGH');
  assert.equal(deg.label, 'MEDIUM');
});

test('missing material runner odds cannot be HIGH (forced LOW)', () => {
  assert.equal(evaluateConfidenceLadder(strong({ missingRunnerOdds: true })).label, 'LOW');
  assert.equal(evaluateConfidenceLadder(strong({ marketCompleteness: 0.5 })).label, 'LOW');
});

test('no-tipster-consensus ALONE does not force LOW when other evidence is strong', () => {
  const r = evaluateConfidenceLadder(strong({ tipsterAlignmentLabel: 'NO_TIPSTER_CONSENSUS' }));
  assert.notEqual(r.label, 'LOW');
  assert.ok(r.downgrades.includes('no tipster consensus'));
});

test('no tipster consensus + large/volatile field DOES force LOW', () => {
  const r = evaluateConfidenceLadder(
    strong({ tipsterAlignmentLabel: 'NO_TIPSTER_CONSENSUS', fieldSize: 20 }),
  );
  assert.equal(r.label, 'LOW');
  assert.match(r.reason, /no tipster consensus|large\/volatile field/);
});

test('model/favourite agreement upgrades to MEDIUM with clean data (EV positive, not strong)', () => {
  const r = evaluateConfidenceLadder(
    strong({ ev: 0.02, modelIsFavourite: true, tipsterAlignmentLabel: 'NO_TIPSTER_CONSENSUS' }),
  );
  assert.equal(r.label, 'MEDIUM');
  assert.match(r.reason, /^MEDIUM because /);
  assert.ok(r.positives.includes('model agrees with market favourite'));
});

test('strong EV + stable repeated pick upgrades to at least MEDIUM', () => {
  const r = evaluateConfidenceLadder(
    strong({
      modelIsMostLikely: false, // so not HIGH-eligible
      modelIsFavourite: true, // still supported, so not forced LOW
      stability: { samePickRuns: 3, evStayedPositive: true, oddsStable: true, qualityHeldUp: true },
    }),
  );
  assert.equal(r.label, 'MEDIUM');
  assert.ok(r.positives.includes('pick stable across recent runs'));
});

test('weak / absent EV forces LOW', () => {
  assert.equal(evaluateConfidenceLadder(strong({ ev: 0 })).label, 'LOW');
  assert.equal(evaluateConfidenceLadder(strong({ ev: null })).label, 'LOW');
});

test('pick that is neither most-likely nor favourite nor large-edge → LOW', () => {
  const r = evaluateConfidenceLadder(
    strong({ modelIsMostLikely: false, modelIsFavourite: false, modelProb: 0.2, marketProb: 0.2 }),
  );
  assert.equal(r.label, 'LOW');
});

test('stake suppression cannot be HIGH (forced LOW)', () => {
  const r = evaluateConfidenceLadder(strong({ suppressed: true }));
  assert.equal(r.label, 'LOW');
  assert.match(r.reason, /suppression/);
});

test('labels are deterministic (same input → same output)', () => {
  const s = strong({ tipsterAlignmentLabel: 'NO_TIPSTER_CONSENSUS' });
  assert.deepEqual(evaluateConfidenceLadder(s), evaluateConfidenceLadder(s));
});

test('reasons start with the label and explain the verdict', () => {
  assert.match(evaluateConfidenceLadder(strong()).reason, /^HIGH because /);
  assert.match(
    evaluateConfidenceLadder(strong({ ev: 0.02, modelIsMostLikely: false })).reason,
    /^MEDIUM because /,
  );
  assert.match(evaluateConfidenceLadder(strong({ oddsStale: true })).reason, /^LOW because /);
});

/* -------------------------------------------------------------------------- */
/* Card mapping (dashboard display)                                            */
/* -------------------------------------------------------------------------- */

function card(over: Partial<LadderCardInput> = {}): LadderCardInput {
  return {
    modelPick: { ev: 0.12, model_prob: 0.45, market_prob: 0.38, isFavourite: true },
    runners: [{ model_prob: 0.45 }, { model_prob: 0.3 }, { model_prob: 0.25 }],
    observability: { runQuality: 'OK', tipsterModelAlignment: { alignment_label: 'ALIGNED' } },
    latestOddsSnapshotTime: new Date().toISOString(),
    ...over,
  };
}

test('cardConfidenceLadder: fresh, clean, aligned card → HIGH', () => {
  const r = cardConfidenceLadder(card(), Date.now());
  assert.ok(r);
  assert.equal(r!.label, 'HIGH');
});

test('cardConfidenceLadder: stale snapshot → not HIGH', () => {
  const old = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
  const r = cardConfidenceLadder(card({ latestOddsSnapshotTime: old }), Date.now());
  assert.ok(r && r.label !== 'HIGH');
});

test('cardConfidenceLadder: no pick → null', () => {
  assert.equal(cardConfidenceLadder(card({ modelPick: null }), Date.now()), null);
});

test('buildLadderSignalsFromCard: most-likely derived from the field', () => {
  const s = buildLadderSignalsFromCard(
    card({
      modelPick: { ev: 0.12, model_prob: 0.3, market_prob: 0.28, isFavourite: true },
      runners: [{ model_prob: 0.5 }, { model_prob: 0.3 }],
    }),
    Date.now(),
  );
  assert.ok(s);
  assert.equal(s!.modelIsMostLikely, false);
  // The live mapping never fabricates completeness / suppression / stability.
  assert.equal(s!.marketCompleteness, null);
  assert.equal(s!.suppressed, false);
  assert.equal(s!.stability, null);
});

/* -------------------------------------------------------------------------- */
/* Safety scans                                                                */
/* -------------------------------------------------------------------------- */

test('ladder lib touches no staking/betting/GenAI/ML and does no I/O', () => {
  const src = readFileSync('src/lib/confidenceLadder.ts', 'utf8');
  // No import of, or call into, the decision engines.
  assert.doesNotMatch(src, /from '\.\/(bettingEngine|modelStakeSuppression|runModelForRace|modelProbabilities)'/);
  assert.doesNotMatch(src, /kellyStake\s*\(|calculateEV\s*\(|labelConfidence\s*\(|scoreRaceRunners\s*\(/);
  assert.doesNotMatch(src, /placeOrder|placeBet|submitOrder|autoBet/i);
  // GenAI/ML are never imported or consumed → they cannot raise the ladder.
  assert.doesNotMatch(src, /import[^\n]*[gG]enai/);
  assert.doesNotMatch(src, /import[^\n]*[oO]pen[aA][iI]/);
  assert.doesNotMatch(src, /import[^\n]*\bml[A-Z]/);
  assert.doesNotMatch(src, /supabaseAdmin|fetch\(|node:fs|Math\.random/);
});

test('dashboard uses the ladder reason + label for display only (no betting/commit added)', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.match(page, /cardConfidenceLadder\(/);
  assert.match(page, /ladder\.reason/); // explanation is shown
  assert.match(page, /ladderToDisplay\(ladder\.label\)/); // label is shown
  assert.doesNotMatch(page, /placeOrder|placeBet|submitOrder/);
});
