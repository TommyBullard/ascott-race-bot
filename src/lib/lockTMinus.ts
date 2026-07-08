/**
 * Pure helpers for the T-minus lock CLI (scripts/lockTMinus.ts) — Newmarket
 * rebuild Phase 2.
 *
 * The lock CLI persists each race's OFFICIAL T-minus-N decision into the
 * append-only `locked_race_decisions` table (Phase 1 schema,
 * 20260708000000_locked_race_decisions.sql). Everything decision-shaped lives
 * here as pure, deterministic functions: argument parsing, the commit-window
 * classification, the decision-status mapping, the no-bet-reason derivation,
 * the insert-row construction, the summary counting, and the report rendering.
 * No I/O, no DB, no wall-clock reads — `now` is always injected — so every rule
 * is unit-testable.
 *
 * CORE SAFETY RULES (enforced here and re-checked by the DB constraints):
 *   - ONE TIMESTAMP: the CLI captures a single `scriptNow` at startup and uses
 *     it for BOTH the window classification and the inserted `lock_time`, so a
 *     row that passes `now <= off_time` here can never fail the DB's
 *     `lock_time <= off_time_at_lock` CHECK.
 *   - COMMIT WINDOW: a race is persistable only when
 *     `capture_target_time <= now <= off_time` (both boundaries inclusive).
 *     Inside the window every persisted state is FINAL BY CONSTRUCTION: no
 *     future model run can have `run_time <= capture_target_time`, so even a
 *     committed `no_run_available` can never be invalidated later.
 *   - TOO EARLY / POST-OFF: reported (`too_early_not_locked` /
 *     `skipped_post_off`), never persisted. A `result` status is post-off
 *     regardless of the clock (reuses the shared `evaluateModelRunGuard`).
 *   - NEVER FABRICATES: the row passes capture nulls through verbatim; the
 *     no-bet reason is composed ONLY from stored facts; `locked_state`
 *     preserves the full capture JSON with nulls intact.
 *
 * Decision-support only. This module builds research decision records — it
 * never places bets and has no betting/order semantics.
 */

import { evaluateModelRunGuard } from './modelRunGuard';
import {
  parseTMinusCaptureArgs,
  buildTMinusCaptureWarnings,
  type TMinusCaptureArgs,
  type TMinusRaceCapture,
} from './tMinusCapture';

/** The append-only official-decision table (Phase 1 migration). */
export const LOCKED_DECISIONS_TABLE = 'locked_race_decisions';

/** The shape version stamped on every `locked_state` snapshot this code writes. */
export const LOCKED_STATE_SCHEMA_VERSION = 1;

/** The official capture horizon: `minutes_before = 5` rows are THE decision. */
export const OFFICIAL_MINUTES_BEFORE = 5;

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

/** Parsed CLI options for the lock script: the capture args plus `--commit`. */
export interface LockTMinusArgs extends TMinusCaptureArgs {
  /** True only when `--commit` was passed; otherwise the run is a dry run. */
  commit: boolean;
}

/**
 * Parses argv (sliced past `node script`). REUSES the capture parser for
 * `--date` / `--course` / `--minutes-before` (identical semantics and
 * defaults), adding only the `--commit` boolean. Dry-run is the default:
 * `commit` is true ONLY when the exact flag is present. Pure.
 */
export function parseLockTMinusArgs(argv: readonly string[]): LockTMinusArgs {
  return {
    ...parseTMinusCaptureArgs(argv),
    commit: argv.includes('--commit'),
  };
}

/* -------------------------------------------------------------------------- */
/* Commit-window classification                                               */
/* -------------------------------------------------------------------------- */

/**
 * Where `now` falls relative to a race's lock window:
 *   - `in_window`  : capture_target_time <= now <= off_time — persistable.
 *   - `too_early`  : now < capture_target_time — report, never persist.
 *   - `post_off`   : now > off_time, or the race status is `result` — report,
 *                    never persist.
 *   - `no_window`  : off time / capture target missing or unparseable — the
 *                    race cannot be locked (surfaced as an error, not guessed).
 */
export type LockWindowClassification =
  | 'in_window'
  | 'too_early'
  | 'post_off'
  | 'no_window';

/** The race signals the window classifier needs. */
export interface LockWindowInput {
  /** Scheduled off time (ISO 8601), or null when unknown. */
  off_time: string | null | undefined;
  /** `off_time - minutes_before` (ISO 8601), or null when unknown. */
  capture_target_time: string | null | undefined;
  /** Race status (`result` marks a settled race), or null when unknown. */
  status: string | null | undefined;
}

/**
 * Classifies the lock window for a race at the given instant. Both boundaries
 * are INCLUSIVE: exactly at the capture target is lockable (the window has
 * opened) and exactly at the off is lockable (the last safe moment — the DB
 * CHECK `lock_time <= off_time_at_lock` accepts equality). A `result` status
 * is post-off regardless of the clock (delegated to the shared
 * `evaluateModelRunGuard`, which also treats `now > off` as post-off). A race
 * with no parseable off time or capture target can NEVER be locked — that is
 * `no_window`, never a guess. Pure; never throws.
 */
export function classifyLockWindow(
  input: LockWindowInput,
  nowIso: string,
): LockWindowClassification {
  const now = new Date(nowIso);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return 'no_window';

  // Resulted races and passed offs are post-off — same detection the model
  // pipeline uses (single-sourced in modelRunGuard).
  const guard = evaluateModelRunGuard(
    { off_time: input.off_time, status: input.status },
    now,
  );
  if (guard.reason !== null) return 'post_off';

  const offMs = input.off_time ? new Date(input.off_time).getTime() : NaN;
  const capMs = input.capture_target_time
    ? new Date(input.capture_target_time).getTime()
    : NaN;
  if (!Number.isFinite(offMs) || !Number.isFinite(capMs)) return 'no_window';

  if (nowMs < capMs) return 'too_early';
  // guard already excluded nowMs > offMs; equality (the off itself) is in-window.
  return 'in_window';
}

/* -------------------------------------------------------------------------- */
/* Decision mapping                                                           */
/* -------------------------------------------------------------------------- */

/** The three official lock states (matches the DB CHECK constraint). */
export type LockDecisionStatus =
  | 'locked_pick'
  | 'locked_no_bet'
  | 'no_run_available';

/**
 * Derives the no-bet reason from STORED FACTS ONLY: the base fact (the captured
 * run made no rank-1 recommendation), plus the run's stored quality verdict
 * (when present and not OK) and its stored data-quality summary (when present).
 * Deterministic; never invents a cause — when the run stored no context, the
 * base fact alone is the honest reason. Pure.
 */
export function deriveNoBetReason(capture: TMinusRaceCapture): string {
  const parts = ['captured run produced no rank-1 recommendation'];
  const quality = (capture.run_quality ?? '').trim();
  if (quality !== '' && quality.toUpperCase() !== 'OK') {
    parts.push(`run quality: ${quality}`);
  }
  const summary = (capture.data_quality_short_summary ?? '').trim();
  if (summary !== '') {
    parts.push(`data quality: ${summary}`);
  }
  return parts.join('; ');
}

/** A capture's decision status + reason (reason only for `locked_no_bet`). */
export interface LockDecision {
  decision_status: LockDecisionStatus;
  no_bet_reason: string | null;
}

/**
 * Maps a T-minus capture to its official decision state:
 *   - no selected run          -> `no_run_available` (reason null);
 *   - selected run + pick      -> `locked_pick` (reason null);
 *   - selected run, no pick    -> `locked_no_bet` (reason REQUIRED, derived
 *                                 from stored facts via {@link deriveNoBetReason}).
 * Pure.
 */
export function deriveLockDecision(capture: TMinusRaceCapture): LockDecision {
  if (capture.selected_run_id === null) {
    return { decision_status: 'no_run_available', no_bet_reason: null };
  }
  if (capture.pick !== null) {
    return { decision_status: 'locked_pick', no_bet_reason: null };
  }
  return { decision_status: 'locked_no_bet', no_bet_reason: deriveNoBetReason(capture) };
}

/* -------------------------------------------------------------------------- */
/* Insert-row construction                                                    */
/* -------------------------------------------------------------------------- */

/** The exact `locked_race_decisions` insert payload (Phase 1 columns). */
export interface LockedDecisionInsertRow {
  race_id: string;
  model_run_id: string | null;
  lock_time: string;
  minutes_before: number;
  off_time_at_lock: string;
  capture_target_time: string;
  decision_status: LockDecisionStatus;
  no_bet_reason: string | null;
  pick_runner_id: string | null;
  pick_horse_name: string | null;
  pick_odds: number | null;
  pick_ev: number | null;
  pick_model_prob: number | null;
  pick_market_prob: number | null;
  pick_stake: number | null;
  pick_confidence_label: string | null;
  run_quality: string | null;
  data_quality_flags: string[];
  data_quality_short_summary: string | null;
  tipster_short_summary: string | null;
  tipster_alignment_label: string | null;
  locked_state: Record<string, unknown>;
  locked_state_schema_version: number;
}

/**
 * Builds the insert row for an IN-WINDOW race. `lockTimeIso` must be the same
 * `scriptNow` the window classification used (one timestamp for both — see the
 * module header). Returns null when the off time or capture target is missing
 * (a `no_window` race; the caller classifies that before ever calling this).
 *
 * Every value comes from the capture verbatim: pick columns are populated only
 * for `locked_pick` (null otherwise, matching the DB CHECKs); nulls are
 * preserved, never replaced; `locked_state` is the full capture plus its
 * derived warnings and `schema_version`. Pure; never fabricates.
 */
export function buildLockedDecisionRow(
  capture: TMinusRaceCapture,
  minutesBefore: number,
  lockTimeIso: string,
): LockedDecisionInsertRow | null {
  if (!capture.off_time || !capture.capture_target_time) return null;

  const decision = deriveLockDecision(capture);
  const pick = decision.decision_status === 'locked_pick' ? capture.pick : null;

  return {
    race_id: capture.race_id,
    model_run_id: capture.selected_run_id,
    lock_time: lockTimeIso,
    minutes_before: minutesBefore,
    off_time_at_lock: capture.off_time,
    capture_target_time: capture.capture_target_time,
    decision_status: decision.decision_status,
    no_bet_reason: decision.no_bet_reason,
    pick_runner_id: pick?.runner_id ?? null,
    pick_horse_name: pick?.horse_name ?? null,
    pick_odds: pick?.odds ?? null,
    pick_ev: pick?.ev ?? null,
    pick_model_prob: pick?.model_prob ?? null,
    pick_market_prob: pick?.market_prob ?? null,
    pick_stake: pick?.stake ?? null,
    pick_confidence_label: pick?.confidence_label ?? null,
    run_quality: capture.run_quality,
    data_quality_flags: capture.data_quality_flags,
    data_quality_short_summary: capture.data_quality_short_summary,
    tipster_short_summary: capture.tipster_short_summary,
    tipster_alignment_label: capture.tipster_alignment_label,
    locked_state: {
      ...capture,
      warnings: buildTMinusCaptureWarnings(capture),
      schema_version: LOCKED_STATE_SCHEMA_VERSION,
    },
    locked_state_schema_version: LOCKED_STATE_SCHEMA_VERSION,
  };
}

/* -------------------------------------------------------------------------- */
/* Outcomes + summary                                                         */
/* -------------------------------------------------------------------------- */

/** Every way a race can leave the lock loop (the summary's counters). */
export type LockOutcomeKind =
  | 'locked_pick'
  | 'locked_no_bet'
  | 'no_run_available'
  | 'too_early_not_locked'
  | 'skipped_post_off'
  | 'already_locked'
  | 'error';

/** One race's outcome, for the per-race report lines and the summary. */
export interface LockRaceOutcome {
  race_id: string;
  race_name: string | null;
  off_time: string | null;
  kind: LockOutcomeKind;
  /** One human line of context (pick name, error message, ...), or null. */
  detail: string | null;
}

/** The per-kind counts (requirement: all eight, races considered included). */
export interface LockRunSummary {
  races_considered: number;
  locked_pick: number;
  locked_no_bet: number;
  no_run_available: number;
  too_early_not_locked: number;
  skipped_post_off: number;
  already_locked: number;
  errors: number;
}

/** Counts outcomes into the summary. Pure; order-independent. */
export function summarizeLockOutcomes(
  outcomes: readonly LockRaceOutcome[],
): LockRunSummary {
  const summary: LockRunSummary = {
    races_considered: outcomes.length,
    locked_pick: 0,
    locked_no_bet: 0,
    no_run_available: 0,
    too_early_not_locked: 0,
    skipped_post_off: 0,
    already_locked: 0,
    errors: 0,
  };
  for (const o of outcomes) {
    if (o.kind === 'error') summary.errors += 1;
    else summary[o.kind] += 1;
  }
  return summary;
}

/** Off time as HH:MM (UTC) for report lines, or an em dash. Pure. */
function fmtOffTimeHm(offTime: string | null): string {
  if (!offTime) return '—';
  const ms = new Date(offTime).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) : '—';
}

/** Renders one race's outcome line deterministically. Pure. */
export function renderLockOutcomeLine(outcome: LockRaceOutcome): string {
  const name = outcome.race_name ?? '(unknown race)';
  const detail = outcome.detail ? ` — ${outcome.detail}` : '';
  return `  ${fmtOffTimeHm(outcome.off_time)} ${name}: ${outcome.kind}${detail}`;
}

/** Options for the summary rendering (echoed into the header lines). */
export interface LockRunRenderOptions {
  date: string;
  course: string | null;
  minutesBefore: number;
  commit: boolean;
  /** The single scriptNow used for windows AND lock_time (shown for audit). */
  lockTimeIso: string;
}

/**
 * Renders the deterministic run summary. A dry run (the default) carries an
 * unmissable banner stating nothing was persisted; a commit run states what
 * was written. Pure: same inputs, same lines.
 */
export function renderLockRunSummary(
  summary: LockRunSummary,
  options: LockRunRenderOptions,
): string[] {
  const lines: string[] = [];
  lines.push(
    `T-minus-${options.minutesBefore} lock — ${options.date}` +
      (options.course ? ` (course ~ "${options.course}")` : ''),
  );
  lines.push(`Script time (window check + lock_time): ${options.lockTimeIso}`);
  if (options.commit) {
    lines.push('MODE: COMMIT — in-window decisions were persisted to locked_race_decisions.');
  } else {
    lines.push('MODE: DRY RUN — nothing was persisted. Pass --commit to write locks.');
  }
  lines.push('');
  lines.push(`Races considered:     ${summary.races_considered}`);
  lines.push(`  locked_pick:          ${summary.locked_pick}`);
  lines.push(`  locked_no_bet:        ${summary.locked_no_bet}`);
  lines.push(`  no_run_available:     ${summary.no_run_available}`);
  lines.push(`  too_early_not_locked: ${summary.too_early_not_locked}`);
  lines.push(`  skipped_post_off:     ${summary.skipped_post_off}`);
  lines.push(`  already_locked:       ${summary.already_locked}`);
  lines.push(`  errors:               ${summary.errors}`);
  return lines;
}

/* -------------------------------------------------------------------------- */
/* Insert-conflict classification                                             */
/* -------------------------------------------------------------------------- */

/** The subset of a PostgREST error the conflict classifier reasons about. */
export interface InsertErrorLike {
  code?: string | null;
  message?: string | null;
}

/**
 * True when an insert error is the `unique (race_id, minutes_before)`
 * violation — i.e. another invocation locked the race between our existence
 * check and our insert. The caller classifies that as `already_locked` (a safe,
 * expected outcome), NOT as an error. Pure.
 */
export function isUniqueViolation(error: InsertErrorLike | null | undefined): boolean {
  if (!error) return false;
  if ((error.code ?? '') === '23505') return true;
  const msg = (error.message ?? '').toLowerCase();
  return (
    msg.includes('duplicate key value') ||
    msg.includes('locked_race_decisions_one_per_horizon')
  );
}
