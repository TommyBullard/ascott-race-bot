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
 */

import type { CSSProperties } from 'react';
import type { ProofPanelView, ProofTone } from '@/lib/proofPanel';

export interface ProofOfUpdatePanelProps {
  view: ProofPanelView;
  /** Optional style override merged over the panel container (e.g. when nested). */
  style?: CSSProperties;
}

const TONE_COLOR: Record<ProofTone, string> = {
  ok: '#1a7f37',
  warn: '#9a6700',
  neutral: '#57606a',
};

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
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 10,
    padding: '6px 10px',
    borderRadius: 8,
    background: '#f6f8fa',
    fontSize: 13,
  } as CSSProperties,
  label: {
    color: '#424a53',
    fontWeight: 600,
  } as CSSProperties,
  value: {
    textAlign: 'right' as const,
    overflowWrap: 'anywhere' as const,
    fontVariantNumeric: 'tabular-nums',
  } as CSSProperties,
  disclaimer: {
    margin: 0,
    fontSize: 12,
    color: '#57606a',
    lineHeight: 1.5,
  } as CSSProperties,
} satisfies Record<string, CSSProperties>;

/**
 * Renders the proof-of-update view. Presentational only — no buttons, inputs,
 * forms, fetches, or write controls of any kind.
 */
export default function ProofOfUpdatePanel({ view, style }: ProofOfUpdatePanelProps) {
  return (
    <section style={{ ...styles.panel, ...style }} aria-label="Proof of update (read-only)">
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
