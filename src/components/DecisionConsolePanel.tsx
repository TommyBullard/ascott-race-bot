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
 *
 * SLICE 3D — TOP-LEVEL PANELS, PART 1. The root now takes the paired
 * `rb-evidence-panel` class, and every descendant foreground moved to a
 * dark-aware token in the same change. The priority chips stay self-contained.
 *
 * The one subtle case is the COUNTS ROW, which used to reuse each chip's
 * foreground as bare text on the panel surface — a chip colour with no fill
 * behind it. Those four now come from `CONSOLE_COUNT_COLOR`, a separate map,
 * so a chip pair and a bare-text role can never again be mistaken for the same
 * thing. Colour only: no layout, wording, aria-label, ordering, priority
 * derivation or read-only behaviour changed here.
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

/*
 * THE CHIP PAIRS — SELF-CONTAINED, AND DELIBERATELY RETAINED.
 *
 * Every entry declares BOTH a foreground and a fill, so the surface behind it
 * cannot affect it: NEXT ACTION 6.68:1, WARNING 4.67:1, MONITOR 4.52:1,
 * GOOD 4.56:1 on their own fills. These values are for the CHIP ONLY. Nothing
 * outside a filled pill may read them — see `CONSOLE_COUNT_COLOR`.
 */
const CHIP_PALETTE: Record<ConsolePriority, { color: string; bg: string; border: string }> = {
  next_action: { color: '#0550ae', bg: '#ddf4ff', border: '#b6e3ff' },
  warning: { color: '#cf222e', bg: '#ffebe9', border: '#ffcecb' },
  monitor: { color: '#9a6700', bg: '#fff8c5', border: '#eed888' },
  good: { color: '#1a7f37', bg: '#dafbe1', border: '#aceebb' },
};

/*
 * THE SAME FOUR PRIORITIES AS BARE TEXT, ON THE PANEL SURFACE.
 *
 * The counts row summarises the priorities in words on the panel itself, with
 * no fill behind it. It previously reused `CHIP_PALETTE[p].color`, which is
 * only safe on that chip's own fill: on the token panel those literals land at
 * 2.18 / 3.09 / 3.40 / 3.26:1 in the dark scheme. A SEPARATE map keeps the two
 * roles apart by construction rather than by discipline, so migrating one can
 * never silently leave the other behind.
 *
 * The semantics are unchanged — analytical blue for the next action, failure
 * for a warning, warning for monitoring, positive for good.
 */
const CONSOLE_COUNT_COLOR: Record<ConsolePriority, string> = {
  next_action: 'var(--rb-accent-analytical)',
  warning: 'var(--rb-status-failure)',
  monitor: 'var(--rb-status-warning)',
  good: 'var(--rb-status-positive)',
};

const styles = {
  /*
   * GEOMETRY ONLY — surface, border, radius and foreground all arrive together
   * from `rb-evidence-panel`. `borderRadius: 10` is dropped rather than kept
   * because `--rb-radius-card` is 10px, so the class reproduces it exactly.
   */
  panel: {
    padding: '10px 14px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    margin: '12px 0 4px',
  } as CSSProperties,
  headRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    flexWrap: 'wrap' as const,
  } as CSSProperties,
  /* Secondary tier, matching the Command Centre's title and the tipster panels'. */
  title: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    color: 'var(--rb-text-secondary)',
  } as CSSProperties,
  /*
   * A fallback tier only: all four children set their own semantic colour from
   * `CONSOLE_COUNT_COLOR`. It is kept — rather than dropped as dead — so that a
   * future unclassed child inherits a readable token instead of nothing.
   */
  counts: {
    fontSize: 11.5,
    color: 'var(--rb-text-muted)',
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
    /*
     * The separator follows the surface. A fixed near-white hairline on a dark
     * token panel reads as a bright seam. It is DECORATIVE — no 3:1 non-text
     * floor is claimed for it, and none is needed: the rows are also separated
     * by spacing and by their own leading chip.
     */
    borderTop: '1px dashed var(--rb-border)',
  } as CSSProperties,
  raceName: { fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' as const } as CSSProperties,
  reason: { color: 'var(--rb-text-muted)', overflowWrap: 'anywhere' as const } as CSSProperties,
  countdown: {
    color: 'var(--rb-accent-analytical)',
    fontVariantNumeric: 'tabular-nums' as const,
    whiteSpace: 'nowrap' as const,
  } as CSSProperties,
  moreSummary: {
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.5,
    color: 'var(--rb-text-muted)',
    textTransform: 'uppercase' as const,
    padding: '6px 0 2px',
  } as CSSProperties,
  empty: { fontSize: 13, color: 'var(--rb-text-muted)', marginTop: 6 } as CSSProperties,
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
    <section className="rb-evidence-panel" style={styles.panel} aria-label="Race-day decision console">
      <div style={styles.headRow}>
        <span style={styles.title}>Decision Console</span>
        <span style={styles.counts}>
          <span style={{ color: CONSOLE_COUNT_COLOR.next_action }}>
            NEXT ACTION: {counts.next_action}
          </span>
          <span style={{ color: CONSOLE_COUNT_COLOR.warning }}>WARNING: {counts.warning}</span>
          <span style={{ color: CONSOLE_COUNT_COLOR.monitor }}>MONITOR: {counts.monitor}</span>
          <span style={{ color: CONSOLE_COUNT_COLOR.good }}>GOOD: {counts.good}</span>
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
