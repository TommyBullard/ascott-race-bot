import type { ReactNode } from 'react';

// Global design tokens and shell styling. Additive by design: it declares
// custom properties plus two accessibility base rules (focus-visible and
// reduced motion) and otherwise styles nothing that is not opted in via an
// `rb-` class, so existing pages render unchanged. See src/styles/tokens.css.
import '@/styles/tokens.css';

export const metadata = {
  title: 'Race-Day Recommendations (Beta) — Decision Support',
  description:
    'Model and tipster analysis for UK & Irish horse racing. Decision-support only — recommendations are model outputs, not betting advice and not guarantees. Public beta.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
