'use client';

import { FileMagnifyingGlass, House } from '@phosphor-icons/react';
import { SpotArt } from '@/components/art';
import { Wordmark } from '@/components/brand';
import { ButtonLink } from '@/components/ui';

// Our own 404 page. Next's built-in one uses an inline <style> element and
// style attributes, which the production CSP (style-src with a nonce, no
// 'unsafe-inline') refuses. This one uses classes only, and never shows
// the requested path back.
export default function NotFound() {
  return (
    <main className="app-backdrop flex min-h-dvh flex-col items-center justify-center px-6 py-12 text-center">
      <div className="flex w-full max-w-md animate-rise flex-col items-center">
        <Wordmark className="mb-8" />
        <div className="animate-pop stagger-1"><SpotArt tone="slate" icon={<FileMagnifyingGlass size={30} />} /></div>
        <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-300">404</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">This page could not be found</h1>
        <p className="mt-2 text-sm leading-6 text-fg-muted">The link may be old, or the page may have moved.</p>
        <ButtonLink href="/" variant="primary" className="mt-6 w-full sm:w-auto" icon={<House size={16} />}>Go to TrustVault</ButtonLink>
      </div>
    </main>
  );
}
