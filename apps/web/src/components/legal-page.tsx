import Link from 'next/link';
import type { ReactNode } from 'react';
import { Wordmark } from './brand';
import { ThemeSwitch } from './shell';

/** Link style shared by the public legal pages (brand-300 in dark, like the rest of the app). */
export const LEGAL_LINK =
  'inline-flex items-center gap-1 rounded font-medium text-brand-600 underline-offset-2 transition-colors duration-150 hover:text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 dark:text-brand-300 dark:hover:text-brand-200';

/** Stagger classes from globals.css (40ms steps, capped at 8). Plain classes, so no style attribute (CSP). */
const stagger = (index?: number) => (index ? `stagger-${Math.max(1, Math.min(8, Math.round(index)))}` : '');

/**
 * Chrome for the public legal pages (privacy, account deletion): the app
 * backdrop, a Wordmark that links back to sign-in, the theme switch, and a
 * readable column on a card. Server-rendered; no inline styles (CSP).
 */
export function LegalPage({ title, intro, icon, children, footer }: { title: string; intro?: ReactNode; icon?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="app-backdrop min-h-dvh">
      <header className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-5 sm:px-6">
        <Link href="/login" aria-label="TrustVault: back to sign in" className="rounded-lg transition-opacity duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50">
          <Wordmark />
        </Link>
        <ThemeSwitch />
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-16 pt-2 sm:px-6 sm:pt-6">
        <article className="animate-rise rounded-3xl border border-line bg-surface p-5 shadow-soft sm:p-10">
          <div className="flex items-start gap-4">
            {icon && (
              <span aria-hidden className="hidden size-12 shrink-0 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-glow sm:inline-flex">{icon}</span>
            )}
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-300">TrustVault</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight break-words text-fg sm:text-3xl">{title}</h1>
              {intro && <div className="mt-2 text-sm leading-6 text-fg-subtle">{intro}</div>}
            </div>
          </div>
          {children}
          {footer && (
            <footer className="mt-12 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-6 text-sm">
              {footer}
            </footer>
          )}
        </article>
      </main>
    </div>
  );
}

export function LegalSection({ title, icon, index, children }: { title: string; icon?: ReactNode; index?: number; children: ReactNode }) {
  return (
    <section className={`mt-8 animate-rise ${stagger(index)}`}>
      <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight text-fg">
        {icon && (
          <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-100 dark:bg-brand-500/15 dark:text-brand-300 dark:ring-brand-400/20">{icon}</span>
        )}
        <span className="min-w-0">{title}</span>
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-fg-muted">{children}</div>
    </section>
  );
}
