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
 *
 * SLICE 3D — TOP-LEVEL PANELS, PART 1. This panel used to own a hard-coded
 * `#fff` surface with hard-coded dark text: an opaque white island once the
 * shell went dark. The root now takes the paired `rb-evidence-panel` class and
 * every descendant foreground moved to a dark-aware token IN THE SAME CHANGE,
 * because a surface moved without its foregrounds is precisely the
 * dark-on-dark defect this programme exists to prevent. The badge chips are
 * self-contained (their own fill AND text) and are retained as they are.
 *
 * Colour only: no layout, wording, aria-label, endpoint, effect, state or
 * classification changed here.
 */

import type { CSSProperties } from 'react';
import type { CommandBadge, CommandCentreView } from '@/lib/commandCentre';

export interface CommandCentrePanelProps {
  view: CommandCentreView;
}

/*
 * SELF-CONTAINED, AND DELIBERATELY RETAINED.
 *
 * Each entry declares BOTH a foreground and a fill, so the surface behind it
 * cannot affect it and it needs no token pairing: GREEN 4.56:1, AMBER 4.52:1,
 * RED 4.67:1 on their own fills. This is the same treatment the nested
 * race-card panels' chips already carry. The badge is never the only signal —
 * `label` supplies the word, and `badgeReasons` the plain-language explanation.
 */
const BADGE_PALETTE: Record<CommandBadge, { color: string; bg: string; border: string; label: string }> = {
  green: { color: '#1a7f37', bg: '#dafbe1', border: '#aceebb', label: 'GREEN' },
  amber: { color: '#9a6700', bg: '#fff8c5', border: '#eed888', label: 'AMBER' },
  red: { color: '#cf222e', bg: '#ffebe9', border: '#ffcecb', label: 'RED' },
};

const styles = {
  /*
   * GEOMETRY ONLY.
   *
   * Surface, border, radius and foreground now arrive TOGETHER from
   * `rb-evidence-panel`. Declaring any of them here would either fight the class
   * or strand one half of the pair on it — the exact failure this migration
   * exists to prevent. `borderRadius: 10` is dropped rather than kept because
   * `--rb-radius-card` is 10px, so the class reproduces it exactly.
   */
  panel: {
    padding: '10px 14px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    margin: '12px 0 4px',
  } as CSSProperties,
  headRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap' as const,
  } as CSSProperties,
  /*
   * The panel's own label takes the SECONDARY tier, matching the tipster
   * panels' titles. Its legacy `#57606a` sat between the two token tiers; the
   * title is the one role here that reads as structure rather than supporting
   * copy, so it takes the stronger of the two.
   */
  title: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    color: 'var(--rb-text-secondary)',
  } as CSSProperties,
  reasons: {
    fontSize: 11.5,
    color: 'var(--rb-text-muted)',
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
  /*
   * `#8c959f` IS NOT CARRIED OVER, AND WAS ALREADY A DEFECT.
   *
   * At 10px it is normal text, so the 4.5:1 floor applies — and it measured
   * only 3.04:1 on the white surface this panel used to own. It was failing in
   * the LIGHT scheme, today, before any of this migration. It folds into
   * `--rb-text-muted` (5.45:1 light / 5.60:1 dark on the new surface), the same
   * resolution evidence part 2b-ii applied to the identical literal in
   * RaceIntelligencePanel.
   */
  rowLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    color: 'var(--rb-text-muted)',
    width: 52,
    flexShrink: 0,
  } as CSSProperties,
  stat: { whiteSpace: 'nowrap' as const } as CSSProperties,
  statLabel: { color: 'var(--rb-text-muted)', marginRight: 4 } as CSSProperties,
  /*
   * The three tone values are BARE TEXT on the panel surface — they carry no
   * background of their own, unlike the badge chips below — so they must move
   * to dark-aware tokens with the surface. Weights are unchanged.
   */
  warn: { color: 'var(--rb-status-warning)', fontWeight: 700 } as CSSProperties,
  bad: { color: 'var(--rb-status-failure)', fontWeight: 700 } as CSSProperties,
  ok: { color: 'var(--rb-status-positive)', fontWeight: 600 } as CSSProperties,
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
    <section className="rb-evidence-panel" style={styles.panel} aria-label="Race-day command centre">
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
