/**
 * Pure, client-safe helpers for the read-only Prediction Audit page
 * (/results-audit).
 *
 * Maps the race cards ALREADY served by GET /api/recommendations into the
 * Phase 5A locked-decision classification (`lockedDayReport.ts` — reused
 * VERBATIM, zero re-implementation) plus the display extras the audit page
 * needs: a time-aware lock status, the diagnostic pick's own outcome, a
 * divergence badge, and the day summary counts.
 *
 * HONESTY RULES (inherited from the Phase 5A core and re-asserted by
 * predictionAudit.test.ts):
 *   - The OFFICIAL decision is the `locked_race_decisions` T-minus-5 row; the
 *     final pre-off model pick is DIAGNOSTIC / comparison only.
 *   - Pending races are never losses; `locked_no_bet` is a valid decision
 *     (never a loss); `no_run_available` and `lock_missing` are separate
 *     buckets (never losses); lock_missing is NEVER backfilled.
 *   - Official P/L uses ONLY the stored locked pick odds/stake (shared
 *     `summarizeModelPerformance`); nothing is fabricated.
 *   - A race with no lock row is "Not locked yet" while its window is still
 *     open (now <= off and unsettled) — LOCK MISSING only once the off has
 *     passed or a winner is recorded (Phase 6A/5C rule).
 *
 * Pure and deterministic: no I/O, no DB, no clock (nowMs injected), no
 * mutation. Display/analysis only — never a betting instruction.
 */

import {
  buildLockedReportRace,
  type DiagnosticPick,
  type LockedReportRace,
  type LockedReportRaceInput,
} from './lockedDayReport';
import {
  summarizeModelPerformance,
  type ModelPerformance,
  type RecommendationOutcome,
} from './modelPerformance';
import { deriveRaceLockStatus } from './lockCoverage';
import type { LockedDecision } from './lockedDecisionRead';

/* -------------------------------------------------------------------------- */
/* Input shape (the /api/recommendations race card fields this module reads)  */
/* -------------------------------------------------------------------------- */

/** Minimal structural card shape (client-safe; NOT the server RaceCard). */
export interface AuditCardInput {
  race_id: string;
  off_time?: string | null;
  race_name?: string | null;
  course?: string | null;
  modelPick?: {
    runner_id: string;
    horse_name: string;
    odds: number | null;
    ev: number | null;
    stake_amount?: number | null;
    confidence_label?: string | null;
    finish_pos?: number | null;
  } | null;
  runners?: ReadonlyArray<{
    runner_id: string;
    horse_name: string;
    finish_pos?: number | null;
  }> | null;
  hasModelRun?: boolean;
  lockedDecision?: LockedDecision | null;
}

/** Diagnostic display extras not carried by the Phase 5A DiagnosticPick. */
export interface DiagnosticDetail {
  stake_amount: number | null;
  ev: number | null;
  confidence_label: string | null;
}

/* -------------------------------------------------------------------------- */
/* Card -> Phase 5A input mapping (pure)                                      */
/* -------------------------------------------------------------------------- */

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Maps one /api/recommendations card into the Phase 5A evaluation input plus
 * the diagnostic display extras. The card's `modelPick` IS the final pre-off
 * diagnostic for historical races (the API's display-run rule); `settled` and
 * the winner come only from stored `finish_pos = 1`. Pure; never fabricates —
 * an empty runner list yields a null winner name even when settled elsewhere.
 */
export function cardToAuditInput(card: AuditCardInput): {
  input: LockedReportRaceInput;
  diagnosticDetail: DiagnosticDetail | null;
} {
  const runners = card.runners ?? [];
  const winner = runners.find((r) => num(r.finish_pos) === 1) ?? null;
  const finishById = new Map(runners.map((r) => [String(r.runner_id), num(r.finish_pos)]));

  const pick = card.modelPick ?? null;
  const diagnostic: DiagnosticPick | null = pick
    ? {
        runner_id: String(pick.runner_id),
        horse_name: pick.horse_name,
        odds: num(pick.odds),
        finish_pos: num(pick.finish_pos) ?? finishById.get(String(pick.runner_id)) ?? null,
      }
    : null;

  const locked = card.lockedDecision ?? null;

  return {
    input: {
      race_id: card.race_id,
      race_name: card.race_name ?? null,
      course: card.course ?? null,
      off_time: card.off_time ?? null,
      locked,
      settled: winner !== null,
      winner_name: winner?.horse_name ?? null,
      locked_pick_finish: locked?.pick_runner_id
        ? (finishById.get(String(locked.pick_runner_id)) ?? null)
        : null,
      diagnostic,
      diagnostic_run_exists: card.hasModelRun === true,
    },
    diagnosticDetail: pick
      ? {
          stake_amount: num(pick.stake_amount),
          ev: num(pick.ev),
          confidence_label: pick.confidence_label ?? null,
        }
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Audit row (classification + display extras)                                */
/* -------------------------------------------------------------------------- */

/** The diagnostic pick's own outcome (comparison only, never official). */
export type DiagnosticOutcome = 'won' | 'lost' | 'pending' | null;

/** Divergence badge tone (matches the dashboard's badge tones). */
export type BadgeTone = 'pos' | 'neg' | 'warn' | 'neutral';

/** One race's fully-derived audit row. */
export interface PredictionAuditRow extends LockedReportRace {
  /**
   * Time-aware official display status: `lock_missing` softens to
   * `not_locked_yet` while the lock window is still open (unsettled AND
   * now <= off / off unknown). All other statuses pass through verbatim.
   */
  display_status:
    | 'locked_pick'
    | 'locked_no_bet'
    | 'no_run_available'
    | 'lock_missing'
    | 'not_locked_yet';
  /** The diagnostic pick's own outcome; null when there is no diagnostic pick. */
  diagnostic_outcome: DiagnosticOutcome;
  diagnosticDetail: DiagnosticDetail | null;
  badge: { label: string; tone: BadgeTone };
}

/** Evaluates the diagnostic pick's own outcome (comparison only). Pure. */
export function evaluateDiagnosticOutcome(
  input: LockedReportRaceInput,
): DiagnosticOutcome {
  if (!input.diagnostic) return null;
  if (!input.settled) return 'pending';
  return input.diagnostic.finish_pos === 1 ? 'won' : 'lost';
}

/**
 * The divergence badge: one plain-language label + tone per race, covering the
 * full required set. Precedence: no official basis first (lock missing /
 * not-yet / no-run), then pending, then no-bet cases, then settled pick-vs-pick
 * outcomes. Pure.
 */
export function divergenceBadge(row: {
  display_status: PredictionAuditRow['display_status'];
  settled: boolean;
  locked_outcome: LockedReportRace['locked_outcome'];
  diagnostic_outcome: DiagnosticOutcome;
  pick_divergence: LockedReportRace['pick_divergence'];
}): { label: string; tone: BadgeTone } {
  const s = row.display_status;
  if (s === 'not_locked_yet') return { label: 'Not locked yet', tone: 'neutral' };
  if (s === 'lock_missing') return { label: 'Lock missing / fallback only', tone: 'warn' };
  if (s === 'no_run_available') return { label: 'No run at lock / fallback only', tone: 'warn' };

  if (!row.settled) return { label: 'Result pending', tone: 'neutral' };

  if (s === 'locked_no_bet') {
    if (row.diagnostic_outcome === 'won') {
      return { label: 'Official no-bet — diagnostic won', tone: 'warn' };
    }
    if (row.diagnostic_outcome === 'lost') {
      return { label: 'Official no-bet — diagnostic lost', tone: 'pos' };
    }
    return { label: 'Official no-bet', tone: 'neutral' };
  }

  // locked_pick, settled.
  const officialWon = row.locked_outcome === 'won';
  const diagnosticWon = row.diagnostic_outcome === 'won';
  if (row.pick_divergence === 'same_pick') {
    return officialWon
      ? { label: 'Same pick — both won', tone: 'pos' }
      : { label: 'Same pick — both lost', tone: 'neg' };
  }
  if (officialWon && !diagnosticWon) {
    return { label: 'Official won, diagnostic lost', tone: 'pos' };
  }
  if (!officialWon && diagnosticWon) {
    return { label: 'Diagnostic won, official lost', tone: 'warn' };
  }
  return officialWon
    ? { label: 'Both won (different picks)', tone: 'pos' }
    : { label: 'Both lost (different picks)', tone: 'neg' };
}

/**
 * Builds one race's audit row: the Phase 5A classification verbatim, the
 * time-aware display status (Phase 6A rule + recorded-winner evidence, as in
 * Phase 5C), the diagnostic outcome, and the badge. Pure; `nowMs` injected.
 */
export function buildPredictionAuditRow(
  card: AuditCardInput,
  nowMs: number,
): PredictionAuditRow {
  const { input, diagnosticDetail } = cardToAuditInput(card);
  const classified = buildLockedReportRace(input);

  let display_status: PredictionAuditRow['display_status'] = classified.official_status;
  if (classified.official_status === 'lock_missing' && !input.settled) {
    // Window still open -> expected absence, not a gap (never accuse early).
    if (deriveRaceLockStatus(null, input.off_time, nowMs) === 'not_locked_yet') {
      display_status = 'not_locked_yet';
    }
  }

  const diagnostic_outcome = evaluateDiagnosticOutcome(input);
  const row = {
    ...classified,
    display_status,
    diagnostic_outcome,
    diagnosticDetail,
  };
  return { ...row, badge: divergenceBadge(row) };
}

/* -------------------------------------------------------------------------- */
/* Audit-safe confidence "as of" instant (pure)                               */
/* -------------------------------------------------------------------------- */

/**
 * The reference instant for judging a historical race's confidence signals
 * (odds staleness) on the audit page — the moment the decision was live, NOT
 * the viewing clock:
 *
 *   1. the displayed diagnostic model run's time (the run priced the snapshot),
 *   2. else the official lock time,
 *   3. else the scheduled off time,
 *   4. else null — staleness is then UNKNOWN, never accused.
 *
 * Prevents "limited by execution" appearing on settled races merely because
 * the audit is read hours later. Pure; display-only.
 */
export function auditConfidenceAsOfMs(card: {
  latestModelRunTime?: string | null;
  off_time?: string | null;
  lockedDecision?: { lock_time?: string | null } | null;
}): number | null {
  for (const iso of [
    card.latestModelRunTime,
    card.lockedDecision?.lock_time,
    card.off_time,
  ]) {
    if (typeof iso === 'string' && iso !== '') {
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Day summary (pure)                                                         */
/* -------------------------------------------------------------------------- */

/** The summary-strip counts (mirrors report:locked's headline figures). */
export interface PredictionAuditSummary {
  races: number;
  settled: number;
  /** Races with ANY official lock row. */
  locked: number;
  coverage_pct: number;
  locked_picks: number;
  official_winners: number;
  official_losers: number;
  official_pending: number;
  locked_no_bet: number;
  no_run_available: number;
  lock_missing: number;
  not_locked_yet: number;
  diagnostic_winners: number;
  diagnostic_won_official_lost: number;
  official_won_diagnostic_lost: number;
  /** Official P/L over locked picks ONLY, at stored locked odds/stake. */
  official: ModelPerformance;
}

/** Aggregates the audit rows into the summary-strip counts. Pure. */
export function summarizePredictionAudit(
  rows: readonly PredictionAuditRow[],
): PredictionAuditSummary {
  const lockedRows = rows.filter((r) => r.locked !== null);
  const outcomes: RecommendationOutcome[] = rows
    .filter((r) => r.official_status === 'locked_pick' && r.locked_outcome !== 'unevaluable')
    .map((r) => ({
      settled: r.settled,
      won: r.locked_outcome === 'won',
      odds: r.locked?.pick_odds ?? null,
      stake: r.locked?.pick_stake ?? null,
      ev: r.locked?.pick_ev ?? null,
    }));
  const lockedNoBet = rows.filter((r) => r.official_status === 'locked_no_bet').length;

  return {
    races: rows.length,
    settled: rows.filter((r) => r.settled).length,
    locked: lockedRows.length,
    coverage_pct:
      rows.length === 0 ? 0 : Math.round((lockedRows.length / rows.length) * 1000) / 10,
    locked_picks: rows.filter((r) => r.official_status === 'locked_pick').length,
    official_winners: rows.filter((r) => r.locked_outcome === 'won').length,
    official_losers: rows.filter((r) => r.locked_outcome === 'lost').length,
    official_pending: rows.filter((r) => r.locked_outcome === 'pending').length,
    locked_no_bet: lockedNoBet,
    no_run_available: rows.filter((r) => r.official_status === 'no_run_available').length,
    lock_missing: rows.filter((r) => r.display_status === 'lock_missing').length,
    not_locked_yet: rows.filter((r) => r.display_status === 'not_locked_yet').length,
    diagnostic_winners: rows.filter((r) => r.diagnostic_outcome === 'won').length,
    diagnostic_won_official_lost: rows.filter(
      (r) => r.outcome_divergence === 'diagnostic_won_official_lost',
    ).length,
    official_won_diagnostic_lost: rows.filter(
      (r) => r.outcome_divergence === 'official_won_diagnostic_lost',
    ).length,
    official: summarizeModelPerformance(outcomes, lockedNoBet),
  };
}
