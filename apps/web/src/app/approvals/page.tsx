'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, Check, CheckCircle, Clock, HandPalm, Quotes, X } from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import { Alert, Avatar, Badge, Button, EmptyState, IconButton, Input, LoadError, PageTitle, Select, Skeleton, cx, staggerClass } from '@/components/ui';
import { api, errorText, formatDate } from '@/lib/api';
import { isAbortError, prefersReducedMotion, useAction, useLatest } from '@/lib/hooks';

interface Request {
  id: string;
  reason: string;
  createdAt: string;
  versionNo: number;
  document: { id: string; title: string };
  requester: { id: string; name: string; email: string };
}

type Terms = { hours: number; uses: number; note: string };

/** Don't refetch on every focus flicker: at most once per this many ms. */
const REFRESH_GAP = 10_000;

/**
 * Download requests waiting for me: documents I own, or shares where the
 * owner nominated me. Approving lets that one person download that one
 * version, a set number of times, for a few hours (THREATS.md P8-P10).
 */
export default function ApprovalsPage() {
  const toast = useToast();
  const latest = useLatest();
  const [requests, setRequests] = useState<Request[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The last load failed. With no list yet this replaces the skeleton with LoadError + Retry (X3). */
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  /** Cards that were just decided: they fade out before the list reloads. */
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const lastLoad = useRef(0);

  const load = useCallback(async () => {
    const t = latest.begin();
    lastLoad.current = Date.now();
    setLoading(true);
    try {
      const r = await api.get<{ requests: Request[] }>('/download-requests', { signal: t.signal });
      if (!t.isLatest()) return;
      setRequests(r.requests);
      setLoadError(null);
    } catch (err) {
      if (!t.isLatest() || isAbortError(err)) return;
      setLoadError(err);
    } finally {
      if (t.isLatest()) setLoading(false);
    }
  }, [latest]);

  useEffect(() => { void load(); }, [load]);

  // New requests arrive while the page is open: refresh when the tab comes back into view.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLoad.current > REFRESH_GAP) void load();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const decide = async (r: Request, approve: boolean, terms: Terms) => {
    setError(null);
    try {
      await api.post(`/download-requests/${r.id}/${approve ? 'approve' : 'reject'}`, approve ? { hours: terms.hours, uses: terms.uses, note: terms.note || undefined } : { note: terms.note || undefined });
      toast(approve ? `${r.requester.name} can download version ${r.versionNo} of “${r.document.title}”.` : 'Request declined. They were told.');
      setLeaving((s) => new Set(s).add(r.id));
      if (!prefersReducedMotion()) await new Promise((res) => setTimeout(res, 180));
      await load();
    } catch (err) {
      setError(errorText(err));
      // It may have expired or been decided by someone else: show the list as it is now (U2).
      void load();
    } finally {
      setLeaving((s) => {
        if (!s.has(r.id)) return s;
        const next = new Set(s);
        next.delete(r.id);
        return next;
      });
    }
  };

  // A refresh that fails while the list is showing: say so, but keep the list.
  const staleError = requests && loadError ? errorText(loadError) : null;

  return (
    <Shell>
      <PageTitle
        title="Download approvals"
        icon={<HandPalm size={26} />}
        subtitle="People whose share asks for approval before downloading. Approve only what you expected; every request, decision and download is recorded."
        actions={requests && (
          <>
            {requests.length > 0 && <Badge tone="amber" dot className="animate-fade-in">{requests.length} waiting</Badge>}
            <IconButton label="Refresh" onClick={() => void load()} disabled={loading}>
              <ArrowClockwise size={18} className={loading ? 'animate-spin' : undefined} />
            </IconButton>
          </>
        )}
      />
      {(error || staleError) && (
        <div className="mb-4 animate-fade-in">
          <Alert onDismiss={() => { setError(null); setLoadError(null); }}>{error ?? staleError}</Alert>
        </div>
      )}
      {!requests ? (
        loadError ? (
          <div className="rounded-2xl border border-line bg-surface shadow-soft">
            <LoadError error={loadError} title="Couldn’t load requests" onRetry={() => void load()} retrying={loading} />
          </div>
        ) : <RequestSkeletons />
      ) : requests.length === 0 ? (
        <div className="animate-fade-in rounded-2xl border border-line bg-surface shadow-soft">
          <EmptyState art={<SpotArt icon={<CheckCircle size={30} />} tone="green" />} title="Nothing waiting">Requests appear here when someone asks to download a document whose share needs approval.</EmptyState>
        </div>
      ) : (
        <ul className="animate-fade-in space-y-4">
          {requests.map((r, i) => <RequestCard key={r.id} r={r} index={i} leaving={leaving.has(r.id)} onDecide={decide} />)}
        </ul>
      )}
    </Shell>
  );
}

/** Card-shaped placeholders: avatar, three lines and the control row. */
function RequestSkeletons() {
  return (
    <div role="status" aria-busy="true" className="space-y-4">
      <span className="sr-only">Loading requests…</span>
      {[0, 1].map((i) => (
        <div key={i} aria-hidden className="rounded-2xl border border-line bg-surface p-4 shadow-soft sm:p-5">
          <div className="flex items-start gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
            <Skeleton className="h-9 w-24 rounded-lg" />
            <Skeleton className="h-9 w-24 rounded-lg" />
            <Skeleton className="h-9 min-w-[12.5rem] flex-1 rounded-lg" />
            <Skeleton className="h-9 w-full rounded-lg sm:w-48" />
          </div>
        </div>
      ))}
    </div>
  );
}

function RequestCard({ r, index, leaving, onDecide }: { r: Request; index: number; leaving: boolean; onDecide: (r: Request, approve: boolean, terms: Terms) => Promise<void> }) {
  const [hours, setHours] = useState(24);
  const [uses, setUses] = useState(1);
  const [note, setNote] = useState('');
  // One decision at a time per card: a double click, or Approve then Decline, sends one POST (U1).
  const { busy, run } = useAction();
  const locked = busy !== null || leaving;
  const decide = (approve: boolean) => void run(approve ? 'approve' : 'reject', () => onDecide(r, approve, { hours, uses, note }));
  const noteId = `note-${r.id}`;
  return (
    <li
      aria-busy={busy !== null || undefined}
      className={cx(
        'rounded-2xl border border-line bg-surface p-4 shadow-soft transition duration-200 ease-out hover:border-line-strong sm:p-5',
        leaving ? 'pointer-events-none scale-95 opacity-0' : cx('animate-rise', staggerClass(index)),
      )}
    >
      <div className="flex items-start gap-3">
        <Avatar name={r.requester.name} />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-6 text-fg-muted [overflow-wrap:anywhere]">
            <span className="font-semibold text-fg">{r.requester.name}</span>{' '}
            <span className="text-fg-subtle">({r.requester.email})</span> asks to download{' '}
            <Link
              className="rounded font-semibold text-brand-700 underline underline-offset-2 transition-colors hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 dark:text-brand-300 dark:hover:text-brand-200"
              href={`/documents/${r.document.id}`}
            >
              {r.document.title}
            </Link>{' '}
            <Badge>v{r.versionNo}</Badge>
          </p>
          <p className="mt-2 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm text-fg-muted ring-1 ring-inset ring-line [overflow-wrap:anywhere]">
            <Quotes size={16} weight="fill" className="mt-0.5 shrink-0 text-fg-subtle" />
            <span className="min-w-0 italic">{r.reason}</span>
          </p>
          <p className="mt-2 flex items-center gap-1.5 text-xs text-fg-subtle">
            <Clock size={14} className="shrink-0" />
            Asked {formatDate(r.createdAt)}. Requests expire after 7 days.
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4">
        <label className="text-xs font-medium text-fg-muted">For
          <Select className="mt-1" value={hours} disabled={locked} onChange={(e) => setHours(Number(e.target.value))}>
            {[1, 4, 8, 24, 48, 72].map((h) => <option key={h} value={h}>{h} hour{h === 1 ? '' : 's'}</option>)}
          </Select>
        </label>
        <label className="text-xs font-medium text-fg-muted">Downloads
          <Select className="mt-1" value={uses} disabled={locked} onChange={(e) => setUses(Number(e.target.value))}>
            {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n === 1 ? 'Once' : `${n} times`}</option>)}
          </Select>
        </label>
        <label htmlFor={noteId} className="min-w-[12.5rem] flex-1 text-xs font-medium text-fg-muted">Note to them <span className="font-normal text-fg-subtle">(optional)</span>
          <Input id={noteId} className="mt-1" placeholder="Shown to the requester" value={note} maxLength={500} disabled={locked} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="flex w-full gap-2 sm:w-auto">
          <Button variant="primary" className="flex-1 sm:flex-none" icon={<Check size={16} weight="bold" />} loading={busy === 'approve'} disabled={locked} onClick={() => decide(true)}>Approve</Button>
          <Button variant="danger" className="flex-1 sm:flex-none" icon={<X size={16} weight="bold" />} loading={busy === 'reject'} disabled={locked} onClick={() => decide(false)}>Decline</Button>
        </div>
      </div>
    </li>
  );
}
