'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import QRCode from 'qrcode';
import { ArrowLeft, CaretRight, DeviceMobile, Fingerprint, Key, ShieldCheckered, SignOut } from '@phosphor-icons/react';
import { useSession } from '@/components/session';
import { AuthLayout } from '@/components/auth-layout';
import { Alert, Button, Divider, IconTile, Skeleton } from '@/components/ui';
import { api, errorText } from '@/lib/api';

interface Status {
  required: boolean;
  satisfied: boolean;
  totp: boolean;
  passkeys: { id: string; name: string }[];
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
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
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

  const verifyTotp = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post(setup ? '/auth/mfa/totp/enable' : '/auth/mfa/totp/verify', { code });
      await done();
    });
  };

  const usePasskey = () => run(async () => {
    const options = await api.post<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/auth/mfa/passkeys/options');
    const response = await startAuthentication({ optionsJSON: options });
    await api.post('/auth/mfa/passkeys/verify', { response });
    await done();
  });

  const startTotpSetup = () => run(async () => {
    const r = await api.post<{ secret: string; otpauthUri: string }>('/auth/mfa/totp/setup');
    setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 220 }) });
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
  const enrolled = status.totp || status.passkeys.length > 0;

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
            : 'Administrator accounts must use an authenticator app or a passkey. Choose one to continue.'}
        </p>
      </div>

      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}

        {enrolled && status.passkeys.length > 0 && (
          <Button variant="primary" size="lg" className="w-full" onClick={() => void usePasskey()} loading={busy} icon={<Fingerprint size={20} />}>Use a passkey</Button>
        )}

        {enrolled && status.passkeys.length > 0 && status.totp && <Divider label="or enter a code" />}

        {(status.totp || setup) && (
          <form onSubmit={verifyTotp} className="space-y-4">
            {setup && (
              <div className="animate-pop rounded-2xl border border-slate-200 bg-white p-5 shadow-soft dark:border-white/10 dark:bg-white/[0.03]">
                <ol className="space-y-1 text-sm text-slate-600 dark:text-slate-300">
                  <li><span className="font-semibold text-brand-600 dark:text-brand-300">1.</span> Open Google Authenticator, 1Password or Authy</li>
                  <li><span className="font-semibold text-brand-600 dark:text-brand-300">2.</span> Scan this code, then type the 6 digits below</li>
                </ol>
                <div className="mt-4 flex flex-col items-center gap-3 sm:flex-row sm:items-start">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={setup.qr} alt="QR code for your authenticator app" width={150} height={150} className="rounded-xl bg-white p-2 ring-1 ring-slate-200" />
                  <div className="min-w-0 text-center sm:text-left">
                    <p className="text-xs text-slate-500">Can&apos;t scan? Enter this key:</p>
                    <code className="mt-1 block break-all rounded-lg bg-slate-100 px-2.5 py-2 font-mono text-xs dark:bg-white/10">{setup.secret}</code>
                  </div>
                </div>
              </div>
            )}
            <label className="block">
              <span className="mb-2 flex items-center gap-2 text-[13px] font-medium text-slate-700 dark:text-slate-300"><DeviceMobile size={16} />6-digit code from your authenticator app</span>
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
              {setup ? 'Turn on and continue' : 'Verify'}
            </Button>
            {setup && (
              <button type="button" onClick={() => { setSetup(null); setCode(''); }} className="flex w-full items-center justify-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
                <ArrowLeft size={14} />Choose another method
              </button>
            )}
          </form>
        )}

        {!enrolled && !setup && (
          <div className="grid gap-3">
            <MethodButton onClick={() => void startTotpSetup()} disabled={busy} icon={<DeviceMobile size={22} />} title="Use an authenticator app" text="Google Authenticator, 1Password, Authy: a new code every 30 seconds." />
            <MethodButton onClick={() => void registerPasskey()} disabled={busy} icon={<Key size={22} />} title="Use a passkey (this device)" text="Face, fingerprint, PIN or a security key. Can't be phished." recommended />
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
