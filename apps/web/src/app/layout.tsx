import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'TrustVault',
  description: 'Secure document sharing with a verifiable audit trail',
  robots: { index: false, follow: false },
};

// Browser chrome colours: slate-50 and ink-950 (oklch(0.155 0.02 275)).
// One theme-color tag that follows the *chosen* theme (X13): the pre-paint
// script below and theme.tsx swap its content between these two.
const THEME_LIGHT = 'rgb(248,250,252)';
const THEME_DARK = 'rgb(10,12,21)';

// Runs before first paint so the page never flashes the wrong theme.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('tv-theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);var m=document.querySelector('meta[name="theme-color"][data-light]');if(m)m.content=d?m.getAttribute('data-dark'):m.getAttribute('data-light')}catch(e){}})()`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading headers makes every page dynamic, so each response gets the
  // per-request CSP nonce set in proxy.ts.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <meta name="theme-color" content={THEME_LIGHT} data-light={THEME_LIGHT} data-dark={THEME_DARK} suppressHydrationWarning />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
