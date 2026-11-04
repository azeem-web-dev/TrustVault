'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { ArrowClockwise, ArrowLeft, CaretRight, DeviceMobile, EnvelopeSimple, Fingerprint, Key, ShieldCheckered, SignOut, Star } from '@phosphor-icons/react';
import { useSession } from '@/components/session';
import { AUTH_INLINE_LINK, AUTH_TEXT_ACTION, AuthHeader, AuthLayout } from '@/components/auth-layout';
import { Alert, Badge, Button, Divider, IconTile, Skeleton, Spinner, cx, staggerClass } from '@/components/ui';
import { TotpSetupGuide } from '@/components/totp-setup';
import { ApiError, api, errorText } from '@/lib/api';

type Busy = null | 'passkey' | 'code' | 'email' | 'setup' | 'register' | 'signout';

/** The browser's passkey sheet was dismissed: not worth a red banner (A7). */
const isCancelled = (err: unknown) => err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError');

function mfaErrorText(err: unknown): string {
  if (err instanceof Error && err.name === 'InvalidStateError') return 'This device already has a passkey for your account. Use it to sign in instead.';
  return errorText(err);
}

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
  /** Which action is running, so only its button spins and nothing submits twice (A7). */
  const [busy, setBusyState] = useState<Busy>(null);
  const busyRef = useRef<Busy>(null);
  const setBusy = (b: Busy) => { busyRef.current = b; setBusyState(b); };
  /** Loading the status failed for a reason other than "not signed in" (A4). */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoadingStatus(true);
    setLoadError(null);
    api.get<Status>('/auth/mfa').then((s) => {
      if (s.satisfied || !s.required) router.replace('/');
      else setStatus(s);
    }).catch((err: unknown) => {
      // Only a missing session means "start again"; a blip or a 5xx gets a retry.
      if (err instanceof ApiError && err.status === 401) router.replace('/login');
      else setLoadError(errorText(err, 'Could not reach the server'));
    }).finally(() => setLoadingStatus(false));
  }, [router]);

  useEffect(() => { load(); }, [load]);

  const enrolled = status ? status.totp || status.passkeys.length > 0 || status.email : false;
  const step = !status ? 'loading' : emailFlow ? `email-${emailFlow.purpose}` : setup ? 'setup' : enrolled ? 'verify' : 'pick';

  // Put the cursor in the code field whenever a code step appears (A9). The
  // setup step starts with the QR guide, so the field is not forced there.
  useEffect(() => {
    if (step !== 'loading' && step !== 'setup' && step !== 'pick') codeInput.current?.focus({ preventScroll: true });
  }, [step]);

  async function done() {
    await refresh();
    router.replace('/');
  }

  async function run(key: Exclude<Busy, null>, fn: () => Promise<unknown>) {
    if (busyRef.current) return; // one action at a time: no double submits
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (!isCancelled(err)) setError(mfaErrorText(err));
    } finally {
      setBusy(null);
    }
  }

  const verifyCode = (e: FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) return;
    const url = emailFlow ? (emailFlow.purpose === 'enable' ? '/auth/mfa/email/enable' : '/auth/mfa/email/verify')
      : setup ? '/auth/mfa/totp/enable' : '/auth/mfa/totp/verify';
    void run('code', async () => {
      await api.post(url, { code });
      await done();
    });
  };

  const sendEmail = (purpose: 'signin' | 'enable') => run('email', async () => {
    const r = await api.post<{ sentTo: string }>('/auth/mfa/email/send', { purpose });
    setSetup(null);
    setCode('');
    setEmailFlow({ purpose, sentTo: r.sentTo });
  });

  const usePasskey = () => run('passkey', async () => {
    const options = await api.post<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/auth/mfa/passkeys/options');
    const response = await startAuthentication({ optionsJSON: options });
    await api.post('/auth/mfa/passkeys/verify', { response });
    await done();
  });

  const startTotpSetup = () => run('setup', async () => {
    setSetup(await api.post<{ secret: string; otpauthUri: string }>('/auth/mfa/totp/setup'));
  });

  const registerPasskey = () => run('register', async () => {
    const options = await api.post<Parameters<typeof startRegistration>[0]['optionsJSON']>('/auth/mfa/passkeys/register/options');
    const response = await startRegistration({ optionsJSON: options });
    await api.post('/auth/mfa/passkeys/register', { response, name: 'My passkey' });
    await done();
  });

  const onSignOut = () => {
    if (busyRef.current) return;
    setBusy('signout');
    void signOut();
  };

  if (!status && loadError) {
    return (
      <AuthLayout stepKey="load-error">
        <AuthHeader icon={<ShieldCheckered size={26} />} title="Confirm it’s you" />
        <div className="space-y-4">
          <Alert
            title="Couldn’t load your sign-in options"
            action={<Button size="sm" icon={<ArrowClockwise size={14} weight="bold" />} loading={loadingStatus} onClick={load}>Try again</Button>}
          >
            {loadError}
          </Alert>
          <button type="button" disabled={busy !== null} onClick={onSignOut} className={cx(AUTH_TEXT_ACTION, 'gap-2')}>
            <SignOut size={16} />{busy === 'signout' ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </AuthLayout>
    );
  }

  if (!status) {
    return (
      <AuthLayout stepKey="loading">
        <span role="status" className="sr-only">Loading…</span>
        <Skeleton className="mb-5 size-14 rounded-2xl" />
        <Skeleton className="h-8 w-48 max-w-full" />
        <Skeleton className="mt-3 h-4 w-72 max-w-full" />
        <Skeleton className="mt-8 h-24 rounded-2xl" />
        <Skeleton className="mt-3 h-24 rounded-2xl" />
      </AuthLayout>
    );
  }
  // Authenticator first, then passkey, then email (an emailed code is the weakest).
  const showCodeForm = Boolean(emailFlow) || Boolean(setup) || status.totp;
  const onlyEmail = status.email && !status.totp && status.passkeys.length === 0;

  return (
    <AuthLayout stepKey={step}>
      <AuthHeader icon={<ShieldCheckered size={26} />} title={enrolled ? 'Confirm it’s you' : 'Set up a second factor'}>
        {enrolled
          ? <>Signed in as <span className="font-medium break-all text-fg">{user?.email ?? status.emailTo}</span>. Your account needs a second factor.</>
          : status.emailUnavailable ? 'Your account must use an authenticator app or a passkey. Choose one to continue.' : 'Your account needs two-step verification. Choose how you want to confirm it’s you.'}
      </AuthHeader>

      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}

        {enrolled && status.passkeys.length > 0 && !emailFlow && (
          <Button variant="primary" size="lg" className="w-full" onClick={() => void usePasskey()} loading={busy === 'passkey'} disabled={busy !== null} icon={<Fingerprint size={18} />}>Use a passkey</Button>
        )}

        {enrolled && status.passkeys.length > 0 && status.totp && !emailFlow && <Divider label="or enter a code" />}

        {onlyEmail && !emailFlow && (
          <Button variant="primary" size="lg" className="w-full" onClick={() => void sendEmail('signin')} loading={busy === 'email'} disabled={busy !== null} icon={<EnvelopeSimple size={18} />}>Send code to {status.emailTo}</Button>
        )}

        {showCodeForm && (
          <form onSubmit={verifyCode} className="space-y-4">
            {setup && (
              <div className="animate-pop rounded-2xl border border-line bg-surface p-4 shadow-soft sm:p-5">
                <TotpSetupGuide secret={setup.secret} otpauthUri={setup.otpauthUri}>
                  <p className="text-xs text-fg-subtle">Enter it below.</p>
                </TotpSetupGuide>
              </div>
            )}
            <label className="block">
              <span className="mb-2 flex items-center gap-2 text-[0.8125rem] font-medium text-fg-muted">
                {emailFlow ? <><EnvelopeSimple size={16} className="shrink-0 text-brand-500 dark:text-brand-300" /><span className="min-w-0 break-words">6-digit code we emailed to {emailFlow.sentTo}</span></> : <><DeviceMobile size={16} className="shrink-0 text-brand-500 dark:text-brand-300" />6-digit code from your authenticator app</>}
              </span>
              <input
                ref={codeInput}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                readOnly={busy === 'code'}
                className="h-16 w-full rounded-2xl border border-line bg-surface pl-[0.5em] text-center font-mono text-2xl font-semibold tracking-[0.5em] text-fg shadow-sm outline-none transition duration-150 ease-out placeholder:text-slate-300 hover:border-line-strong focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 read-only:opacity-60 min-[400px]:text-3xl dark:bg-white/[0.04] dark:placeholder:text-slate-600 dark:focus:border-brand-400"
              />
            </label>
            <div className="flex gap-1.5" aria-hidden>
              {Array.from({ length: 6 }, (_, i) => (
                <span key={i} className={cx('h-1 flex-1 rounded-full transition-colors duration-200', i < code.length ? 'bg-brand-gradient' : 'bg-line-strong')} />
              ))}
            </div>
            <Button type="submit" variant={status.passkeys.length ? 'secondary' : 'primary'} size="lg" className="w-full" loading={busy === 'code'} disabled={busy !== null || code.length !== 6}>
              {setup || emailFlow?.purpose === 'enable' ? 'Turn on and continue' : 'Verify'}
            </Button>
            {emailFlow && (
              <p className="text-center text-xs text-fg-subtle">
                It works once, for 10 minutes. No email?{' '}
                <button type="button" disabled={busy !== null} onClick={() => void sendEmail(emailFlow.purpose)} className={cx(AUTH_INLINE_LINK, 'min-h-8 px-1')}>
                  {busy === 'email' ? 'Sending…' : 'Send a new code'}
                </button>
              </p>
            )}
            {(setup || emailFlow) && (
              <button type="button" disabled={busy !== null} onClick={() => { setSetup(null); setEmailFlow(null); setCode(''); setError(null); }} className={AUTH_TEXT_ACTION}>
                <ArrowLeft size={14} />{onlyEmail ? 'Back' : enrolled ? 'Use another method' : 'Choose another method'}
              </button>
            )}
          </form>
        )}

        {enrolled && status.email && !onlyEmail && !emailFlow && (
          <button type="button" disabled={busy !== null} onClick={() => void sendEmail('signin')} className={AUTH_TEXT_ACTION}>
            <EnvelopeSimple size={16} />{busy === 'email' ? 'Sending…' : <>Email a code to {status.emailTo} instead</>}
          </button>
        )}

        {!enrolled && !setup && !emailFlow && (
          <div className="grid gap-3">
            <MethodButton index={0} onClick={() => void startTotpSetup()} disabled={busy !== null} busy={busy === 'setup'} icon={<DeviceMobile size={22} />} title="Use Google Authenticator" text="Or any authenticator app: a new 6-digit code every 30 seconds. Takes a minute." />
            <MethodButton index={1} onClick={() => void registerPasskey()} disabled={busy !== null} busy={busy === 'register'} icon={<Key size={22} />} title="Use a passkey (this device)" text="Face, fingerprint, PIN or a security key. Can't be phished." recommended />
            {!status.emailUnavailable && (
              <MethodButton index={2} onClick={() => void sendEmail('enable')} disabled={busy !== null} busy={busy === 'email'} icon={<EnvelopeSimple size={22} />} title={`Email me a code (${status.emailTo})`} text="Simplest, but weakest: anyone who can read your email could use it. We send a code now to check it reaches you." />
            )}
          </div>
        )}

        <button type="button" disabled={busy !== null} onClick={onSignOut} className={cx(AUTH_TEXT_ACTION, 'mt-2 gap-2')}>
          <SignOut size={16} />{busy === 'signout' ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </AuthLayout>
  );
}

function MethodButton({ icon, title, text, onClick, disabled, busy, recommended, index = 0 }: { icon: ReactNode; title: string; text: string; onClick: () => void; disabled?: boolean; busy?: boolean; recommended?: boolean; index?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy || undefined}
      className={cx('group flex w-full animate-rise items-center gap-3 rounded-2xl border border-line bg-surface p-4 text-left shadow-soft transition duration-150 ease-out hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-white active:translate-y-0 active:scale-[0.99] disabled:pointer-events-none disabled:opacity-60 sm:gap-4 dark:hover:border-brand-400/50 dark:focus-visible:ring-offset-ink-950', staggerClass(index + 1))}
    >
      <IconTile size="lg">{icon}</IconTile>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg"><span className="min-w-0 break-words">{title}</span>{recommended && <Badge tone="green" icon={<Star size={11} weight="fill" />}>Recommended</Badge>}</span>
        <span className="mt-0.5 block text-xs leading-5 text-fg-subtle">{text}</span>
      </span>
      {busy
        ? <Spinner className="text-brand-500 dark:text-brand-300" />
        : <CaretRight size={18} weight="bold" className="shrink-0 text-fg-subtle transition duration-150 ease-out group-hover:translate-x-0.5 group-hover:text-brand-500 dark:group-hover:text-brand-300" />}
    </button>
  );
}
