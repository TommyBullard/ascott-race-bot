/**
 * MlShadowComparisonPanel — a READ-ONLY, SHADOW-ONLY comparison card.
 *
 * Shows, side by side for one race: the REGULAR model pick (runner, odds, EV,
 * confidence, stake), the candidate ML SHADOW pick (runner, ML win-probability,
 * ML rank), and the MARKET favourite (runner, odds, implied probability), plus
 * an agreement badge and small-sample / data-mismatch warnings.
 *
 * Hard properties:
 *   - The ML output is RESEARCH ONLY and NOT model-active. It never changes the
 *     production probability, EV, staking, confidence, the no-bet gate, or any
 *     recommendation, and it never hides the regular pick. The three standard
 *     labels ("not model-active", "Research only", "Does not affect staking or
 *     recommendations") are always shown.
 *   - Purely presentational: no data fetching, no write controls, no bet path.
 *   - The agreement badge is computed from the THREE DISPLAYED runner names via
 *     the shared pure {@link buildMlAgreement}, so it always matches the card.
 */

import type { CSSProperties } from 'react';
import { buildMlAgreement, ML_SHADOW_LABELS } from '@/lib/mlAgreement';

/** The regular production pick view (live card data). */
export interface RegularPickView {
  name: string | null;
  odds: number | null;
  ev: number | null;
  confidence: number | null;
  stake: number | null;
}

/** The market favourite view (live card data). */
export interface MarketFavouriteView {
  name: string | null;
  odds: number | null;
  impliedProb: number | null;
}

/** The ML shadow pick + warnings (from the read-only shadow endpoint). */
export interface MlShadowView {
  runner_name: string | null;
  ml_prob: number | null;
  ml_rank: number | null;
  smallSample: boolean;
  smallSampleText: string | null;
  dataDiffers: boolean;
  dataDiffersText: string | null;
}

interface Props {
  regular: RegularPickView | null;
  marketFav: MarketFavouriteView | null;
  ml: MlShadowView | null;
  style?: CSSProperties;
}

const DASH = '\u2014';

function pct(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : DASH;
}
function odds(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : DASH;
}
function num(v: number | null | undefined, dp = 2): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(dp) : DASH;
}

const styles = {
  panel: { borderTop: '1px dashed #d0d7de', marginTop: 12, paddingTop: 12 } as CSSProperties,
  heading: { fontSize: 13, fontWeight: 700, color: '#1f2328', margin: '0 0 2px' } as CSSProperties,
  labels: { fontSize: 11, fontStyle: 'italic', color: '#8250df', margin: '0 0 8px' } as CSSProperties,
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 } as CSSProperties,
  col: { border: '1px solid #eaeef2', borderRadius: 8, padding: '8px 10px', minWidth: 0 } as CSSProperties,
  mlCol: { border: '1px solid #e4d4f4', borderRadius: 8, padding: '8px 10px', background: '#faf5ff', minWidth: 0 } as CSSProperties,
  colTitle: { fontSize: 10, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: '#656d76', marginBottom: 4 } as CSSProperties,
  runner: { fontSize: 13, fontWeight: 700, color: '#1f2328', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
  meta: { fontSize: 11, color: '#656d76', marginTop: 2 } as CSSProperties,
  shadowChip: { display: 'inline-block', fontSize: 9, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: '#8250df', background: '#f3e8ff', border: '1px solid #e4d4f4', borderRadius: 999, padding: '0 6px', marginTop: 4 } as CSSProperties,
  badge: { display: 'inline-block', fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '2px 9px', marginTop: 8 } as CSSProperties,
  warn: { fontSize: 11, color: '#9a6700', background: '#fff8c5', border: '1px solid #eac54f', borderRadius: 6, padding: '3px 7px', marginTop: 6 } as CSSProperties,
  empty: { fontSize: 12, color: '#656d76', marginTop: 6 } as CSSProperties,
  disclaimer: { fontSize: 11, fontStyle: 'italic', color: '#656d76', marginTop: 8 } as CSSProperties,
};

function badgeStyle(badge: string): CSSProperties {
  if (badge === 'all_agree') return { ...styles.badge, color: '#1a7f37', background: '#dafbe1', border: '1px solid #aceebb' };
  if (badge === 'ml_differs_from_both') return { ...styles.badge, color: '#9a6700', background: '#fff8c5', border: '1px solid #eac54f' };
  if (badge === 'unknown') return { ...styles.badge, color: '#656d76', background: '#f6f8fa', border: '1px solid #d0d7de' };
  return { ...styles.badge, color: '#0550ae', background: '#ddf4ff', border: '1px solid #b6e3ff' };
}

/** Read-only side-by-side comparison of regular / ML shadow / market picks. */
export default function MlShadowComparisonPanel({ regular, marketFav, ml, style }: Props) {
  const mlName = ml?.runner_name ?? null;
  const agreement = buildMlAgreement(regular?.name ?? null, marketFav?.name ?? null, mlName);

  return (
    <section style={{ ...styles.panel, ...style }}>
      <h4 style={styles.heading}>ML shadow comparison</h4>
      <p style={styles.labels}>
        {ML_SHADOW_LABELS.notModelActive} · {ML_SHADOW_LABELS.researchOnly} · {ML_SHADOW_LABELS.noEffect}
      </p>

      <div style={styles.grid}>
        <div style={styles.col}>
          <div style={styles.colTitle}>Regular model pick</div>
          <div style={styles.runner}>{regular?.name ?? DASH}</div>
          <div style={styles.meta}>odds {odds(regular?.odds)} · EV {num(regular?.ev)}</div>
          <div style={styles.meta}>conf {pct(regular?.confidence)} · stake {num(regular?.stake)}</div>
        </div>

        <div style={styles.mlCol}>
          <div style={styles.colTitle}>ML shadow pick</div>
          {ml && mlName ? (
            <>
              <div style={styles.runner}>{mlName}</div>
              <div style={styles.meta}>ML prob {pct(ml.ml_prob)} · ML rank {ml.ml_rank ?? DASH}</div>
              <span style={styles.shadowChip}>not model-active</span>
            </>
          ) : (
            <div style={styles.empty}>
              Not available — run <code>npm run ml:predict-shadow</code>.
            </div>
          )}
        </div>

        <div style={styles.col}>
          <div style={styles.colTitle}>Market favourite</div>
          <div style={styles.runner}>{marketFav?.name ?? DASH}</div>
          <div style={styles.meta}>odds {odds(marketFav?.odds)}</div>
          <div style={styles.meta}>implied {pct(marketFav?.impliedProb)}</div>
        </div>
      </div>

      <span style={badgeStyle(agreement.badge)}>{agreement.badge_label}</span>

      {ml?.smallSample && ml.smallSampleText && <div style={styles.warn}>⚠ {ml.smallSampleText}</div>}
      {ml?.dataDiffers && ml.dataDiffersText && <div style={styles.warn}>⚠ {ml.dataDiffersText}</div>}

      <p style={styles.disclaimer}>
        The ML shadow pick is a candidate model shown for research only. The regular model pick remains
        the only recommendation; staking, EV, confidence, and the no-bet gate are unchanged. No bet is
        placed or suggested.
      </p>
    </section>
  );
}
