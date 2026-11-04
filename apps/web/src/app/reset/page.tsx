'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CheckCircle, LinkBreak, LockSimple, Password, WarningCircle } from '@phosphor-icons/react';
import { useSession } from '@/components/session';
import { AuthHeader, AuthLayout, BackToSignIn, PasswordStrength } from '@/components/auth-layout';
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token || busy || pw.next !== pw.repeat) return;
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
      // Only a dead link is a link problem; a 400 for the password itself (e.g. too long) is not (A1).
      setLinkBad(err instanceof ApiError && err.status === 400 && /link/i.test(err.message));
    } finally {
      setBusy(false);
    }
  }

  if (!checked) {
    return (
      <AuthLayout stepKey="loading">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-3 h-4 w-72 max-w-full" />
        <Skeleton className="mt-8 h-10 rounded-lg" />
        <Skeleton className="mt-4 h-10 rounded-lg" />
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout stepKey="done">
        <AuthHeader icon={<CheckCircle size={26} />} title="All set" tone="success" />
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
      <AuthLayout stepKey="no-token">
        <AuthHeader icon={<LinkBreak size={26} />} title="This link is incomplete" tone="warning">
            Open the link from your email again, or ask for a new one. Each link works once and expires in 30 minutes.
        </AuthHeader>
        <div className="space-y-4">
          <ButtonLink href="/forgot" variant="primary" size="lg" className="w-full">
            Request a new link <ArrowRight size={16} weight="bold" />
          </ButtonLink>
          <BackToSignIn />
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout stepKey="form">
      <AuthHeader icon={<Password size={26} />} title="Choose a new password">Setting it signs you out on every device.</AuthHeader>

      <form onSubmit={onSubmit} className="space-y-4">
        <Label label="New password" hint="At least 12 characters. Length matters more than symbols.">
          <Input icon={<LockSimple size={18} />} type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        </Label>
        {pw.next && <PasswordStrength value={pw.next} />}
        <Label label="Repeat new password" hint={mismatch ? <span className="inline-flex items-center gap-1 font-medium text-danger-600 dark:text-danger-300"><WarningCircle size={14} weight="fill" />The two passwords don&apos;t match.</span> : undefined}>
          <Input icon={<LockSimple size={18} />} type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} />
        </Label>
        {error && (
          <Alert action={linkBad ? <ButtonLink href="/forgot" size="sm" variant="secondary">Request a new link <ArrowRight size={14} weight="bold" /></ButtonLink> : undefined}>
            {error}
          </Alert>
        )}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={pw.next.length < 12 || pw.next !== pw.repeat} className="w-full">
          {busy ? 'Saving…' : 'Set new password'}
        </Button>
        <BackToSignIn />
      </form>
    </AuthLayout>
  );
}
