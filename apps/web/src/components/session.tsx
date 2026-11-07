'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError, setCsrfToken, setMfaHandler, setSessionEndedHandler, type User } from '@/lib/api';
import { useToast } from './toast';

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
const PUBLIC_PATHS = ['/login', '/forgot', '/reset', '/invite', '/signin-link', '/privacy', '/beta', '/delete-account'];
/** Navigating re-checks the session only when the last check is older than this (A5). */
const RECHECK_MS = 5 * 60_000;

/**
 * Knows who is signed in, for display only. Hiding a link here is a
 * convenience: every request is still checked by the API.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  // Read through refs so `refresh` stays stable: a new path must not refetch
  // /auth/me on every navigation (A5).
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const meRef = useRef(me);
  meRef.current = me;
  const lastCheck = useRef(0);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++seq.current;
    try {
      const r = await api.get<Me>('/auth/me');
      if (id !== seq.current) return;
      lastCheck.current = Date.now();
      setCsrfToken(r.csrfToken);
      setMe(r);
      if (r.mfaRequired && !r.mfaSatisfied && pathRef.current !== '/login/mfa') router.replace('/login/mfa');
    } catch (err) {
      if (id !== seq.current) return;
      if (err instanceof ApiError && err.status === 401) {
        lastCheck.current = Date.now();
        const wasSignedIn = meRef.current !== null;
        setMe(null);
        if (!PUBLIC_PATHS.includes(pathRef.current)) router.replace(wasSignedIn ? '/login?ended=1' : '/login');
      } else if (!PUBLIC_PATHS.includes(pathRef.current)) {
        // A network blip or a 5xx is not a sign-out: keep who we know and say so.
        toast('Could not reach the server to check your session.', 'warning', { action: { label: 'Retry', onClick: () => void refresh() } });
      }
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [router, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // On navigation: only re-check when we know nobody (a private page needs a
  // verdict) or the last check is stale; otherwise just enforce a pending
  // second factor from what we already know.
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) { firstPath.current = false; return; }
    const known = meRef.current;
    if ((!known && !PUBLIC_PATHS.includes(pathname)) || Date.now() - lastCheck.current > RECHECK_MS) {
      void refresh();
    } else if (known && known.mfaRequired && !known.mfaSatisfied && pathname !== '/login/mfa' && !PUBLIC_PATHS.includes(pathname)) {
      router.replace('/login/mfa');
    }
  }, [pathname, refresh, router]);

  useEffect(() => {
    setMfaHandler(() => router.replace('/login/mfa'));
    return () => setMfaHandler(null);
  }, [router]);

  // Any call answered "session_required" while someone was signed in: back to sign-in, with the reason.
  useEffect(() => {
    setSessionEndedHandler(() => {
      if (meRef.current === null) return;
      meRef.current = null;
      setMe(null);
      setCsrfToken(null);
      if (!PUBLIC_PATHS.includes(pathRef.current)) router.replace('/login?ended=1');
    });
    return () => setSessionEndedHandler(null);
  }, [router]);

  const signIn = useCallback(async (email: string, password: string) => {
    const r = await api.post<Me | { signInLinkSent: true; message: string }>('/auth/login', { email, password });
    if ('signInLinkSent' in r) return { mfaRequired: false, linkSent: r.message };
    seq.current++; // an older /auth/me answer must not undo this sign-in
    lastCheck.current = Date.now();
    setLoading(false);
    setCsrfToken(r.csrfToken);
    setMe({ ...r, mfaSatisfied: false });
    return { mfaRequired: r.mfaRequired };
  }, []);

  const signInWithLink = useCallback(async (token: string) => {
    const r = await api.post<Me>('/auth/login/link', { token });
    seq.current++;
    lastCheck.current = Date.now();
    setLoading(false);
    setCsrfToken(r.csrfToken);
    setMe({ ...r, mfaSatisfied: false });
    return { mfaRequired: r.mfaRequired };
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // The local session is dropped either way; the server cookie expires on its own.
    } finally {
      seq.current++;
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
