'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import {
  BellRinging, CaretUpDown, Desktop, Files, GearSix, HandPalm, List, ListMagnifyingGlass, MagnifyingGlass, Moon, ShieldCheck, SignOut, Sun, UserCheck, UserCircleGear, UsersFour, UsersThree, X,
} from '@phosphor-icons/react';
import { useSession } from './session';
import { useTheme, type ThemeChoice } from './theme';
import { Logo, Wordmark } from './brand';
import { CommandPalette, type CommandLink } from './command';
import { Avatar, Drawer, IconButton, Kbd, Menu, MenuHeading, MenuItem, MenuSeparator, cx } from './ui';

export { Logo };

const ROLE_LABEL = { ADMIN: 'Administrator', OWNER: 'Document owner', VIEWER: 'Viewer', EXTERNAL: 'External partner' } as const;

interface NavItem { href: string; label: string; icon: ReactNode; hint: string }

export function Shell({ children }: { children: ReactNode }) {
  const { user, loading, mfaPending, signOut } = useSession();
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const isMac = useIsMac();

  useEffect(() => setDrawer(false), [pathname]);
  useCloseAtDesktop(drawer, () => setDrawer(false));
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
    { href: '/', label: 'Documents', icon: <Files size={18} />, hint: 'Everything you can open' },
    ...(user.role !== 'ADMIN' ? [{ href: '/approvals', label: 'Approvals', icon: <HandPalm size={18} />, hint: 'Download requests waiting for you' }] : []),
    { href: '/account', label: 'Account', icon: <UserCircleGear size={18} />, hint: 'Password, passkeys, 2FA' },
  ];
  const admin: NavItem[] = user.role === 'ADMIN'
    ? [
        { href: '/admin/audit', label: 'Audit log', icon: <ListMagnifyingGlass size={18} />, hint: 'Who did what, when' },
        { href: '/admin/alerts', label: 'Alerts', icon: <BellRinging size={18} />, hint: 'Activity worth a look' },
        { href: '/admin/users', label: 'Users', icon: <UsersThree size={18} />, hint: 'Accounts and roles' },
        { href: '/admin/approvals', label: 'Approvals', icon: <UserCheck size={18} />, hint: 'Requests needing a second admin' },
        { href: '/admin/groups', label: 'Groups', icon: <UsersFour size={18} />, hint: 'Teams for sharing' },
        { href: '/admin/settings', label: 'Settings', icon: <GearSix size={18} />, hint: 'Second-factor policy' },
        { href: '/admin/policies', label: 'Access rules', icon: <ShieldCheck size={18} />, hint: 'Hours and networks per role' },
      ]
    : [];
  const all = [...workspace, ...admin];
  const active = (href: string) => (href === '/' ? pathname === '/' || pathname.startsWith('/documents') : pathname.startsWith(href));
  const current = all.find((l) => active(l.href));
  const commandLinks: CommandLink[] = all.map((l) => ({ href: l.href, label: l.label, icon: l.icon, hint: l.hint }));

  const sidebar = (inDrawer: boolean) => (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex h-16 shrink-0 items-center justify-between px-5">
        <Link href="/" aria-label="TrustVault home" className="rounded-lg"><Wordmark /></Link>
        {inDrawer && <IconButton label="Close menu" data-autofocus onClick={() => setDrawer(false)}><X size={18} weight="bold" /></IconButton>}
      </div>
      <nav aria-label="Main" className="flex-1 space-y-6 overflow-y-auto overscroll-contain px-3 py-2">
        <NavSection title="Workspace" items={workspace} active={active} />
        {admin.length > 0 && <NavSection title="Administration" items={admin} active={active} />}
      </nav>
      <div className="space-y-3 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="relative overflow-hidden rounded-2xl border border-success-300/50 bg-gradient-to-br from-success-50 to-success-100/40 p-3.5 dark:border-success-500/20 dark:from-success-500/10 dark:to-success-500/5">
          <div className="flex items-center gap-2 text-[0.8125rem] font-semibold text-success-700 dark:text-success-100">
            <span aria-hidden className="relative flex size-2"><span className="absolute inset-0 animate-pulse-ring rounded-full bg-success-500" /><span className="relative size-2 rounded-full bg-success-500" /></span>
            Audit trail protected
          </div>
          <p className="mt-1 text-xs leading-5 text-success-700 dark:text-success-300/80">Every action is hash-chained, signed each minute and published to a public log.</p>
          <ShieldCheck size={56} aria-hidden className="absolute -bottom-3 -right-3 text-success-500/15" />
        </div>
        <UserMenu name={user.displayName} email={user.email} role={ROLE_LABEL[user.role]} onSignOut={() => void signOut()} />
      </div>
    </div>
  );

  return (
    <div className="app-backdrop min-h-dvh">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[16.5rem] border-r border-line bg-white/70 backdrop-blur-xl lg:flex lg:flex-col dark:bg-ink-950/60">
        {sidebar(false)}
      </aside>

      {/* Phones and tablets: the same sidebar in an accessible drawer (Escape, focus trap, scroll lock, exit animation). */}
      <Drawer open={drawer} onClose={() => setDrawer(false)} label="Navigation" rootClassName="lg:hidden">
        <div id="tv-nav-drawer" className="flex min-h-0 flex-1 flex-col">{sidebar(true)}</div>
      </Drawer>

      <div className="lg:pl-[16.5rem]">
        <header className="sticky top-0 z-20 border-b border-line bg-white/70 backdrop-blur-xl dark:bg-ink-950/70">
          <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 px-4 sm:gap-3 sm:px-6 lg:px-8">
            <IconButton
              label="Open menu"
              className="lg:hidden"
              aria-haspopup="dialog"
              aria-expanded={drawer}
              aria-controls={drawer ? 'tv-nav-drawer' : undefined}
              onClick={() => setDrawer(true)}
            >
              <List size={20} weight="bold" />
            </IconButton>
            <Link href="/" className="shrink-0 rounded-lg lg:hidden" aria-label="TrustVault home"><Logo /></Link>
            <div className="hidden min-w-0 items-center gap-2 text-sm md:flex">
              <span className="text-fg-subtle">{user.role === 'ADMIN' && admin.some((a) => a === current) ? 'Administration' : 'Workspace'}</span>
              <span aria-hidden className="text-line-strong">/</span>
              <span className="truncate font-medium text-fg">{current?.label ?? 'TrustVault'}</span>
            </div>
            <button
              type="button"
              onClick={() => setPalette(true)}
              aria-haspopup="dialog"
              aria-expanded={palette}
              aria-keyshortcuts="Control+K Meta+K"
              className="ml-auto flex h-11 w-full min-w-0 max-w-xs items-center gap-2.5 rounded-xl border border-line bg-white/80 px-3 text-sm text-fg-subtle shadow-sm transition duration-150 ease-out hover:border-line-strong hover:text-fg-muted hover:shadow-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 active:scale-[0.99] sm:h-10 sm:w-72 dark:bg-white/5"
            >
              <MagnifyingGlass size={18} aria-hidden className="shrink-0" />
              <span className="flex-1 truncate text-left">Search or jump to…</span>
              <span aria-hidden className="hidden items-center gap-1 sm:flex">{isMac ? <Kbd>⌘</Kbd> : <Kbd>Ctrl</Kbd>}<Kbd>K</Kbd></span>
            </button>
            <ThemeSwitch />
          </div>
        </header>
        <main id="main" className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
      </div>

      <CommandPalette open={palette} onClose={() => setPalette(false)} links={commandLinks} />
    </div>
  );
}

function NavSection({ title, items, active }: { title: string; items: NavItem[]; active: (href: string) => boolean }) {
  return (
    <div>
      <p className="px-3 pb-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">{title}</p>
      <ul className="space-y-0.5">
        {items.map((l) => {
          const on = active(l.href);
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={on ? 'page' : undefined}
                className={cx(
                  'group relative flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition duration-150 active:scale-[0.99] lg:min-h-0',
                  on ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-white' : 'text-fg-muted hover:bg-slate-100 hover:text-fg active:bg-slate-200/70 dark:hover:bg-white/5 dark:active:bg-white/10',
                )}
              >
                {on && <span aria-hidden className="absolute -left-3 top-1/2 h-6 w-1 -translate-y-1/2 animate-fade-in rounded-r-full bg-brand-gradient" />}
                <span className={cx('transition-colors duration-150', on ? 'text-brand-600 dark:text-brand-300' : 'text-fg-subtle group-hover:text-fg-muted')}>{l.icon}</span>
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
  const { theme, setTheme } = useTheme();
  return (
    <Menu
      label="Account menu"
      align="start"
      direction="up"
      buttonClassName="flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-2 text-left shadow-sm outline-none transition duration-150 ease-out hover:border-line-strong hover:shadow-soft active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-brand-500/50"
      panelClassName="left-0 right-0"
      button={(
        <>
          <Avatar name={name} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{name}</span>
            <span className="block truncate text-xs text-fg-subtle">{role}</span>
          </span>
          <CaretUpDown size={16} weight="bold" aria-hidden className="shrink-0 text-fg-subtle" />
        </>
      )}
    >
      <div className="border-b border-line px-3 py-2">
        <p className="truncate text-xs text-fg-subtle">Signed in as</p>
        <p className="truncate text-sm font-medium text-fg">{email}</p>
      </div>
      <div className="pt-1" />
      <MenuItem icon={<UserCircleGear size={18} />} href="/account">Account &amp; security</MenuItem>
      {/* Theme lives here too, so it is reachable on phones where the header switch is hidden. */}
      <MenuSeparator />
      <MenuHeading>Theme</MenuHeading>
      {THEMES.map((t) => (
        <MenuItem key={t.id} icon={t.icon} selected={theme === t.id} onSelect={() => setTheme(t.id)}>{t.label}</MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem danger icon={<SignOut size={18} />} onSelect={onSignOut}>Sign out</MenuItem>
    </Menu>
  );
}

const THEMES: { id: ThemeChoice; label: string; icon: ReactNode }[] = [
  { id: 'light', label: 'Light', icon: <Sun size={16} /> },
  { id: 'dark', label: 'Dark', icon: <Moon size={16} /> },
  { id: 'system', label: 'System', icon: <Desktop size={16} /> },
];

/**
 * Light / dark / system picker: an ARIA radiogroup with one tab stop, where
 * ←/→ (and ↑/↓, Home, End) move and select. In the app header it is hidden on
 * phones, because the account menu offers the theme there. Pass `compact` to
 * show it at every width, e.g. on the sign-in pages, which have no account menu.
 */
export function ThemeSwitch({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { theme, setTheme } = useTheme();
  const refs = useRef(new Map<ThemeChoice, HTMLButtonElement>());
  const current = THEMES.findIndex((t) => t.id === theme);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, idx: number) => {
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % THEMES.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + THEMES.length) % THEMES.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = THEMES.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const t = THEMES[next];
    if (!t) return;
    setTheme(t.id);
    refs.current.get(t.id)?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cx(
        'shrink-0 items-center gap-0.5 rounded-xl border border-line bg-white/80 p-1 shadow-sm dark:bg-white/5',
        compact ? 'flex' : 'hidden sm:flex',
        className,
      )}
    >
      {THEMES.map((t, i) => {
        const on = theme === t.id;
        return (
          <button
            key={t.id}
            ref={(el) => { if (el) refs.current.set(t.id, el); else refs.current.delete(t.id); }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (current < 0 && i === 0) ? 0 : -1}
            title={`${t.label} theme`}
            aria-label={`${t.label} theme`}
            onClick={() => setTheme(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cx(
              'relative inline-flex size-8 items-center justify-center rounded-lg transition duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50',
              'pointer-coarse:before:absolute pointer-coarse:before:-inset-1.5',
              on ? 'bg-brand-gradient text-white shadow-glow' : 'text-fg-subtle hover:bg-slate-100 hover:text-fg active:bg-slate-200 dark:hover:bg-white/10 dark:active:bg-white/15',
            )}
          >
            {t.icon}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A phone/tablet-only drawer (hidden at `lg`) would stay open, invisible,
 * with the page scroll-locked if the window grows past `lg`: close it then.
 */
export function useCloseAtDesktop(open: boolean, close: () => void) {
  const fn = useRef(close);
  useEffect(() => { fn.current = close; });
  useEffect(() => {
    if (!open || typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(min-width: 64rem)');
    const onChange = () => { if (mq.matches) fn.current(); };
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [open]);
}

/** ⌘ vs Ctrl in shortcut hints (D12). Read after mount, so server and client markup match. */
function useIsMac() {
  const [mac, setMac] = useState(false);
  useEffect(() => {
    try {
      const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
      setMac(/mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || nav.userAgent));
    } catch { /* keep Ctrl */ }
  }, []);
  return mac;
}

function ShellSkeleton() {
  return (
    <div className="app-backdrop flex min-h-dvh animate-fade-in" role="status" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div aria-hidden className="hidden w-[16.5rem] border-r border-line p-5 lg:block">
        <div className="skeleton h-7 w-32" />
        <div className="mt-10 space-y-3">{Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton h-9" />)}</div>
      </div>
      <div aria-hidden className="flex-1 p-4 sm:p-8">
        <div className="skeleton h-8 w-56 max-w-full" />
        <div className="skeleton mt-3 h-4 w-96 max-w-full" />
        <div className="mt-8 grid gap-4 sm:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <div key={i} className="skeleton h-24 rounded-2xl" />)}</div>
        <div className="skeleton mt-6 h-72 rounded-2xl" />
      </div>
    </div>
  );
}
