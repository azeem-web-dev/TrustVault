'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Check, HandPalm, X } from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import { Alert, Avatar, Badge, Button, EmptyState, Input, PageTitle, Select, Skeleton } from '@/components/ui';
import { api, errorText, formatDate } from '@/lib/api';

interface Request {
  id: string;
  reason: string;
  createdAt: string;
  versionNo: number;
  document: { id: string; title: string };
  requester: { id: string; name: string; email: string };
}

/**
 * Download requests waiting for me: documents I own, or shares where the
 * owner nominated me. Approving lets that one person download that one
 * version, a set number of times, for a few hours (THREATS.md P8-P10).
 */
export default function ApprovalsPage() {
  const toast = useToast();
  const [requests, setRequests] = useState<Request[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.get<{ requests: Request[] }>('/download-requests').then((r) => setRequests(r.requests)).catch((e) => setError(errorText(e))), []);
  useEffect(() => { void load(); }, [load]);

  const decide = async (r: Request, approve: boolean, terms: { hours: number; uses: number; note: string }) => {
    setError(null);
    try {
      await api.post(`/download-requests/${r.id}/${approve ? 'approve' : 'reject'}`, approve ? { hours: terms.hours, uses: terms.uses, note: terms.note || undefined } : { note: terms.note || undefined });
      toast(approve ? `${r.requester.name} can download version ${r.versionNo} of “${r.document.title}”.` : 'Request declined. They were told.');
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Shell>
      <PageTitle
        title="Download approvals"
        icon={<HandPalm size={26} />}
        subtitle="People whose share asks for approval before downloading. Approve only what you expected; every request, decision and download is recorded."
      />
      {error && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}
      {!requests ? <Skeleton className="h-40 rounded-2xl" /> : requests.length === 0 ? (
        <div className="rounded-2xl border border-slate-200/80 bg-white shadow-soft dark:border-white/[0.08] dark:bg-white/[0.03]">
          <EmptyState art={<SpotArt icon={<Check size={30} />} tone="green" />} title="Nothing waiting">Requests appear here when someone asks to download a document whose share needs approval.</EmptyState>
        </div>
      ) : (
        <ul className="space-y-4">
          {requests.map((r) => <RequestCard key={r.id} r={r} onDecide={decide} />)}
        </ul>
      )}
    </Shell>
  );
}

function RequestCard({ r, onDecide }: { r: Request; onDecide: (r: Request, approve: boolean, terms: { hours: number; uses: number; note: string }) => Promise<void> }) {
  const [hours, setHours] = useState(24);
  const [uses, setUses] = useState(1);
  const [note, setNote] = useState('');
  return (
    <li className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-soft dark:border-white/[0.08] dark:bg-white/[0.03]">
      <div className="flex flex-wrap items-start gap-3">
        <Avatar name={r.requester.name} />
        <div className="min-w-0 flex-1">
          <p className="text-sm"><span className="font-semibold">{r.requester.name}</span> <span className="text-slate-500">({r.requester.email})</span> asks to download <Link className="font-semibold underline" href={`/documents/${r.document.id}`}>{r.document.title}</Link> <Badge>v{r.versionNo}</Badge></p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">“{r.reason}”</p>
          <p className="mt-1 text-xs text-slate-500">Asked {formatDate(r.createdAt)}. Requests expire after 7 days.</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-500">For
          <Select className="mt-1" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {[1, 4, 8, 24, 48, 72].map((h) => <option key={h} value={h}>{h} hour{h === 1 ? '' : 's'}</option>)}
          </Select>
        </label>
        <label className="text-xs text-slate-500">Downloads
          <Select className="mt-1" value={uses} onChange={(e) => setUses(Number(e.target.value))}>
            {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n === 1 ? 'Once' : `${n} times`}</option>)}
          </Select>
        </label>
        <Input className="min-w-[12.5rem] flex-1" placeholder="Note to them (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        <Button variant="primary" icon={<Check size={16} />} onClick={() => void onDecide(r, true, { hours, uses, note })}>Approve</Button>
        <Button icon={<X size={16} />} onClick={() => void onDecide(r, false, { hours, uses, note })}>Decline</Button>
      </div>
    </li>
  );
}
