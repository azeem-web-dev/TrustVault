'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowClockwise, ChatText, CheckCircle, Checks, ClockCounterClockwise, Info, ListChecks, MagnifyingGlass, ShieldCheck, UserPlus, Warning, WarningOctagon, ArrowCounterClockwise, UserFocus, CaretDown,
} from '@phosphor-icons/react';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import { Alert, Badge, Button, Card, EmptyState, Input, Label, LoadError, Modal, Select, SkeletonRows, StatCard, Textarea, cx, relativeTime, staggerClass } from '@/components/ui';
import { api, errorText, formatDate } from '@/lib/api';
import { useAction, useDebounced, useLatest } from '@/lib/hooks';
import { localDayEndISO, localDayStartISO } from '@/lib/dates';

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
interface Reviewer { id: string; email: string; displayName: string }
interface RunResult { scannedEvents: number; raised: number; bySeverity: Record<string, number>; escalated: number; backlog: boolean }

/** One severity scale for pills, side bars and stat cards (critical red, high orange, medium amber, low sky, info slate). */
export const SEV: Record<Severity, { label: string; bar: string; tile: string; icon: ReactNode }> = {
  critical: { label: 'Critical', bar: 'bg-danger-600', tile: 'bg-danger-700 text-white dark:bg-danger-600', icon: <WarningOctagon size={14} weight="fill" /> },
  high: { label: 'High', bar: 'bg-severe-500', tile: 'bg-severe-100 text-severe-700 ring-1 ring-inset ring-severe-300/60 dark:bg-severe-500/20 dark:text-severe-300 dark:ring-severe-500/30', icon: <Warning size={14} weight="fill" /> },
  medium: { label: 'Medium', bar: 'bg-warning-500', tile: 'bg-warning-100 text-warning-700 ring-1 ring-inset ring-warning-300/60 dark:bg-warning-500/20 dark:text-warning-300 dark:ring-warning-500/30', icon: <Warning size={14} /> },
  low: { label: 'Low', bar: 'bg-info-500', tile: 'bg-info-100 text-info-700 ring-1 ring-inset ring-info-300/60 dark:bg-info-500/20 dark:text-info-300 dark:ring-info-500/30', icon: <Info size={14} /> },
  info: { label: 'Info', bar: 'bg-fg-subtle', tile: 'bg-fg/[0.06] text-fg-muted ring-1 ring-inset ring-line', icon: <Info size={14} /> },
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
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function AlertQueue({ openId, onDeepLinkClosed }: { openId?: string | null; onDeepLinkClosed?: () => void }) {
  const toast = useToast();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [alerts, setAlerts] = useState<QueueAlert[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [selected, setSelected] = useState<string | null>(openId ?? null);
  // The last alert opened stays mounted while its dialog animates out.
  const [shown, setShown] = useState<string | null>(openId ?? null);
  useEffect(() => { if (selected) setShown(selected); }, [selected]);
  const [f, setF] = useState({ status: 'active', minSeverity: '', category: '', subject: '', from: '', to: '', sort: 'severity', mine: false });
  // Typing an email waits for a pause before it searches (O7).
  const subject = useDebounced(f.subject.trim(), 300);
  const latest = useLatest();
  // Bumped by every fresh load, so a "Load more" started under old filters is dropped.
  const generation = useRef(0);

  // The deep link arrives after the first render (it is read from the URL in an effect).
  useEffect(() => { if (openId) setSelected(openId); }, [openId]);

  const { status, minSeverity, category, from, to, sort, mine } = f;
  const query = useCallback((after?: string | null) => {
    const p = new URLSearchParams({ status, sort, limit: '50' });
    if (minSeverity) p.set('minSeverity', minSeverity);
    if (category) p.set('category', category);
    if (subject) p.set('subject', subject);
    // Both ends in the admin's own time zone: start of 'From', end of 'To' (X6).
    const fromIso = localDayStartISO(from);
    const toIso = localDayEndISO(to);
    if (fromIso) p.set('from', fromIso);
    if (toIso) p.set('to', toIso);
    if (mine) p.set('assignee', 'me');
    if (after) p.set('cursor', after);
    return `/admin/alert-queue?${p.toString()}`;
  }, [status, minSeverity, category, subject, from, to, sort, mine]);

  const load = useCallback(async () => {
    const t = latest.begin();
    generation.current++;
    setLoading(true);
    setError(null);
    const [s, r] = await Promise.allSettled([
      api.get<Summary>('/admin/alert-queue/summary', { signal: t.signal }),
      api.get<{ alerts: QueueAlert[]; total: number; nextCursor: string | null }>(query(), { signal: t.signal }),
    ]);
    if (!t.isLatest()) return;
    if (s.status === 'fulfilled') setSummary(s.value);
    if (r.status === 'fulfilled') {
      setAlerts(r.value.alerts);
      setTotal(r.value.total);
      setCursor(r.value.nextCursor);
      setLoadError(null);
    } else {
      setLoadError(r.reason);
      setError(errorText(r.reason));
    }
    setLoading(false);
  }, [query, latest]);

  // Old rows stay on screen, dimmed, while new filters load.
  useEffect(() => { void load(); }, [load]);

  const more = async () => {
    if (!cursor || loadingMore) return;
    const gen = generation.current;
    setLoadingMore(true);
    try {
      const r = await api.get<{ alerts: QueueAlert[]; nextCursor: string | null }>(query(cursor));
      if (gen !== generation.current) return;
      setAlerts((a) => {
        const seen = new Set((a ?? []).map((x) => x.id));
        return [...(a ?? []), ...r.alerts.filter((x) => !seen.has(x.id))];
      });
      setCursor(r.nextCursor);
    } catch (err) {
      if (gen === generation.current) setError(errorText(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const evaluate = async () => {
    if (evaluating) return;
    setEvaluating(true);
    setError(null);
    try {
      const { run } = await api.post<{ run: RunResult | null }>('/admin/alert-queue/evaluate');
      if (!run) toast('Rules are already running on the server; refresh in a moment', 'info');
      else if (run.raised === 0) toast(`Rules evaluated: no new alerts (${plural(run.scannedEvents, 'event')} checked)`, 'success');
      else toast(`Rules evaluated: ${plural(run.raised, 'new alert')}${run.backlog ? '. More events are waiting; run it again.' : ''}`, run.bySeverity.critical ? 'warning' : 'success');
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setEvaluating(false);
    }
  };

  const closeDetail = useCallback(() => {
    if (selected && selected === openId) onDeepLinkClosed?.();
    setSelected(null);
  }, [selected, openId, onDeepLinkClosed]);

  const u = summary?.unresolvedBySeverity;
  return (
    <>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatCard label="Critical, unresolved" value={u?.critical ?? '–'} icon={<WarningOctagon size={22} weight="fill" />} tone="red" hint="Act now" />
        <StatCard label="High, unresolved" value={u?.high ?? '–'} icon={<Warning size={22} weight="fill" />} tone="orange" hint="Look today" delay={40} />
        <StatCard label="Medium, unresolved" value={u?.medium ?? '–'} icon={<Warning size={22} />} tone="amber" hint="Worth a check" delay={80} />
        <StatCard label="Low and info" value={u ? u.low + u.info : '–'} icon={<Info size={22} weight="fill" />} tone="blue" hint="For the record" delay={120} />
      </div>

      {summary?.generator.stale && (
        <div className="mb-4">
          <Alert tone="amber" title="Alert rules have not run recently">
            Last good run {relativeTime(summary.generator.lastOkAt)}{summary.generator.lastError ? `: ${summary.generator.lastError}` : ''}. Nothing is lost: the next run reads from where the last good one stopped.
          </Alert>
        </div>
      )}
      {error && alerts && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}

      <Card
        title="Alert queue"
        icon={<ListChecks size={20} />}
        description={alerts ? `${alerts.length} of ${total} shown · ${sort === 'severity' ? 'highest severity first' : 'newest first'}` : 'Loading'}
        actions={<Button size="sm" icon={<ArrowClockwise size={14} />} loading={evaluating} onClick={() => void evaluate()}>Evaluate now</Button>}
        padded={false}
      >
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-4">
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
              {['extraction', 'access', 'auth', 'session', 'integrity', 'policy', 'system'].map((c) => <option key={c} value={c}>{c[0]!.toUpperCase() + c.slice(1)}</option>)}
            </Select>
          </Label>
          <Label label="Order">
            <Select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })}>
              <option value="severity">Severity, then newest</option><option value="newest">Newest first</option>
            </Select>
          </Label>
          <Label label="Person (email)"><Input type="search" icon={<MagnifyingGlass size={16} />} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="name@company" /></Label>
          <Label label="From"><Input type="date" max={f.to || undefined} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Label>
          <Label label="To"><Input type="date" min={f.from || undefined} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Label>
          <div className="flex items-end">
            <button
              type="button"
              aria-pressed={f.mine}
              onClick={() => setF({ ...f, mine: !f.mine })}
              className={cx(
                'inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 pointer-coarse:h-11',
                f.mine
                  ? 'border-brand-400 bg-brand-50 text-brand-700 dark:border-brand-400/60 dark:bg-brand-500/15 dark:text-brand-200'
                  : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:bg-fg/[0.03] hover:text-fg dark:bg-white/[0.04]',
              )}
            >
              {f.mine ? <CheckCircle size={16} weight="fill" /> : <UserFocus size={16} />}
              Assigned to me
            </button>
          </div>
        </div>

        {!alerts ? (
          loadError && !loading
            ? <LoadError error={loadError} title="Couldn't load the queue" onRetry={() => void load()} />
            : <SkeletonRows rows={5} label="Loading alerts…" />
        ) : alerts.length === 0 ? (
          <EmptyState art={<SpotArt icon={<ShieldCheck size={30} />} tone="green" />} title="Nothing here">No alerts match these filters.</EmptyState>
        ) : (
          <ul aria-busy={loading || undefined} className={cx('divide-y divide-line transition-opacity duration-200', loading && 'opacity-60')}>
            {alerts.map((a, i) => {
              const s = SEV[a.severity];
              return (
                <li key={a.id} className={cx('animate-fade-in', staggerClass(i))}>
                  <button
                    type="button"
                    onClick={() => setSelected(a.id)}
                    className="relative flex w-full items-start gap-4 px-5 py-4 text-left transition-colors hover:bg-fg/[0.03] focus-visible:bg-fg/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/50 active:bg-fg/[0.06]"
                  >
                    <span aria-hidden className={cx('absolute inset-y-3 left-0 w-1 rounded-r-full', s.bar)} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium leading-6">{a.message}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-subtle">
                        <span className="capitalize">{human(a.rule)}</span><span aria-hidden>·</span>
                        <span title={formatDate(a.createdAt)}>{relativeTime(a.createdAt)}</span>
                        <Badge tone={STATUS_TONE[a.status]} dot className="capitalize">{a.status}</Badge>
                        {a.assigneeEmail && <span>→ {a.assigneeEmail}</span>}
                      </p>
                    </div>
                    <span className={cx('inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[0.6875rem] font-bold uppercase tracking-wide', s.tile)}>{s.icon}{s.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {cursor && alerts && <div className="border-t border-line p-4 text-center"><Button icon={<CaretDown size={16} weight="bold" />} onClick={() => void more()} loading={loadingMore} disabled={loading}>Load more</Button></div>}
      </Card>

      {shown && <AlertDetail key={shown} id={shown} open={selected === shown} onClose={closeDetail} onChanged={load} />}
    </>
  );
}

type Detail = { alert: QueueAlert; history: HistoryItem[]; relatedAlerts30d: number };

function AlertDetail({ id, open, onClose, onChanged }: { id: string; open: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);
  const [reviewers, setReviewers] = useState<Reviewer[] | null>(null);
  const [reviewersError, setReviewersError] = useState(false);
  const [note, setNote] = useState('');
  const [assignee, setAssignee] = useState('');
  const [resolution, setResolution] = useState('true_positive');
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();

  // The alert and the reviewer list load separately: a reviewers failure only
  // disables Assign, it never hides an alert that loaded (O1).
  const load = useCallback(async () => {
    const [d, r] = await Promise.allSettled([
      api.get<Detail>(`/admin/alert-queue/${id}`),
      api.get<{ reviewers: Reviewer[] }>('/admin/alert-queue/reviewers'),
    ]);
    if (d.status === 'fulfilled') { setData(d.value); setLoadError(null); } else setLoadError(d.reason);
    if (r.status === 'fulfilled') { setReviewers(r.value.reviewers); setReviewersError(false); } else setReviewersError(true);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const retry = async () => {
    setRetrying(true);
    try { await load(); } finally { setRetrying(false); }
  };

  const act = (action: string, body: object) => run(action, async () => {
    setError(null);
    try {
      await api.post(`/admin/alert-queue/${id}/${action}`, body);
      toast(DONE[action] ?? 'Saved', 'success');
      setNote('');
      if (action === 'assign') setAssignee('');
      await load();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  });

  const a = data?.alert;
  const resolved = a?.status === 'resolved';
  const noteOk = note.trim().length >= 5;
  const dt = 'text-fg-subtle';
  return (
    <Modal open={open} onClose={onClose} wide title={a ? <span className="capitalize">{human(a.rule)}</span> : 'Alert'} description={a ? `${SEV[a.severity].label} · ${a.category} · ${formatDate(a.createdAt)}` : undefined} icon={<ListChecks size={20} />}>
      {!a ? (
        loadError
          ? <LoadError error={loadError} title="Couldn't open this alert" onRetry={() => void retry()} retrying={retrying} />
          : <SkeletonRows rows={3} label="Loading the alert…" />
      ) : (
        <div className="animate-fade-in space-y-5">
          <p className="text-sm leading-6">{a.message}</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            <div><dt className={dt}>Status</dt><dd><Badge tone={STATUS_TONE[a.status]} dot className="capitalize">{a.status}</Badge>{a.resolution && <span className="ml-1">{human(a.resolution)}</span>}</dd></div>
            <div><dt className={dt}>Person</dt><dd className="truncate">{a.subjectEmail ?? '—'}</dd></div>
            <div><dt className={dt}>Assigned to</dt><dd className="truncate">{a.assigneeEmail ?? '—'}</dd></div>
            {a.observed !== null && <div><dt className={dt}>Observed / threshold</dt><dd>{a.observed}{a.threshold !== null ? ` / ${a.threshold}` : ''}</dd></div>}
            {a.windowStart && <div><dt className={dt}>Window</dt><dd>{formatDate(a.windowStart)} – {formatDate(a.windowEnd)}</dd></div>}
            {a.auditSeq && <div><dt className={dt}>Audit event</dt><dd>#{a.auditSeq}</dd></div>}
            <div><dt className={dt}>Same person, 30 days</dt><dd>{plural(data!.relatedAlerts30d, 'other alert')}</dd></div>
          </dl>
          {a.details && Object.keys(a.details).length > 0 && (
            <pre className="max-h-40 overflow-auto rounded-xl border border-line bg-surface-2 p-3 font-mono text-[0.6875rem] leading-5 text-fg-muted dark:bg-white/[0.04]">{JSON.stringify(a.details, null, 2)}</pre>
          )}

          <section>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><ClockCounterClockwise size={16} className="text-fg-subtle" />History</h3>
            {data!.history.length === 0 ? <p className="flex items-center gap-2 text-xs text-fg-subtle"><Info size={14} />No review steps yet.</p> : (
              <ol className="space-y-2">
                {data!.history.map((h, i) => (
                  <li key={h.id} className={cx('animate-fade-in rounded-xl border border-line px-3 py-2 text-xs', staggerClass(i))}>
                    <span className="font-semibold capitalize">{h.action}</span> → {h.statusAfter} · {h.actorEmail ?? 'system'} · {formatDate(h.at)}
                    {h.assigneeEmail && h.action === 'assign' && <> · to {h.assigneeEmail}</>}
                    {h.resolution && <> · {human(h.resolution)}</>}
                    {h.note && <p className="mt-1 border-l-2 border-line-strong pl-2 italic text-fg-muted">“{h.note}”</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}

          <section className="space-y-3 rounded-2xl border border-line bg-surface-2/50 p-4 dark:bg-white/[0.02]">
            <Label label="Note" hint="Recorded in the alert history and the audit log"><Textarea rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked, what you found" /></Label>
            <div className="flex flex-wrap items-center gap-2">
              {a.status === 'open' && <Button size="sm" icon={<Checks size={14} />} loading={busy === 'acknowledge'} disabled={!!busy} onClick={() => void act('acknowledge', note.trim() ? { note } : {})}>Acknowledge</Button>}
              {!resolved && (
                <>
                  <span className="flex flex-wrap items-center gap-2">
                    <Select
                      size="sm"
                      aria-label="Assign to"
                      className="w-56"
                      value={assignee}
                      disabled={!reviewers || !!busy}
                      onChange={(e) => setAssignee(e.target.value)}
                    >
                      <option value="">{reviewersError ? 'Reviewers unavailable' : !reviewers ? 'Loading reviewers…' : 'Assign to…'}</option>
                      {(reviewers ?? []).filter((r) => r.id !== a.subjectUserId).map((r) => <option key={r.id} value={r.id}>{r.displayName} ({r.email})</option>)}
                    </Select>
                    <Button size="sm" icon={<UserPlus size={14} />} disabled={!assignee || !!busy} loading={busy === 'assign'} onClick={() => void act('assign', { assigneeId: assignee, ...(note.trim() ? { note } : {}) })}>Assign</Button>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <Select size="sm" aria-label="Resolution" className="w-60" value={resolution} disabled={!!busy} onChange={(e) => setResolution(e.target.value)}>
                      {RESOLUTIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                    </Select>
                    <Button size="sm" variant="primary" icon={<CheckCircle size={14} />} disabled={!noteOk || !!busy} loading={busy === 'resolve'} onClick={() => void act('resolve', { resolution, note })}>Resolve</Button>
                  </span>
                </>
              )}
              {resolved && <Button size="sm" icon={<ArrowCounterClockwise size={14} />} disabled={!noteOk || !!busy} loading={busy === 'reopen'} onClick={() => void act('reopen', { note })}>Reopen</Button>}
              <Button size="sm" variant="ghost" icon={<ChatText size={14} />} disabled={!noteOk || !!busy} loading={busy === 'comment'} onClick={() => void act('comment', { note })}>Comment</Button>
            </div>
            <p className="text-[0.6875rem] text-fg-subtle">Resolving, reopening and comments need a note of at least 5 characters. An alert about you must be resolved by another administrator.</p>
          </section>
        </div>
      )}
    </Modal>
  );
}
