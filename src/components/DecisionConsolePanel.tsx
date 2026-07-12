/**
 * DecisionConsolePanel — the READ-ONLY Race-Day Decision Console.
 *
 * Purely presentational. Renders {@link buildDecisionConsole}'s view: summary
 * counts, then every race with a coloured priority chip (NEXT ACTION /
 * WARNING / MONITOR / GOOD), the race name, the plain-language reason, and a
 * countdown where a deadline applies. NO data fetching, NO API calls, NO
 * write controls, NO commit buttons, NO bet placement.
 *
 * Mobile-first: the TOP THREE most urgent rows are always visible; the rest
 * collapse behind a native <details> toggle (no JS state). Decision-support
 * only — priorities are operational display hints, never betting instructions.
 */

import type { CSSProperties } from 'react';
import {
  CONSOLE_PRIORITY_LABEL,
  type ConsoleItem,
  type ConsolePriority,
  type DecisionConsoleView,
} from '@/lib/decisionConsole';

export interface DecisionConsolePanelProps {
  view: DecisionConsoleView;
}

/** How many rows stay visible above the fold (mobile requirement). */
export const CONSOLE_VISIBLE_ROWS = 3;

const CHIP_PALETTE: Record<ConsolePriority, { color: string; bg: string; border: string }> = {
  next_action: { color: '#0550ae', bg: '#ddf4ff', border: '#b6e3ff' },
  warning: { color: '#cf222e', bg: '#ffebe9', border: '#ffcecb' },
  monitor: { color: '#9a6700', bg: '#fff8c5', border: '#eed888' },
  good: { color: '#1a7f37', bg: '#dafbe1', border: '#aceebb' },
};

const styles = {
  panel: {
    border: '1px solid #d0d7de',
    borderRadius: 10,
    padding: '10px 14px',
    background: '#fff',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#1f2328',
    margin: '12px 0 4px',
  } as CSSProperties,
  headRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    flexWrap: 'wrap' as const,
  } as CSSProperties,
  title: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    color: '#57606a',
  } as CSSProperties,
  counts: {
    fontSize: 11.5,
    color: '#57606a',
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap' as const,
  } as CSSProperties,
  row: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    flexWrap: 'wrap' as const,
    padding: '4px 0',
    fontSize: 13,
    lineHeight: 1.5,
    borderTop: '1px dashed #eaeef2',
  } as CSSProperties,
  raceName: { fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' as const } as CSSProperties,
  reason: { color: '#57606a', overflowWrap: 'anywhere' as const } as CSSProperties,
  countdown: {
    color: '#0550ae',
    fontVariantNumeric: 'tabular-nums' as const,
    whiteSpace: 'nowrap' as const,
  } as CSSProperties,
  moreSummary: {
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.5,
    color: '#656d76',
    textTransform: 'uppercase' as const,
    padding: '6px 0 2px',
  } as CSSProperties,
  empty: { fontSize: 13, color: '#656d76', marginTop: 6 } as CSSProperties,
};

function chipStyle(priority: ConsolePriority): CSSProperties {
  const p = CHIP_PALETTE[priority];
  return {
    display: 'inline-block',
    padding: '1px 8px',
    borderRadius: 999,
    fontSize: 10.5,
    fontWeight: 800,
    letterSpacing: 0.5,
    whiteSpace: 'nowrap',
    color: p.color,
    background: p.bg,
    border: `1px solid ${p.border}`,
  };
}

function ConsoleRow({ item }: { item: ConsoleItem }) {
  // The countdown is shown separately only when it isn't already the reason.
  const showCountdown = item.countdown !== null && item.countdown !== item.reason;
  return (
    <div style={styles.row}>
      <span style={chipStyle(item.priority)}>{CONSOLE_PRIORITY_LABEL[item.priority]}</span>
      <span style={styles.raceName}>{item.race_name ?? '(unknown race)'}</span>
      <span style={styles.reason}>— {item.reason}</span>
      {showCountdown && <span style={styles.countdown}>{item.countdown}</span>}
    </div>
  );
}

export default function DecisionConsolePanel({ view }: DecisionConsolePanelProps) {
  const { items, counts } = view;
  const visible = items.slice(0, CONSOLE_VISIBLE_ROWS);
  const rest = items.slice(CONSOLE_VISIBLE_ROWS);

  return (
    <section style={styles.panel} aria-label="Race-day decision console">
      <div style={styles.headRow}>
        <span style={styles.title}>Decision Console</span>
        <span style={styles.counts}>
          <span style={{ color: CHIP_PALETTE.next_action.color }}>
            NEXT ACTION: {counts.next_action}
          </span>
          <span style={{ color: CHIP_PALETTE.warning.color }}>WARNING: {counts.warning}</span>
          <span style={{ color: CHIP_PALETTE.monitor.color }}>MONITOR: {counts.monitor}</span>
          <span style={{ color: CHIP_PALETTE.good.color }}>GOOD: {counts.good}</span>
        </span>
      </div>
      {items.length === 0 && (
        <div style={styles.empty}>No races in scope — nothing needs attention.</div>
      )}
      {visible.map((item) => (
        <ConsoleRow key={item.race_id} item={item} />
      ))}
      {rest.length > 0 && (
        <details>
          <summary style={styles.moreSummary}>Show {rest.length} more</summary>
          {rest.map((item) => (
            <ConsoleRow key={item.race_id} item={item} />
          ))}
        </details>
      )}
    </section>
  );
}
