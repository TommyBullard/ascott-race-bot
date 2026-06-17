/**
 * SettlementStatusPanel — a READ-ONLY result-settlement status display.
 *
 * Purely presentational. For a settled/off race it shows the settlement status
 * (settled / pending / settle-ready / blocked), the winner + the model pick's
 * finishing position when settled, any stored Free-API result note, and a fixed
 * "backend settlement only; UI is read-only" disclaimer. It renders NOTHING for
 * an upcoming/unknown race. NO data fetching, NO API calls, NO write controls,
 * NO commit button — the website never settles; the backend `results:auto`
 * command does. Decision-support only; missing values render "—".
 */

import type { CSSProperties } from 'react';
import { formatFinishPosition } from '@/lib/raceIntelligence';
import {
  settlementStatusBadge,
  SETTLEMENT_READONLY_NOTE,
  type SettlementTone,
  type SettlementView,
} from '@/lib/settlementStatus';

export interface SettlementStatusPanelProps {
  view: SettlementView;
  /** Optional style override merged over the panel container (e.g. when nested). */
  style?: CSSProperties;
}

const DASH = '\u2014';

/** Pill style tinted by tone (mirrors the dashboard status palette). */
function badgeStyle(tone: SettlementTone): CSSProperties {
  const palette: Record<SettlementTone, { bg: string; border: string; color: string }> = {
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
    padding: '10px 12px',
    background: '#fff',
    marginBottom: 12,
  } as CSSProperties,
  label: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.5,
    color: '#656d76',
    textTransform: 'uppercase' as const,
    marginBottom: 6,
  } as CSSProperties,
  row: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'baseline',
    gap: 12,
    fontSize: 14,
  } as CSSProperties,
  muted: {
    color: '#656d76',
  } as CSSProperties,
  note: {
    fontSize: 12.5,
    color: '#424a53',
    marginTop: 6,
    overflowWrap: 'anywhere' as const,
  } as CSSProperties,
  disclaimer: {
    fontSize: 11.5,
    color: '#656d76',
    marginTop: 6,
  } as CSSProperties,
} as const;

export default function SettlementStatusPanel({ view, style }: SettlementStatusPanelProps) {
  // Only settled/off races have a meaningful settlement state.
  if (view.status === 'unknown') return null;

  const badge = settlementStatusBadge(view.status);

  return (
    <div style={style ? { ...styles.panel, ...style } : styles.panel}>
      <div style={styles.label}>Result settlement</div>
      <div style={styles.row}>
        <span style={badgeStyle(badge.tone)}>{badge.label}</span>
        {view.settled && (
          <span>
            <span style={styles.muted}>Winner: </span>
            <strong>{view.winnerName ?? DASH}</strong>
          </span>
        )}
        {view.settled && (
          <span>
            <span style={styles.muted}>Model pick: </span>
            {formatFinishPosition(view.modelPickFinish)}
          </span>
        )}
      </div>
      {view.freeResultNote && <div style={styles.note}>{view.freeResultNote}</div>}
      <div style={styles.disclaimer}>{SETTLEMENT_READONLY_NOTE}</div>
    </div>
  );
}
