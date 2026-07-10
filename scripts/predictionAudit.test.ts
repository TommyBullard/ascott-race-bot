/**
 * Tests for the Prediction Audit helpers (src/lib/predictionAudit.ts) behind
 * the read-only /results-audit page.
 *
 * Proves the card -> Phase 5A input mapping, the divergence badges, and the
 * summary counts — and re-asserts the honesty invariants at this layer:
 * pending races are never losses; locked_no_bet / no_run_available /
 * lock_missing are never losses; official P/L uses stored LOCKED odds/stake
 * only (never the diagnostic's); lock_missing softens to not_locked_yet only
 * while the window is open. The regression fixtures are Newmarket 2026-07-09
 * (coverage 5/7, Shipbourne/Asmen Warrior divergence) and 2026-07-10
 * (7/7, W4/L2, one diagnostic-won-official-lost). Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  auditConfidenceAsOfMs,
  cardToAuditInput,
  buildPredictionAuditRow,
  divergenceBadge,
  summarizePredictionAudit,
  type AuditCardInput,
} from '../src/lib/predictionAudit';
import type { LockedDecision } from '../src/lib/lockedDecisionRead';

const NOW_MS = Date.parse('2026-07-10T20:00:00.000Z'); // evening — all offs past

/** A complete locked pick with terse-test defaults. */
function lockedPick(over: Partial<LockedDecision> = {}): LockedDecision {
  return {
    decision_status: 'locked_pick',
    lock_time: '2026-07-10T14:20:00.000Z',
    minutes_before: 5,
    capture_target_time: '2026-07-10T14:20:00.000Z',
    off_time_at_lock: '2026-07-10T14:25:00.000Z',
    model_run_id: 'run-1',
    no_bet_reason: null,
    pick_runner_id: 'r-official',
    pick_horse_name: 'Official Pick',
    pick_odds: 4.0,
    pick_ev: 0.08,
    pick_model_prob: 0.3,
    pick_market_prob: 0.25,
    pick_stake: 1.0,
    pick_confidence_label: 'low',
    run_quality: 'OK',
    data_quality_flags: [],
    data_quality_short_summary: null,
    tipster_short_summary: null,
    tipster_alignment_label: null,
    locked_state_schema_version: 1,
    ...over,
  };
}

/** A settled card: official pick lost, diagnostic (different) pick won. */
function card(over: Partial<AuditCardInput> = {}): AuditCardInput {
  return {
    race_id: 'race-1',
    off_time: '2026-07-10T14:25:00.000Z',
    race_name: 'Test Stakes',
    course: 'Newmarket',
    modelPick: {
      runner_id: 'r-diag',
      horse_name: 'Diagnostic Pick',
      odds: 6.0,
      ev: 0.1,
      stake_amount: 0.5,
      confidence_label: 'low',
      finish_pos: 1,
    },
    runners: [
      { runner_id: 'r-diag', horse_name: 'Diagnostic Pick', finish_pos: 1 },
      { runner_id: 'r-official', horse_name: 'Official Pick', finish_pos: 4 },
      { runner_id: 'r-other', horse_name: 'Other', finish_pos: 2 },
    ],
    hasModelRun: true,
    lockedDecision: lockedPick(),
    ...over,
  };
}

/* ------------------------------ cardToAuditInput --------------------------- */

test('cardToAuditInput: locked passthrough, winner/settled from finish_pos, diagnostic + detail mapped', () => {
  const { input, diagnosticDetail } = cardToAuditInput(card());
  assert.equal(input.locked?.pick_horse_name, 'Official Pick');
  assert.equal(input.settled, true);
  assert.equal(input.winner_name, 'Diagnostic Pick');
  assert.equal(input.locked_pick_finish, 4);
  assert.equal(input.diagnostic?.runner_id, 'r-diag');
  assert.equal(input.diagnostic?.odds, 6.0);
  assert.equal(input.diagnostic?.finish_pos, 1);
  assert.equal(input.diagnostic_run_exists, true);
  assert.deepEqual(diagnosticDetail, {
    stake_amount: 0.5,
    ev: 0.1,
    confidence_label: 'low',
  });
});

test('cardToAuditInput: null-safety — no pick, no lock, empty runners never fabricate', () => {
  const { input, diagnosticDetail } = cardToAuditInput({
    race_id: 'bare',
    modelPick: null,
    runners: [],
    hasModelRun: false,
    lockedDecision: null,
  });
  assert.equal(input.locked, null);
  assert.equal(input.settled, false);
  assert.equal(input.winner_name, null);
  assert.equal(input.diagnostic, null);
  assert.equal(input.diagnostic_run_exists, false);
  assert.equal(diagnosticDetail, null);
});

/* ------------------------------ badges ------------------------------------- */

function rowFor(over: Partial<AuditCardInput> = {}) {
  return buildPredictionAuditRow(card(over), NOW_MS);
}

test('badge: diagnostic won, official lost (the headline divergence)', () => {
  const row = rowFor();
  assert.equal(row.outcome_divergence, 'diagnostic_won_official_lost');
  assert.deepEqual(row.badge, { label: 'Diagnostic won, official lost', tone: 'warn' });
});

test('badge: same pick — both won / both lost', () => {
  const won = rowFor({
    lockedDecision: lockedPick({ pick_runner_id: 'r-diag', pick_horse_name: 'Diagnostic Pick' }),
  });
  assert.deepEqual(won.badge, { label: 'Same pick — both won', tone: 'pos' });

  const lost = rowFor({
    modelPick: {
      runner_id: 'r-official',
      horse_name: 'Official Pick',
      odds: 4.0,
      ev: 0.08,
      finish_pos: 4,
    },
  });
  assert.deepEqual(lost.badge, { label: 'Same pick — both lost', tone: 'neg' });
});

test('badge: official won, diagnostic lost', () => {
  const row = rowFor({
    runners: [
      { runner_id: 'r-diag', horse_name: 'Diagnostic Pick', finish_pos: 3 },
      { runner_id: 'r-official', horse_name: 'Official Pick', finish_pos: 1 },
    ],
    modelPick: {
      runner_id: 'r-diag',
      horse_name: 'Diagnostic Pick',
      odds: 6.0,
      ev: 0.1,
      finish_pos: 3,
    },
  });
  assert.equal(row.outcome_divergence, 'official_won_diagnostic_lost');
  assert.deepEqual(row.badge, { label: 'Official won, diagnostic lost', tone: 'pos' });
});

test('badge: official no-bet — diagnostic won / lost / no diagnostic', () => {
  const noBet = lockedPick({
    decision_status: 'locked_no_bet',
    no_bet_reason: 'no rank-1 recommendation',
    pick_runner_id: null,
  });
  const diagWon = rowFor({ lockedDecision: noBet });
  assert.deepEqual(diagWon.badge, { label: 'Official no-bet — diagnostic won', tone: 'warn' });

  const diagLost = rowFor({
    lockedDecision: noBet,
    modelPick: {
      runner_id: 'r-official',
      horse_name: 'Official Pick',
      odds: 4.0,
      ev: 0.08,
      finish_pos: 4,
    },
  });
  assert.deepEqual(diagLost.badge, { label: 'Official no-bet — diagnostic lost', tone: 'pos' });

  const noDiag = rowFor({ lockedDecision: noBet, modelPick: null });
  assert.deepEqual(noDiag.badge, { label: 'Official no-bet', tone: 'neutral' });
});

test('badge: lock missing / no-run -> fallback-only warnings; unsettled -> Result pending', () => {
  const missing = rowFor({ lockedDecision: null });
  assert.deepEqual(missing.badge, { label: 'Lock missing / fallback only', tone: 'warn' });

  const noRun = rowFor({
    lockedDecision: lockedPick({
      decision_status: 'no_run_available',
      model_run_id: null,
      pick_runner_id: null,
    }),
  });
  assert.deepEqual(noRun.badge, { label: 'No run at lock / fallback only', tone: 'warn' });

  const pending = rowFor({
    runners: [
      { runner_id: 'r-diag', horse_name: 'Diagnostic Pick', finish_pos: null },
      { runner_id: 'r-official', horse_name: 'Official Pick', finish_pos: null },
    ],
    modelPick: {
      runner_id: 'r-diag',
      horse_name: 'Diagnostic Pick',
      odds: 6.0,
      ev: 0.1,
      finish_pos: null,
    },
  });
  assert.deepEqual(pending.badge, { label: 'Result pending', tone: 'neutral' });
  assert.equal(pending.locked_outcome, 'pending');
});

test('time-aware: no lock + future off + unsettled -> Not locked yet, never LOCK MISSING', () => {
  const row = buildPredictionAuditRow(
    card({
      lockedDecision: null,
      off_time: '2026-07-10T21:30:00.000Z', // after NOW_MS
      runners: [{ runner_id: 'r-diag', horse_name: 'Diagnostic Pick', finish_pos: null }],
      modelPick: null,
    }),
    NOW_MS,
  );
  assert.equal(row.display_status, 'not_locked_yet');
  assert.deepEqual(row.badge, { label: 'Not locked yet', tone: 'neutral' });
  // The Phase 5A official status is untouched underneath (never rewritten).
  assert.equal(row.official_status, 'lock_missing');
});

/* --------------------------- honesty invariants ---------------------------- */

test('official P/L uses stored LOCKED odds/stake only — never the diagnostic figures', () => {
  // Official pick WON at locked odds 4.0 / stake 1.0; diagnostic had odds 6.0.
  const rows = [
    buildPredictionAuditRow(
      card({
        runners: [
          { runner_id: 'r-diag', horse_name: 'Diagnostic Pick', finish_pos: 5 },
          { runner_id: 'r-official', horse_name: 'Official Pick', finish_pos: 1 },
        ],
      }),
      NOW_MS,
    ),
  ];
  const summary = summarizePredictionAudit(rows);
  assert.equal(summary.official_winners, 1);
  // (4.0 - 1) * 1.0 = 3.0 — the LOCKED odds, not (6.0 - 1) from the diagnostic.
  assert.equal(summary.official.profit_loss, 3);
});

test('no-bet / no-run / missing / pending contribute ZERO official losers', () => {
  const rows = [
    rowFor({
      lockedDecision: lockedPick({
        decision_status: 'locked_no_bet',
        no_bet_reason: 'gate',
        pick_runner_id: null,
      }),
    }),
    rowFor({
      lockedDecision: lockedPick({
        decision_status: 'no_run_available',
        model_run_id: null,
        pick_runner_id: null,
      }),
    }),
    rowFor({ lockedDecision: null }),
    rowFor({
      runners: [{ runner_id: 'r-official', horse_name: 'Official Pick', finish_pos: null }],
      modelPick: null,
    }),
  ];
  const summary = summarizePredictionAudit(rows);
  assert.equal(summary.official_losers, 0);
  assert.equal(summary.official.losers, 0);
  assert.equal(summary.locked_no_bet, 1);
  assert.equal(summary.no_run_available, 1);
  assert.equal(summary.lock_missing, 1);
  assert.equal(summary.official_pending, 1);
});

/* ---------------------- Newmarket regression fixtures ---------------------- */

test('Newmarket 2026-07-09: coverage 5/7, missing 2, no-bet 2, official 0/3, Shipbourne/Asmen divergence', () => {
  const noBet = (id: string): AuditCardInput =>
    card({
      race_id: id,
      lockedDecision: lockedPick({
        decision_status: 'locked_no_bet',
        no_bet_reason: 'no rank-1 recommendation',
        pick_runner_id: null,
      }),
      modelPick: null,
      runners: [{ runner_id: 'w', horse_name: 'Winner', finish_pos: 1 }],
    });
  const lostPick = (id: string): AuditCardInput =>
    card({
      race_id: id,
      lockedDecision: lockedPick(),
      modelPick: {
        runner_id: 'r-official',
        horse_name: 'Official Pick',
        odds: 4.0,
        ev: 0.08,
        finish_pos: 4,
      },
    });
  const cards: AuditCardInput[] = [
    lostPick('r1'),
    lostPick('r2'),
    // Final race: official Shipbourne LOST, diagnostic Asmen Warrior WON.
    card({
      race_id: 'r-final',
      lockedDecision: lockedPick({ pick_runner_id: 'r-ship', pick_horse_name: 'Shipbourne', pick_odds: 5.0 }),
      modelPick: {
        runner_id: 'r-asmen',
        horse_name: 'Asmen Warrior',
        odds: 7.0,
        ev: 0.12,
        finish_pos: 1,
      },
      runners: [
        { runner_id: 'r-asmen', horse_name: 'Asmen Warrior', finish_pos: 1 },
        { runner_id: 'r-ship', horse_name: 'Shipbourne', finish_pos: 6 },
      ],
    }),
    noBet('r4'),
    noBet('r5'),
    card({ race_id: 'r6-missing', lockedDecision: null }),
    card({ race_id: 'r7-missing', lockedDecision: null }),
  ];
  const rows = cards.map((c) => buildPredictionAuditRow(c, NOW_MS));
  const s = summarizePredictionAudit(rows);

  assert.equal(s.races, 7);
  assert.equal(s.locked, 5);
  assert.equal(s.coverage_pct, 71.4);
  assert.equal(s.lock_missing, 2);
  assert.equal(s.locked_no_bet, 2);
  assert.equal(s.locked_picks, 3);
  assert.equal(s.official_winners, 0);
  assert.equal(s.official_losers, 3);
  assert.ok(s.diagnostic_won_official_lost >= 1);
  const final = rows.find((r) => r.race_id === 'r-final');
  assert.equal(final?.outcome_divergence, 'diagnostic_won_official_lost');
  assert.deepEqual(final?.badge, { label: 'Diagnostic won, official lost', tone: 'warn' });
});

test('Newmarket 2026-07-10: coverage 7/7, picks 6, official W4/L2, no-bet 1, diag-won-official-lost 1', () => {
  const winPick = (id: string): AuditCardInput =>
    card({
      race_id: id,
      lockedDecision: lockedPick({ pick_runner_id: 'r-diag', pick_horse_name: 'Diagnostic Pick' }),
    }); // same pick, both won
  const lostSame = (id: string): AuditCardInput =>
    card({
      race_id: id,
      modelPick: {
        runner_id: 'r-official',
        horse_name: 'Official Pick',
        odds: 4.0,
        ev: 0.08,
        finish_pos: 4,
      },
    }); // same pick, both lost
  const cards: AuditCardInput[] = [
    winPick('r1'),
    winPick('r2'),
    winPick('r3'),
    winPick('r4'),
    lostSame('r5'),
    // 14:25: official Libertango LOST, diagnostic Senorita Bonita WON.
    card({
      race_id: 'r-1425',
      lockedDecision: lockedPick({ pick_runner_id: 'r-lib', pick_horse_name: 'Libertango' }),
      modelPick: {
        runner_id: 'r-senorita',
        horse_name: 'Senorita Bonita',
        odds: 5.5,
        ev: 0.1,
        finish_pos: 1,
      },
      runners: [
        { runner_id: 'r-senorita', horse_name: 'Senorita Bonita', finish_pos: 1 },
        { runner_id: 'r-lib', horse_name: 'Libertango', finish_pos: 5 },
      ],
    }),
    card({
      race_id: 'r-nobet',
      lockedDecision: lockedPick({
        decision_status: 'locked_no_bet',
        no_bet_reason: 'no rank-1 recommendation',
        pick_runner_id: null,
      }),
      modelPick: null,
      runners: [{ runner_id: 'w', horse_name: 'Winner', finish_pos: 1 }],
    }),
  ];
  const rows = cards.map((c) => buildPredictionAuditRow(c, NOW_MS));
  const s = summarizePredictionAudit(rows);

  assert.equal(s.races, 7);
  assert.equal(s.locked, 7);
  assert.equal(s.coverage_pct, 100);
  assert.equal(s.lock_missing, 0);
  assert.equal(s.locked_picks, 6);
  assert.equal(s.official_winners, 4);
  assert.equal(s.official_losers, 2);
  assert.equal(s.locked_no_bet, 1);
  assert.equal(s.diagnostic_won_official_lost, 1);
  assert.equal(s.settled, 7);
  assert.equal(s.official_pending, 0);
});

/* ------------------- audit-safe confidence "as of" instant ----------------- */

test('auditConfidenceAsOfMs: run time preferred, then lock time, then off time, else null', () => {
  const run = '2026-07-10T14:21:00.000Z';
  const lock = '2026-07-10T14:20:00.000Z';
  const off = '2026-07-10T14:25:00.000Z';

  assert.equal(
    auditConfidenceAsOfMs({
      latestModelRunTime: run,
      lockedDecision: { lock_time: lock },
      off_time: off,
    }),
    Date.parse(run),
  );
  assert.equal(
    auditConfidenceAsOfMs({ lockedDecision: { lock_time: lock }, off_time: off }),
    Date.parse(lock),
  );
  assert.equal(auditConfidenceAsOfMs({ off_time: off }), Date.parse(off));
  // Nothing usable -> null (staleness then renders UNKNOWN, never wrongly low).
  assert.equal(auditConfidenceAsOfMs({}), null);
  assert.equal(
    auditConfidenceAsOfMs({ latestModelRunTime: 'junk', off_time: '' }),
    null,
  );
});

test('auditConfidenceAsOfMs: an unparseable run time falls through to the next source', () => {
  const off = '2026-07-10T14:25:00.000Z';
  assert.equal(
    auditConfidenceAsOfMs({ latestModelRunTime: 'not-a-date', off_time: off }),
    Date.parse(off),
  );
});

/* --------------------------- safety source scans --------------------------- */

test('predictionAudit.ts is pure: no DB / fs / env / network, no writes', () => {
  const src = readFileSync('src/lib/predictionAudit.ts', 'utf8');
  assert.equal(/supabaseAdmin|node:fs|process\.env|\bfetch\s*\(/.test(src), false);
  assert.equal(/\.(insert|update|upsert|delete)\s*\(/.test(src), false);
});

test('results-audit page is read-only: GET /api/recommendations only, no server-only imports', () => {
  const src = readFileSync('src/app/results-audit/page.tsx', 'utf8');
  assert.equal(/supabaseAdmin|@\/lib\/raceData|node:fs|process\.env/.test(src), false);
  assert.equal(/\.(insert|update|upsert|delete)\s*\(/.test(src), false);
  assert.equal(/method\s*:\s*['"](POST|PUT|PATCH|DELETE)/i.test(src), false);
  assert.ok(src.includes('/api/recommendations'));
});
