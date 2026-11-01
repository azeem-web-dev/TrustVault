'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import { Shell } from '@/components/shell';
import { Alert, Badge, Button, Card, Empty, Input, Label, PageTitle, Select } from '@/components/ui';
import { api, errorText, formatDate } from '@/lib/api';

interface Event {
  seq: string;
  occurredAt: string;
  actorEmail: string | null;
  action: string;
  outcome: 'ALLOWED' | 'DENIED' | 'FAILED';
  reason: string | null;
  targetType: string | null;
  targetId: string | null;
  documentId: string | null;
  documentTitle: string | null;
  ip: string | null;
  userAgent: string | null;
  details: unknown;
  hash: string;
}

interface Verify {
  ok: boolean;
  eventsChecked: string;
  firstBadSeq: string | null;
  checkpointsChecked: number;
  latestCheckpoint: { seq: string; createdAt: string } | null;
  problems: string[];
  signingKey: { keyId: string; publicKey: string };
}

const EMPTY = { action: '', outcome: '', actor: '', documentId: '', from: '', to: '' };
const QUICK = [
  { label: 'Everything', action: '' },
  { label: 'Downloads', action: 'document.download' },
  { label: 'Permission changes', action: 'access.' },
  { label: 'Uploads & edits', action: 'document.upload' },
  { label: 'Sign-ins', action: 'auth.' },
  { label: 'Admin actions', action: 'admin.' },
];

/** Document activity and permission changes. Admins see metadata and titles, never file contents. */
export default function AuditPage() {
  const [filters, setFilters] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [events, setEvents] = useState<Event[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [verify, setVerify] = useState<Verify | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const query = useCallback((f: typeof EMPTY, before?: string) => {
    const p = new URLSearchParams({ limit: '50' });
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    if (before) p.set('before', before);
    return p.toString();
  }, []);

  const load = useCallback(async (before?: string) => {
    try {
      const r = await api.get<{ events: Event[]; nextBefore: string | null }>(`/admin/audit?${query(applied, before)}`);
      setEvents((prev) => (before ? [...prev, ...r.events] : r.events));
      setNext(r.nextBefore);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [applied, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied(filters);
  };

  const runVerify = async () => {
    setBusy(true);
    try {
      await api.post('/admin/audit/checkpoint');
      setVerify(await api.post<Verify>('/admin/audit/verify'));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <PageTitle
        title="Audit log"
        subtitle="Every upload, download, change, deletion, permission change and refused attempt. Append-only and hash-chained in the database."
        actions={<>
          <Button onClick={() => void runVerify()} disabled={busy}>{busy ? 'Verifying…' : 'Verify integrity'}</Button>
          <a className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800" href="/api/admin/audit/export?fromSeq=1">Export evidence bundle</a>
        </>}
      />

      {verify && (
        <div className="mb-6">
          <Card title={verify.ok ? 'Audit trail intact' : 'Audit trail FAILED verification'} actions={<Badge tone={verify.ok ? 'green' : 'red'}>{verify.ok ? 'Verified' : 'Tampered'}</Badge>}>
            <ul className="space-y-1 text-sm">
              <li>{verify.eventsChecked} events re-hashed in order{verify.firstBadSeq && <span className="text-red-600"> — first mismatch at #{verify.firstBadSeq}</span>}</li>
              <li>{verify.checkpointsChecked} signed checkpoints checked{verify.latestCheckpoint && <>, latest #{verify.latestCheckpoint.seq} at {formatDate(verify.latestCheckpoint.createdAt)}</>}</li>
              <li className="break-all text-xs text-slate-500">Signing key ({verify.signingKey.keyId}): {verify.signingKey.publicKey}</li>
              {verify.problems.map((p) => <li key={p} className="text-red-600">{p}</li>)}
            </ul>
            <p className="mt-3 text-xs text-slate-500">Exported bundles can be checked offline with <code>node tools/verify-audit.mjs bundle.json {'<public key>'}</code>, without trusting this server.</p>
          </Card>
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-2">
        {QUICK.map((q) => (
          <Button key={q.label} variant={applied.action === q.action ? 'primary' : 'secondary'} onClick={() => { const f = { ...EMPTY, action: q.action }; setFilters(f); setApplied(f); }}>{q.label}</Button>
        ))}
        <Button variant={applied.outcome === 'DENIED' ? 'primary' : 'secondary'} onClick={() => { const f = { ...applied, outcome: applied.outcome === 'DENIED' ? '' : 'DENIED' }; setFilters(f); setApplied(f); }}>Refused only</Button>
      </div>

      <form onSubmit={submit} className="mb-6 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3 lg:grid-cols-6 dark:border-slate-800 dark:bg-slate-900">
        <Label label="Action starts with"><Input value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} placeholder="document." /></Label>
        <Label label="Outcome">
          <Select value={filters.outcome} onChange={(e) => setFilters({ ...filters, outcome: e.target.value })}>
            <option value="">Any</option><option>ALLOWED</option><option>DENIED</option><option>FAILED</option>
          </Select>
        </Label>
        <Label label="Actor email"><Input value={filters.actor} onChange={(e) => setFilters({ ...filters, actor: e.target.value })} /></Label>
        <Label label="Document id"><Input value={filters.documentId} onChange={(e) => setFilters({ ...filters, documentId: e.target.value })} /></Label>
        <Label label="From"><Input type="datetime-local" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></Label>
        <Label label="To"><Input type="datetime-local" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></Label>
        <div className="flex gap-2 lg:col-span-6"><Button type="submit" variant="primary">Filter</Button><Button type="button" variant="ghost" onClick={() => { setFilters(EMPTY); setApplied(EMPTY); }}>Clear</Button></div>
      </form>

      {error && <div className="mb-4"><Alert>{error}</Alert></div>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
            <tr><th className="px-3 py-2">#</th><th className="px-3 py-2">When</th><th className="px-3 py-2">Who</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Target</th><th className="px-3 py-2">Result</th></tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <Fragment key={e.seq}>
                <tr onClick={() => setOpen(open === e.seq ? null : e.seq)} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50">
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{e.seq}</td>
                  <td className="whitespace-nowrap px-3 py-2">{formatDate(e.occurredAt)}</td>
                  <td className="px-3 py-2">{e.actorEmail ?? 'system'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{e.action}</td>
                  <td className="px-3 py-2">{e.documentTitle ? <span title={e.documentId ?? ''}>{e.documentTitle}</span> : e.targetType ? <span className="text-slate-500">{e.targetType}</span> : '—'}</td>
                  <td className="px-3 py-2"><Badge tone={e.outcome === 'ALLOWED' ? 'green' : e.outcome === 'DENIED' ? 'red' : 'amber'}>{e.outcome}</Badge>{e.reason && <span className="ml-2 text-xs text-slate-500">{e.reason}</span>}</td>
                </tr>
                {open === e.seq && (
                  <tr className="border-b border-slate-100 bg-slate-50 dark:border-slate-800 dark:bg-slate-800/40">
                    <td colSpan={6} className="px-3 py-3 text-xs">
                      <div className="grid gap-1 sm:grid-cols-2">
                        <div>IP: {e.ip ?? '—'}</div>
                        <div className="truncate">User agent: {e.userAgent ?? '—'}</div>
                        <div>Target: {e.targetType ?? '—'} {e.targetId ?? ''}</div>
                        <div className="break-all">Hash: <span className="font-mono">{e.hash}</span></div>
                      </div>
                      {e.documentId && <Link className="mt-2 inline-block text-brand-600 hover:underline" href={`/admin/audit?documentId=${e.documentId}`} onClick={(ev) => { ev.preventDefault(); const f = { ...EMPTY, documentId: e.documentId! }; setFilters(f); setApplied(f); }}>All events for this document</Link>}
                      {e.details !== null && <pre className="mt-2 overflow-x-auto rounded bg-white p-2 dark:bg-slate-900">{JSON.stringify(e.details, null, 2)}</pre>}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {events.length === 0 && <Empty>No events match.</Empty>}
      </div>
      {next && <div className="mt-4 text-center"><Button onClick={() => void load(next)}>Load older events</Button></div>}
    </Shell>
  );
}
