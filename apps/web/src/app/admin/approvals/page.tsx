'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, Fingerprint, HandPalm, Siren, UserCheck, X } from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import { Alert, Badge, Button, Card, EmptyState, PageTitle, SkeletonRows, relativeTime } from '@/components/ui';
import { api, errorText, formatDate } from '@/lib/api';

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
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await api.get<{ approvals: Approval[] }>('/admin/approvals')).approvals);
    } catch (err) {
      setError(errorText(err, 'Could not load requests'));
    }
  }, []);
  useEffect(() => {
    if (me?.role === 'ADMIN') void load();
  }, [me, load]);

  async function act(id: string, work: () => Promise<unknown>, done: string) {
    setError(null);
    setBusy(id);
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

  const waiting = rows?.filter((a) => a.status === 'PENDING' && a.requestedBy.id !== me?.id) ?? [];

  return (
    <Shell>
      <PageTitle
        title="Approvals"
        icon={<UserCheck size={26} />}
        subtitle="Clearing an owner's or administrator's second factor, and break-glass, need two administrators: one asks with a reason, a different one approves, and the one who asked then carries it out, once, within 24 hours. With only one active administrator these actions are impossible."
      />
      {error && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}
      {waiting.length > 0 && (
        <div className="mb-4"><Alert tone="amber" title="Requests waiting for approval">{waiting.length} request{waiting.length === 1 ? '' : 's'} from another administrator {waiting.length === 1 ? 'needs' : 'need'} your answer.</Alert></div>
      )}
      <Card title="All requests" description="Newest first. Every step is in the audit log.">
        {!rows ? <SkeletonRows rows={4} /> : rows.length === 0 ? (
          <EmptyState art={<SpotArt icon={<UserCheck size={30} />} />} title="No requests">Ask from the Users page (Reset 2FA on an owner or admin) or from Alerts (break-glass).</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {rows.map((a) => {
              const mine = a.requestedBy.id === me?.id;
              return (
                <li key={a.id} className="flex flex-wrap items-start gap-3 py-4">
                  <span className="mt-0.5 text-slate-500">{a.action === 'MFA_RESET' ? <Fingerprint size={22} /> : <Siren size={22} />}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-6">
                      <strong>{mine ? 'You' : a.requestedBy.displayName}</strong> asked to {a.action === 'MFA_RESET' ? 'clear the ' : 'use '}{target(a)}.
                    </p>
                    <p className="mt-1 text-sm italic text-slate-600 dark:text-slate-300">&ldquo;{a.reason}&rdquo;</p>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
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
                        <Button size="sm" variant="primary" icon={<Check size={14} />} loading={busy === a.id} onClick={() => void act(a.id, () => api.post(`/admin/approvals/${a.id}/approve`), 'Approved. The admin who asked can now carry it out, once.')}>Approve</Button>
                        <Button size="sm" variant="danger" icon={<X size={14} />} onClick={() => void act(a.id, () => api.post(`/admin/approvals/${a.id}/reject`), 'Rejected')}>Reject</Button>
                      </>
                    )}
                    {a.status === 'PENDING' && mine && <Badge icon={<HandPalm size={11} />}>Another admin must answer</Badge>}
                    {a.status === 'APPROVED' && mine && a.action === 'MFA_RESET' && (
                      <Button size="sm" variant="danger" icon={<Fingerprint size={14} />} loading={busy === a.id}
                        onClick={() => void act(a.id, () => api.post(`/admin/users/${a.targetUser!.id}/mfa/reset`, { approvalId: a.id }), `Second factor cleared for ${a.targetUser?.email}; they were told by email`)}>Clear second factor now</Button>
                    )}
                    {a.status === 'APPROVED' && mine && a.action === 'BREAK_GLASS' && (
                      <Button size="sm" variant="danger" icon={<Siren size={14} />} loading={busy === a.id}
                        onClick={() => void act(a.id, () => api.post('/admin/break-glass', { documentId: a.targetDocumentId, approvalId: a.id }), 'Emergency access open for one hour')}>Open emergency access</Button>
                    )}
                    {a.status === 'USED' && a.action === 'BREAK_GLASS' && mine && a.targetDocumentId && (
                      <Link className="text-sm font-semibold text-brand-600 hover:underline dark:text-brand-300" href={`/documents/${a.targetDocumentId}`}>Open document</Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </Shell>
  );
}
