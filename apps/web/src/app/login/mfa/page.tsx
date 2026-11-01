'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import QRCode from 'qrcode';
import { useSession } from '@/components/session';
import { Logo } from '@/components/shell';
import { Alert, Button, Input, Label } from '@/components/ui';
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
    setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 200 }) });
  });

  const registerPasskey = () => run(async () => {
    const options = await api.post<Parameters<typeof startRegistration>[0]['optionsJSON']>('/auth/mfa/passkeys/register/options');
    const response = await startRegistration({ optionsJSON: options });
    await api.post('/auth/mfa/passkeys/register', { response, name: 'My passkey' });
    await done();
  });

  if (!status) return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Loading…</div>;
  const enrolled = status.totp || status.passkeys.length > 0;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-2 text-xl font-semibold">
          <Logo /> TrustVault
        </div>
        <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div>
            <h1 className="text-lg font-semibold">{enrolled ? 'Confirm it is you' : 'Set up a second factor'}</h1>
            <p className="mt-1 text-sm text-slate-500">
              {enrolled
                ? `Signed in as ${user?.email ?? ''}. Your account needs a second factor.`
                : 'Administrator accounts must use an authenticator app or a passkey. Choose one to continue.'}
            </p>
          </div>

          {error && <Alert>{error}</Alert>}

          {enrolled && status.passkeys.length > 0 && (
            <Button variant="primary" className="w-full py-2" onClick={() => void usePasskey()} disabled={busy}>Use a passkey</Button>
          )}

          {(status.totp || setup) && (
            <form onSubmit={verifyTotp} className="space-y-3">
              {setup && (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-slate-300 p-4 dark:border-slate-700">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={setup.qr} alt="QR code for your authenticator app" width={200} height={200} />
                  <p className="text-xs text-slate-500">Scan with an authenticator app, or enter this key:</p>
                  <code className="break-all text-xs">{setup.secret}</code>
                </div>
              )}
              <Label label="6-digit code from your authenticator app">
                <Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              </Label>
              <Button type="submit" variant={status.passkeys.length ? 'secondary' : 'primary'} className="w-full py-2" disabled={busy || code.length !== 6}>
                {setup ? 'Turn on and continue' : 'Verify'}
              </Button>
            </form>
          )}

          {!enrolled && !setup && (
            <div className="grid gap-2">
              <Button variant="primary" className="py-2" onClick={() => void startTotpSetup()} disabled={busy}>Use an authenticator app</Button>
              <Button className="py-2" onClick={() => void registerPasskey()} disabled={busy}>Use a passkey (this device)</Button>
            </div>
          )}

          <button onClick={() => void signOut()} className="w-full text-center text-sm text-slate-500 hover:underline">Sign out</button>
        </div>
      </div>
    </main>
  );
}
