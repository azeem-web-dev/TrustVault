'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { startRegistration } from '@simplewebauthn/browser';
import { CheckCircle, Circle, Desktop, DeviceMobile, Devices, EnvelopeSimple, Fingerprint, Key, LockSimple, Password, Plus, ShieldCheck, ShieldCheckered, SignOut, Trash, UserCircleGear } from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { useToast } from '@/components/toast';
import { Alert, Avatar, Badge, Button, Card, IconButton, IconTile, Input, Label, PageTitle, SkeletonRows, relativeTime } from '@/components/ui';
import { TotpSetupGuide } from '@/components/totp-setup';
import { api, errorText, formatDate } from '@/lib/api';

interface MfaStatus {
  required: boolean;
  requiredByRole: boolean;
  satisfied: boolean;
  totp: boolean;
  passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
  /** Emailed codes are on (THREATS.md S30). */
  email: boolean;
  emailTo: string;
  /** Why email codes cannot be turned on for this account (admins, demo accounts), or null. */
  emailUnavailable: string | null;
}

interface Device {
  id: string;
  device: string;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  authLevel: string;
  current: boolean;
}

const ROLE_LABEL = { ADMIN: 'Administrator', OWNER: 'Document owner', VIEWER: 'Viewer', EXTERNAL: 'External partner' } as const;

export default function AccountPage() {
  const { user, refresh } = useSession();
  const router = useRouter();
  const toast = useToast();
  const [mfa, setMfa] = useState<MfaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [totp, setTotp] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [code, setCode] = useState('');
  const [passkeyName, setPasskeyName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  /** Turning email codes on: where the code went, and what was typed. */
  const [emailSetup, setEmailSetup] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState('');

  const load = useCallback(() => Promise.all([
    api.get<MfaStatus>('/auth/mfa').then(setMfa),
    api.get<{ sessions: Device[] }>('/auth/sessions').then((r) => setDevices(r.sessions)),
  ]).catch((e) => setError(errorText(e))), []);
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
  const factorCount = mfa ? Number(mfa.totp) + mfa.passkeys.length + Number(mfa.email) : 0;
  /** Your role must keep a factor, and this is the only one left. */
  const lastRequired = (mfa?.requiredByRole ?? false) && factorCount <= 1;

  const startEmail = () => run('email-send', async () => {
    const r = await api.post<{ sentTo: string }>('/auth/mfa/email/send', { purpose: 'enable' });
    setEmailCode('');
    setEmailSetup(r.sentTo);
  }, 'Code sent. Check your email.');

  const confirmEmail = (e: FormEvent) => {
    e.preventDefault();
    void run('email-on', async () => {
      await api.post('/auth/mfa/email/enable', { code: emailCode });
      setEmailSetup(null);
      setEmailCode('');
      await refresh();
    }, 'Email codes turned on');
  };

  // Turning off is a step-up route: lib/api asks for a fresh factor first.
  const stopEmail = () => run('email-off', () => api.delete('/auth/mfa/email'), 'Email codes turned off');
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
          <Card
            title="Two-step verification"
            icon={<ShieldCheckered size={20} />}
            description="After your password, TrustVault asks for one more thing only you have. Turning a method on or off needs a code."
            actions={mfa && <Badge tone={factorCount ? 'green' : 'neutral'} dot>{factorCount ? 'On' : 'Off: password only'}</Badge>}
            padded={false}
          >
            {!mfa ? <SkeletonRows rows={3} /> : (
              <ul className="divide-y divide-slate-100 dark:divide-white/[0.05]">
                <FactorRow icon={<DeviceMobile size={18} />} title="Authenticator app" text="Google Authenticator or similar. Set up below." on={mfa.totp} />
                <FactorRow icon={<Fingerprint size={18} />} title="Passkeys" text={hasPasskey ? `${mfa.passkeys.length} added. Manage them below.` : 'Strongest: can’t be phished. Add one below.'} on={hasPasskey} />
                <li className="px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <IconTile tone={mfa.email ? 'green' : 'brand'}><EnvelopeSimple size={18} /></IconTile>
                    <span className="min-w-0 flex-1 text-sm font-semibold">
                      Email code
                      <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">
                        {mfa.emailUnavailable ?? `A 6-digit code sent to ${mfa.emailTo} each time. Easy, but weaker: anyone who can read your email can use it.`}
                      </span>
                    </span>
                    <Toggle
                      label="Email code"
                      on={mfa.email}
                      disabled={Boolean(mfa.emailUnavailable && !mfa.email) || (mfa.email && lastRequired) || busy !== null || Boolean(emailSetup)}
                      onChange={(next) => void (next ? startEmail() : stopEmail())}
                    />
                  </div>
                  {mfa.email && lastRequired && (
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Your role must keep two-step verification. Add an authenticator app or passkey before turning email codes off.</p>
                  )}
                  {emailSetup && (
                    <form onSubmit={confirmEmail} className="mt-3 animate-pop rounded-xl bg-slate-50 p-4 dark:bg-white/[0.04]">
                      <p className="mb-2 text-sm">We emailed a 6-digit code to <span className="font-medium">{emailSetup}</span>. Enter it to turn email codes on.</p>
                      <div className="flex flex-wrap gap-2">
                        <Input className="w-36 text-center font-mono tracking-[0.3em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={emailCode} onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" aria-label="Code from the email" />
                        <Button type="submit" variant="primary" disabled={emailCode.length !== 6} loading={busy === 'email-on'}>Turn on</Button>
                        <Button type="button" variant="ghost" onClick={() => { setEmailSetup(null); setEmailCode(''); }}>Cancel</Button>
                      </div>
                      <button type="button" className="mt-2 text-xs text-brand-600 hover:underline dark:text-brand-300" disabled={busy !== null} onClick={() => void startEmail()}>No email? Send a new code</button>
                    </form>
                  )}
                </li>
              </ul>
            )}
          </Card>

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
                  <Input className="min-w-[12.5rem] flex-1" icon={<Key size={18} />} placeholder="Name, e.g. Work laptop" value={passkeyName} onChange={(e) => setPasskeyName(e.target.value)} />
                  <Button variant="primary" icon={<Plus size={16} weight="bold" />} onClick={() => void addPasskey()} loading={busy === 'passkey'}>Add passkey</Button>
                </div>
              </>
            )}
          </Card>

          <Card title="Authenticator app" icon={<DeviceMobile size={20} />} description="A 6-digit code that changes every 30 seconds." actions={mfa && <Badge tone={mfa.totp ? 'green' : 'neutral'} dot>{mfa.totp ? 'On' : 'Off'}</Badge>}>
            {!mfa ? <SkeletonRows rows={1} /> : mfa.totp ? (
              <div className="flex flex-wrap items-center gap-3 rounded-xl bg-emerald-50/60 p-4 text-sm dark:bg-emerald-500/10">
                <ShieldCheck size={22} className="text-emerald-600 dark:text-emerald-300" />
                <span className="min-w-0 flex-1">Set up. You will be asked for a code when you sign in.</span>
                {!(mfa.requiredByRole && !hasPasskey && !mfa.email) && (
                  <Button variant="danger" size="sm" icon={<Trash size={14} />} loading={busy === 'totp-rm'} onClick={() => void run('totp-rm', () => api.delete('/auth/mfa/totp'), 'Authenticator app removed')}>Remove</Button>
                )}
              </div>
            ) : totp ? (
              <form onSubmit={(e) => { e.preventDefault(); void run('totp', async () => { await api.post('/auth/mfa/totp/enable', { code }); setTotp(null); setCode(''); await refresh(); }, 'Authenticator app turned on'); }} className="animate-pop">
                <TotpSetupGuide secret={totp.secret} otpauthUri={totp.otpauthUri}>
                  <div className="flex gap-2">
                    <Input className="w-36 text-center font-mono tracking-[0.3em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" aria-label="Code from the app" />
                    <Button type="submit" variant="primary" disabled={code.length !== 6} loading={busy === 'totp'}>Turn on</Button>
                  </div>
                </TotpSetupGuide>
              </form>
            ) : (
              <Button icon={<DeviceMobile size={18} />} loading={busy === 'totp-setup'} onClick={() => void run('totp-setup', async () => {
                setTotp(await api.post<{ secret: string; otpauthUri: string }>('/auth/mfa/totp/setup'));
              }, 'Follow the three steps to finish')}>Set up Google Authenticator</Button>
            )}
          </Card>
        </div>

        <div className="space-y-6 lg:col-span-2">
          <Card title="Signed-in devices" icon={<Devices size={20} />} description="Where your account is signed in now. Sign out anything you don’t recognise." padded={false}
            actions={devices && devices.length > 1 && (
              <Button size="sm" variant="danger" icon={<SignOut size={14} />} loading={busy === 'others'} onClick={() => void run('others', () => api.post('/auth/sessions/revoke-others'), 'Signed out everywhere else')}>Sign out all others</Button>
            )}>
            {!devices ? <SkeletonRows rows={2} /> : (
              <ul className="divide-y divide-slate-100 dark:divide-white/[0.05]">
                {devices.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 px-5 py-3.5">
                    <IconTile tone={d.current ? 'green' : 'brand'}>{/app|Android|iPhone/.test(d.device) ? <DeviceMobile size={18} /> : <Desktop size={18} />}</IconTile>
                    <span className="min-w-0 flex-1 text-sm font-semibold">
                      {d.device}{d.current && <Badge tone="green" className="ml-2">This device</Badge>}
                      <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">
                        {d.ip ?? 'Unknown IP'} · signed in {formatDate(d.createdAt)} · active {relativeTime(d.lastSeenAt)}{d.authLevel !== 'mfa' && ' · password only'}
                      </span>
                    </span>
                    {!d.current && <Button variant="secondary" size="sm" loading={busy === `so-${d.id}`} onClick={() => void run(`so-${d.id}`, () => api.delete(`/auth/sessions/${d.id}`), 'Device signed out')}>Sign out</Button>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

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

function FactorRow({ icon, title, text, on }: { icon: ReactNode; title: string; text: string; on: boolean }) {
  return (
    <li className="flex items-center gap-3 px-5 py-3.5">
      <IconTile tone={on ? 'green' : 'brand'}>{icon}</IconTile>
      <span className="min-w-0 flex-1 text-sm font-semibold">
        {title}
        <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">{text}</span>
      </span>
      <Badge tone={on ? 'green' : 'neutral'} dot>{on ? 'On' : 'Off'}</Badge>
    </li>
  );
}

/** An on/off switch (role="switch"). */
function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (next: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${on ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-white/20'}`}
    >
      <span className={`inline-block size-5 rounded-full bg-white shadow transition ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
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
