'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/components/session';
import { Logo } from '@/components/shell';
import { Alert, Button, Input, Label } from '@/components/ui';
import { errorText } from '@/lib/api';

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
      const { mfaRequired } = await signIn(email, password);
      router.replace(mfaRequired ? '/login/mfa' : '/');
    } catch (err) {
      setError(errorText(err, 'Could not reach the server'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2 text-xl font-semibold">
          <Logo /> TrustVault
        </div>
        <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h1 className="text-lg font-semibold">Sign in</h1>
          <Label label="Email">
            <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Label>
          <Label label="Password">
            <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Label>
          {error && <Alert>{error}</Alert>}
          <Button type="submit" variant="primary" disabled={busy} className="w-full py-2">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
        <p className="mt-4 text-center text-xs text-slate-500">Every sign-in, download and permission change is recorded.</p>
      </div>
    </main>
  );
}
