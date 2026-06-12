import type { ReactNode } from 'react';

export const metadata = {
  title: 'Bet Recommendations',
  description: 'Personal betting recommendations tool',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
