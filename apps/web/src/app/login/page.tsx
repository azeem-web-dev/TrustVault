'use client';

import { BetaCard } from '@/components/beta-card';
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Envelope, Eye, EyeSlash, LockSimple, SignIn, Sparkle } from '@phosphor-icons/react';
import { useSession } from '@/components/session';
import { AUTH_INLINE_LINK, AuthFootnote, AuthHeader, AuthLayout } from '@/components/auth-layout';
import { Alert, Avatar, Button, Divider, IconButton, Input, Label, cx, staggerClass } from '@/components/ui';
import { errorText } from '@/lib/api';

// The published demo accounts (also listed in the README). They are
// protected server-side: nobody can change their password or second factor.
const DEMO = [
  { name: 'Ada Admin', role: 'Administrator', email: 'admin@demo.com', password: 'admin1234567', note: 'Needs a 6-digit code' },
  { name: 'Ben Admin', role: 'Second administrator', email: 'admin2@demo.com', password: 'admin2345678', note: 'Approves the first admin’s requests' },
  { name: 'Olivia Owner', role: 'Document owner', email: 'olivia@demo.com', password: 'owner1234567' },
  { name: 'Victor Viewer', role: 'Viewer', email: 'victor@demo.com', password: 'viewer123456' },
  { name: 'Erin External', role: 'External partner', email: 'erin@demo.com', password: 'external1234' },
];

export default function LoginPage() {
  const { user, loading, mfaPending, signIn } = useSession();
  const router = useRouter();
  const [ended, setEnded] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkSent, setLinkSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Sent here by an ended session (401 session_required): say so, once.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('ended') === '1') setEnded(true);
  }, []);

  // Already signed in (A6): there is nothing to do here.
  useEffect(() => {
    if (!loading && user && !busy) router.replace(mfaPending ? '/login/mfa' : '/');
  }, [loading, user, mfaPending, busy, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setLinkSent(null);
    try {
      const { mfaRequired, linkSent: sent } = await signIn(email, password);
      if (sent) {
        setLinkSent(sent);
        setPassword('');
        setBusy(false);
        return;
      }
      // Stay busy until the next page takes over, so the button can't submit twice (A6).
      router.replace(mfaRequired ? '/login/mfa' : '/');
    } catch (err) {
      setError(errorText(err, 'Could not reach the server'));
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <AuthHeader icon={<SignIn size={26} />} title="Welcome back">Sign in to reach the documents shared with you.</AuthHeader>

      <form onSubmit={onSubmit} className="space-y-4">
        <Label label="Email">
          <Input icon={<Envelope size={18} />} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        </Label>
        <Label label="Password">
          <span className="relative block">
            <Input
              icon={<LockSimple size={18} />}
              type={reveal ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="pr-11"
            />
            {/* IconButton is `relative` itself, so a wrapper does the positioning. */}
            <span className="absolute inset-y-0 right-1 flex items-center">
              <IconButton
                label={reveal ? 'Hide password' : 'Show password'}
                aria-pressed={reveal}
                onClick={() => setReveal((r) => !r)}
              >
                {reveal ? <EyeSlash size={18} /> : <Eye size={18} />}
              </IconButton>
            </span>
          </span>
        </Label>
        <div className="-mt-2 flex justify-end">
          <Link href="/forgot" className={cx(AUTH_INLINE_LINK, 'min-h-8 px-1 text-xs')}>Forgot password?</Link>
        </div>
        {ended && !error && !busy && <Alert tone="blue">Your session ended, please sign in again.</Alert>}
        {error && <Alert>{error}</Alert>}
        {linkSent && <Alert tone="blue" title="Check your email">{linkSent}</Alert>}
        <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
          {busy ? 'Signing in…' : <>Sign in <ArrowRight size={16} weight="bold" /></>}
        </Button>
      </form>

      <BetaCard />

      <div className="mt-8 space-y-3">
        <Divider label="or try a demo account" />
        <div className="grid grid-cols-2 gap-2">
          {DEMO.map((d, i) => {
            const picked = email === d.email;
            return (
              <button
                key={d.email}
                type="button"
                disabled={busy}
                aria-pressed={picked}
                onClick={() => { setEmail(d.email); setPassword(d.password); setError(null); setLinkSent(null); }}
                className={cx(
                  'group flex min-h-11 min-w-0 animate-rise items-center gap-2.5 rounded-xl border p-2.5 text-left transition duration-150 ease-out active:translate-y-0 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:pointer-events-none disabled:opacity-60 dark:focus-visible:ring-offset-ink-950',
                  staggerClass(i + 1),
                  picked ? 'border-brand-400 bg-brand-50 ring-4 ring-brand-500/10 dark:border-brand-400/60 dark:bg-brand-500/10' : 'border-line bg-surface hover:-translate-y-0.5 hover:border-line-strong hover:shadow-soft',
                )}
              >
                <Avatar name={d.name} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate text-[0.8125rem] font-semibold text-fg">{d.name.split(' ')[0]}</span>
                  <span className="block truncate text-[0.6875rem] text-fg-subtle">{d.role}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="flex items-start gap-1.5 text-xs leading-5 text-fg-subtle">
          <Sparkle size={14} className="mt-0.5 shrink-0 text-brand-500 dark:text-brand-300" />
          Picking one fills in its login. The admin also needs a 6-digit code from the secret in the README.
        </p>
      </div>

      <AuthFootnote />
    </AuthLayout>
  );
}
