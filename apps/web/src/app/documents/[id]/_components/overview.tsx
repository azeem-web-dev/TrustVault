'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CalendarBlank, Check, Copy, Eye, Fingerprint, Info, LockKey, PencilSimple, ShieldCheck, Crown, Bug, Hash } from '@phosphor-icons/react';
import { useToast } from '@/components/toast';
import { Alert, Button, Card, IconButton, IconTile, Input, Label, Textarea, cx, staggerClass } from '@/components/ui';
import { errorText, formatDate } from '@/lib/api';
import type { Doc } from './types';

function CopyButton({ value, label }: { value: string; label: string }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(value);
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1500);
      toast('Copied to the clipboard');
    } catch {
      toast('Could not copy. Select the text and copy it instead.', 'error');
    }
  };
  return (
    // Drawn at 28px, but the hit area is 44px.
    <IconButton label={label} className="size-7 before:absolute before:-inset-2" onClick={() => void copy()}>
      {done ? <Check size={14} weight="bold" className="animate-pop text-success-600 dark:text-success-300" /> : <Copy size={14} />}
    </IconButton>
  );
}

export function AboutCard({ doc, canManage }: { doc: Doc; canManage: boolean }) {
  const current = doc.versions[0];
  const rows: { icon: ReactNode; label: string; value: ReactNode }[] = [
    { icon: <Crown size={16} />, label: 'Owner', value: doc.isOwner ? 'You' : <>{doc.owner.displayName}<span className="block break-all text-xs font-normal text-fg-subtle">{doc.owner.email}</span></> },
    { icon: <CalendarBlank size={16} />, label: 'Created', value: formatDate(doc.createdAt) },
    { icon: <PencilSimple size={16} />, label: 'Last changed', value: formatDate(doc.updatedAt) },
  ];
  return (
    <Card title="About" icon={<Info size={20} />}>
      <dl className="space-y-4 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex gap-3">
            <span className="mt-0.5 text-fg-subtle">{r.icon}</span>
            <div className="min-w-0 break-words"><dt className="text-xs text-fg-subtle">{r.label}</dt><dd className="mt-0.5 font-medium">{r.value}</dd></div>
          </div>
        ))}
        {current && (
          <div className="flex gap-3">
            <span className="mt-0.5 text-fg-subtle"><Hash size={16} /></span>
            <div className="min-w-0 flex-1">
              <dt className="flex items-center justify-between text-xs text-fg-subtle">SHA-256 of current version<CopyButton value={current.sha256} label="Copy SHA-256" /></dt>
              <dd className="mt-0.5 break-all rounded-lg bg-surface-2 p-2 font-mono text-[0.6875rem] leading-4 text-fg-muted dark:bg-white/5">{current.sha256}</dd>
            </div>
          </div>
        )}
      </dl>
      {!canManage && (
        <p className="mt-5 flex gap-2 rounded-xl bg-surface-2 p-3 text-xs leading-5 text-fg-subtle dark:bg-white/5">
          <Eye size={16} className="shrink-0" />You can see this document because someone shared it with you. Only people with Manage access can see who else has it.
        </p>
      )}
    </Card>
  );
}

export function ProtectionCard({ doc }: { doc: Doc }) {
  const items = [
    { icon: <LockKey size={18} />, title: 'Encrypted at rest', text: 'Its own key, wrapped by a separate key service.', tone: 'brand' as const },
    { icon: <Bug size={18} />, title: 'Malware-scanned', text: 'On upload, and again every night with new signatures.', tone: 'green' as const },
    { icon: <Fingerprint size={18} />, title: 'Every access recorded', text: 'Views, downloads and refusals go into the signed audit trail.', tone: 'violet' as const },
    { icon: <ShieldCheck size={18} />, title: doc.isOwner ? 'Only you decide' : 'Shared on purpose', text: doc.isOwner ? 'Nobody sees it unless you share it with them.' : 'Access was granted to you for this document only.', tone: 'amber' as const },
  ];
  return (
    <Card title="How this document is protected" icon={<ShieldCheck size={20} />}>
      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((i, n) => (
          <div key={i.title} className={cx('flex animate-rise gap-3 rounded-xl border border-line p-3 transition-colors hover:border-line-strong', staggerClass(n))}>
            <IconTile tone={i.tone} size="sm">{i.icon}</IconTile>
            <div><p className="text-sm font-semibold">{i.title}</p><p className="mt-0.5 text-xs leading-5 text-fg-subtle">{i.text}</p></div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function Details({ doc, canEdit, onSave }: { doc: Doc; canEdit: boolean; onSave: (patch: object) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ title: doc.title, category: doc.category, description: doc.description ?? '' });
  // Follow the document only while not editing, so a reload (e.g. after a
  // folder move) never overwrites what is being typed (P4).
  useEffect(() => {
    if (!editing) setForm({ title: doc.title, category: doc.category, description: doc.description ?? '' });
  }, [doc, editing]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ title: form.title, category: form.category, description: form.description || null });
      setEditing(false);
    } catch (err) {
      // Keep the form open with the edits; show why it failed right here.
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };
  const cancel = () => { setEditing(false); setError(null); };
  return (
    <Card title="Details" icon={<PencilSimple size={20} />} actions={canEdit && !editing && <Button size="sm" icon={<PencilSimple size={14} />} onClick={() => setEditing(true)}>Edit</Button>}>
      {editing ? (
        <form onSubmit={submit} className="grid animate-pop gap-4 sm:grid-cols-2">
          <Label label="Title"><Input required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus /></Label>
          <Label label="Category"><Input required maxLength={60} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Label>
          <div className="sm:col-span-2"><Label label="Description"><Textarea rows={4} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Label></div>
          {error && <div className="sm:col-span-2"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" variant="primary" icon={<Check size={16} weight="bold" />} loading={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            <Button type="button" variant="ghost" disabled={saving} onClick={cancel}>Cancel</Button>
          </div>
        </form>
      ) : (
        <p className="animate-fade-in whitespace-pre-wrap break-words text-sm leading-6 text-fg-muted">{doc.description || <span className="italic text-fg-subtle">No description.</span>}</p>
      )}
    </Card>
  );
}
