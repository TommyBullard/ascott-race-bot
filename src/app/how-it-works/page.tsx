/**
 * "How the model works" page (/how-it-works).
 *
 * A static, user-facing explanation of the model at a high level, with a simple
 * top-to-bottom flow diagram. Improves trust and transparency without exposing
 * proprietary implementation details. No data fetching, no backend logic — a
 * plain server component.
 *
 * SHELL ADOPTION. The page no longer renders its own `<main>`; `AppShell` owns
 * the single main landmark. Every word of the methodology is unchanged — only
 * the frame around it moved from page-local inline styles to the committed
 * design system.
 */

import Link from 'next/link';
import AppShell from '@/components/AppShell';
import { NeumorphicPanel, SectionHeader } from '@/components/UiPrimitives';
import ModelFlowVisual from '@/components/ModelFlowVisual';

export const metadata = {
  title: 'How the model works',
  description: 'A plain-English overview of how the model produces recommendations.',
};

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
    <AppShell>
      <div className="rb-stack">
        <div className="rb-page-header">
          <h1 className="rb-page-title">How the model works</h1>
          <Link href="/" className="rb-inline-link">
            ← Recommendations
          </Link>
        </div>

        <p className="rb-lead">
          Racing Bot is a decision-support tool, not a bookmaker. It combines
          market data, tipster insights, and data-quality checks to highlight
          where the model sees value — and, just as importantly, where it does
          not. It never places bets for you and never guarantees an outcome.
        </p>

        {SECTIONS.map((section) => (
          <NeumorphicPanel key={section.title}>
            <SectionHeader title={section.title} />
            <ul className="rb-list">
              {section.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </NeumorphicPanel>
        ))}

        <p className="rb-callout rb-callout--key">
          Sometimes the best decision is not to bet — and the system is designed to
          recognise that.
        </p>

        {/*
          Constrained to the reading measure. The component centres its own
          steps, which read as adrift when the container is the full shell
          width rather than the narrow page it was originally written for.
          The component itself is unchanged — only the frame it sits in.
        */}
        <ModelFlowVisual style={{ maxWidth: 'var(--rb-measure)' }} />

        <p className="rb-callout rb-callout--note">
          Predictions are informational and should not be treated as guaranteed
          outcomes. The system is designed to support disciplined decision-making,
          including reducing or suppressing stakes when data quality is poor.
        </p>
      </div>
    </AppShell>
  );
}
