/**
 * Pure helpers for the READ-ONLY result-settlement status display.
 *
 * The backend `results:auto` commit command settles races; the WEBSITE never
 * commits. This module derives a per-race settlement status from STORED, read-only state
 * (the race row status + off time, plus an OPTIONAL stored settle-ready / blocked
 * signal and free-result note when one exists) and assembles a small view-model
 * the dashboard renders. It NEVER settles, NEVER writes, NEVER calls an external
 * API, and is deterministic given its inputs — fully unit-testable.
 *
 * Note: `settle-ready` and `blocked / conflict` are NOT derivable from stored DB
 * state alone (they come from the `results:auto` Free-results audit), so they are
 * only reported when explicitly PROVIDED; otherwise a finished-but-unsettled race
 * reads as `pending` and a resulted race as `settled`.
 */

/** The result-settlement state shown per race. */
export type SettlementStatus =
  | 'settled'
  | 'settle-ready'
  | 'pending'
  | 'blocked'
  | 'unknown';

/** The fixed read-only disclaimer shown on every settlement panel. */
export const SETTLEMENT_READONLY_NOTE =
  'Results are settled separately and may be entered manually during beta — this page is read-only.';

/** The race-row status value that marks a settled / resulted race. */
const SETTLED_STATUS = 'result';

/** A runner with its finishing position (for the winner lookup). */
export interface SettlementRunner {
  horse_name: string;
  finish_pos: number | null;
}

export interface SettlementInput {
  offTime: string | null;
  now: number;
  /** `races.status` ('result' once settled). */
  status?: string | null;
  /** Optional stored settle-ready / blocked / conflict signal (not derivable). */
  providedStatus?: string | null;
  /** Optional stored Free-API result note. */
  freeResultNote?: string | null;
  /** The full field, for the winner (finish_pos === 1). */
  runners?: readonly SettlementRunner[];
  /** The model pick's finishing position, if known. */
  modelPickFinishPos?: number | null;
}

export interface SettlementView {
  status: SettlementStatus;
  settled: boolean;
  winnerName: string | null;
  modelPickFinish: number | null;
  freeResultNote: string | null;
}

export type SettlementTone = 'pos' | 'neg' | 'warn' | 'neutral';

export interface SettlementBadge {
  label: string;
  tone: SettlementTone;
}

/** True when the race-row status marks it settled / resulted. */
function isSettledStatus(status: string | null | undefined): boolean {
  return (status ?? '').trim().toLowerCase() === SETTLED_STATUS;
}

/** Normalises an optional provided settlement signal, or null when unrecognised. */
function normaliseProvided(value: string | null | undefined): SettlementStatus | null {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'settle-ready':
    case 'settle_ready':
    case 'settleready':
      return 'settle-ready';
    case 'blocked':
    case 'conflict':
    case 'blocked/conflict':
    case 'blocked / conflict':
      return 'blocked';
    case 'pending':
      return 'pending';
    case 'settled':
      return 'settled';
    case 'unknown':
      return 'unknown';
    default:
      return null;
  }
}

/**
 * Derives the {@link SettlementStatus}. A resulted race is `settled`; otherwise a
 * recognised PROVIDED signal (settle-ready / blocked) wins; otherwise a race past
 * its off time reads as `pending`; an upcoming race or one with no parseable off
 * time reads as `unknown`. Pure & deterministic.
 */
export function deriveSettlementStatus(input: SettlementInput): SettlementStatus {
  if (isSettledStatus(input.status)) return 'settled';

  const provided = normaliseProvided(input.providedStatus);
  if (provided) return provided;

  const offMs = input.offTime ? Date.parse(input.offTime) : NaN;
  if (Number.isNaN(offMs)) return 'unknown';
  return offMs <= input.now ? 'pending' : 'unknown';
}

/** Human label + tone for a settlement status. Pure. */
export function settlementStatusBadge(status: SettlementStatus): SettlementBadge {
  switch (status) {
    case 'settled':
      return { label: 'Settled', tone: 'pos' };
    case 'settle-ready':
      return { label: 'Settle-ready', tone: 'warn' };
    case 'pending':
      return { label: 'Pending', tone: 'warn' };
    case 'blocked':
      return { label: 'Blocked / conflict', tone: 'neg' };
    default:
      return { label: 'Unknown', tone: 'neutral' };
  }
}

/** Finite-number guard. */
function isFiniteNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Assembles the read-only settlement view-model for one race: the status, the
 * winner (only when settled), the model pick's finishing position (only when
 * settled), and any stored Free-API result note. Pure & deterministic.
 */
export function buildSettlementView(input: SettlementInput): SettlementView {
  const status = deriveSettlementStatus(input);
  const settled = status === 'settled';

  const winner = settled
    ? (input.runners ?? []).find((r) => r.finish_pos === 1) ?? null
    : null;

  return {
    status,
    settled,
    winnerName: winner ? winner.horse_name : null,
    modelPickFinish:
      settled && isFiniteNum(input.modelPickFinishPos)
        ? input.modelPickFinishPos
        : null,
    freeResultNote:
      typeof input.freeResultNote === 'string' && input.freeResultNote.trim() !== ''
        ? input.freeResultNote
        : null,
  };
}
