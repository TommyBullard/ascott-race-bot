import type { ReactNode } from 'react';
import type { Viewport } from 'next';

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

/**
 * `viewportFit: 'cover'` is what makes `env(safe-area-inset-*)` resolve to a
 * real value on a notched device. Without it those insets are always 0px, and
 * the shell's fixed bottom navigation would sit under the home indicator while
 * the clearance reserved on `.rb-main` would under-reserve by the same amount.
 *
 * `width` and `initialScale` restate Next's own defaults explicitly, so adding
 * this export cannot silently drop them. No other metadata changes here.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
