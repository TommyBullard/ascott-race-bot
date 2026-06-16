/**
 * Pure pre-off / post-off run guard.
 *
 * Decides whether the model should run for a race, given the race's scheduled
 * off time and status. The goal is to protect the FINAL pre-off model run (the
 * one the dashboard/evaluation treats as the race's recommendation) from being
 * superseded by a later post-off rerun on stale odds.
 *
 * Policy:
 *   - A race whose `status` is `result` is already settled — skip (RESULTED).
 *   - A race whose scheduled off time has passed (`now > off_time`) — skip
 *     (POST_OFF).
 *   - Otherwise the race is pre-off — run normally.
 *
 * `allowPostOff` is an explicit DIAGNOSTIC override: it lets a post-off/resulted
 * run proceed, but the caller must then write that run as NON-current and must
 * NOT supersede the valid pre-off run (see `runModelForRace`). When the override
 * is set, `skip` is false but `reason` is still reported, so the caller knows it
 * is a diagnostic post-off run.
 *
 * No I/O, no mutation, never throws — so the policy is fully unit-testable.
 */

/** Why a model run was (or would be) skipped by the pre-off guard. */
export type PreOffSkipReason = 'POST_OFF' | 'RESULTED';

/** The race signals the guard needs (a subset of `races`). */
export interface ModelRunGuardInput {
  /** Scheduled off time (ISO 8601 timestamptz), or null/undefined when unknown. */
  off_time: string | null | undefined;
  /** Race status (e.g. `result` once settled), or null/undefined when unknown. */
  status: string | null | undefined;
}

/** Options controlling the guard decision. */
export interface ModelRunGuardOptions {
  /**
   * Diagnostic override: allow a post-off / resulted run to proceed. The caller
   * MUST then write the run as non-current and must not supersede the pre-off
   * run. Default false (post-off / resulted races are skipped).
   */
  allowPostOff?: boolean;
}

/** The guard's decision. */
export interface ModelRunGuardDecision {
  /** True when the model run should be skipped entirely (no write). */
  skip: boolean;
  /**
   * The post-off reason, when the race is post-off / resulted — reported even
   * when `allowPostOff` makes `skip` false (so the caller can write a diagnostic
   * non-current run). Null when the race is pre-off.
   */
  reason: PreOffSkipReason | null;
}

/** The `races.status` value that marks a race as settled/resulted. */
const RESULT_STATUS = 'result';

/**
 * Evaluates the pre-off run guard for a race. Pure; `now` is injectable so tests
 * are deterministic (defaults to the wall clock).
 *
 * Precedence: a `result` status wins over a passed off time (a settled race is
 * reported as RESULTED, the more specific reason). An unknown/empty off time is
 * treated as "cannot tell" and does NOT trigger POST_OFF (the race runs), so a
 * missing timestamp never silently suppresses a legitimate pre-off run.
 */
export function evaluateModelRunGuard(
  input: ModelRunGuardInput,
  now: Date = new Date(),
  options: ModelRunGuardOptions = {},
): ModelRunGuardDecision {
  let reason: PreOffSkipReason | null = null;

  if ((input.status ?? '').trim().toLowerCase() === RESULT_STATUS) {
    reason = 'RESULTED';
  } else if (input.off_time != null && input.off_time !== '') {
    const offMs = new Date(input.off_time).getTime();
    if (Number.isFinite(offMs) && now.getTime() > offMs) {
      reason = 'POST_OFF';
    }
  }

  return { skip: reason !== null && options.allowPostOff !== true, reason };
}

/**
 * Whether a race should be DISPLAYED as historical — i.e. it has already gone
 * off (`now > off_time`) or is resulted (`status = result`). When true, the
 * race card / evaluation should show the final **pre-off** model run
 * (`run_time <= off_time`) instead of the live `is_current` run, which a post-off
 * rerun on stale odds may have superseded.
 *
 * This is the read-side mirror of {@link evaluateModelRunGuard} (which gates the
 * write side): both use the same off/resulted detection, single-sourced here.
 * For an UPCOMING race this returns false, so live/current selection is
 * preserved unchanged. Pure; `now` is injectable for tests.
 */
export function isHistoricalRaceView(
  input: ModelRunGuardInput,
  now: Date = new Date(),
): boolean {
  return evaluateModelRunGuard(input, now).reason !== null;
}
