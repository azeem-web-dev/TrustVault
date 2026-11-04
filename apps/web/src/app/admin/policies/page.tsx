'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Briefcase, Clock, Eye, Globe, GlobeHemisphereWest, LockKey, PencilSimple, ShieldCheck, Trash, WifiHigh, ArrowLeft } from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import { Alert, Badge, Button, Card, EmptyState, Input, Label, LoadError, PageTitle, Select, SkeletonRows, Switch, Textarea, cx, staggerClass, useConfirm, type Tone, ButtonLink, IconTile } from '@/components/ui';
import { api, errorText, formatDate } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { DAY_SHORT, describeWindow, type WindowSpec } from '@/components/access-policy';

type PolicyRole = 'OWNER' | 'VIEWER' | 'EXTERNAL';
interface RolePolicy { role: PolicyRole; window: WindowSpec | null; networks: string[] | null; updatedBy: string; updatedAt: string }
const ROLES: { id: PolicyRole; label: string; short: string; tone: Tone; icon: ReactNode }[] = [
  { id: 'VIEWER', label: 'Viewers', short: 'Viewers', tone: 'green', icon: <Eye size={11} /> },
  { id: 'EXTERNAL', label: 'External partners', short: 'External partners', tone: 'amber', icon: <Globe size={11} /> },
  { id: 'OWNER', label: 'Document owners (on documents shared with them; never their own)', short: 'Document owners', tone: 'blue', icon: <Briefcase size={11} /> },
];
const roleInfo = (r: PolicyRole) => ROLES.find((x) => x.id === r)!;

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const defaultWindow = (): WindowSpec => ({ days: [1, 2, 3, 4, 5], start: '08:00', end: '19:00', timeZone: localZone() });

/** True when the browser knows this IANA zone (the API checks the same names). */
function validZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Organisation-wide rules per role (THREATS.md P4, P5-P7). They narrow every
 * share given to people with that role; owners cannot lift them. Network
 * rules check the network, not the device: see the warning below.
 */
export default function RolePoliciesPage() {
  const { user: me } = useSession();
  const toast = useToast();
  const [rows, setRows] = useState<RolePolicy[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<PolicyRole>('EXTERNAL');
  const [useWindow, setUseWindow] = useState(true);
  const [w, setW] = useState<WindowSpec>(defaultWindow);
  const [networks, setNetworks] = useState('');
  const [lastDayHint, setLastDayHint] = useState(false);
  const { busy, run } = useAction();
  const [confirm, confirmDialog] = useConfirm();

  const zones = useMemo(() => {
    try { return Intl.supportedValuesOf('timeZone'); } catch { return [] as string[]; }
  }, []);

  /** Puts a role's rules in force into the form, or the defaults when it has none (G4). */
  const fill = useCallback((r: PolicyRole, list: RolePolicy[] | null) => {
    const p = list?.find((x) => x.role === r);
    setRole(r);
    setUseWindow(p ? !!p.window : true);
    setW(p?.window ?? defaultWindow());
    setNetworks(p?.networks?.join('\n') ?? '');
    setLastDayHint(false);
  }, []);

  const load = useCallback(async (opts?: { fillRole?: PolicyRole }) => {
    try {
      const r = await api.get<{ policies: RolePolicy[] }>('/admin/access-policies');
      setRows(r.policies);
      setLoadError(null);
      if (opts?.fillRole) fill(opts.fillRole, r.policies);
    } catch (e) {
      setLoadError(e);
      setError(errorText(e));
    }
  }, [fill]);

  const isAdmin = me?.role === 'ADMIN';
  useEffect(() => {
    if (isAdmin) void load({ fillRole: 'EXTERNAL' });
  }, [isAdmin, load]);

  const retry = async () => {
    setRetrying(true);
    setError(null);
    try { await load({ fillRole: role }); } finally { setRetrying(false); }
  };

  const existing = rows?.find((r) => r.role === role);
  const tzOk = !useWindow || validZone(w.timeZone);
  const timesOk = !useWindow || (!!w.start && !!w.end);

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!tzOk || !timesOk) return;
    const list = networks.split(/[\s,]+/).filter(Boolean);
    void run('save', async () => {
      setError(null);
      try {
        await api.put(`/admin/access-policies/${role}`, { window: useWindow ? w : null, networks: list.length ? list : null });
        toast('Saved. It applies from the next request.');
        await load();
      } catch (err) {
        setError(errorText(err));
      }
    });
  };

  const clear = async (r: PolicyRole) => {
    const ok = await confirm({
      title: `Remove the rules for ${roleInfo(r).short.toLowerCase()}?`,
      body: 'Their shares then apply at any time and from any network, as each share was given. This takes effect on their next request.',
      confirmLabel: 'Remove rules',
      cancelLabel: 'Keep',
      danger: true,
      icon: <Trash size={20} />,
    });
    if (!ok) return;
    await run(`clear:${r}`, async () => {
      setError(null);
      try {
        await api.delete(`/admin/access-policies/${r}`);
        toast('Rules removed');
        await load();
        if (r === role) fill(r, null);
      } catch (err) {
        setError(errorText(err));
      }
    });
  };

  const toggleDay = (d: number) => {
    const days = w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d].sort((a, b) => a - b);
    if (!days.length) { setLastDayHint(true); return; }
    setLastDayHint(false);
    setW({ ...w, days });
  };

  if (me && !isAdmin) {
    return (
      <Shell>
        <EmptyState art={<SpotArt tone="amber" icon={<LockKey size={30} />} />} title="Administrators only" action={<ButtonLink href="/" variant="soft" icon={<ArrowLeft size={16} weight="bold" />}>Back to documents</ButtonLink>}>
          Access rules are set by administrators.
        </EmptyState>
      </Shell>
    );
  }

  return (
    <Shell>
      <PageTitle title="Access rules by role" icon={<ShieldCheck size={26} />} subtitle="Working hours and allowed networks for everyone with a role, on top of every share they hold. Owners cannot lift these with an exception." />
      {error && rows && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}
      <div className="mb-4"><Alert tone="amber" title="A network is not a device">An IP allowlist checks where a request comes from, not what is making it. A stolen password used over the office VPN passes it, and people on mobile networks or at home fail it. Use it together with MFA and short shares, never as the only control. Managed-device checks (client certificates from your MDM) are a documented design, not built yet.</Alert></div>

      {!rows && loadError ? (
        <Card><LoadError error={loadError} title="Couldn't load the access rules" onRetry={() => void retry()} retrying={retrying} /></Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title={existing ? 'Update rules' : 'Set rules'} icon={<Clock size={20} />} description={existing ? `Editing the rules in force for ${roleInfo(role).short.toLowerCase()}.` : undefined}>
            <form onSubmit={save} className="space-y-5">
              <Label label="Role">
                <Select value={role} disabled={!rows || !!busy} onChange={(e) => fill(e.target.value as PolicyRole, rows)}>
                  {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}{rows?.some((x) => x.role === r.id) ? ' · rules in force' : ''}</option>)}
                </Select>
              </Label>
              <Switch checked={useWindow} onChange={setUseWindow} label="Only during these hours" description="Outside these hours their shares do not open." />
              {useWindow && (
                <div className="animate-fade-in space-y-3">
                  <div>
                    <p id="policy-days" className="mb-1.5 text-[0.8125rem] font-medium text-fg-muted">Days</p>
                    <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="policy-days">
                      {[1, 2, 3, 4, 5, 6, 7].map((d) => {
                        const on = w.days.includes(d);
                        return (
                          <button
                            key={d}
                            type="button"
                            aria-pressed={on}
                            onClick={() => toggleDay(d)}
                            className={cx(
                              'inline-flex min-h-9 min-w-11 items-center justify-center rounded-lg border px-3 text-xs transition duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 pointer-coarse:min-h-11',
                              on
                                ? 'border-brand-400 bg-brand-50 font-semibold text-brand-700 dark:border-brand-400/60 dark:bg-brand-500/15 dark:text-brand-200'
                                : 'border-line text-fg-muted hover:border-line-strong hover:bg-fg/[0.03] hover:text-fg',
                            )}
                          >
                            {DAY_SHORT[d]}
                          </button>
                        );
                      })}
                    </div>
                    {lastDayHint && <p role="status" className="mt-1.5 animate-fade-in text-xs text-warning-700 dark:text-warning-300">Keep at least one day. To allow any time, turn off “Only during these hours”.</p>}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-[auto_auto_1fr]">
                    <Label label="From"><Input type="time" required value={w.start} onChange={(e) => setW({ ...w, start: e.target.value })} /></Label>
                    <Label label="Until"><Input type="time" required value={w.end} onChange={(e) => setW({ ...w, end: e.target.value })} /></Label>
                    <Label label="Time zone" hint={tzOk ? undefined : <span className="text-danger-600 dark:text-danger-300">Pick a time zone from the list, e.g. Europe/London.</span>}>
                      <Input
                        list="policy-time-zones"
                        required
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={!tzOk || undefined}
                        placeholder="Europe/London"
                        value={w.timeZone}
                        onChange={(e) => setW({ ...w, timeZone: e.target.value.trim() })}
                      />
                    </Label>
                    <datalist id="policy-time-zones">
                      {zones.map((z) => <option key={z} value={z} />)}
                    </datalist>
                  </div>
                </div>
              )}
              <Label label="Allowed networks (optional)" hint="CIDR ranges, one per line, IPv4 or IPv6. Empty: any network.">
                <Textarea rows={3} value={networks} onChange={(e) => setNetworks(e.target.value)} placeholder={'203.0.113.0/24\n2001:db8::/32'} spellCheck={false} />
              </Label>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" variant="primary" icon={<ShieldCheck size={16} />} loading={busy === 'save'} disabled={!rows || (!!busy && busy !== 'save') || (!useWindow && !networks.trim()) || !tzOk || !timesOk}>
                  {existing ? 'Update rules' : 'Save rules'}
                </Button>
                {!useWindow && !networks.trim() && <span className="text-xs text-fg-subtle">Set hours or networks, or remove the rules instead.</span>}
              </div>
            </form>
          </Card>

          <Card title="In force" icon={<GlobeHemisphereWest size={20} />} padded={false}>
            {!rows ? <SkeletonRows rows={2} label="Loading rules…" /> : rows.length === 0 ? <EmptyState className="py-10" art={<IconTile tone="slate" size="lg"><GlobeHemisphereWest size={22} /></IconTile>} title="No role rules">Shares apply as given, at any time and from any network.</EmptyState> : (
              <ul className="divide-y divide-line text-sm">
                {rows.map((r, i) => {
                  const info = roleInfo(r.role);
                  return (
                    <li key={r.role} className={cx('flex animate-fade-in flex-wrap items-start gap-3 px-5 py-4 transition-colors', staggerClass(i), r.role === role && 'bg-brand-50/40 dark:bg-brand-500/5')}>
                      <Badge tone={info.tone} icon={info.icon}>{info.short}</Badge>
                      <span className="min-w-0 flex-1 space-y-1">
                        <span className="flex items-center gap-1.5"><Clock size={14} className="shrink-0 text-fg-subtle" />{r.window ? describeWindow(r.window) : 'Any time'}</span>
                        <span className="flex items-start gap-1.5"><WifiHigh size={14} className="mt-0.5 shrink-0 text-fg-subtle" /><span className="break-all">{r.networks ? r.networks.join(', ') : 'Any network'}</span></span>
                        <span className="block text-xs text-fg-subtle">by {r.updatedBy}, {formatDate(r.updatedAt)}</span>
                      </span>
                      <span className="flex gap-1">
                        <Button size="sm" variant="ghost" icon={<PencilSimple size={14} />} disabled={!!busy || r.role === role} onClick={() => fill(r.role, rows)}>Edit</Button>
                        <Button size="sm" variant="ghost" icon={<Trash size={14} />} loading={busy === `clear:${r.role}`} disabled={!!busy && busy !== `clear:${r.role}`} onClick={() => void clear(r.role)} className="hover:text-danger-600 dark:hover:text-danger-300">Remove</Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      )}
      {confirmDialog}
    </Shell>
  );
}
