/**
 * Pure view-model for the Race-Day Command Centre panel — READ-ONLY.
 *
 * One compact operational status view over data the dashboard ALREADY loads
 * (/api/recommendations race cards + the page's fetch state and clock). It
 * derives: platform-feed health, racecard/odds/model/results freshness, lock
 * operation counts (Phase 6A time-aware statuses), results progress, and a
 * single GREEN / AMBER / RED badge with plain-language reasons.
 *
 * REUSES the existing pure helpers — `buildRaceDayTimeline` (per-race
 * staleness judged AS-OF the off for finished races, lock status, result
 * status, T-minus-5 capture target) and `summarizeLockCoverage` — so this
 * panel can never disagree with the timeline or proof panels.
 *
 * HONESTY RULES:
 *   - "Platform feed" reports whether the dashboard's own read API responded —
 *     the page has no direct database probe and this module never claims one.
 *   - Freshness only goes AMBER for races still to run; a finished day is
 *     never "stale" merely because it is over.
 *   - `not_locked_yet` races are expected — they alone never change the badge.
 *   - LOCK MISSING / no-run-at-lock are facts (post-off gaps) -> RED.
 *
 * No I/O, no DB, no writes, no model/staking/confidence maths. Deterministic
 * given its inputs (the clock is injected). Display only.
 */

import {
  buildRaceDayTimeline,
  type TimelineInput,
  type TimelineEntry,
} from './raceDayTimeline';
import { summarizeLockCoverage } from './lockCoverage';
import { formatRelativeAge } from './relativeTime';

/** How long after the off a still-pending result counts as "slow" (AMBER). */
export const RESULT_PENDING_SLOW_MS = 15 * 60 * 1000;

/** The dashboard's recommendations fetch state, as the panel sees it. */
export type FeedState = 'ready' | 'error';

export type CommandBadge = 'green' | 'amber' | 'red';

export interface CommandCentreInput {
  /** Injected clock (epoch ms). */
  now: number;
  /** Whether the recommendations read API responded. */
  feedState: FeedState;
  /** The consolidated status poll errored (cards may still be fine). */
  statusPollError: boolean;
  /** URL scopes to a day/course (zero races is then a capture problem). */
  scoped: boolean;
  races: readonly TimelineInput[];
}

export interface CommandCentreView {
  badge: CommandBadge;
  /** Plain-language reasons behind a non-green badge (empty when green). */
  badgeReasons: string[];
  health: {
    /** 'ok' | 'failed' — the read API, never a direct DB probe. */
    platformFeed: 'ok' | 'failed';
    racecards: number;
    /** Most recent odds snapshot age, e.g. "5m ago" / "unknown". */
    oddsLabel: string;
    /** True only when a race STILL TO RUN has stale odds. */
    oddsStale: boolean;
    /** Most recent model run age. */
    modelLabel: string;
    /** True only when a race still to run has a STALE model verdict. */
    modelStale: boolean;
    /** Age of the most recent settled result, or null before any result. */
    resultsLabel: string | null;
  };
  locks: {
    races: number;
    /** Races with ANY official lock row (pick + no-bet + no-run). */
    locked: number;
    notYetDue: number;
    lockMissing: number;
    noRunAvailable: number;
    /** "due now" / "in 12m" for the next T-minus-5 capture, or null when none. */
    nextLockDueLabel: string | null;
  };
  results: {
    settled: number;
    /** Races off with no recorded result yet. */
    pending: number;
    lastResultLabel: string | null;
  };
}

/** Humanises a non-negative wait in ms, e.g. "due now", "in 4m", "in 1h 05m". */
function formatUntil(waitMs: number): string {
  if (waitMs <= 0) return 'due now';
  const totalMinutes = Math.ceil(waitMs / 60_000);
  if (totalMinutes < 60) return `in ${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `in ${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/** The latest parseable timestamp among the given ISO strings, or null. */
function latestMs(timestamps: ReadonlyArray<string | null>): number | null {
  let latest: number | null = null;
  for (const iso of timestamps) {
    const ms = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(ms) && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

/** True when the entry's race has not gone off yet (freshness matters NOW). */
function stillToRun(entry: TimelineEntry): boolean {
  return entry.raceState === 'upcoming';
}

/**
 * Builds the Command Centre view. Pure & deterministic; reuses the shared
 * timeline/lock helpers so every count matches the other panels.
 */
export function buildCommandCentre(input: CommandCentreInput): CommandCentreView {
  const { now, feedState, statusPollError, scoped, races } = input;
  const entries = buildRaceDayTimeline(races, now);

  // --- Lock operations (Phase 6A statuses; time-aware by construction). ----
  const lockSummary = summarizeLockCoverage(entries.map((e) => e.lockStatus));
  // Next lock due = the earliest T-minus-5 capture target among races whose
  // lock window has not opened/closed yet ("not locked yet").
  let nextDue: number | null = null;
  for (const e of entries) {
    if (e.lockStatus !== 'not_locked_yet' || !e.tMinusCaptureTarget) continue;
    const target = Date.parse(e.tMinusCaptureTarget);
    if (!Number.isFinite(target)) continue;
    if (nextDue === null || target < nextDue) nextDue = target;
  }

  // --- Freshness (upcoming races only; finished races judged as-of the off
  //     by the timeline and never re-accused here). -------------------------
  const upcoming = entries.filter(stillToRun);
  const oddsStaleUpcoming = upcoming.filter((e) => e.oddsStale).length;
  const modelStaleUpcoming = upcoming.filter((e) => e.modelStale).length;
  const oddsLabel = formatRelativeAge(latestMs(entries.map((e) => e.oddsUpdatedAt)), now).text;
  const modelLabel = formatRelativeAge(latestMs(entries.map((e) => e.modelUpdatedAt)), now).text;

  // --- Results operations. --------------------------------------------------
  const settled = entries.filter((e) => e.resultStatus === 'settled').length;
  const pendingEntries = entries.filter((e) => e.resultStatus === 'pending');
  const lastResultMs = latestMs(entries.map((e) => e.settledTime));
  const pendingSlow = pendingEntries.filter((e) => {
    const off = e.off_time ? Date.parse(e.off_time) : NaN;
    return Number.isFinite(off) && now - off > RESULT_PENDING_SLOW_MS;
  }).length;

  // --- Badge (red > amber > green; every reason is plain language). --------
  const red: string[] = [];
  const amber: string[] = [];
  if (feedState === 'error') red.push('data feed failed — dashboard cannot read the platform');
  if (feedState === 'ready' && scoped && races.length === 0) {
    red.push('no racecards loaded for the selected day/course');
  }
  if (lockSummary.lockMissing > 0) {
    red.push(`${lockSummary.lockMissing} race(s) LOCK MISSING (window passed, no official decision)`);
  }
  if (lockSummary.noRunAvailable > 0) {
    red.push(`${lockSummary.noRunAvailable} race(s) had no model run available at lock`);
  }
  if (oddsStaleUpcoming > 0) amber.push(`stale odds on ${oddsStaleUpcoming} upcoming race(s)`);
  if (modelStaleUpcoming > 0) amber.push(`stale model on ${modelStaleUpcoming} upcoming race(s)`);
  if (pendingSlow > 0) amber.push(`${pendingSlow} result(s) still pending >15m after the off`);
  if (statusPollError && feedState === 'ready') amber.push('status poll failing (cards still loading)');

  const badge: CommandBadge = red.length > 0 ? 'red' : amber.length > 0 ? 'amber' : 'green';

  return {
    badge,
    badgeReasons: badge === 'red' ? red : badge === 'amber' ? amber : [],
    health: {
      platformFeed: feedState === 'ready' ? 'ok' : 'failed',
      racecards: races.length,
      oddsLabel,
      oddsStale: oddsStaleUpcoming > 0,
      modelLabel,
      modelStale: modelStaleUpcoming > 0,
      resultsLabel: lastResultMs === null ? null : formatRelativeAge(lastResultMs, now).text,
    },
    locks: {
      races: lockSummary.races,
      locked: lockSummary.locked,
      notYetDue: lockSummary.notLockedYet,
      lockMissing: lockSummary.lockMissing,
      noRunAvailable: lockSummary.noRunAvailable,
      nextLockDueLabel: nextDue === null ? null : formatUntil(nextDue - now),
    },
    results: {
      settled,
      pending: pendingEntries.length,
      lastResultLabel: lastResultMs === null ? null : formatRelativeAge(lastResultMs, now).text,
    },
  };
}
