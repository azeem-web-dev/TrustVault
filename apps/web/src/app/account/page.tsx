'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { startRegistration } from '@simplewebauthn/browser';
import QRCode from 'qrcode';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { Alert, Badge, Button, Card, Input, Label, PageTitle } from '@/components/ui';
import { api, errorText, formatDate } from '@/lib/api';

interface MfaStatus {
  required: boolean;
  satisfied: boolean;
  totp: boolean;
  passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
}

export default function AccountPage() {
  const { user, refresh } = useSession();
  const router = useRouter();
  const [mfa, setMfa] = useState<MfaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [totp, setTotp] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [passkeyName, setPasskeyName] = useState('');

  const load = useCallback(() => api.get<MfaStatus>('/auth/mfa').then(setMfa).catch((e) => setError(errorText(e))), []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, success: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(success);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const changePassword = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post('/auth/password', { currentPassword: pw.current, newPassword: pw.next });
      router.replace('/login');
    }, 'Password changed. You have been signed out everywhere.');
  };

  return (
    <Shell>
      <PageTitle title="Account" subtitle={`${user?.displayName} · ${user?.email}`} />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {notice && <div className="mb-4"><Alert tone="green">{notice}</Alert></div>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Password">
          <form onSubmit={changePassword} className="space-y-3">
            <Label label="Current password"><Input type="password" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Label>
            <Label label="New password" hint="At least 12 characters. Changing it signs you out on every device."><Input type="password" autoComplete="new-password" minLength={12} required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Label>
            <Button type="submit" variant="primary">Change password</Button>
          </form>
        </Card>

        <Card title="Second factor" actions={mfa && <Badge tone={mfa.totp || mfa.passkeys.length ? 'green' : 'amber'}>{mfa.totp || mfa.passkeys.length ? 'On' : 'Off'}</Badge>}>
          {!mfa ? <p className="text-sm text-slate-500">Loading…</p> : (
            <div className="space-y-5 text-sm">
              <div>
                <h3 className="font-medium">Authenticator app</h3>
                {mfa.totp ? <p className="text-slate-500">Set up. You will be asked for a code when you sign in.</p> : totp ? (
                  <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.post('/auth/mfa/totp/enable', { code }); setTotp(null); setCode(''); await refresh(); }, 'Authenticator app turned on'); }} className="mt-2 space-y-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={totp.qr} alt="QR code for your authenticator app" width={180} height={180} />
                    <code className="block break-all text-xs">{totp.secret}</code>
                    <Label label="Code from the app"><Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Label>
                    <Button type="submit" variant="primary" disabled={code.length !== 6}>Turn on</Button>
                  </form>
                ) : (
                  <Button className="mt-2" onClick={() => void run(async () => {
                    const r = await api.post<{ secret: string; otpauthUri: string }>('/auth/mfa/totp/setup');
                    setTotp({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 180 }) });
                  }, 'Scan the code, then enter the 6 digits')}>Set up an authenticator app</Button>
                )}
              </div>
              <div>
                <h3 className="font-medium">Passkeys</h3>
                <ul className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
                  {mfa.passkeys.map((p) => (
                    <li key={p.id} className="flex items-center justify-between py-2">
                      <span>{p.name}<span className="block text-xs text-slate-500">Added {formatDate(p.createdAt)} · last used {formatDate(p.lastUsedAt)}</span></span>
                      <Button variant="danger" onClick={() => void run(() => api.delete(`/auth/mfa/passkeys/${p.id}`), 'Passkey removed')}>Remove</Button>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex gap-2">
                  <Input placeholder="Name, e.g. Work laptop" value={passkeyName} onChange={(e) => setPasskeyName(e.target.value)} />
                  <Button onClick={() => void run(async () => {
                    const options = await api.post<Parameters<typeof startRegistration>[0]['optionsJSON']>('/auth/mfa/passkeys/register/options');
                    const response = await startRegistration({ optionsJSON: options });
                    await api.post('/auth/mfa/passkeys/register', { response, name: passkeyName.trim() || 'Passkey' });
                    setPasskeyName('');
                    await refresh();
                  }, 'Passkey added')}>Add passkey</Button>
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>
    </Shell>
  );
}
