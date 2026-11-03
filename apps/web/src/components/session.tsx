'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError, setCsrfToken, setMfaHandler, type User } from '@/lib/api';

interface Me {
  user: User;
  csrfToken: string;
  mfaRequired: boolean;
  mfaSatisfied: boolean;
  mfaEnrolled: boolean;
}

interface SessionState {
  user: User | null;
  loading: boolean;
  mfaPending: boolean;
  mfaEnrolled: boolean;
  refresh: () => Promise<void>;
  /** `linkSent`: the account is under attack and this browser is new; finish from the emailed link. */
  signIn: (email: string, password: string) => Promise<{ mfaRequired: boolean; linkSent?: string }>;
  /** Finish a sign-in from an emailed one-time link. */
  signInWithLink: (token: string) => Promise<{ mfaRequired: boolean }>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);
const PUBLIC_PATHS = ['/login', '/forgot', '/reset', '/invite', '/signin-link'];

/**
 * Knows who is signed in, for display only. Hiding a link here is a
 * convenience: every request is still checked by the API.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<Me>('/auth/me');
      setCsrfToken(r.csrfToken);
      setMe(r);
      if (r.mfaRequired && !r.mfaSatisfied && pathname !== '/login/mfa') router.replace('/login/mfa');
    } catch (err) {
      setMe(null);
      if (err instanceof ApiError && err.status === 401 && !PUBLIC_PATHS.includes(pathname)) router.replace('/login');
    } finally {
      setLoading(false);
    }
  }, [pathname, router]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setMfaHandler(() => router.replace('/login/mfa'));
    return () => setMfaHandler(null);
  }, [router]);

  const signIn = useCallback(async (email: string, password: string) => {
    const r = await api.post<Me | { signInLinkSent: true; message: string }>('/auth/login', { email, password });
    if ('signInLinkSent' in r) return { mfaRequired: false, linkSent: r.message };
    setCsrfToken(r.csrfToken);
    setMe({ ...r, mfaSatisfied: false });
    return { mfaRequired: r.mfaRequired };
  }, []);

  const signInWithLink = useCallback(async (token: string) => {
    const r = await api.post<Me>('/auth/login/link', { token });
    setCsrfToken(r.csrfToken);
    setMe({ ...r, mfaSatisfied: false });
    return { mfaRequired: r.mfaRequired };
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setCsrfToken(null);
      setMe(null);
      router.replace('/login');
    }
  }, [router]);

  return (
    <SessionContext.Provider
      value={{
        user: me?.user ?? null,
        loading,
        mfaPending: Boolean(me && me.mfaRequired && !me.mfaSatisfied),
        mfaEnrolled: me?.mfaEnrolled ?? false,
        refresh,
        signIn,
        signInWithLink,
        signOut,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
