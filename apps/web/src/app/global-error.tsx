'use client';

import { useEffect } from 'react';
import { ArrowClockwise, House, WarningOctagon } from '@phosphor-icons/react';
import { Wordmark } from '@/components/brand';
import './globals.css';

// Shown when the root layout itself fails, so it brings its own <html> and
// <body>. Next's built-in fallback relies on inline styles the production
// CSP refuses; this one uses classes only and never shows the error, only
// its digest. No IconContext here (the providers are gone), so icon sizes
// and weights are set on each icon.
const BTN = 'inline-flex h-11 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-medium transition duration-150 ease-out active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-white sm:h-10 dark:focus-visible:ring-offset-ink-950';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // No pre-paint theme script here: follow the saved choice once mounted.
    try {
      const t = localStorage.getItem('tv-theme');
      const dark = t === 'dark' || (t !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', dark);
    } catch {
      /* storage blocked: light */
    }
  }, []);
  return (
    <html lang="en">
      <body className="bg-bg font-sans text-fg antialiased">
        <main className="app-backdrop flex min-h-dvh flex-col items-center justify-center px-6 py-12 text-center">
          <div className="flex w-full max-w-md animate-rise flex-col items-center">
            <Wordmark className="mb-8" />
            <span aria-hidden className="inline-flex size-16 animate-pop items-center justify-center rounded-2xl bg-danger-50 text-danger-600 ring-1 ring-inset ring-danger-100 stagger-1 dark:bg-danger-500/15 dark:text-danger-300 dark:ring-danger-500/25">
              <WarningOctagon size={30} weight="duotone" />
            </span>
            <h1 className="mt-5 text-2xl font-semibold tracking-tight text-fg">TrustVault hit a problem</h1>
            <p className="mt-2 text-sm leading-6 text-fg-muted">Something went wrong while loading the app. Trying again usually fixes it.</p>
            {error.digest && <p className="mt-3 rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-fg-subtle ring-1 ring-inset ring-line [overflow-wrap:anywhere]">Reference {error.digest}</p>}
            <div className="mt-6 flex w-full flex-col justify-center gap-2 sm:w-auto sm:flex-row">
              <button
                type="button"
                onClick={reset}
                className={`${BTN} border-transparent bg-brand-gradient text-white shadow-glow hover:brightness-110 active:brightness-95`}
              >
                <ArrowClockwise aria-hidden size={16} weight="bold" />
                Try again
              </button>
              <a
                href="/"
                className={`${BTN} border-line bg-surface text-fg-muted shadow-soft hover:border-line-strong hover:bg-surface-2 hover:text-fg`}
              >
                <House aria-hidden size={16} weight="duotone" />
                Go to TrustVault
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
