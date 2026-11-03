'use client';

import type { ReactNode } from 'react';
import { Fingerprint, LinkSimpleHorizontal, LockKey, ShieldCheck } from '@phosphor-icons/react';
import { VaultHero } from './art';
import { Wordmark } from './brand';
import { ThemeSwitch } from './shell';

const POINTS = [
  { icon: <LockKey size={20} />, title: 'Only the right people', text: 'Access is granted one document at a time and checked twice: in the app and in the database.' },
  { icon: <LinkSimpleHorizontal size={20} />, title: 'Proof of every read', text: 'Every view, download and refusal is hash-chained, signed and published to a public log.' },
  { icon: <Fingerprint size={20} />, title: 'Phishing-resistant sign-in', text: 'Passkeys and authenticator codes. Administrators must use one.' },
];

/** Split screen for the sign-in steps: brand story on the left, the form on the right. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-[#0d0b24] text-white lg:flex lg:flex-col">
        <div className="absolute inset-0 bg-grid opacity-40 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
        <div className="absolute -left-32 -top-32 size-[30rem] rounded-full bg-indigo-600/30 blur-3xl" />
        <div className="absolute -bottom-40 -right-24 size-[28rem] rounded-full bg-fuchsia-600/25 blur-3xl" />
        <div className="relative flex flex-1 flex-col px-12 py-10 xl:px-16">
          <Wordmark className="text-white" />
          <div className="my-auto py-10">
            <VaultHero className="mx-auto max-h-[38vh] w-full max-w-[28.75rem] drop-shadow-2xl" />
            <h2 className="mt-6 text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">
              The wrong person can&apos;t reach it.<br />
              <span className="text-gradient">You can prove who did.</span>
            </h2>
            <ul className="mt-8 grid gap-5 xl:grid-cols-3 xl:gap-4 [@media(max-height:860px)]:hidden">
              {POINTS.map((p) => (
                <li key={p.title} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur">
                  <span className="inline-flex size-9 items-center justify-center rounded-xl bg-white/10 text-indigo-200">{p.icon}</span>
                  <p className="mt-3 text-sm font-semibold">{p.title}</p>
                  <p className="mt-1 text-xs leading-5 text-indigo-100/60">{p.text}</p>
                </li>
              ))}
            </ul>
          </div>
          <p className="flex items-center gap-2 text-xs text-indigo-100/50"><ShieldCheck size={16} />Encrypted at rest · Malware-scanned · Tamper-evident audit</p>
        </div>
      </aside>

      <main className="app-backdrop relative flex flex-col">
        <div className="flex items-center justify-between px-6 py-5 sm:px-10">
          <span className="lg:invisible"><Wordmark /></span>
          <ThemeSwitch />
        </div>
        <div className="flex flex-1 items-center justify-center px-5 pb-12 sm:px-10">
          <div className="w-full max-w-[26.25rem] animate-rise">{children}</div>
        </div>
      </main>
    </div>
  );
}
