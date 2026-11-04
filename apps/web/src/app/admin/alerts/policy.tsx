'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowUp, Gauge, HandPalm, Prohibit, SlidersHorizontal } from '@phosphor-icons/react';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, Input, Label, LoadError, Select, SkeletonRows, Textarea, cx, relativeTime, staggerClass, useConfirm, IconTile } from '@/components/ui';
import { api, errorText, formatDate } from '@/lib/api';

interface Setting { key: string; label: string; value: number; default: number; min: number; max: number; updatedAt: string | null; updatedBy: string | null }
interface Override { id: string; userId: string; userEmail: string; dailyLimit: number; sessionLimit: number; reason: string; grantedBy: string; createdAt: string; expiresAt: string; revokedAt: string | null; revokedBy: string | null; active: boolean }
interface Person { id: string; email: string; displayName: string; role: string; status: string }

/** Detection thresholds and hard download limits, plus time-boxed overrides. Every change is audited and alerted. */
export function RiskPolicy() {
  const toast = useToast();
  const [settings, setSettings] = useState<Setting[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ settings: Setting[] }>('/admin/risk-settings');
      setSettings(r.settings);
      setDraft(Object.fromEntries(r.settings.map((s) => [s.key, String(s.value)])));
      setLoadError(null);
    } catch (err) {
      setLoadError(err);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const retry = async () => {
    setRetrying(true);
    try { await load(); } finally { setRetrying(false); }
  };

  // An empty or half-typed field is not a change to 0 (O6).
  const valid = (v: string | undefined) => v !== undefined && v.trim() !== '' && Number.isFinite(Number(v));
  const changed = settings?.filter((s) => valid(draft[s.key]) && Number(draft[s.key]) !== s.value) ?? [];
  const invalid = settings?.filter((s) => !valid(draft[s.key])) ?? [];

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || changed.length === 0 || invalid.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const values = Object.fromEntries(changed.map((s) => [s.key, Number(draft[s.key])]));
      await api.put('/admin/risk-settings', { values, reason });
      setReason('');
      toast('Saved. The change is in the audit log and the other admins see an alert.', 'success');
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card title="Thresholds and hard limits" icon={<SlidersHorizontal size={20} />} description="Each value has a safe default and a range it cannot leave. Changes need a reason, are audited with before and after, and raise an alert another admin must close.">
        {!settings ? (loadError ? <LoadError compact error={loadError} title="Couldn't load the thresholds" onRetry={() => void retry()} retrying={retrying} /> : <SkeletonRows rows={6} label="Loading thresholds…" />) : (
          <form onSubmit={save} className="space-y-4">
            <div className="divide-y divide-line">
              {settings.map((s, i) => (
                <div key={s.key} className={cx('grid animate-fade-in items-center gap-2 py-2.5 sm:grid-cols-[1fr_8rem]', staggerClass(i))}>
                  <div className="min-w-0">
                    <p id={`risk-${s.key}`} className={cx('text-sm', draft[s.key] !== undefined && valid(draft[s.key]) && Number(draft[s.key]) !== s.value && 'font-semibold text-brand-700 dark:text-brand-200')}>{s.label}</p>
                    <p className="text-[0.6875rem] text-fg-subtle">
                      <code>{s.key}</code> · default {s.default} · {s.min}–{s.max}
                      {s.updatedBy && <> · changed by {s.updatedBy} {relativeTime(s.updatedAt)}</>}
                    </p>
                  </div>
                  <Input
                    type="number"
                    required
                    aria-labelledby={`risk-${s.key}`}
                    aria-invalid={!valid(draft[s.key]) || undefined}
                    inputMode="decimal"
                    min={s.min}
                    max={s.max}
                    step={s.key.endsWith('fraction') || s.key.endsWith('multiplier') ? 0.05 : 1}
                    value={draft[s.key] ?? ''}
                    onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
                    className="tabular-nums"
                  />
                </div>
              ))}
            </div>
            <Label label="Why (at least 10 characters)" hint={`${changed.length} changed · ${reason.length}/500`}><Textarea rows={2} minLength={10} maxLength={500} required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Finance does month-end exports in bulk; agreed with the CISO" /></Label>
            {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" icon={<Gauge size={16} />} disabled={changed.length === 0 || invalid.length > 0} loading={busy}>
                {changed.length ? `Save ${changed.length} change${changed.length === 1 ? '' : 's'}` : 'No changes'}
              </Button>
              {invalid.length > 0 && <span className="text-xs text-danger-600 dark:text-danger-300">Fill in {invalid.length === 1 ? 'the empty value' : `the ${invalid.length} empty values`} first.</span>}
            </div>
          </form>
        )}
      </Card>
      <Overrides />
    </div>
  );
}

function Overrides() {
  const toast = useToast();
  const [rows, setRows] = useState<Override[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [form, setForm] = useState({ userId: '', dailyLimit: '500', sessionLimit: '250', days: '3', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    const [o, u] = await Promise.allSettled([
      api.get<{ overrides: Override[] }>('/admin/download-limits/overrides'),
      api.get<{ users: Person[] }>('/admin/users'),
    ]);
    if (o.status === 'fulfilled') { setRows(o.value.overrides); setLoadError(null); } else setLoadError(o.reason);
    if (u.status === 'fulfilled') setPeople(u.value.users.filter((p) => p.role !== 'ADMIN' && p.status === 'ACTIVE'));
    else if (o.status === 'fulfilled') setError(`Could not load the list of people: ${errorText(u.reason)}`);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const retry = async () => {
    setRetrying(true);
    try { await load(); } finally { setRetrying(false); }
  };

  const grant = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/admin/download-limits/overrides', {
        userId: form.userId, dailyLimit: Number(form.dailyLimit), sessionLimit: Number(form.sessionLimit), reason: form.reason,
        expiresAt: new Date(Date.now() + Number(form.days) * 86_400_000).toISOString(),
      });
      toast('Limit raised. Audited and alerted.', 'success');
      setForm({ ...form, reason: '' });
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (o: Override) => {
    if (ending) return;
    const ok = await confirm({
      title: `End the exception for ${o.userEmail} now?`,
      body: <>Their normal download limits apply again from their next request. To raise them again you need a new exception and reason.</>,
      confirmLabel: 'End now',
      cancelLabel: 'Keep it',
      danger: true,
      icon: <Prohibit size={20} />,
    });
    if (!ok) return;
    setEnding(o.id);
    setError(null);
    try {
      await api.post(`/admin/download-limits/overrides/${o.id}/revoke`);
      toast('Override ended', 'success');
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setEnding(null);
    }
  };

  return (
    <Card title="Download limit exceptions" icon={<HandPalm size={20} />} description="Raise one person's limits for legitimate bulk work, for at most 14 days. Never your own. Audited, alerted, and it ends on its own.">
      <form onSubmit={grant} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Label label="Person">
          <Select required value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
            <option value="">Choose…</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.displayName} ({p.email})</option>)}
          </Select>
        </Label>
        <Label label="Per 24 hours"><Input type="number" min={1} max={100000} required value={form.dailyLimit} onChange={(e) => setForm({ ...form, dailyLimit: e.target.value })} /></Label>
        <Label label="Per session"><Input type="number" min={1} max={100000} required value={form.sessionLimit} onChange={(e) => setForm({ ...form, sessionLimit: e.target.value })} /></Label>
        <Label label="For (days)"><Input type="number" min={1} max={14} required value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} /></Label>
        <div className="sm:col-span-2 lg:col-span-5"><Label label="Reason (at least 20 characters)"><Textarea rows={2} minLength={20} maxLength={500} required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Annual audit export for KPMG, ticket AUD-2026" /></Label></div>
        <div><Button type="submit" variant="primary" icon={<ArrowUp size={16} weight="bold" />} loading={busy}>Raise limit</Button></div>
      </form>
      {error && <div className="mt-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}
      <div className="mt-5">
        {!rows ? (loadError ? <LoadError compact error={loadError} title="Couldn't load the exceptions" onRetry={() => void retry()} retrying={retrying} /> : <SkeletonRows rows={2} label="Loading exceptions…" />) : rows.length === 0 ? <div className="flex animate-fade-in items-center gap-3 rounded-xl border border-dashed border-line-strong px-4 py-4 text-sm text-fg-subtle"><IconTile tone="slate" size="sm"><HandPalm size={18} /></IconTile>No exceptions granted. Everyone has the normal limits.</div> : (
          <ul className="divide-y divide-line">
            {rows.map((o, i) => (
              <li key={o.id} className={cx('flex animate-fade-in flex-wrap items-start gap-3 py-3 text-sm transition-opacity duration-200', staggerClass(i), ending === o.id && 'opacity-60')}>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{o.userEmail}: {o.dailyLimit} a day, {o.sessionLimit} a session</p>
                  <p className="text-xs text-fg-subtle">by {o.grantedBy} · {formatDate(o.createdAt)} → {formatDate(o.expiresAt)}{o.revokedAt ? ` · ended by ${o.revokedBy ?? '?'} ${formatDate(o.revokedAt)}` : ''}</p>
                  <p className="mt-1.5 border-l-2 border-line-strong pl-3 text-xs italic text-fg-muted">“{o.reason}”</p>
                </div>
                {o.active ? <Badge tone="amber" dot>active</Badge> : <Badge>ended</Badge>}
                {o.active && <Button size="sm" variant="danger" icon={<Prohibit size={14} />} loading={ending === o.id} disabled={!!ending && ending !== o.id} onClick={() => void revoke(o)}>End now</Button>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {confirmDialog}
    </Card>
  );
}
