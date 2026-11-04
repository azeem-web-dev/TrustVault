'use client';

import { useCallback, useEffect, useState } from 'react';
import { GearSix, LockKey, LockSimple, ShieldCheck, ArrowLeft, ArrowCounterClockwise, FloppyDisk } from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import { Alert, Badge, Button, Card, EmptyState, LoadError, PageTitle, SkeletonRows, Switch, ButtonLink, cx, staggerClass } from '@/components/ui';
import { api, errorText, type Role } from '@/lib/api';

const ROLES: { role: Role; label: string; text: string }[] = [
  { role: 'ADMIN', label: 'Administrators', text: 'Always required. Admins manage every account, so this cannot be turned off.' },
  { role: 'OWNER', label: 'Document owners', text: 'People who upload and share documents.' },
  { role: 'VIEWER', label: 'Viewers', text: 'Staff who only read what is shared with them.' },
  { role: 'EXTERNAL', label: 'External partners', text: 'Outside accounts with an access end date.' },
];

/**
 * Instance settings. The API enforces everything here (ADMIN always on,
 * admins only, a fresh second factor to change it, THREATS.md S21); this
 * page only shows and sends the choice.
 */
export default function SettingsPage() {
  const { user: me } = useSession();
  const toast = useToast();
  const [saved, setSaved] = useState<Role[] | null>(null);
  const [draft, setDraft] = useState<Role[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ requiredRoles: Role[] }>('/admin/settings/mfa-policy');
      setSaved(r.requiredRoles);
      setDraft(r.requiredRoles);
      setLoadError(null);
    } catch (err) {
      setLoadError(err);
    }
  }, []);
  const isAdmin = me?.role === 'ADMIN';
  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  const retry = async () => {
    setRetrying(true);
    try { await load(); } finally { setRetrying(false); }
  };

  const toggle = (role: Role) => setDraft((d) => (d.includes(role) ? d.filter((r) => r !== role) : [...d, role]));
  const changed = saved !== null && (draft.length !== saved.length || draft.some((r) => !saved.includes(r)));

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.put<{ requiredRoles: Role[] }>('/admin/settings/mfa-policy', { requiredRoles: draft });
      setSaved(r.requiredRoles);
      setDraft(r.requiredRoles);
      toast('Second-factor policy saved. It applies to everyone’s next request.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (me && !isAdmin) {
    return (
      <Shell>
        <EmptyState art={<SpotArt tone="amber" icon={<LockKey size={30} />} />} title="Administrators only" action={<ButtonLink href="/" variant="soft" icon={<ArrowLeft size={16} weight="bold" />}>Back to documents</ButtonLink>}>
          Instance settings are changed by administrators.
        </EmptyState>
      </Shell>
    );
  }

  return (
    <Shell>
      <PageTitle title="Settings" icon={<GearSix size={26} />} subtitle="Instance-wide security settings. Every change is recorded in the audit trail." />
      {error && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}
      <Card
        title="Second factor required for"
        icon={<ShieldCheck size={20} />}
        description="People in these roles must use an authenticator app, a passkey or (except administrators) codes sent by email. Anyone signed in without one is asked to set it up on their next click. Anyone who has set one up always uses it."
        padded={false}
      >
        {!saved ? (loadError ? <LoadError error={loadError} title="Couldn't load the policy" onRetry={() => void retry()} retrying={retrying} /> : <SkeletonRows rows={4} label="Loading the policy…" />) : (
          <>
            <ul className="divide-y divide-line">
              {ROLES.map(({ role, label, text }, i) => {
                const locked = role === 'ADMIN';
                const on = locked || draft.includes(role);
                return (
                  <li key={role} className={cx('flex animate-fade-in items-center gap-4 px-5 py-4', staggerClass(i))}>
                    <span className="min-w-0 flex-1">
                      <span id={`mfa-${role}`} className="flex items-center gap-2 text-sm font-semibold">{label}{locked && <Badge tone="violet" icon={<LockSimple size={12} />}>Always</Badge>}</span>
                      <span id={`mfa-${role}-desc`} className="mt-0.5 block text-xs text-fg-subtle">{text}</span>
                    </span>
                    <Switch
                      checked={on}
                      onChange={() => toggle(role)}
                      disabled={locked || busy}
                      aria-label={`Require a second factor for ${label.toLowerCase()}`}
                      aria-describedby={`mfa-${role}-desc`}
                    />
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2/50 px-5 py-4 dark:bg-white/[0.02]">
              <Button variant="ghost" icon={<ArrowCounterClockwise size={16} />} disabled={!changed || busy} onClick={() => setDraft(saved)}>Undo</Button>
              <Button variant="primary" icon={<FloppyDisk size={16} />} disabled={!changed} loading={busy} onClick={() => void save()}>Save policy</Button>
            </div>
          </>
        )}
      </Card>
    </Shell>
  );
}
