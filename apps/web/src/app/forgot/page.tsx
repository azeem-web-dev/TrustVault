'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ArrowClockwise, Envelope, EnvelopeSimpleOpen, PaperPlaneTilt, PencilSimple, Sparkle } from '@phosphor-icons/react';
import { AuthFootnote, AuthHeader, AuthLayout, BackToSignIn } from '@/components/auth-layout';
import { Alert, Button, Input, Label } from '@/components/ui';
import { api, errorText } from '@/lib/api';

const RESEND_SECONDS = 30;

/**
 * Asks for a reset link. The answer is the same whether or not the account
 * exists, so this page can't be used to find out who has an account.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Seconds until "Send again" is allowed. */
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function send() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/password/forgot', { email });
      setSent(true);
      setCooldown(RESEND_SECONDS);
    } catch (err) {
      setError(errorText(err, 'Could not reach the server'));
    } finally {
      setBusy(false);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send();
  };

  return (
    <AuthLayout stepKey={sent ? 'sent' : 'form'}>
      <AuthHeader icon={sent ? <EnvelopeSimpleOpen size={26} /> : <PaperPlaneTilt size={26} />} title={sent ? 'Check your inbox' : 'Reset your password'}>
        {sent
          ? <>We sent the link to <span className="font-medium break-all text-fg">{email}</span>, if it belongs to an account.</>
          : 'Enter the email you sign in with and we will send you a link to choose a new password.'}
      </AuthHeader>

      {sent ? (
        <div className="space-y-4">
          <Alert tone="green">If an account exists for that email, a link is on its way. It works once and expires in 30 minutes.</Alert>
          {error && <Alert>{error}</Alert>}
          <div className="grid gap-2 sm:grid-cols-2 [&>*]:min-w-0">
            <Button size="lg" icon={<PencilSimple size={18} />} disabled={busy} onClick={() => { setSent(false); setError(null); }}>
              Use a different email
            </Button>
            <Button size="lg" icon={<ArrowClockwise size={18} />} loading={busy} disabled={cooldown > 0} onClick={() => void send()}>
              {cooldown > 0 ? `Send again (${cooldown}s)` : 'Send again'}
            </Button>
          </div>
          <BackToSignIn />
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <Label label="Email">
            <Input icon={<Envelope size={18} />} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </Label>
          {error && <Alert>{error}</Alert>}
          <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full" icon={<PaperPlaneTilt size={18} />}>
            {busy ? 'Sending…' : 'Email me a reset link'}
          </Button>
          <p className="flex items-start gap-1.5 text-xs leading-5 text-fg-subtle">
            <Sparkle size={14} className="mt-0.5 shrink-0 text-brand-500 dark:text-brand-300" />
            Demo accounts cannot be reset.
          </p>
          <BackToSignIn />
        </form>
      )}

      <AuthFootnote />
    </AuthLayout>
  );
}
