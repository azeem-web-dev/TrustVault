'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { DeviceMobile, Fingerprint, ShieldCheckered } from '@phosphor-icons/react';
import { api, errorText, setStepUpHandler } from '@/lib/api';
import { Alert, Button, Divider, Modal } from './ui';

interface Methods {
  totp: boolean;
  passkeys: { id: string }[];
  stepUpMinutes: number;
}

/**
 * Asks for a fresh second factor when the API refuses a risky action with
 * `step_up_required` (THREATS.md S19), then lets lib/api retry the request.
 * The prompt itself proves nothing to the API: POST /auth/mfa/step-up does.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [methods, setMethods] = useState<Methods | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const finish = useCallback((ok: boolean) => {
    pending.current?.(ok);
    pending.current = null;
    setOpen(false);
    setCode('');
    setError(null);
  }, []);

  useEffect(() => {
    setStepUpHandler(() => new Promise<boolean>((resolve) => {
      // One prompt at a time; a second refusal while it is open just waits for it.
      const previous = pending.current;
      pending.current = (ok) => { previous?.(ok); resolve(ok); };
      setOpen(true);
      api.get<Methods>('/auth/mfa').then(setMethods).catch(() => setMethods({ totp: true, passkeys: [], stepUpMinutes: 5 }));
    }));
    return () => setStepUpHandler(null);
  }, []);

  const attempt = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      finish(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    void attempt(() => api.post('/auth/mfa/step-up', { code }));
  };

  const usePasskey = () => attempt(async () => {
    const options = await api.post<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/auth/mfa/passkeys/options');
    const response = await startAuthentication({ optionsJSON: options });
    await api.post('/auth/mfa/step-up', { response });
  });

  const hasPasskey = (methods?.passkeys.length ?? 0) > 0;
  return (
    <>
      {children}
      <Modal
        open={open}
        onClose={() => finish(false)}
        icon={<ShieldCheckered size={20} />}
        title="Confirm it’s you"
        description={`This action needs a second factor from the last ${methods?.stepUpMinutes ?? 5} minutes.`}
      >
        <div className="space-y-4">
          {error && <Alert>{error}</Alert>}
          {hasPasskey && <Button variant="primary" className="w-full" icon={<Fingerprint size={18} />} loading={busy && !code} onClick={() => void usePasskey()}>Use a passkey</Button>}
          {hasPasskey && methods?.totp && <Divider label="or enter a code" />}
          {(methods?.totp ?? true) && (
            <form onSubmit={submitCode} className="space-y-3">
              <label className="block">
                <span className="mb-2 flex items-center gap-2 text-[13px] font-medium text-slate-700 dark:text-slate-300"><DeviceMobile size={16} />6-digit code from your authenticator app</span>
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  aria-label="Code from your authenticator app"
                  className="h-14 w-full rounded-2xl border border-slate-200 bg-white text-center font-mono text-2xl font-semibold tracking-[0.45em] outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 dark:border-white/10 dark:bg-white/[0.04]"
                />
              </label>
              <Button type="submit" variant={hasPasskey ? 'secondary' : 'primary'} className="w-full" disabled={busy || code.length !== 6} loading={busy && code.length === 6}>Confirm and continue</Button>
            </form>
          )}
        </div>
      </Modal>
    </>
  );
}
