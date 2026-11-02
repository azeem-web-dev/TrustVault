'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BellRinging, CaretUpDown, Desktop, Files, GearSix, List, ListMagnifyingGlass, MagnifyingGlass, Moon, ShieldCheck, SignOut, Sun, UserCircleGear, UsersFour, UsersThree, X,
} from '@phosphor-icons/react';
import { useSession } from './session';
import { useTheme, type ThemeChoice } from './theme';
import { Logo, Wordmark } from './brand';
import { CommandPalette, type CommandLink } from './command';
import { Avatar, IconButton, Kbd, cx } from './ui';

export { Logo };

const ROLE_LABEL = { ADMIN: 'Administrator', OWNER: 'Document owner', VIEWER: 'Viewer', EXTERNAL: 'External partner' } as const;

interface NavItem { href: string; label: string; icon: ReactNode; hint: string }

export function Shell({ children }: { children: ReactNode }) {
  const { user, loading, mfaPending, signOut } = useSession();
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);

  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (loading || !user || mfaPending) return <ShellSkeleton />;

  const workspace: NavItem[] = [
    { href: '/', label: 'Documents', icon: <Files size={20} />, hint: 'Everything you can open' },
    { href: '/account', label: 'Account', icon: <UserCircleGear size={20} />, hint: 'Password, passkeys, 2FA' },
  ];
  const admin: NavItem[] = user.role === 'ADMIN'
    ? [
        { href: '/admin/audit', label: 'Audit log', icon: <ListMagnifyingGlass size={20} />, hint: 'Who did what, when' },
        { href: '/admin/alerts', label: 'Alerts', icon: <BellRinging size={20} />, hint: 'Activity worth a look' },
        { href: '/admin/users', label: 'Users', icon: <UsersThree size={20} />, hint: 'Accounts and roles' },
        { href: '/admin/groups', label: 'Groups', icon: <UsersFour size={20} />, hint: 'Teams for sharing' },
        { href: '/admin/settings', label: 'Settings', icon: <GearSix size={20} />, hint: 'Second-factor policy' },
      ]
    : [];
  const all = [...workspace, ...admin];
  const active = (href: string) => (href === '/' ? pathname === '/' || pathname.startsWith('/documents') : pathname.startsWith(href));
  const current = all.find((l) => active(l.href));
  const commandLinks: CommandLink[] = all.map((l) => ({ href: l.href, label: l.label, icon: l.icon, hint: l.hint }));

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center justify-between px-5">
        <Link href="/" aria-label="TrustVault home"><Wordmark /></Link>
        <IconButton label="Close menu" className="lg:hidden" onClick={() => setDrawer(false)}><X size={18} weight="bold" /></IconButton>
      </div>
      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-2">
        <NavSection title="Workspace" items={workspace} active={active} />
        {admin.length > 0 && <NavSection title="Administration" items={admin} active={active} />}
      </nav>
      <div className="space-y-3 p-3">
        <div className="relative overflow-hidden rounded-2xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50 to-teal-50 p-3.5 dark:border-emerald-500/20 dark:from-emerald-500/10 dark:to-teal-500/5">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-emerald-800 dark:text-emerald-200">
            <span className="relative flex size-2"><span className="absolute inset-0 animate-pulse-ring rounded-full bg-emerald-500" /><span className="relative size-2 rounded-full bg-emerald-500" /></span>
            Audit trail protected
          </div>
          <p className="mt-1 text-xs leading-5 text-emerald-700/80 dark:text-emerald-300/70">Every action is hash-chained, signed each minute and published to a public log.</p>
          <ShieldCheck size={56} className="absolute -bottom-3 -right-3 text-emerald-500/15" />
        </div>
        <UserMenu name={user.displayName} email={user.email} role={ROLE_LABEL[user.role]} onSignOut={() => void signOut()} />
      </div>
    </div>
  );

  return (
    <div className="app-backdrop min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[264px] border-r border-slate-200/80 bg-white/70 backdrop-blur-xl lg:block dark:border-white/[0.06] dark:bg-ink-950/60">
        {sidebar}
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-slate-950/50 backdrop-blur-sm" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-[280px] animate-drawer border-r border-slate-200 bg-white shadow-lift dark:border-white/10 dark:bg-ink-900">{sidebar}</aside>
        </div>
      )}

      <div className="lg:pl-[264px]">
        <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/70 backdrop-blur-xl dark:border-white/[0.06] dark:bg-ink-950/70">
          <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
            <IconButton label="Open menu" className="lg:hidden" onClick={() => setDrawer(true)}><List size={20} weight="bold" /></IconButton>
            <Link href="/" className="lg:hidden" aria-label="TrustVault home"><Logo /></Link>
            <div className="hidden min-w-0 items-center gap-2 text-sm md:flex">
              <span className="text-slate-400">{user.role === 'ADMIN' && admin.some((a) => a === current) ? 'Administration' : 'Workspace'}</span>
              <span className="text-slate-300 dark:text-slate-600">/</span>
              <span className="truncate font-medium">{current?.label ?? 'TrustVault'}</span>
            </div>
            <button
              onClick={() => setPalette(true)}
              className="ml-auto flex h-10 w-full max-w-xs items-center gap-2.5 rounded-xl border border-slate-200 bg-white/80 px-3 text-sm text-slate-400 shadow-sm transition hover:border-slate-300 hover:text-slate-600 sm:w-72 dark:border-white/10 dark:bg-white/5 dark:hover:border-white/20 dark:hover:text-slate-300"
            >
              <MagnifyingGlass size={17} />
              <span className="flex-1 truncate text-left">Search or jump to…</span>
              <span className="hidden items-center gap-1 sm:flex"><Kbd>Ctrl</Kbd><Kbd>K</Kbd></span>
            </button>
            <ThemeSwitch />
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
      </div>

      <CommandPalette open={palette} onClose={() => setPalette(false)} links={commandLinks} />
    </div>
  );
}

function NavSection({ title, items, active }: { title: string; items: NavItem[]; active: (href: string) => boolean }) {
  return (
    <div>
      <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">{title}</p>
      <ul className="space-y-0.5">
        {items.map((l) => {
          const on = active(l.href);
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={on ? 'page' : undefined}
                className={cx(
                  'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition',
                  on ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-white',
                )}
              >
                {on && <span className="absolute -left-3 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-brand-gradient" />}
                <span className={cx('transition', on ? 'text-brand-600 dark:text-brand-300' : 'text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-200')}>{l.icon}</span>
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function UserMenu({ name, email, role, onSignOut }: { name: string; email: string; role: string; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {open && (
        <div className="absolute inset-x-0 bottom-full mb-2 animate-pop overflow-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-lift dark:border-white/10 dark:bg-ink-900">
          <div className="border-b border-slate-100 px-3 py-2 dark:border-white/[0.06]">
            <p className="truncate text-xs text-slate-500">Signed in as</p>
            <p className="truncate text-sm font-medium">{email}</p>
          </div>
          <Link href="/account" className="mt-1 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-white/5"><UserCircleGear size={18} />Account &amp; security</Link>
          <button onClick={onSignOut} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-500/10"><SignOut size={18} />Sign out</button>
        </div>
      )}
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 rounded-xl border border-slate-200/80 bg-white p-2 text-left shadow-sm transition hover:border-slate-300 dark:border-white/[0.08] dark:bg-white/[0.04] dark:hover:border-white/15">
        <Avatar name={name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{name}</span>
          <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{role}</span>
        </span>
        <CaretUpDown size={16} className="text-slate-400" />
      </button>
    </div>
  );
}

const THEMES: { id: ThemeChoice; label: string; icon: ReactNode }[] = [
  { id: 'light', label: 'Light', icon: <Sun size={16} /> },
  { id: 'dark', label: 'Dark', icon: <Moon size={16} /> },
  { id: 'system', label: 'System', icon: <Desktop size={16} /> },
];

export function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="hidden items-center gap-0.5 rounded-xl border border-slate-200 bg-white/80 p-1 shadow-sm sm:flex dark:border-white/10 dark:bg-white/5" role="radiogroup" aria-label="Theme">
      {THEMES.map((t) => (
        <button
          key={t.id}
          role="radio"
          aria-checked={theme === t.id}
          title={`${t.label} theme`}
          aria-label={`${t.label} theme`}
          onClick={() => setTheme(t.id)}
          className={cx('inline-flex size-8 items-center justify-center rounded-lg transition', theme === t.id ? 'bg-brand-gradient text-white shadow-glow' : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200')}
        >
          {t.icon}
        </button>
      ))}
    </div>
  );
}

function ShellSkeleton() {
  return (
    <div className="app-backdrop flex min-h-screen">
      <div className="hidden w-[264px] border-r border-slate-200/80 p-5 lg:block dark:border-white/[0.06]">
        <div className="skeleton h-7 w-32" />
        <div className="mt-10 space-y-3">{Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton h-9" />)}</div>
      </div>
      <div className="flex-1 p-8">
        <div className="skeleton h-8 w-56" />
        <div className="skeleton mt-3 h-4 w-96 max-w-full" />
        <div className="mt-8 grid gap-4 sm:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <div key={i} className="skeleton h-24 rounded-2xl" />)}</div>
        <div className="skeleton mt-6 h-72 rounded-2xl" />
      </div>
    </div>
  );
}
