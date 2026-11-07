import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, Baby, Clock, ClockCounterClockwise, Database, IdentificationBadge, LockKey, ShareNetwork, ShieldCheckered, Target, Trash } from '@phosphor-icons/react/ssr';
import { LEGAL_LINK, LegalPage, LegalSection as Section } from '@/components/legal-page';

export const metadata: Metadata = {
  title: 'Privacy Policy · TrustVault',
  description: 'How TrustVault collects, uses, protects and deletes your data.',
};

const UPDATED = '4 November 2026';
const CONTACT = 'ridahuda03@gmail.com';

export default function PrivacyPolicyPage() {
  return (
    <LegalPage
      icon={<LockKey size={26} weight="duotone" />}
      title="Privacy Policy"
      intro={<>Last updated {UPDATED}</>}
      footer={(
        <>
          <Link className={LEGAL_LINK} href="/login"><ArrowLeft aria-hidden size={16} weight="bold" />Back to TrustVault</Link>
        </>
      )}
    >
      <div className="mt-6 space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          TrustVault is a platform for sharing confidential documents with a tamper-evident record of who
          reached them. This policy explains what personal data TrustVault handles, why, how it is protected,
          and how you can have it deleted. It applies to the TrustVault website and Android app, which both use
          the same service at <span className="font-medium text-fg">vault.rayyanazeem.cloud</span>.
        </p>
      </div>

      <Section title="Who is responsible" index={1} icon={<IdentificationBadge size={18} weight="duotone" />}>
        <p>
          TrustVault is operated by the TrustVault team. For any privacy question or request, contact{' '}
          <a className={LEGAL_LINK} href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>
      </Section>

      <Section title="What we collect" index={2} icon={<Database size={18} weight="duotone" />}>
        <ul className="list-disc space-y-1 pl-5">
          <li><span className="font-medium">Account information</span> — your name and email address.</li>
          <li><span className="font-medium">Authentication data</span> — your password (stored only as a salted Argon2 hash, never in readable form) and, if you set them up, your second factor (an authenticator secret, a passkey, or email codes).</li>
          <li><span className="font-medium">Documents</span> — the files you upload, their versions and metadata (name, category, folder).</li>
          <li><span className="font-medium">Activity records</span> — a security audit log of actions such as sign-ins, uploads, views, downloads, shares and permission changes, with the time and the network address of the request.</li>
          <li><span className="font-medium">A device trust token</span> — a random value stored on your device so a known device can be recognised at sign-in. It is not an advertising or hardware identifier.</li>
        </ul>
        <p>TrustVault does not collect your location, contacts, or advertising identifiers, and contains no ads or third-party analytics or advertising SDKs.</p>
        <p>If you ask for the Android beta steps, we store your email address, when we emailed you and how many times, only to send you those instructions (one email per day at most). We keep no IP address or other detail with it. To have it removed, email <a className={LEGAL_LINK} href={`mailto:${CONTACT}`}>{CONTACT}</a> from that address.</p>
      </Section>

      <Section title="Why we use it" index={3} icon={<Target size={18} weight="duotone" />}>
        <p>Your data is used only to provide the service: to store and share your documents, to decide who may reach each document, to keep the security audit trail, to manage your account, and to send you service emails (such as sign-in notices, share notices and password resets). We do not use your data for advertising or profiling.</p>
      </Section>

      <Section title="Who we share it with" index={4} icon={<ShareNetwork size={18} weight="duotone" />}>
        <p><span className="font-medium">We do not sell your data and do not share it with third parties for their own use.</span> Your documents are visible only to the people you grant access to, and to an administrator only through an audited, time-limited emergency access that needs a second administrator&rsquo;s approval. We use an email provider to deliver the service emails above; that provider processes only the message needed to send them.</p>
      </Section>

      <Section title="How we protect it" index={5} icon={<ShieldCheckered size={18} weight="duotone" />}>
        <p>All data is encrypted in transit (HTTPS/TLS). Documents are encrypted at rest with a unique AES-256-GCM key per file, wrapped by a separate key service. Access is checked on every request by the application and, independently, by the database. The audit log is hash-chained and append-only, and signed checkpoints are published to a public transparency log, so the record of who reached a document cannot be quietly altered. Accounts can require a second factor.</p>
      </Section>

      <Section title="How long we keep it" index={6} icon={<Clock size={18} weight="duotone" />}>
        <p>Documents are kept until you or your document owner delete them. Account information is kept while your account is active. Audit-log entries are kept to preserve the integrity and evidential value of the record; because the log is append-only and tamper-evident, individual entries are not edited or removed, but they are tied to the action, not used for any other purpose.</p>
      </Section>

      <Section title="Deleting your data" index={7} icon={<Trash size={18} weight="duotone" />}>
        <p>
          You can ask for your account and associated personal data to be deleted at any time. See{' '}
          <Link className={LEGAL_LINK} href="/delete-account">Delete your account and data</Link>{' '}
          for the steps, or email{' '}
          <a className={LEGAL_LINK} href={`mailto:${CONTACT}`}>{CONTACT}</a>{' '}
          from your account address.
        </p>
      </Section>

      <Section title="Children" index={8} icon={<Baby size={18} weight="duotone" />}>
        <p>TrustVault is intended for people aged 18 and over and is not directed to children.</p>
      </Section>

      <Section title="Changes" index={9} icon={<ClockCounterClockwise size={18} weight="duotone" />}>
        <p>If this policy changes, the date above will be updated and, for significant changes, we will let signed-in users know.</p>
      </Section>

    </LegalPage>
  );
}
