/**
 * Pure relative-time formatting for dashboard freshness indicators (Phase 3A).
 *
 * Turns an absolute timestamp into a short "X ago" label plus the raw age in
 * milliseconds, so the UI can both display recency and decide staleness against
 * an existing threshold. No I/O, deterministic given `now`, and safe for missing
 * / unparseable / future timestamps (the latter clamp to "just now"). This is a
 * presentation helper only — it never touches model maths, EV, or staking.
 */

/** A timestamp's recency: a human label plus its age in ms (null when unknown). */
export interface RelativeAge {
  /** Human label, e.g. "just now", "30s ago", "5m ago", "2h ago", "3d ago". */
  text: string;
  /** Age in ms (>= 0), or null when the timestamp is missing / unparseable. */
  ageMs: number | null;
}

/** Label used when a timestamp is absent or cannot be parsed. */
const UNKNOWN_LABEL = 'unknown';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Parses a timestamp (ISO string / epoch ms / Date) to epoch ms, or null. */
function toEpochMs(
  timestamp: string | number | Date | null | undefined,
): number | null {
  if (timestamp == null) return null;
  if (timestamp instanceof Date) {
    const ms = timestamp.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof timestamp === 'number') {
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? null : ms;
}

/** Humanises a non-negative age in ms into a short label. */
function humanizeAge(ageMs: number): string {
  if (ageMs < 10 * SECOND) return 'just now';
  if (ageMs < MINUTE) return `${Math.floor(ageMs / SECOND)}s ago`;
  if (ageMs < HOUR) return `${Math.floor(ageMs / MINUTE)}m ago`;
  if (ageMs < DAY) return `${Math.floor(ageMs / HOUR)}h ago`;
  return `${Math.floor(ageMs / DAY)}d ago`;
}

/**
 * Formats the age of `timestamp` relative to `now` (epoch ms). Missing /
 * unparseable timestamps yield `{ text: 'unknown', ageMs: null }`. A future
 * timestamp is clamped to age 0 ("just now") rather than producing a negative
 * age, so clock skew never shows a nonsensical label.
 */
export function formatRelativeAge(
  timestamp: string | number | Date | null | undefined,
  now: number,
): RelativeAge {
  const ms = toEpochMs(timestamp);
  if (ms === null) {
    return { text: UNKNOWN_LABEL, ageMs: null };
  }
  const ageMs = Math.max(0, now - ms);
  return { text: humanizeAge(ageMs), ageMs };
}

/**
 * True when `timestamp` is older than `thresholdMs` relative to `now`. Missing /
 * unparseable timestamps are NOT considered stale (returns false) — the UI shows
 * a distinct "unavailable" state for those rather than a false stale warning.
 */
export function isStaleAge(
  timestamp: string | number | Date | null | undefined,
  now: number,
  thresholdMs: number,
): boolean {
  const { ageMs } = formatRelativeAge(timestamp, now);
  return ageMs !== null && ageMs > thresholdMs;
}
