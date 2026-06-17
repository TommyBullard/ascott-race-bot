/**
 * RaceTimelinePanel — a READ-ONLY race-day operational timeline.
 *
 * Purely presentational. It renders the per-race operational rows derived by
 * {@link buildRaceDayTimeline} (off time, odds/model freshness, pre-off run, the
 * T-5 capture target + availability, race/result state, settled time, and
 * warnings) so the operator can audit, at a glance, when each race's data last
 * changed. NO data fetching, NO API calls, NO backend coupling, NO write
 * controls. Decision-support only — it never changes the recommendation, never
 * predicts a winner, and shows "—" / "unknown" for missing values.
 */

import type { CSSProperties } from 'react';
import { formatRelativeAge } from '@/lib/relativeTime';
import {
  raceStateBadge,
  resultStatusBadge,
  type StatusTone,
} from '@/lib/raceDayStatus';
import type { TimelineEntry } from '@/lib/raceDayTimeline';

export interface RaceTimelinePanelProps {
  entries: TimelineEntry[];
  /** Current time (epoch ms) for the "updated X ago" freshness labels. */
  nowMs: number;
}

const DASH = '\u2014';

/** Formats an ISO time as local HH:MM, or a dash when missing/unparseable. */
function formatClock(iso: string | null): string {
  if (!iso) return DASH;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return DASH;
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Pill style tinted by tone (mirrors the dashboard status palette). */
function badgeStyle(tone: StatusTone): CSSProperties {
  const palette: Record<StatusTone, { bg: string; border: string; color: string }> = {
    pos: { bg: '#dafbe1', border: '#aceebb', color: '#1a7f37' },
    neg: { bg: '#ffebe9', border: '#ffcecb', color: '#cf222e' },
    warn: { bg: '#fff8c5', border: '#eac54f', color: '#9a6700' },
    neutral: { bg: '#f6f8fa', border: '#d0d7de', color: '#424a53' },
  };
  const c = palette[tone];
  return {
    display: 'inline-block',
    padding: '1px 8px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    background: c.bg,
    border: `1px solid ${c.border}`,
    color: c.color,
  };
}

const styles = {
  panel: {
    border: '1px solid #d0d7de',
    borderRadius: 10,
    padding: 16,
    background: '#fff',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#1f2328',
    marginBottom: 16,
  } as CSSProperties,
  heading: {
    fontSize: 16,
    margin: '0 0 4px',
  } as CSSProperties,
  note: {
    fontSize: 12,
    color: '#656d76',
    margin: '0 0 12px',
  } as CSSProperties,
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  } as CSSProperties,
  row: {
    borderTop: '1px dashed #eaeef2',
    paddingTop: 10,
  } as CSSProperties,
  rowTop: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'baseline',
    gap: 8,
  } as CSSProperties,
  time: {
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  name: {
    flex: 1,
    minWidth: 0,
    overflowWrap: 'anywhere' as const,
    fontWeight: 600,
  } as CSSProperties,
  metaRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 12,
    fontSize: 12.5,
    color: '#656d76',
    marginTop: 4,
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  stale: {
    color: '#9a6700',
    fontWeight: 700,
  } as CSSProperties,
  warnRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 6,
    marginTop: 6,
  } as CSSProperties,
  warnChip: {
    display: 'inline-block',
    padding: '1px 8px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    background: '#fff8c5',
    border: '1px solid #eac54f',
    color: '#9a6700',
  } as CSSProperties,
  empty: {
    fontSize: 14,
    color: '#656d76',
    margin: 0,
  } as CSSProperties,
} as const;

/** A single timeline row for one race. */
function TimelineRow({ entry, nowMs }: { entry: TimelineEntry; nowMs: number }) {
  const state = raceStateBadge(entry.raceState);
  const result = resultStatusBadge(entry.resultStatus);
  const oddsAge = formatRelativeAge(entry.oddsUpdatedAt, nowMs);
  const modelAge = formatRelativeAge(entry.modelUpdatedAt, nowMs);

  return (
    <div style={styles.row}>
      <div style={styles.rowTop}>
        <span style={styles.time}>{formatClock(entry.off_time)}</span>
        <span style={styles.name}>{entry.race_name ?? DASH}</span>
        <span style={badgeStyle(state.tone)}>{state.label}</span>
        {result.label !== DASH && (
          <span style={badgeStyle(result.tone)}>{`Result: ${result.label}`}</span>
        )}
      </div>
      <div style={styles.metaRow}>
        <span style={entry.oddsStale ? styles.stale : undefined}>
          {`Odds: ${oddsAge.text}${entry.oddsStale ? ' \u00b7 stale' : ''}`}
        </span>
        <span style={entry.modelStale ? styles.stale : undefined}>
          {`Model: ${modelAge.text}${entry.modelStale ? ' \u00b7 stale' : ''}`}
        </span>
        <span>{`Pre-off run: ${formatClock(entry.preOffRunTime)}`}</span>
        <span>{`T-5 target: ${formatClock(entry.tMinusCaptureTarget)}`}</span>
        <span>{`Capture: ${entry.captureAvailable ? 'available' : 'missing'}`}</span>
        {entry.settledTime && <span>{`Settled: ${formatClock(entry.settledTime)}`}</span>}
      </div>
      {entry.warnings.length > 0 && (
        <div style={styles.warnRow}>
          {entry.warnings.map((w) => (
            <span key={w} style={styles.warnChip}>
              {w}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RaceTimelinePanel({ entries, nowMs }: RaceTimelinePanelProps) {
  return (
    <section style={styles.panel}>
      <h2 style={styles.heading}>Race-day timeline</h2>
      <p style={styles.note}>
        Read-only operational status from stored data. Freshness for completed
        races is judged as-of off time. This is decision-support only.
      </p>
      {entries.length === 0 ? (
        <p style={styles.empty}>No races.</p>
      ) : (
        <div style={styles.list}>
          {entries.map((entry) => (
            <TimelineRow key={entry.race_id} entry={entry} nowMs={nowMs} />
          ))}
        </div>
      )}
    </section>
  );
}
