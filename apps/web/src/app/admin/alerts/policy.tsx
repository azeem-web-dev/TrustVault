'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Gauge, HandPalm, Prohibit, SlidersHorizontal } from '@phosphor-icons/react';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, Input, Label, Select, SkeletonRows, Textarea, relativeTime } from '@/components/ui';
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
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ settings: Setting[] }>('/admin/risk-settings');
      setSettings(r.settings);
      setDraft(Object.fromEntries(r.settings.map((s) => [s.key, String(s.value)])));
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const changed = settings?.filter((s) => draft[s.key] !== undefined && Number(draft[s.key]) !== s.value) ?? [];

  const save = async (e: FormEvent) => {
    e.preventDefault();
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
        {!settings ? <SkeletonRows rows={6} /> : (
          <form onSubmit={save} className="space-y-4">
            <div className="divide-y divide-slate-100 dark:divide-white/[0.05]">
              {settings.map((s) => (
                <div key={s.key} className="grid items-center gap-2 py-2.5 sm:grid-cols-[1fr_8rem]">
                  <div className="min-w-0">
                    <p className="text-sm">{s.label}</p>
                    <p className="text-[11px] text-slate-500">
                      <code>{s.key}</code> · default {s.default} · {s.min}–{s.max}
                      {s.updatedBy && <> · changed by {s.updatedBy} {relativeTime(s.updatedAt)}</>}
                    </p>
                  </div>
                  <Input type="number" min={s.min} max={s.max} step={s.key.endsWith('fraction') || s.key.endsWith('multiplier') ? 0.05 : 1} value={draft[s.key] ?? ''} onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })} />
                </div>
              ))}
            </div>
            <Label label="Why (at least 10 characters)" hint={`${changed.length} changed`}><Textarea rows={2} minLength={10} maxLength={500} required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Finance does month-end exports in bulk; agreed with the CISO" /></Label>
            {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
            <Button type="submit" variant="primary" icon={<Gauge size={16} />} disabled={changed.length === 0} loading={busy}>Save {changed.length || ''} change{changed.length === 1 ? '' : 's'}</Button>
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
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [o, u] = await Promise.all([
        api.get<{ overrides: Override[] }>('/admin/download-limits/overrides'),
        api.get<{ users: Person[] }>('/admin/users'),
      ]);
      setRows(o.overrides);
      setPeople(u.users.filter((p) => p.role !== 'ADMIN' && p.status === 'ACTIVE'));
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const grant = async (e: FormEvent) => {
    e.preventDefault();
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

  const revoke = async (id: string) => {
    try {
      await api.post(`/admin/download-limits/overrides/${id}/revoke`);
      toast('Override ended', 'success');
      await load();
    } catch (err) {
      setError(errorText(err));
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
        <div><Button type="submit" variant="primary" loading={busy}>Raise limit</Button></div>
      </form>
      {error && <div className="mt-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}
      <div className="mt-5">
        {!rows ? <SkeletonRows rows={2} /> : rows.length === 0 ? <p className="text-sm text-slate-500">No exceptions granted.</p> : (
          <ul className="divide-y divide-slate-100 dark:divide-white/[0.05]">
            {rows.map((o) => (
              <li key={o.id} className="flex flex-wrap items-start gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{o.userEmail}: {o.dailyLimit} a day, {o.sessionLimit} a session</p>
                  <p className="text-xs text-slate-500">by {o.grantedBy} · {formatDate(o.createdAt)} → {formatDate(o.expiresAt)}{o.revokedAt ? ` · ended by ${o.revokedBy ?? '?'} ${formatDate(o.revokedAt)}` : ''}</p>
                  <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">“{o.reason}”</p>
                </div>
                {o.active ? <Badge tone="amber" dot>active</Badge> : <Badge>ended</Badge>}
                {o.active && <Button size="sm" variant="danger" icon={<Prohibit size={14} />} onClick={() => revoke(o.id)}>End now</Button>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
