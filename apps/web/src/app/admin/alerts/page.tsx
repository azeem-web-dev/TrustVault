'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  BellRinging, Biohazard, Bug, DownloadSimple, Eye, FileText, Info, LockKey, Prohibit, ShareNetwork, ShieldCheck, ShieldWarning, Siren, Warning, WarningOctagon, ArrowSquareOut, ArrowLeft, ListChecks, Pulse, SlidersHorizontal,
} from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import { Alert, Button, Card, EmptyState, Input, Label, LoadError, PageTitle, Segmented, SkeletonRows, StatCard, Textarea, cx, relativeTime, staggerClass, tabPanelProps, ButtonLink, IconTile, SEVERITY_TILE_TONE } from '@/components/ui';
import { api, errorText, formatDate } from '@/lib/api';
import { useLatest } from '@/lib/hooks';
import { AlertQueue, SEV } from './queue';
import { RiskPolicy } from './policy';

interface AlertItem {
  severity: 'critical' | 'high' | 'medium' | 'info';
  kind: string;
  at?: string;
  message: string;
  documentId?: string | null;
  documentTitle?: string | null;
}


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

type Tab = 'queue' | 'live' | 'policy';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function AlertsPage() {
  const { user: me } = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('queue');
  // Escalation emails link to /admin/alerts?alert=<id>.
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('alert');
    if (id && UUID.test(id)) setOpenId(id);
  }, []);

  // The deep link is used once: closing that alert drops ?alert= from the URL,
  // so switching tabs or reloading doesn't open it again (O2).
  const consumeDeepLink = useCallback(() => {
    setOpenId(null);
    if (new URLSearchParams(window.location.search).has('alert')) router.replace('/admin/alerts', { scroll: false });
  }, [router]);

  if (me && me.role !== 'ADMIN') {
    return (
      <Shell>
        <EmptyState art={<SpotArt tone="amber" icon={<LockKey size={30} />} />} title="Administrators only" action={<ButtonLink href="/" variant="soft" icon={<ArrowLeft size={16} weight="bold" />}>Back to documents</ButtonLink>}>
          Alerts are reviewed by administrators.
        </EmptyState>
      </Shell>
    );
  }

  return (
    <Shell>
      <PageTitle
        title="Alerts"
        icon={<BellRinging size={26} />}
        subtitle="Every alert is kept: the queue shows all of them, highest severity first, with who acknowledged, assigned and resolved each one. Rules cover slow extraction over days and weeks, unusual sign-ins, refusals, integrity and malware."
        actions={<Segmented label="Alerts view" idBase="alerts-tab" value={tab} onChange={setTab} options={[{ id: 'queue', label: 'Queue', icon: <ListChecks size={16} /> }, { id: 'live', label: 'Live view', icon: <Pulse size={16} /> }, { id: 'policy', label: 'Thresholds and limits', icon: <SlidersHorizontal size={16} /> }]} />}
      />
      <div key={tab} {...tabPanelProps('alerts-tab', tab)} className="animate-fade-in outline-none">
        {tab === 'queue' && <AlertQueue openId={openId} onDeepLinkClosed={consumeDeepLink} />}
        {tab === 'live' && <LiveAlerts />}
        {tab === 'policy' && <RiskPolicy />}
      </div>
      {tab === 'queue' && <div className="mt-6"><BreakGlass /></div>}
    </Shell>
  );
}

/** The earlier view, computed from the audit log on each visit. Kept for a quick look; the queue is the record. */
function LiveAlerts() {
  const [hours, setHours] = useState('24');
  const [alerts, setAlerts] = useState<AlertItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const latest = useLatest();

  // Old rows stay (dimmed) while another period loads; a slower, older
  // response never replaces a newer one (X5).
  const load = useCallback(async () => {
    const t = latest.begin();
    setError(null);
    setLoading(true);
    try {
      const r = await api.get<{ alerts: AlertItem[] }>(`/admin/alerts?hours=${hours}`, { signal: t.signal });
      if (t.isLatest()) setAlerts(r.alerts);
    } catch (err) {
      if (t.isLatest()) { setAlerts(null); setError(err); }
    } finally {
      if (t.isLatest()) setLoading(false);
    }
  }, [hours, latest]);

  useEffect(() => {
    void load();
  }, [load]);

  const count = (s: AlertItem['severity']) => alerts?.filter((a) => a.severity === s).length ?? '–';

  return (
    <>
      <div className="mb-4 flex justify-end"><Segmented mode="filter" label="Period" value={hours} onChange={setHours} options={RANGES} /></div>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatCard label="Critical" value={count('critical')} icon={<WarningOctagon size={22} weight="fill" />} tone="red" hint="Act now" />
        <StatCard label="High" value={count('high')} icon={<Warning size={22} weight="fill" />} tone="orange" hint="Look today" delay={40} />
        <StatCard label="Medium" value={count('medium')} icon={<Warning size={22} />} tone="amber" hint="Worth a check" delay={80} />
        <StatCard label="Info" value={count('info')} icon={<Info size={22} weight="fill" />} tone="blue" hint="For the record" delay={120} />
      </div>

      <Card title="What to notice" icon={<BellRinging size={20} />} description={`Last ${RANGES.find((r) => r.id === hours)?.label.toLowerCase()}, recomputed now (up to 20 per kind; the queue keeps every alert)`} padded={false}>
        {error && !loading ? <LoadError error={error} title="Couldn't load alerts" onRetry={() => void load()} /> : !alerts ? <SkeletonRows rows={4} label="Loading alerts…" /> : alerts.length === 0 ? (
          <EmptyState art={<SpotArt icon={<ShieldCheck size={30} />} tone="green" />} title="All clear">Nothing unusual in this period.</EmptyState>
        ) : (
          <ul className={cx('divide-y divide-line transition-opacity duration-200', loading && 'opacity-60')} aria-busy={loading || undefined}>
            {alerts.map((a, i) => {
              const s = SEV[a.severity];
              return (
                <li key={`${hours}-${i}`} className={cx('relative flex animate-rise items-start gap-4 px-5 py-4', staggerClass(i))}>
                  <span className={cx('absolute inset-y-3 left-0 w-1 rounded-r-full', s.bar)} />
                  <IconTile tone={SEVERITY_TILE_TONE[a.severity.toUpperCase()] ?? 'slate'}>{kindIcon(a.kind)}</IconTile>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium leading-6">{a.message}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-fg-subtle">
                      <span className="capitalize">{a.kind.replace(/_/g, ' ')}</span>
                      {a.at && <><span>·</span><span title={formatDate(a.at)}>{relativeTime(a.at)}</span></>}
                      {a.documentId && (
                        <><span>·</span><Link className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline dark:text-brand-300" href={`/admin/audit?documentId=${encodeURIComponent(a.documentId)}`}><FileText size={13} />{a.documentTitle ?? a.documentId}<ArrowSquareOut size={12} /></Link></>
                      )}
                    </p>
                  </div>
                  <span className={cx('inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[0.6875rem] font-bold uppercase tracking-wide', s.tile)}>{s.icon}{s.label}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}

function BreakGlass() {
  const toast = useToast();
  const [documentId, setDocumentId] = useState('');
  const [reason, setReason] = useState('');
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const id = documentId.trim();
    if (!UUID.test(id)) { setError('Paste the full document id from the audit log: 36 characters, like 3f2b9c1e-8d4a-4c1b-9e2f-0a1b2c3d4e5f.'); return; }
    setError(null);
    setBusy(true);
    try {
      // Break-glass needs a second administrator (THREATS.md S19): this asks.
      await api.post('/admin/approvals', { action: 'BREAK_GLASS', documentId: id, reason });
      setAsked(true);
      setReason('');
      setDocumentId('');
      toast('Request sent. Another administrator must approve it on the Approvals page.', 'info');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="relative overflow-hidden rounded-2xl border border-warning-300/70 bg-gradient-to-br from-warning-50 via-surface to-surface shadow-soft dark:border-warning-500/30 dark:from-warning-500/10 dark:via-transparent dark:to-transparent">
      <div aria-hidden className="hazard-stripe pointer-events-none absolute inset-x-0 top-0 h-1.5 opacity-80" />
      <div className="p-6">
        <div className="flex flex-wrap items-start gap-4">
          <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-2xl bg-warning-500 text-white shadow-lg ring-4 ring-warning-500/15"><Siren size={26} weight="fill" /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[0.9375rem] font-semibold">Break-glass access</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-fg-muted">
              Administrators cannot open documents. In an emergency (legal hold, incident response) you can ask for one hour of view-only access to a single document: its pages, watermarked with your name, never the original file.
              A second administrator must approve; then you open it from the Approvals page, once, within 24 hours. The owner is emailed when it is approved,
              and the reason is recorded in the audit trail, raised as an alert, and shown in the document&apos;s own history. With only one administrator it is impossible.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-100 px-3 py-1 text-xs font-semibold text-warning-700 dark:bg-warning-500/20 dark:text-warning-300"><ShieldWarning size={14} />Audited and alerted</span>
        </div>
        <form onSubmit={submit} className="mt-5 grid gap-4 sm:grid-cols-3">
          <Label label="Document id" hint="The 36-character id from the audit log.">
            <Input
              required
              value={documentId}
              onChange={(e) => setDocumentId(e.target.value)}
              placeholder="from the audit log"
              title="A document id: 36 characters, e.g. 3f2b9c1e-8d4a-4c1b-9e2f-0a1b2c3d4e5f"
              spellCheck={false}
              autoComplete="off"
              className="font-mono"
            />
          </Label>
          <div className="sm:col-span-2">
            <Label label="Reason (at least 20 characters)" hint={`${reason.length}/500`}><Textarea rows={2} required minLength={20} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Legal hold requested by counsel, ticket LEG-142" /></Label>
          </div>
          <div><Button type="submit" variant="danger" icon={<Siren size={16} />} loading={busy}>Ask for emergency access</Button></div>
        </form>
        {error && <div className="mt-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}
        {asked && (
          <div className="mt-4"><Alert tone="amber" title="Waiting for a second administrator">Once another admin approves, open the access from <Link className="font-semibold underline" href="/admin/approvals">Approvals</Link>.</Alert></div>
        )}
      </div>
    </section>
  );
}
