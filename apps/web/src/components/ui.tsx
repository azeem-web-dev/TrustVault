'use client';

import { createContext, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import Link from 'next/link';
import {
  CaretDown, CheckCircle, File, FileCsv, FileDoc, FileImage, FileMd, FilePdf, FilePpt, FileTxt, FileXls, Info, Warning, WarningOctagon, X,
} from '@phosphor-icons/react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/* ------------------------------------------------------------------ buttons */

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'soft';
type Size = 'sm' | 'md' | 'lg';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-gradient text-white shadow-glow border-transparent hover:brightness-110 active:brightness-95',
  secondary: 'border-slate-200 bg-white text-slate-700 shadow-soft hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-white/10',
  danger: 'border-red-200 bg-white text-red-600 hover:bg-red-50 hover:border-red-300 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20',
  ghost: 'border-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white',
  soft: 'border-transparent bg-brand-50 text-brand-700 hover:bg-brand-100 dark:bg-brand-500/15 dark:text-brand-200 dark:hover:bg-brand-500/25',
};
const SIZES: Record<Size, string> = {
  sm: 'h-8 px-2.5 text-xs gap-1.5 rounded-lg',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-sm gap-2 rounded-xl',
};

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden className={cx('inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent', className)} />;
}

export function Button({
  variant = 'secondary', size = 'md', icon, loading, className, children, disabled, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: ReactNode; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center border font-medium whitespace-nowrap transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:pointer-events-none disabled:opacity-50 dark:focus-visible:ring-offset-ink-950',
        VARIANTS[variant], SIZES[size], className,
      )}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

/** A link styled as a button (downloads must be real links so the browser handles them). */
export function ButtonLink({ variant = 'secondary', size = 'md', icon, className, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: Size; icon?: ReactNode }) {
  return (
    <a {...rest} className={cx('inline-flex shrink-0 items-center justify-center border font-medium whitespace-nowrap transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50', VARIANTS[variant], SIZES[size], className)}>
      {icon}
      {children}
    </a>
  );
}

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cx('inline-flex size-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white', className)}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------- fields */

const field = 'w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 hover:border-slate-300 focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100 dark:placeholder:text-slate-500 dark:hover:border-white/20 dark:focus:border-brand-400';

export function Input({ className, icon, ...rest }: InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }) {
  if (!icon) return <input {...rest} className={cx(field, 'h-10', rest.type === 'file' && 'h-auto py-2 file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-1 file:text-xs file:font-medium file:text-brand-700 dark:file:bg-brand-500/20 dark:file:text-brand-200', className)} />;
  return (
    <span className={cx('relative block', className)}>
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">{icon}</span>
      <input {...rest} className={cx(field, 'h-10 pl-10')} />
    </span>
  );
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cx('relative block', className)}>
      <select {...rest} className={cx(field, 'h-10 cursor-pointer appearance-none pr-9')} />
      <CaretDown size={14} weight="bold" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
    </span>
  );
}

export const Textarea = ({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...rest} className={cx(field, 'py-2.5', className)} />;

export function Label({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 block text-[0.8125rem] font-medium text-slate-700 dark:text-slate-300">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs leading-5 text-slate-500 dark:text-slate-400">{hint}</span>}
    </label>
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

export function StatCard({ label, value, icon, tone = 'brand', hint, delay = 0 }: { label: string; value: ReactNode; icon: ReactNode; tone?: TileTone; hint?: ReactNode; delay?: number }) {
  return (
    <div style={{ animationDelay: `${delay}ms` }} className="relative animate-rise overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-4 shadow-soft dark:border-white/[0.08] dark:bg-white/[0.03]">
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

type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'violet';
const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-white/10 dark:text-slate-300 dark:ring-white/10',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25',
  red: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25',
  blue: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/25',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/25',
};
const DOTS: Record<Tone, string> = { neutral: 'bg-slate-400', green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500', blue: 'bg-sky-500', violet: 'bg-violet-500' };

export function Badge({ tone = 'neutral', dot, icon, children, className }: { tone?: Tone; dot?: boolean; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold whitespace-nowrap ring-1 ring-inset', TONES[tone], className)}>
      {dot && <span className={cx('size-1.5 rounded-full', DOTS[tone])} />}
      {icon}
      {children}
    </span>
  );
}

export const ACCESS_TONE: Record<string, Tone> = { OWNER: 'violet', MANAGE: 'blue', EDIT: 'amber', READ: 'green', VIEW: 'neutral', NONE: 'neutral' };
export const ACCESS_LABEL: Record<string, string> = { OWNER: 'Owner', MANAGE: 'Manage', EDIT: 'Edit', READ: 'Download', VIEW: 'View only', NONE: 'None' };
export const OUTCOME_TONE = { ALLOWED: 'green', DENIED: 'red', FAILED: 'amber' } as const;

/* ------------------------------------------------------------------- alerts */

export function Alert({ tone = 'red', title, children, onDismiss }: { tone?: 'red' | 'green' | 'amber' | 'blue'; title?: ReactNode; children: ReactNode; onDismiss?: () => void }) {
  const t = {
    red: { c: 'border-red-200 bg-red-50/80 text-red-800 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-200', i: <WarningOctagon size={20} className="text-red-500" /> },
    green: { c: 'border-emerald-200 bg-emerald-50/80 text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200', i: <CheckCircle size={20} className="text-emerald-500" /> },
    amber: { c: 'border-amber-200 bg-amber-50/80 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200', i: <Warning size={20} className="text-amber-500" /> },
    blue: { c: 'border-sky-200 bg-sky-50/80 text-sky-900 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-200', i: <Info size={20} className="text-sky-500" /> },
  }[tone];
  return (
    <div role={tone === 'red' ? 'alert' : 'status'} className={cx('flex animate-pop items-start gap-3 rounded-xl border px-4 py-3 text-sm', t.c)}>
      <span className="mt-px shrink-0">{t.i}</span>
      <div className="min-w-0 flex-1 leading-5">
        {title && <p className="font-semibold">{title}</p>}
        <div className={title ? 'mt-0.5 opacity-90' : ''}>{children}</div>
      </div>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" className="rounded-md p-0.5 opacity-60 hover:opacity-100">
          <X size={14} weight="bold" />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ empty states */

export function EmptyState({ art, title, children, action }: { art?: ReactNode; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex animate-fade-in flex-col items-center px-6 py-12 text-center">
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

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton h-4', className)} />;
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-5">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
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
          <h1 className="text-2xl font-semibold tracking-tight sm:text-[1.75rem]">{title}</h1>
          {subtitle && <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-500 dark:text-slate-400">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ----------------------------------------------------------------- avatars */

const AVATAR_GRADIENTS = [
  'from-indigo-500 to-violet-500', 'from-sky-500 to-indigo-500', 'from-emerald-500 to-teal-500', 'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-500', 'from-fuchsia-500 to-purple-500', 'from-cyan-500 to-blue-500', 'from-lime-500 to-emerald-500',
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
  { ext: ['png', 'jpg', 'jpeg', 'gif', 'webp'], icon: FileImage, tone: 'from-fuchsia-500 to-violet-600', label: 'Image' },
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

/* -------------------------------------------------------------------- modal */

export function Modal({ open, onClose, title, description, icon, children, footer, wide }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; icon?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 animate-fade-in bg-slate-950/50 backdrop-blur-sm" onClick={onClose} />
      <div ref={panel} className={cx('relative flex max-h-[92vh] w-full animate-pop flex-col overflow-hidden rounded-t-3xl border border-slate-200/80 bg-white shadow-lift sm:rounded-3xl dark:border-white/10 dark:bg-ink-900', wide ? 'sm:max-w-2xl' : 'sm:max-w-lg')}>
        <header className="flex items-start gap-3 border-b border-slate-100 px-6 py-5 dark:border-white/[0.06]">
          {icon && <IconTile>{icon}</IconTile>}
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold tracking-tight">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{description}</p>}
          </div>
          <IconButton label="Close" onClick={onClose} className="-mr-2 -mt-1"><X size={18} weight="bold" /></IconButton>
        </header>
        <div className="overflow-y-auto px-6 py-5">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-4 dark:border-white/[0.06] dark:bg-white/[0.02]">{footer}</footer>}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- menu */

/**
 * One accessible dropdown menu for the whole app: account menu, row action
 * menus, sort/filter pickers. Click or Enter/Space/↓ to open, ↑/↓ to move,
 * Enter to choose, Esc or click-outside to close. The caller passes the
 * trigger's *contents* (not a <button>); Menu renders the button itself.
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
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const move = (dir: 1 | -1 | 0) => {
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
    if (!items.length) return;
    const idx = items.findIndex((el) => el === document.activeElement);
    let next = dir === 0 ? 0 : idx + dir;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    items[next]?.focus();
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(true); setTimeout(() => move(0), 0); }
        }}
        className={buttonClassName ?? 'inline-flex items-center gap-1.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50'}
      >
        {typeof button === 'function' ? button(open) : button}
      </button>
      {open && (
        <div
          ref={panel}
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            else if (e.key === 'Home') { e.preventDefault(); move(0); }
            else if (e.key === 'Tab') setOpen(false);
          }}
          className={cx(
            'absolute z-40 min-w-[12rem] max-w-[calc(100vw-2rem)] animate-pop overflow-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-lift dark:border-white/10 dark:bg-ink-900',
            direction === 'up' ? 'bottom-full mb-2' : 'top-full mt-2',
            align === 'end' ? 'right-0' : 'left-0',
            panelClassName,
          )}
        >
          <MenuCtx.Provider value={{ close: () => setOpen(false) }}>{children}</MenuCtx.Provider>
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
    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm outline-none transition',
    'hover:bg-slate-100 focus-visible:bg-slate-100 dark:hover:bg-white/5 dark:focus-visible:bg-white/10',
    danger && 'text-red-600 hover:bg-red-50 focus-visible:bg-red-50 dark:text-red-300 dark:hover:bg-red-500/10 dark:focus-visible:bg-red-500/10',
    selected && 'font-semibold text-brand-700 dark:text-brand-200',
    disabled && 'pointer-events-none opacity-50',
  );
  const inner = <>{icon && <span className="shrink-0 text-slate-400">{icon}</span>}<span className="min-w-0 flex-1 truncate">{children}</span>{selected && <CheckCircle size={15} weight="fill" className="shrink-0 text-brand-500" />}</>;
  if (href && !disabled) {
    return <Link role="menuitem" href={href} className={cls} onClick={() => ctx?.close()}>{inner}</Link>;
  }
  return (
    <button type="button" role="menuitem" aria-disabled={disabled} disabled={disabled} className={cls} onClick={() => { onSelect?.(); ctx?.close(); }}>
      {inner}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-slate-100 dark:bg-white/[0.06]" />;
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <p className="px-3 pb-1 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-400">{children}</p>;
}

/* ---------------------------------------------------------------- segmented */

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: string; icon?: ReactNode; count?: number }[] }) {
  return (
    <div role="tablist" className="inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border border-slate-200/80 bg-slate-100/70 p-1 dark:border-white/[0.08] dark:bg-white/[0.04]">
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={cx(
            'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition',
            value === o.id ? 'bg-white text-slate-900 shadow-soft dark:bg-white/10 dark:text-white' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
          )}
        >
          {o.icon}
          {o.label}
          {o.count !== undefined && <span className="rounded-md bg-slate-200/70 px-1.5 text-[0.6875rem] tabular-nums dark:bg-white/10">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 font-sans text-[0.6875rem] font-medium text-slate-500 shadow-sm dark:border-white/10 dark:bg-white/5 dark:text-slate-400">{children}</kbd>;
}

export function Divider({ label }: { label?: string }) {
  if (!label) return <hr className="border-slate-100 dark:border-white/[0.06]" />;
  return (
    <div className="flex items-center gap-3 text-xs font-medium text-slate-400">
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
