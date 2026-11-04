'use client';

import {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type AnchorHTMLAttributes, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode, type RefObject, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import Link from 'next/link';
import {
  ArrowClockwise, CaretDown, CheckCircle, File, FileCsv, FileDoc, FileImage, FileMd, FilePdf, FilePpt, FileTxt, FileXls, Info, Warning, WarningOctagon, X,
} from '@phosphor-icons/react';
import { useExitState } from '@/lib/hooks';
import { errorText } from '@/lib/api';
import { SpotArt } from './art';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/* ------------------------------------------------------------------ buttons */

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'soft';
type Size = 'sm' | 'md' | 'lg';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-gradient text-white shadow-glow border-transparent hover:brightness-110 active:brightness-95',
  secondary: 'border-slate-200 bg-white text-slate-700 shadow-soft hover:border-slate-300 hover:bg-slate-50 active:bg-slate-100 dark:border-white/10 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-white/10 dark:active:bg-white/15',
  danger: 'border-red-200 bg-white text-red-600 hover:bg-red-50 hover:border-red-300 active:bg-red-100 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20 dark:active:bg-red-500/25',
  ghost: 'border-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white dark:active:bg-white/15',
  soft: 'border-transparent bg-brand-50 text-brand-700 hover:bg-brand-100 active:bg-brand-200/70 dark:bg-brand-500/15 dark:text-brand-200 dark:hover:bg-brand-500/25 dark:active:bg-brand-500/30',
};
// The drawn sizes stay compact; on touch screens an invisible ::before
// extends sm and md to a 44px-tall hit area (§2.4) without moving layout.
const SIZES: Record<Size, string> = {
  sm: 'h-8 px-2.5 text-xs gap-1.5 rounded-lg pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-1.5',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-1',
  lg: 'h-11 px-5 text-sm gap-2 rounded-xl',
};
/** Shared by Button and ButtonLink: focus ring with offset, pressed, disabled and aria-disabled states. */
export const BTN_BASE = 'relative inline-flex shrink-0 select-none items-center justify-center border font-medium whitespace-nowrap transition duration-150 ease-out active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:focus-visible:ring-offset-ink-950';

/** Class string for anything that should look like a Button (e.g. a Link you render yourself). */
export const buttonClass = (variant: Variant = 'secondary', size: Size = 'md', className?: string) => cx(BTN_BASE, VARIANTS[variant], SIZES[size], className);

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden className={cx('inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent', className)} />;
}

export function Button({
  variant = 'secondary', size = 'md', icon, loading, className, children, disabled, type, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: ReactNode; loading?: boolean }) {
  return (
    <button
      type={type ?? 'button'}
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, className)}
    >
      {loading ? (
        icon ? <Spinner /> : <><span aria-hidden className="absolute inset-0 flex items-center justify-center"><Spinner /></span><span className="invisible contents">{children}</span></>
      ) : icon}
      {loading && !icon ? null : children}
    </button>
  );
}

/**
 * A link styled as a button. Internal page hrefs ('/documents/…') use
 * next/link (client navigation); '/api/…' downloads, hashes, external URLs,
 * `download`/`target` links, or `native` stay real <a> elements so the
 * browser handles them. `aria-disabled` makes it inert.
 */
export function ButtonLink({
  variant = 'secondary', size = 'md', icon, className, children, href, native, onClick, ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: Size; icon?: ReactNode; native?: boolean }) {
  const disabled = rest['aria-disabled'] === true || rest['aria-disabled'] === 'true';
  const cls = buttonClass(variant, size, className);
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (disabled) { e.preventDefault(); return; }
    onClick?.(e);
  };
  const internal = !!href && href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/api/') && !native && !rest.download && !rest.target;
  if (internal) {
    return (
      <Link {...rest} href={href} onClick={handleClick} tabIndex={disabled ? -1 : rest.tabIndex} className={cls}>
        {icon}
        {children}
      </Link>
    );
  }
  return (
    <a {...rest} href={href} onClick={handleClick} tabIndex={disabled ? -1 : rest.tabIndex} className={cls}>
      {icon}
      {children}
    </a>
  );
}

export function IconButton({ label, className, children, type, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type={type ?? 'button'}
      {...rest}
      aria-label={label}
      title={label}
      className={cx(
        'relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-slate-500 transition duration-150 hover:bg-slate-100 hover:text-slate-900 active:scale-95 active:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:pointer-events-none disabled:opacity-40 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white dark:active:bg-white/15',
        'pointer-coarse:before:absolute pointer-coarse:before:-inset-1',
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------- fields */

const field = 'w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 hover:border-slate-300 focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-red-400 aria-[invalid=true]:focus:ring-red-500/15 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100 dark:placeholder:text-slate-500 dark:hover:border-white/20 dark:focus:border-brand-400';

export type FieldSize = 'sm' | 'md' | 'lg';
const FIELD_H: Record<FieldSize, string> = { sm: 'h-8', md: 'h-10', lg: 'h-11' };
const FIELD_TEXT: Record<FieldSize, string> = { sm: 'text-xs', md: '', lg: 'text-base' };

/** The class after any `sm:`/`hover:`… variants (brackets respected) and a leading '!'. */
function baseOf(token: string): string {
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === ':' && depth === 0) cut = i + 1;
  }
  return token.slice(cut).replace(/^!/, '');
}
const LAYOUT = /^(-?m[trblxyse]?-|w-|min-w-|max-w-|flex-|flex$|grow|shrink|basis-|col-|row-|self-|order-|justify-self-|place-self-|hidden$|block$|inline|contents$)/;

/**
 * Splits a caller's className: layout classes (width, margin, flex/grid
 * placement, display) go on the wrapper so old callers keep working, and
 * everything else (h-8, text-xs, font-mono…) reaches the control (X11).
 */
function splitField(className: string | undefined, size: FieldSize): { wrap: string; control: string } {
  const wrap: string[] = [];
  const control: string[] = [];
  for (const t of (className ?? '').split(/\s+/).filter(Boolean)) (LAYOUT.test(baseOf(t)) ? wrap : control).push(t);
  const bases = control.map(baseOf);
  const hasH = bases.some((b) => /^h-/.test(b));
  const hasText = bases.some((b) => /^text-(xs|sm|base|lg|xl|\[)/.test(b));
  return { wrap: wrap.join(' '), control: cx(!hasH && FIELD_H[size], !hasText && FIELD_TEXT[size], control.join(' ')) };
}

type FieldExtras = { size?: FieldSize; wrapperClassName?: string };

export function Input({ className, wrapperClassName, icon, size = 'md', ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & FieldExtras & { icon?: ReactNode }) {
  const file = rest.type === 'file' && 'h-auto py-2 file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-1 file:text-xs file:font-medium file:text-brand-700 dark:file:bg-brand-500/20 dark:file:text-brand-200';
  // A file input sizes itself; never force a height on it.
  const { wrap, control } = splitField(file ? cx('h-auto', className) : className, size);
  if (!icon && !wrapperClassName) return <input {...rest} className={cx(field, file, control, wrap)} />;
  return (
    <span className={cx('relative block', wrap, wrapperClassName)}>
      {icon && <span aria-hidden className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">{icon}</span>}
      <input {...rest} className={cx(field, !!icon && 'pl-10', file, control)} />
    </span>
  );
}

export function Select({ className, wrapperClassName, size = 'md', ...rest }: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & FieldExtras) {
  const { wrap, control } = splitField(className, size);
  return (
    <span className={cx('relative block', wrap, wrapperClassName)}>
      <select {...rest} className={cx(field, 'cursor-pointer appearance-none pr-9', size === 'sm' && 'pl-2.5 pr-8', control)} />
      <CaretDown aria-hidden size={size === 'sm' ? 12 : 14} weight="bold" className={cx('pointer-events-none absolute top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400', size === 'sm' ? 'right-2.5' : 'right-3')} />
    </span>
  );
}

export const Textarea = ({ className, wrapperClassName, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { wrapperClassName?: string }) => {
  const el = <textarea {...rest} className={cx(field, 'py-2.5', className)} />;
  return wrapperClassName ? <span className={cx('block', wrapperClassName)}>{el}</span> : el;
};

export function Label({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 block text-[0.8125rem] font-medium text-slate-700 dark:text-slate-300">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs leading-5 text-slate-500 dark:text-slate-400">{hint}</span>}
    </label>
  );
}

/** A styled native checkbox (accent-brand, focus ring). With `label` it renders a full-width clickable row. */
export function Checkbox({ label, description, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label?: ReactNode; description?: ReactNode }) {
  const box = (
    <input
      type="checkbox"
      {...rest}
      className={cx(
        'size-4 shrink-0 cursor-pointer rounded border-slate-300 accent-brand-600 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50 dark:accent-brand-400 dark:focus-visible:ring-offset-ink-950',
        !label && className,
      )}
    />
  );
  if (!label) return box;
  return (
    <label className={cx('flex cursor-pointer items-start gap-2.5 text-sm pointer-coarse:min-h-11 pointer-coarse:items-center has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60', className)}>
      <span className="flex h-5 items-center">{box}</span>
      <span className="min-w-0">
        <span className="block font-medium text-slate-700 dark:text-slate-200">{label}</span>
        {description && <span className="mt-0.5 block text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</span>}
      </span>
    </label>
  );
}

/**
 * An on/off switch (role=switch) with a focus ring, a sliding thumb and a
 * 44px hit area. With `label` it renders a row whose text also toggles it;
 * without one, pass `aria-label`/`aria-labelledby`.
 */
export function Switch({
  checked, onChange, label, description, disabled, className, id, ...aria
}: {
  checked: boolean; onChange: (next: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean; className?: string; id?: string;
  'aria-label'?: string; 'aria-labelledby'?: string; 'aria-describedby'?: string;
}) {
  const auto = useId();
  const sid = id ?? `${auto}-switch`;
  const descId = description ? `${sid}-desc` : undefined;
  const button = (
    <button
      type="button"
      role="switch"
      id={sid}
      aria-checked={checked}
      aria-describedby={aria['aria-describedby'] ?? descId}
      aria-label={aria['aria-label']}
      aria-labelledby={aria['aria-labelledby']}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors duration-200 before:absolute before:-inset-2.5',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-ink-950',
        checked ? 'bg-brand-600 dark:bg-brand-500' : 'bg-slate-300 dark:bg-white/15',
        !label && className,
      )}
    >
      <span
        aria-hidden
        className={cx(
          'pointer-events-none inline-block size-5 rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform duration-200 ease-[cubic-bezier(0.3,1.3,0.5,1)]',
          checked ? 'translate-x-[1.25rem]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
  if (!label) return button;
  return (
    <div className={cx('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <label htmlFor={sid} className={cx('block text-sm font-medium text-slate-800 dark:text-slate-200', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>{label}</label>
        {description && <p id={descId} className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>}
      </div>
      <span className="pt-0.5">{button}</span>
    </div>
  );
}

/* -------------------------------------------------------------------- cards */

export function Card({
  title, icon, description, actions, children, className, padded = true,
}: { title?: ReactNode; icon?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('rounded-2xl border border-slate-200/80 bg-white shadow-soft dark:border-white/[0.08] dark:bg-white/[0.03]', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-white/[0.06]">
          <div className="flex min-w-0 items-center gap-3">
            {icon && <IconTile>{icon}</IconTile>}
            <div className="min-w-0">
              <h2 className="text-[0.9375rem] font-semibold tracking-tight">{title}</h2>
              {description && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

const TILE_TONES = {
  brand: 'bg-brand-50 text-brand-600 ring-brand-100 dark:bg-brand-500/15 dark:text-brand-300 dark:ring-brand-400/20',
  green: 'bg-emerald-50 text-emerald-600 ring-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/20',
  amber: 'bg-amber-50 text-amber-600 ring-amber-100 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/20',
  orange: 'bg-orange-50 text-orange-600 ring-orange-100 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-orange-400/20',
  red: 'bg-red-50 text-red-600 ring-red-100 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-400/20',
  blue: 'bg-sky-50 text-sky-600 ring-sky-100 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-400/20',
  violet: 'bg-violet-50 text-violet-600 ring-violet-100 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-400/20',
  slate: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-white/10 dark:text-slate-300 dark:ring-white/10',
} as const;
export type TileTone = keyof typeof TILE_TONES;

export function IconTile({ tone = 'brand', size = 'md', children }: { tone?: TileTone; size?: 'sm' | 'md' | 'lg'; children: ReactNode }) {
  const s = { sm: 'size-8 rounded-lg', md: 'size-10 rounded-xl', lg: 'size-12 rounded-2xl' }[size];
  return <span className={cx('inline-flex shrink-0 items-center justify-center ring-1 ring-inset', s, TILE_TONES[tone])}>{children}</span>;
}

const STAGGER = ['', 'stagger-1', 'stagger-2', 'stagger-3', 'stagger-4', 'stagger-5', 'stagger-6', 'stagger-7', 'stagger-8'];
/** Class for the n-th item of a staggered enter animation (40ms steps, capped at 8). No style attribute, so CSP-safe. */
export const staggerClass = (index: number) => STAGGER[Math.max(0, Math.min(8, Math.round(index)))] ?? '';

export function StatCard({ label, value, icon, tone = 'brand', hint, delay = 0 }: { label: string; value: ReactNode; icon: ReactNode; tone?: TileTone; hint?: ReactNode; delay?: number }) {
  return (
    <div className={cx('relative animate-rise overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-4 shadow-soft dark:border-white/[0.08] dark:bg-white/[0.03]', staggerClass(delay / 40))}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
          <p className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
        </div>
        <IconTile tone={tone}>{icon}</IconTile>
      </div>
      {hint && <p className="mt-2 truncate text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------- badges */

export type Tone = 'neutral' | 'green' | 'amber' | 'orange' | 'red' | 'blue' | 'violet';
export type BadgeTone = Tone;
const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-white/10 dark:text-slate-300 dark:ring-white/10',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25',
  orange: 'bg-orange-50 text-orange-700 ring-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-500/25',
  red: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25',
  blue: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/25',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/25',
};
const DOTS: Record<Tone, string> = { neutral: 'bg-slate-400', green: 'bg-emerald-500', amber: 'bg-amber-500', orange: 'bg-orange-500', red: 'bg-red-500', blue: 'bg-sky-500', violet: 'bg-violet-500' };

export function Badge({ tone = 'neutral', dot, icon, children, className }: { tone?: Tone; dot?: boolean; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold whitespace-nowrap ring-1 ring-inset', TONES[tone], className)}>
      {dot && <span aria-hidden className={cx('size-1.5 rounded-full', DOTS[tone])} />}
      {icon}
      {children}
    </span>
  );
}

export const ACCESS_TONE: Record<string, Tone> = { OWNER: 'violet', MANAGE: 'blue', EDIT: 'amber', READ: 'green', VIEW: 'neutral', NONE: 'neutral' };
export const ACCESS_LABEL: Record<string, string> = { OWNER: 'Owner', MANAGE: 'Manage', EDIT: 'Edit', READ: 'Download', VIEW: 'View only', NONE: 'None' };
export const OUTCOME_TONE = { ALLOWED: 'green', DENIED: 'red', FAILED: 'amber' } as const;
/** One severity scale for pills, stat tiles and side bars (§2.1): critical red, high orange, medium amber, low blue, info slate. */
export const SEVERITY_TONE: Record<string, Tone> = { CRITICAL: 'red', HIGH: 'orange', MEDIUM: 'amber', LOW: 'blue', INFO: 'neutral' };
export const SEVERITY_TILE_TONE: Record<string, TileTone> = { CRITICAL: 'red', HIGH: 'orange', MEDIUM: 'amber', LOW: 'blue', INFO: 'slate' };

/* ------------------------------------------------------------------- alerts */

export type AlertTone = 'red' | 'green' | 'amber' | 'orange' | 'blue';

export function Alert({ tone = 'red', title, children, onDismiss, action, className }: { tone?: AlertTone; title?: ReactNode; children: ReactNode; onDismiss?: () => void; action?: ReactNode; className?: string }) {
  const t = {
    red: { c: 'border-red-200 bg-red-50/80 text-red-800 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-200', i: <WarningOctagon size={20} className="text-red-500" /> },
    green: { c: 'border-emerald-200 bg-emerald-50/80 text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200', i: <CheckCircle size={20} className="text-emerald-500" /> },
    amber: { c: 'border-amber-200 bg-amber-50/80 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200', i: <Warning size={20} className="text-amber-500" /> },
    orange: { c: 'border-orange-200 bg-orange-50/80 text-orange-900 dark:border-orange-500/25 dark:bg-orange-500/10 dark:text-orange-200', i: <Warning size={20} className="text-orange-500" /> },
    blue: { c: 'border-sky-200 bg-sky-50/80 text-sky-900 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-200', i: <Info size={20} className="text-sky-500" /> },
  }[tone];
  return (
    <div role={tone === 'red' ? 'alert' : 'status'} className={cx('flex animate-pop items-start gap-3 rounded-xl border px-4 py-3 text-sm', t.c, className)}>
      <span aria-hidden className="mt-px shrink-0">{t.i}</span>
      <div className="min-w-0 flex-1 leading-5 break-words">
        {title && <p className="font-semibold">{title}</p>}
        <div className={title ? 'mt-0.5 opacity-90' : ''}>{children}</div>
        {action && <div className="mt-2.5 flex flex-wrap gap-2">{action}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-my-1.5 -mr-2 inline-flex size-8 shrink-0 items-center justify-center rounded-md opacity-70 transition hover:bg-black/5 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 dark:hover:bg-white/10"
        >
          <X size={14} weight="bold" />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ empty states */

export function EmptyState({ art, title, children, action, className }: { art?: ReactNode; title?: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex animate-fade-in flex-col items-center px-6 py-12 text-center', className)}>
      {art && <div className="mb-4">{art}</div>}
      {title && <p className="text-[0.9375rem] font-semibold">{title}</p>}
      {children && <div className="mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <EmptyState>{children}</EmptyState>;
}

/**
 * The first load failed (X3): says so and offers Retry, instead of an
 * endless skeleton. `compact` renders an inline alert for use inside cards.
 */
export function LoadError({
  error, onRetry, retrying, title = "Couldn't load this", compact, className,
}: { error?: unknown; onRetry?: () => void; retrying?: boolean; title?: string; compact?: boolean; className?: string }) {
  const message = typeof error === 'string' ? error : error ? errorText(error, 'Check your connection and try again.') : 'Check your connection and try again.';
  const retry = onRetry && (
    <Button size={compact ? 'sm' : 'md'} icon={<ArrowClockwise size={compact ? 14 : 16} weight="bold" />} loading={retrying} onClick={onRetry}>Try again</Button>
  );
  if (compact) {
    return <div className={className}><Alert tone="red" title={title} action={retry}>{message}</Alert></div>;
  }
  return (
    <div role="alert" className={className}>
      <EmptyState art={<SpotArt tone="red" icon={<WarningOctagon size={30} weight="duotone" />} />} title={title} action={retry}>
        {message}
      </EmptyState>
    </div>
  );
}

export function Skeleton({ className, as = 'div' }: { className?: string; as?: 'div' | 'span' }) {
  if (as === 'span') return <span aria-hidden className={cx('skeleton inline-block h-4 align-middle', className)} />;
  return <div aria-hidden className={cx('skeleton h-4', className)} />;
}

export function SkeletonRows({ rows = 4, label = 'Loading…', className }: { rows?: number; label?: string; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={cx('space-y-3 p-5', className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-xl" />
          <div className="flex-1 space-y-2"><Skeleton className="h-3.5 w-1/3" /><Skeleton className="h-3 w-1/2" /></div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- page header */

export function PageTitle({ title, subtitle, actions, icon, eyebrow }: { title: string; subtitle?: ReactNode; actions?: ReactNode; icon?: ReactNode; eyebrow?: string }) {
  return (
    <div className="mb-7 flex animate-rise flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 items-start gap-4">
        {icon && (
          <span className="hidden size-12 shrink-0 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-glow sm:inline-flex">{icon}</span>
        )}
        <div className="min-w-0">
          {eyebrow && <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-300">{eyebrow}</p>}
          <h1 className="text-2xl font-semibold tracking-tight break-words sm:text-[1.75rem]">{title}</h1>
          {subtitle && <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-500 dark:text-slate-400">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ----------------------------------------------------------------- avatars */

const AVATAR_GRADIENTS = [
  'from-brand-500 to-violet-500', 'from-sky-500 to-brand-500', 'from-emerald-500 to-teal-500', 'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-500', 'from-violet-500 to-purple-500', 'from-cyan-500 to-blue-500', 'from-lime-500 to-emerald-500',
];

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase();
}

export function Avatar({ name, size = 'md', className }: { name: string; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; className?: string }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const s = { xs: 'size-6 text-[0.625rem]', sm: 'size-8 text-xs', md: 'size-9 text-xs', lg: 'size-12 text-base', xl: 'size-16 text-xl' }[size];
  return (
    <span aria-hidden className={cx('inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-semibold text-white ring-2 ring-white dark:ring-ink-950', AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length], s, className)}>
      {initials(name)}
    </span>
  );
}

export function AvatarStack({ names, max = 4 }: { names: string[]; max?: number }) {
  const shown = names.slice(0, max);
  return (
    <div className="flex -space-x-2">
      {shown.map((n, i) => <Avatar key={`${n}-${i}`} name={n} size="sm" />)}
      {names.length > max && (
        <span className="inline-flex size-8 items-center justify-center rounded-full bg-slate-100 text-[0.6875rem] font-semibold text-slate-600 ring-2 ring-white dark:bg-white/10 dark:text-slate-300 dark:ring-ink-950">+{names.length - max}</span>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- file icon */

const FILE_TYPES: { ext: string[]; icon: typeof File; tone: string; label: string }[] = [
  { ext: ['pdf'], icon: FilePdf, tone: 'from-rose-500 to-red-600', label: 'PDF' },
  { ext: ['doc', 'docx'], icon: FileDoc, tone: 'from-sky-500 to-blue-600', label: 'Word' },
  { ext: ['xls', 'xlsx'], icon: FileXls, tone: 'from-emerald-500 to-green-600', label: 'Excel' },
  { ext: ['ppt', 'pptx'], icon: FilePpt, tone: 'from-orange-400 to-orange-600', label: 'PowerPoint' },
  { ext: ['png', 'jpg', 'jpeg', 'gif', 'webp'], icon: FileImage, tone: 'from-violet-500 to-purple-600', label: 'Image' },
  { ext: ['csv'], icon: FileCsv, tone: 'from-teal-500 to-cyan-600', label: 'CSV' },
  { ext: ['md'], icon: FileMd, tone: 'from-slate-500 to-slate-700', label: 'Markdown' },
  { ext: ['txt'], icon: FileTxt, tone: 'from-slate-400 to-slate-600', label: 'Text' },
];

export function fileType(fileName?: string | null) {
  const ext = fileName?.split('.').pop()?.toLowerCase() ?? '';
  return FILE_TYPES.find((t) => t.ext.includes(ext)) ?? { ext: [], icon: File, tone: 'from-slate-400 to-slate-600', label: ext ? ext.toUpperCase() : 'File' };
}

export function FileIcon({ fileName, size = 'md' }: { fileName?: string | null; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const t = fileType(fileName);
  const Icon = t.icon;
  const s = { sm: ['size-8 rounded-lg', 16], md: ['size-10 rounded-xl', 20], lg: ['size-12 rounded-xl', 24], xl: ['size-16 rounded-2xl', 32] }[size] as [string, number];
  return (
    <span className={cx('relative inline-flex shrink-0 items-center justify-center bg-gradient-to-br text-white shadow-sm ring-1 ring-inset ring-white/20', t.tone, s[0])}>
      <Icon size={s[1]} weight="duotone" />
    </span>
  );
}

/* ------------------------------------------------------- overlay plumbing */

/*
 * Every overlay (Modal, Drawer, Menu) registers a layer while open. One
 * document keydown listener sends Escape to the topmost layer only (X2), and
 * keeps Tab inside it when it traps focus. A component that handles Escape
 * itself (e.g. the command palette) calls preventDefault/stopPropagation and
 * the layers below leave it alone.
 */
type Layer = { escape: () => void; panel: () => HTMLElement | null; trap: boolean };
const layers: Layer[] = [];

const FOCUSABLE = 'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
const visible = (el: HTMLElement) => el.getClientRects().length > 0 && !el.closest('[inert]');
const focusables = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);

function trapTab(e: KeyboardEvent, panel: HTMLElement | null) {
  if (!panel) return;
  const active = document.activeElement as HTMLElement | null;
  if (!active || !panel.contains(active)) {
    // Focus sits in another modal surface stacked above (e.g. the palette): not ours to move.
    if (active && active !== document.body && active.closest('[aria-modal="true"]')) return;
    e.preventDefault();
    (focusables(panel)[0] ?? panel).focus();
    return;
  }
  const items = focusables(panel);
  if (!items.length) { e.preventDefault(); panel.focus(); return; }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (e.shiftKey && (active === first || active === panel)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}

function onLayerKey(e: KeyboardEvent) {
  const top = layers[layers.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    if (e.defaultPrevented) return;
    e.preventDefault();
    top.escape();
  } else if (e.key === 'Tab' && top.trap) {
    trapTab(e, top.panel());
  }
}

/**
 * Registers an overlay layer while `active`. Escape calls `onEscape` only
 * when this is the topmost layer; with `trap`, Tab cycles inside `panel`.
 */
export function useLayer(active: boolean, onEscape: () => void, opts: { panel?: RefObject<HTMLElement | null>; trap?: boolean } = {}) {
  const escape = useRef(onEscape);
  useEffect(() => { escape.current = onEscape; });
  const { panel, trap = false } = opts;
  useEffect(() => {
    if (!active) return;
    const layer: Layer = { escape: () => escape.current(), panel: () => panel?.current ?? null, trap };
    layers.push(layer);
    if (layers.length === 1) document.addEventListener('keydown', onLayerKey);
    return () => {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
      if (layers.length === 0) document.removeEventListener('keydown', onLayerKey);
    };
  }, [active, trap, panel]);
}

let scrollLocks = 0;
let savedOverflow = '';
function lockScroll(): () => void {
  if (scrollLocks++ === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--scrollLocks === 0) document.body.style.overflow = savedOverflow;
  };
}

const FIELD_SELECTOR = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])';

/**
 * On open: focus `[data-autofocus]`, else the first field in `body`, else
 * the panel itself (never the header Close button, X1). If the panel got
 * focus and a `[data-autofocus]` element renders later (async content), it
 * takes focus then. On close: focus goes back to whatever opened it.
 * Depends on `open` only, so parent re-renders never move focus.
 */
function useDialogFocus(open: boolean, panel: RefObject<HTMLElement | null>, body?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const el = panel.current;
    let observer: MutationObserver | null = null;
    if (el && !el.contains(document.activeElement)) {
      const auto = el.querySelector<HTMLElement>('[data-autofocus]');
      const firstField = Array.from(body?.current?.querySelectorAll<HTMLElement>(FIELD_SELECTOR) ?? []).find(visible);
      (auto ?? firstField ?? el).focus({ preventScroll: true });
    }
    if (el && document.activeElement === el && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(() => {
        if (document.activeElement !== el) { observer?.disconnect(); return; }
        const late = el.querySelector<HTMLElement>('[data-autofocus]');
        if (late) { late.focus({ preventScroll: true }); observer?.disconnect(); }
      });
      observer.observe(el, { childList: true, subtree: true });
    }
    return () => {
      observer?.disconnect();
      const now = document.activeElement;
      const ours = !now || now === document.body || (el?.contains(now) ?? false);
      if (ours && opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

/* -------------------------------------------------------------------- modal */

/**
 * Dialog (bottom sheet below `sm`). Focus goes to `[data-autofocus]` or the
 * first field, Tab stays inside, Escape closes only the topmost layer, focus
 * returns to the opener, and it animates out. `onClose` may be an inline
 * arrow: it is read through a ref and never re-runs the focus logic.
 */
export function Modal({ open, onClose, title, description, icon, children, footer, wide, className, closeLabel = 'Close', dismissible = true }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; icon?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean;
  className?: string; closeLabel?: string;
  /** false: Escape and the backdrop do nothing (e.g. while a confirm runs). The Close button stays. */
  dismissible?: boolean;
}) {
  const { mounted, state } = useExitState(open, 200);
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  const dismiss = useRef(dismissible);
  useEffect(() => { dismiss.current = dismissible; });
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;

  useLayer(open, () => { if (dismiss.current) close.current(); }, { panel, trap: true });
  useEffect(() => (open ? lockScroll() : undefined), [open]);
  useDialogFocus(open, panel, body);

  if (!mounted) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6" data-state={state} inert={state === 'closed' || undefined}>
      <div
        aria-hidden
        data-state={state}
        className="absolute inset-0 animate-fade-in bg-slate-950/50 backdrop-blur-sm data-[state=closed]:animate-fade-out"
        onClick={() => { if (dismiss.current) close.current(); }}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        data-state={state}
        className={cx(
          'relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-slate-200/80 bg-white shadow-lift outline-none sm:rounded-3xl dark:border-white/10 dark:bg-ink-900',
          'max-sm:animate-sheet-up sm:animate-pop max-sm:data-[state=closed]:animate-sheet-down sm:data-[state=closed]:animate-pop-out',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-lg',
          className,
        )}
      >
        <span aria-hidden className="mx-auto mt-2 block h-1 w-10 shrink-0 rounded-full bg-slate-200 sm:hidden dark:bg-white/15" />
        <header className="flex items-start gap-3 border-b border-slate-100 px-6 pb-4 pt-3 sm:py-5 dark:border-white/[0.06]">
          {icon && <IconTile>{icon}</IconTile>}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold tracking-tight break-words">{title}</h2>
            {description && <p id={descId} className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{description}</p>}
          </div>
          <IconButton label={closeLabel} onClick={() => close.current()} className="-mr-2 -mt-1"><X size={18} weight="bold" /></IconButton>
        </header>
        <div ref={body} className={cx('min-h-0 overflow-y-auto overscroll-contain px-6 py-5', !footer && 'max-sm:pb-[max(1.25rem,env(safe-area-inset-bottom))]')}>{children}</div>
        {footer && (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-4 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))] dark:border-white/[0.06] dark:bg-white/[0.02]">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- drawer */

/**
 * Side drawer (X8): role=dialog, Escape (topmost only), focus moved in and
 * trapped, focus restored, scroll locked, animated in and out. Give it a
 * `title` for a header with a Close button, or a `label` when the children
 * bring their own header (e.g. the nav sidebar).
 */
export function Drawer({
  open, onClose, title, label, side = 'left', children, footer, className, rootClassName, closeLabel = 'Close',
}: {
  open: boolean; onClose: () => void; title?: ReactNode; label?: string; side?: 'left' | 'right'; children: ReactNode; footer?: ReactNode;
  className?: string; rootClassName?: string; closeLabel?: string;
}) {
  const { mounted, state } = useExitState(open, 200);
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  const titleId = `${useId()}-title`;

  useLayer(open, () => close.current(), { panel, trap: true });
  useEffect(() => (open ? lockScroll() : undefined), [open]);
  useDialogFocus(open, panel, body);

  if (!mounted) return null;
  const left = side === 'left';
  return (
    <div className={cx('fixed inset-0 z-40', rootClassName)} data-state={state} inert={state === 'closed' || undefined}>
      <div aria-hidden data-state={state} className="absolute inset-0 animate-fade-in bg-slate-950/50 backdrop-blur-sm data-[state=closed]:animate-fade-out" onClick={() => close.current()} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : label}
        tabIndex={-1}
        data-state={state}
        className={cx(
          'absolute inset-y-0 flex w-[17.5rem] max-w-[85vw] flex-col bg-white shadow-lift outline-none dark:bg-ink-900',
          left
            ? 'left-0 animate-drawer border-r border-slate-200 data-[state=closed]:animate-drawer-out dark:border-white/10'
            : 'right-0 animate-drawer-right border-l border-slate-200 data-[state=closed]:animate-drawer-right-out dark:border-white/10',
          className,
        )}
      >
        {title ? (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-white/[0.06]">
              <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold">{title}</h2>
              <IconButton label={closeLabel} onClick={() => close.current()}><X size={18} weight="bold" /></IconButton>
            </div>
            <div ref={body} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
          </>
        ) : (
          <div ref={body} className="flex min-h-0 flex-1 flex-col">{children}</div>
        )}
        {footer && <div className="border-t border-slate-100 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] dark:border-white/[0.06]">{footer}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ confirm */

export function ConfirmDialog({
  open, onClose, onConfirm, title, children, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, loading, error, icon,
}: {
  open: boolean; onClose: () => void; onConfirm: () => void; title: ReactNode; children?: ReactNode;
  confirmLabel?: string; cancelLabel?: string; danger?: boolean; loading?: boolean; error?: ReactNode; icon?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={() => { if (!loading) onClose(); }}
      dismissible={!loading}
      title={title}
      icon={icon ?? (danger ? <WarningOctagon size={20} /> : undefined)}
      footer={(
        <>
          <Button data-autofocus={danger ? true : undefined} disabled={loading} onClick={onClose}>{cancelLabel}</Button>
          <Button data-autofocus={danger ? undefined : true} variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      )}
    >
      <div className="space-y-3">
        {children && <div className="text-sm leading-6 text-slate-600 dark:text-slate-300">{children}</div>}
        {error && <Alert tone="red">{error}</Alert>}
      </div>
    </Modal>
  );
}

export interface ConfirmOptions {
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  icon?: ReactNode;
  /** Optional work to run from the dialog: the button spins, an error keeps the dialog open and is shown in it, success closes it. */
  onConfirm?: () => Promise<unknown> | unknown;
}

/**
 * Promise-based confirm. Render the returned element once; `confirm()`
 * resolves true when the user confirms (and `onConfirm`, if given, succeeds)
 * or false on Cancel/Escape.
 *
 *   const [confirm, confirmDialog] = useConfirm();
 *   if (!(await confirm({ title: 'Revoke access?', danger: true, confirmLabel: 'Revoke' }))) return;
 *   …
 *   return <>{…}{confirmDialog}</>;
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [req, setReq] = useState<ConfirmOptions | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  useEffect(() => () => { resolver.current?.(false); resolver.current = null; }, []);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setReq(options);
    setError(null);
    setBusy(false);
    setOpen(true);
  }), []);

  const settle = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setOpen(false);
  };

  const onConfirm = async () => {
    if (!req || busy) return;
    if (!req.onConfirm) { settle(true); return; }
    setBusy(true);
    setError(null);
    try {
      await req.onConfirm();
      settle(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <ConfirmDialog
      open={open}
      onClose={() => settle(false)}
      onConfirm={() => void onConfirm()}
      title={req?.title ?? ''}
      confirmLabel={req?.confirmLabel}
      cancelLabel={req?.cancelLabel}
      danger={req?.danger}
      icon={req?.icon}
      loading={busy}
      error={error}
    >
      {req?.body}
    </ConfirmDialog>
  );
  return [confirm, dialog];
}

/* --------------------------------------------------------------------- menu */

/**
 * One accessible dropdown menu for the whole app: account menu, row action
 * menus, sort/filter pickers. Click or Enter/Space/↓ to open, ↑/↓ to move,
 * Enter to choose, Esc or click-outside to close. The caller passes the
 * trigger's *contents* (not a <button>); Menu renders the button itself.
 * Escape closes only the menu (not a dialog under it) and focus returns to
 * the trigger.
 */
const MenuCtx = createContext<{ close: () => void } | null>(null);

export function Menu({ button, label, children, align = 'end', direction = 'down', buttonClassName, panelClassName }: {
  button: ReactNode | ((open: boolean) => ReactNode);
  label: string;
  children: ReactNode;
  align?: 'start' | 'end';
  direction?: 'down' | 'up';
  buttonClassName?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const { mounted, state } = useExitState(open, 120);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const closeAndFocus = useCallback(() => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }, []);

  useLayer(open, closeAndFocus);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, [open]);

  const move = (dir: 1 | -1 | 0 | 'end') => {
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
    if (!items.length) return;
    const idx = items.findIndex((el) => el === document.activeElement);
    let next = dir === 0 ? 0 : dir === 'end' ? items.length - 1 : idx + dir;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    items[next]?.focus();
  };

  const up = direction === 'up';
  const origin = up ? (align === 'end' ? 'origin-bottom-right' : 'origin-bottom-left') : (align === 'end' ? 'origin-top-right' : 'origin-top-left');
  const ctx = useMemo(() => ({ close: closeAndFocus }), [closeAndFocus]);

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(true); setTimeout(() => move(0), 0); }
          else if (!open && e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setTimeout(() => move('end'), 0); }
        }}
        className={buttonClassName ?? 'inline-flex items-center gap-1.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50'}
      >
        {typeof button === 'function' ? button(open) : button}
      </button>
      {mounted && (
        <div
          ref={panel}
          role="menu"
          aria-label={label}
          data-state={state}
          inert={state === 'closed' || undefined}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            else if (e.key === 'Home') { e.preventDefault(); move(0); }
            else if (e.key === 'End') { e.preventDefault(); move('end'); }
            else if (e.key === 'Tab') setOpen(false);
          }}
          className={cx(
            'absolute z-40 min-w-[12rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-lift dark:border-white/10 dark:bg-ink-900',
            up ? 'bottom-full mb-2 animate-pop-up data-[state=closed]:animate-pop-up-out' : 'top-full mt-2 animate-pop data-[state=closed]:animate-menu-out',
            origin,
            align === 'end' ? 'right-0' : 'left-0',
            panelClassName,
          )}
        >
          <MenuCtx.Provider value={ctx}>{children}</MenuCtx.Provider>
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, onSelect, href, danger, disabled, selected }: {
  icon?: ReactNode; children: ReactNode; onSelect?: () => void; href?: string; danger?: boolean; disabled?: boolean; selected?: boolean;
}) {
  const ctx = useContext(MenuCtx);
  const cls = cx(
    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm outline-none transition pointer-coarse:min-h-11',
    'hover:bg-slate-100 focus-visible:bg-slate-100 active:bg-slate-200/70 dark:hover:bg-white/5 dark:focus-visible:bg-white/10 dark:active:bg-white/10',
    danger && 'text-red-600 hover:bg-red-50 focus-visible:bg-red-50 dark:text-red-300 dark:hover:bg-red-500/10 dark:focus-visible:bg-red-500/10',
    selected && 'font-semibold text-brand-700 dark:text-brand-200',
    disabled && 'pointer-events-none opacity-50',
  );
  const inner = <>{icon && <span aria-hidden className="shrink-0 text-slate-400">{icon}</span>}<span className="min-w-0 flex-1 truncate">{children}</span>{selected && <CheckCircle aria-hidden size={15} weight="fill" className="shrink-0 text-brand-500" />}</>;
  if (href && !disabled) {
    return <Link role="menuitem" href={href} className={cls} onClick={() => ctx?.close()}>{inner}</Link>;
  }
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled}
      aria-checked={selected === undefined ? undefined : selected}
      disabled={disabled}
      className={cls}
      onClick={() => { ctx?.close(); onSelect?.(); }}
    >
      {inner}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-slate-100 dark:bg-white/[0.06]" />;
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <p className="px-3 pb-1 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">{children}</p>;
}

/* ---------------------------------------------------------------- segmented */

/** Props for the panel a `mode="tabs"` Segmented controls (pass the same `idBase`). */
export const tabPanelProps = (idBase: string, id: string) => ({ id: `${idBase}-panel-${id}`, role: 'tabpanel' as const, 'aria-labelledby': `${idBase}-tab-${id}`, tabIndex: 0 });

/**
 * A pill switcher. `mode="tabs"` (default) is an ARIA tablist with roving
 * tabindex and ←/→/Home/End; pass `idBase` and spread `tabPanelProps` on
 * the panel to link them. `mode="filter"` is a button group with
 * aria-pressed, for filters that don't swap a panel (X11).
 */
export function Segmented<T extends string>({
  value, onChange, options, mode = 'tabs', label, idBase, size = 'md', className,
}: {
  value: T; onChange: (v: T) => void; options: { id: T; label: string; icon?: ReactNode; count?: number }[];
  mode?: 'tabs' | 'filter'; label?: string; idBase?: string; size?: 'sm' | 'md'; className?: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const tabs = mode === 'tabs';

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (!tabs) return;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const o = options[next];
    if (!o) return;
    onChange(o.id);
    refs.current.get(o.id)?.focus();
  };

  return (
    <div
      role={tabs ? 'tablist' : 'group'}
      aria-label={label}
      className={cx('inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border border-slate-200/80 bg-slate-100/70 p-1 dark:border-white/[0.08] dark:bg-white/[0.04]', className)}
    >
      {options.map((o, i) => {
        const on = value === o.id;
        return (
          <button
            key={o.id}
            ref={(el) => { if (el) refs.current.set(o.id, el); else refs.current.delete(o.id); }}
            type="button"
            role={tabs ? 'tab' : undefined}
            aria-selected={tabs ? on : undefined}
            aria-pressed={tabs ? undefined : on}
            aria-controls={tabs && idBase ? `${idBase}-panel-${o.id}` : undefined}
            id={tabs && idBase ? `${idBase}-tab-${o.id}` : undefined}
            tabIndex={tabs ? (on ? 0 : -1) : undefined}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cx(
              'relative inline-flex items-center gap-2 rounded-lg font-medium whitespace-nowrap transition duration-150 active:scale-[0.97]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-1.5',
              size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
              on ? 'bg-white text-slate-900 shadow-soft dark:bg-white/10 dark:text-white' : 'text-slate-500 hover:bg-white/50 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-slate-200',
            )}
          >
            {o.icon}
            {o.label}
            {o.count !== undefined && <span className="rounded-md bg-slate-200/70 px-1.5 text-[0.6875rem] tabular-nums dark:bg-white/10">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------- combobox nav */

/**
 * Keyboard + ARIA plumbing for a text input that drives a listbox (search
 * pickers, the command palette). Spread `inputProps` on the input,
 * `listProps` on the list and `optionProps(i)` on each option. ↑/↓/Home/End
 * move, Enter selects, the active option scrolls into view.
 */
export function useListNav({ count, onSelect, open = true, loop = true }: { count: number; onSelect: (index: number) => void; open?: boolean; loop?: boolean }) {
  const base = useId();
  const listId = `${base}-list`;
  const [active, setActive] = useState(-1);
  const select = useRef(onSelect);
  useEffect(() => { select.current = onSelect; });

  // Keep the active index inside the list as it changes; start at the top.
  useEffect(() => {
    setActive((a) => (count === 0 ? -1 : a < 0 ? 0 : Math.min(a, count - 1)));
  }, [count]);

  const optionId = useCallback((i: number) => `${base}-opt-${i}`, [base]);

  useEffect(() => {
    if (active < 0 || !open) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }, [active, open, optionId]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (!open || count === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1 >= count ? (loop ? 0 : count - 1) : a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 < 0 ? (loop ? count - 1 : 0) : a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(count - 1); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); select.current(active); }
  };

  return {
    active,
    setActive,
    onKeyDown,
    listId,
    optionId,
    inputProps: {
      role: 'combobox' as const,
      'aria-expanded': open,
      'aria-controls': listId,
      'aria-autocomplete': 'list' as const,
      'aria-activedescendant': open && active >= 0 && count > 0 ? optionId(active) : undefined,
      onKeyDown,
    },
    listProps: { id: listId, role: 'listbox' as const },
    optionProps: (i: number) => ({
      id: optionId(i),
      role: 'option' as const,
      'aria-selected': i === active,
      'data-active': i === active ? '' : undefined,
      onMouseMove: () => { if (i !== active) setActive(i); },
      // Keep focus in the input when an option is clicked.
      onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
      onClick: () => select.current(i),
    }),
  };
}

/* ------------------------------------------------------------------- misc */

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 font-sans text-[0.6875rem] font-medium text-slate-500 shadow-sm dark:border-white/10 dark:bg-white/5 dark:text-slate-400">{children}</kbd>;
}

export function Divider({ label }: { label?: string }) {
  if (!label) return <hr className="border-slate-100 dark:border-white/[0.06]" />;
  return (
    <div className="flex items-center gap-3 text-xs font-medium text-fg-subtle">
      <span className="h-px flex-1 bg-slate-200 dark:bg-white/10" />{label}<span className="h-px flex-1 bg-slate-200 dark:bg-white/10" />
    </div>
  );
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  const abs = Math.abs(diff);
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60) return fmt.format(-Math.round(diff), 'second');
  if (abs < 3600) return fmt.format(-Math.round(diff / 60), 'minute');
  if (abs < 86400) return fmt.format(-Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return fmt.format(-Math.round(diff / 86400), 'day');
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}
