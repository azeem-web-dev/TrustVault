'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowClockwise, ArrowRight, CheckCircle, EnvelopeOpen, IdentificationCard, LinkBreak, LockSimple, WarningCircle } from '@phosphor-icons/react';
import { AuthHeader, AuthLayout, BackToSignIn, PasswordStrength } from '@/components/auth-layout';
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
  /** Why the invitation check failed; with `linkBad` false it was not a dead link (offline, 429, 5xx). */
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback((t: string) => {
    setChecking(true);
    setCheckError(null);
    api.post<Invitation>('/auth/invite/check', { token: t })
      .then(setInvitation)
      .catch((err: unknown) => {
        setCheckError(errorText(err, 'Could not reach the server'));
        // Only the API saying "400" means the invitation itself is dead (A2).
        if (err instanceof ApiError && err.status === 400) setLinkBad(true);
      })
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '');
    if (hash) {
      const t = new URLSearchParams(hash).get('token');
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
      // Effects can run twice in development; only the first run sees the hash.
      if (t) {
        setToken(t);
        check(t);
      }
    }
    setChecked(true);
  }, [check]);

  const mismatch = pw.repeat.length > 0 && pw.next !== pw.repeat;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token || busy || pw.next !== pw.repeat || !name.trim()) return;
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

  const checkFailed = !invitation && !linkBad && checkError !== null;

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
        <AuthHeader icon={<CheckCircle size={26} />} title="Welcome to TrustVault" tone="success" />
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
      <AuthLayout stepKey={token ? 'dead' : 'no-token'}>
        <AuthHeader icon={<LinkBreak size={26} />} title={token ? 'This invitation no longer works' : 'This link is incomplete'} tone="warning">
            {token
              ? 'It may have been used already, replaced by a newer one, or expired. Ask your administrator to send the invitation again.'
              : 'Open the link from your invitation email again. Each link works once and expires after a few days.'}
        </AuthHeader>
        {token && (error ?? checkError) && <Alert className="mb-4">{error ?? checkError}</Alert>}
        <BackToSignIn />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout stepKey="form">
      <AuthHeader icon={<EnvelopeOpen size={26} />} title="Set up your account">
          {invitation
            ? <>Joining as <span className="font-semibold text-fg">{invitation.email}</span> ({ROLE_LABEL[invitation.role]}).</>
            : checkFailed ? 'We couldn’t check your invitation yet.' : <Skeleton as="span" className="h-4 w-64 max-w-full" />}
          {' '}Only you will know your password.
      </AuthHeader>

      {checkFailed && (
        <Alert
          className="mb-4"
          title="Couldn’t check your invitation"
          action={<Button size="sm" icon={<ArrowClockwise size={14} weight="bold" />} loading={checking} onClick={() => token && check(token)}>Try again</Button>}
        >
          {checkError}
        </Alert>
      )}

      <form onSubmit={onSubmit} className="space-y-4">
        <Label label="Your name" hint="How others see you when you share documents.">
          <Input icon={<IdentificationCard size={18} />} autoComplete="name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
        </Label>
        <Label label="Password" hint="At least 12 characters. Length matters more than symbols.">
          <Input icon={<LockSimple size={18} />} type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        </Label>
        {pw.next && <PasswordStrength value={pw.next} />}
        <Label label="Repeat password" hint={mismatch ? <span className="inline-flex items-center gap-1 font-medium text-danger-600 dark:text-danger-300"><WarningCircle size={14} weight="fill" />The two passwords don&apos;t match.</span> : undefined}>
          <Input icon={<LockSimple size={18} />} type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} />
        </Label>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!name.trim() || pw.next.length < 12 || pw.next !== pw.repeat} className="w-full">
          {busy ? 'Saving…' : 'Create my account'}
        </Button>
        <BackToSignIn />
      </form>
    </AuthLayout>
  );
}
