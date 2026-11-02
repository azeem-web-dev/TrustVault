'use client';

import { Fragment, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  CaretDown, CheckCircle, DownloadSimple, Export, FunnelSimple, Globe, Hash, Key, ListMagnifyingGlass, LockKeyOpen, Prohibit, SealCheck,
  SignIn, Stack, UploadSimple, UserGear, Desktop, Target, ArrowClockwise, Broadcast, GitCommit, ShieldWarning,
} from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { ChainArt, SpotArt } from '@/components/art';
import { ActionIcon, actionMeta } from '@/components/audit-ui';
import { Alert, Avatar, Badge, Button, ButtonLink, EmptyState, Input, Label, OUTCOME_TONE, PageTitle, Select, SkeletonRows, cx, relativeTime } from '@/components/ui';
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
const QUICK: { label: string; action: string; icon: ReactNode }[] = [
  { label: 'Everything', action: '', icon: <Stack size={15} /> },
  { label: 'Downloads', action: 'document.download', icon: <DownloadSimple size={15} /> },
  { label: 'Permission changes', action: 'access.', icon: <LockKeyOpen size={15} /> },
  { label: 'Uploads & edits', action: 'document.upload', icon: <UploadSimple size={15} /> },
  { label: 'Sign-ins', action: 'auth.', icon: <SignIn size={15} /> },
  { label: 'Admin actions', action: 'admin.', icon: <UserGear size={15} /> },
];

/** Document activity and permission changes. Admins see metadata and titles, never file contents. */
export default function AuditPage() {
  const [filters, setFilters] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [events, setEvents] = useState<Event[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [verify, setVerify] = useState<Verify | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  const query = useCallback((f: typeof EMPTY, before?: string) => {
    const p = new URLSearchParams({ limit: '50' });
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    if (before) p.set('before', before);
    return p.toString();
  }, []);

  const load = useCallback(async (before?: string) => {
    try {
      const r = await api.get<{ events: Event[]; nextBefore: string | null }>(`/admin/audit?${query(applied, before)}`);
      setEvents((prev) => (before && prev ? [...prev, ...r.events] : r.events));
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
  const apply = (f: typeof EMPTY) => { setFilters(f); setApplied(f); };

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

  const advanced = [applied.outcome, applied.actor, applied.documentId, applied.from, applied.to].filter(Boolean).length + (QUICK.some((q) => q.action === applied.action) ? 0 : 1);

  return (
    <Shell>
      <PageTitle
        title="Audit log"
        icon={<ListMagnifyingGlass size={26} />}
        subtitle="Every upload, download, change, deletion, permission change and refused attempt. Append-only and hash-chained in the database."
        actions={<>
          <ButtonLink href="/api/admin/audit/export?fromSeq=1" icon={<Export size={18} />}>Export evidence bundle</ButtonLink>
          <Button variant="primary" icon={<SealCheck size={18} />} onClick={() => void runVerify()} loading={busy}>{busy ? 'Verifying…' : 'Verify integrity'}</Button>
        </>}
      />

      <IntegrityPanel verify={verify} busy={busy} onVerify={() => void runVerify()} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {QUICK.map((q) => {
          const on = applied.action === q.action;
          return (
            <button
              key={q.label}
              onClick={() => apply({ ...EMPTY, action: q.action, outcome: applied.outcome })}
              className={cx('inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition', on ? 'border-transparent bg-brand-gradient text-white shadow-glow' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900 dark:border-white/10 dark:bg-white/5 dark:text-slate-300 dark:hover:text-white')}
            >
              {q.icon}{q.label}
            </button>
          );
        })}
        <button
          onClick={() => apply({ ...applied, outcome: applied.outcome === 'DENIED' ? '' : 'DENIED' })}
          className={cx('inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition', applied.outcome === 'DENIED' ? 'border-transparent bg-red-600 text-white shadow-sm' : 'border-red-200 bg-white text-red-600 hover:bg-red-50 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300')}
        >
          <Prohibit size={15} />Refused only
        </button>
        <Button size="sm" variant="ghost" className="ml-auto" icon={<FunnelSimple size={16} />} onClick={() => setShowFilters((s) => !s)}>
          More filters{advanced > 0 && <span className="rounded-md bg-brand-600 px-1.5 text-[11px] text-white">{advanced}</span>}
          <CaretDown size={12} className={cx('transition', showFilters && 'rotate-180')} />
        </Button>
      </div>

      {showFilters && (
        <form onSubmit={submit} className="mb-5 grid animate-pop gap-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-soft sm:grid-cols-3 lg:grid-cols-6 dark:border-white/[0.08] dark:bg-white/[0.03]">
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
          <div className="flex gap-2 sm:col-span-3 lg:col-span-6"><Button type="submit" variant="primary" icon={<FunnelSimple size={16} />}>Filter</Button><Button type="button" variant="ghost" onClick={() => apply(EMPTY)}>Clear</Button></div>
        </form>
      )}

      {error && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}

      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-soft dark:border-white/[0.08] dark:bg-white/[0.03]">
        {!events ? <SkeletonRows rows={8} /> : events.length === 0 ? (
          <EmptyState art={<SpotArt icon={<ListMagnifyingGlass size={30} />} />} title="No events match" action={<Button onClick={() => apply(EMPTY)}>Show everything</Button>}>Try a wider time range or another filter.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-slate-400">
                <tr>
                  <th className="px-5 py-3">Event</th>
                  <th className="hidden px-4 py-3 md:table-cell">Who</th>
                  <th className="hidden px-4 py-3 lg:table-cell">Target</th>
                  <th className="px-4 py-3">Result</th>
                  <th className="hidden px-4 py-3 sm:table-cell">When</th>
                  <th className="w-8 px-3 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/[0.05]">
                {events.map((e) => {
                  const isOpen = open === e.seq;
                  return (
                    <Fragment key={e.seq}>
                      <tr onClick={() => setOpen(isOpen ? null : e.seq)} className={cx('cursor-pointer transition hover:bg-slate-50 dark:hover:bg-white/[0.03]', isOpen && 'bg-brand-50/40 dark:bg-brand-500/5')}>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <ActionIcon action={e.action} outcome={e.outcome} />
                            <div className="min-w-0">
                              <p className="truncate font-semibold">{actionMeta(e.action).label}</p>
                              <p className="truncate font-mono text-[11px] text-slate-400">#{e.seq} · {e.action}</p>
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
                          {e.documentTitle ? <span className="block truncate font-medium" title={e.documentId ?? ''}>{e.documentTitle}</span> : e.targetType ? <span className="text-slate-500">{e.targetType}</span> : <span className="text-slate-400">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <Badge dot tone={OUTCOME_TONE[e.outcome]}>{e.outcome === 'ALLOWED' ? 'Allowed' : e.outcome === 'DENIED' ? 'Refused' : 'Failed'}</Badge>
                          {e.reason && <span className="mt-0.5 block max-w-[12rem] truncate text-[11px] text-slate-500">{e.reason.replace(/_/g, ' ')}</span>}
                        </td>
                        <td className="hidden whitespace-nowrap px-4 py-3 text-slate-500 sm:table-cell dark:text-slate-400" title={formatDate(e.occurredAt)}>{relativeTime(e.occurredAt)}</td>
                        <td className="px-3 py-3 text-slate-400"><CaretDown size={14} className={cx('transition', isOpen && 'rotate-180')} /></td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-slate-50/70 dark:bg-white/[0.02]">
                          <td colSpan={6} className="px-5 py-4">
                            <div className="grid animate-pop gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                              <Detail icon={<Globe size={15} />} label="IP address" value={e.ip ?? '—'} mono />
                              <Detail icon={<Desktop size={15} />} label="Browser" value={e.userAgent ?? '—'} />
                              <Detail icon={<Target size={15} />} label="Target" value={`${e.targetType ?? '—'} ${e.targetId ?? ''}`} mono />
                              <Detail icon={<Hash size={15} />} label="Chain hash" value={e.hash} mono />
                            </div>
                            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                              <span className="text-slate-500">{formatDate(e.occurredAt)}</span>
                              {e.documentId && (
                                <button className="font-medium text-brand-600 hover:underline dark:text-brand-300" onClick={() => apply({ ...EMPTY, documentId: e.documentId! })}>All events for this document →</button>
                              )}
                              {e.actorEmail && (
                                <button className="font-medium text-brand-600 hover:underline dark:text-brand-300" onClick={() => apply({ ...EMPTY, actor: e.actorEmail! })}>Everything by {e.actorEmail} →</button>
                              )}
                            </div>
                            {e.details !== null && <pre className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white p-3 font-mono text-[11px] leading-5 dark:border-white/10 dark:bg-ink-950">{JSON.stringify(e.details, null, 2)}</pre>}
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
      {next && <div className="mt-5 text-center"><Button icon={<ArrowClockwise size={16} />} onClick={() => void load(next)}>Load older events</Button></div>}
    </Shell>
  );
}

function Detail({ icon, label, value, mono }: { icon: ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200/80 bg-white p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <p className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">{icon}{label}</p>
      <p className={cx('mt-1 break-all text-slate-800 dark:text-slate-200', mono && 'font-mono text-[11px]')}>{value}</p>
    </div>
  );
}

function IntegrityPanel({ verify, busy, onVerify }: { verify: Verify | null; busy: boolean; onVerify: () => void }) {
  if (!verify) {
    return (
      <section className="mb-7 grid animate-rise gap-5 overflow-hidden rounded-3xl border border-slate-200/80 bg-white p-6 shadow-soft md:grid-cols-[1fr_auto] dark:border-white/[0.08] dark:bg-white/[0.03]">
        <div>
          <p className="text-[15px] font-semibold">Three independent protections keep this log honest</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Protect icon={<GitCommit size={18} />} title="Hash chain" text="Each event includes the hash of the one before. Change one and every later hash breaks." />
            <Protect icon={<Key size={18} />} title="Signed every minute" text="A separate key service signs the chain head. The database cannot forge it." />
            <Protect icon={<Broadcast size={18} />} title="Published outside" text="Each signature goes to Sigstore's public log and a GitHub witness." />
          </div>
        </div>
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl bg-slate-50 p-5 dark:bg-white/[0.03]">
          <ChainArt ok className="w-52" />
          <Button variant="soft" icon={<SealCheck size={16} />} onClick={onVerify} loading={busy}>Check it now</Button>
        </div>
      </section>
    );
  }
  return (
    <section className={cx('relative mb-7 animate-pop overflow-hidden rounded-3xl border p-6 shadow-soft', verify.ok ? 'border-emerald-200 bg-gradient-to-br from-emerald-50 to-white dark:border-emerald-500/25 dark:from-emerald-500/10 dark:to-transparent' : 'border-red-200 bg-gradient-to-br from-red-50 to-white dark:border-red-500/30 dark:from-red-500/10 dark:to-transparent')}>
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-4">
          <span className={cx('inline-flex size-14 items-center justify-center rounded-2xl text-white shadow-lg', verify.ok ? 'bg-emerald-500' : 'bg-red-500')}>
            {verify.ok ? <CheckCircle size={30} weight="fill" /> : <ShieldWarning size={30} weight="fill" />}
          </span>
          <div>
            <p className={cx('text-lg font-semibold', verify.ok ? 'text-emerald-800 dark:text-emerald-200' : 'text-red-800 dark:text-red-200')}>{verify.ok ? 'Audit trail intact' : 'Audit trail FAILED verification'}</p>
            <p className="text-sm text-slate-600 dark:text-slate-300">{verify.ok ? 'Every event re-hashed in order and every signature checked.' : 'Something in the history was changed or removed.'}</p>
          </div>
        </div>
        <ChainArt ok={verify.ok} className="ml-auto hidden w-56 md:block" />
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Events re-hashed" value={verify.eventsChecked} extra={verify.firstBadSeq && <span className="text-red-600">first mismatch at #{verify.firstBadSeq}</span>} />
        <Metric label="Signed checkpoints checked" value={String(verify.checkpointsChecked)} />
        <Metric label="Latest checkpoint" value={verify.latestCheckpoint ? `#${verify.latestCheckpoint.seq}` : '—'} extra={verify.latestCheckpoint && relativeTime(verify.latestCheckpoint.createdAt)} />
      </div>
      {verify.problems.length > 0 && (
        <ul className="mt-4 space-y-1 rounded-xl bg-red-100/60 p-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">
          {verify.problems.map((p) => <li key={p} className="flex gap-2"><ShieldWarning size={16} className="mt-0.5 shrink-0" />{p}</li>)}
        </ul>
      )}
      <p className="mt-4 break-all text-xs text-slate-500 dark:text-slate-400">Signing key ({verify.signingKey.keyId}): <span className="font-mono">{verify.signingKey.publicKey}</span></p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Exported bundles can be checked offline with <code className="rounded bg-white/70 px-1 font-mono dark:bg-white/10">node tools/verify-audit.mjs bundle.json --rekor</code>, without trusting this server.</p>
    </section>
  );
}

function Protect({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="rounded-xl border border-slate-100 p-3 dark:border-white/[0.06]">
      <span className="inline-flex size-8 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">{icon}</span>
      <p className="mt-2 text-sm font-semibold">{title}</p>
      <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{text}</p>
    </div>
  );
}

function Metric({ label, value, extra }: { label: string; value: string; extra?: ReactNode }) {
  return (
    <div className="rounded-xl border border-white/60 bg-white/70 p-3 backdrop-blur dark:border-white/10 dark:bg-white/5">
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {extra && <p className="text-xs text-slate-500">{extra}</p>}
    </div>
  );
}
