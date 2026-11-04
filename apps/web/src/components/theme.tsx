'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = 'tv-theme';
const ThemeContext = createContext<{ theme: ThemeChoice; setTheme: (t: ThemeChoice) => void }>({ theme: 'system', setTheme: () => undefined });

function readSaved(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system'; // storage blocked: follow the system
  }
}

function apply(choice: ThemeChoice) {
  const dark = choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  // The browser chrome (mobile address bar) follows the chosen theme, not the OS.
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"][data-light]');
  const color = meta?.dataset[dark ? 'dark' : 'light'];
  if (meta && color) meta.content = color;
}

/**
 * Light, dark or follow the system. The choice is a per-browser convenience
 * only. Nothing is applied until the saved choice has been read (the
 * pre-paint script in layout.tsx already set it), so there is no flash of
 * the wrong theme (X13). Other tabs follow along through the storage event.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice | null>(null);

  useEffect(() => {
    setThemeState(readSaved());
    const onStorage = (e: StorageEvent) => { if (e.key === KEY || e.key === null) setThemeState(readSaved()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    if (theme === null) return;
    apply(theme);
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((t: ThemeChoice) => {
    setThemeState(t);
    try {
      if (t === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      /* ignore */
    }
  }, []);

  return <ThemeContext.Provider value={{ theme: theme ?? 'system', setTheme }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
