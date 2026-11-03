import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Delete your account and data · TrustVault',
  description: 'How to request deletion of your TrustVault account and associated data, what is removed, and how long it takes.',
};

const CONTACT = 'ridahuda03@gmail.com';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-white">{title}</h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{children}</div>
    </section>
  );
}

export default function DeleteAccountPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 sm:py-16">
      <p className="text-sm font-medium text-brand-600 dark:text-brand-400">TrustVault</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900 dark:text-white">Delete your account and data</h1>
      <p className="mt-2 text-sm text-slate-500">This page explains how to have your TrustVault account and associated data deleted.</p>

      <Section title="How to request deletion">
        <p>
          Send an email to{' '}
          <a className="font-medium text-brand-600 hover:underline dark:text-brand-400" href={`mailto:${CONTACT}?subject=Delete%20my%20TrustVault%20account`}>{CONTACT}</a>{' '}
          from the email address on your TrustVault account, with the subject &ldquo;Delete my TrustVault account&rdquo;.
          If your account was created for you by an organisation&rsquo;s administrator, you can also ask that administrator to remove it.
          We confirm the request is from the account holder before deleting.
        </p>
      </Section>

      <Section title="What is deleted">
        <ul className="list-disc space-y-1 pl-5">
          <li>Your account and profile (your name and email address).</li>
          <li>Your password hash, authenticator secret, passkeys and trusted devices.</li>
          <li>Your active sessions (you are signed out everywhere).</li>
          <li>Documents you own, their versions and the encrypted files, together with the grants that shared them.</li>
        </ul>
      </Section>

      <Section title="What is kept, and why">
        <p>
          For security and to preserve the evidential value of the record, entries in the tamper-evident audit log
          (for example that an action happened, and when) are retained. This log is append-only and cannot be edited
          or selectively removed; it is used only to prove who reached a document, never for any other purpose.
          Documents that other people own and had shared with you are not deleted, because they do not belong to your account.
        </p>
      </Section>

      <Section title="How long it takes">
        <p>Deletion is carried out within 30 days of a confirmed request, and usually much sooner.</p>
      </Section>

      <footer className="mt-12 border-t border-slate-200 pt-6 text-sm dark:border-white/10">
        <Link className="font-medium text-brand-600 hover:underline dark:text-brand-400" href="/privacy">Privacy Policy</Link>
        <span className="px-2 text-slate-300">·</span>
        <Link className="font-medium text-brand-600 hover:underline dark:text-brand-400" href="/login">Back to TrustVault</Link>
      </footer>
    </main>
  );
}
