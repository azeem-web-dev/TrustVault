'use client';

// Access policies on shares (THREATS.md P1-P12): conditions in the share
// sheet, badges on each share, and the download-approval request card a
// recipient sees. The API and the database enforce all of it; this is only
// how people set and see it.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CheckCircle, Clock, DownloadSimple, GlobeHemisphereWest, HandPalm, Lightning, ShieldCheck } from '@phosphor-icons/react';
import { Badge, Button, ButtonLink, Card, Input, Label, Select, Textarea, cx } from './ui';
import { api, errorText, formatDate } from '@/lib/api';

export interface WindowSpec { days: number[]; start: string; end: string; timeZone: string }
export interface SharePolicy { downloadApproval: boolean; approverId?: string | null; window?: WindowSpec | null; networks?: string[] | null }
export interface SharePolicyView { downloadApproval: boolean; approver: { id: string; name: string } | null; window: WindowSpec | null; networks: string[] | null }

export const DAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const browserZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};

export function describeWindow(w: WindowSpec): string {
  const days = w.days.length === 5 && w.days.every((d, i) => d === i + 1) ? 'Mon–Fri' : w.days.length === 7 ? 'Every day' : w.days.map((d) => DAY_SHORT[d]).join(', ');
  return `${days} ${w.start}–${w.end} (${w.timeZone})`;
}

/** Badges for one share's conditions, in the "who has access" list. */
export function ConditionBadges({ policy }: { policy?: SharePolicyView | null }) {
  if (!policy) return null;
  return (
    <>
      {policy.downloadApproval && <Badge tone="amber" icon={<HandPalm size={11} />}>Downloads need approval{policy.approver ? ` (${policy.approver.name})` : ''}</Badge>}
      {policy.window && <Badge tone="blue" icon={<Clock size={11} />}>{describeWindow(policy.window)}</Badge>}
      {policy.networks && <Badge tone="violet" icon={<GlobeHemisphereWest size={11} />}>{policy.networks.length === 1 ? policy.networks[0] : `${policy.networks.length} networks`}</Badge>}
    </>
  );
}

/** The "Conditions" part of the share form. Returns undefined policy when nothing is set. */
export function PolicyFields({ value, onChange, managers }: { value: SharePolicy | undefined; onChange: (p: SharePolicy | undefined) => void; managers: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(Boolean(value));
  const p: SharePolicy = value ?? { downloadApproval: false };
  const set = (patch: Partial<SharePolicy>) => {
    const next = { ...p, ...patch };
    const empty = !next.downloadApproval && !next.window && !next.networks;
    onChange(empty ? undefined : next);
  };
  const w = p.window ?? null;
  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
      <button type="button" className="flex w-full items-center gap-2 text-left text-[13px] font-medium" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ShieldCheck size={16} className="text-brand-600 dark:text-brand-300" />
        Conditions (optional)
        <span className="ml-auto text-xs font-normal text-slate-500">{value ? 'set' : 'none'}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-4">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={p.downloadApproval} onChange={(e) => set({ downloadApproval: e.target.checked, approverId: e.target.checked ? p.approverId ?? null : null })} />
            <span><span className="font-medium">Downloads need approval.</span> They can open the details; to get the file they ask with a reason, and you (or the approver below) approve each time.</span>
          </label>
          {p.downloadApproval && managers.length > 0 && (
            <Label label="Also allow this manager to approve (optional)">
              <Select value={p.approverId ?? ''} onChange={(e) => set({ approverId: e.target.value || null })}>
                <option value="">Only me</option>
                {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            </Label>
          )}

          <div>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={Boolean(w)} onChange={(e) => set({ window: e.target.checked ? { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', timeZone: browserZone() } : null })} />
              Only during working hours
            </label>
            {w && (
              <div className="mt-2 space-y-2 pl-6">
                <div className="flex flex-wrap gap-1" role="group" aria-label="Days">
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={w.days.includes(d)}
                      className={cx('rounded-lg border px-2.5 py-1 text-xs', w.days.includes(d) ? 'border-brand-400 bg-brand-50 font-semibold dark:bg-brand-500/10' : 'border-slate-200 dark:border-white/10')}
                      onClick={() => {
                        const days = w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d].sort((a, b) => a - b);
                        if (days.length) set({ window: { ...w, days } });
                      }}
                    >{DAY_SHORT[d]}</button>
                  ))}
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <Label label="From"><Input type="time" value={w.start} onChange={(e) => set({ window: { ...w, start: e.target.value } })} /></Label>
                  <Label label="Until"><Input type="time" value={w.end === '24:00' ? '23:59' : w.end} onChange={(e) => set({ window: { ...w, end: e.target.value } })} /></Label>
                  <Label label="Time zone"><Input value={w.timeZone} onChange={(e) => set({ window: { ...w, timeZone: e.target.value.trim() } })} placeholder="Europe/London" /></Label>
                </div>
                <p className="text-xs text-slate-500">Local time in that zone, including daylight-saving changes. Outside these hours the share gives nothing.</p>
              </div>
            )}
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={Boolean(p.networks)} onChange={(e) => set({ networks: e.target.checked ? ['10.0.0.0/8'] : null })} />
              Only from these networks
            </label>
            {p.networks && (
              <div className="mt-2 pl-6">
                <Textarea rows={2} value={p.networks.join('\n')} onChange={(e) => set({ networks: e.target.value.split(/[\s,]+/).filter(Boolean) })} placeholder={'10.0.0.0/8\n2001:db8::/32'} />
                <p className="mt-1 text-xs text-slate-500">IPv4 or IPv6 ranges (CIDR), one per line. This checks the network, not the device: someone on the office VPN with stolen credentials passes it. Use it with, not instead of, the other controls.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface MyRequest { id: string; status: string; versionNo: number; reason: string; createdAt: string; validUntil: string | null; maxUses: number | null; uses: number; note: string | null; decidedBy: string | null; mine: boolean }

const STATUS_TONE: Record<string, 'amber' | 'green' | 'red' | 'neutral' | 'blue'> = { PENDING: 'amber', APPROVED: 'green', USED: 'neutral', REJECTED: 'red', EXPIRED: 'neutral', CANCELLED: 'neutral' };

/** What a recipient whose share needs approval sees instead of a plain Download button. */
export function DownloadRequestCard({ docId, versionNo }: { docId: string; versionNo: number }) {
  const [requests, setRequests] = useState<MyRequest[] | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const load = useCallback(() => api.get<{ requests: MyRequest[] }>(`/documents/${docId}/download-requests`).then((r) => setRequests(r.requests.filter((x) => x.mine))).catch((e) => setError(errorText(e))), [docId]);
  useEffect(() => { void load(); }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/documents/${docId}/download-requests`, { reason, versionNo });
      setReason('');
      setSent(true);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const live = requests?.filter((r) => r.status === 'APPROVED' && r.validUntil && new Date(r.validUntil) > new Date() && (r.maxUses ?? 0) > r.uses) ?? [];
  const pending = requests?.some((r) => r.status === 'PENDING' && r.versionNo === versionNo);
  return (
    <Card title="Download needs approval" icon={<HandPalm size={20} />} description="The owner asked to approve each download of this document. You can still read its details here.">
      {live.map((r) => (
        <div key={r.id} className="mb-3 flex flex-wrap items-center gap-3 rounded-xl bg-emerald-50 p-3 text-sm dark:bg-emerald-500/10">
          <CheckCircle size={18} className="text-emerald-600" />
          <span className="flex-1">Approved for version {r.versionNo}: {(r.maxUses ?? 0) - r.uses} download{(r.maxUses ?? 0) - r.uses === 1 ? '' : 's'} left, until {formatDate(r.validUntil)}.</span>
          <ButtonLink href={`/api/documents/${docId}/versions/${r.versionNo}/download`} variant="primary" icon={<DownloadSimple size={16} />} onClick={() => setTimeout(() => void load(), 1500)}>Download</ButtonLink>
        </div>
      ))}
      {pending ? (
        <p className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300"><Lightning size={16} />Your request for version {versionNo} is waiting for the owner.{sent && ' They were emailed.'}</p>
      ) : live.length === 0 && (
        <form onSubmit={submit} className="space-y-3">
          <Label label={`Why do you need a copy of version ${versionNo}?`} hint="The owner sees this. At least 10 characters.">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} maxLength={500} required />
          </Label>
          <Button type="submit" variant="primary" icon={<HandPalm size={16} />}>Ask to download</Button>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {requests && requests.length > 0 && (
        <ul className="mt-4 space-y-2 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-white/[0.06]">
          {requests.slice(0, 5).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status.toLowerCase()}</Badge>
              <span>v{r.versionNo} · asked {formatDate(r.createdAt)}{r.decidedBy ? ` · ${r.decidedBy}` : ''}{r.note ? ` · “${r.note}”` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
