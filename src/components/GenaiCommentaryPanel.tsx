/**
 * GenaiCommentaryPanel — a READ-ONLY "AI commentary (shadow)" card.
 *
 * Renders ONLY human-approved shadow commentary for a race (via the pure
 * {@link buildGenaiCommentaryView} gate), each note labelled with its kind,
 * prose, and provenance (generator + prompt version + generated-at), under a
 * persistent "AI shadow note — not betting advice." disclaimer.
 *
 * Hard properties:
 *   - It surfaces ONLY approved commentary; pending / rejected rows are filtered
 *     out by the selector and never shown as fact. When nothing is approved it
 *     shows a neutral "No reviewed AI shadow commentary available." placeholder.
 *   - It is purely presentational: no data fetching and no write controls of any
 *     kind (no buttons, forms, approve/reject, or commit path).
 *   - It is not model-active and is never betting advice; it only displays
 *     already-reviewed, decision-support prose.
 */

import type { CSSProperties } from 'react';
import {
  buildGenaiCommentaryView,
  type GenaiCommentaryRow,
} from '@/lib/genaiCommentaryView';

const styles = {
  panel: {
    borderTop: '1px dashed #d0d7de',
    marginTop: 12,
    paddingTop: 12,
  } as CSSProperties,
  heading: {
    fontSize: 13,
    fontWeight: 700,
    color: '#1f2328',
    margin: '0 0 8px',
  } as CSSProperties,
  item: {
    marginBottom: 10,
  } as CSSProperties,
  kind: {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    color: '#0550ae',
    background: '#ddf4ff',
    border: '1px solid #b6e3ff',
    borderRadius: 999,
    padding: '1px 7px',
    marginBottom: 4,
  } as CSSProperties,
  text: {
    fontSize: 13,
    color: '#1f2328',
    margin: '2px 0 3px',
    lineHeight: 1.45,
  } as CSSProperties,
  provenance: {
    fontSize: 11,
    color: '#656d76',
  } as CSSProperties,
  disclaimer: {
    fontSize: 11,
    fontStyle: 'italic',
    color: '#656d76',
    marginTop: 4,
  } as CSSProperties,
  empty: {
    fontSize: 12,
    color: '#656d76',
    margin: '2px 0 3px',
  } as CSSProperties,
} as const;

interface GenaiCommentaryPanelProps {
  /** Raw genai_commentary rows for the race; only approved candidates render. */
  rows?: GenaiCommentaryRow[] | null;
  style?: CSSProperties;
}

export default function GenaiCommentaryPanel({ rows, style }: GenaiCommentaryPanelProps) {
  const view = buildGenaiCommentaryView(rows ?? []);

  return (
    <section
      style={{ ...styles.panel, ...style }}
      aria-label="AI shadow commentary (read-only)"
    >
      <h3 style={styles.heading}>AI commentary (shadow)</h3>
      {view.hasAny ? (
        view.items.map((item, i) => (
          <div key={`${item.kind}-${i}`} style={styles.item}>
            <span style={styles.kind}>{item.kind.replace(/_/g, ' ')}</span>
            <p style={styles.text}>{item.text}</p>
            <span style={styles.provenance}>
              {[item.generatorName, item.promptVersion, item.generatedAt]
                .filter((v): v is string => typeof v === 'string' && v !== '')
                .join(' · ')}
            </span>
          </div>
        ))
      ) : (
        <p style={styles.empty}>{view.emptyMessage}</p>
      )}
      <p style={styles.disclaimer}>{view.disclaimer}</p>
    </section>
  );
}
