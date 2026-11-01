'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useSession } from './session';

const roleLabel = { ADMIN: 'Administrator', OWNER: 'Document owner', VIEWER: 'Viewer', EXTERNAL: 'External' } as const;

export function Shell({ children }: { children: ReactNode }) {
  const { user, loading, signOut } = useSession();
  const pathname = usePathname();

  if (loading || !user) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Loading…</div>;
  }

  const links = [
    { href: '/', label: 'Documents' },
    ...(user.role === 'ADMIN' ? [{ href: '/admin/users', label: 'Users' }] : []),
  ];

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <span aria-hidden className="inline-block h-6 w-6 rounded-md bg-brand-600" />
            TrustVault
          </Link>
          <nav className="flex gap-1 text-sm">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-md px-3 py-1.5 ${pathname === l.href ? 'bg-slate-100 font-medium dark:bg-slate-800' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-right sm:block">
              <span className="block font-medium">{user.displayName}</span>
              <span className="block text-xs text-slate-500">{roleLabel[user.role]}</span>
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
