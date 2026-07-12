/**
 * Pure view-model for the Race-Day Decision Console — READ-ONLY.
 *
 * Answers "what deserves my attention right now?" by classifying every race
 * into one of four display-only priorities and sorting by urgency. It consumes
 * ONLY data the dashboard already loads (the same card projection as the
 * Command Centre) and REUSES the shared pure helpers — `buildRaceDayTimeline`
 * (race state, result status, time-aware lock status, T-minus-5 capture
 * target, as-of-off staleness), `RESULT_PENDING_SLOW_MS` / `formatUntil` /
 * `PRE_OFF_STATES` from the Command Centre — so no business rule exists twice.
 *
 * PRIORITY RULES (display-only; nothing here changes any decision):
 *   WARNING     — a problem: stale odds/model BEFORE the off, LOCK MISSING
 *                 (window passed, no official row), no_run_available, or a
 *                 result still pending unusually long after the off.
 *   NEXT ACTION — time-critical, no problem yet: lock due within 15 minutes
 *                 (or due now), off within 15 minutes, or a result expected
 *                 soon (just gone off / pending within the normal window).
 *   MONITOR     — coming up: off within the next 60 minutes, or a lock due
 *                 later today.
 *   GOOD        — settled, locked with no concern, or simply no operational
 *                 concern.
 *
 * A race matching several rules takes its MOST SEVERE class (WARNING first —
 * a problem always surfaces as a problem, even when something is also due).
 * The list sorts NEXT ACTION → WARNING → MONITOR → GOOD (the operator's
 * requested reading order), each class by soonest deadline / off time.
 *
 * No I/O, no DB, no writes, no model/staking/confidence maths. Deterministic
 * given its inputs (the clock is injected). Decision-support display only —
 * never a betting instruction.
 */

import {
  buildRaceDayTimeline,
  type TimelineEntry,
  type TimelineInput,
} from './raceDayTimeline';
import {
  formatUntil,
  PRE_OFF_STATES,
  RESULT_PENDING_SLOW_MS,
} from './commandCentre';

/** Lock/off deadlines within this window are NEXT ACTION. */
export const NEXT_ACTION_WINDOW_MS = 15 * 60_000;

/** Races off within this window (but not NEXT ACTION) are MONITOR. */
export const MONITOR_WINDOW_MS = 60 * 60_000;

export type ConsolePriority = 'next_action' | 'warning' | 'monitor' | 'good';

/** Display order of the classes (most important first). */
export const CONSOLE_PRIORITY_ORDER: readonly ConsolePriority[] = [
  'next_action',
  'warning',
  'monitor',
  'good',
];

/** Chip label per class (stable; tested). */
export const CONSOLE_PRIORITY_LABEL: Record<ConsolePriority, string> = {
  next_action: 'NEXT ACTION',
  warning: 'WARNING',
  monitor: 'MONITOR',
  good: 'GOOD',
};

/** One classified race row. */
export interface ConsoleItem {
  race_id: string;
  race_name: string | null;
  off_time: string | null;
  priority: ConsolePriority;
  /** Plain-language reason, e.g. "lock due in 7m" / "stale odds before the off". */
  reason: string;
  /** Countdown wording when a deadline applies (already part of some reasons). */
  countdown: string | null;
  /** Sort key within the class (soonest deadline first; ties by off time). */
  sortMs: number;
}

export interface ConsoleCounts {
  next_action: number;
  warning: number;
  monitor: number;
  good: number;
}

export interface DecisionConsoleView {
  /** All races, sorted NEXT ACTION → WARNING → MONITOR → GOOD, urgent first. */
  items: ConsoleItem[];
  counts: ConsoleCounts;
}

function parseMs(iso: string | null): number | null {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** Countdown to a deadline, e.g. "in 7m" / "due now". */
function until(deadlineMs: number, now: number): string {
  return formatUntil(deadlineMs - now);
}

/** Minutes elapsed since `pastMs`, floored, for "pending Xm" wording. */
function minutesSince(pastMs: number, now: number): number {
  return Math.max(0, Math.floor((now - pastMs) / 60_000));
}

/** Classifies one timeline entry. Pure. */
function classify(e: TimelineEntry, now: number): Omit<ConsoleItem, 'race_id' | 'race_name' | 'off_time'> {
  const offMs = parseMs(e.off_time);
  const targetMs = parseMs(e.tMinusCaptureTarget);
  const preOff = PRE_OFF_STATES.includes(e.raceState);
  const offSort = offMs ?? Number.POSITIVE_INFINITY;

  // --- WARNING: a problem always surfaces as a problem. ---------------------
  if (e.lockStatus === 'lock_missing') {
    return {
      priority: 'warning',
      reason: 'lock missing — window passed with no official decision',
      countdown: null,
      sortMs: offSort,
    };
  }
  if (e.lockStatus === 'no_run_available') {
    return {
      priority: 'warning',
      reason: 'no model run available at lock',
      countdown: null,
      sortMs: offSort,
    };
  }
  if (preOff && e.oddsStale) {
    return {
      priority: 'warning',
      reason: 'stale odds before the off',
      countdown: offMs !== null ? `off ${until(offMs, now)}` : null,
      sortMs: offSort,
    };
  }
  if (preOff && e.modelStale) {
    return {
      priority: 'warning',
      reason: 'stale model before the off',
      countdown: offMs !== null ? `off ${until(offMs, now)}` : null,
      sortMs: offSort,
    };
  }
  if (e.resultStatus === 'pending' && offMs !== null && now - offMs > RESULT_PENDING_SLOW_MS) {
    return {
      priority: 'warning',
      reason: `result still pending ${minutesSince(offMs, now)}m after the off`,
      countdown: null,
      sortMs: offSort,
    };
  }

  // --- NEXT ACTION: time-critical, nothing wrong (yet). ---------------------
  if (e.lockStatus === 'not_locked_yet' && targetMs !== null && targetMs - now <= NEXT_ACTION_WINDOW_MS) {
    const label = targetMs <= now ? 'lock due now' : `lock due ${until(targetMs, now)}`;
    return { priority: 'next_action', reason: label, countdown: label, sortMs: targetMs };
  }
  if (preOff && offMs !== null && offMs - now <= NEXT_ACTION_WINDOW_MS) {
    const label = `off ${until(offMs, now)}`;
    return { priority: 'next_action', reason: label, countdown: label, sortMs: offMs };
  }
  if (
    e.raceState === 'off' ||
    (e.resultStatus === 'pending' && offMs !== null && now - offMs <= RESULT_PENDING_SLOW_MS)
  ) {
    return {
      priority: 'next_action',
      reason: 'result expected soon',
      countdown: null,
      sortMs: offSort,
    };
  }

  // --- MONITOR: coming up. ---------------------------------------------------
  if (preOff && offMs !== null && offMs - now <= MONITOR_WINDOW_MS) {
    const label =
      e.lockStatus === 'not_locked_yet' && targetMs !== null
        ? `lock due ${until(targetMs, now)}`
        : `off ${until(offMs, now)}`;
    return { priority: 'monitor', reason: label, countdown: label, sortMs: offMs };
  }
  if (e.lockStatus === 'not_locked_yet') {
    const label = targetMs !== null ? `lock due ${until(targetMs, now)}` : 'lock due later';
    return { priority: 'monitor', reason: label, countdown: targetMs !== null ? label : null, sortMs: targetMs ?? offSort };
  }

  // --- GOOD. ------------------------------------------------------------------
  if (e.resultStatus === 'settled') {
    return { priority: 'good', reason: 'settled', countdown: null, sortMs: offSort };
  }
  if (e.lockStatus === 'locked_pick' || e.lockStatus === 'locked_no_bet') {
    return {
      priority: 'good',
      reason: e.lockStatus === 'locked_pick' ? 'locked — official pick captured' : 'locked — official no-bet',
      countdown: null,
      sortMs: offSort,
    };
  }
  return { priority: 'good', reason: 'no operational concern', countdown: null, sortMs: offSort };
}

/**
 * Builds the Decision Console view: every race classified, sorted by class
 * importance then urgency, with per-class counts. Pure & deterministic.
 */
export function buildDecisionConsole(
  races: readonly TimelineInput[],
  now: number,
): DecisionConsoleView {
  const entries = buildRaceDayTimeline(races, now);
  const items: ConsoleItem[] = entries.map((e) => ({
    race_id: e.race_id,
    race_name: e.race_name,
    off_time: e.off_time,
    ...classify(e, now),
  }));

  const rank = new Map(CONSOLE_PRIORITY_ORDER.map((p, i) => [p, i]));
  items.sort((a, b) => {
    const byClass = (rank.get(a.priority) ?? 9) - (rank.get(b.priority) ?? 9);
    if (byClass !== 0) return byClass;
    return a.sortMs - b.sortMs;
  });

  const counts: ConsoleCounts = { next_action: 0, warning: 0, monitor: 0, good: 0 };
  for (const item of items) counts[item.priority] += 1;

  return { items, counts };
}
