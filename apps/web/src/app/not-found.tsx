import Link from 'next/link';

// Our own 404 page. Next's built-in one uses an inline <style> element and
// style attributes, which the production CSP (style-src with a nonce, no
// 'unsafe-inline') refuses. This one uses classes only, and never shows
// the requested path back.
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-sm font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-300">404</p>
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-white">This page could not be found</h1>
      <Link href="/" className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-300">Back to documents</Link>
    </main>
  );
}
