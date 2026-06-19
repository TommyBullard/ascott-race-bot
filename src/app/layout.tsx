import type { ReactNode } from 'react';

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
