'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { ArrowClockwise, DeviceMobile, EnvelopeSimple, Fingerprint, ShieldCheckered } from '@phosphor-icons/react';
import { api, errorText, setStepUpHandler } from '@/lib/api';
import { Alert, Button, Divider, Modal, Skeleton, cx } from './ui';

interface Methods {
  totp: boolean;
  passkeys: { id: string }[];
  stepUpMinutes: number;
  email?: boolean;
  emailTo?: string;
}

type Busy = null | 'passkey' | 'code' | 'email';

/** The browser's passkey sheet was dismissed: not an error worth a red banner (A7). */
const isCancelled = (err: unknown) => err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError');

/**
 * Asks for a fresh second factor when the API refuses a risky action with
 * `step_up_required` (THREATS.md S20), then lets lib/api retry the request.
 * The prompt itself proves nothing to the API: POST /auth/mfa/step-up does.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [methods, setMethods] = useState<Methods | null>(null);
  /** Loading the sign-in methods failed; offer a retry instead of guessing (A3). */
  const [methodsError, setMethodsError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const busyRef = useRef<Busy>(null);
  /** Where an emailed step-up code went, once one was sent (THREATS.md S30). */
  const [sentTo, setSentTo] = useState<string | null>(null);
  const pending = useRef<((ok: boolean) => void) | null>(null);
  const loadSeq = useRef(0);

  const finish = useCallback((ok: boolean) => {
    pending.current?.(ok);
    pending.current = null;
    loadSeq.current++;
    setOpen(false);
    setCode('');
    setError(null);
    setSentTo(null);
  }, []);
  // Stable, so the Modal never re-runs its focus logic while typing (X1).
  const close = useCallback(() => finish(false), [finish]);

  const loadMethods = useCallback(() => {
    const id = ++loadSeq.current;
    setMethods(null);
    setMethodsError(null);
    api.get<Methods>('/auth/mfa')
      .then((m) => { if (id === loadSeq.current) setMethods(m); })
      .catch((err: unknown) => { if (id === loadSeq.current) setMethodsError(errorText(err, 'Could not load your sign-in methods.')); });
  }, []);

  useEffect(() => {
    setStepUpHandler(() => new Promise<boolean>((resolve) => {
      // One prompt at a time; a second refusal while it is open just waits for it.
      const previous = pending.current;
      pending.current = (ok) => { previous?.(ok); resolve(ok); };
      setOpen(true);
      if (!previous) loadMethods();
    }));
    return () => setStepUpHandler(null);
  }, [loadMethods]);

  const attempt = async (key: Exclude<Busy, null>, fn: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = key;
    setBusy(key);
    setError(null);
    try {
      await fn();
      finish(true);
    } catch (err) {
      if (!isCancelled(err)) setError(errorText(err));
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) return;
    void attempt('code', () => api.post('/auth/mfa/step-up', sentTo ? { code, method: 'email' } : { code }));
  };

  const sendEmail = async () => {
    if (busyRef.current) return;
    busyRef.current = 'email';
    setBusy('email');
    setError(null);
    try {
      const r = await api.post<{ sentTo: string }>('/auth/mfa/email/send', { purpose: 'stepup' });
      setCode('');
      setSentTo(r.sentTo);
    } catch (err) {
      setError(errorText(err));
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  const usePasskey = () => attempt('passkey', async () => {
    const options = await api.post<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/auth/mfa/passkeys/options');
    const response = await startAuthentication({ optionsJSON: options });
    await api.post('/auth/mfa/step-up', { response });
  });

  const hasPasskey = (methods?.passkeys.length ?? 0) > 0;
  const showCode = Boolean(sentTo) || Boolean(methods?.totp);
  const step = !methods ? (methodsError ? 'error' : 'loading') : sentTo ? 'email-code' : 'pick';

  // Each step swaps the dialog's content; when the control that had focus is
  // gone, move focus to the new step's main control (the code field, Retry…).
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dialog = content.current?.closest<HTMLElement>('[role="dialog"]');
    const active = document.activeElement;
    if (active && active !== document.body && active !== dialog && dialog?.contains(active)) return;
    content.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }, [open, step]);
  return (
    <>
      {children}
      <Modal
        open={open}
        onClose={close}
        icon={<ShieldCheckered size={20} />}
        title="Confirm it’s you"
        description={`This action needs a second factor from the last ${methods?.stepUpMinutes ?? 5} minutes.`}
      >
        <div key={step} ref={content} className="animate-fade-in space-y-4" aria-busy={step === 'loading' || undefined}>
          {error && <Alert>{error}</Alert>}

          {!methods && !methodsError && (
            <div role="status" className="space-y-3">
              <span className="sr-only">Loading your sign-in methods…</span>
              <Skeleton className="h-11 rounded-xl" />
              <Skeleton className="h-14 rounded-2xl" />
            </div>
          )}

          {!methods && methodsError && (
            <Alert
              title="Couldn’t load your sign-in methods"
              action={<Button size="sm" icon={<ArrowClockwise size={14} weight="bold" />} onClick={loadMethods} data-autofocus>Try again</Button>}
            >
              {methodsError}
            </Alert>
          )}

          {methods && (
            <>
              {hasPasskey && !sentTo && (
                <Button
                  variant="primary"
                  className="w-full"
                  icon={<Fingerprint size={18} />}
                  loading={busy === 'passkey'}
                  disabled={busy !== null}
                  onClick={() => void usePasskey()}
                  data-autofocus={!methods.totp || undefined}
                >
                  Use a passkey
                </Button>
              )}
              {hasPasskey && (methods.totp || methods.email) && !sentTo && <Divider label="or enter a code" />}
              {methods.email && !methods.totp && !sentTo && (
                <Button
                  variant={hasPasskey ? 'secondary' : 'primary'}
                  className="w-full"
                  icon={<EnvelopeSimple size={18} />}
                  loading={busy === 'email'}
                  disabled={busy !== null}
                  onClick={() => void sendEmail()}
                  data-autofocus={!hasPasskey || undefined}
                >
                  Email a code to {methods.emailTo}
                </Button>
              )}
              {showCode && (
                <form onSubmit={submitCode} className="space-y-3">
                  <label className="block">
                    <span className="mb-2 flex items-center gap-2 text-[0.8125rem] font-medium text-fg-muted">
                      {sentTo ? <><EnvelopeSimple size={16} className="shrink-0 text-brand-500 dark:text-brand-300" /><span className="min-w-0 break-words">6-digit code we emailed to {sentTo}</span></> : <><DeviceMobile size={16} className="shrink-0 text-brand-500 dark:text-brand-300" />6-digit code from your authenticator app</>}
                    </span>
                    <input
                      data-autofocus
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="000000"
                      aria-label={sentTo ? 'Code from the email' : 'Code from your authenticator app'}
                      readOnly={busy === 'code'}
                      className="h-14 w-full rounded-2xl border border-line bg-surface pl-[0.45em] text-center font-mono text-2xl font-semibold tracking-[0.45em] text-fg shadow-sm outline-none transition duration-150 ease-out placeholder:text-slate-300 hover:border-line-strong focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 read-only:opacity-60 dark:bg-white/[0.04] dark:placeholder:text-slate-600 dark:focus:border-brand-400"
                    />
                  </label>
                  <div className="flex gap-1.5" aria-hidden>
                    {Array.from({ length: 6 }, (_, i) => (
                      <span key={i} className={cx('h-1 flex-1 rounded-full transition-colors duration-200', i < code.length ? 'bg-brand-gradient' : 'bg-line-strong')} />
                    ))}
                  </div>
                  <Button type="submit" variant={hasPasskey && !sentTo ? 'secondary' : 'primary'} className="w-full" disabled={busy !== null || code.length !== 6} loading={busy === 'code'}>
                    Confirm and continue
                  </Button>
                  {sentTo && (
                    <p className="text-center text-xs text-fg-subtle">
                      No email?{' '}
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void sendEmail()}
                        className="inline-flex min-h-8 items-center gap-1 rounded px-1 font-medium text-brand-600 underline-offset-2 transition-colors hover:text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:min-h-11 dark:text-brand-300 dark:hover:text-brand-200"
                      >
                        {busy === 'email' ? 'Sending…' : 'Send a new code'}
                      </button>
                    </p>
                  )}
                </form>
              )}
              {methods.email && methods.totp && !sentTo && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void sendEmail()}
                  className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg px-2 text-sm text-fg-subtle transition duration-150 ease-out hover:bg-slate-100/70 hover:text-fg active:scale-[0.99] active:bg-slate-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/5 dark:active:bg-white/10"
                >
                  <EnvelopeSimple size={16} />{busy === 'email' ? 'Sending…' : 'Email me a code instead'}
                </button>
              )}
              {!hasPasskey && !methods.totp && !methods.email && (
                <Alert tone="amber" title="No second factor set up">
                  Add an authenticator app or a passkey on your Account page, then try again.
                </Alert>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
