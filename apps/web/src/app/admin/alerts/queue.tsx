'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ArrowClockwise, ChatText, CheckCircle, Checks, ClockCounterClockwise, Fire, Info, ListChecks, MagnifyingGlass, ShieldCheck, UserPlus, Warning, WarningOctagon, ArrowCounterClockwise,
} from '@phosphor-icons/react';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import { Alert, Badge, Button, Card, EmptyState, Input, Label, Modal, Select, SkeletonRows, StatCard, Textarea, cx, relativeTime } from '@/components/ui';
import { api, errorText, formatDate } from '@/lib/api';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
type Status = 'open' | 'acknowledged' | 'assigned' | 'resolved';

export interface QueueAlert {
  id: string;
  createdAt: string;
  rule: string;
  category: string;
  severity: Severity;
  subjectUserId: string | null;
  subjectEmail: string | null;
  documentId: string | null;
  sessionId: string | null;
  observed: number | null;
  threshold: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  message: string;
  details: Record<string, unknown> | null;
  auditSeq: string | null;
  status: Status;
  assigneeId: string | null;
  assigneeEmail: string | null;
  resolution: string | null;
}

interface HistoryItem { id: string; at: string; action: string; statusAfter: string; actorEmail: string | null; assigneeEmail: string | null; resolution: string | null; note: string | null }
interface Summary {
  unresolvedBySeverity: Record<Severity, number>;
  byStatus: Record<Status, number>;
  topSubjects: { userId: string; email: string | null; count: number; maxSeverity: Severity }[];
  generator: { lastOkAt: string | null; lastError: string | null; stale: boolean };
}

export const SEV: Record<Severity, { label: string; bar: string; tile: string; icon: ReactNode }> = {
  critical: { label: 'Critical', bar: 'bg-red-600', tile: 'bg-red-600 text-white', icon: <WarningOctagon size={14} weight="fill" /> },
  high: { label: 'High', bar: 'bg-orange-500', tile: 'bg-orange-500 text-white', icon: <Warning size={14} weight="fill" /> },
  medium: { label: 'Medium', bar: 'bg-amber-400', tile: 'bg-amber-400 text-amber-950', icon: <Warning size={14} /> },
  low: { label: 'Low', bar: 'bg-sky-400', tile: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200', icon: <Info size={14} /> },
  info: { label: 'Info', bar: 'bg-slate-300', tile: 'bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-slate-300', icon: <Info size={14} /> },
};

const STATUS_TONE: Record<Status, 'red' | 'amber' | 'blue' | 'green'> = { open: 'red', acknowledged: 'amber', assigned: 'blue', resolved: 'green' };
const RESOLUTIONS = [
  { id: 'true_positive', label: 'True positive: it happened' },
  { id: 'false_positive', label: 'False positive: the rule was wrong' },
  { id: 'benign', label: 'Benign: real, but legitimate' },
  { id: 'duplicate', label: 'Duplicate of another alert' },
];

const human = (s: string) => s.replace(/_/g, ' ');
const DONE: Record<string, string> = { acknowledge: 'Alert acknowledged', assign: 'Alert assigned', resolve: 'Alert resolved', reopen: 'Alert reopened', comment: 'Comment added' };

export function AlertQueue({ openId }: { openId?: string | null }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [alerts, setAlerts] = useState<QueueAlert[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(openId ?? null);
  const [f, setF] = useState({ status: 'active', minSeverity: '', category: '', subject: '', from: '', to: '', sort: 'severity', mine: false });

  const query = useCallback((after?: string | null) => {
    const p = new URLSearchParams({ status: f.status, sort: f.sort, limit: '50' });
    if (f.minSeverity) p.set('minSeverity', f.minSeverity);
    if (f.category) p.set('category', f.category);
    if (f.subject.trim()) p.set('subject', f.subject.trim());
    if (f.from) p.set('from', new Date(f.from).toISOString());
    if (f.to) p.set('to', new Date(`${f.to}T23:59:59`).toISOString());
    if (f.mine) p.set('assignee', 'me');
    if (after) p.set('cursor', after);
    return `/admin/alert-queue?${p.toString()}`;
  }, [f]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, r] = await Promise.all([
        api.get<Summary>('/admin/alert-queue/summary'),
        api.get<{ alerts: QueueAlert[]; total: number; nextCursor: string | null }>(query()),
      ]);
      setSummary(s);
      setAlerts(r.alerts);
      setTotal(r.total);
      setCursor(r.nextCursor);
    } catch (err) {
      setError(errorText(err));
    }
  }, [query]);

  useEffect(() => { setAlerts(null); void load(); }, [load]);

  const more = async () => {
    if (!cursor) return;
    setBusy(true);
    try {
      const r = await api.get<{ alerts: QueueAlert[]; nextCursor: string | null }>(query(cursor));
      setAlerts((a) => [...(a ?? []), ...r.alerts]);
      setCursor(r.nextCursor);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const evaluate = async () => {
    setBusy(true);
    try {
      await api.post('/admin/alert-queue/evaluate');
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const u = summary?.unresolvedBySeverity;
  return (
    <>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatCard label="Critical, unresolved" value={u?.critical ?? '–'} icon={<WarningOctagon size={22} />} tone="red" hint="Act now" />
        <StatCard label="High, unresolved" value={u?.high ?? '–'} icon={<Warning size={22} />} tone="amber" hint="Look today" delay={60} />
        <StatCard label="Medium, unresolved" value={u?.medium ?? '–'} icon={<Fire size={22} />} tone="violet" hint="Worth a check" delay={120} />
        <StatCard label="Low and info" value={u ? u.low + u.info : '–'} icon={<Info size={22} />} tone="blue" hint="For the record" delay={180} />
      </div>

      {summary?.generator.stale && (
        <div className="mb-4">
          <Alert tone="amber" title="Alert rules have not run recently">
            Last good run {relativeTime(summary.generator.lastOkAt)}{summary.generator.lastError ? `: ${summary.generator.lastError}` : ''}. Nothing is lost: the next run reads from where the last good one stopped.
          </Alert>
        </div>
      )}
      {error && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}

      <Card
        title="Alert queue"
        icon={<ListChecks size={20} />}
        description={alerts ? `${alerts.length} of ${total} shown · highest severity first` : 'Loading'}
        actions={<Button size="sm" icon={<ArrowClockwise size={14} />} loading={busy} onClick={evaluate}>Evaluate now</Button>}
        padded={false}
      >
        <div className="grid gap-3 border-b border-slate-100 p-4 sm:grid-cols-2 lg:grid-cols-4 dark:border-white/[0.06]">
          <Label label="Status">
            <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="active">Not resolved</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option>
              <option value="assigned">Assigned</option><option value="resolved">Resolved</option><option value="all">All</option>
            </Select>
          </Label>
          <Label label="Severity at least">
            <Select value={f.minSeverity} onChange={(e) => setF({ ...f, minSeverity: e.target.value })}>
              <option value="">Any</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
            </Select>
          </Label>
          <Label label="Category">
            <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              <option value="">Any</option>
              {['extraction', 'access', 'auth', 'session', 'integrity', 'policy', 'system'].map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Label>
          <Label label="Order">
            <Select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })}>
              <option value="severity">Severity, then newest</option><option value="newest">Newest first</option>
            </Select>
          </Label>
          <Label label="Person (email)"><Input icon={<MagnifyingGlass size={16} />} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="name@company" /></Label>
          <Label label="From"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Label>
          <Label label="To"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Label>
          <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={f.mine} onChange={(e) => setF({ ...f, mine: e.target.checked })} /> Assigned to me</label>
        </div>

        {!alerts ? <SkeletonRows rows={5} /> : alerts.length === 0 ? (
          <EmptyState art={<SpotArt icon={<ShieldCheck size={30} />} tone="green" />} title="Nothing here">No alerts match these filters.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-white/[0.05]">
            {alerts.map((a) => {
              const s = SEV[a.severity];
              return (
                <li key={a.id}>
                  <button onClick={() => setSelected(a.id)} className="relative flex w-full items-start gap-4 px-5 py-4 text-left hover:bg-slate-50 dark:hover:bg-white/[0.03]">
                    <span className={cx('absolute inset-y-3 left-0 w-1 rounded-r-full', s.bar)} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium leading-6">{a.message}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                        <span className="capitalize">{human(a.rule)}</span><span>·</span>
                        <span title={formatDate(a.createdAt)}>{relativeTime(a.createdAt)}</span>
                        <Badge tone={STATUS_TONE[a.status]} dot>{a.status}</Badge>
                        {a.assigneeEmail && <span>→ {a.assigneeEmail}</span>}
                      </p>
                    </div>
                    <span className={cx('inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide', s.tile)}>{s.icon}{s.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {cursor && <div className="border-t border-slate-100 p-4 text-center dark:border-white/[0.06]"><Button onClick={more} loading={busy}>Load more</Button></div>}
      </Card>

      {selected && <AlertDetail id={selected} onClose={() => setSelected(null)} onChanged={load} />}
    </>
  );
}

function AlertDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<{ alert: QueueAlert; history: HistoryItem[]; relatedAlerts30d: number } | null>(null);
  const [reviewers, setReviewers] = useState<{ id: string; email: string; displayName: string }[]>([]);
  const [note, setNote] = useState('');
  const [assignee, setAssignee] = useState('');
  const [resolution, setResolution] = useState('true_positive');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([
        api.get<{ alert: QueueAlert; history: HistoryItem[]; relatedAlerts30d: number }>(`/admin/alert-queue/${id}`),
        api.get<{ reviewers: { id: string; email: string; displayName: string }[] }>('/admin/alert-queue/reviewers'),
      ]);
      setData(d);
      setReviewers(r.reviewers);
    } catch (err) {
      setError(errorText(err));
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const act = async (action: string, body: object) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/admin/alert-queue/${id}/${action}`, body);
      toast(DONE[action] ?? 'Saved', 'success');
      setNote('');
      await load();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const a = data?.alert;
  const resolved = a?.status === 'resolved';
  return (
    <Modal open onClose={onClose} wide title={a ? human(a.rule) : 'Alert'} description={a ? `${SEV[a.severity].label} · ${a.category} · ${formatDate(a.createdAt)}` : undefined} icon={<ListChecks size={20} />}>
      {!a ? <SkeletonRows rows={3} /> : (
        <div className="space-y-5">
          <p className="text-sm leading-6">{a.message}</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            <div><dt className="text-slate-500">Status</dt><dd><Badge tone={STATUS_TONE[a.status]} dot>{a.status}</Badge>{a.resolution && <span className="ml-1">{human(a.resolution)}</span>}</dd></div>
            <div><dt className="text-slate-500">Person</dt><dd className="truncate">{a.subjectEmail ?? '—'}</dd></div>
            <div><dt className="text-slate-500">Assigned to</dt><dd className="truncate">{a.assigneeEmail ?? '—'}</dd></div>
            {a.observed !== null && <div><dt className="text-slate-500">Observed / threshold</dt><dd>{a.observed}{a.threshold !== null ? ` / ${a.threshold}` : ''}</dd></div>}
            {a.windowStart && <div><dt className="text-slate-500">Window</dt><dd>{formatDate(a.windowStart)} – {formatDate(a.windowEnd)}</dd></div>}
            {a.auditSeq && <div><dt className="text-slate-500">Audit event</dt><dd>#{a.auditSeq}</dd></div>}
            <div><dt className="text-slate-500">Same person, 30 days</dt><dd>{data!.relatedAlerts30d} other alerts</dd></div>
          </dl>
          {a.details && Object.keys(a.details).length > 0 && (
            <pre className="max-h-40 overflow-auto rounded-xl bg-slate-50 p-3 text-[11px] leading-5 text-slate-600 dark:bg-white/[0.04] dark:text-slate-300">{JSON.stringify(a.details, null, 2)}</pre>
          )}

          <section>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><ClockCounterClockwise size={16} />History</h3>
            {data!.history.length === 0 ? <p className="text-xs text-slate-500">No review steps yet.</p> : (
              <ol className="space-y-2">
                {data!.history.map((h) => (
                  <li key={h.id} className="rounded-xl border border-slate-100 px-3 py-2 text-xs dark:border-white/[0.06]">
                    <span className="font-semibold capitalize">{h.action}</span> → {h.statusAfter} · {h.actorEmail ?? 'system'} · {formatDate(h.at)}
                    {h.assigneeEmail && h.action === 'assign' && <> · to {h.assigneeEmail}</>}
                    {h.resolution && <> · {human(h.resolution)}</>}
                    {h.note && <p className="mt-1 text-slate-600 dark:text-slate-300">“{h.note}”</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}

          <section className="space-y-3 rounded-2xl border border-slate-200/80 p-4 dark:border-white/[0.08]">
            <Label label="Note" hint="Recorded in the alert history and the audit log"><Textarea rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked, what you found" /></Label>
            <div className="flex flex-wrap items-end gap-2">
              {a.status === 'open' && <Button size="sm" icon={<Checks size={14} />} loading={busy} onClick={() => act('acknowledge', note.trim() ? { note } : {})}>Acknowledge</Button>}
              {!resolved && (
                <>
                  <Select className="h-8 w-56 text-xs" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                    <option value="">Assign to…</option>
                    {reviewers.filter((r) => r.id !== a.subjectUserId).map((r) => <option key={r.id} value={r.id}>{r.displayName} ({r.email})</option>)}
                  </Select>
                  <Button size="sm" icon={<UserPlus size={14} />} disabled={!assignee} loading={busy} onClick={() => act('assign', { assigneeId: assignee, ...(note.trim() ? { note } : {}) })}>Assign</Button>
                  <Select className="h-8 w-60 text-xs" value={resolution} onChange={(e) => setResolution(e.target.value)}>
                    {RESOLUTIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </Select>
                  <Button size="sm" variant="primary" icon={<CheckCircle size={14} />} disabled={note.trim().length < 5} loading={busy} onClick={() => act('resolve', { resolution, note })}>Resolve</Button>
                </>
              )}
              {resolved && <Button size="sm" icon={<ArrowCounterClockwise size={14} />} disabled={note.trim().length < 5} loading={busy} onClick={() => act('reopen', { note })}>Reopen</Button>}
              <Button size="sm" variant="ghost" icon={<ChatText size={14} />} disabled={note.trim().length < 5} loading={busy} onClick={() => act('comment', { note })}>Comment</Button>
            </div>
            <p className="text-[11px] text-slate-500">Resolving needs a note. An alert about you must be resolved by another administrator.</p>
          </section>
        </div>
      )}
    </Modal>
  );
}
