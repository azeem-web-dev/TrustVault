import Link from 'next/link';
import type { Metadata } from 'next';
import { Archive, ArrowLeft, Clock, EnvelopeSimple, LockKey, Trash, UserMinus } from '@phosphor-icons/react/ssr';
import { LEGAL_LINK, LegalPage, LegalSection as Section } from '@/components/legal-page';

export const metadata: Metadata = {
  title: 'Delete your account and data · TrustVault',
  description: 'How to request deletion of your TrustVault account and associated data, what is removed, and how long it takes.',
};

const CONTACT = 'ridahuda03@gmail.com';

export default function DeleteAccountPage() {
  return (
    <LegalPage
      icon={<UserMinus size={26} weight="duotone" />}
      title="Delete your account and data"
      intro={<>This page explains how to have your TrustVault account and associated data deleted.</>}
      footer={(
        <>
          <Link className={LEGAL_LINK} href="/privacy"><LockKey aria-hidden size={16} weight="duotone" />Privacy Policy</Link>
          <span aria-hidden className="text-fg-subtle">·</span>
          <Link className={LEGAL_LINK} href="/login"><ArrowLeft aria-hidden size={16} weight="bold" />Back to TrustVault</Link>
        </>
      )}
    >
      <Section title="How to request deletion" index={1} icon={<EnvelopeSimple size={18} weight="duotone" />}>
        <p>
          Send an email to{' '}
          <a className={LEGAL_LINK} href={`mailto:${CONTACT}?subject=Delete%20my%20TrustVault%20account`}>{CONTACT}</a>{' '}
          from the email address on your TrustVault account, with the subject &ldquo;Delete my TrustVault account&rdquo;.
          If your account was created for you by an organisation&rsquo;s administrator, you can also ask that administrator to remove it.
          We confirm the request is from the account holder before deleting.
        </p>
      </Section>

      <Section title="What is deleted" index={2} icon={<Trash size={18} weight="duotone" />}>
        <ul className="list-disc space-y-1 pl-5">
          <li>Your account and profile (your name and email address).</li>
          <li>Your password hash, authenticator secret, passkeys and trusted devices.</li>
          <li>Your active sessions (you are signed out everywhere).</li>
          <li>Documents you own, their versions and the encrypted files, together with the grants that shared them.</li>
        </ul>
      </Section>

      <Section title="What is kept, and why" index={3} icon={<Archive size={18} weight="duotone" />}>
        <p>
          For security and to preserve the evidential value of the record, entries in the tamper-evident audit log
          (for example that an action happened, and when) are retained. This log is append-only and cannot be edited
          or selectively removed; it is used only to prove who reached a document, never for any other purpose.
          Documents that other people own and had shared with you are not deleted, because they do not belong to your account.
        </p>
      </Section>

      <Section title="How long it takes" index={4} icon={<Clock size={18} weight="duotone" />}>
        <p>Deletion is carried out within 30 days of a confirmed request, and usually much sooner.</p>
      </Section>

    </LegalPage>
  );
}
