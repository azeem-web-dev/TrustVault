'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft, Envelope, EnvelopeSimpleOpen, PaperPlaneTilt, Sparkle } from '@phosphor-icons/react';
import { AuthLayout } from '@/components/auth-layout';
import { Alert, Button, Input, Label } from '@/components/ui';
import { api, errorText } from '@/lib/api';

/**
 * Asks for a reset link. The answer is the same whether or not the account
 * exists, so this page can't be used to find out who has an account.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/password/forgot', { email });
      setSent(true);
    } catch (err) {
      setError(errorText(err, 'Could not reach the server'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <div className="mb-8">
        <span className="mb-5 inline-flex size-14 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-glow">
          {sent ? <EnvelopeSimpleOpen size={28} /> : <PaperPlaneTilt size={28} />}
        </span>
        <h1 className="text-[1.75rem] font-semibold tracking-tight">{sent ? 'Check your inbox' : 'Reset your password'}</h1>
        <p className="mt-1.5 text-sm leading-6 text-slate-500 dark:text-slate-400">
          {sent ? 'We sent the link to the address you entered, if it belongs to an account.' : 'Enter the email you sign in with and we will send you a link to choose a new password.'}
        </p>
      </div>

      {sent ? (
        <div className="space-y-4">
          <Alert tone="green">If an account exists for that email, a link is on its way. It works once and expires in 30 minutes.</Alert>
          <Link href="/login" className="flex w-full items-center justify-center gap-1.5 pt-2 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
            <ArrowLeft size={14} />Back to sign in
          </Link>
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
          <p className="flex items-start gap-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
            <Sparkle size={14} className="mt-0.5 shrink-0 text-brand-500" />
            Demo accounts cannot be reset.
          </p>
          <Link href="/login" className="flex w-full items-center justify-center gap-1.5 pt-2 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
            <ArrowLeft size={14} />Back to sign in
          </Link>
        </form>
      )}

      <p className="mt-10 text-center text-xs text-slate-400">Every sign-in, download and permission change is recorded.</p>
    </AuthLayout>
  );
}
