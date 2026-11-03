'use client';

import { useEffect, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { AppleLogo, ArrowSquareOut, Check, Copy, GooglePlayLogo } from '@phosphor-icons/react';

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
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void QRCode.toDataURL(otpauthUri, { margin: 1, width: 200 }).then(setQr);
  }, [otpauthUri]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
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
          {qr
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={qr} alt="QR code for your authenticator app" width={168} height={168} className="mx-auto shrink-0 rounded-2xl bg-white p-2 ring-1 ring-slate-200 sm:mx-0" />
            : <span className="mx-auto block size-[10.5rem] shrink-0 animate-pulse rounded-2xl bg-slate-100 sm:mx-0 dark:bg-white/10" />}
          <div className="min-w-0 space-y-2">
            <p className="text-xs text-slate-500">On this phone already? <a href={otpauthUri} className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline dark:text-brand-300">Open in authenticator app<ArrowSquareOut size={12} /></a></p>
            <p className="text-xs text-slate-500">Can’t scan? Choose <b>Enter a setup key</b>, type any name, and this key (time based):</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-words rounded-lg bg-slate-100 px-2.5 py-2 font-mono text-sm tracking-wider dark:bg-white/10" aria-label="Setup key">{groupKey(secret)}</code>
              <button type="button" onClick={() => void copy()} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-medium hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/5">
                {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy key'}
              </button>
            </div>
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
      <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-xs font-semibold text-white">{n}</span>
      <div className="min-w-0 flex-1 text-slate-600 dark:text-slate-300">
        <p className="mb-1 font-semibold text-slate-800 dark:text-slate-100">{title}</p>
        {children}
      </div>
    </li>
  );
}

function StoreLink({ href, icon, children }: { href: string; icon: ReactNode; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/5">
      {icon}{children}
    </a>
  );
}

