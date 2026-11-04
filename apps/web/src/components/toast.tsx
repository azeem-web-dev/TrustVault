'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle, Info, Warning, WarningCircle, X } from '@phosphor-icons/react';
import { prefersReducedMotion } from '@/lib/hooks';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';
export interface ToastOptions {
  /** A single inline action, e.g. Undo. Clicking it runs `onClick` and dismisses the toast. */
  action?: { label: string; onClick: () => void };
  /** Milliseconds before auto-dismiss (default 4.5s, errors 7s, 8s with an action). */
  duration?: number;
}
/** Shows a toast and returns its id. */
export type ToastFn = (message: string, tone?: ToastTone, options?: ToastOptions) => number;

interface Toast { id: number; tone: ToastTone; message: string; action?: ToastOptions['action']; leaving: boolean }
interface Timer { handle: ReturnType<typeof setTimeout> | null; remaining: number; started: number }

const MAX_VISIBLE = 3;
const EXIT_MS = 200;

const ToastContext = createContext<ToastFn>(() => 0);
const DismissContext = createContext<(id: number) => void>(() => undefined);

const STYLE: Record<ToastTone, { icon: ReactNode; bar: string }> = {
  success: { icon: <CheckCircle size={20} className="text-emerald-500" />, bar: 'before:bg-emerald-500' },
  error: { icon: <WarningCircle size={20} className="text-red-500" />, bar: 'before:bg-red-500' },
  warning: { icon: <Warning size={20} className="text-amber-500" />, bar: 'before:bg-amber-500' },
  info: { icon: <Info size={20} className="text-brand-500" />, bar: 'before:bg-brand-500' },
};

/**
 * Short confirmations in the corner. Errors that need reading stay inline on
 * the page. At most three show at once; hovering or focusing one pauses its
 * timer; errors are announced assertively (role=alert), the rest politely.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, Timer>());
  const removals = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const live = useRef<Toast[]>([]);
  live.current = toasts;

  const remove = useCallback((id: number) => {
    removals.current.delete(id);
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer?.handle) clearTimeout(timer.handle);
    timers.current.delete(id);
    if (removals.current.has(id)) return;
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    removals.current.set(id, setTimeout(() => remove(id), prefersReducedMotion() ? 0 : EXIT_MS));
  }, [remove]);

  const startTimer = useCallback((id: number, ms: number) => {
    const handle = setTimeout(() => dismiss(id), ms);
    timers.current.set(id, { handle, remaining: ms, started: Date.now() });
  }, [dismiss]);

  const pause = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (!t?.handle) return;
    clearTimeout(t.handle);
    timers.current.set(id, { handle: null, remaining: Math.max(1000, t.remaining - (Date.now() - t.started)), started: Date.now() });
  }, []);

  const resume = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (!t || t.handle) return;
    startTimer(id, t.remaining);
  }, [startTimer]);

  const push = useCallback<ToastFn>((message, tone = 'success', options = {}) => {
    const id = next.current++;
    const visible = live.current.filter((x) => !x.leaving);
    // Make room: the oldest leave so no more than MAX_VISIBLE remain.
    visible.slice(0, Math.max(0, visible.length - (MAX_VISIBLE - 1))).forEach((x) => dismiss(x.id));
    setToasts((t) => [...t, { id, tone, message, action: options.action, leaving: false }]);
    startTimer(id, options.duration ?? (options.action ? 8000 : tone === 'error' ? 7000 : 4500));
    return id;
  }, [dismiss, startTimer]);

  useEffect(() => {
    const t = timers.current;
    const r = removals.current;
    return () => {
      t.forEach((x) => { if (x.handle) clearTimeout(x.handle); });
      r.forEach((h) => clearTimeout(h));
    };
  }, []);

  return (
    <ToastContext.Provider value={push}>
      <DismissContext.Provider value={dismiss}>
        {children}
        <div className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-2 pb-[env(safe-area-inset-bottom)] sm:left-auto sm:right-6 sm:bottom-6">
          {toasts.map((t) => (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              data-state={t.leaving ? 'closed' : 'open'}
              onMouseEnter={() => pause(t.id)}
              onMouseLeave={() => resume(t.id)}
              onFocus={() => pause(t.id)}
              onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resume(t.id); }}
              className={`pointer-events-auto relative flex w-full max-w-sm animate-slide-in items-start gap-3 overflow-hidden rounded-xl border border-slate-200/80 bg-white/95 py-2.5 pl-4 pr-1.5 text-sm shadow-lift backdrop-blur before:absolute before:inset-y-0 before:left-0 before:w-1 data-[state=closed]:pointer-events-none data-[state=closed]:animate-toast-out dark:border-white/10 dark:bg-ink-900/95 ${STYLE[t.tone].bar}`}
            >
              <span aria-hidden className="mt-1.5 shrink-0">{STYLE[t.tone].icon}</span>
              <span className="min-w-0 flex-1 py-1.5 leading-5 break-words">{t.message}</span>
              {t.action && (
                <button
                  type="button"
                  onClick={() => { t.action?.onClick(); dismiss(t.id); }}
                  className="mt-0.5 inline-flex h-8 shrink-0 items-center rounded-md px-2.5 text-sm font-semibold text-brand-600 transition hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 dark:text-brand-300 dark:hover:bg-brand-500/15"
                >
                  {t.action.label}
                </button>
              )}
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
                className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-200"
              >
                <X size={14} weight="bold" />
              </button>
            </div>
          ))}
        </div>
      </DismissContext.Provider>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
/** Dismiss a toast early by the id `toast()` returned. */
export const useDismissToast = () => useContext(DismissContext);
