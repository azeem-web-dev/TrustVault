'use client';

// Replaces Next's default error screen, which injects an inline <style>
// element the production CSP refuses. Classes only; the error itself is
// never shown (it may contain server details), only its digest.
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-white">Something went wrong</h1>
      {error.digest && <p className="font-mono text-xs text-slate-500">Reference {error.digest}</p>}
      <button type="button" onClick={reset} className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-300">Try again</button>
    </main>
  );
}
