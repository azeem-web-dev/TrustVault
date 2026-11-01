'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError, setCsrfToken, type User } from '@/lib/api';

interface SessionState {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

/**
 * Knows who is signed in, for display only. Hiding a link here is a
 * convenience: every request is still checked by the API.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ user: User; csrfToken: string }>('/auth/me')
      .then((r) => {
        if (cancelled) return;
        setCsrfToken(r.csrfToken);
        setUser(r.user);
      })
      .catch((err) => {
        if (cancelled) return;
        setUser(null);
        if (err instanceof ApiError && err.status === 401 && pathname !== '/login') router.replace('/login');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  const signIn = useCallback(async (email: string, password: string) => {
    const r = await api.post<{ user: User; csrfToken: string }>('/auth/login', { email, password });
    setCsrfToken(r.csrfToken);
    setUser(r.user);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setCsrfToken(null);
      setUser(null);
      router.replace('/login');
    }
  }, [router]);

  return <SessionContext.Provider value={{ user, loading, signIn, signOut }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
