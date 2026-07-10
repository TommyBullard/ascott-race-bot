/**
 * Pure helpers for the READ-ONLY race-day operational timeline.
 *
 * Decision-support / audit only. For each race it derives a per-race operational
 * status row from STORED, read-only fields the dashboard already holds (off time,
 * latest odds-snapshot time, latest displayed model-run time, race status, result
 * time, model run-quality verdict) plus the current clock. It reuses the existing
 * race-state / result-status / capture / pre-off helpers so the timeline stays
 * consistent with the cards.
 *
 * There is NO I/O here: no DB, no network, no external API calls, no writes, and
 * no model / staking / ranking maths. Given the same inputs every function
 * returns the same output, so the whole module is unit-testable without a
 * database. Missing values surface as null (the UI renders "—" / "unknown").
 *
 * Freshness note: for a race that has already gone off, "staleness" is judged
 * AS-OF its off time (was the data fresh when it mattered?), not relative to now
 * — otherwise every finished race would trivially look stale.
 */

import {
  T_MINUS_5_MS,
  deriveRaceState,
  deriveResultStatus,
  deriveCaptureStatus,
  isPreOffRun,
  type RaceState,
  type ResultStatus,
  type CaptureStatus,
} from './raceDayStatus';
import { isStaleAge } from './relativeTime';
import { STALE_ODDS_THRESHOLD_MS } from './modelDataQuality';
import { deriveRaceLockStatus, type RaceLockStatus } from './lockCoverage';

/** Warning labels (stable, exported for tests + rendering). */
export const TIMELINE_WARN_STALE_ODDS = 'Stale odds';
export const TIMELINE_WARN_STALE_MODEL = 'Stale model';
export const TIMELINE_WARN_NO_CAPTURE = 'No T-minus capture';
export const TIMELINE_WARN_POST_OFF_IGNORED = 'Post-off runs ignored';
export const TIMELINE_WARN_RESULT_PENDING = 'Result pending';

/** Read-only inputs for one race row (a projection of the dashboard RaceCard). */
export interface TimelineInput {
  race_id: string;
  off_time: string | null;
  race_name?: string | null;
  course?: string | null;
  /** `market_snapshots.snapshot_time` of the latest priced snapshot. */
  oddsUpdatedAt?: string | null;
  /** `model_runs.run_time` of the displayed run (pre-off for historical races). */
  modelUpdatedAt?: string | null;
  /** Whether a current/displayed model run exists. */
  hasModelRun?: boolean;
  /** `races.status` (e.g. 'result' once settled). */
  status?: string | null;
  /** `races.official_result_time` when settled. */
  resultTime?: string | null;
  /** Observational model data-quality verdict (e.g. 'STALE'). */
  runQuality?: string | null;
  /**
   * Official locked decision status from the card's `lockedDecision`
   * (Phase 6A), or null/absent when the race has no lock row. Optional for
   * back-compat: absent behaves as "no lock", classified by time alone.
   */
  lockedDecisionStatus?: string | null;
}

/** A derived, serialisable operational status row for one race. */
export interface TimelineEntry {
  race_id: string;
  off_time: string | null;
  race_name: string | null;
  course: string | null;
  oddsUpdatedAt: string | null;
  modelUpdatedAt: string | null;
  /** Displayed run time when it is a pre-off run, else null. */
  preOffRunTime: string | null;
  /** The T-5 capture target (ISO) = off time − 5 min, or null when off unknown. */
  tMinusCaptureTarget: string | null;
  /** True when a pre-off capture (model run) is present. */
  captureAvailable: boolean;
  captureStatus: CaptureStatus;
  raceState: RaceState;
  resultStatus: ResultStatus;
  settledTime: string | null;
  oddsStale: boolean;
  modelStale: boolean;
  /**
   * Live official T-minus lock status (Phase 6A): a locked status verbatim,
   * `not_locked_yet` while the window is open (never a failure), or
   * `lock_missing` once the off has passed with no official row.
   */
  lockStatus: RaceLockStatus;
  warnings: string[];
}

/** Parses an off time to epoch ms, or +Infinity so unknowns sort last. */
function offMsOrInfinity(input: { off_time: string | null }): number {
  const ms = input.off_time ? Date.parse(input.off_time) : NaN;
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Derives one {@link TimelineEntry} from stored fields + the current clock. Pure
 * & deterministic; never performs I/O. Reuses the shared race-state / result /
 * capture / pre-off helpers so the row matches the card.
 */
export function buildTimelineEntry(input: TimelineInput, now: number): TimelineEntry {
  const offMs = input.off_time ? Date.parse(input.off_time) : NaN;
  const hasOff = !Number.isNaN(offMs);

  const stateArgs = { offTime: input.off_time, now, status: input.status ?? null };
  const raceState = deriveRaceState(stateArgs);
  const resultStatus = deriveResultStatus(stateArgs);

  const captureStatus = deriveCaptureStatus({
    hasModelRun: input.hasModelRun,
    runTime: input.modelUpdatedAt ?? null,
    offTime: input.off_time,
  });
  const captureAvailable = captureStatus === 'captured';

  const preOffRunTime = isPreOffRun(input.modelUpdatedAt ?? null, input.off_time)
    ? input.modelUpdatedAt ?? null
    : null;

  const tMinusCaptureTarget = hasOff
    ? new Date(offMs - T_MINUS_5_MS).toISOString()
    : null;

  // Freshness reference: as-of off once the race has run, else now.
  const referenceMs = hasOff && offMs < now ? offMs : now;
  const oddsStale = isStaleAge(
    input.oddsUpdatedAt ?? null,
    referenceMs,
    STALE_ODDS_THRESHOLD_MS,
  );
  const modelStale = (input.runQuality ?? '').trim().toUpperCase() === 'STALE';

  const pastOff =
    raceState === 'off' ||
    raceState === 'result-pending' ||
    raceState === 'settled';

  const warnings: string[] = [];
  if (oddsStale) warnings.push(TIMELINE_WARN_STALE_ODDS);
  if (modelStale) warnings.push(TIMELINE_WARN_STALE_MODEL);
  if (captureStatus === 'missing' || captureStatus === 'post-off-only') {
    warnings.push(TIMELINE_WARN_NO_CAPTURE);
  }
  if (pastOff && preOffRunTime !== null) {
    warnings.push(TIMELINE_WARN_POST_OFF_IGNORED);
  }
  if (resultStatus === 'pending') warnings.push(TIMELINE_WARN_RESULT_PENDING);

  return {
    race_id: input.race_id,
    off_time: input.off_time ?? null,
    race_name: input.race_name ?? null,
    course: input.course ?? null,
    oddsUpdatedAt: input.oddsUpdatedAt ?? null,
    modelUpdatedAt: input.modelUpdatedAt ?? null,
    preOffRunTime,
    tMinusCaptureTarget,
    captureAvailable,
    captureStatus,
    raceState,
    resultStatus,
    settledTime: input.resultTime ?? null,
    oddsStale,
    modelStale,
    lockStatus: deriveRaceLockStatus(
      input.lockedDecisionStatus ?? null,
      input.off_time,
      now,
    ),
    warnings,
  };
}

/**
 * Builds the full race-day timeline: every input sorted by off time (ascending;
 * unknown/unparseable off times last) then mapped to a {@link TimelineEntry}.
 * Does not mutate the input array. Pure & deterministic.
 */
export function buildRaceDayTimeline(
  inputs: readonly TimelineInput[],
  now: number,
): TimelineEntry[] {
  return [...inputs]
    .sort((a, b) => offMsOrInfinity(a) - offMsOrInfinity(b))
    .map((input) => buildTimelineEntry(input, now));
}
