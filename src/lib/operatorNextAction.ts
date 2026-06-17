/**
 * Pure helper for the READ-ONLY operator "next action" widget.
 *
 * Decision-support only. Given the loaded races (off time + stored status) and
 * the current clock, it derives the single most useful NEXT OPERATOR ACTION as
 * TEXT — e.g. "refresh the pipeline around T-minus-7", "run results:auto when a
 * result is available", "all races settled — run end-of-day reports". It also
 * offers a read-only terminal command SUGGESTION (never the commit flag, never a
 * clickable UI action). It reuses the shared {@link deriveRaceState} so the
 * action stays consistent with the dashboard's per-race state.
 *
 * It NEVER executes anything, NEVER writes the DB, NEVER calls an external API,
 * and NEVER places a bet. Given the same inputs it returns the same output, so it
 * is fully unit-testable without any I/O.
 */

import { deriveRaceState, type NextRaceLike } from './raceDayStatus';

export type NextActionTone = 'pos' | 'warn' | 'neutral';

/** Optional date/course scope used only to fill in a command suggestion. */
export interface OperatorScope {
  date?: string | null;
  course?: string | null;
}

/** The derived next operator action (text only). */
export interface NextAction {
  /** Stable machine key (for tests + styling). */
  kind:
    | 'capture'
    | 'refresh'
    | 'result-pending'
    | 'race-off'
    | 'monitor'
    | 'all-settled'
    | 'none';
  headline: string;
  detail: string;
  /** A READ-ONLY terminal command suggestion (never the commit flag), or null. */
  suggestedCommand: string | null;
  tone: NextActionTone;
}

/** Whole minutes until the off (never below 1 for an upcoming race). */
function minsToOff(toOffMs: number): number {
  return Math.max(1, Math.round(toOffMs / 60_000));
}

/**
 * Builds `npm run <script> -- --date <d> --course <c>` for a read-only suggestion.
 * NEVER appends a commit flag. A course containing whitespace is quoted. Pure.
 */
export function buildScopedCommand(script: string, scope?: OperatorScope): string {
  let cmd = `npm run ${script}`;
  const date = scope?.date?.trim();
  const course = scope?.course?.trim();
  if (date || course) {
    cmd += ' --';
    if (date) cmd += ` --date ${date}`;
    if (course) cmd += ` --course ${/\s/.test(course) ? `"${course}"` : course}`;
  }
  return cmd;
}

/**
 * Derives the single most useful next operator action from the loaded races.
 *
 * Priority (most time-critical first): an imminent next race inside T-minus-5
 * (capture) > inside T-minus-10 (pipeline refresh) > a finished race awaiting a
 * result (results:auto) > a race currently off (do not rerun) > an upcoming race
 * further out (monitor) > every race settled (end-of-day reports). Pure.
 */
export function deriveNextAction(
  races: readonly NextRaceLike[],
  now: number,
  scope?: OperatorScope,
): NextAction {
  let imminent5: number | null = null;
  let imminent10: number | null = null;
  let hasPending = false;
  let hasOff = false;
  let upcoming: number | null = null;
  let knownCount = 0;
  let settledCount = 0;

  for (const race of races) {
    const state = deriveRaceState({
      offTime: race.off_time,
      now,
      status: race.status ?? null,
    });
    if (state === 'unknown') continue;
    knownCount += 1;

    const offMs = race.off_time ? Date.parse(race.off_time) : NaN;
    const toOff = Number.isNaN(offMs) ? NaN : offMs - now;

    if (state === 't-minus-5' && !Number.isNaN(toOff)) {
      imminent5 = imminent5 === null ? toOff : Math.min(imminent5, toOff);
    } else if (state === 't-minus-10' && !Number.isNaN(toOff)) {
      imminent10 = imminent10 === null ? toOff : Math.min(imminent10, toOff);
    } else if (state === 'result-pending') {
      hasPending = true;
    } else if (state === 'off') {
      hasOff = true;
    } else if (state === 'upcoming' && !Number.isNaN(toOff)) {
      upcoming = upcoming === null ? toOff : Math.min(upcoming, toOff);
    } else if (state === 'settled') {
      settledCount += 1;
    }
  }

  if (knownCount === 0) {
    return {
      kind: 'none',
      headline: 'No scheduled races to action.',
      detail: 'No races with a known off time are loaded for this view.',
      suggestedCommand: null,
      tone: 'neutral',
    };
  }

  if (imminent5 !== null) {
    return {
      kind: 'capture',
      headline: `Next race in ${minsToOff(imminent5)}m — T-minus capture should be available.`,
      detail:
        'The final pre-off capture window is open — check the next race has fresh odds + a current pre-off model run.',
      suggestedCommand: buildScopedCommand('capture:t-minus', scope),
      tone: 'warn',
    };
  }

  if (imminent10 !== null) {
    return {
      kind: 'refresh',
      headline: `Next race in ${minsToOff(imminent10)}m — refresh pipeline around T-minus-7.`,
      detail:
        'Refresh odds + the model so the pre-off run is current before the off. Read-only / dry-run unless run manually in a terminal.',
      suggestedCommand: buildScopedCommand('pipeline:day', scope),
      tone: 'warn',
    };
  }

  if (hasPending) {
    return {
      kind: 'result-pending',
      headline: 'Result pending — run results:auto when the official/free result is available.',
      detail:
        'A finished race is awaiting a result. results:auto is read-only by default; settling is a separate manual backend command and is never run from this UI.',
      suggestedCommand: buildScopedCommand('results:auto', scope),
      tone: 'warn',
    };
  }

  if (hasOff) {
    return {
      kind: 'race-off',
      headline: 'Race off — do not rerun the model for this race.',
      detail:
        'A race is currently off. The pre-off run is the decision record; a post-off rerun must not supersede it.',
      suggestedCommand: null,
      tone: 'neutral',
    };
  }

  if (upcoming !== null) {
    return {
      kind: 'monitor',
      headline: `Next race in ${minsToOff(upcoming)}m — monitoring; no pipeline refresh needed yet.`,
      detail:
        'A pipeline refresh is due around T-minus-10. Watch odds + model freshness until then.',
      suggestedCommand: null,
      tone: 'neutral',
    };
  }

  // Everything known is settled.
  return {
    kind: 'all-settled',
    headline: 'All races settled — run end-of-day reports.',
    detail:
      'The card is complete. Generate the read-only day report and other end-of-day summaries.',
    suggestedCommand: buildScopedCommand('report:day', scope),
    tone: 'pos',
  };
}
