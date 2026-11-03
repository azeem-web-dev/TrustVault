'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { ArrowLeft, CaretRight, DeviceMobile, EnvelopeSimple, Fingerprint, Key, ShieldCheckered, SignOut } from '@phosphor-icons/react';
import { useSession } from '@/components/session';
import { AuthLayout } from '@/components/auth-layout';
import { Alert, Button, Divider, IconTile, Skeleton } from '@/components/ui';
import { TotpSetupGuide } from '@/components/totp-setup';
import { api, errorText } from '@/lib/api';

interface Status {
  required: boolean;
  satisfied: boolean;
  totp: boolean;
  passkeys: { id: string; name: string }[];
  /** Emailed codes are on (THREATS.md S30). */
  email: boolean;
  emailTo: string;
  emailUnavailable: string | null;
}

/**
 * Second sign-in step. The session cookie from the password step can only
 * reach these routes; passing here replaces it with a new, full session.
 */
export default function MfaPage() {
  const { user, refresh, signOut } = useSession();
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  /** An emailed code is on its way: to finish signing in, or to turn email codes on. */
  const [emailFlow, setEmailFlow] = useState<{ purpose: 'signin' | 'enable'; sentTo: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Status>('/auth/mfa').then((s) => {
      if (s.satisfied || !s.required) router.replace('/');
      else setStatus(s);
    }).catch(() => router.replace('/login'));
  }, [router]);

  async function done() {
    await refresh();
    router.replace('/');
  }

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const verifyCode = (e: FormEvent) => {
    e.preventDefault();
    const url = emailFlow ? (emailFlow.purpose === 'enable' ? '/auth/mfa/email/enable' : '/auth/mfa/email/verify')
      : setup ? '/auth/mfa/totp/enable' : '/auth/mfa/totp/verify';
    void run(async () => {
      await api.post(url, { code });
      await done();
    });
  };

  const sendEmail = (purpose: 'signin' | 'enable') => run(async () => {
    const r = await api.post<{ sentTo: string }>('/auth/mfa/email/send', { purpose });
    setSetup(null);
    setCode('');
    setEmailFlow({ purpose, sentTo: r.sentTo });
  });

  const usePasskey = () => run(async () => {
    const options = await api.post<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/auth/mfa/passkeys/options');
    const response = await startAuthentication({ optionsJSON: options });
    await api.post('/auth/mfa/passkeys/verify', { response });
    await done();
  });

  const startTotpSetup = () => run(async () => {
    setSetup(await api.post<{ secret: string; otpauthUri: string }>('/auth/mfa/totp/setup'));
  });

  const registerPasskey = () => run(async () => {
    const options = await api.post<Parameters<typeof startRegistration>[0]['optionsJSON']>('/auth/mfa/passkeys/register/options');
    const response = await startRegistration({ optionsJSON: options });
    await api.post('/auth/mfa/passkeys/register', { response, name: 'My passkey' });
    await done();
  });

  if (!status) {
    return (
      <AuthLayout>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-3 h-4 w-72" />
        <Skeleton className="mt-8 h-24 rounded-2xl" />
        <Skeleton className="mt-3 h-24 rounded-2xl" />
      </AuthLayout>
    );
  }
  const enrolled = status.totp || status.passkeys.length > 0 || status.email;
  // Authenticator first, then passkey, then email (an emailed code is the weakest).
  const showCodeForm = Boolean(emailFlow) || Boolean(setup) || status.totp;
  const onlyEmail = status.email && !status.totp && status.passkeys.length === 0;

  return (
    <AuthLayout>
      <div className="mb-7">
        <span className="mb-5 inline-flex size-14 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-glow">
          <ShieldCheckered size={28} />
        </span>
        <h1 className="text-[26px] font-semibold tracking-tight">{enrolled ? 'Confirm it’s you' : 'Set up a second factor'}</h1>
        <p className="mt-1.5 text-sm leading-6 text-slate-500 dark:text-slate-400">
          {enrolled
            ? <>Signed in as <span className="font-medium text-slate-700 dark:text-slate-200">{user?.email ?? ''}</span>. Your account needs a second factor.</>
            : status.emailUnavailable ? 'Your account must use an authenticator app or a passkey. Choose one to continue.' : 'Your account needs two-step verification. Choose how you want to confirm it’s you.'}
        </p>
      </div>

      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}

        {enrolled && status.passkeys.length > 0 && !emailFlow && (
          <Button variant="primary" size="lg" className="w-full" onClick={() => void usePasskey()} loading={busy} icon={<Fingerprint size={20} />}>Use a passkey</Button>
        )}

        {enrolled && status.passkeys.length > 0 && status.totp && !emailFlow && <Divider label="or enter a code" />}

        {onlyEmail && !emailFlow && (
          <Button variant="primary" size="lg" className="w-full" onClick={() => void sendEmail('signin')} loading={busy} icon={<EnvelopeSimple size={20} />}>Send code to {status.emailTo}</Button>
        )}

        {showCodeForm && (
          <form onSubmit={verifyCode} className="space-y-4">
            {setup && (
              <div className="animate-pop rounded-2xl border border-slate-200 bg-white p-5 shadow-soft dark:border-white/10 dark:bg-white/[0.03]">
                <TotpSetupGuide secret={setup.secret} otpauthUri={setup.otpauthUri}>
                  <p className="text-xs text-slate-500">Enter it below.</p>
                </TotpSetupGuide>
              </div>
            )}
            <label className="block">
              <span className="mb-2 flex items-center gap-2 text-[13px] font-medium text-slate-700 dark:text-slate-300">
                {emailFlow ? <><EnvelopeSimple size={16} />6-digit code we emailed to {emailFlow.sentTo}</> : <><DeviceMobile size={16} />6-digit code from your authenticator app</>}
              </span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="h-16 w-full rounded-2xl border border-slate-200 bg-white text-center font-mono text-3xl font-semibold tracking-[0.5em] shadow-sm outline-none transition placeholder:text-slate-200 focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 dark:border-white/10 dark:bg-white/[0.04] dark:placeholder:text-slate-700 dark:focus:border-brand-400"
              />
            </label>
            <div className="flex gap-1.5" aria-hidden>
              {Array.from({ length: 6 }, (_, i) => (
                <span key={i} className={`h-1 flex-1 rounded-full transition ${i < code.length ? 'bg-brand-gradient' : 'bg-slate-200 dark:bg-white/10'}`} />
              ))}
            </div>
            <Button type="submit" variant={status.passkeys.length ? 'secondary' : 'primary'} size="lg" className="w-full" loading={busy && code.length === 6} disabled={busy || code.length !== 6}>
              {setup || emailFlow?.purpose === 'enable' ? 'Turn on and continue' : 'Verify'}
            </Button>
            {emailFlow && (
              <p className="text-center text-xs text-slate-500">
                It works once, for 10 minutes. No email?{' '}
                <button type="button" disabled={busy} onClick={() => void sendEmail(emailFlow.purpose)} className="font-medium text-brand-600 hover:underline dark:text-brand-300">Send a new code</button>
              </p>
            )}
            {(setup || emailFlow) && (
              <button type="button" onClick={() => { setSetup(null); setEmailFlow(null); setCode(''); }} className="flex w-full items-center justify-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
                <ArrowLeft size={14} />{enrolled ? 'Use another method' : 'Choose another method'}
              </button>
            )}
          </form>
        )}

        {enrolled && status.email && !onlyEmail && !emailFlow && (
          <button type="button" disabled={busy} onClick={() => void sendEmail('signin')} className="flex w-full items-center justify-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
            <EnvelopeSimple size={16} />Email a code to {status.emailTo} instead
          </button>
        )}

        {!enrolled && !setup && !emailFlow && (
          <div className="grid gap-3">
            <MethodButton onClick={() => void startTotpSetup()} disabled={busy} icon={<DeviceMobile size={22} />} title="Use Google Authenticator" text="Or any authenticator app: a new 6-digit code every 30 seconds. Takes a minute." />
            <MethodButton onClick={() => void registerPasskey()} disabled={busy} icon={<Key size={22} />} title="Use a passkey (this device)" text="Face, fingerprint, PIN or a security key. Can't be phished." recommended />
            {!status.emailUnavailable && (
              <MethodButton onClick={() => void sendEmail('enable')} disabled={busy} icon={<EnvelopeSimple size={22} />} title={`Email me a code (${status.emailTo})`} text="Simplest, but weakest: anyone who can read your email could use it. We send a code now to check it reaches you." />
            )}
          </div>
        )}

        <button onClick={() => void signOut()} className="flex w-full items-center justify-center gap-2 pt-2 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
          <SignOut size={16} />Sign out
        </button>
      </div>
    </AuthLayout>
  );
}

function MethodButton({ icon, title, text, onClick, disabled, recommended }: { icon: ReactNode; title: string; text: string; onClick: () => void; disabled?: boolean; recommended?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group flex w-full items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-soft transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-lift disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-brand-400/50"
    >
      <IconTile size="lg">{icon}</IconTile>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-semibold">{title}{recommended && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">Recommended</span>}</span>
        <span className="mt-0.5 block text-xs leading-5 text-slate-500 dark:text-slate-400">{text}</span>
      </span>
      <CaretRight size={18} className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-500" />
    </button>
  );
}
