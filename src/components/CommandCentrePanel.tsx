/**
 * CommandCentrePanel — the READ-ONLY Race-Day Command Centre.
 *
 * Purely presentational: renders the {@link buildCommandCentre} view — one
 * GREEN / AMBER / RED health badge with its plain-language reasons, plus three
 * compact rows (System Health · Lock Operations · Results Operations) — over
 * data the dashboard has ALREADY loaded. NO data fetching, NO API calls, NO
 * write controls, NO commit buttons, NO bet placement, NO payout maths.
 *
 * Mobile-first: one small card, three wrapping rows, designed to be fully
 * visible without scrolling on a phone. "Platform feed" reports the read
 * API's reachability only — never a direct database probe. Decision-support
 * only; never betting advice.
 */

import type { CSSProperties } from 'react';
import type { CommandBadge, CommandCentreView } from '@/lib/commandCentre';

export interface CommandCentrePanelProps {
  view: CommandCentreView;
}

const BADGE_PALETTE: Record<CommandBadge, { color: string; bg: string; border: string; label: string }> = {
  green: { color: '#1a7f37', bg: '#dafbe1', border: '#aceebb', label: 'GREEN' },
  amber: { color: '#9a6700', bg: '#fff8c5', border: '#eed888', label: 'AMBER' },
  red: { color: '#cf222e', bg: '#ffebe9', border: '#ffcecb', label: 'RED' },
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
    alignItems: 'center',
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
  reasons: {
    fontSize: 11.5,
    color: '#57606a',
    lineHeight: 1.4,
    marginTop: 2,
    overflowWrap: 'anywhere' as const,
  } as CSSProperties,
  row: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    flexWrap: 'wrap' as const,
    fontSize: 12.5,
    lineHeight: 1.7,
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  rowLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    color: '#8c959f',
    width: 52,
    flexShrink: 0,
  } as CSSProperties,
  stat: { whiteSpace: 'nowrap' as const } as CSSProperties,
  statLabel: { color: '#656d76', marginRight: 4 } as CSSProperties,
  warn: { color: '#9a6700', fontWeight: 700 } as CSSProperties,
  bad: { color: '#cf222e', fontWeight: 700 } as CSSProperties,
  ok: { color: '#1a7f37', fontWeight: 600 } as CSSProperties,
};

function badgeChipStyle(badge: CommandBadge): CSSProperties {
  const p = BADGE_PALETTE[badge];
  return {
    display: 'inline-block',
    padding: '3px 12px',
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 800,
    letterSpacing: 0.5,
    color: p.color,
    background: p.bg,
    border: `1px solid ${p.border}`,
  };
}

const DASH = '—';

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const valueStyle = tone === 'bad' ? styles.bad : tone === 'warn' ? styles.warn : tone === 'ok' ? styles.ok : undefined;
  return (
    <span style={styles.stat}>
      <span style={styles.statLabel}>{label}</span>
      <span style={valueStyle}>{value}</span>
    </span>
  );
}

export default function CommandCentrePanel({ view }: CommandCentrePanelProps) {
  const { badge, badgeReasons, health, locks, results } = view;
  return (
    <section style={styles.panel} aria-label="Race-day command centre">
      <div style={styles.headRow}>
        <span style={styles.title}>Command Centre</span>
        <span style={badgeChipStyle(badge)}>{BADGE_PALETTE[badge].label}</span>
      </div>
      {badgeReasons.length > 0 && (
        <div style={styles.reasons}>{badgeReasons.join(' · ')}</div>
      )}
      <div style={styles.row}>
        <span style={styles.rowLabel}>Health</span>
        <Stat label="feed" value={health.platformFeed} tone={health.platformFeed === 'ok' ? 'ok' : 'bad'} />
        <Stat label="races" value={String(health.racecards)} />
        <Stat label="odds" value={health.oddsLabel} tone={health.oddsStale ? 'warn' : undefined} />
        <Stat label="model" value={health.modelLabel} tone={health.modelStale ? 'warn' : undefined} />
        <Stat label="results" value={health.resultsLabel ?? DASH} />
      </div>
      <div style={styles.row}>
        <span style={styles.rowLabel}>Locks</span>
        <Stat label="locked" value={`${locks.locked}/${locks.races}`} />
        <Stat label="not yet due" value={String(locks.notYetDue)} />
        <Stat label="MISSING" value={String(locks.lockMissing)} tone={locks.lockMissing > 0 ? 'bad' : 'ok'} />
        <Stat label="no-run" value={String(locks.noRunAvailable)} tone={locks.noRunAvailable > 0 ? 'bad' : undefined} />
        <Stat label="next lock" value={locks.nextLockDueLabel ?? DASH} />
      </div>
      <div style={styles.row}>
        <span style={styles.rowLabel}>Results</span>
        <Stat label="settled" value={String(results.settled)} />
        <Stat label="pending" value={String(results.pending)} tone={results.pending > 0 ? 'warn' : undefined} />
        <Stat label="last" value={results.lastResultLabel ?? DASH} />
      </div>
    </section>
  );
}
