/**
 * RaceIntelligencePanel — a compact, READ-ONLY / SHADOW comparison panel.
 *
 * Purely presentational. It renders the display-only candidates derived by
 * {@link buildRaceIntelligence} (most likely winner, win-value candidate,
 * each-way / place-value shadow candidate, market favourite) so the operator can
 * eyeball how they relate to the unchanged model pick. NO data fetching, NO API
 * calls, NO backend coupling, NO write controls. It never changes the
 * recommendation and never implies a bet, place terms, or a payout — the
 * each-way line is a display-only interpretation and this is not betting advice.
 *
 * Missing candidates render as "unknown" / "—" / "Not enough data". For settled
 * races it shows each candidate's finishing position when known. Uses the
 * project's inline-style conventions (system-ui, neutral GitHub-style palette)
 * and no external libraries.
 */

import type { CSSProperties } from 'react';
import {
  EACH_WAY_DISCLAIMER,
  formatFinishPosition,
  type IntelCandidate,
  type RaceIntelligence,
} from '@/lib/raceIntelligence';

export interface RaceIntelligencePanelProps {
  intel: RaceIntelligence;
  /** True once the race is resulted, so finishing positions are shown. */
  settled?: boolean;
  /** Optional style override merged over the panel container (e.g. when nested). */
  style?: CSSProperties;
}

const DASH = '\u2014';

const styles = {
  panel: {
    border: '1px solid #d0d7de',
    borderRadius: 10,
    padding: 16,
    background: '#fff',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#1f2328',
  } as CSSProperties,
  title: {
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    color: '#424a53',
    margin: '0 0 10px',
  } as CSSProperties,
  row: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 8,
    alignItems: 'baseline',
    marginBottom: 8,
  } as CSSProperties,
  label: {
    fontSize: 12,
    fontWeight: 700,
    color: '#656d76',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.4,
    minWidth: 140,
  } as CSSProperties,
  value: {
    fontSize: 14,
    color: '#1f2328',
    fontWeight: 600,
  } as CSSProperties,
  odds: {
    fontSize: 13,
    color: '#656d76',
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  basis: {
    fontSize: 12,
    color: '#8c959f',
    flexBasis: '100%',
  } as CSSProperties,
  empty: {
    fontSize: 14,
    color: '#656d76',
  } as CSSProperties,
  badge: {
    display: 'inline-block',
    padding: '1px 8px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    background: '#f6f8fa',
    border: '1px solid #d0d7de',
    color: '#424a53',
  } as CSSProperties,
  pickBadge: {
    display: 'inline-block',
    padding: '1px 8px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    background: '#dafbe1',
    border: '1px solid #aceebb',
    color: '#1a7f37',
  } as CSSProperties,
  finishBadge: {
    display: 'inline-block',
    padding: '1px 8px',
    fontSize: 12,
    fontWeight: 700,
    borderRadius: 999,
    background: '#ddf4ff',
    border: '1px solid #b6e3ff',
    color: '#0969da',
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  warnList: {
    margin: '10px 0 0',
    paddingLeft: 18,
    color: '#9a6700',
    fontSize: 13,
  } as CSSProperties,
  disclaimer: {
    margin: '10px 0 0',
    fontSize: 11.5,
    lineHeight: 1.5,
    color: '#656d76',
  } as CSSProperties,
} as const;

/** Formats decimal odds for display, or a dash when unknown. */
function formatOdds(odds: number | null): string {
  return typeof odds === 'number' && Number.isFinite(odds)
    ? odds.toFixed(2)
    : DASH;
}

/** One labelled candidate row (or its empty state). */
function CandidateRow({
  label,
  candidate,
  emptyText,
  settled,
}: {
  label: string;
  candidate: IntelCandidate | null;
  emptyText: string;
  settled: boolean;
}) {
  return (
    <div style={styles.row}>
      <span style={styles.label}>{label}</span>
      {candidate ? (
        <>
          <span style={styles.value}>{candidate.horse_name}</span>
          <span style={styles.odds}>{formatOdds(candidate.odds)}</span>
          {settled && (
            <span style={styles.finishBadge}>
              {formatFinishPosition(candidate.finish_pos)}
            </span>
          )}
          <span style={candidate.isModelPick ? styles.pickBadge : styles.badge}>
            {candidate.isModelPick ? '= model pick' : 'differs from model pick'}
          </span>
          <span style={styles.basis}>{candidate.basis}</span>
        </>
      ) : (
        <span style={styles.empty}>{emptyText}</span>
      )}
    </div>
  );
}

export default function RaceIntelligencePanel({
  intel,
  settled = false,
  style,
}: RaceIntelligencePanelProps) {
  return (
    <div style={style ? { ...styles.panel, ...style } : styles.panel}>
      <div style={styles.title}>Race Intelligence</div>

      <CandidateRow
        label="Most likely winner"
        candidate={intel.mostLikelyWinner}
        emptyText="unknown"
        settled={settled}
      />
      <CandidateRow
        label="Win-value candidate"
        candidate={intel.winValueCandidate}
        emptyText={DASH}
        settled={settled}
      />
      <CandidateRow
        label="Each-way / value candidate"
        candidate={intel.eachWayCandidate}
        emptyText="Not enough data"
        settled={settled}
      />
      <CandidateRow
        label="Market favourite"
        candidate={intel.marketFavourite}
        emptyText={DASH}
        settled={settled}
      />

      {intel.warnings.length > 0 && (
        <ul style={styles.warnList}>
          {intel.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <p style={styles.disclaimer}>{EACH_WAY_DISCLAIMER}</p>
    </div>
  );
}
