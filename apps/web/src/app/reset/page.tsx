'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, CheckCircle, LinkBreak, LockSimple, Password } from '@phosphor-icons/react';
import { useSession } from '@/components/session';
import { AuthLayout } from '@/components/auth-layout';
import { Alert, Button, ButtonLink, Input, Label, Skeleton } from '@/components/ui';
import { ApiError, api, errorText } from '@/lib/api';

/**
 * Lands here from the emailed link: /reset#token=…  The token sits in the URL
 * fragment, so it is never sent to a server or leaked through Referer. It is
 * read once, wiped from the address bar, and kept in memory only.
 */
export default function ResetPasswordPage() {
  const { refresh } = useSession();
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [pw, setPw] = useState({ next: '', repeat: '' });
  const [error, setError] = useState<string | null>(null);
  const [linkBad, setLinkBad] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '');
    if (hash) {
      const t = new URLSearchParams(hash).get('token');
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
      // Effects can run twice in development; only the first run sees the hash.
      if (t) setToken(t);
    }
    setChecked(true);
  }, []);

  const mismatch = pw.repeat.length > 0 && pw.next !== pw.repeat;
  const strength = Math.min(100, (pw.next.length / 20) * 100);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token || pw.next !== pw.repeat) return;
    setBusy(true);
    setError(null);
    setLinkBad(false);
    try {
      await api.post('/auth/password/reset', { token, newPassword: pw.next });
      setToken(null);
      setPw({ next: '', repeat: '' });
      setDone(true);
      void refresh();
    } catch (err) {
      setError(errorText(err, 'Could not reach the server'));
      setLinkBad(err instanceof ApiError && err.status === 400);
    } finally {
      setBusy(false);
    }
  }

  if (!checked) {
    return (
      <AuthLayout>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-3 h-4 w-72" />
        <Skeleton className="mt-8 h-10 rounded-lg" />
        <Skeleton className="mt-4 h-10 rounded-lg" />
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout>
        <div className="mb-8">
          <span className="mb-5 inline-flex size-14 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-glow">
            <CheckCircle size={28} />
          </span>
          <h1 className="text-[28px] font-semibold tracking-tight">All set</h1>
        </div>
        <div className="space-y-4">
          <Alert tone="green">Password changed. You&apos;ve been signed out everywhere.</Alert>
          <Button variant="primary" size="lg" className="w-full" onClick={() => router.replace('/login')}>
            Sign in <ArrowRight size={16} weight="bold" />
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (!token) {
    return (
      <AuthLayout>
        <div className="mb-8">
          <span className="mb-5 inline-flex size-14 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-glow">
            <LinkBreak size={28} />
          </span>
          <h1 className="text-[28px] font-semibold tracking-tight">This link is incomplete</h1>
          <p className="mt-1.5 text-sm leading-6 text-slate-500 dark:text-slate-400">
            Open the link from your email again, or ask for a new one. Each link works once and expires in 30 minutes.
          </p>
        </div>
        <div className="space-y-4">
          <ButtonLink href="/forgot" variant="primary" size="lg" className="w-full">
            Request a new link <ArrowRight size={16} weight="bold" />
          </ButtonLink>
          <Link href="/login" className="flex w-full items-center justify-center gap-1.5 pt-2 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
            <ArrowLeft size={14} />Back to sign in
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="mb-8">
        <span className="mb-5 inline-flex size-14 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-glow">
          <Password size={28} />
        </span>
        <h1 className="text-[28px] font-semibold tracking-tight">Choose a new password</h1>
        <p className="mt-1.5 text-sm leading-6 text-slate-500 dark:text-slate-400">Setting it signs you out on every device.</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <Label label="New password" hint="At least 12 characters. Length matters more than symbols.">
          <Input icon={<LockSimple size={18} />} type="password" autoComplete="new-password" minLength={12} required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        </Label>
        {pw.next && (
          <div className="-mt-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10">
              <div className={`h-full rounded-full transition-all ${pw.next.length < 12 ? 'bg-red-500' : pw.next.length < 16 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${strength}%` }} />
            </div>
            <p className="mt-1 text-xs text-slate-500">{pw.next.length < 12 ? `${12 - pw.next.length} more characters needed` : pw.next.length < 16 ? 'Good. Longer is even better.' : 'Strong'}</p>
          </div>
        )}
        <Label label="Repeat new password" hint={mismatch ? <span className="text-red-600 dark:text-red-400">The two passwords don&apos;t match.</span> : undefined}>
          <Input icon={<LockSimple size={18} />} type="password" autoComplete="new-password" minLength={12} required value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} />
        </Label>
        {error && (
          <Alert>
            {error}
            {linkBad && <> <Link href="/forgot" className="font-semibold underline">Request a new link</Link></>}
          </Alert>
        )}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={pw.next.length < 12 || pw.next !== pw.repeat} className="w-full">
          {busy ? 'Saving…' : 'Set new password'}
        </Button>
        <Link href="/login" className="flex w-full items-center justify-center gap-1.5 pt-2 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
          <ArrowLeft size={14} />Back to sign in
        </Link>
      </form>
    </AuthLayout>
  );
}
