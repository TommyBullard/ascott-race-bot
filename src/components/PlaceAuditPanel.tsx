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
 *
 * SLICE 3D — TOP-LEVEL PANELS, PART 2. Like its sibling proof panel, this one
 * owned TWO fixed-light surfaces: a `#fff` root and a `#f6f8fa` fill behind
 * every metric cell. Both move to tokens here, together with every descendant
 * foreground, in ONE change — an inner surface left behind by an outer one is
 * exactly the dark-on-dark defect this programme exists to prevent.
 *
 * The cell fill takes `--rb-surface-inset` and its edge takes `--rb-border`,
 * so each cell still reads as a recessed tile. The big cell VALUE inherits the
 * root's token foreground and is therefore measured against the INSET surface
 * (13.91:1 light / 16.58:1 dark), while its label takes muted text there
 * (4.78 / 6.35) — the tightest pair in this tranche, pinned by name in 24b.
 *
 * The marker badge and the pending notice are SELF-CONTAINED (each declares
 * its own fill AND its own text) and are retained exactly as they are.
 *
 * Colour only: the research-only boundary, heading, wording, disclaimers,
 * settled/pending logic, em-dash rendering and the empty-day condition are all
 * unchanged.
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
  /*
   * GEOMETRY ONLY — surface, border, radius and foreground all arrive together
   * from `rb-evidence-panel`. `borderRadius: 10` is dropped rather than kept
   * because `--rb-radius-card` is 10px, so the class reproduces it exactly.
   * Padding, font family and the bottom margin stay, and the caller's `style`
   * prop still merges over them exactly as before.
   */
  panel: {
    padding: 16,
    fontFamily: 'system-ui, -apple-system, sans-serif',
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
    color: 'var(--rb-text-secondary)',
  } as CSSProperties,
  /* Self-contained and retained verbatim: 6.68:1 on its own fill. */
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
  /*
   * Self-contained and retained verbatim: 4.52:1 on its own fill. It declares
   * BOTH halves, so the surface behind it cannot reach it and it needs no
   * token pairing — the pending treatment is unchanged in every respect.
   */
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
  /*
   * THE SECOND SURFACE, MIGRATED WITH THE FIRST.
   *
   * `#f6f8fa` is a fixed near-white tile and `#eaeef2` its fixed near-white
   * edge. Left behind on a token root they would stay bright in the dark
   * scheme and hold the inherited light cell value at 1.06:1 — worse than not
   * migrating the root at all. The fill takes the recessed token and the edge
   * takes the hairline token, so the tile follows the surface it sits on. Its
   * own `borderRadius` is kept: that is the tile's shape, not a duplicate of
   * the root radius the class now owns.
   */
  cell: {
    border: '1px solid var(--rb-border)',
    borderRadius: 8,
    padding: '8px 10px',
    background: 'var(--rb-surface-inset)',
  } as CSSProperties,
  /* On the inset tile, not the raised panel: 4.78:1 light / 6.35:1 dark. */
  cellLabel: {
    fontSize: 11,
    color: 'var(--rb-text-muted)',
    marginBottom: 2,
  } as CSSProperties,
  cellValue: {
    fontSize: 18,
    fontWeight: 700,
  } as CSSProperties,
  /* On the RAISED panel surface, not the inset tiles: 5.45:1 / 5.60:1. */
  disclaimers: {
    margin: 0,
    paddingLeft: 18,
    fontSize: 11.5,
    color: 'var(--rb-text-muted)',
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
    <section
      className="rb-evidence-panel"
      style={style ? { ...styles.panel, ...style } : styles.panel}
      aria-label="Place / each-way audit (research)"
    >
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
