'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { startRegistration } from '@simplewebauthn/browser';
import QRCode from 'qrcode';
import { CheckCircle, Circle, DeviceMobile, Fingerprint, Key, LockSimple, Password, Plus, ShieldCheck, Trash, UserCircleGear } from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { useToast } from '@/components/toast';
import { Alert, Avatar, Badge, Button, Card, IconButton, IconTile, Input, Label, PageTitle, SkeletonRows, relativeTime } from '@/components/ui';
import { api, errorText, formatDate } from '@/lib/api';

interface MfaStatus {
  required: boolean;
  satisfied: boolean;
  totp: boolean;
  passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
}

const ROLE_LABEL = { ADMIN: 'Administrator', OWNER: 'Document owner', VIEWER: 'Viewer', EXTERNAL: 'External partner' } as const;

export default function AccountPage() {
  const { user, refresh } = useSession();
  const router = useRouter();
  const toast = useToast();
  const [mfa, setMfa] = useState<MfaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [totp, setTotp] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [passkeyName, setPasskeyName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => api.get<MfaStatus>('/auth/mfa').then(setMfa).catch((e) => setError(errorText(e))), []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setError(null);
    setBusy(key);
    try {
      await fn();
      toast(success);
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const changePassword = (e: FormEvent) => {
    e.preventDefault();
    void run('pw', async () => {
      await api.post('/auth/password', { currentPassword: pw.current, newPassword: pw.next });
      router.replace('/login');
    }, 'Password changed. You have been signed out everywhere.');
  };

  const addPasskey = () => run('passkey', async () => {
    const options = await api.post<Parameters<typeof startRegistration>[0]['optionsJSON']>('/auth/mfa/passkeys/register/options');
    const response = await startRegistration({ optionsJSON: options });
    await api.post('/auth/mfa/passkeys/register', { response, name: passkeyName.trim() || 'Passkey' });
    setPasskeyName('');
    await refresh();
  }, 'Passkey added');

  const hasPasskey = (mfa?.passkeys.length ?? 0) > 0;
  const checks = [
    { done: true, label: 'Strong password (12+ characters)' },
    { done: Boolean(mfa?.totp), label: 'Authenticator app' },
    { done: hasPasskey, label: 'Passkey (phishing-resistant)' },
  ];
  const score = checks.filter((c) => c.done).length;
  const strength = Math.min(100, (pw.next.length / 20) * 100);

  return (
    <Shell>
      <PageTitle title="Account & security" icon={<UserCircleGear size={26} />} subtitle="Your password and second factors. Every change here is recorded in the audit trail." />

      <section className="relative mb-6 animate-rise overflow-hidden rounded-3xl border border-slate-200/80 bg-white p-6 shadow-soft dark:border-white/[0.08] dark:bg-white/[0.03]">
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-40 [mask-image:linear-gradient(to_left,black,transparent_60%)]" />
        <div className="relative flex flex-wrap items-center gap-6">
          {user && <Avatar name={user.displayName} size="xl" />}
          <div className="min-w-0 flex-1">
            <p className="text-xl font-semibold tracking-tight">{user?.displayName}</p>
            <p className="text-sm text-slate-500 dark:text-slate-400">{user?.email}</p>
            {user && <Badge tone="violet" className="mt-2">{ROLE_LABEL[user.role]}</Badge>}
          </div>
          <div className="flex items-center gap-4 rounded-2xl border border-slate-200/80 bg-white/80 p-4 dark:border-white/10 dark:bg-white/5">
            <ScoreRing value={score} max={3} />
            <ul className="space-y-1 text-xs">
              {checks.map((c) => (
                <li key={c.label} className="flex items-center gap-1.5">
                  {c.done ? <CheckCircle size={16} weight="fill" className="text-emerald-500" /> : <Circle size={16} className="text-slate-300 dark:text-slate-600" />}
                  <span className={c.done ? '' : 'text-slate-500'}>{c.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {error && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Card title="Passkeys" icon={<Fingerprint size={20} />} description="Sign in with your face, fingerprint, PIN or a security key. They can't be phished." actions={mfa && <Badge tone={hasPasskey ? 'green' : 'neutral'} dot>{hasPasskey ? `${mfa.passkeys.length} added` : 'None yet'}</Badge>} padded={false}>
            {!mfa ? <SkeletonRows rows={2} /> : (
              <>
                {mfa.passkeys.length > 0 && (
                  <ul className="divide-y divide-slate-100 dark:divide-white/[0.05]">
                    {mfa.passkeys.map((p) => (
                      <li key={p.id} className="flex items-center gap-3 px-5 py-3.5">
                        <IconTile tone="violet"><Key size={18} /></IconTile>
                        <span className="min-w-0 flex-1 text-sm font-semibold">
                          {p.name}
                          <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">Added {formatDate(p.createdAt)} · last used {relativeTime(p.lastUsedAt)}</span>
                        </span>
                        <Button variant="danger" size="sm" icon={<Trash size={14} />} onClick={() => void run(`rm-${p.id}`, () => api.delete(`/auth/mfa/passkeys/${p.id}`), 'Passkey removed')} loading={busy === `rm-${p.id}`}>Remove</Button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap gap-2 border-t border-slate-100 bg-slate-50/50 px-5 py-4 dark:border-white/[0.05] dark:bg-white/[0.02]">
                  <Input className="min-w-[200px] flex-1" icon={<Key size={18} />} placeholder="Name, e.g. Work laptop" value={passkeyName} onChange={(e) => setPasskeyName(e.target.value)} />
                  <Button variant="primary" icon={<Plus size={16} weight="bold" />} onClick={() => void addPasskey()} loading={busy === 'passkey'}>Add passkey</Button>
                </div>
              </>
            )}
          </Card>

          <Card title="Authenticator app" icon={<DeviceMobile size={20} />} description="A 6-digit code that changes every 30 seconds." actions={mfa && <Badge tone={mfa.totp ? 'green' : 'neutral'} dot>{mfa.totp ? 'On' : 'Off'}</Badge>}>
            {!mfa ? <SkeletonRows rows={1} /> : mfa.totp ? (
              <div className="flex items-center gap-3 rounded-xl bg-emerald-50/60 p-4 text-sm dark:bg-emerald-500/10">
                <ShieldCheck size={22} className="text-emerald-600 dark:text-emerald-300" />
                <span>Set up. You will be asked for a code when you sign in.</span>
              </div>
            ) : totp ? (
              <form onSubmit={(e) => { e.preventDefault(); void run('totp', async () => { await api.post('/auth/mfa/totp/enable', { code }); setTotp(null); setCode(''); await refresh(); }, 'Authenticator app turned on'); }} className="grid animate-pop gap-5 sm:grid-cols-[auto_1fr]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={totp.qr} alt="QR code for your authenticator app" width={168} height={168} className="mx-auto rounded-2xl bg-white p-2 ring-1 ring-slate-200" />
                <div className="space-y-3">
                  <Step n={1}>Open Google Authenticator, 1Password or Authy and scan the code.</Step>
                  <Step n={2}>Or enter this key: <code className="mt-1 block break-all rounded-lg bg-slate-100 px-2 py-1.5 font-mono text-xs dark:bg-white/10">{totp.secret}</code></Step>
                  <Step n={3}>Type the 6 digits the app shows.</Step>
                  <div className="flex gap-2">
                    <Input className="w-36 text-center font-mono tracking-[0.3em]" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" aria-label="Code from the app" />
                    <Button type="submit" variant="primary" disabled={code.length !== 6} loading={busy === 'totp'}>Turn on</Button>
                  </div>
                </div>
              </form>
            ) : (
              <Button icon={<DeviceMobile size={18} />} loading={busy === 'totp-setup'} onClick={() => void run('totp-setup', async () => {
                const r = await api.post<{ secret: string; otpauthUri: string }>('/auth/mfa/totp/setup');
                setTotp({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 180 }) });
              }, 'Scan the code, then enter the 6 digits')}>Set up an authenticator app</Button>
            )}
          </Card>
        </div>

        <div className="lg:col-span-2">
          <Card title="Password" icon={<Password size={20} />} description="Changing it signs you out on every device.">
            <form onSubmit={changePassword} className="space-y-4">
              <Label label="Current password"><Input icon={<LockSimple size={18} />} type="password" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Label>
              <Label label="New password" hint="At least 12 characters. Length matters more than symbols.">
                <Input icon={<LockSimple size={18} />} type="password" autoComplete="new-password" minLength={12} required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
              </Label>
              {pw.next && (
                <div className="-mt-1">
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10">
                    <div className={`h-full rounded-full transition-all ${pw.next.length < 12 ? 'bg-red-500' : pw.next.length < 16 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${strength}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{pw.next.length < 12 ? `${12 - pw.next.length} more characters needed` : pw.next.length < 16 ? 'Good. Longer is even better.' : 'Strong'}</p>
                </div>
              )}
              <Button type="submit" variant="primary" className="w-full" loading={busy === 'pw'}>Change password</Button>
            </form>
          </Card>
        </div>
      </div>
    </Shell>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-xs font-semibold text-white">{n}</span>
      <div className="min-w-0 pt-0.5 text-slate-600 dark:text-slate-300">{children}</div>
    </div>
  );
}

function ScoreRing({ value, max }: { value: number; max: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const color = value === max ? '#10b981' : value >= 2 ? '#6366f1' : '#f59e0b';
  return (
    <div className="relative size-16">
      <svg viewBox="0 0 64 64" className="size-16 -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth="6" className="text-slate-100 dark:text-white/10" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - value / max)} className="transition-all duration-700" />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-sm font-bold tabular-nums">{value}/{max}</span>
      </span>
    </div>
  );
}
