'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { CheckCircle, Info, WarningCircle, X } from '@phosphor-icons/react';

type Tone = 'success' | 'error' | 'info';
interface Toast { id: number; tone: Tone; message: string }

const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => undefined);

const STYLE: Record<Tone, { icon: ReactNode; ring: string }> = {
  success: { icon: <CheckCircle size={20} className="text-emerald-500" />, ring: 'before:bg-emerald-500' },
  error: { icon: <WarningCircle size={20} className="text-red-500" />, ring: 'before:bg-red-500' },
  info: { icon: <Info size={20} className="text-brand-500" />, ring: 'before:bg-brand-500' },
};

/** Short confirmations in the corner. Errors that need reading stay inline on the page. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((message: string, tone: Tone = 'success') => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-3), { id, tone, message }]);
    setTimeout(() => dismiss(id), tone === 'error' ? 7000 : 4500);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-2 sm:left-auto sm:right-6 sm:bottom-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto relative flex w-full max-w-sm animate-slide-in items-start gap-3 overflow-hidden rounded-xl border border-slate-200/80 bg-white/95 py-3 pl-4 pr-3 text-sm shadow-lift backdrop-blur before:absolute before:inset-y-0 before:left-0 before:w-1 dark:border-white/10 dark:bg-ink-900/95 ${STYLE[t.tone].ring}`}
          >
            <span className="mt-px shrink-0">{STYLE[t.tone].icon}</span>
            <span className="flex-1 leading-5">{t.message}</span>
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="rounded-md p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10">
              <X size={14} weight="bold" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
