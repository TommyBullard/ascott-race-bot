/**
 * ModelFlowVisual — a reusable, self-contained visual of the model's high-level
 * pipeline, top to bottom:
 *
 *   Market Data + Tipster Picks -> Probability Model -> Value Detection ->
 *   Data Quality Layer -> Confidence + Safeguards -> Final Recommendation
 *
 * UI-only and presentational: no data, no logic, no backend coupling. Uses the
 * project's inline-style conventions (system-ui, neutral GitHub-style palette)
 * and no external libraries, so it can be dropped into the explanation page,
 * dashboards, onboarding, or race panels. Responsive (steps cap their width and
 * stack vertically) and accessible (an `aria-label` on the flow, decorative
 * arrows hidden from assistive tech).
 */

import type { CSSProperties } from 'react';

/** The high-level pipeline shown as a simple vertical flow. */
export const MODEL_FLOW_STEPS = [
  'Market Data + Tipster Picks',
  'Probability Model',
  'Value Detection',
  'Data Quality Layer',
  'Confidence + Safeguards',
  'Final Recommendation',
] as const;

const styles = {
  flow: {
    marginTop: 24,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 4,
  } as CSSProperties,
  stepWrap: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 4,
  } as CSSProperties,
  flowStep: {
    width: '100%',
    maxWidth: 360,
    textAlign: 'center' as const,
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid #d0d7de',
    background: '#f6f8fa',
    fontWeight: 600,
    fontSize: 15,
  } as CSSProperties,
  flowArrow: {
    color: '#8c959f',
    fontSize: 18,
    lineHeight: 1,
  } as CSSProperties,
} as const;

export interface ModelFlowVisualProps {
  /** Optional style overrides merged onto the outer flow container. */
  style?: CSSProperties;
  /** Accessible label for the flow region. */
  ariaLabel?: string;
}

/** Renders the model pipeline as a responsive, accessible vertical flow. */
export default function ModelFlowVisual({
  style,
  ariaLabel = 'Model pipeline flow',
}: ModelFlowVisualProps) {
  return (
    <div style={{ ...styles.flow, ...style }} aria-label={ariaLabel}>
      {MODEL_FLOW_STEPS.map((step, index) => (
        <div key={step} style={styles.stepWrap}>
          <div style={styles.flowStep}>{step}</div>
          {index < MODEL_FLOW_STEPS.length - 1 && (
            <span style={styles.flowArrow} aria-hidden="true">
              ↓
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
