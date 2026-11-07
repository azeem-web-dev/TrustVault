'use client';

import { useState, type FormEvent } from 'react';
import { AndroidLogo, ArrowSquareOut, Envelope, EnvelopeSimpleOpen, PaperPlaneTilt, PencilSimple } from '@phosphor-icons/react';
import { AuthFootnote, AuthHeader, AuthLayout, AUTH_INLINE_LINK, BackToSignIn } from '@/components/auth-layout';
import { Alert, Button, Input, Label } from '@/components/ui';
import { api, errorText } from '@/lib/api';

// Same defaults as the API (BETA_* in apps/api/.env.example).
const STEPS = [
  { title: 'Join the testers group', text: 'Sign in with the Google account you use on your phone, then click "Join group".', href: 'https://groups.google.com/g/trust-vault-beta-users' },
  { title: 'Become a tester', text: 'Opt in to the closed test on Google Play.', href: 'https://play.google.com/apps/testing/cloud.rayyanazeem.trustvault' },
  { title: 'Install the app', text: 'Get TrustVault from Google Play.', href: 'https://play.google.com/store/apps/details?id=cloud.rayyanazeem.trustvault' },
];

/** Android closed-test signup. The answer is the same for every valid address, so it reveals nothing. */
export default function BetaPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/beta/signup', { email });
      setSent(true);
    } catch (err) {
      setError(errorText(err, 'Could not reach the server'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout stepKey={sent ? 'sent' : 'form'}>
      <AuthHeader icon={sent ? <EnvelopeSimpleOpen size={26} /> : <AndroidLogo size={26} />} title={sent ? 'Check your email for the 3 steps' : 'Get the Android beta'}>
        {sent
          ? <>If <span className="font-medium break-all text-fg">{email}</span> is valid, the steps are on their way. The same steps are below.</>
          : 'TrustVault for Android is in a closed test on Google Play. Enter your email and we will send you the steps to join.'}
      </AuthHeader>

      {sent ? (
        <Button size="lg" className="w-full" icon={<PencilSimple size={18} />} onClick={() => setSent(false)}>Use a different email</Button>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Label label="Email">
            <Input icon={<Envelope size={18} />} type="email" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com" />
          </Label>
          {error && <Alert>{error}</Alert>}
          <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full" icon={<PaperPlaneTilt size={18} />}>
            {busy ? 'Sending…' : 'Email me the steps'}
          </Button>
        </form>
      )}

      <ol className="mt-8 space-y-3">
        {STEPS.map((s, i) => (
          <li key={s.href} className="flex gap-3 rounded-xl border border-line bg-surface p-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700 dark:bg-brand-500/10 dark:text-brand-200">{i + 1}</span>
            <div className="min-w-0 text-sm">
              <p className="font-medium text-fg">{s.title}</p>
              <p className="mt-0.5 text-xs leading-5 text-fg-subtle">{s.text}</p>
              <a href={s.href} target="_blank" rel="noopener noreferrer" className={`${AUTH_INLINE_LINK} mt-1 gap-1 text-xs`}>Open <ArrowSquareOut size={12} /></a>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs leading-5 text-fg-subtle">The Google account must be the same one that is signed in on your phone.</p>

      <BackToSignIn />
      <AuthFootnote />
    </AuthLayout>
  );
}
