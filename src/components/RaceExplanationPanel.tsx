/**
 * RaceExplanationPanel — a presentational placeholder for race-level model
 * explanations.
 *
 * Renders the already-persisted observability summaries (data-quality + tipster
 * consensus) for a race when they are supplied as props. It is purely
 * presentational: NO data fetching, NO API calls, NO backend coupling. Every
 * prop is optional — when nothing usable is provided it shows a clean empty
 * state, so it is safe to drop in ahead of the data being wired through.
 *
 * The summary fields it displays currently live in `model_runs.config_json`
 * (run_quality, data_quality_*summary, tipster_consensus_*summary,
 * tipster_model_alignment.alignment_label) and are NOT yet exposed by the
 * `/api/recommendations` race-card response. Wiring those through is a future,
 * additive API change; until then this component renders its empty state on the
 * live dashboard. Uses the project's inline-style conventions (system-ui,
 * neutral GitHub-style palette) and no external libraries.
 */

import type { CSSProperties } from 'react';

export interface RaceExplanationPanelProps {
  dataQualityShortSummary?: string | null;
  dataQualitySummary?: string[] | null;
  tipsterConsensusShortSummary?: string | null;
  tipsterConsensusSummary?: string[] | null;
  runQuality?: string | null;
  alignmentLabel?: string | null;
}

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
  empty: {
    fontSize: 14,
    color: '#656d76',
    margin: 0,
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
    minWidth: 120,
  } as CSSProperties,
  value: {
    fontSize: 14,
    color: '#1f2328',
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
  details: {
    marginTop: 8,
  } as CSSProperties,
  summaryToggle: {
    cursor: 'pointer',
    fontSize: 13,
    color: '#0969da',
  } as CSSProperties,
  list: {
    margin: '8px 0 0',
    paddingLeft: 18,
    color: '#424a53',
    fontSize: 14,
  } as CSSProperties,
} as const;

/** A non-empty string, else null. */
function clean(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** A non-empty array of non-empty strings, else null. */
function cleanList(value: string[] | null | undefined): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return items.length > 0 ? items : null;
}

/** One "label: value" row, rendered only when `value` is present. */
function Row({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <div style={styles.row}>
      <span style={styles.label}>{label}</span>
      <span style={styles.value}>{value}</span>
    </div>
  );
}

/** A collapsible detail list, rendered only when `items` is present. */
function DetailList({ summaryLabel, items }: { summaryLabel: string; items: string[] | null }) {
  if (items === null) return null;
  return (
    <details style={styles.details}>
      <summary style={styles.summaryToggle}>{summaryLabel}</summary>
      <ul style={styles.list}>
        {items.map((item, index) => (
          <li key={`${index}-${item}`}>{item}</li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Renders the race explanation, or a clean empty state when no usable props are
 * supplied. Read-only and presentational.
 */
export default function RaceExplanationPanel({
  dataQualityShortSummary,
  dataQualitySummary,
  tipsterConsensusShortSummary,
  tipsterConsensusSummary,
  runQuality,
  alignmentLabel,
}: RaceExplanationPanelProps) {
  const dqShort = clean(dataQualityShortSummary);
  const dqList = cleanList(dataQualitySummary);
  const tipShort = clean(tipsterConsensusShortSummary);
  const tipList = cleanList(tipsterConsensusSummary);
  const quality = clean(runQuality);
  const alignment = clean(alignmentLabel);

  const hasAnything =
    dqShort !== null ||
    dqList !== null ||
    tipShort !== null ||
    tipList !== null ||
    quality !== null ||
    alignment !== null;

  return (
    <section style={styles.panel} aria-label="Race model explanation">
      <h2 style={styles.title}>Model explanation</h2>

      {!hasAnything ? (
        <p style={styles.empty}>
          Model explanation will appear here when available.
        </p>
      ) : (
        <>
          {(quality !== null || alignment !== null) && (
            <div style={styles.row}>
              {quality !== null && <span style={styles.badge}>Data quality: {quality}</span>}
              {alignment !== null && <span style={styles.badge}>Tipsters: {alignment}</span>}
            </div>
          )}

          <Row label="Data quality" value={dqShort} />
          <Row label="Tipster consensus" value={tipShort} />

          <DetailList summaryLabel="Data quality details" items={dqList} />
          <DetailList summaryLabel="Tipster consensus details" items={tipList} />
        </>
      )}
    </section>
  );
}
