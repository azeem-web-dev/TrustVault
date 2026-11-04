'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, LinkBreak } from '@phosphor-icons/react';
import { useSession } from '@/components/session';
import { AUTH_TEXT_ACTION, AuthHeader, AuthLayout } from '@/components/auth-layout';
import { Alert, ButtonLink, Skeleton, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';

/**
 * Lands here from the emailed sign-in confirmation: /signin-link#token=…
 * (sent when the account had many failed sign-ins and this browser was new).
 * The token sits in the URL fragment, so it is never sent to a server or
 * leaked through Referer. It is read once, wiped from the address bar, and
 * spent straight away: opening the link is the confirmation.
 */
export default function SignInLinkPage() {
  const { signInWithLink } = useSession();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // Effects can run twice in development; the link works once.
    if (started.current) return;
    started.current = true;
    const hash = window.location.hash.replace(/^#/, '');
    const token = hash ? new URLSearchParams(hash).get('token') : null;
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    if (!token) {
      setError('This link is incomplete. Open it from your email again, or sign in again to get a new one.');
      return;
    }
    signInWithLink(token)
      .then(({ mfaRequired }) => router.replace(mfaRequired ? '/login/mfa' : '/'))
      .catch((err: unknown) => setError(errorText(err, 'Could not reach the server')));
  }, [router, signInWithLink]);

  if (!error) {
    return (
      <AuthLayout stepKey="working">
        <Skeleton className="mb-5 size-14 rounded-2xl" />
        <Skeleton className="h-8 w-56 max-w-full" />
        <Skeleton className="mt-3 h-4 w-72 max-w-full" />
        <p role="status" className="mt-8 flex items-center gap-2 text-sm text-fg-subtle"><Spinner className="text-brand-500 dark:text-brand-300" />Signing you in…</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout stepKey="failed">
      <AuthHeader icon={<LinkBreak size={26} />} title="This link did not work" tone="warning" />
      <div className="space-y-4">
        <Alert>{error}</Alert>
        <ButtonLink href="/login" variant="primary" size="lg" className="w-full">
          Sign in again <ArrowRight size={16} weight="bold" />
        </ButtonLink>
        <Link href="/forgot" className={AUTH_TEXT_ACTION}>
          <ArrowLeft size={14} />Didn’t try to sign in? Reset your password
        </Link>
      </div>
    </AuthLayout>
  );
}
