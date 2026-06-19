/**
 * "How the model works" page (/how-it-works).
 *
 * A static, user-facing explanation of the model at a high level, with a simple
 * top-to-bottom flow diagram. Improves trust and transparency without exposing
 * proprietary implementation details. No data fetching, no backend logic — a
 * plain server component using the same inline-style conventions as the other
 * pages (system-ui, a centred max-width container, #0969da nav links).
 */

import type { CSSProperties } from 'react';
import Link from 'next/link';
import ModelFlowVisual from '@/components/ModelFlowVisual';

export const metadata = {
  title: 'How the model works',
  description: 'A plain-English overview of how the model produces recommendations.',
};

const styles = {
  page: {
    maxWidth: 820,
    margin: '2rem auto',
    padding: '0 1rem',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#1f2328',
    lineHeight: 1.55,
  } as CSSProperties,
  headerRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap' as const,
  } as CSSProperties,
  navLink: {
    fontSize: 14,
    color: '#0969da',
    textDecoration: 'none',
  } as CSSProperties,
  intro: {
    fontSize: 16,
    color: '#424a53',
    marginTop: 8,
  } as CSSProperties,
  section: {
    border: '1px solid #d0d7de',
    borderRadius: 10,
    padding: 16,
    marginTop: 16,
    background: '#fff',
  } as CSSProperties,
  sectionTitle: {
    fontSize: 16,
    fontWeight: 700,
    margin: '0 0 8px',
  } as CSSProperties,
  list: {
    margin: 0,
    paddingLeft: 20,
    color: '#424a53',
  } as CSSProperties,
  keyLine: {
    marginTop: 20,
    padding: '12px 16px',
    background: '#ddf4ff',
    border: '1px solid #b6e3ff',
    borderRadius: 10,
    fontSize: 16,
    fontWeight: 600,
    color: '#0a3069',
  } as CSSProperties,
  flow: {
    marginTop: 24,
  } as CSSProperties,
  note: {
    marginTop: 24,
    padding: '12px 16px',
    background: '#fff8c5',
    border: '1px solid #eac54f',
    borderRadius: 10,
    fontSize: 14,
    color: '#4d2d00',
  } as CSSProperties,
} as const;

interface Section {
  title: string;
  points: string[];
}

const SECTIONS: Section[] = [
  {
    title: '1. Data collection',
    points: [
      'Market odds',
      'Race runners',
      'Tipster selections',
      'Timing and freshness data',
    ],
  },
  {
    title: '2. Race analysis',
    points: [
      'Estimates runner probabilities',
      'Compares the model view with the available odds',
      'Looks for value opportunities',
    ],
  },
  {
    title: '3. Tipster consensus',
    points: [
      'Aggregates tipster selections',
      'Measures which runners have the most support',
      'Compares the tipster consensus with the model recommendation',
    ],
  },
  {
    title: '4. Data quality checks',
    points: [
      'Checks for missing odds',
      'Checks for stale odds',
      'Checks for incomplete markets',
      'Checks for missing or unmatched tipster data',
    ],
  },
  {
    title: '5. Confidence and safeguards',
    points: [
      'Adjusts confidence when data quality is weaker',
      'Suppresses staking when market data is unreliable',
      'Keeps the recommendation visible for transparency',
    ],
  },
];

export default function HowItWorksPage() {
  return (
    <main style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={{ margin: 0 }}>How the model works</h1>
        <Link href="/" style={styles.navLink}>
          ← Recommendations
        </Link>
      </div>

      <p style={styles.intro}>
        Racing Bot is a decision-support tool, not a bookmaker. It combines
        market data, tipster insights, and data-quality checks to highlight
        where the model sees value — and, just as importantly, where it does
        not. It never places bets for you and never guarantees an outcome.
      </p>

      {SECTIONS.map((section) => (
        <section key={section.title} style={styles.section}>
          <h2 style={styles.sectionTitle}>{section.title}</h2>
          <ul style={styles.list}>
            {section.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </section>
      ))}

      <p style={styles.keyLine}>
        Sometimes the best decision is not to bet — and the system is designed to
        recognise that.
      </p>

      <ModelFlowVisual style={styles.flow} />

      <p style={styles.note}>
        Predictions are informational and should not be treated as guaranteed
        outcomes. The system is designed to support disciplined decision-making,
        including reducing or suppressing stakes when data quality is poor.
      </p>
    </main>
  );
}
