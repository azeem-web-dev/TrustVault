'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, Desktop, Fingerprint, LinkSimpleHorizontal, LockKey, Moon, ShieldCheck, Sun } from '@phosphor-icons/react';
import { VaultHero } from './art';
import { Wordmark } from './brand';
import { ThemeSwitch } from './shell';
import { useTheme, type ThemeChoice } from './theme';
import { IconButton, cx, staggerClass } from './ui';

const HERO_TONES = {
  brand: 'bg-brand-gradient text-white shadow-glow',
  success: 'bg-success-50 text-success-600 ring-1 ring-inset ring-success-100 shadow-soft dark:bg-success-500/15 dark:text-success-300 dark:ring-success-300/20',
  warning: 'bg-warning-50 text-warning-700 ring-1 ring-inset ring-warning-100 shadow-soft dark:bg-warning-500/15 dark:text-warning-300 dark:ring-warning-300/20',
} as const;

/**
 * The top of every auth step: icon tile (pops in), title and an optional
 * lead paragraph, on one shared type scale so the steps line up.
 */
export function AuthHeader({ icon, title, children, tone = 'brand' }: { icon: ReactNode; title: ReactNode; children?: ReactNode; tone?: keyof typeof HERO_TONES }) {
  return (
    <div className="mb-8">
      <span className={cx('mb-5 inline-flex size-14 animate-pop items-center justify-center rounded-2xl', HERO_TONES[tone])}>{icon}</span>
      <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight text-fg text-balance">{title}</h1>
      {children && <p className="mt-2 text-sm leading-6 text-fg-subtle">{children}</p>}
    </div>
  );
}

const STRENGTH_SEGMENTS = 5;
/**
 * Password length meter drawn as segments (classes only: no style attribute,
 * so the CSP needs no 'unsafe-inline'). Every 4 characters fills a segment.
 */
export function PasswordStrength({ value }: { value: string }) {
  const n = value.length;
  const filled = Math.min(STRENGTH_SEGMENTS, Math.ceil(n / 4));
  const tone = n < 12 ? 'bg-danger-500' : n < 16 ? 'bg-warning-500' : 'bg-success-500';
  const label = n < 12 ? `${12 - n} more characters needed` : n < 16 ? 'Good. Longer is even better.' : 'Strong';
  const text = n < 12 ? 'text-fg-subtle' : n < 16 ? 'text-warning-700 dark:text-warning-300' : 'text-success-700 dark:text-success-300';
  return (
    <div className="-mt-1 animate-fade-in">
      <div className="flex gap-1" aria-hidden>
        {Array.from({ length: STRENGTH_SEGMENTS }, (_, i) => (
          <span key={i} className={cx('h-1.5 flex-1 rounded-full transition-colors duration-200 ease-out', i < filled ? tone : 'bg-slate-200 dark:bg-white/10')} />
        ))}
      </div>
      <p className={cx('mt-1.5 text-xs font-medium transition-colors duration-200', text)}>{label}</p>
    </div>
  );
}

const POINTS = [
  { icon: <LockKey size={20} />, title: 'Only the right people', text: 'Access is granted one document at a time and checked twice: in the app and in the database.' },
  { icon: <LinkSimpleHorizontal size={20} />, title: 'Proof of every read', text: 'Every view, download and refusal is hash-chained, signed and published to a public log.' },
  { icon: <Fingerprint size={20} />, title: 'Phishing-resistant sign-in', text: 'Passkeys and authenticator codes. Administrators must use one.' },
];

/**
 * Split screen for the sign-in steps: brand story on the left, the form on
 * the right. `stepKey` re-mounts the form column when a page moves to another
 * step (form → sent, picker → code…), so each step animates in (A10).
 */
export function AuthLayout({ children, stepKey }: { children: ReactNode; stepKey?: string }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-ink-975 text-white lg:flex lg:flex-col">
        <div className="absolute inset-0 bg-grid opacity-40 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
        <div className="absolute -left-32 -top-32 size-[30rem] rounded-full bg-brand-600/30 blur-3xl" />
        <div className="absolute -bottom-40 -right-24 size-[28rem] rounded-full bg-brand-400/20 blur-3xl" />
        <div className="relative flex flex-1 flex-col px-12 py-10 xl:px-16">
          <Wordmark className="text-white" />
          <div className="my-auto py-10">
            <VaultHero className="mx-auto max-h-[38vh] w-full max-w-[28.75rem] drop-shadow-2xl" />
            <h2 className="mt-6 text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">
              The wrong person can&apos;t reach it.<br />
              <span className="text-gradient">You can prove who did.</span>
            </h2>
            <ul className="mt-8 grid gap-5 xl:grid-cols-3 xl:gap-4 [@media(max-height:860px)]:hidden">
              {POINTS.map((p, i) => (
                <li key={p.title} className={cx('animate-rise rounded-2xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur', staggerClass(i + 2))}>
                  <span className="inline-flex size-9 items-center justify-center rounded-xl bg-white/10 text-brand-200 ring-1 ring-inset ring-white/10">{p.icon}</span>
                  <p className="mt-3 text-sm font-semibold">{p.title}</p>
                  <p className="mt-1 text-xs leading-5 text-brand-100/70">{p.text}</p>
                </li>
              ))}
            </ul>
          </div>
          <p className="flex items-center gap-2 text-xs text-brand-100/60"><ShieldCheck size={16} />Encrypted at rest · Malware-scanned · Tamper-evident audit</p>
        </div>
      </aside>

      <main className="app-backdrop relative flex min-w-0 flex-col">
        <div className="flex items-center justify-between px-5 py-4 sm:px-10 sm:py-5">
          <span className="lg:invisible"><Wordmark /></span>
          <ThemeSwitch />
          <CompactThemeSwitch />
        </div>
        <div className="flex flex-1 items-center justify-center px-5 pb-[max(3rem,env(safe-area-inset-bottom))] sm:px-10">
          <div key={stepKey} className="w-full max-w-[26.25rem] animate-rise">{children}</div>
        </div>
      </main>
    </div>
  );
}

/** Quiet text action (back links, "send a new code") with a 44px tap target (A10). */
export const AUTH_TEXT_ACTION = 'inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg px-2 text-sm text-fg-subtle transition duration-150 ease-out hover:bg-slate-100/70 hover:text-fg active:scale-[0.99] active:bg-slate-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/5 dark:active:bg-white/10';
/** Inline brand link inside a sentence; padded to a 44px tap target on touch screens. */
export const AUTH_INLINE_LINK = 'inline-flex items-center rounded font-medium text-brand-600 underline-offset-2 transition-colors hover:text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-1 dark:text-brand-300 dark:hover:text-brand-200';

export function BackToSignIn({ label = 'Back to sign in', href = '/login', className }: { label?: ReactNode; href?: string; className?: string }) {
  return (
    <Link href={href} className={cx(AUTH_TEXT_ACTION, 'mt-2', className)}>
      <ArrowLeft size={14} />{label}
    </Link>
  );
}

/** The quiet footer line under the sign-in forms. */
export function AuthFootnote() {
  return (
    <p className="mt-10 flex items-center justify-center gap-1.5 text-center text-xs text-fg-subtle">
      <ShieldCheck size={14} className="shrink-0 text-brand-500 dark:text-brand-300" />Every sign-in, download and permission change is recorded.
    </p>
  );
}

const CYCLE:{ id: ThemeChoice; label: string; icon: ReactNode }[] = [
  { id: 'system', label: 'System', icon: <Desktop size={18} /> },
  { id: 'light', label: 'Light', icon: <Sun size={18} /> },
  { id: 'dark', label: 'Dark', icon: <Moon size={18} /> },
];

/** Phones: the header ThemeSwitch is hidden below `sm`, so one button cycles system → light → dark. */
function CompactThemeSwitch() {
  const { theme, setTheme } = useTheme();
  const i = Math.max(0, CYCLE.findIndex((t) => t.id === theme));
  const current = CYCLE[i]!;
  const next = CYCLE[(i + 1) % CYCLE.length]!;
  return (
    <IconButton
      label={`Theme: ${current.label}. Switch to ${next.label.toLowerCase()}`}
      onClick={() => setTheme(next.id)}
      className="size-11! rounded-xl! border border-line bg-raised/80 shadow-soft backdrop-blur sm:hidden dark:bg-white/5"
    >
      {current.icon}
    </IconButton>
  );
}
