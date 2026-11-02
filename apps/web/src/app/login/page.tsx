'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Envelope, Eye, EyeSlash, LockSimple, Sparkle } from '@phosphor-icons/react';
import { useSession } from '@/components/session';
import { AuthLayout } from '@/components/auth-layout';
import { Alert, Avatar, Button, Divider, Input, Label, cx } from '@/components/ui';
import { errorText } from '@/lib/api';

// The published demo accounts (also listed in the README). They are
// protected server-side: nobody can change their password or second factor.
const DEMO = [
  { name: 'Ada Admin', role: 'Administrator', email: 'admin@demo.com', password: 'admin1234567', note: 'Needs a 6-digit code' },
  { name: 'Olivia Owner', role: 'Document owner', email: 'olivia@demo.com', password: 'owner1234567' },
  { name: 'Victor Viewer', role: 'Viewer', email: 'victor@demo.com', password: 'viewer123456' },
  { name: 'Erin External', role: 'External partner', email: 'erin@demo.com', password: 'external1234' },
];

export default function LoginPage() {
  const { signIn } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
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
    <AuthLayout>
      <div className="mb-8">
        <h1 className="text-[28px] font-semibold tracking-tight">Welcome back</h1>
        <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">Sign in to reach the documents shared with you.</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <Label label="Email">
          <Input icon={<Envelope size={18} />} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        </Label>
        <label className="block text-sm">
          <span className="mb-1.5 block text-[13px] font-medium text-slate-700 dark:text-slate-300">Password</span>
          <span className="relative block">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400"><LockSimple size={18} /></span>
            <input
              type={reveal ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-10 pr-11 text-sm shadow-sm outline-none transition placeholder:text-slate-400 hover:border-slate-300 focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 dark:border-white/10 dark:bg-white/[0.04] dark:hover:border-white/20 dark:focus:border-brand-400"
            />
          </span>
        </label>
        <div className="-mt-2 flex items-center justify-end gap-4">
          <Link href="/forgot" className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-300">Forgot password?</Link>
          <button type="button" onClick={() => setReveal((r) => !r)} aria-pressed={reveal} className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
            {reveal ? <EyeSlash size={15} /> : <Eye size={15} />}{reveal ? 'Hide' : 'Show'} characters
          </button>
        </div>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
          {busy ? 'Signing in…' : <>Sign in <ArrowRight size={16} weight="bold" /></>}
        </Button>
      </form>

      <div className="mt-8 space-y-3">
        <Divider label="or try a demo account" />
        <div className="grid grid-cols-2 gap-2">
          {DEMO.map((d) => {
            const picked = email === d.email;
            return (
              <button
                key={d.email}
                type="button"
                onClick={() => { setEmail(d.email); setPassword(d.password); setError(null); }}
                className={cx(
                  'group flex items-center gap-2.5 rounded-xl border p-2.5 text-left transition',
                  picked ? 'border-brand-400 bg-brand-50 ring-4 ring-brand-500/10 dark:border-brand-400/60 dark:bg-brand-500/10' : 'border-slate-200 bg-white hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-soft dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-white/20',
                )}
              >
                <Avatar name={d.name} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold">{d.name.split(' ')[0]}</span>
                  <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">{d.role}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="flex items-start gap-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
          <Sparkle size={14} className="mt-0.5 shrink-0 text-brand-500" />
          Picking one fills in its login. The admin also needs a 6-digit code from the secret in the README.
        </p>
      </div>

      <p className="mt-10 text-center text-xs text-slate-400">Every sign-in, download and permission change is recorded.</p>
    </AuthLayout>
  );
}
