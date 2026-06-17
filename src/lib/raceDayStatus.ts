/**
 * Pure helpers for the LIVE race-day dashboard status indicators.
 *
 * Decision-support only. Every function here derives a presentation label from
 * STORED, read-only fields the dashboard already holds (scheduled off time, the
 * race row `status`, the displayed model-run time) plus the current clock. There
 * is NO I/O here: no DB, no network, no external API calls, no writes, and no
 * model / staking / ranking maths. Given the same inputs every function returns
 * the same output, so the whole module is unit-testable without a database.
 *
 * Scope note on "settle-ready": whether a finished race is *settle-ready* is a
 * `results:auto` concept — it depends on the Free results endpoint, which the
 * dashboard deliberately never calls. So this module only ever reports what is
 * derivable from stored DB state (`upcoming` -> ... -> `result-pending` ->
 * `settled`); it never claims "settle-ready". Actual settlement remains a safe
 * backend command, never a UI action.
 */

/** Em dash used for unknown / not-applicable labels. */
const DASH = '\u2014';

/**
 * Auto-refresh cadence (ms) for the live race-day dashboard. Chosen inside the
 * requested 30-60s window: frequent enough to feel live on a race day, slow
 * enough to stay light on the read-only endpoints. Exported so the UI and the
 * tests share one source of truth.
 */
export const RACE_DAY_REFRESH_MS = 45_000;

/** T-minus-10 window: this long (ms) before the off. */
export const T_MINUS_10_MS = 10 * 60_000;
/** T-minus-5 window: this long (ms) before the off. */
export const T_MINUS_5_MS = 5 * 60_000;
/**
 * How long (ms) after the scheduled off a race is treated as still "off"
 * (running) before it becomes "result-pending". Most flat races finish well
 * inside this window; it only governs which read-only label shows.
 */
export const OFF_WINDOW_MS = 5 * 60_000;

/** The `races.status` value that marks a settled / resulted race. */
export const SETTLED_STATUS = 'result';

/**
 * Lifecycle state of a race for the live dashboard, derived from off time +
 * stored status. `unknown` is used when the off time is missing / unparseable.
 */
export type RaceState =
  | 'upcoming'
  | 't-minus-10'
  | 't-minus-5'
  | 'off'
  | 'result-pending'
  | 'settled'
  | 'unknown';

/**
 * Result lifecycle derivable from stored DB state only. `none` = no result
 * expected yet (before/around the off); `pending` = race finished, awaiting a
 * recorded result; `settled` = race row resulted. `unknown` when the off time
 * cannot be parsed. NB: "settle-ready" is intentionally absent (see file note).
 */
export type ResultStatus = 'none' | 'pending' | 'settled' | 'unknown';

/** Tone hint for badge colouring; the UI maps these to inline styles. */
export type StatusTone = 'pos' | 'neg' | 'warn' | 'neutral';

/** A presentation badge: a short human label plus a colour tone. */
export interface StatusBadge {
  label: string;
  tone: StatusTone;
}

/** Inputs for race-state / result-status derivation. All read-only. */
export interface RaceStateInput {
  /** Scheduled off time (ISO string), or null/absent when unknown. */
  offTime: string | null | undefined;
  /** Current time as epoch ms (injected so derivation stays deterministic). */
  now: number;
  /** The `races.status` value (e.g. 'result' once settled), if known. */
  status?: string | null;
}

/** True when the race row status marks it settled / resulted. Pure. */
export function isSettled(status: string | null | undefined): boolean {
  return (status ?? '').trim().toLowerCase() === SETTLED_STATUS;
}

/**
 * Derives the {@link RaceState} from the scheduled off time, the stored race
 * status and the current clock. A settled status always wins (a resulted race
 * is `settled` regardless of the clock); otherwise the off-time windows apply:
 *
 * - `> 10m` before off            -> `upcoming`
 * - `(5m, 10m]` before off        -> `t-minus-10`
 * - `(0, 5m]` before off          -> `t-minus-5`
 * - `[off, off + 5m)`             -> `off`
 * - `>= off + 5m`, not resulted   -> `result-pending`
 *
 * A missing / unparseable off time yields `unknown`. Pure & deterministic.
 */
export function deriveRaceState(input: RaceStateInput): RaceState {
  if (isSettled(input.status)) return 'settled';

  const off = input.offTime ? Date.parse(input.offTime) : NaN;
  if (Number.isNaN(off)) return 'unknown';

  const toOff = off - input.now; // > 0 before the off, <= 0 once off
  if (toOff > T_MINUS_10_MS) return 'upcoming';
  if (toOff > T_MINUS_5_MS) return 't-minus-10';
  if (toOff > 0) return 't-minus-5';
  if (toOff > -OFF_WINDOW_MS) return 'off';
  return 'result-pending';
}

/**
 * Derives the {@link ResultStatus} from stored state only. Settled by status;
 * `pending` once the race is well past its off (>= off + 5m) without a recorded
 * result; otherwise `none`. Never returns a "settle-ready" verdict — that needs
 * the Free results endpoint, which the dashboard does not call. Pure.
 */
export function deriveResultStatus(input: RaceStateInput): ResultStatus {
  if (isSettled(input.status)) return 'settled';

  const off = input.offTime ? Date.parse(input.offTime) : NaN;
  if (Number.isNaN(off)) return 'unknown';

  const toOff = off - input.now;
  if (toOff <= -OFF_WINDOW_MS) return 'pending'; // finished, awaiting result
  return 'none'; // not off yet, or still running
}

/** Human label + tone for a {@link RaceState}. Pure. */
export function raceStateBadge(state: RaceState): StatusBadge {
  switch (state) {
    case 'upcoming':
      return { label: 'Upcoming', tone: 'neutral' };
    case 't-minus-10':
      return { label: 'T\u221210', tone: 'warn' };
    case 't-minus-5':
      return { label: 'T\u22125', tone: 'warn' };
    case 'off':
      return { label: 'Off', tone: 'pos' };
    case 'result-pending':
      return { label: 'Result pending', tone: 'warn' };
    case 'settled':
      return { label: 'Settled', tone: 'pos' };
    default:
      return { label: 'Unknown', tone: 'neutral' };
  }
}

/** Human label + tone for a {@link ResultStatus}. Pure. */
export function resultStatusBadge(statusValue: ResultStatus): StatusBadge {
  switch (statusValue) {
    case 'settled':
      return { label: 'Settled', tone: 'pos' };
    case 'pending':
      return { label: 'Result pending', tone: 'warn' };
    case 'none':
      return { label: DASH, tone: 'neutral' };
    default:
      return { label: 'Unknown', tone: 'neutral' };
  }
}

/**
 * True when a displayed model run is a PRE-OFF run (`runTime <= offTime`). The
 * dashboard uses this to confirm the run it shows is the pre-off decision record
 * — a post-off rerun is never the source of truth for a finished race. Missing /
 * unparseable inputs yield `false` (cannot confirm pre-off). Pure.
 */
export function isPreOffRun(
  runTime: string | null | undefined,
  offTime: string | null | undefined,
): boolean {
  const r = runTime ? Date.parse(runTime) : NaN;
  const o = offTime ? Date.parse(offTime) : NaN;
  if (Number.isNaN(r) || Number.isNaN(o)) return false;
  return r <= o;
}

/**
 * Capture status for the displayed run, for the read-only "T-minus capture"
 * line. `captured` = a pre-off run exists and is shown; `post-off-only` = a run
 * exists but it is post-off (so the pre-off capture is missing — shown for
 * transparency, never used as a decision input); `missing` = no run at all;
 * `unknown` = inputs insufficient to tell. Pure.
 */
export type CaptureStatus = 'captured' | 'post-off-only' | 'missing' | 'unknown';

export function deriveCaptureStatus(input: {
  hasModelRun: boolean | undefined;
  runTime: string | null | undefined;
  offTime: string | null | undefined;
}): CaptureStatus {
  if (!input.hasModelRun) return 'missing';
  if (!input.offTime || !input.runTime) return 'unknown';
  return isPreOffRun(input.runTime, input.offTime) ? 'captured' : 'post-off-only';
}

/** Human label + tone for a {@link CaptureStatus}. Pure. */
export function captureStatusBadge(captureValue: CaptureStatus): StatusBadge {
  switch (captureValue) {
    case 'captured':
      return { label: 'Pre-off run captured', tone: 'pos' };
    case 'post-off-only':
      return { label: 'Pre-off run missing', tone: 'warn' };
    case 'missing':
      return { label: 'No model run', tone: 'neutral' };
    default:
      return { label: 'Unknown', tone: 'neutral' };
  }
}

/** Minimal read-only shape for next-race selection. */
export interface NextRaceLike {
  off_time: string | null;
  status?: string | null;
}

/**
 * Selects the "next race" for the on-course header from a list of races: the
 * soonest race whose off time is still in the FUTURE relative to `now`; when none
 * are upcoming (end of day), the LATEST race by off time (so its settled/result
 * status is shown instead). Returns null when the list is empty or no race has a
 * parseable off time. Read-only, pure & deterministic — never re-orders or
 * mutates the input.
 */
export function selectNextRace<T extends NextRaceLike>(
  races: readonly T[],
  now: number,
): T | null {
  let nextUpcoming: T | null = null;
  let nextUpcomingMs = Number.POSITIVE_INFINITY;
  let latest: T | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;

  for (const race of races) {
    const ms = race.off_time ? Date.parse(race.off_time) : NaN;
    if (Number.isNaN(ms)) continue;
    if (ms > now && ms < nextUpcomingMs) {
      nextUpcoming = race;
      nextUpcomingMs = ms;
    }
    if (ms > latestMs) {
      latest = race;
      latestMs = ms;
    }
  }

  return nextUpcoming ?? latest;
}

/** Inputs for {@link buildRaceWarningChips}; all read-only, all optional. */
export interface RaceWarningInput {
  /** The model pick's confidence label (e.g. 'Low'); only 'LOW' raises a chip. */
  confidenceLabel?: string | null;
  /** Run data-quality verdict (e.g. 'DEGRADED' / 'STALE' / 'INVALID'). */
  runQuality?: string | null;
  /** Tipster-model alignment label (e.g. 'NO_TIPSTER_CONSENSUS'). */
  alignmentLabel?: string | null;
}

/**
 * Builds the at-a-glance warning chips shown on a race card / next-race header:
 * `LOW confidence`, `DEGRADED|STALE|INVALID data`, and `NO_TIPSTER_CONSENSUS`,
 * derived purely from already-stored read-only fields. Returns an empty array
 * when none apply. Decision-support only; never a bet instruction. Pure.
 */
export function buildRaceWarningChips(input: RaceWarningInput): StatusBadge[] {
  const chips: StatusBadge[] = [];

  if ((input.confidenceLabel ?? '').trim().toUpperCase() === 'LOW') {
    chips.push({ label: 'LOW confidence', tone: 'warn' });
  }

  const rq = (input.runQuality ?? '').trim().toUpperCase();
  if (rq === 'DEGRADED' || rq === 'STALE' || rq === 'INVALID') {
    chips.push({ label: `${rq} data`, tone: 'warn' });
  }

  if ((input.alignmentLabel ?? '').trim().toUpperCase() === 'NO_TIPSTER_CONSENSUS') {
    chips.push({ label: 'NO_TIPSTER_CONSENSUS', tone: 'neutral' });
  }

  return chips;
}
