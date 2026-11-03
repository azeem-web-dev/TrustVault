'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, CheckCircle, EnvelopeOpen, IdentificationCard, LinkBreak, LockSimple } from '@phosphor-icons/react';
import { AuthLayout } from '@/components/auth-layout';
import { Alert, Button, Input, Label, Skeleton } from '@/components/ui';
import { ApiError, api, errorText, type Role } from '@/lib/api';

const ROLE_LABEL: Record<Role, string> = { ADMIN: 'Administrator', OWNER: 'Document owner', VIEWER: 'Viewer', EXTERNAL: 'External (read-only)' };

interface Invitation { email: string; role: Role; accessExpiresAt: string | null }

/**
 * Lands here from the invitation email: /invite#token=…  Like /reset, the
 * token sits in the URL fragment, so it is never sent to a server or leaked
 * through Referer. It is read once, wiped from the address bar, and kept in
 * memory only. The person chooses their own name and password here; the
 * admin who invited them never knows it.
 */
export default function AcceptInvitePage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [name, setName] = useState('');
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
      if (t) {
        setToken(t);
        api.post<Invitation>('/auth/invite/check', { token: t })
          .then(setInvitation)
          .catch((err: unknown) => { setLinkBad(true); setError(errorText(err, 'Could not reach the server')); });
      }
    }
    setChecked(true);
  }, []);

  const mismatch = pw.repeat.length > 0 && pw.next !== pw.repeat;
  const strength = Math.min(100, (pw.next.length / 20) * 100);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token || pw.next !== pw.repeat || !name.trim()) return;
    setBusy(true);
    setError(null);
    setLinkBad(false);
    try {
      await api.post('/auth/invite/accept', { token, displayName: name.trim(), password: pw.next });
      setToken(null);
      setPw({ next: '', repeat: '' });
      setDone(true);
    } catch (err) {
      setError(errorText(err, 'Could not reach the server'));
      setLinkBad(err instanceof ApiError && err.status === 400 && /invitation link/i.test(err.message));
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
          <h1 className="text-[1.75rem] font-semibold tracking-tight">Welcome to TrustVault</h1>
        </div>
        <div className="space-y-4">
          <Alert tone="green">Your account is ready. Sign in with your email and the password you just chose.</Alert>
          {invitation?.role === 'ADMIN' && <Alert tone="blue">As an administrator you&apos;ll set up a second factor (an authenticator app or passkey) when you first sign in.</Alert>}
          <Button variant="primary" size="lg" className="w-full" onClick={() => router.replace('/login')}>
            Sign in <ArrowRight size={16} weight="bold" />
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (!token || linkBad) {
    return (
      <AuthLayout>
        <div className="mb-8">
          <span className="mb-5 inline-flex size-14 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-glow">
            <LinkBreak size={28} />
          </span>
          <h1 className="text-[1.75rem] font-semibold tracking-tight">{token ? 'This invitation no longer works' : 'This link is incomplete'}</h1>
          <p className="mt-1.5 text-sm leading-6 text-slate-500 dark:text-slate-400">
            {token
              ? 'It may have been used already, replaced by a newer one, or expired. Ask your administrator to send the invitation again.'
              : 'Open the link from your invitation email again. Each link works once and expires after a few days.'}
          </p>
        </div>
        <Link href="/login" className="flex w-full items-center justify-center gap-1.5 pt-2 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
          <ArrowLeft size={14} />Back to sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="mb-8">
        <span className="mb-5 inline-flex size-14 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-glow">
          <EnvelopeOpen size={28} />
        </span>
        <h1 className="text-[1.75rem] font-semibold tracking-tight">Set up your account</h1>
        <p className="mt-1.5 text-sm leading-6 text-slate-500 dark:text-slate-400">
          {invitation
            ? <>Joining as <span className="font-semibold text-slate-700 dark:text-slate-200">{invitation.email}</span> ({ROLE_LABEL[invitation.role]}).</>
            : <Skeleton className="inline-block h-4 w-64 align-middle" />}
          {' '}Only you will know your password.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <Label label="Your name" hint="How others see you when you share documents.">
          <Input icon={<IdentificationCard size={18} />} autoComplete="name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
        </Label>
        <Label label="Password" hint="At least 12 characters. Length matters more than symbols.">
          <Input icon={<LockSimple size={18} />} type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        </Label>
        {pw.next && (
          <div className="-mt-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10">
              <div className={`h-full rounded-full transition-all ${pw.next.length < 12 ? 'bg-red-500' : pw.next.length < 16 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${strength}%` }} />
            </div>
            <p className="mt-1 text-xs text-slate-500">{pw.next.length < 12 ? `${12 - pw.next.length} more characters needed` : pw.next.length < 16 ? 'Good. Longer is even better.' : 'Strong'}</p>
          </div>
        )}
        <Label label="Repeat password" hint={mismatch ? <span className="text-red-600 dark:text-red-400">The two passwords don&apos;t match.</span> : undefined}>
          <Input icon={<LockSimple size={18} />} type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} />
        </Label>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!name.trim() || pw.next.length < 12 || pw.next !== pw.repeat} className="w-full">
          {busy ? 'Saving…' : 'Create my account'}
        </Button>
        <Link href="/login" className="flex w-full items-center justify-center gap-1.5 pt-2 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
          <ArrowLeft size={14} />Back to sign in
        </Link>
      </form>
    </AuthLayout>
  );
}
