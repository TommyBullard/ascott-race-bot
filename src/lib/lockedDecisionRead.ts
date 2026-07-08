/**
 * Read-only access to the OFFICIAL T-minus locked decisions
 * (`locked_race_decisions`, Phase 1 schema) — Newmarket rebuild Phase 3.
 *
 * `fetchLockedDecisionForRace` returns the single official lock row for a race
 * at a capture horizon (default `minutes_before = 5`, THE official decision),
 * projected to the display/evaluation shape below. It is STRICTLY READ-ONLY
 * and FAIL-OPEN: a missing table (migration not yet applied), a query error,
 * or no row all yield `null`, so /api/recommendations and the dashboard never
 * break on the lock read. Missing-table errors are silent (a known
 * pre-migration state); unexpected errors are logged once per read.
 *
 * The projection deliberately EXCLUDES the `locked_state` jsonb snapshot: the
 * promoted columns exist precisely so consumers don't unpack the JSON, and the
 * full capture would bloat every dashboard poll for no Phase 3/4 consumer. It
 * is omitted from the SELECT itself, keeping the read cheap; a future audit
 * view can fetch it per race. `locked_state_schema_version` IS included so
 * consumers can detect snapshot versions now.
 *
 * Phase 3 exposes this as ADDITIONAL data on each race card only: `modelPick`
 * behaviour, display precedence, and performance evaluation are unchanged
 * until Phases 4-5. Decision-support only — never a betting instruction.
 */

import { supabaseAdmin } from './supabaseAdmin';
import { classifyTableProbe } from './dbHealthSpec';
import {
  LOCKED_DECISIONS_TABLE,
  OFFICIAL_MINUTES_BEFORE,
  type LockDecisionStatus,
} from './lockTMinus';

/**
 * The official T-minus locked decision for a race (a read-only projection of
 * one `locked_race_decisions` row). Display/evaluation data only.
 */
export interface LockedDecision {
  decision_status: LockDecisionStatus;
  /** When the lock was written (ISO; also the window-check instant). */
  lock_time: string;
  minutes_before: number;
  /** `off_time_at_lock - minutes_before` (ISO). */
  capture_target_time: string;
  /** The race's off time AS KNOWN AT LOCK TIME (ISO). */
  off_time_at_lock: string;
  /** Source model run, or null for `no_run_available`. */
  model_run_id: string | null;
  /** Why the locked decision was no-bet; null unless `locked_no_bet`. */
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
  /** Version of the (not-included-here) locked_state snapshot shape. */
  locked_state_schema_version: number;
}

/** The columns the read selects (locked_state intentionally absent). */
const LOCKED_DECISION_COLUMNS =
  'decision_status, lock_time, minutes_before, capture_target_time, ' +
  'off_time_at_lock, model_run_id, no_bet_reason, pick_runner_id, ' +
  'pick_horse_name, pick_odds, pick_ev, pick_model_prob, pick_market_prob, ' +
  'pick_stake, pick_confidence_label, run_quality, data_quality_flags, ' +
  'data_quality_short_summary, tipster_short_summary, ' +
  'tipster_alignment_label, locked_state_schema_version';

const VALID_STATUSES: readonly string[] = [
  'locked_pick',
  'locked_no_bet',
  'no_run_available',
];

/** Coerces a possibly null/string DB numeric to a number, or null. Pure. */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A non-empty string verbatim, else null (never invented). Pure. */
function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Maps a raw `locked_race_decisions` row to {@link LockedDecision}, or null
 * when the row is not usable (missing/invalid status or timestamps — a
 * malformed row is dropped, never guessed at). DB numerics may arrive as
 * strings via PostgREST and are coerced; nulls pass through verbatim; flags
 * are filtered to strings (anything malformed becomes `[]`). Pure.
 */
export function toLockedDecision(row: unknown): LockedDecision | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;

  const status = r.decision_status;
  if (typeof status !== 'string' || !VALID_STATUSES.includes(status)) return null;

  const lockTime = toStringOrNull(r.lock_time);
  const captureTarget = toStringOrNull(r.capture_target_time);
  const offAtLock = toStringOrNull(r.off_time_at_lock);
  const minutesBefore = toNumberOrNull(r.minutes_before);
  if (!lockTime || !captureTarget || !offAtLock || minutesBefore === null) {
    return null; // not-null in the schema; a row without them is unusable
  }

  const flags = Array.isArray(r.data_quality_flags)
    ? r.data_quality_flags.filter((f): f is string => typeof f === 'string')
    : [];

  return {
    decision_status: status as LockDecisionStatus,
    lock_time: lockTime,
    minutes_before: minutesBefore,
    capture_target_time: captureTarget,
    off_time_at_lock: offAtLock,
    model_run_id: toStringOrNull(r.model_run_id),
    no_bet_reason: toStringOrNull(r.no_bet_reason),
    pick_runner_id: toStringOrNull(r.pick_runner_id),
    pick_horse_name: toStringOrNull(r.pick_horse_name),
    pick_odds: toNumberOrNull(r.pick_odds),
    pick_ev: toNumberOrNull(r.pick_ev),
    pick_model_prob: toNumberOrNull(r.pick_model_prob),
    pick_market_prob: toNumberOrNull(r.pick_market_prob),
    pick_stake: toNumberOrNull(r.pick_stake),
    pick_confidence_label: toStringOrNull(r.pick_confidence_label),
    run_quality: toStringOrNull(r.run_quality),
    data_quality_flags: flags,
    data_quality_short_summary: toStringOrNull(r.data_quality_short_summary),
    tipster_short_summary: toStringOrNull(r.tipster_short_summary),
    tipster_alignment_label: toStringOrNull(r.tipster_alignment_label),
    locked_state_schema_version: toNumberOrNull(r.locked_state_schema_version) ?? 1,
  };
}

/**
 * Fetches the official locked decision for a race at a capture horizon
 * (default {@link OFFICIAL_MINUTES_BEFORE} = 5). READ-ONLY and FAIL-OPEN:
 *
 *  - no row               -> null (race not locked — the honest state);
 *  - table missing        -> null, SILENT (known pre-migration state; logging
 *                            it per race per poll would spam the server log);
 *  - any other error      -> null, logged once (so a post-migration systemic
 *                            failure — e.g. RLS misconfiguration — is visible);
 *  - malformed row        -> null (dropped by {@link toLockedDecision}).
 *
 * Never throws, so attaching it can never break a race card.
 */
export async function fetchLockedDecisionForRace(
  raceId: string,
  minutesBefore: number = OFFICIAL_MINUTES_BEFORE,
): Promise<LockedDecision | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from(LOCKED_DECISIONS_TABLE)
      .select(LOCKED_DECISION_COLUMNS)
      .eq('race_id', raceId)
      .eq('minutes_before', minutesBefore)
      .maybeSingle();
    if (error) {
      if (classifyTableProbe(error) !== 'missing') {
        console.error(
          `Failed to read locked decision for race ${raceId}: ${error.message}`,
        );
      }
      return null;
    }
    return toLockedDecision(data);
  } catch (err) {
    console.error(
      `Failed to read locked decision for race ${raceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
