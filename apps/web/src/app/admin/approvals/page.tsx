'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowClockwise, Check, Fingerprint, HandPalm, LockKey, Siren, UserCheck, X, ArrowRight, ArrowSquareOut, ListChecks } from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import { Alert, Badge, Button, Card, EmptyState, IconButton, LoadError, PageTitle, SkeletonRows, Spinner, cx, relativeTime, staggerClass, useConfirm, ButtonLink, IconTile } from '@/components/ui';
import { api, errorText, formatDate } from '@/lib/api';
import { useLatest } from '@/lib/hooks';

interface Person { id: string; email: string; displayName: string }
export interface Approval {
  id: string;
  action: 'MFA_RESET' | 'BREAK_GLASS';
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'USED' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  consumedAt: string | null;
  requestedBy: Person;
  approvedBy: Person | null;
  rejectedBy: Person | null;
  targetUser: (Person & { role: string }) | null;
  targetDocumentId: string | null;
  documentTitle?: string | null;
}

const STATUS_TONE = { PENDING: 'amber', APPROVED: 'green', REJECTED: 'red', USED: 'neutral', EXPIRED: 'neutral' } as const;
const STATUS_LABEL = { PENDING: 'Waiting', APPROVED: 'Approved', REJECTED: 'Rejected', USED: 'Used', EXPIRED: 'Expired' } as const;

/**
 * Requests that need a second administrator (THREATS.md S19): clearing an
 * owner's or admin's second factor, and break-glass. Another admin approves
 * or rejects; the admin who asked then carries it out, once.
 */
export default function ApprovalsPage() {
  const { user: me } = useSession();
  const toast = useToast();
  const [rows, setRows] = useState<Approval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Which request, and which of its buttons, is running: '<id>:approve'.
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const latest = useLatest();

  const load = useCallback(async (opts: { quiet?: boolean } = {}) => {
    const t = latest.begin();
    if (!opts.quiet) setRefreshing(true);
    try {
      const r = await api.get<{ approvals: Approval[] }>('/admin/approvals', { signal: t.signal });
      if (!t.isLatest()) return;
      setRows(r.approvals);
      setLoadError(null);
    } catch (err) {
      if (!t.isLatest()) return;
      // A failed background refresh keeps the list; only a first load shows the error page.
      setLoadError(err);
      if (!opts.quiet) setError(errorText(err, 'Could not load requests'));
    } finally {
      if (t.isLatest()) setRefreshing(false);
    }
  }, [latest]);

  const isAdmin = me?.role === 'ADMIN';
  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  // Another admin's answer shows up without a reload: refresh every 30 s while
  // the tab is visible, and as soon as it becomes visible again.
  useEffect(() => {
    if (!isAdmin) return;
    const tick = () => { if (document.visibilityState === 'visible') void load({ quiet: true }); };
    const timer = window.setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [isAdmin, load]);

  async function act(key: string, work: () => Promise<unknown>, done: string) {
    if (busy) return;
    setError(null);
    setBusy(key);
    try {
      await work();
      toast(done);
      await load();
    } catch (err) {
      setError(errorText(err, 'Request failed'));
    } finally {
      setBusy(null);
    }
  }

  const target = (a: Approval) =>
    a.action === 'MFA_RESET'
      ? <>second factor of <strong>{a.targetUser?.displayName}</strong> ({a.targetUser?.email}, {a.targetUser?.role.toLowerCase()})</>
      : <>break-glass on <strong>{a.documentTitle ?? a.targetDocumentId}</strong></>;

  const reject = async (a: Approval) => {
    if (busy) return;
    const ok = await confirm({
      title: 'Reject this request?',
      body: <>{a.requestedBy.displayName} asked to {a.action === 'MFA_RESET' ? 'clear the ' : 'use '}{target(a)}. Rejecting cannot be undone; they would have to ask again.</>,
      confirmLabel: 'Reject',
      cancelLabel: 'Keep waiting',
      danger: true,
      icon: <X size={20} weight="bold" />,
    });
    if (ok) await act(`${a.id}:reject`, () => api.post(`/admin/approvals/${a.id}/reject`), 'Rejected');
  };

  const waiting = rows?.filter((a) => a.status === 'PENDING' && a.requestedBy.id !== me?.id) ?? [];

  if (me && !isAdmin) {
    return (
      <Shell>
        <EmptyState art={<SpotArt tone="amber" icon={<LockKey size={30} />} />} title="Administrators only" action={<ButtonLink href="/approvals" variant="soft" icon={<ArrowRight size={16} weight="bold" />}>Go to your download approvals</ButtonLink>}>
          These requests are answered by administrators.
        </EmptyState>
      </Shell>
    );
  }

  return (
    <Shell>
      <PageTitle
        title="Approvals"
        icon={<UserCheck size={26} />}
        subtitle="Clearing an owner's or administrator's second factor, and break-glass, need two administrators: one asks with a reason, a different one approves, and the one who asked then carries it out, once, within 24 hours. With only one active administrator these actions are impossible."
      />
      {error && rows && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}
      {waiting.length > 0 && (
        <div className="mb-4"><Alert tone="amber" title="Requests waiting for approval">{waiting.length} request{waiting.length === 1 ? '' : 's'} from another administrator {waiting.length === 1 ? 'needs' : 'need'} your answer.</Alert></div>
      )}
      <Card
        title="All requests"
        icon={<ListChecks size={20} />}
        description="Newest first. Every step is in the audit log. Refreshes on its own every 30 seconds."
        actions={<IconButton label="Refresh" disabled={refreshing} aria-busy={refreshing || undefined} onClick={() => void load()}>{refreshing ? <Spinner /> : <ArrowClockwise size={18} />}</IconButton>}
      >
        {!rows ? (loadError && !refreshing ? <LoadError error={loadError} title="Couldn't load requests" onRetry={() => void load()} /> : <SkeletonRows rows={4} label="Loading requests…" />) : rows.length === 0 ? (
          <EmptyState art={<SpotArt icon={<UserCheck size={30} />} />} title="No requests">Ask from the Users page (Reset 2FA on an owner or admin) or from Alerts (break-glass).</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((a, i) => {
              const mine = a.requestedBy.id === me?.id;
              const rowBusy = !!busy && busy.startsWith(`${a.id}:`);
              return (
                <li key={a.id} className={cx('flex animate-fade-in flex-wrap items-start gap-3 py-4 transition-opacity duration-200', staggerClass(i), rowBusy && 'opacity-80')}>
                  <IconTile size="sm" tone={a.action === 'MFA_RESET' ? 'violet' : 'amber'}>{a.action === 'MFA_RESET' ? <Fingerprint size={18} /> : <Siren size={18} />}</IconTile>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-6">
                      <strong>{mine ? 'You' : a.requestedBy.displayName}</strong> asked to {a.action === 'MFA_RESET' ? 'clear the ' : 'use '}{target(a)}.
                    </p>
                    <p className="mt-1.5 border-l-2 border-line-strong pl-3 text-sm italic text-fg-muted">&ldquo;{a.reason}&rdquo;</p>
                    <p className="mt-1 text-xs text-fg-subtle">
                      Asked <span title={formatDate(a.createdAt)}>{relativeTime(a.createdAt)}</span>
                      {a.approvedBy && <> · approved by {a.approvedBy.displayName}</>}
                      {a.rejectedBy && <> · rejected by {a.rejectedBy.displayName}</>}
                      {a.status === 'PENDING' || a.status === 'APPROVED' ? <> · expires {formatDate(a.expiresAt)}</> : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <Badge dot tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Badge>
                    {a.status === 'PENDING' && !mine && (
                      <>
                        <Button size="sm" variant="primary" icon={<Check size={14} />} loading={busy === `${a.id}:approve`} disabled={!!busy} onClick={() => void act(`${a.id}:approve`, () => api.post(`/admin/approvals/${a.id}/approve`), 'Approved. The admin who asked can now carry it out, once.')}>Approve</Button>
                        <Button size="sm" variant="danger" icon={<X size={14} />} loading={busy === `${a.id}:reject`} disabled={!!busy} onClick={() => void reject(a)}>Reject</Button>
                      </>
                    )}
                    {a.status === 'PENDING' && mine && <Badge icon={<HandPalm size={11} />}>Another admin must answer</Badge>}
                    {a.status === 'APPROVED' && mine && a.action === 'MFA_RESET' && (
                      <Button size="sm" variant="danger" icon={<Fingerprint size={14} />} loading={busy === `${a.id}:execute`} disabled={!!busy}
                        onClick={() => void act(`${a.id}:execute`, () => api.post(`/admin/users/${a.targetUser!.id}/mfa/reset`, { approvalId: a.id }), `Second factor cleared for ${a.targetUser?.email}; they were told by email`)}>Clear second factor now</Button>
                    )}
                    {a.status === 'APPROVED' && mine && a.action === 'BREAK_GLASS' && (
                      <Button size="sm" variant="danger" icon={<Siren size={14} />} loading={busy === `${a.id}:execute`} disabled={!!busy}
                        onClick={() => void act(`${a.id}:execute`, () => api.post('/admin/break-glass', { documentId: a.targetDocumentId, approvalId: a.id }), 'Emergency access open for one hour')}>Open emergency access</Button>
                    )}
                    {a.status === 'USED' && a.action === 'BREAK_GLASS' && mine && a.targetDocumentId && (
                      <ButtonLink size="sm" variant="soft" icon={<ArrowSquareOut size={14} />} href={`/documents/${a.targetDocumentId}`}>Open document</ButtonLink>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {confirmDialog}
    </Shell>
  );
}
