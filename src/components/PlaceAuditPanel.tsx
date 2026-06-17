/**
 * PlaceAuditPanel — a READ-ONLY, research-only "Place / each-way audit" summary
 * for a settled race day.
 *
 * Purely presentational. It renders the compact view built by
 * {@link buildPlaceAuditView}: the SIMULATED place marker (e.g. "Research top-4
 * marker"), the model pick / alternatives / market favourite placed + won
 * counts, the "lost but placed" and "alternative placed / won" race counts, and
 * the always-shown research disclaimers. NO data fetching, NO API calls, NO
 * backend coupling, NO write controls, NO payout maths.
 *
 * Decision-support only: it never changes the recommendation, never implies real
 * bookmaker each-way terms, never calculates a payout or profit/loss, and shows
 * "—" for values that are not yet known (e.g. before any race is settled).
 */

import type { CSSProperties } from 'react';
import type { PlaceAuditView } from '@/lib/placeAuditView';

export interface PlaceAuditPanelProps {
  view: PlaceAuditView;
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
    marginBottom: 16,
  } as CSSProperties,
  heading: {
    margin: '0 0 4px',
    fontSize: 16,
    fontWeight: 700,
  } as CSSProperties,
  markerRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
    fontSize: 13,
    color: '#424a53',
  } as CSSProperties,
  markerBadge: {
    display: 'inline-block',
    padding: '1px 8px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    background: '#ddf4ff',
    border: '1px solid #b6e3ff',
    color: '#0550ae',
  } as CSSProperties,
  pending: {
    fontSize: 13,
    color: '#9a6700',
    background: '#fff8c5',
    border: '1px solid #eac54f',
    borderRadius: 8,
    padding: '6px 10px',
    marginBottom: 12,
  } as CSSProperties,
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: 10,
    marginBottom: 12,
  } as CSSProperties,
  cell: {
    border: '1px solid #eaeef2',
    borderRadius: 8,
    padding: '8px 10px',
    background: '#f6f8fa',
  } as CSSProperties,
  cellLabel: {
    fontSize: 11,
    color: '#656d76',
    marginBottom: 2,
  } as CSSProperties,
  cellValue: {
    fontSize: 18,
    fontWeight: 700,
  } as CSSProperties,
  disclaimers: {
    margin: 0,
    paddingLeft: 18,
    fontSize: 11.5,
    color: '#656d76',
    lineHeight: 1.5,
  } as CSSProperties,
} as const;

export default function PlaceAuditPanel({ view, style }: PlaceAuditPanelProps) {
  // Nothing to research without any races on the day.
  if (view.raceCount === 0) return null;

  const s = view.summary;
  const settled = view.hasSettledRaces;
  // Counts are only meaningful once at least one race is settled; otherwise the
  // value is not yet known and renders as the em dash (research-only).
  const val = (n: number): string => (settled ? String(n) : DASH);

  const cells: Array<{ label: string; value: string }> = [
    { label: 'Model pick placed', value: val(s.modelPickPlaced) },
    { label: 'Model pick won', value: val(s.modelPickWon) },
    { label: 'Model pick lost but placed', value: val(s.modelPickLostButPlaced) },
    { label: 'Alternatives placed', value: val(s.alternativesPlaced) },
    { label: 'Alternatives won', value: val(s.alternativesWon) },
    { label: 'Races where an alternative placed', value: val(s.racesWhereAlternativePlaced) },
    { label: 'Races where an alternative won', value: val(s.racesWhereAlternativeWon) },
    { label: 'Market favourite placed', value: val(s.favouritePlaced) },
    { label: 'Market favourite won', value: val(s.favouriteWon) },
  ];

  return (
    <section style={style ? { ...styles.panel, ...style } : styles.panel} aria-label="Place / each-way audit (research)">
      <h2 style={styles.heading}>Place / each-way audit (research)</h2>

      <div style={styles.markerRow}>
        <span style={styles.markerBadge}>{view.placeMarkerLabel}</span>
        <span>
          Races: {view.raceCount} · Settled: {settled ? view.settledRaceCount : DASH}
        </span>
      </div>

      {!settled && (
        <div style={styles.pending}>
          No settled races yet — placed / won counts appear once results are recorded.
        </div>
      )}

      <div style={styles.grid}>
        {cells.map((cell) => (
          <div key={cell.label} style={styles.cell}>
            <div style={styles.cellLabel}>{cell.label}</div>
            <div style={styles.cellValue}>{cell.value}</div>
          </div>
        ))}
      </div>

      <ul style={styles.disclaimers}>
        {view.warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </section>
  );
}
