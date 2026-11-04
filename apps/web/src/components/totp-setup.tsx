'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { AppleLogo, ArrowSquareOut, Check, Copy, GooglePlayLogo, QrCode, Warning } from '@phosphor-icons/react';

const PLAY_STORE = 'https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2';
const APP_STORE = 'https://apps.apple.com/app/google-authenticator/id388497605';

/** "ABCD EFGH ..." — easier to type into an app by hand. */
export const groupKey = (secret: string): string => secret.replace(/(.{4})/g, '$1 ').trim();

/**
 * The three steps to set up Google Authenticator (or any TOTP app). The key
 * and QR code come from POST /auth/mfa/totp/setup; the code typed in step 3
 * is checked by the API, which computes exactly what the app computes
 * (RFC 6238, SHA-1, 6 digits, 30 s; test/totp.unit.test.ts).
 */
export function TotpSetupGuide({ secret, otpauthUri, children }: { secret: string; otpauthUri: string; children: ReactNode }) {
  /** The QR data URL; 'error' when it could not be drawn (A8). */
  const [qr, setQr] = useState<string | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyEl = useRef<HTMLElement>(null);

  useEffect(() => {
    let live = true;
    setQr(null);
    QRCode.toDataURL(otpauthUri, { margin: 1, width: 200 })
      .then((url) => { if (live) setQr(url); })
      .catch(() => { if (live) setQr('error'); });
    return () => { live = false; };
  }, [otpauthUri]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const flash = (state: 'copied' | 'failed') => {
    setCopy(state);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopy('idle'), state === 'copied' ? 2000 : 4000);
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      flash('copied');
    } catch {
      // Clipboard blocked (insecure context or denied): select the key so it can be copied by hand.
      const el = keyEl.current;
      const sel = typeof window !== 'undefined' ? window.getSelection() : null;
      if (el && sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      flash('failed');
    }
  };

  return (
    <ol className="space-y-5">
      <Step n={1} title="Install an authenticator app">
        <p>Google Authenticator is free. Microsoft Authenticator, 1Password or Authy work too.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <StoreLink href={PLAY_STORE} icon={<GooglePlayLogo size={16} />}>Google Play</StoreLink>
          <StoreLink href={APP_STORE} icon={<AppleLogo size={16} />}>App Store</StoreLink>
        </div>
      </Step>
      <Step n={2} title="Add TrustVault to the app">
        <p>In the app tap <b>+</b>, then <b>Scan a QR code</b> and point your phone at this code.</p>
        <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start">
          {qr === 'error' ? (
            <span role="status" className="mx-auto flex size-[10.5rem] shrink-0 animate-fade-in flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong bg-surface-2 p-3 text-center text-xs text-fg-subtle sm:mx-0">
              <QrCode size={26} className="text-fg-subtle" />
              QR code unavailable. Use the key instead.
            </span>
          ) : qr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt="QR code for your authenticator app" width={168} height={168} className="mx-auto shrink-0 animate-fade-in rounded-2xl bg-white p-2 shadow-soft ring-1 ring-line sm:mx-0" />
          ) : (
            <span aria-hidden className="skeleton mx-auto block size-[10.5rem] shrink-0 rounded-2xl sm:mx-0" />
          )}
          <div className="min-w-0 space-y-2">
            <p className="text-xs text-fg-subtle">
              On this phone already?{' '}
              <a href={otpauthUri} className="inline-flex items-center gap-1 rounded font-medium text-brand-600 underline-offset-2 transition-colors hover:text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 pointer-coarse:min-h-11 dark:text-brand-300 dark:hover:text-brand-200">
                Open in authenticator app<ArrowSquareOut size={12} />
              </a>
            </p>
            <p className="text-xs text-fg-subtle">Can’t scan? Choose <b>Enter a setup key</b>, type any name, and this key (time based):</p>
            <div className="flex items-center gap-2">
              <code ref={keyEl} className="min-w-0 flex-1 select-all break-words rounded-lg border border-line bg-surface-2 px-2.5 py-2 font-mono text-sm tracking-wider text-fg dark:bg-white/10" aria-label="Setup key">{groupKey(secret)}</code>
              <button
                type="button"
                onClick={() => void copyKey()}
                className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-2 text-xs font-medium text-fg-muted shadow-soft transition duration-150 ease-out hover:border-line-strong hover:bg-slate-50 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 active:scale-[0.98] active:bg-slate-100 pointer-coarse:min-h-11 dark:hover:bg-white/5 dark:active:bg-white/10"
              >
                {copy === 'copied' ? <Check size={14} weight="bold" className="animate-pop text-success-600 dark:text-success-300" /> : <Copy size={14} />}{copy === 'copied' ? 'Copied' : 'Copy key'}
              </button>
            </div>
            <p aria-live="polite" className="min-h-4 text-xs text-warning-700 dark:text-warning-300">
              {copy === 'failed' && <span className="inline-flex animate-fade-in items-center gap-1"><Warning size={14} weight="fill" className="shrink-0" />Couldn’t copy. The key is selected: copy it by hand.</span>}
            </p>
          </div>
        </div>
      </Step>
      <Step n={3} title="Type the 6-digit code it shows">
        <p className="mb-2">The code changes every 30 seconds; use the newest one.</p>
        {children}
      </Step>
    </ol>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 text-sm">
      <span aria-hidden className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-xs font-semibold text-white shadow-glow">{n}</span>
      <div className="min-w-0 flex-1 leading-6 text-fg-muted">
        <p className="mb-1 font-semibold text-fg">{title}</p>
        {children}
      </div>
    </li>
  );
}

function StoreLink({ href, icon, children }: { href: string; icon: ReactNode; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-fg-muted shadow-soft transition duration-150 ease-out hover:border-line-strong hover:bg-slate-50 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 active:scale-[0.98] active:bg-slate-100 pointer-coarse:min-h-11 dark:hover:bg-white/5 dark:active:bg-white/10">
      {icon}{children}
    </a>
  );
}
