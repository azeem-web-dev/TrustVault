'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowCounterClockwise, Briefcase, CalendarBlank, Crown, DotsThreeVertical, Envelope, EnvelopeSimple, Eye, Fingerprint, Globe, HourglassMedium, Key, LockKey, MagnifyingGlass,
  PaperPlaneTilt, PencilSimple, Prohibit, ShieldCheck, Sparkle, UserPlus, UsersThree, Lock, Warning, ArrowLeft,
} from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import Link from 'next/link';
import {
  Alert, Avatar, Badge, Button, EmptyState, Input, Label, LoadError, Menu, MenuItem, MenuSeparator, Modal, PageTitle, Segmented, Select, SkeletonRows, StatCard, Textarea, cx,
  staggerClass, useConfirm, ButtonLink,
} from '@/components/ui';
import { api, errorText, type Role } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { localDayEndISO, localTodayISO, toLocalDateInput } from '@/lib/dates';

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
  // TODO(api): GET /admin/users does not return this yet. Once it returns a
  // passkey count, Reset 2FA also shows for passkey-only users (G3).
  passkeys?: number;
}

const ROLES: Role[] = ['ADMIN', 'OWNER', 'VIEWER', 'EXTERNAL'];
const ROLE_INFO: Record<Role, { label: string; short: string; text: string; icon: ReactNode; tone: 'violet' | 'blue' | 'green' | 'amber' }> = {
  ADMIN: { label: 'Administrator', short: 'Admins', text: 'Users, audit, alerts. Cannot open documents.', icon: <Crown size={18} />, tone: 'violet' },
  OWNER: { label: 'Document owner', short: 'Owners', text: 'Uploads documents and shares them.', icon: <Briefcase size={18} />, tone: 'blue' },
  VIEWER: { label: 'Viewer', short: 'Viewers', text: 'Opens what is shared with them.', icon: <Eye size={18} />, tone: 'green' },
  EXTERNAL: { label: 'External', short: 'External', text: 'Read-only, until an end date.', icon: <Globe size={18} />, tone: 'amber' },
};

type Filter = 'all' | Role;
/** A pending change to someone's role or access end date, confirmed in a dialog first. */
type Change = { user: AdminUser; role: Role; mode: 'role' | 'expiry' };

const hasSecondFactor = (u: AdminUser) => !!(u.totpEnabledAt || u.emailOtpEnabledAt || (u.passkeys ?? 0) > 0);

export default function AdminUsersPage() {
  const { user: me } = useSession();
  const toast = useToast();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [creating, setCreating] = useState(false);
  const [asking, setAsking] = useState<AdminUser | null>(null);
  const [change, setChange] = useState<Change | null>(null);
  const [changeOpen, setChangeOpen] = useState(false);
  const { busy, run: runAction } = useAction();
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ users: AdminUser[] }>('/admin/users');
      setUsers(r.users);
      setLoadError(null);
    } catch (err) {
      setLoadError(err);
      setError(errorText(err, 'Could not load users'));
    }
  }, []);

  const isAdmin = me?.role === 'ADMIN';
  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  const retry = async () => {
    setRetrying(true);
    setError(null);
    try { await load(); } finally { setRetrying(false); }
  };

  /** One action per click: a second click (or another row's button) waits until this one ends. */
  async function run(key: string, action: () => Promise<unknown>, success: string) {
    setError(null);
    await runAction(key, async () => {
      try {
        await action();
        toast(success);
        await load();
      } catch (err) {
        setError(errorText(err, 'Request failed'));
      }
    });
  }

  // The admin only triggers the email; the new password is chosen by the user.
  const sendResetLink = (u: AdminUser) => runAction(`reset-link:${u.id}`, async () => {
    setError(null);
    try {
      const r = await api.post<{ ok: boolean; sent: boolean }>(`/admin/users/${u.id}/reset-link`);
      if (r.sent) toast(`Reset link sent to ${u.email}. You never see their new password.`);
      else toast('Demo accounts never receive email', 'info');
    } catch (err) {
      setError(errorText(err, 'Request failed'));
    }
  });

  // Sends a fresh invitation link; the earlier one stops working.
  const resendInvite = (u: AdminUser) => runAction(`invite:${u.id}`, async () => {
    setError(null);
    try {
      const r = await api.post<{ ok: boolean; sent: boolean }>(`/admin/users/${u.id}/invite`);
      if (r.sent) toast(`Invitation sent again to ${u.email}. The earlier link no longer works.`);
      else toast('Email is turned off on this server, so no invitation was sent', 'info');
    } catch (err) {
      setError(errorText(err, 'Request failed'));
    }
  });

  const resetMfa = async (u: AdminUser) => {
    // An owner's or admin's second factor is cleared only with a second
    // admin's approval (THREATS.md S19): this asks for it.
    if (u.role === 'OWNER' || u.role === 'ADMIN') { setAsking(u); return; }
    const ok = await confirm({
      title: `Reset the second factor of ${u.displayName}?`,
      body: <>This removes their authenticator app, emailed codes and passkeys, and signs them out everywhere. They must set a second factor up again on their next sign-in.</>,
      confirmLabel: 'Reset 2FA',
      danger: true,
      icon: <Fingerprint size={20} />,
    });
    if (ok) await run(`mfa:${u.id}`, () => api.post(`/admin/users/${u.id}/mfa/reset`), `Second factor reset for ${u.email}; they must set it up again`);
  };

  const deactivate = async (u: AdminUser) => {
    const invite = u.status === 'INVITED';
    const ok = await confirm({
      title: invite ? `Cancel the invitation for ${u.email}?` : `Deactivate ${u.displayName}?`,
      body: invite
        ? 'Their invitation link stops working. You can invite them again later with Reactivate.'
        : 'They are signed out everywhere at once and cannot sign in until an administrator reactivates them.',
      confirmLabel: invite ? 'Cancel invitation' : 'Deactivate',
      cancelLabel: invite ? 'Keep invitation' : 'Cancel',
      danger: true,
      icon: <Prohibit size={20} />,
    });
    if (ok) await run(`deactivate:${u.id}`, () => api.post(`/admin/users/${u.id}/deactivate`), invite ? `Invitation for ${u.email} cancelled` : `${u.email} deactivated and signed out`);
  };

  const reactivate = (u: AdminUser) =>
    run(`reactivate:${u.id}`, () => api.post(`/admin/users/${u.id}/reactivate`), u.activatedAt ? `${u.email} reactivated` : `${u.email} is invited again. Use Resend invite to email a new link.`);

  const openChange = (c: Change) => { setChange(c); setChangeOpen(true); };

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (users ?? []).filter((u) => (filter === 'all' || u.role === filter) && (!term || u.displayName.toLowerCase().includes(term) || u.email.toLowerCase().includes(term)));
  }, [users, q, filter]);
  const by = (r: Role) => users?.filter((u) => u.role === r).length;

  if (me && !isAdmin) return <AdminOnly />;

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
          <StatCard key={r} label={ROLE_INFO[r].label} value={by(r) ?? '–'} icon={ROLE_INFO[r].icon} tone={ROLE_INFO[r].tone} hint={ROLE_INFO[r].text} delay={i * 40} />
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input className="min-w-[13.75rem] flex-1" icon={<MagnifyingGlass size={18} />} placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" type="search" />
        <Segmented
          mode="filter"
          label="Filter by role"
          value={filter}
          onChange={setFilter}
          options={[{ id: 'all' as const, label: 'All', count: users?.length }, ...ROLES.map((r) => ({ id: r, label: ROLE_INFO[r].short, count: by(r) }))]}
        />
      </div>

      {error && users && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}

      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
        {!users ? (loadError ? <LoadError error={loadError} title="Couldn't load users" onRetry={() => void retry()} retrying={retrying} /> : <SkeletonRows rows={6} label="Loading users…" />) : shown.length === 0 ? (
          <EmptyState art={<SpotArt icon={<UsersThree size={30} />} />} title="No users match">Try another name or role.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line bg-surface-2/70 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle dark:bg-white/[0.02]">
                <tr>
                  <th className="px-5 py-3">Name</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="hidden px-4 py-3 md:table-cell">Access expires</th>
                  <th className="px-5 py-3 text-right"><span className="max-md:sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.map((u, i) => {
                  const locked = u.lockedUntil && new Date(u.lockedUntil) > new Date();
                  const self = u.id === me?.id;
                  const editable = !self && !u.isProtected;
                  const rowBusy = !!busy && busy.endsWith(`:${u.id}`);
                  const canReset = editable && hasSecondFactor(u);
                  const twoAdmins = u.role === 'OWNER' || u.role === 'ADMIN';
                  return (
                    <tr key={u.id} className={cx('animate-fade-in transition-[opacity,background-color] duration-200 hover:bg-fg/[0.03]', staggerClass(i), u.status === 'DEACTIVATED' && 'opacity-60')}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <Avatar name={u.displayName} />
                          <div className="min-w-0">
                            <p className="truncate font-semibold">{u.displayName}{self && <span className="font-normal text-fg-subtle"> (you)</span>}</p>
                            <p className="truncate text-xs text-fg-subtle">{u.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Select
                          aria-label={`Role for ${u.email}`}
                          value={u.role}
                          disabled={!editable || !!busy}
                          onChange={(e) => {
                            const role = e.target.value as Role;
                            if (role !== u.role) openChange({ user: u, role, mode: 'role' });
                          }}
                          className="w-full min-w-[8.5rem] sm:w-40"
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
                          {(u.passkeys ?? 0) > 0 && <span title={`${u.passkeys} passkey${u.passkeys === 1 ? '' : 's'}`}><Badge tone="blue" icon={<Key size={11} />}>Passkey</Badge></span>}
                          {u.emailOtpEnabledAt && <span title="Signs in with codes sent by email"><Badge tone="neutral" icon={<ShieldCheck size={11} />}>Email 2FA</Badge></span>}
                          {u.accessExpiresAt && <span className="md:hidden"><Badge tone="amber" icon={<CalendarBlank size={11} />}>Until {formatDay(u.accessExpiresAt)}</Badge></span>}
                        </div>
                      </td>
                      <td className="hidden px-4 py-3 text-fg-subtle md:table-cell">
                        {u.accessExpiresAt ? <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><CalendarBlank size={15} />{formatDay(u.accessExpiresAt)}</span> : '—'}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 text-right">
                        {editable ? (
                          <>
                            {/* md and up: the actions inline. */}
                            <div className="hidden gap-1.5 md:inline-flex">
                              {canReset && (
                                <Button size="sm" variant="ghost" icon={<Fingerprint size={14} />} loading={busy === `mfa:${u.id}`} disabled={!!busy} onClick={() => void resetMfa(u)}>{twoAdmins ? 'Reset 2FA…' : 'Reset 2FA'}</Button>
                              )}
                              {u.status === 'INVITED' && (
                                <Button size="sm" variant="ghost" icon={<PaperPlaneTilt size={14} />} loading={busy === `invite:${u.id}`} disabled={!!busy} onClick={() => void resendInvite(u)}>Resend invite</Button>
                              )}
                              {u.status === 'ACTIVE' && (
                                <Button size="sm" variant="ghost" icon={<EnvelopeSimple size={14} />} loading={busy === `reset-link:${u.id}`} disabled={!!busy} onClick={() => void sendResetLink(u)}>Send reset link</Button>
                              )}
                              {u.status === 'DEACTIVATED' ? (
                                <Button size="sm" icon={<ArrowCounterClockwise size={14} />} loading={busy === `reactivate:${u.id}`} disabled={!!busy} onClick={() => void reactivate(u)}>Reactivate</Button>
                              ) : (
                                <Button size="sm" variant="danger" icon={<Prohibit size={14} />} loading={busy === `deactivate:${u.id}`} disabled={!!busy} onClick={() => void deactivate(u)}>{u.status === 'INVITED' ? 'Cancel invite' : 'Deactivate'}</Button>
                              )}
                              <Menu
                                label={`More actions for ${u.email}`}
                                buttonClassName="relative inline-flex size-8 items-center justify-center rounded-lg text-fg-subtle transition hover:bg-fg/5 hover:text-fg active:bg-fg/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 pointer-coarse:before:absolute pointer-coarse:before:-inset-1.5"
                                button={<DotsThreeVertical size={18} weight="bold" />}
                              >
                                <MenuItem icon={<CalendarBlank size={16} />} disabled={!!busy} onSelect={() => openChange({ user: u, role: u.role, mode: 'expiry' })}>Edit access end date…</MenuItem>
                              </Menu>
                            </div>
                            {/* Below md: one menu, with 44px items. */}
                            <div className="inline-flex md:hidden">
                              <Menu
                                label={`Actions for ${u.email}`}
                                buttonClassName="relative inline-flex size-11 items-center justify-center rounded-lg text-fg-subtle transition hover:bg-fg/5 hover:text-fg active:bg-fg/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
                                button={rowBusy ? <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent" /> : <DotsThreeVertical size={20} weight="bold" />}
                              >
                                {canReset && <MenuItem icon={<Fingerprint size={16} />} disabled={!!busy} onSelect={() => void resetMfa(u)}>{twoAdmins ? 'Reset 2FA…' : 'Reset 2FA'}</MenuItem>}
                                {u.status === 'INVITED' && <MenuItem icon={<PaperPlaneTilt size={16} />} disabled={!!busy} onSelect={() => void resendInvite(u)}>Resend invite</MenuItem>}
                                {u.status === 'ACTIVE' && <MenuItem icon={<EnvelopeSimple size={16} />} disabled={!!busy} onSelect={() => void sendResetLink(u)}>Send reset link</MenuItem>}
                                <MenuItem icon={<CalendarBlank size={16} />} disabled={!!busy} onSelect={() => openChange({ user: u, role: u.role, mode: 'expiry' })}>Edit access end date…</MenuItem>
                                <MenuSeparator />
                                {u.status === 'DEACTIVATED'
                                  ? <MenuItem icon={<ArrowCounterClockwise size={16} />} disabled={!!busy} onSelect={() => void reactivate(u)}>Reactivate</MenuItem>
                                  : <MenuItem danger icon={<Prohibit size={16} />} disabled={!!busy} onSelect={() => void deactivate(u)}>{u.status === 'INVITED' ? 'Cancel invite' : 'Deactivate'}</MenuItem>}
                              </Menu>
                            </div>
                          </>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-fg-subtle"><Lock size={13} />{self ? 'Your account' : 'Protected'}</span>
                        )}
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

      <ChangeAccess
        open={changeOpen}
        change={change}
        onClose={() => setChangeOpen(false)}
        onDone={(msg) => { setChangeOpen(false); toast(msg); void load(); }}
      />

      <CreateUser
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(email, invited) => {
          setCreating(false);
          if (invited) toast(`Invitation sent to ${email}. They choose their own name and password.`);
          else toast(`${email} was added, but email is turned off on this server, so no invitation was sent`, 'info');
          void load();
        }}
      />
      {confirmDialog}
    </Shell>
  );
}

/** The date an access window ends, in the viewer's time zone. */
function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function AdminOnly() {
  return (
    <Shell>
      <EmptyState art={<SpotArt tone="amber" icon={<LockKey size={30} />} />} title="Administrators only" action={<ButtonLink href="/" variant="soft" icon={<ArrowLeft size={16} weight="bold" />}>Back to documents</ButtonLink>}>
        This page is for administrators. Ask one if you need an account changed.
      </EmptyState>
    </Shell>
  );
}

/**
 * Confirms a role change (which signs the person out and may drop their
 * grants) or edits the access end date. Becoming External needs an end date,
 * sent together with the role (G2).
 */
function ChangeAccess({ open, change, onClose, onDone }: { open: boolean; change: Change | null; onClose: () => void; onDone: (message: string) => void }) {
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && change) { setDate(toLocalDateInput(change.user.accessExpiresAt)); setError(null); }
  }, [open, change]);

  if (!change) return null;
  const { user: u, role, mode } = change;
  const external = role === 'EXTERNAL';
  const roleChange = mode === 'role' && role !== u.role;
  const showDate = mode === 'expiry' || external;
  const dropsGrants = roleChange && (role === 'ADMIN' || role === 'EXTERNAL');
  const leavesAdmin = roleChange && u.role === 'ADMIN';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const expires = date ? localDayEndISO(date) : null;
    if (external && !expires) { setError('External accounts need an access end date.'); return; }
    setBusy(true);
    setError(null);
    try {
      const body: { role?: Role; accessExpiresAt?: string | null } = {};
      if (roleChange) body.role = role;
      if (showDate) body.accessExpiresAt = expires ?? null;
      await api.patch(`/admin/users/${u.id}`, body);
      onDone(roleChange
        ? `${u.email} is now ${ROLE_INFO[role].label.toLowerCase()}. They were signed out.`
        : expires ? `Access for ${u.email} now ends after ${formatDay(expires)}. They were signed out.` : `Access for ${u.email} no longer ends on a date`);
    } catch (err) {
      setError(errorText(err, 'Could not save the change'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      dismissible={!busy}
      icon={mode === 'expiry' ? <CalendarBlank size={20} /> : ROLE_INFO[role].icon}
      title={mode === 'expiry' ? `Access end date for ${u.displayName}` : `Make ${u.displayName} ${ROLE_INFO[role].label.toLowerCase()}?`}
      description={mode === 'expiry' ? u.email : `${ROLE_INFO[u.role].label} → ${ROLE_INFO[role].label}`}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button type="submit" form="change-access" variant={dropsGrants || leavesAdmin ? 'danger' : 'primary'} icon={mode === 'expiry' ? <PencilSimple size={16} /> : undefined} loading={busy} data-autofocus={!showDate || undefined}>
          {mode === 'expiry' ? 'Save end date' : 'Change role'}
        </Button>
      </>}
    >
      <form id="change-access" onSubmit={submit} className="space-y-4">
        {roleChange && (
          <ul className="space-y-2 text-sm leading-6 text-fg-muted">
            <li className="flex gap-2"><LockKey size={16} className="mt-1 shrink-0 text-fg-subtle" />They are signed out everywhere at once and sign in again with the new role.</li>
            {dropsGrants && <li className="flex gap-2"><Warning size={16} weight="fill" className="mt-1 shrink-0 text-warning-500" />Every document share and group they hold is removed. This cannot be undone by changing the role back.</li>}
            {leavesAdmin && <li className="flex gap-2"><Warning size={16} weight="fill" className="mt-1 shrink-0 text-warning-500" />They lose access to users, audit and alerts, and any break-glass access they hold ends.</li>}
            {u.role === 'OWNER' && <li className="flex gap-2"><Briefcase size={16} className="mt-1 shrink-0 text-fg-subtle" />If they own documents, transfer or delete them first: the change is refused otherwise.</li>}
          </ul>
        )}
        {showDate && (
          <Label
            label={external ? 'Access ends after (required)' : 'Access ends after (optional)'}
            hint={external ? 'External accounts always have an end date. Access stops at the end of this day, your time. Changing it signs them out.' : 'Leave empty for no end date. Access stops at the end of this day, your time. Changing it signs them out.'}
          >
            <Input icon={<CalendarBlank size={18} />} type="date" data-autofocus required={external} min={localTodayISO()} value={date} onChange={(e) => setDate(e.target.value)} />
          </Label>
        )}
        {error && <Alert>{error}</Alert>}
      </form>
    </Modal>
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
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // The end of the chosen day in the admin's time zone, not UTC midnight (X6).
      const expires = localDayEndISO(form.accessExpiresAt);
      const r = await api.post<{ invited: boolean }>('/admin/users', {
        email: form.email,
        role: form.role,
        ...(expires ? { accessExpiresAt: expires } : {}),
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
          <p id="create-user-role" className="mb-2 text-[0.8125rem] font-medium text-fg-muted">Role</p>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-labelledby="create-user-role">
            {ROLES.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={form.role === r}
                onClick={() => setForm({ ...form, role: r })}
                className={cx(
                  'flex items-start gap-3 rounded-xl border p-3 text-left transition duration-150 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50',
                  form.role === r ? 'border-brand-400 bg-brand-50 ring-4 ring-brand-500/10 dark:border-brand-400/60 dark:bg-brand-500/10' : 'border-line hover:border-line-strong hover:bg-fg/[0.02]',
                )}
              >
                <span className={cx('mt-0.5', form.role === r ? 'text-brand-600 dark:text-brand-300' : 'text-fg-subtle')}>{ROLE_INFO[r].icon}</span>
                <span><span className="block text-sm font-semibold">{ROLE_INFO[r].label}</span><span className="block text-xs text-fg-subtle">{ROLE_INFO[r].text}</span></span>
              </button>
            ))}
          </div>
        </div>
        <Label
          label={form.role === 'EXTERNAL' ? 'Access ends after (required)' : 'Access ends after (optional)'}
          hint={form.role === 'EXTERNAL' ? 'External accounts always have an end date. Access stops at the end of this day, your time.' : 'Leave empty for no end date.'}
        >
          <Input icon={<CalendarBlank size={18} />} type="date" required={form.role === 'EXTERNAL'} min={localTodayISO()} value={form.accessExpiresAt} onChange={(e) => setForm({ ...form, accessExpiresAt: e.target.value })} />
        </Label>
        {error && <Alert>{error}</Alert>}
      </form>
    </Modal>
  );
}

/** Asks a second administrator to approve clearing an owner's or admin's second factor. */
function AskMfaReset({ user: target, onClose, onAsked }: { user: AdminUser | null; onClose: () => void; onAsked: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The last person asked about stays rendered while the dialog animates out.
  const [user, setUser] = useState(target);
  useEffect(() => {
    if (!target) return;
    setUser(target);
    setReason('');
    setError(null);
  }, [target]);
  if (!user) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
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
      open={!!target}
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
        <p className="text-xs text-fg-subtle">See <Link className="font-semibold underline" href="/admin/approvals">Approvals</Link> for the request.</p>
      </form>
    </Modal>
  );
}
