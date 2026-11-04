'use client';

import { ArrowClockwise, House, WarningOctagon } from '@phosphor-icons/react';
import { SpotArt } from '@/components/art';
import { Wordmark } from '@/components/brand';
import { Button, ButtonLink } from '@/components/ui';

// Replaces Next's default error screen, which injects an inline <style>
// element the production CSP refuses. Classes only; the error itself is
// never shown (it may contain server details), only its digest.
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="app-backdrop flex min-h-dvh flex-col items-center justify-center px-6 py-12 text-center">
      <div className="flex w-full max-w-md animate-rise flex-col items-center">
        <Wordmark className="mb-8" />
        <div className="animate-pop stagger-1"><SpotArt tone="red" icon={<WarningOctagon size={30} />} /></div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-fg">Something went wrong</h1>
        <p className="mt-2 text-sm leading-6 text-fg-muted">The page hit an unexpected problem. Trying again usually fixes it.</p>
        {error.digest && <p className="mt-3 rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-fg-subtle ring-1 ring-inset ring-line [overflow-wrap:anywhere]">Reference {error.digest}</p>}
        <div className="mt-6 flex w-full flex-col justify-center gap-2 sm:w-auto sm:flex-row">
          <Button variant="primary" icon={<ArrowClockwise size={16} weight="bold" />} onClick={reset}>Try again</Button>
          <ButtonLink href="/" icon={<House size={16} />}>Go to TrustVault</ButtonLink>
        </div>
      </div>
    </main>
  );
}
