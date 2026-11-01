'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useSession } from './session';

const ROLE_LABEL = { ADMIN: 'Administrator', OWNER: 'Document owner', VIEWER: 'Viewer', EXTERNAL: 'External' } as const;

export function Shell({ children }: { children: ReactNode }) {
  const { user, loading, mfaPending, signOut } = useSession();
  const pathname = usePathname();

  if (loading || !user || mfaPending) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Loading…</div>;
  }

  const links = [
    { href: '/', label: 'Documents', show: true },
    { href: '/admin/audit', label: 'Audit log', show: user.role === 'ADMIN' },
    { href: '/admin/alerts', label: 'Alerts', show: user.role === 'ADMIN' },
    { href: '/admin/users', label: 'Users', show: user.role === 'ADMIN' },
    { href: '/admin/groups', label: 'Groups', show: user.role === 'ADMIN' },
    { href: '/account', label: 'Account', show: true },
  ].filter((l) => l.show);

  const active = (href: string) => (href === '/' ? pathname === '/' || pathname.startsWith('/documents') : pathname.startsWith(href));

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <Logo /> TrustVault
          </Link>
          <nav className="flex flex-wrap gap-1 text-sm">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-md px-3 py-1.5 ${active(l.href) ? 'bg-slate-100 font-medium dark:bg-slate-800' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-right sm:block">
              <span className="block font-medium">{user.displayName}</span>
              <span className="block text-xs text-slate-500">{ROLE_LABEL[user.role]}</span>
            </span>
            <button onClick={() => void signOut()} className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}

export function Logo() {
  return (
    <svg aria-hidden width="24" height="24" viewBox="0 0 24 24" className="text-brand-600">
      <rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor" />
      <path d="M8 11V9a4 4 0 1 1 8 0v2" stroke="white" strokeWidth="1.8" fill="none" />
      <rect x="7" y="11" width="10" height="7" rx="1.5" fill="white" />
    </svg>
  );
}
