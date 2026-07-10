/**
 * Pure, client-safe live lock-coverage helpers — Newmarket rebuild Phase 6A.
 *
 * Derives, from data the dashboard ALREADY loads (/api/recommendations race
 * cards: `lockedDecision.decision_status` + `off_time`, plus the page's ticking
 * clock), a per-race official T-minus lock status and a day-level coverage
 * summary for the Proof-of-Update panel and race-day timeline.
 *
 * READ-ONLY + HONEST. No I/O (no DB, no network, no writes); deterministic
 * given its inputs. The distinction that matters:
 *
 *   - "Not locked yet" (null lock, now <= off): the lock window has not
 *     closed — absence is EXPECTED, not a failure. Includes mid-window nulls
 *     (the lock job legitimately writes as late as the off) and unknown off
 *     times (never accuse "missing" without evidence).
 *   - "LOCK MISSING" (null lock, now > off): the window has passed and the DB
 *     CHECK forbids post-off locks, so a missing official decision is now a
 *     FACT — surfaced as a warning, but still never a loss and never a no-bet.
 *
 * Locked statuses pass through verbatim from the official row. Nothing here
 * influences the model, staking, or any decision; display only.
 */

/** Tone hint matching the proof panel's `ProofTone`. */
export type LockTone = 'ok' | 'warn' | 'neutral';

/** Per-race official lock status as displayed live. */
export type RaceLockStatus =
  | 'locked_pick'
  | 'locked_no_bet'
  | 'no_run_available'
  | 'not_locked_yet'
  | 'lock_missing';

/** UI wording per status (requirement wording; MISSING deliberately loud). */
export const LOCK_STATUS_LABEL: Record<RaceLockStatus, string> = {
  locked_pick: 'Official locked pick',
  locked_no_bet: 'Official locked no-bet',
  no_run_available: 'No run available at lock',
  not_locked_yet: 'Not locked yet',
  lock_missing: 'LOCK MISSING',
};

/** Tone per status. A locked no-bet is a VALID decision (ok, not a failure). */
export const LOCK_STATUS_TONE: Record<RaceLockStatus, LockTone> = {
  locked_pick: 'ok',
  locked_no_bet: 'ok',
  no_run_available: 'warn',
  not_locked_yet: 'neutral',
  lock_missing: 'warn',
};

const KNOWN_DECISION_STATUSES: readonly string[] = [
  'locked_pick',
  'locked_no_bet',
  'no_run_available',
];

/**
 * Derives one race's live lock status.
 *
 *  - A known official `decision_status` passes through verbatim (an unknown
 *    string is treated like no lock — never guessed into a bucket).
 *  - No lock + `nowMs <= off` (inclusive: the off is the lock CLI's last safe
 *    moment) -> `not_locked_yet`.
 *  - No lock + `nowMs > off` -> `lock_missing` (the window has passed; a lock
 *    can never legally be created post-off).
 *  - No lock + unknown/unparseable off -> `not_locked_yet`.
 *
 * Pure; `nowMs` is injected so tests are deterministic.
 */
export function deriveRaceLockStatus(
  decisionStatus: string | null | undefined,
  offTime: string | null | undefined,
  nowMs: number,
): RaceLockStatus {
  if (
    typeof decisionStatus === 'string' &&
    KNOWN_DECISION_STATUSES.includes(decisionStatus)
  ) {
    return decisionStatus as RaceLockStatus;
  }
  const offMs = offTime ? Date.parse(offTime) : NaN;
  if (!Number.isFinite(offMs)) return 'not_locked_yet';
  return nowMs > offMs ? 'lock_missing' : 'not_locked_yet';
}

/** Day-level lock coverage counts (requirement 10). */
export interface LockCoverageSummary {
  races: number;
  /** Races with ANY official lock row (pick + no-bet + no-run). */
  locked: number;
  /** locked / races * 100, one decimal; 0 when no races. */
  coveragePct: number;
  lockedPick: number;
  lockedNoBet: number;
  noRunAvailable: number;
  lockMissing: number;
  notLockedYet: number;
}

/** Counts per-race statuses into the day summary. Pure; order-independent. */
export function summarizeLockCoverage(
  statuses: readonly RaceLockStatus[],
): LockCoverageSummary {
  const summary: LockCoverageSummary = {
    races: statuses.length,
    locked: 0,
    coveragePct: 0,
    lockedPick: 0,
    lockedNoBet: 0,
    noRunAvailable: 0,
    lockMissing: 0,
    notLockedYet: 0,
  };
  for (const s of statuses) {
    if (s === 'locked_pick') summary.lockedPick += 1;
    else if (s === 'locked_no_bet') summary.lockedNoBet += 1;
    else if (s === 'no_run_available') summary.noRunAvailable += 1;
    else if (s === 'lock_missing') summary.lockMissing += 1;
    else summary.notLockedYet += 1;
  }
  summary.locked = summary.lockedPick + summary.lockedNoBet + summary.noRunAvailable;
  summary.coveragePct =
    summary.races === 0 ? 0 : Math.round((summary.locked / summary.races) * 1000) / 10;
  return summary;
}

/** One-line proof-row value, e.g. `5/7 locked (71.4%) · pick 3 · ...`. Pure. */
export function formatLockCoverageValue(summary: LockCoverageSummary): string {
  return (
    `${summary.locked}/${summary.races} locked (${summary.coveragePct.toFixed(1)}%) · ` +
    `pick ${summary.lockedPick} · no-bet ${summary.lockedNoBet} · ` +
    `no-run ${summary.noRunAvailable} · MISSING ${summary.lockMissing} · ` +
    `not yet ${summary.notLockedYet}`
  );
}

/**
 * Proof-row tone: warn when anything is factually wrong or degraded (a lock
 * missing after its window, or a lock recorded with no run available); ok when
 * every race has an official lock; neutral otherwise (pre-day / locks still
 * legitimately pending). Pure.
 */
export function lockCoverageTone(summary: LockCoverageSummary): LockTone {
  if (summary.lockMissing > 0 || summary.noRunAvailable > 0) return 'warn';
  if (summary.races > 0 && summary.locked === summary.races) return 'ok';
  return 'neutral';
}
