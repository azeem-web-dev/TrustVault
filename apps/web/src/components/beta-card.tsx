'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { AndroidLogo, ArrowSquareOut, CaretDown, CheckCircle, Envelope, PaperPlaneTilt } from '@phosphor-icons/react';
import { Alert, Button, Input, cx } from '@/components/ui';
import { api, errorText } from '@/lib/api';

const GROUP_URL = 'https://groups.google.com/g/trust-vault-beta-users';
const STORE_URL = 'https://play.google.com/store/apps/details?id=cloud.rayyanazeem.trustvault';
const LINK = 'inline-flex min-h-9 items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-xs font-medium text-fg-muted transition hover:border-line-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 pointer-coarse:min-h-11';

/** "Try the Android beta": the three closed-test steps, collapsed on narrow screens. */
export function BetaCard() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try { setOpen(window.matchMedia('(min-width: 1024px)').matches); } catch { /* stays collapsed */ }
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/beta/signup', { email });
      setSent(true);
    } catch (err) {
      setError(errorText(err, 'Could not reach the server'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-2xl border border-line bg-surface shadow-soft">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex min-h-11 w-full items-center gap-2.5 rounded-2xl px-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50">
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300"><AndroidLogo size={16} /></span>
        <span className="min-w-0 flex-1 text-sm font-semibold text-fg">Try the Android beta</span>
        <CaretDown size={14} className={cx('shrink-0 text-fg-subtle transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ol className="space-y-3.5 border-t border-line px-3.5 py-3.5 text-xs leading-5 text-fg-subtle">
          <li>
            <p className="font-medium text-fg">1. Join the testers group</p>
            <p>Use the Google account that is on your phone.</p>
            <a href={GROUP_URL} target="_blank" rel="noopener noreferrer" className={cx(LINK, 'mt-1.5')}>Open the group <ArrowSquareOut size={12} /></a>
          </li>
          <li>
            <p className="font-medium text-fg">2. Get the Play Store link by email</p>
            {sent ? (
              <p className="mt-1.5 flex items-center gap-1.5 text-fg"><CheckCircle size={16} weight="fill" className="text-emerald-600 dark:text-emerald-400" />Check your email.</p>
            ) : (
              <form onSubmit={submit} className="mt-1.5 space-y-2">
                <Input icon={<Envelope size={16} />} type="email" autoComplete="email" required maxLength={254} aria-label="Email for the beta link" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com" />
                {error && <Alert>{error}</Alert>}
                <Button type="submit" size="sm" loading={busy} className="w-full" icon={<PaperPlaneTilt size={14} />}>{busy ? 'Sending…' : 'Email me the link'}</Button>
              </form>
            )}
          </li>
          <li>
            <p className="font-medium text-fg">3. Install from the Play Store</p>
            <p>Already joined? <a href={STORE_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 underline-offset-2 hover:underline dark:text-brand-300">Install here</a>.</p>
          </li>
        </ol>
      )}
    </section>
  );
}
