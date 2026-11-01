'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Shell } from '@/components/shell';
import { Alert, Badge, Button, Card, Empty, Input, Label, PageTitle, Select, Textarea } from '@/components/ui';
import { api, errorText, formatDate } from '@/lib/api';

interface AlertItem {
  severity: 'critical' | 'high' | 'medium' | 'info';
  kind: string;
  at?: string;
  message: string;
  documentId?: string | null;
  documentTitle?: string | null;
}

const TONE = { critical: 'red', high: 'red', medium: 'amber', info: 'blue' } as const;

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
    void load();
  }, [load]);

  return (
    <Shell>
      <PageTitle
        title="Alerts"
        subtitle="Activity worth a second look, computed from the audit log: repeated refusals, access attempts after revocation, bulk downloads, external sharing, break-glass use, blocked sign-ins, and any integrity failure."
        actions={
          <Select value={hours} onChange={(e) => setHours(e.target.value)} className="w-40">
            <option value="1">Last hour</option><option value="24">Last 24 hours</option><option value="168">Last 7 days</option><option value="720">Last 30 days</option>
          </Select>
        }
      />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      <Card title="What to notice">
        {!alerts ? <p className="text-sm text-slate-500">Loading…</p> : alerts.length === 0 ? <Empty>Nothing unusual in this period.</Empty> : (
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {alerts.map((a, i) => (
              <li key={i} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div>
                  <div>{a.message}</div>
                  <div className="text-xs text-slate-500">
                    {a.kind.replace(/_/g, ' ')}{a.at && <> · {formatDate(a.at)}</>}
                    {a.documentId && <> · <Link className="text-brand-600 hover:underline" href={`/admin/audit`}>document: {a.documentTitle ?? a.documentId}</Link></>}
                  </div>
                </div>
                <Badge tone={TONE[a.severity]}>{a.severity}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div className="mt-6"><BreakGlass onDone={load} /></div>
    </Shell>
  );
}

function BreakGlass({ onDone }: { onDone: () => void }) {
  const [documentId, setDocumentId] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<{ documentId: string; title: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      setResult(await api.post('/admin/break-glass', { documentId: documentId.trim(), reason }));
      setReason('');
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Card title="Break-glass access" actions={<Badge tone="amber">Audited and alerted</Badge>}>
      <p className="mb-4 text-sm text-slate-500">
        Administrators cannot open documents. In an emergency (legal hold, incident response) you can take one hour of READ access to a single document.
        The reason is recorded in the audit trail, raised as an alert, and shown in the document&apos;s own history to its owner.
      </p>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
        <Label label="Document id"><Input required value={documentId} onChange={(e) => setDocumentId(e.target.value)} placeholder="from the audit log" /></Label>
        <div className="sm:col-span-2"><Label label="Reason (at least 20 characters)"><Textarea rows={2} required minLength={20} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Label></div>
        <div><Button type="submit" variant="danger">Take emergency access</Button></div>
      </form>
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      {result && (
        <div className="mt-3"><Alert tone="amber">Access to &quot;{result.title}&quot; until {formatDate(result.expiresAt)}. <Link className="underline" href={`/documents/${result.documentId}`}>Open document</Link></Alert></div>
      )}
    </Card>
  );
}
