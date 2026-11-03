'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowCounterClockwise, Briefcase, CalendarBlank, Crown, Envelope, EnvelopeSimple, Eye, Fingerprint, Globe, HourglassMedium, LockKey, MagnifyingGlass,
  PaperPlaneTilt, Prohibit, ShieldCheck, Sparkle, UserPlus, UsersThree, Lock,
} from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import Link from 'next/link';
import { Alert, Avatar, Badge, Button, EmptyState, Input, Label, Modal, PageTitle, Segmented, Select, SkeletonRows, StatCard, Textarea, cx } from '@/components/ui';
import { api, errorText, type Role } from '@/lib/api';

interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: 'ACTIVE' | 'DEACTIVATED' | 'INVITED';
  accessExpiresAt: string | null;
  lockedUntil: string | null;
  createdAt: string;
  activatedAt: string | null;
  isProtected: boolean;
  totpEnabledAt: string | null;
  emailOtpEnabledAt?: string | null;
}

const ROLES: Role[] = ['ADMIN', 'OWNER', 'VIEWER', 'EXTERNAL'];
const ROLE_INFO: Record<Role, { label: string; text: string; icon: ReactNode; tone: 'violet' | 'blue' | 'green' | 'amber' }> = {
  ADMIN: { label: 'Administrator', text: 'Users, audit, alerts. Cannot open documents.', icon: <Crown size={18} />, tone: 'violet' },
  OWNER: { label: 'Document owner', text: 'Uploads documents and shares them.', icon: <Briefcase size={18} />, tone: 'blue' },
  VIEWER: { label: 'Viewer', text: 'Opens what is shared with them.', icon: <Eye size={18} />, tone: 'green' },
  EXTERNAL: { label: 'External', text: 'Read-only, until an end date.', icon: <Globe size={18} />, tone: 'amber' },
};

type Filter = 'all' | Role;

export default function AdminUsersPage() {
  const { user: me } = useSession();
  const toast = useToast();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [inviting, setInviting] = useState<string | null>(null);
  const [asking, setAsking] = useState<AdminUser | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ users: AdminUser[] }>('/admin/users');
      setUsers(r.users);
    } catch (err) {
      setError(errorText(err, 'Could not load users'));
    }
  }, []);

  useEffect(() => {
    if (me?.role === 'ADMIN') void load();
  }, [me, load]);

  async function run(action: () => Promise<unknown>, success: string) {
    setError(null);
    try {
      await action();
      toast(success);
      await load();
    } catch (err) {
      setError(errorText(err, 'Request failed'));
    }
  }

  // The admin only triggers the email; the new password is chosen by the user.
  async function sendResetLink(u: AdminUser) {
    setError(null);
    setSending(u.id);
    try {
      const r = await api.post<{ ok: boolean; sent: boolean }>(`/admin/users/${u.id}/reset-link`);
      if (r.sent) toast(`Reset link sent to ${u.email}. You never see their new password.`);
      else toast('Demo accounts never receive email', 'info');
    } catch (err) {
      setError(errorText(err, 'Request failed'));
    } finally {
      setSending(null);
    }
  }

  // Sends a fresh invitation link; the earlier one stops working.
  async function resendInvite(u: AdminUser) {
    setError(null);
    setInviting(u.id);
    try {
      const r = await api.post<{ ok: boolean; sent: boolean }>(`/admin/users/${u.id}/invite`);
      if (r.sent) toast(`Invitation sent again to ${u.email}. The earlier link no longer works.`);
      else toast('Email is turned off on this server, so no invitation was sent', 'info');
    } catch (err) {
      setError(errorText(err, 'Request failed'));
    } finally {
      setInviting(null);
    }
  }

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (users ?? []).filter((u) => (filter === 'all' || u.role === filter) && (!term || u.displayName.toLowerCase().includes(term) || u.email.toLowerCase().includes(term)));
  }, [users, q, filter]);
  const by = (r: Role) => users?.filter((u) => u.role === r).length ?? '–';

  return (
    <Shell>
      <PageTitle
        title="Users"
        icon={<UsersThree size={26} />}
        subtitle="New people are invited by email and choose their own password. Role changes, deactivation and password resets sign the user out everywhere immediately."
        actions={<Button variant="primary" icon={<UserPlus size={18} />} onClick={() => setCreating(true)}>Invite user</Button>}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {ROLES.map((r, i) => (
          <StatCard key={r} label={ROLE_INFO[r].label} value={by(r)} icon={ROLE_INFO[r].icon} tone={ROLE_INFO[r].tone} hint={ROLE_INFO[r].text} delay={i * 60} />
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input className="min-w-[220px] flex-1" icon={<MagnifyingGlass size={18} />} placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" />
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[{ id: 'all' as const, label: 'All', count: users?.length }, ...ROLES.map((r) => ({ id: r, label: ROLE_INFO[r].label.split(' ')[0]! }))]}
        />
      </div>

      {error && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}

      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-soft dark:border-white/[0.08] dark:bg-white/[0.03]">
        {!users ? <SkeletonRows rows={6} /> : shown.length === 0 ? (
          <EmptyState art={<SpotArt icon={<UsersThree size={30} />} />} title="No users match">Try another name or role.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-slate-400">
                <tr>
                  <th className="px-5 py-3">Name</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="hidden px-4 py-3 md:table-cell">Access expires</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/[0.05]">
                {shown.map((u) => {
                  const locked = u.lockedUntil && new Date(u.lockedUntil) > new Date();
                  const self = u.id === me?.id;
                  return (
                    <tr key={u.id} className={cx('transition hover:bg-slate-50/70 dark:hover:bg-white/[0.02]', u.status === 'DEACTIVATED' && 'opacity-60')}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <Avatar name={u.displayName} />
                          <div className="min-w-0">
                            <p className="truncate font-semibold">{u.displayName}{self && <span className="font-normal text-slate-500"> (you)</span>}</p>
                            <p className="truncate text-xs text-slate-500 dark:text-slate-400">{u.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Select
                          aria-label={`Role for ${u.email}`}
                          value={u.role}
                          disabled={self || u.isProtected}
                          onChange={(e) => void run(() => api.patch(`/admin/users/${u.id}`, { role: e.target.value }), `Role changed for ${u.email}. They were signed out.`)}
                          className="w-40"
                        >
                          {ROLES.map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
                        </Select>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {u.status === 'INVITED'
                            ? <span title="Has not accepted the invitation yet"><Badge tone="amber" icon={<HourglassMedium size={11} />}>Invited</Badge></span>
                            : <Badge dot tone={u.status === 'ACTIVE' ? 'green' : 'neutral'}>{u.status === 'ACTIVE' ? 'Active' : 'Deactivated'}</Badge>}
                          {locked && <Badge tone="amber" icon={<LockKey size={11} />}>Locked</Badge>}
                          {u.isProtected && <span title="Published demo account: cannot be changed"><Badge tone="violet" icon={<Sparkle size={11} />}>Demo</Badge></span>}
                          {u.totpEnabledAt && <Badge tone="blue" icon={<ShieldCheck size={11} />}>2FA</Badge>}
                          {u.emailOtpEnabledAt && <span title="Signs in with codes sent by email"><Badge tone="neutral" icon={<ShieldCheck size={11} />}>Email 2FA</Badge></span>}
                        </div>
                      </td>
                      <td className="hidden px-4 py-3 text-slate-500 md:table-cell dark:text-slate-400">
                        {u.accessExpiresAt ? <span className="inline-flex items-center gap-1.5"><CalendarBlank size={15} />{new Date(u.accessExpiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span> : '—'}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 text-right">
                        <div className="inline-flex gap-1.5">
                          {!self && !u.isProtected && (u.totpEnabledAt || u.emailOtpEnabledAt) && (
                            // An owner's or admin's second factor is cleared only with a second
                            // admin's approval (THREATS.md S19): this asks for it.
                            u.role === 'OWNER' || u.role === 'ADMIN'
                              ? <Button size="sm" variant="ghost" icon={<Fingerprint size={14} />} onClick={() => setAsking(u)}>Reset 2FA…</Button>
                              : <Button size="sm" variant="ghost" icon={<Fingerprint size={14} />} onClick={() => void run(() => api.post(`/admin/users/${u.id}/mfa/reset`), `Second factor reset for ${u.email}; they must set it up again`)}>Reset 2FA</Button>
                          )}
                          {!self && !u.isProtected && u.status === 'INVITED' && (
                            <Button size="sm" variant="ghost" icon={<PaperPlaneTilt size={14} />} loading={inviting === u.id} onClick={() => void resendInvite(u)}>Resend invite</Button>
                          )}
                          {!self && !u.isProtected && u.status === 'ACTIVE' && (
                            <Button size="sm" variant="ghost" icon={<EnvelopeSimple size={14} />} loading={sending === u.id} onClick={() => void sendResetLink(u)}>Send reset link</Button>
                          )}
                          {!self && !u.isProtected && (u.status === 'INVITED' ? (
                            <Button size="sm" variant="danger" icon={<Prohibit size={14} />} onClick={() => void run(() => api.post(`/admin/users/${u.id}/deactivate`), `Invitation for ${u.email} cancelled`)}>Cancel invite</Button>
                          ) : u.status === 'ACTIVE' ? (
                            <Button size="sm" variant="danger" icon={<Prohibit size={14} />} onClick={() => void run(() => api.post(`/admin/users/${u.id}/deactivate`), `${u.email} deactivated and signed out`)}>Deactivate</Button>
                          ) : (
                            <Button size="sm" icon={<ArrowCounterClockwise size={14} />} onClick={() => void run(() => api.post(`/admin/users/${u.id}/reactivate`), u.activatedAt ? `${u.email} reactivated` : `${u.email} is invited again. Use Resend invite to email a new link.`)}>Reactivate</Button>
                          ))}
                          {(self || u.isProtected) && <span className="inline-flex items-center gap-1 text-xs text-slate-400"><Lock size={13} />{self ? 'Your account' : 'Protected'}</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <AskMfaReset user={asking} onClose={() => setAsking(null)} onAsked={() => { setAsking(null); toast('Request sent. Another administrator must approve it on the Approvals page; then you clear the factor from there.'); }} />

      <CreateUser
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(email, invited) => {
          setCreating(false);
          if (invited) void run(async () => undefined, `Invitation sent to ${email}. They choose their own name and password.`);
          else { toast(`${email} was added, but email is turned off on this server, so no invitation was sent`, 'info'); void load(); }
        }}
      />
    </Shell>
  );
}

function CreateUser({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (email: string, invited: boolean) => void }) {
  const [form, setForm] = useState({ email: '', role: 'VIEWER' as Role, accessExpiresAt: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { setForm({ email: '', role: 'VIEWER', accessExpiresAt: '' }); setError(null); }
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ invited: boolean }>('/admin/users', {
        email: form.email,
        role: form.role,
        ...(form.accessExpiresAt ? { accessExpiresAt: new Date(form.accessExpiresAt).toISOString() } : {}),
      });
      onCreated(form.email, r.invited);
    } catch (err) {
      setError(errorText(err, 'Could not send the invitation'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      icon={<UserPlus size={22} />}
      title="Invite a user"
      description="They get an email with a link to choose their own name and password. You never see it. Administrators also set up a second factor on first sign-in."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" form="create-user" variant="primary" icon={<PaperPlaneTilt size={16} />} loading={busy}>Send invitation</Button></>}
    >
      <form id="create-user" onSubmit={submit} className="space-y-5">
        <Label label="Email"><Input icon={<Envelope size={18} />} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@company.com" /></Label>
        <div>
          <p className="mb-2 text-[13px] font-medium text-slate-700 dark:text-slate-300">Role</p>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Role">
            {ROLES.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={form.role === r}
                onClick={() => setForm({ ...form, role: r })}
                className={cx('flex items-start gap-3 rounded-xl border p-3 text-left transition', form.role === r ? 'border-brand-400 bg-brand-50 ring-4 ring-brand-500/10 dark:border-brand-400/60 dark:bg-brand-500/10' : 'border-slate-200 hover:border-slate-300 dark:border-white/10 dark:hover:border-white/20')}
              >
                <span className={cx('mt-0.5', form.role === r ? 'text-brand-600 dark:text-brand-300' : 'text-slate-400')}>{ROLE_INFO[r].icon}</span>
                <span><span className="block text-sm font-semibold">{ROLE_INFO[r].label}</span><span className="block text-xs text-slate-500 dark:text-slate-400">{ROLE_INFO[r].text}</span></span>
              </button>
            ))}
          </div>
        </div>
        <Label
          label={form.role === 'EXTERNAL' ? 'Access ends on (required)' : 'Access ends on (optional)'}
          hint={form.role === 'EXTERNAL' ? 'External accounts always have an end date.' : 'Leave empty for no end date.'}
        >
          <Input icon={<CalendarBlank size={18} />} type="date" required={form.role === 'EXTERNAL'} min={new Date().toISOString().slice(0, 10)} value={form.accessExpiresAt} onChange={(e) => setForm({ ...form, accessExpiresAt: e.target.value })} />
        </Label>
        {error && <Alert>{error}</Alert>}
      </form>
    </Modal>
  );
}

/** Asks a second administrator to approve clearing an owner's or admin's second factor. */
function AskMfaReset({ user, onClose, onAsked }: { user: AdminUser | null; onClose: () => void; onAsked: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setReason(''); setError(null); }, [user]);
  if (!user) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/admin/approvals', { action: 'MFA_RESET', targetUserId: user.id, reason });
      onAsked();
    } catch (err) {
      setError(errorText(err, 'Request failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Reset the second factor of ${user.displayName}`}
      description="Clearing an owner's or administrator's second factor needs a second administrator. Say why; another admin approves on the Approvals page, then you carry it out once, within 24 hours. The person is emailed when it happens."
      icon={<Fingerprint size={20} />}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="ask-mfa" loading={busy}>Ask for approval</Button></>}
    >
      <form id="ask-mfa" onSubmit={submit} className="space-y-4">
        <Label label="Reason (at least 20 characters)" hint={`${reason.length}/500`}>
          <Textarea rows={3} required minLength={20} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Lost phone, confirmed by video call, ticket IT-311" />
        </Label>
        {error && <Alert>{error}</Alert>}
        <p className="text-xs text-slate-500 dark:text-slate-400">See <Link className="font-semibold underline" href="/admin/approvals">Approvals</Link> for the request.</p>
      </form>
    </Modal>
  );
}
