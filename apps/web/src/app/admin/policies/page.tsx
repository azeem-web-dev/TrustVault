'use client';

import { useCallback, useEffect, useState } from 'react';
import { Clock, GlobeHemisphereWest, ShieldCheck, Trash } from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, Input, Label, PageTitle, Select, Textarea } from '@/components/ui';
import { api, errorText, formatDate } from '@/lib/api';
import { DAY_SHORT, describeWindow, type WindowSpec } from '@/components/access-policy';

interface RolePolicy { role: 'OWNER' | 'VIEWER' | 'EXTERNAL'; window: WindowSpec | null; networks: string[] | null; updatedBy: string; updatedAt: string }
const ROLES = [
  { id: 'VIEWER', label: 'Viewers' },
  { id: 'EXTERNAL', label: 'External partners' },
  { id: 'OWNER', label: 'Document owners (on documents shared with them; never their own)' },
] as const;

/**
 * Organisation-wide rules per role (THREATS.md P4, P5-P7). They narrow every
 * share given to people with that role; owners cannot lift them. Network
 * rules check the network, not the device: see the warning below.
 */
export default function RolePoliciesPage() {
  const toast = useToast();
  const [rows, setRows] = useState<RolePolicy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<RolePolicy['role']>('EXTERNAL');
  const [useWindow, setUseWindow] = useState(true);
  const [w, setW] = useState<WindowSpec>({ days: [1, 2, 3, 4, 5], start: '08:00', end: '19:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
  const [networks, setNetworks] = useState('');

  const load = useCallback(() => api.get<{ policies: RolePolicy[] }>('/admin/access-policies').then((r) => setRows(r.policies)).catch((e) => setError(errorText(e))), []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setError(null);
    const list = networks.split(/[\s,]+/).filter(Boolean);
    try {
      await api.put(`/admin/access-policies/${role}`, { window: useWindow ? w : null, networks: list.length ? list : null });
      toast('Saved. It applies from the next request.');
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const clear = async (r: RolePolicy['role']) => {
    try {
      await api.delete(`/admin/access-policies/${r}`);
      toast('Rules removed');
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Shell>
      <PageTitle title="Access rules by role" icon={<ShieldCheck size={26} />} subtitle="Working hours and allowed networks for everyone with a role, on top of every share they hold. Owners cannot lift these with an exception." />
      {error && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}
      <div className="mb-4"><Alert tone="amber" title="A network is not a device">An IP allowlist checks where a request comes from, not what is making it. A stolen password used over the office VPN passes it, and people on mobile networks or at home fail it. Use it together with MFA and short shares, never as the only control. Managed-device checks (client certificates from your MDM) are a documented design, not built yet.</Alert></div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Set rules" icon={<Clock size={20} />}>
          <div className="space-y-4">
            <Label label="Role">
              <Select value={role} onChange={(e) => setRole(e.target.value as RolePolicy['role'])}>
                {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </Select>
            </Label>
            <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={useWindow} onChange={(e) => setUseWindow(e.target.checked)} />Only during these hours</label>
            {useWindow && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1">
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                    <button key={d} type="button" aria-pressed={w.days.includes(d)} className={`rounded-lg border px-2.5 py-1 text-xs ${w.days.includes(d) ? 'border-brand-400 bg-brand-50 font-semibold dark:bg-brand-500/10' : 'border-slate-200 dark:border-white/10'}`}
                      onClick={() => { const days = w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d].sort((a, b) => a - b); if (days.length) setW({ ...w, days }); }}>{DAY_SHORT[d]}</button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Label label="From"><Input type="time" value={w.start} onChange={(e) => setW({ ...w, start: e.target.value })} /></Label>
                  <Label label="Until"><Input type="time" value={w.end} onChange={(e) => setW({ ...w, end: e.target.value })} /></Label>
                  <Label label="Time zone"><Input value={w.timeZone} onChange={(e) => setW({ ...w, timeZone: e.target.value.trim() })} /></Label>
                </div>
              </div>
            )}
            <Label label="Allowed networks (optional)" hint="CIDR ranges, one per line, IPv4 or IPv6. Empty: any network.">
              <Textarea rows={3} value={networks} onChange={(e) => setNetworks(e.target.value)} placeholder={'203.0.113.0/24\n2001:db8::/32'} />
            </Label>
            <Button variant="primary" onClick={() => void save()} disabled={!useWindow && !networks.trim()}>Save rules</Button>
          </div>
        </Card>

        <Card title="In force" icon={<GlobeHemisphereWest size={20} />}>
          {!rows ? null : rows.length === 0 ? <p className="text-sm text-slate-500">No role rules. Shares apply as given.</p> : (
            <ul className="space-y-3 text-sm">
              {rows.map((r) => (
                <li key={r.role} className="flex flex-wrap items-start gap-2">
                  <Badge tone="violet">{r.role}</Badge>
                  <span className="flex-1">
                    {r.window ? describeWindow(r.window) : 'Any time'} · {r.networks ? r.networks.join(', ') : 'any network'}
                    <span className="block text-xs text-slate-500">by {r.updatedBy}, {formatDate(r.updatedAt)}</span>
                  </span>
                  <Button size="sm" variant="ghost" icon={<Trash size={14} />} onClick={() => void clear(r.role)}>Remove</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Shell>
  );
}
