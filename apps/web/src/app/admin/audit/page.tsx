'use client';

import { Fragment, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  CaretDown, CheckCircle, DownloadSimple, Export, FunnelSimple, Globe, Hash, Key, ListMagnifyingGlass, LockKey, LockKeyOpen, Prohibit, SealCheck,
  SignIn, Stack, UploadSimple, UserGear, Files, UsersThree, Desktop, Target, Broadcast, GitCommit, ShieldWarning, ArrowLeft, ArrowRight, FileText, UserCircle,
} from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { useToast } from '@/components/toast';
import { ChainArt, SpotArt } from '@/components/art';
import { ActionIcon, actionMeta } from '@/components/audit-ui';
import { Alert, Avatar, Badge, Button, EmptyState, Input, Label, LoadError, OUTCOME_TONE, PageTitle, Select, SkeletonRows, cx, relativeTime, ButtonLink, IconTile, staggerClass } from '@/components/ui';
import { api, downloadBlob, errorText, formatBytes, formatDate } from '@/lib/api';
import { useLatest } from '@/lib/hooks';
import { localInputToISO } from '@/lib/dates';

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
const chip = 'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-white pointer-coarse:min-h-9 dark:focus-visible:ring-offset-ink-950';
const QUICK: { label: string; action: string; icon: ReactNode }[] = [
  { label: 'Everything', action: '', icon: <Stack size={15} /> },
  { label: 'Downloads', action: 'document.download', icon: <DownloadSimple size={15} /> },
  { label: 'All document activity', action: 'document.', icon: <Files size={15} /> },
  { label: 'Uploads', action: 'document.upload', icon: <UploadSimple size={15} /> },
  { label: 'Permission changes', action: 'access.', icon: <LockKeyOpen size={15} /> },
  { label: 'Group membership', action: 'group.member', icon: <UsersThree size={15} /> },
  { label: 'Sign-ins', action: 'auth.', icon: <SignIn size={15} /> },
  { label: 'Admin actions', action: 'admin.', icon: <UserGear size={15} /> },
];

type Filters = typeof EMPTY;

/**
 * The query string for the API. `from`/`to` come from datetime-local inputs
 * (no offset), so they are read in the admin's own time zone and sent as ISO
 * instants; otherwise the server would read them in its zone (O3).
 */
function query(f: Filters, before?: string): string {
  const p = new URLSearchParams({ limit: '50' });
  for (const [k, v] of Object.entries(f)) {
    if (!v) continue;
    if (k === 'from' || k === 'to') {
      const iso = localInputToISO(v);
      if (iso) p.set(k, iso);
    } else p.set(k, v.trim());
  }
  if (before) p.set('before', before);
  return p.toString();
}

/** Filters from links such as /admin/audit?documentId=… (alerts, approvals). */
function filtersFromUrl(): Filters {
  const q = new URLSearchParams(window.location.search);
  const outcome = q.get('outcome')?.toUpperCase() ?? '';
  return {
    ...EMPTY,
    action: q.get('action') ?? '',
    outcome: ['ALLOWED', 'DENIED', 'FAILED'].includes(outcome) ? outcome : '',
    actor: q.get('actor') ?? '',
    documentId: q.get('documentId') ?? '',
  };
}

/** Document activity and permission changes. Admins see metadata and titles, never file contents. */
export default function AuditPage() {
  const { user: me } = useSession();
  const toast = useToast();
  const [filters, setFilters] = useState(EMPTY);
  const [applied, setApplied] = useState<Filters | null>(null);
  const [events, setEvents] = useState<Event[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [verify, setVerify] = useState<Verify | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const latest = useLatest();
  const isAdmin = me?.role === 'ADMIN';

  // Start from the URL's filters, so a link to one document's history opens filtered.
  useEffect(() => {
    const f = filtersFromUrl();
    setFilters(f);
    setApplied(f);
    if (f.actor || f.documentId) setShowFilters(true);
  }, []);

  // Every load (first page or older) carries the filters it was asked with and
  // a ticket: a newer filter change cancels it, so a slow page for old filters
  // is never shown or appended (O4, X5).
  const load = useCallback(async (f: Filters, before?: string) => {
    const t = latest.begin();
    if (before) setLoadingMore(true);
    else { setLoading(true); setOpen(null); }
    try {
      const r = await api.get<{ events: Event[]; nextBefore: string | null }>(`/admin/audit?${query(f, before)}`, { signal: t.signal });
      if (!t.isLatest()) return;
      setEvents((prev) => {
        if (!before || !prev) return r.events;
        const seen = new Set(prev.map((e) => e.seq));
        return [...prev, ...r.events.filter((e) => !seen.has(e.seq))];
      });
      setNext(r.nextBefore);
      setError(null);
      setLoadError(null);
    } catch (err) {
      if (!t.isLatest()) return;
      if (!before) setLoadError(err);
      setError(errorText(err));
    } finally {
      if (t.isLatest()) { setLoading(false); setLoadingMore(false); }
    }
  }, [latest]);

  useEffect(() => {
    if (isAdmin && applied) void load(applied);
  }, [isAdmin, applied, load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied({ ...filters });
  };
  const apply = (f: Filters) => { setFilters(f); setApplied(f); };
  const cur = applied ?? EMPTY;

  const exportBundle = async () => {
    if (exporting) return;
    setExporting(true);
    setError(null);
    try {
      const r = await downloadBlob('/api/admin/audit/export?fromSeq=1');
      toast(`Evidence bundle saved: ${r.filename} (${formatBytes(r.size)})`, 'success');
    } catch (err) {
      setError(errorText(err, 'Could not export the evidence bundle'));
    } finally {
      setExporting(false);
    }
  };

  const runVerify = async () => {
    if (busy) return;
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

  const advanced = [cur.actor, cur.documentId, cur.from, cur.to].filter(Boolean).length + (cur.outcome && cur.outcome !== 'DENIED' ? 1 : 0) + (QUICK.some((q) => q.action === cur.action) ? 0 : 1);

  if (me && !isAdmin) {
    return (
      <Shell>
        <EmptyState art={<SpotArt tone="amber" icon={<LockKey size={30} />} />} title="Administrators only" action={<ButtonLink href="/" variant="soft" icon={<ArrowLeft size={16} weight="bold" />}>Back to documents</ButtonLink>}>
          The audit log is for administrators. Each document&apos;s own history is on its page.
        </EmptyState>
      </Shell>
    );
  }

  return (
    <Shell>
      <PageTitle
        title="Audit log"
        icon={<ListMagnifyingGlass size={26} />}
        subtitle="Every upload, download, change, deletion, permission change and refused attempt. Append-only and hash-chained in the database."
        actions={<>
          <Button icon={<Export size={18} />} loading={exporting} onClick={() => void exportBundle()}>{exporting ? 'Exporting…' : 'Export evidence bundle'}</Button>
          <Button variant="primary" icon={<SealCheck size={18} />} onClick={() => void runVerify()} loading={busy}>{busy ? 'Verifying…' : 'Verify integrity'}</Button>
        </>}
      />

      <IntegrityPanel verify={verify} busy={busy} onVerify={() => void runVerify()} />

      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Quick filters">
        {QUICK.map((q) => {
          const on = cur.action === q.action;
          return (
            <button
              key={q.label}
              type="button"
              aria-pressed={on}
              // Keeps the actor, document, dates and outcome already chosen.
              onClick={() => apply({ ...cur, action: q.action })}
              className={cx(chip, on ? 'border-transparent bg-brand-gradient text-white shadow-glow' : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:bg-fg/[0.03] hover:text-fg')}
            >
              {q.icon}{q.label}
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={cur.outcome === 'DENIED'}
          onClick={() => apply({ ...cur, outcome: cur.outcome === 'DENIED' ? '' : 'DENIED' })}
          className={cx(chip, cur.outcome === 'DENIED' ? 'border-transparent bg-danger-600 text-white shadow-sm' : 'border-danger-300/60 bg-surface text-danger-700 hover:bg-danger-50 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-300 dark:hover:bg-danger-500/15')}
        >
          <Prohibit size={15} />Refused only
        </button>
        <Button size="sm" variant="ghost" className="ml-auto" icon={<FunnelSimple size={16} />} aria-expanded={showFilters} aria-controls="audit-filters" onClick={() => setShowFilters((s) => !s)}>
          More filters{advanced > 0 && <span className="rounded-md bg-brand-600 px-1.5 text-[0.6875rem] text-white">{advanced}</span>}
          <CaretDown size={12} className={cx('transition-transform duration-200', showFilters && 'rotate-180')} />
        </Button>
      </div>

      <div
        className={cx('grid transition-[grid-template-rows,opacity] duration-200 ease-out', showFilters ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}
        inert={!showFilters || undefined}
      >
        <div className="min-h-0 overflow-hidden">
        <form id="audit-filters" onSubmit={submit} className="mb-5 grid gap-3 rounded-2xl border border-line bg-surface p-4 shadow-soft sm:grid-cols-3 lg:grid-cols-6">
          <Label label="Action starts with"><Input value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} placeholder="document." /></Label>
          <Label label="Outcome">
            <Select value={filters.outcome} onChange={(e) => setFilters({ ...filters, outcome: e.target.value })}>
              <option value="">Any</option><option>ALLOWED</option><option>DENIED</option><option>FAILED</option>
            </Select>
          </Label>
          <Label label="Actor email"><Input value={filters.actor} onChange={(e) => setFilters({ ...filters, actor: e.target.value })} /></Label>
          <Label label="Document id"><Input value={filters.documentId} onChange={(e) => setFilters({ ...filters, documentId: e.target.value })} /></Label>
          <Label label="From (your time)"><Input type="datetime-local" max={filters.to || undefined} value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></Label>
          <Label label="To (your time)"><Input type="datetime-local" min={filters.from || undefined} value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></Label>
          <div className="flex gap-2 sm:col-span-3 lg:col-span-6"><Button type="submit" variant="primary" icon={<FunnelSimple size={16} />} loading={loading && !!events}>Filter</Button><Button type="button" variant="ghost" onClick={() => apply(EMPTY)}>Clear</Button></div>
        </form>
        </div>
      </div>

      {error && !(loadError && !events) && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}

      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
        {!events ? (loadError && !loading ? <LoadError error={loadError} title="Couldn't load the audit log" onRetry={() => applied && void load(applied)} /> : <SkeletonRows rows={8} label="Loading events…" />) : events.length === 0 ? (
          <EmptyState art={<SpotArt icon={<ListMagnifyingGlass size={30} />} />} title="No events match" action={<Button onClick={() => apply(EMPTY)}>Show everything</Button>}>Try a wider time range or another filter.</EmptyState>
        ) : (
          <div aria-busy={loading || undefined} className={cx('overflow-x-auto transition-opacity duration-200', loading && 'opacity-60')}>
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line bg-surface-2/70 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle dark:bg-white/[0.02]">
                <tr>
                  <th className="px-5 py-3">Event</th>
                  <th className="hidden px-4 py-3 md:table-cell">Who</th>
                  <th className="hidden px-4 py-3 lg:table-cell">Target</th>
                  <th className="px-4 py-3">Result</th>
                  <th className="hidden px-4 py-3 sm:table-cell">When</th>
                  <th className="w-8 px-3 py-3"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {events.map((e, i) => {
                  const isOpen = open === e.seq;
                  return (
                    <Fragment key={e.seq}>
                      <tr onClick={() => setOpen(isOpen ? null : e.seq)} className={cx('animate-fade-in cursor-pointer transition-colors hover:bg-fg/[0.03]', staggerClass(i), isOpen && 'bg-brand-50/40 dark:bg-brand-500/5')}>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <ActionIcon action={e.action} outcome={e.outcome} />
                            <div className="min-w-0">
                              <p className="truncate font-semibold">{actionMeta(e.action).label}</p>
                              <p className="truncate font-mono text-[0.6875rem] text-fg-subtle">#{e.seq} · {e.action}</p>
                            </div>
                          </div>
                        </td>
                        <td className="hidden px-4 py-3 md:table-cell">
                          <div className="flex min-w-0 items-center gap-2">
                            <Avatar name={e.actorEmail ?? 'system'} size="xs" />
                            <span className="truncate">{e.actorEmail ?? 'system'}</span>
                          </div>
                        </td>
                        <td className="hidden max-w-[14rem] px-4 py-3 lg:table-cell">
                          {e.documentTitle ? <span className="block truncate font-medium" title={e.documentId ?? ''}>{e.documentTitle}</span> : e.targetType ? <span className="text-fg-subtle">{e.targetType}</span> : <span className="text-fg-subtle">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <Badge dot tone={OUTCOME_TONE[e.outcome]}>{e.outcome === 'ALLOWED' ? 'Allowed' : e.outcome === 'DENIED' ? 'Refused' : 'Failed'}</Badge>
                          {e.reason && <span className="mt-0.5 block max-w-[12rem] truncate text-[0.6875rem] text-fg-subtle">{e.reason.replace(/_/g, ' ')}</span>}
                        </td>
                        <td className="hidden whitespace-nowrap px-4 py-3 text-fg-subtle sm:table-cell" title={formatDate(e.occurredAt)}>{relativeTime(e.occurredAt)}</td>
                        <td className="px-1.5 py-1.5 text-right">
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            aria-controls={`ev-${e.seq}`}
                            aria-label={`${isOpen ? 'Hide' : 'Show'} details of event #${e.seq}`}
                            onClick={(ev) => { ev.stopPropagation(); setOpen(isOpen ? null : e.seq); }}
                            className="relative inline-flex size-9 items-center justify-center rounded-lg text-fg-subtle transition hover:bg-fg/5 hover:text-fg active:bg-fg/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 pointer-coarse:before:absolute pointer-coarse:before:-inset-1"
                          >
                            <CaretDown size={14} weight="bold" className={cx('transition-transform duration-200', isOpen && 'rotate-180')} />
                          </button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr id={`ev-${e.seq}`} className="bg-surface-2/70 dark:bg-white/[0.02]">
                          <td colSpan={6} className="px-5 py-4">
                            <div className="grid animate-pop gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                              <Detail icon={<Globe size={15} />} label="IP address" value={e.ip ?? '—'} mono />
                              <Detail icon={<Desktop size={15} />} label="Browser" value={e.userAgent ?? '—'} />
                              <Detail icon={<Target size={15} />} label="Target" value={`${e.targetType ?? '—'} ${e.targetId ?? ''}`} mono />
                              <Detail icon={<Hash size={15} />} label="Chain hash" value={e.hash} mono />
                            </div>
                            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                              <span className="text-fg-subtle">{formatDate(e.occurredAt)}</span>
                              {e.documentId && (
                                <button type="button" className="inline-flex items-center gap-1 rounded font-medium text-brand-600 underline-offset-2 transition-colors hover:text-brand-700 hover:underline dark:text-brand-300 dark:hover:text-brand-200" onClick={() => apply({ ...EMPTY, documentId: e.documentId! })}><FileText size={14} />All events for this document<ArrowRight size={12} weight="bold" /></button>
                              )}
                              {e.actorEmail && (
                                <button type="button" className="inline-flex min-w-0 items-center gap-1 rounded font-medium text-brand-600 underline-offset-2 transition-colors hover:text-brand-700 hover:underline dark:text-brand-300 dark:hover:text-brand-200" onClick={() => apply({ ...EMPTY, actor: e.actorEmail! })}><UserCircle size={14} className="shrink-0" /><span className="truncate">Everything by {e.actorEmail}</span><ArrowRight size={12} weight="bold" className="shrink-0" /></button>
                              )}
                            </div>
                            {e.details !== null && <pre className="mt-3 overflow-x-auto rounded-xl border border-line bg-surface p-3 font-mono text-[0.6875rem] leading-5 dark:border-white/10 dark:bg-ink-950">{JSON.stringify(e.details, null, 2)}</pre>}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {next && events && applied && <div className="mt-5 text-center"><Button icon={<CaretDown size={16} weight="bold" />} loading={loadingMore} disabled={loading} onClick={() => void load(applied, next)}>Load older events</Button></div>}
    </Shell>
  );
}

function Detail({ icon, label, value, mono }: { icon: ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface p-3">
      <p className="flex items-center gap-1.5 text-fg-subtle">{icon}{label}</p>
      <p className={cx('mt-1 break-all text-fg', mono && 'font-mono text-[0.6875rem]')}>{value}</p>
    </div>
  );
}

function IntegrityPanel({ verify, busy, onVerify }: { verify: Verify | null; busy: boolean; onVerify: () => void }) {
  if (!verify) {
    return (
      <section className="mb-7 grid animate-rise gap-5 overflow-hidden rounded-3xl border border-line bg-surface p-6 shadow-soft md:grid-cols-[1fr_auto]">
        <div>
          <p className="text-[0.9375rem] font-semibold">Three independent protections keep this log honest</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Protect icon={<GitCommit size={18} />} title="Hash chain" text="Each event includes the hash of the one before. Change one and every later hash breaks." />
            <Protect icon={<Key size={18} />} title="Signed every minute" text="A separate key service signs the chain head. The database cannot forge it." />
            <Protect icon={<Broadcast size={18} />} title="Published outside" text="Each signature goes to Sigstore's public log and a GitHub witness." />
          </div>
        </div>
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl bg-surface-2 p-5 dark:bg-white/[0.03]">
          <ChainArt ok className="w-52" />
          <Button variant="soft" icon={<SealCheck size={16} />} onClick={onVerify} loading={busy}>Check it now</Button>
        </div>
      </section>
    );
  }
  return (
    <section className={cx('relative mb-7 animate-pop overflow-hidden rounded-3xl border p-6 shadow-soft', verify.ok ? 'border-success-300/60 bg-gradient-to-br from-success-50 to-surface dark:border-success-500/25 dark:from-success-500/10 dark:to-transparent' : 'border-danger-300/60 bg-gradient-to-br from-danger-50 to-surface dark:border-danger-500/30 dark:from-danger-500/10 dark:to-transparent')}>
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-4">
          <span className={cx('inline-flex size-14 items-center justify-center rounded-2xl text-white shadow-lg', verify.ok ? 'bg-success-500' : 'bg-danger-500')}>
            {verify.ok ? <CheckCircle size={30} weight="fill" /> : <ShieldWarning size={30} weight="fill" />}
          </span>
          <div>
            <p className={cx('text-lg font-semibold', verify.ok ? 'text-success-700 dark:text-success-300' : 'text-danger-700 dark:text-danger-300')}>{verify.ok ? 'Audit trail intact' : 'Audit trail FAILED verification'}</p>
            <p className="text-sm text-fg-muted">{verify.ok ? 'Every event re-hashed in order and every signature checked.' : 'Something in the history was changed or removed.'}</p>
          </div>
        </div>
        <ChainArt ok={verify.ok} className="ml-auto hidden w-56 md:block" />
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Events re-hashed" value={verify.eventsChecked} extra={verify.firstBadSeq && <span className="text-danger-700 dark:text-danger-300">first mismatch at #{verify.firstBadSeq}</span>} />
        <Metric label="Signed checkpoints checked" value={String(verify.checkpointsChecked)} />
        <Metric label="Latest checkpoint" value={verify.latestCheckpoint ? `#${verify.latestCheckpoint.seq}` : '—'} extra={verify.latestCheckpoint && relativeTime(verify.latestCheckpoint.createdAt)} />
      </div>
      {verify.problems.length > 0 && (
        <ul className="mt-4 space-y-1 rounded-xl bg-danger-100/60 p-3 text-sm text-danger-700 dark:bg-danger-500/10 dark:text-danger-300">
          {verify.problems.map((p) => <li key={p} className="flex gap-2"><ShieldWarning size={16} className="mt-0.5 shrink-0" />{p}</li>)}
        </ul>
      )}
      <p className="mt-4 break-all text-xs text-fg-subtle">Signing key ({verify.signingKey.keyId}): <span className="font-mono">{verify.signingKey.publicKey}</span></p>
      <p className="mt-1 text-xs text-fg-subtle">Exported bundles can be checked offline with <code className="rounded bg-fg/[0.06] px-1 font-mono">node tools/verify-audit.mjs bundle.json --key &lt;signing key above&gt; --rekor</code>, without trusting this server.</p>
    </section>
  );
}

function Protect({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="rounded-xl border border-line p-3 transition-colors hover:border-line-strong">
      <IconTile size="sm">{icon}</IconTile>
      <p className="mt-2 text-sm font-semibold">{title}</p>
      <p className="mt-0.5 text-xs leading-5 text-fg-subtle">{text}</p>
    </div>
  );
}

function Metric({ label, value, extra }: { label: string; value: string; extra?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface/70 p-3 backdrop-blur">
      <p className="text-xs text-fg-subtle">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {extra && <p className="text-xs text-fg-subtle">{extra}</p>}
    </div>
  );
}
