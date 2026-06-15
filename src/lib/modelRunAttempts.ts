/**
 * Lightweight debugging visibility for model runs that were SKIPPED before any
 * `model_runs` row was written — e.g. a race with no market snapshot or no
 * priced runners.
 *
 * This is a stub capability: it NEVER writes to the database (no migration) and
 * NEVER changes model behaviour. It provides a structured entry shape (mirroring
 * what a future `model_run_attempts` table could persist), a pure builder, a
 * bounded in-memory store, and a structured logger.
 */

/**
 * Why a model run was skipped at the input-gathering stage. The first two mirror
 * the `DATA_QUALITY_FLAG` values of the same name; `NO_DECLARED_RUNNERS` is the
 * distinct "the race has no runners at all" case (logged for visibility).
 */
export type SkippedRunReason =
  | 'NO_MARKET_SNAPSHOT'
  | 'NO_PRICED_RUNNERS'
  | 'NO_DECLARED_RUNNERS';

/** A structured record of one skipped model-run attempt. */
export interface ModelRunAttempt {
  race_id: string;
  reason: SkippedRunReason;
  /** ISO 8601 timestamp the attempt was skipped. */
  timestamp: string;
}

/**
 * Builds a structured skipped-attempt entry. Pure; `now` is injectable so tests
 * are deterministic (defaults to the wall clock).
 */
export function buildModelRunAttempt(
  race_id: string,
  reason: SkippedRunReason,
  now: Date = new Date(),
): ModelRunAttempt {
  return { race_id, reason, timestamp: now.toISOString() };
}

/**
 * Most recent skipped attempts retained in memory (newest last). Bounded by
 * {@link MAX_RETAINED_ATTEMPTS} so a long-running process cannot leak memory.
 * Best-effort only: process-local and reset on restart (e.g. a serverless cold
 * start) — it is a debugging aid, not a source of truth.
 */
const MAX_RETAINED_ATTEMPTS = 100;
const attempts: ModelRunAttempt[] = [];

/** Records an attempt in the in-memory store, trimming to the retention cap. */
export function recordModelRunAttempt(attempt: ModelRunAttempt): void {
  attempts.push(attempt);
  if (attempts.length > MAX_RETAINED_ATTEMPTS) {
    attempts.splice(0, attempts.length - MAX_RETAINED_ATTEMPTS);
  }
}

/** Returns the retained skipped attempts (most recent last). Read-only copy. */
export function getModelRunAttempts(): readonly ModelRunAttempt[] {
  return [...attempts];
}

/** Clears the in-memory store (intended for tests / manual resets). */
export function clearModelRunAttempts(): void {
  attempts.length = 0;
}

/**
 * Records and logs a skipped model run as a single structured entry
 * `{ race_id, reason, timestamp }`, returning that entry. Side effects only
 * (an in-memory record + a `console.warn`); never touches the database.
 */
export function logSkippedModelRun(
  race_id: string,
  reason: SkippedRunReason,
  now: Date = new Date(),
): ModelRunAttempt {
  const attempt = buildModelRunAttempt(race_id, reason, now);
  recordModelRunAttempt(attempt);
  console.warn('[runModelForRace] skipped run:', JSON.stringify(attempt));
  return attempt;
}
