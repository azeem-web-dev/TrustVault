'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { startRegistration } from '@simplewebauthn/browser';
import { CheckCircle, Circle, Desktop, DeviceMobile, Devices, EnvelopeSimple, Fingerprint, Info, Key, LockSimple, Password, Plus, ShieldCheckered, SignOut, Trash, UserCircleGear } from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { useToast, type ToastTone } from '@/components/toast';
import { Alert, Avatar, Badge, Button, Card, IconTile, Input, Label, LoadError, PageTitle, SkeletonRows, Switch, cx, relativeTime, staggerClass } from '@/components/ui';
import { TotpSetupGuide } from '@/components/totp-setup';
import { api, errorText, formatDate } from '@/lib/api';
import { isAbortError, useAction, useLatest } from '@/lib/hooks';

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
/** The server caps passkey names at 60 characters (mfa.controller RegisterSchema). */
const PASSKEY_NAME_MAX = 60;
/** Wait this long before another emailed code can be requested. */
const RESEND_COOLDOWN_MS = 30_000;
/** Returned by an action the person cancelled: no success toast, no reload. */
const CANCELLED = Symbol('cancelled');

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
  const { busy, run: runAction } = useAction();
  const anyBusy = busy !== null;
  /** Turning email codes on: where the code went, and what was typed. */
  const [emailSetup, setEmailSetup] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState('');
  /** "Send a new code" is paused for a short while after each send. */
  const [resendPaused, setResendPaused] = useState(false);
  const resendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resendTimer.current) clearTimeout(resendTimer.current); }, []);
  /** Each card's last load error. With no data yet, the card shows LoadError + Retry instead of an endless skeleton (X3). */
  const [mfaError, setMfaError] = useState<unknown>(null);
  const [devicesError, setDevicesError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const latest = useLatest();

  const load = useCallback(async () => {
    const t = latest.begin();
    setLoading(true);
    const [m, d] = await Promise.allSettled([
      api.get<MfaStatus>('/auth/mfa', { signal: t.signal }),
      api.get<{ sessions: Device[] }>('/auth/sessions', { signal: t.signal }),
    ]);
    if (!t.isLatest()) return;
    setLoading(false);
    if (m.status === 'fulfilled') { setMfa(m.value); setMfaError(null); } else if (!isAbortError(m.reason)) setMfaError(m.reason);
    if (d.status === 'fulfilled') { setDevices(d.value.sessions); setDevicesError(null); } else if (!isAbortError(d.reason)) setDevicesError(d.reason);
  }, [latest]);
  useEffect(() => {
    void load();
  }, [load]);

  /**
   * One action at a time: useAction ignores a second click while one runs, so
   * nothing is sent twice (X4). On success: toast, then reload the cards.
   */
  const run = (key: string, fn: () => Promise<unknown>, success: string, tone?: ToastTone) => runAction(key, async () => {
    setError(null);
    try {
      if ((await fn()) === CANCELLED) return;
      toast(success, tone);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  });

  // Changing the password ends every session, this one included (U4). Don't
  // reload the cards on the dead session: clear the fields, let the session
  // context see the 401 and drop the old user, then go to sign-in.
  const changePassword = (e: FormEvent) => {
    e.preventDefault();
    void runAction('pw', async () => {
      setError(null);
      try {
        await api.post('/auth/password', { currentPassword: pw.current, newPassword: pw.next });
      } catch (err) {
        setError(errorText(err));
        return;
      }
      setPw({ current: '', next: '' });
      latest.cancel();
      toast('Password changed. You have been signed out everywhere.');
      await refresh();
      router.replace('/login');
    });
  };

  const addPasskey = () => run('passkey', async () => {
    const options = await api.post<Parameters<typeof startRegistration>[0]['optionsJSON']>('/auth/mfa/passkeys/register/options');
    let response: Awaited<ReturnType<typeof startRegistration>>;
    try {
      response = await startRegistration({ optionsJSON: options });
    } catch (err) {
      // The person closed the browser's passkey prompt: not a failure (U7).
      if (err instanceof Error && err.name === 'NotAllowedError') {
        toast('Passkey not added', 'info');
        return CANCELLED;
      }
      throw err;
    }
    await api.post('/auth/mfa/passkeys/register', { response, name: passkeyName.trim().slice(0, PASSKEY_NAME_MAX) || 'Passkey' });
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
    setResendPaused(true);
    if (resendTimer.current) clearTimeout(resendTimer.current);
    resendTimer.current = setTimeout(() => setResendPaused(false), RESEND_COOLDOWN_MS);
  }, 'Code sent. Check your email.', 'info');

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
  // The score counts second factors (app, passkey or email), not the password (U7).
  const checks = [
    { done: factorCount > 0, label: 'Two-step verification on' },
    { done: hasPasskey, label: 'Passkey (phishing-resistant)' },
    { done: factorCount >= 2, label: 'A backup method' },
  ];
  const score = checks.filter((c) => c.done).length;
  const strength = Math.min(100, (pw.next.length / 20) * 100);
  // A reload that fails while the cards already show data: say so above them.
  const staleCause = (mfa && mfaError) || (devices && devicesError) || null;
  const staleError = staleCause ? errorText(staleCause) : null;
  const mfaPlaceholder = (rows: number) => (mfaError
    ? <LoadError compact className="p-5" error={mfaError} title="Couldn’t load your sign-in methods" onRetry={() => void load()} retrying={loading} />
    : <SkeletonRows rows={rows} />);

  return (
    <Shell>
      <PageTitle title="Account & security" icon={<UserCircleGear size={26} />} subtitle="Your password and second factors. Every change here is recorded in the audit trail." />

      <section className="relative mb-6 animate-rise overflow-hidden rounded-3xl border border-line bg-surface p-5 shadow-soft sm:p-6">
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-40 [mask-image:linear-gradient(to_left,black,transparent_60%)]" />
        <div className="relative flex flex-wrap items-center gap-4 sm:gap-6">
          {user && <Avatar name={user.displayName} size="xl" />}
          <div className="min-w-0 flex-1">
            <p className="text-xl font-semibold tracking-tight text-fg [overflow-wrap:anywhere]">{user?.displayName}</p>
            <p className="text-sm text-fg-subtle [overflow-wrap:anywhere]">{user?.email}</p>
            {user && <Badge tone="violet" className="mt-2">{ROLE_LABEL[user.role]}</Badge>}
          </div>
          <div className="flex w-full animate-fade-in items-center gap-4 rounded-2xl border border-line bg-surface-2/70 p-4 backdrop-blur-sm sm:w-auto">
            <ScoreRing value={score} max={3} />
            <ul aria-label="Security checklist" className="space-y-1.5 text-xs">
              {checks.map((c) => (
                <li key={c.label} className="flex items-center gap-1.5">
                  {c.done ? <CheckCircle size={16} weight="fill" className="shrink-0 text-success-500" /> : <Circle size={16} weight="bold" className="shrink-0 text-fg-subtle" />}
                  <span className={c.done ? 'font-medium text-fg' : 'text-fg-subtle'}><span className="sr-only">{c.done ? 'Done: ' : 'To do: '}</span>{c.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {(error || staleError) && (
        <div className="mb-4 animate-fade-in">
          <Alert onDismiss={() => { setError(null); setMfaError(null); setDevicesError(null); }}>{error ?? staleError}</Alert>
        </div>
      )}

      <div className="grid gap-4 sm:gap-6 lg:grid-cols-5">
        <div className="min-w-0 space-y-4 sm:space-y-6 lg:col-span-3">
          <Card
            title="Two-step verification"
            icon={<ShieldCheckered size={20} />}
            description="After your password, TrustVault asks for one more thing only you have. Turning a method on or off needs a code."
            actions={mfa && <Badge tone={factorCount ? 'green' : 'neutral'} dot>{factorCount ? 'On' : 'Off: password only'}</Badge>}
            padded={false}
            className="animate-rise stagger-1"
          >
            {!mfa ? mfaPlaceholder(3) : (
              <ul className="animate-fade-in divide-y divide-line">
                <FactorRow icon={<DeviceMobile size={20} />} title="Authenticator app" text="Google Authenticator or similar. Set up below." on={mfa.totp} />
                <FactorRow icon={<Fingerprint size={20} />} title="Passkeys" text={hasPasskey ? `${mfa.passkeys.length} added. Manage them below.` : 'Strongest: can’t be phished. Add one below.'} on={hasPasskey} />
                <li className="px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <IconTile tone={mfa.email ? 'green' : 'brand'}><EnvelopeSimple size={20} /></IconTile>
                    <span className="min-w-0 flex-1 text-sm font-semibold text-fg">
                      Email code
                      <span className="block text-xs font-normal text-fg-subtle">
                        {mfa.emailUnavailable ?? `A 6-digit code sent to ${mfa.emailTo} each time. Easy, but weaker: anyone who can read your email can use it.`}
                      </span>
                    </span>
                    <Switch
                      aria-label="Email codes"
                      aria-describedby={mfa.email && lastRequired ? 'email-last-factor' : undefined}
                      checked={mfa.email}
                      disabled={Boolean(mfa.emailUnavailable && !mfa.email) || (mfa.email && lastRequired) || anyBusy || Boolean(emailSetup)}
                      onChange={(next) => void (next ? startEmail() : stopEmail())}
                    />
                  </div>
                  {mfa.email && lastRequired && (
                    <p id="email-last-factor" className="mt-2 flex items-start gap-1.5 text-xs text-fg-subtle"><Info size={14} className="mt-px shrink-0 text-info-500" />Your role must keep two-step verification. Add an authenticator app or passkey before turning email codes off.</p>
                  )}
                  {emailSetup && (
                    <form onSubmit={confirmEmail} className="mt-3 animate-pop rounded-xl bg-surface-2 p-4 ring-1 ring-inset ring-line">
                      <p className="mb-3 text-sm text-fg-muted">We emailed a 6-digit code to <span className="font-medium text-fg [overflow-wrap:anywhere]">{emailSetup}</span>. Enter it to turn email codes on.</p>
                      <div className="flex flex-wrap gap-2">
                        <Input className="w-36 text-center font-mono tracking-[0.3em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={emailCode} onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" aria-label="Code from the email" />
                        <Button type="submit" variant="primary" disabled={emailCode.length !== 6} loading={busy === 'email-on'}>Turn on</Button>
                        <Button type="button" variant="ghost" disabled={anyBusy} onClick={() => { setEmailSetup(null); setEmailCode(''); }}>Cancel</Button>
                      </div>
                      <button
                        type="button"
                        className="mt-1 inline-flex min-h-11 items-center rounded text-xs font-medium text-brand-600 underline-offset-2 transition-colors hover:text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:cursor-not-allowed disabled:text-fg-subtle disabled:no-underline sm:min-h-8 dark:text-brand-300 dark:hover:text-brand-200"
                        disabled={anyBusy || resendPaused}
                        onClick={() => void startEmail()}
                      >
                        {busy === 'email-send' ? 'Sending a new code…' : resendPaused ? 'Code sent. You can ask for another in a moment.' : 'No email? Send a new code'}
                      </button>
                    </form>
                  )}
                </li>
              </ul>
            )}
          </Card>

          <Card title="Passkeys" icon={<Fingerprint size={20} />} description="Sign in with your face, fingerprint, PIN or a security key. They can't be phished." actions={mfa && <Badge tone={hasPasskey ? 'green' : 'neutral'} dot>{hasPasskey ? `${mfa.passkeys.length} added` : 'None yet'}</Badge>} padded={false} className="animate-rise stagger-2">
            {!mfa ? mfaPlaceholder(2) : (
              <>
                {mfa.passkeys.length > 0 && (
                  <ul className="animate-fade-in divide-y divide-line">
                    {mfa.passkeys.map((p, i) => (
                      <li key={p.id} className={cx('flex animate-rise flex-wrap items-center gap-3 px-5 py-3.5 transition-colors hover:bg-surface-2/60', staggerClass(i))}>
                        <IconTile tone="violet"><Key size={20} /></IconTile>
                        <span className="min-w-0 flex-1 text-sm font-semibold text-fg [overflow-wrap:anywhere]">
                          {p.name}
                          <span className="block text-xs font-normal text-fg-subtle">Added {formatDate(p.createdAt)} · last used {relativeTime(p.lastUsedAt)}</span>
                        </span>
                        <Button
                          variant="danger"
                          size="sm"
                          icon={<Trash size={14} />}
                          disabled={anyBusy || lastRequired}
                          aria-describedby={lastRequired ? 'passkey-last-factor' : undefined}
                          onClick={() => void run(`rm-${p.id}`, () => api.delete(`/auth/mfa/passkeys/${p.id}`), 'Passkey removed')}
                          loading={busy === `rm-${p.id}`}
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {lastRequired && hasPasskey && (
                  <p id="passkey-last-factor" className="flex items-start gap-1.5 px-5 pb-3.5 text-xs text-fg-subtle"><Info size={14} className="mt-px shrink-0 text-info-500" />Your role must keep two-step verification. Add an authenticator app or email codes before removing this passkey.</p>
                )}
                <div className="flex flex-wrap gap-2 border-t border-line bg-surface-2/50 px-5 py-4">
                  <Input className="min-w-[12.5rem] flex-1" icon={<Key size={18} />} placeholder="Name, e.g. Work laptop" aria-label="Passkey name" maxLength={PASSKEY_NAME_MAX} value={passkeyName} onChange={(e) => setPasskeyName(e.target.value)} />
                  <Button variant="primary" icon={<Plus size={16} weight="bold" />} disabled={anyBusy} onClick={() => void addPasskey()} loading={busy === 'passkey'}>Add passkey</Button>
                </div>
              </>
            )}
          </Card>

          <Card title="Authenticator app" icon={<DeviceMobile size={20} />} description="A 6-digit code that changes every 30 seconds." actions={mfa && <Badge tone={mfa.totp ? 'green' : 'neutral'} dot>{mfa.totp ? 'On' : 'Off'}</Badge>} className="animate-rise stagger-3">
            {!mfa ? mfaPlaceholder(1) : mfa.totp ? (
              <div className="animate-fade-in">
                <div className="flex flex-wrap items-center gap-3 rounded-xl bg-success-50/70 p-4 text-sm text-fg ring-1 ring-inset ring-success-100 dark:bg-success-500/10 dark:ring-success-500/20">
                  <CheckCircle size={20} weight="fill" className="shrink-0 text-success-600 dark:text-success-300" />
                  <span className="min-w-0 flex-1">Set up. You will be asked for a code when you sign in.</span>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash size={14} />}
                    disabled={anyBusy || lastRequired}
                    aria-describedby={lastRequired ? 'totp-last-factor' : undefined}
                    loading={busy === 'totp-rm'}
                    onClick={() => void run('totp-rm', () => api.delete('/auth/mfa/totp'), 'Authenticator app removed')}
                  >
                    Remove
                  </Button>
                </div>
                {lastRequired && (
                  <p id="totp-last-factor" className="mt-2 flex items-start gap-1.5 text-xs text-fg-subtle"><Info size={14} className="mt-px shrink-0 text-info-500" />Your role must keep two-step verification. Add a passkey or email codes before removing the app.</p>
                )}
              </div>
            ) : totp ? (
              <form onSubmit={(e) => { e.preventDefault(); void run('totp', async () => { await api.post('/auth/mfa/totp/enable', { code }); setTotp(null); setCode(''); await refresh(); }, 'Authenticator app turned on'); }} className="animate-pop">
                <TotpSetupGuide secret={totp.secret} otpauthUri={totp.otpauthUri}>
                  <div className="flex flex-wrap gap-2">
                    <Input className="w-36 text-center font-mono tracking-[0.3em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" aria-label="Code from the app" />
                    <Button type="submit" variant="primary" disabled={code.length !== 6} loading={busy === 'totp'}>Turn on</Button>
                    <Button type="button" variant="ghost" disabled={anyBusy} onClick={() => { setTotp(null); setCode(''); }}>Cancel</Button>
                  </div>
                </TotpSetupGuide>
              </form>
            ) : (
              <Button variant="soft" icon={<Plus size={16} weight="bold" />} disabled={anyBusy} loading={busy === 'totp-setup'} onClick={() => void run('totp-setup', async () => {
                setTotp(await api.post<{ secret: string; otpauthUri: string }>('/auth/mfa/totp/setup'));
              }, 'Follow the three steps to finish', 'info')}>Set up Google Authenticator</Button>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4 sm:space-y-6 lg:col-span-2">
          <Card title="Signed-in devices" icon={<Devices size={20} />} description="Where your account is signed in now. Sign out anything you don’t recognise." padded={false} className="animate-rise stagger-2"
            actions={devices && devices.length > 1 && (
              <Button size="sm" variant="danger" icon={<SignOut size={14} />} disabled={anyBusy} loading={busy === 'others'} onClick={() => void run('others', () => api.post('/auth/sessions/revoke-others'), 'Signed out everywhere else')}>Sign out all others</Button>
            )}>
            {!devices ? (devicesError
              ? <LoadError compact className="p-5" error={devicesError} title="Couldn’t load your devices" onRetry={() => void load()} retrying={loading} />
              : <SkeletonRows rows={2} />) : (
              <ul className="animate-fade-in divide-y divide-line">
                {devices.map((d, i) => (
                  <li key={d.id} className={cx('flex animate-rise flex-wrap items-center gap-3 px-5 py-3.5 transition-colors hover:bg-surface-2/60', staggerClass(i))}>
                    <IconTile tone={d.current ? 'green' : 'brand'}>{/app|Android|iPhone/.test(d.device) ? <DeviceMobile size={20} /> : <Desktop size={20} />}</IconTile>
                    <span className="min-w-0 flex-1 text-sm font-semibold text-fg [overflow-wrap:anywhere]">
                      {d.device}{d.current && <Badge tone="green" className="ml-2">This device</Badge>}
                      <span className="block text-xs font-normal text-fg-subtle">
                        {d.ip ?? 'Unknown IP'} · signed in {formatDate(d.createdAt)} · active {relativeTime(d.lastSeenAt)}{d.authLevel !== 'mfa' && ' · password only'}
                      </span>
                    </span>
                    {!d.current && <Button variant="secondary" size="sm" icon={<SignOut size={14} />} disabled={anyBusy} loading={busy === `so-${d.id}`} onClick={() => void run(`so-${d.id}`, () => api.delete(`/auth/sessions/${d.id}`), 'Device signed out')}>Sign out</Button>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Password" icon={<Password size={20} />} description="Changing it signs you out on every device." className="animate-rise stagger-3">
            <form onSubmit={changePassword} className="space-y-4">
              <Label label="Current password"><Input icon={<LockSimple size={18} />} type="password" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Label>
              <Label label="New password" hint="At least 12 characters. Length matters more than symbols.">
                <Input icon={<LockSimple size={18} />} type="password" autoComplete="new-password" minLength={12} required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
              </Label>
              {pw.next && (
                <div className="-mt-1 animate-fade-in">
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-2 ring-1 ring-inset ring-line">
                    <div className={`h-full rounded-full transition-[width,background-color] duration-300 ease-out ${pw.next.length < 12 ? 'bg-danger-500' : pw.next.length < 16 ? 'bg-warning-500' : 'bg-success-500'}`} style={{ width: `${strength}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-fg-subtle">{pw.next.length < 12 ? `${12 - pw.next.length} more characters needed` : pw.next.length < 16 ? 'Good. Longer is even better.' : 'Strong'}</p>
                </div>
              )}
              <Button type="submit" variant="primary" className="w-full" icon={<Key size={16} />} disabled={anyBusy && busy !== 'pw'} loading={busy === 'pw'}>Change password</Button>
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
      <span className="min-w-0 flex-1 text-sm font-semibold text-fg">
        {title}
        <span className="block text-xs font-normal text-fg-subtle">{text}</span>
      </span>
      <Badge tone={on ? 'green' : 'neutral'} dot>{on ? 'On' : 'Off'}</Badge>
    </li>
  );
}

/** Security score as a ring. Colours come from tone classes via currentColor, not hex (X14). */
function ScoreRing({ value, max }: { value: number; max: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const tone = value === max ? 'text-success-500' : value >= 2 ? 'text-brand-500 dark:text-brand-400' : 'text-warning-500';
  return (
    <div role="img" aria-label={`Security score ${value} of ${max}`} className="relative size-16 shrink-0">
      <svg viewBox="0 0 64 64" className="size-16 -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth="6" className="text-line-strong" />
        <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - value / max)} className={cx('transition-[stroke-dashoffset,color] duration-700 ease-out', tone)} />
      </svg>
      <span aria-hidden className="absolute inset-0 flex flex-col items-center justify-center">
        <span key={value} className="animate-pop text-sm font-bold text-fg tabular-nums">{value}/{max}</span>
      </span>
    </div>
  );
}
