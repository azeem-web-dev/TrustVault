'use client';

// Access policies on shares (THREATS.md P1-P12): conditions in the share
// sheet, badges on each share, and the download-approval request card a
// recipient sees. The API and the database enforce all of it; this is only
// how people set and see it.

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowClockwise, CaretDown, CheckCircle, Clock, DownloadSimple, GlobeHemisphereWest, HandPalm, HourglassMedium, ShieldCheck } from '@phosphor-icons/react';
import { Alert, Badge, Button, ButtonLink, Card, Checkbox, Input, Label, Select, Textarea, cx, staggerClass } from './ui';
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

/** Splits the networks textarea into ranges (one per line; spaces and commas also separate). */
const parseNetworks = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/**
 * The "Conditions" part of the share form. Returns undefined policy when nothing is set.
 * With "Only from these networks" ticked and no range typed, `networks` is `[]`:
 * the textarea is `required`, so the form cannot be sent until a range is added
 * or the box is unticked (an empty list is never sent as "no restriction").
 */
export function PolicyFields({ value, onChange, managers }: { value: SharePolicy | undefined; onChange: (p: SharePolicy | undefined) => void; managers: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(Boolean(value));
  const p: SharePolicy = value ?? { downloadApproval: false };
  // The networks box keeps its own raw text, so Enter, spaces and commas can
  // be typed; the parsed list is what goes into the policy (P1).
  const [netText, setNetText] = useState(() => (p.networks ?? []).join('\n'));
  const set = (patch: Partial<SharePolicy>) => {
    const next = { ...p, ...patch };
    const empty = !next.downloadApproval && !next.window && !next.networks;
    onChange(empty ? undefined : next);
  };
  const w = p.window ?? null;
  const netsEmpty = Array.isArray(p.networks) && p.networks.length === 0;
  return (
    <div className="rounded-xl border border-line p-3 transition-colors focus-within:border-line-strong">
      <button
        type="button"
        className="-m-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-lg p-1 text-left text-[0.8125rem] font-medium transition hover:bg-surface-2 pointer-coarse:min-h-11 dark:hover:bg-white/[0.04]"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ShieldCheck size={16} className="shrink-0 text-brand-600 dark:text-brand-300" />
        Conditions (optional)
        <span className={cx('ml-auto text-xs', value ? 'font-semibold text-brand-700 dark:text-brand-300' : 'font-normal text-fg-subtle')}>{value ? 'set' : 'none'}</span>
        <CaretDown aria-hidden size={12} weight="bold" className={cx('text-fg-subtle transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-3 animate-pop space-y-4">
          <Checkbox
            checked={p.downloadApproval}
            onChange={(e) => set({ downloadApproval: e.target.checked, approverId: e.target.checked ? p.approverId ?? null : null })}
            label="Downloads need approval"
            description="They can open the details; to get the file they ask with a reason, and you (or the approver below) approve each time."
          />
          {p.downloadApproval && managers.length > 0 && (
            <div className="animate-fade-in pl-6">
              <Label label="Also allow this manager to approve (optional)">
                <Select value={p.approverId ?? ''} onChange={(e) => set({ approverId: e.target.value || null })}>
                  <option value="">Only me</option>
                  {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              </Label>
            </div>
          )}

          <div>
            <Checkbox
              checked={Boolean(w)}
              onChange={(e) => set({ window: e.target.checked ? { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', timeZone: browserZone() } : null })}
              label="Only during working hours"
            />
            {w && (
              <div className="mt-2 animate-fade-in space-y-2 pl-6">
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => {
                    const on = w.days.includes(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        className={cx(
                          'relative min-h-9 min-w-11 rounded-lg border px-3 text-xs transition duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 pointer-coarse:min-h-11',
                          on
                            ? 'border-brand-400 bg-brand-50 font-semibold text-brand-700 dark:border-brand-400/60 dark:bg-brand-500/15 dark:text-brand-200'
                            : 'border-line text-fg-muted hover:border-line-strong hover:bg-surface-2 dark:hover:bg-white/[0.04]',
                        )}
                        onClick={() => {
                          const days = on ? w.days.filter((x) => x !== d) : [...w.days, d].sort((a, b) => a - b);
                          if (days.length) set({ window: { ...w, days } });
                        }}
                      >{DAY_SHORT[d]}</button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <Label label="From"><Input type="time" value={w.start} onChange={(e) => set({ window: { ...w, start: e.target.value } })} /></Label>
                  <Label label="Until"><Input type="time" value={w.end === '24:00' ? '23:59' : w.end} onChange={(e) => set({ window: { ...w, end: e.target.value } })} /></Label>
                  <Label label="Time zone"><Input value={w.timeZone} onChange={(e) => set({ window: { ...w, timeZone: e.target.value.trim() } })} placeholder="Europe/London" /></Label>
                </div>
                <p className="text-xs text-fg-subtle">Local time in that zone, including daylight-saving changes. Outside these hours the share gives nothing.</p>
              </div>
            )}
          </div>

          <div>
            <Checkbox
              checked={Boolean(p.networks)}
              onChange={(e) => {
                const on = e.target.checked;
                setNetText(on ? '10.0.0.0/8' : '');
                set({ networks: on ? ['10.0.0.0/8'] : null });
              }}
              label="Only from these networks"
            />
            {p.networks && (
              <div className="mt-2 animate-fade-in pl-6">
                <Textarea
                  rows={2}
                  required
                  aria-label="Allowed networks"
                  aria-invalid={netsEmpty || undefined}
                  aria-describedby="share-networks-hint"
                  value={netText}
                  onChange={(e) => { setNetText(e.target.value); set({ networks: parseNetworks(e.target.value) }); }}
                  onBlur={() => { const list = parseNetworks(netText); setNetText(list.join('\n')); set({ networks: list }); }}
                  placeholder={'10.0.0.0/8\n2001:db8::/32'}
                  className="font-mono text-[0.8125rem]"
                />
                {netsEmpty && <p role="alert" className="mt-1 text-xs font-medium text-danger-600 dark:text-danger-300">Add at least one range, or untick this condition.</p>}
                <p id="share-networks-hint" className="mt-1 text-xs text-fg-subtle">IPv4 or IPv6 ranges (CIDR), one per line. This checks the network, not the device: someone on the office VPN with stolen credentials passes it. Use it with, not instead of, the other controls.</p>
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

/** Downloads left on an approval; Infinity when it has no limit (maxUses null). */
const usesLeft = (r: MyRequest) => (r.maxUses === null ? Infinity : r.maxUses - r.uses);

/**
 * What a recipient whose share needs approval sees instead of a plain Download
 * button. `onChanged` lets the page refresh its header after an ask or a download.
 */
export function DownloadRequestCard({ docId, versionNo, onChanged }: { docId: string; versionNo: number; onChanged?: () => void }) {
  const [requests, setRequests] = useState<MyRequest[] | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const alive = useRef(true);
  const changed = useRef(onChanged);
  useEffect(() => { changed.current = onChanged; });
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ requests: MyRequest[] }>(`/documents/${docId}/download-requests`);
      if (!alive.current) return;
      setRequests(r.requests.filter((x) => x.mine));
      setLoadError(null);
    } catch (e) {
      if (alive.current) setLoadError(errorText(e));
    }
  }, [docId]);
  useEffect(() => { void load(); }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      await api.post(`/documents/${docId}/download-requests`, { reason, versionNo });
      if (!alive.current) return;
      setReason('');
      setSent(true);
      await load();
      changed.current?.();
    } catch (err) {
      if (alive.current) setError(errorText(err));
    } finally {
      sendingRef.current = false;
      if (alive.current) setSending(false);
    }
  };

  const now = new Date();
  const live = requests?.filter((r) => r.status === 'APPROVED' && (!r.validUntil || new Date(r.validUntil) > now) && usesLeft(r) > 0) ?? [];
  const pending = requests?.some((r) => r.status === 'PENDING' && r.versionNo === versionNo);
  return (
    <Card title="Download needs approval" icon={<HandPalm size={20} />} description="The owner asked to approve each download of this document. You can still read its details here.">
      {loadError && !requests && <div className="mb-3"><Alert title="Couldn't load your requests" action={<Button size="sm" icon={<ArrowClockwise size={14} weight="bold" />} onClick={() => void load()}>Try again</Button>}>{loadError}</Alert></div>}
      {live.map((r) => {
        const left = usesLeft(r);
        return (
          <div key={r.id} className="mb-3 flex animate-pop flex-wrap items-center gap-3 rounded-xl bg-success-50 p-3 text-sm text-success-700 ring-1 ring-inset ring-success-100 dark:bg-success-500/10 dark:text-success-300 dark:ring-success-500/20">
            <CheckCircle size={18} className="shrink-0 text-success-600 dark:text-success-300" />
            <span className="min-w-0 flex-1">
              Approved for version {r.versionNo}: {left === Infinity ? 'unlimited downloads' : `${left} download${left === 1 ? '' : 's'} left`}
              {r.validUntil ? `, until ${formatDate(r.validUntil)}` : ''}.
            </span>
            <ButtonLink
              href={`/api/documents/${docId}/versions/${r.versionNo}/download`}
              variant="primary"
              icon={<DownloadSimple size={16} />}
              onClick={() => setTimeout(() => { if (!alive.current) return; void load(); changed.current?.(); }, 1500)}
            >Download</ButtonLink>
          </div>
        );
      })}
      {pending ? (
        <p className="flex animate-fade-in items-start gap-2 rounded-xl bg-warning-50 p-3 text-sm text-warning-700 ring-1 ring-inset ring-warning-100 dark:bg-warning-500/10 dark:text-warning-300 dark:ring-warning-500/20"><HourglassMedium size={16} className="mt-0.5 shrink-0" />Your request for version {versionNo} is waiting for the owner.{sent && ' They were emailed.'}</p>
      ) : live.length === 0 && (
        <form onSubmit={submit} className="animate-fade-in space-y-3">
          <Label label={`Why do you need a copy of version ${versionNo}?`} hint="The owner sees this. At least 10 characters.">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} maxLength={500} required />
          </Label>
          <Button type="submit" variant="primary" icon={<HandPalm size={16} />} loading={sending}>{sending ? 'Sending…' : 'Ask to download'}</Button>
        </form>
      )}
      {error && <div className="mt-3"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}
      {requests && requests.length > 0 && (
        <ul className="mt-4 space-y-2 border-t border-line pt-3 text-xs text-fg-subtle">
          {requests.slice(0, 5).map((r, i) => (
            <li key={r.id} className={cx('flex animate-rise flex-wrap items-center gap-2', staggerClass(i))}>
              <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status.toLowerCase()}</Badge>
              <span className="min-w-0 break-words">v{r.versionNo} · asked {formatDate(r.createdAt)}{r.decidedBy ? ` · ${r.decidedBy}` : ''}{r.note ? ` · “${r.note}”` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
