/**
 * ProofOfUpdatePanel — a READ-ONLY "Proof of Update" panel for the race-day
 * dashboard.
 *
 * Purely presentational. It renders the at-a-glance proof built by
 * {@link buildProofPanelView}: whether racecards loaded, race + runner counts,
 * odds / model freshness, T-minus capture, results status (+ source / blocked
 * reason), training capture, GenAI commentary status, and the durable proof
 * report path. NO data fetching, NO API calls, NO write controls, NO commit
 * buttons, NO bet placement, NO payout maths.
 *
 * Read-only audit only: it changes no recommendation/model/staking value,
 * exposes no secret, renders "unknown" / "not available" for missing data
 * (never implying success), and is never betting advice.
 *
 * SLICE 3D — TOP-LEVEL PANELS, PART 2. This panel owned TWO fixed-light
 * surfaces: a `#fff` root and a `#f6f8fa` fill behind every proof row. Both
 * move to tokens here, together with every descendant foreground, in ONE
 * change — a surface migrated without its foregrounds, or an inner surface
 * left behind by an outer one, is exactly the dark-on-dark defect this
 * programme exists to prevent.
 *
 * The row fill takes `--rb-surface-inset`, the recessed token, so the rows
 * still read as wells inside the panel. Everything printed on them is
 * therefore measured against the INSET surface rather than the raised one.
 *
 * Colour only: no wording, value, row ordering, heading, aria-label, effect,
 * state or read-only behaviour changed here.
 */

import type { CSSProperties } from 'react';
import type { ProofPanelView, ProofTone } from '@/lib/proofPanel';

export interface ProofOfUpdatePanelProps {
  view: ProofPanelView;
  /** Optional style override merged over the panel container (e.g. when nested). */
  style?: CSSProperties;
}

/*
 * BARE TEXT ON THE INSET ROW — DELIBERATELY NOT A CHIP PALETTE.
 *
 * Each tone is a FOREGROUND ONLY; the row behind it supplies the fill. So all
 * three must be dark-aware tokens, and all three are measured against
 * `--rb-surface-inset`: positive 5.23:1 light / 8.18:1 dark, warning 5.28 /
 * 8.35, muted 4.78 / 6.35. The muted-on-inset pair is the tightest in this
 * tranche — it clears AA with the least headroom of any role here, so test 24b
 * pins it by name rather than letting it ride on a general sweep.
 *
 * These are NOT converted into self-contained foreground/background pairs. The
 * proof grid is a table of evidence read down a column, not a row of pills;
 * giving each tone its own fill would change what the panel is. `neutral` maps
 * to muted text rather than to a status colour because it is the explicit
 * "no signal" tone — the same reason `.rb-ev--neutral` takes a text tier.
 *
 * Key order is part of the contract and is pinned by name in test 24.
 */
const TONE_COLOR: Record<ProofTone, string> = {
  ok: 'var(--rb-status-positive)',
  warn: 'var(--rb-status-warning)',
  neutral: 'var(--rb-text-muted)',
};

const styles = {
  /*
   * GEOMETRY ONLY.
   *
   * Surface, border, radius and foreground now arrive TOGETHER from
   * `rb-evidence-panel`. Declaring any of them here would either fight the
   * class or strand one half of the pair on it. `borderRadius: 10` is dropped
   * rather than kept because `--rb-radius-card` is 10px, so the class
   * reproduces it exactly. Padding, font family and the bottom margin stay:
   * they are structural, and the caller's `style` prop still merges over them.
   */
  panel: {
    padding: 16,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    marginBottom: 16,
  } as CSSProperties,
  heading: {
    margin: '0 0 10px',
    fontSize: 16,
    fontWeight: 700,
  } as CSSProperties,
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: 8,
    marginBottom: 12,
  } as CSSProperties,
  /*
   * THE SECOND SURFACE, MIGRATED WITH THE FIRST.
   *
   * `#f6f8fa` is a fixed near-white well. Left behind on a token root it would
   * stay bright in the dark scheme and hold the panel's inherited light text at
   * 1.06:1 — a worse outcome than not migrating the root at all. It takes
   * `--rb-surface-inset`, the recessed token, which is what a well means in
   * this design system. Its own `borderRadius` is kept: that is the row's
   * shape, not a duplicate of the root radius the class now owns.
   */
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 10,
    padding: '6px 10px',
    borderRadius: 8,
    background: 'var(--rb-surface-inset)',
    fontSize: 13,
  } as CSSProperties,
  /* On the inset row: secondary text at 7.38:1 light / 10.44:1 dark. */
  label: {
    color: 'var(--rb-text-secondary)',
    fontWeight: 600,
  } as CSSProperties,
  value: {
    textAlign: 'right' as const,
    overflowWrap: 'anywhere' as const,
    fontVariantNumeric: 'tabular-nums',
  } as CSSProperties,
  /* On the RAISED panel surface, not the inset rows: 5.45:1 light / 5.60:1 dark. */
  disclaimer: {
    margin: 0,
    fontSize: 12,
    color: 'var(--rb-text-muted)',
    lineHeight: 1.5,
  } as CSSProperties,
} satisfies Record<string, CSSProperties>;

/**
 * Renders the proof-of-update view. Presentational only — no buttons, inputs,
 * forms, fetches, or write controls of any kind.
 */
export default function ProofOfUpdatePanel({ view, style }: ProofOfUpdatePanelProps) {
  return (
    <section
      className="rb-evidence-panel"
      style={{ ...styles.panel, ...style }}
      aria-label="Proof of update (read-only)"
    >
      <h2 style={styles.heading}>{view.title}</h2>
      <div style={styles.grid}>
        {view.rows.map((r) => (
          <div key={r.label} style={styles.row}>
            <span style={styles.label}>{r.label}</span>
            <span style={{ ...styles.value, color: TONE_COLOR[r.tone] }}>{r.value}</span>
          </div>
        ))}
      </div>
      {view.disclaimers.map((d) => (
        <p key={d} style={styles.disclaimer}>
          {d}
        </p>
      ))}
    </section>
  );
}
