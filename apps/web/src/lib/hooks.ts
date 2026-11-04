'use client';

// Small shared hooks for pages: request ordering (useLatest), debouncing,
// per-action busy state (useAction) and exit animations (useExitState).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ---------------------------------------------------------------- useLatest */

export interface LatestTicket {
  /** Aborts when a newer request starts or the component unmounts. Pass to api.get(path, { signal }). */
  signal: AbortSignal;
  /** True while this is still the newest request. Check before using a result or an error. */
  isLatest: () => boolean;
}

/**
 * Request-id guard against out-of-order responses (X5). Call `begin()` at the
 * start of each load; a newer `begin()` aborts the previous request and makes
 * its `isLatest()` false, so a slow, older response can never overwrite a
 * newer one.
 *
 *   const latest = useLatest();
 *   const load = async () => {
 *     const t = latest.begin();
 *     try { const r = await api.get(url, { signal: t.signal }); if (t.isLatest()) setData(r); }
 *     catch (e) { if (t.isLatest()) setError(errorText(e)); }
 *   };
 */
export function useLatest() {
  const state = useRef<{ id: number; ctrl: AbortController | null }>({ id: 0, ctrl: null });
  useEffect(() => () => {
    state.current.id++;
    state.current.ctrl?.abort();
  }, []);
  return useMemo(() => ({
    begin(): LatestTicket {
      state.current.ctrl?.abort();
      const ctrl = new AbortController();
      const id = ++state.current.id;
      state.current.ctrl = ctrl;
      return { signal: ctrl.signal, isLatest: () => state.current.id === id };
    },
    /** Invalidate (and abort) whatever is in flight without starting anything new. */
    cancel(): void {
      state.current.id++;
      state.current.ctrl?.abort();
      state.current.ctrl = null;
    },
  }), []);
}

/** True for the error fetch throws when its signal aborts. */
export const isAbortError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';

/* ------------------------------------------------------------- useDebounced */

/** `value`, but only after it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/* ---------------------------------------------------------------- useAction */

/**
 * Per-action busy state that also blocks double submits (X4). `run` ignores
 * calls while any action is running (synchronously, so a double click sends
 * one request) and returns `undefined` for an ignored call. Errors thrown by
 * `fn` propagate to the caller.
 *
 *   const { busy, run } = useAction();
 *   <Button loading={busy === 'approve'} disabled={!!busy} onClick={() => run('approve', approve)}>
 */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const current = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const run = useCallback(async <T>(key: string, fn: () => Promise<T> | T): Promise<T | undefined> => {
    if (current.current !== null) return undefined;
    current.current = key;
    setBusy(key);
    try {
      return await fn();
    } finally {
      current.current = null;
      if (alive.current) setBusy(null);
    }
  }, []);

  const isBusy = useCallback((key?: string) => (key === undefined ? busy !== null : busy === key), [busy]);

  return { busy, run, isBusy };
}

/* ------------------------------------------------------------ useExitState */

export const prefersReducedMotion = (): boolean => {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/**
 * Keeps an overlay mounted while its exit animation plays. Render while
 * `mounted`, and put `data-state={state}` on the animated nodes so CSS can
 * switch to the `*-out` animation when `state === 'closed'`.
 */
export function useExitState(open: boolean, ms = 200): { mounted: boolean; state: 'open' | 'closed' } {
  const [mounted, setMounted] = useState(open);
  // Mount in the same render that opens, so the enter animation never misses a frame.
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (open || !mounted) return;
    const delay = prefersReducedMotion() ? 0 : ms;
    const t = setTimeout(() => setMounted(false), delay);
    return () => clearTimeout(t);
  }, [open, mounted, ms]);

  return { mounted: open || mounted, state: open ? 'open' : 'closed' };
}
