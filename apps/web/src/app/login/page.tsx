'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/components/session';
import { ApiError } from '@/lib/api';

export default function LoginPage() {
  const { signIn } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      router.replace('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2 text-xl font-semibold">
          <span aria-hidden className="inline-block h-7 w-7 rounded-md bg-brand-600" />
          TrustVault
        </div>
        <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h1 className="text-lg font-semibold">Sign in</h1>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Email</span>
            <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-transparent px-3 py-2 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20 dark:border-slate-700" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Password</span>
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-transparent px-3 py-2 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20 dark:border-slate-700" />
          </label>
          {error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
          <button type="submit" disabled={busy}
            className="w-full rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="mt-4 text-center text-xs text-slate-500">Every sign-in, download and permission change is recorded.</p>
      </div>
    </main>
  );
}
