import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { SessionProvider } from '@/components/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'TrustVault',
  description: 'Secure document sharing with a verifiable audit trail',
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading headers makes every page dynamic, so each response gets the
  // per-request CSP nonce set in proxy.ts.
  await headers();
  return (
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
