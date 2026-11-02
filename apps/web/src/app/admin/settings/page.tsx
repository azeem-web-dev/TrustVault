'use client';

import { useCallback, useEffect, useState } from 'react';
import { GearSix, LockSimple, ShieldCheck } from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, PageTitle, SkeletonRows, cx } from '@/components/ui';
import { api, errorText, type Role } from '@/lib/api';

const ROLES: { role: Role; label: string; text: string }[] = [
  { role: 'ADMIN', label: 'Administrators', text: 'Always required. Admins manage every account, so this cannot be turned off.' },
  { role: 'OWNER', label: 'Document owners', text: 'People who upload and share documents.' },
  { role: 'VIEWER', label: 'Viewers', text: 'Staff who only read what is shared with them.' },
  { role: 'EXTERNAL', label: 'External partners', text: 'Outside accounts with an access end date.' },
];

/**
 * Instance settings. The API enforces everything here (ADMIN always on,
 * admins only, a fresh second factor to change it, THREATS.md S20); this
 * page only shows and sends the choice.
 */
export default function SettingsPage() {
  const toast = useToast();
  const [saved, setSaved] = useState<Role[] | null>(null);
  const [draft, setDraft] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ requiredRoles: Role[] }>('/admin/settings/mfa-policy');
      setSaved(r.requiredRoles);
      setDraft(r.requiredRoles);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (role: Role) => setDraft((d) => (d.includes(role) ? d.filter((r) => r !== role) : [...d, role]));
  const changed = saved !== null && (draft.length !== saved.length || draft.some((r) => !saved.includes(r)));

  const save = async () => {
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

  return (
    <Shell>
      <PageTitle title="Settings" icon={<GearSix size={26} />} subtitle="Instance-wide security settings. Every change is recorded in the audit trail." />
      {error && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}
      <Card
        title="Second factor required for"
        icon={<ShieldCheck size={20} />}
        description="People in these roles must use an authenticator app or a passkey. Anyone signed in without one is asked to set it up on their next click. Anyone who has set one up always uses it."
        padded={false}
      >
        {!saved ? <SkeletonRows rows={4} /> : (
          <>
            <ul className="divide-y divide-slate-100 dark:divide-white/[0.05]">
              {ROLES.map(({ role, label, text }) => {
                const locked = role === 'ADMIN';
                const on = locked || draft.includes(role);
                return (
                  <li key={role} className="flex items-center gap-4 px-5 py-4">
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-semibold">{label}{locked && <Badge tone="violet" icon={<LockSimple size={12} />}>Always</Badge>}</span>
                      <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{text}</span>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={`Require a second factor for ${label.toLowerCase()}`}
                      disabled={locked || busy}
                      onClick={() => toggle(role)}
                      className={cx('relative h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed', on ? 'bg-brand-gradient' : 'bg-slate-200 dark:bg-white/15', locked && 'opacity-70')}
                    >
                      <span className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-all', on ? 'left-[22px]' : 'left-0.5')} />
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/50 px-5 py-4 dark:border-white/[0.05] dark:bg-white/[0.02]">
              <Button variant="ghost" disabled={!changed || busy} onClick={() => setDraft(saved)}>Undo</Button>
              <Button variant="primary" disabled={!changed} loading={busy} onClick={() => void save()}>Save policy</Button>
            </div>
          </>
        )}
      </Card>
    </Shell>
  );
}
