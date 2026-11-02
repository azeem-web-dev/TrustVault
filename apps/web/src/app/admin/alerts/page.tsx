'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import {
  BellRinging, Biohazard, Bug, DownloadSimple, Eye, FileText, Fire, Info, LockKey, Prohibit, ShareNetwork, ShieldCheck, ShieldWarning, Siren, Warning, WarningOctagon, ArrowSquareOut,
} from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import { Alert, Button, Card, EmptyState, Input, Label, PageTitle, Segmented, SkeletonRows, StatCard, Textarea, cx, relativeTime } from '@/components/ui';
import { api, errorText, formatDate } from '@/lib/api';

interface AlertItem {
  severity: 'critical' | 'high' | 'medium' | 'info';
  kind: string;
  at?: string;
  message: string;
  documentId?: string | null;
  documentTitle?: string | null;
}

const SEV = {
  critical: { label: 'Critical', bar: 'bg-red-600', tile: 'bg-red-600 text-white', text: 'text-red-700 dark:text-red-300', icon: <WarningOctagon size={18} weight="fill" /> },
  high: { label: 'High', bar: 'bg-orange-500', tile: 'bg-orange-500 text-white', text: 'text-orange-700 dark:text-orange-300', icon: <Warning size={18} weight="fill" /> },
  medium: { label: 'Medium', bar: 'bg-amber-400', tile: 'bg-amber-400 text-amber-950', text: 'text-amber-700 dark:text-amber-300', icon: <Warning size={18} /> },
  info: { label: 'Info', bar: 'bg-sky-500', tile: 'bg-sky-500 text-white', text: 'text-sky-700 dark:text-sky-300', icon: <Info size={18} weight="fill" /> },
} as const;

function kindIcon(kind: string): ReactNode {
  if (kind.includes('malware')) return <Biohazard size={20} />;
  if (kind.includes('rescan')) return <Bug size={20} />;
  if (kind.includes('break')) return <Siren size={20} />;
  if (kind.includes('integrity') || kind.includes('tamper')) return <ShieldWarning size={20} />;
  if (kind.includes('page_view')) return <Eye size={20} />;
  if (kind.includes('download')) return <DownloadSimple size={20} />;
  if (kind.includes('external') || kind.includes('share')) return <ShareNetwork size={20} />;
  if (kind.includes('revok')) return <Prohibit size={20} />;
  if (kind.includes('login') || kind.includes('sign') || kind.includes('locked')) return <LockKey size={20} />;
  if (kind.includes('denied') || kind.includes('refus')) return <Prohibit size={20} />;
  return <BellRinging size={20} />;
}

const RANGES = [
  { id: '1', label: 'Hour' },
  { id: '24', label: '24 hours' },
  { id: '168', label: '7 days' },
  { id: '720', label: '30 days' },
];

export default function AlertsPage() {
  const [hours, setHours] = useState('24');
  const [alerts, setAlerts] = useState<AlertItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ alerts: AlertItem[] }>(`/admin/alerts?hours=${hours}`);
      setAlerts(r.alerts);
    } catch (err) {
      setError(errorText(err));
    }
  }, [hours]);

  useEffect(() => {
    setAlerts(null);
    void load();
  }, [load]);

  const count = (s: AlertItem['severity']) => alerts?.filter((a) => a.severity === s).length ?? '–';

  return (
    <Shell>
      <PageTitle
        title="Alerts"
        icon={<BellRinging size={26} />}
        subtitle="Activity worth a second look, computed from the audit log: repeated refusals, access attempts after revocation, bulk downloads, external sharing, break-glass use, blocked sign-ins, malware, and any integrity failure."
        actions={<Segmented value={hours} onChange={setHours} options={RANGES} />}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatCard label="Critical" value={count('critical')} icon={<WarningOctagon size={22} />} tone="red" hint="Act now" />
        <StatCard label="High" value={count('high')} icon={<Warning size={22} />} tone="amber" hint="Look today" delay={60} />
        <StatCard label="Medium" value={count('medium')} icon={<Fire size={22} />} tone="violet" hint="Worth a check" delay={120} />
        <StatCard label="Info" value={count('info')} icon={<Info size={22} />} tone="blue" hint="For the record" delay={180} />
      </div>

      {error && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}

      <Card title="What to notice" icon={<BellRinging size={20} />} description={`Last ${RANGES.find((r) => r.id === hours)?.label.toLowerCase()}`} padded={false}>
        {!alerts ? <SkeletonRows rows={4} /> : alerts.length === 0 ? (
          <EmptyState art={<SpotArt icon={<ShieldCheck size={30} />} tone="green" />} title="All clear">Nothing unusual in this period.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-white/[0.05]">
            {alerts.map((a, i) => {
              const s = SEV[a.severity];
              return (
                <li key={i} style={{ animationDelay: `${i * 30}ms` }} className="relative flex animate-rise items-start gap-4 px-5 py-4">
                  <span className={cx('absolute inset-y-3 left-0 w-1 rounded-r-full', s.bar)} />
                  <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300">{kindIcon(a.kind)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium leading-6">{a.message}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="capitalize">{a.kind.replace(/_/g, ' ')}</span>
                      {a.at && <><span>·</span><span title={formatDate(a.at)}>{relativeTime(a.at)}</span></>}
                      {a.documentId && (
                        <><span>·</span><Link className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline dark:text-brand-300" href="/admin/audit"><FileText size={13} />{a.documentTitle ?? a.documentId}<ArrowSquareOut size={12} /></Link></>
                      )}
                    </p>
                  </div>
                  <span className={cx('inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide', s.tile)}>{s.icon}{s.label}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <div className="mt-6"><BreakGlass onDone={load} /></div>
    </Shell>
  );
}

function BreakGlass({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [documentId, setDocumentId] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<{ documentId: string; title: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api.post<{ documentId: string; title: string; expiresAt: string }>('/admin/break-glass', { documentId: documentId.trim(), reason });
      setResult(r);
      setReason('');
      toast('Emergency access granted for one hour. This was alerted.', 'info');
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="relative overflow-hidden rounded-2xl border border-amber-300/70 bg-gradient-to-br from-amber-50 via-white to-white shadow-soft dark:border-amber-500/30 dark:from-amber-500/10 dark:via-transparent dark:to-transparent">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1.5 bg-[repeating-linear-gradient(-45deg,#f59e0b_0_12px,#1f2937_12px_24px)] opacity-80" />
      <div className="p-6">
        <div className="flex flex-wrap items-start gap-4">
          <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-2xl bg-amber-500 text-white shadow-lg"><Siren size={26} /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">Break-glass access</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-300">
              Administrators cannot open documents. In an emergency (legal hold, incident response) you can take one hour of view-only access to a single document: its pages, watermarked with your name, never the original file.
              The reason is recorded in the audit trail, raised as an alert, and shown in the document&apos;s own history to its owner.
            </p>
          </div>
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">Audited and alerted</span>
        </div>
        <form onSubmit={submit} className="mt-5 grid gap-4 sm:grid-cols-3">
          <Label label="Document id"><Input required value={documentId} onChange={(e) => setDocumentId(e.target.value)} placeholder="from the audit log" /></Label>
          <div className="sm:col-span-2">
            <Label label="Reason (at least 20 characters)" hint={`${reason.length}/500`}><Textarea rows={2} required minLength={20} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Legal hold requested by counsel, ticket LEG-142" /></Label>
          </div>
          <div><Button type="submit" variant="danger" icon={<Siren size={16} />} loading={busy}>Take emergency access</Button></div>
        </form>
        {error && <div className="mt-4"><Alert>{error}</Alert></div>}
        {result && (
          <div className="mt-4"><Alert tone="amber" title="Emergency access granted">Access to &quot;{result.title}&quot; until {formatDate(result.expiresAt)}. <Link className="font-semibold underline" href={`/documents/${result.documentId}`}>Open document</Link></Alert></div>
        )}
      </div>
    </section>
  );
}
