'use client';

import { useEffect, useState } from 'react';
import { ArrowsLeftRight, Trash, WarningOctagon, ArrowCounterClockwise, Fire, Crown } from '@phosphor-icons/react';
import { Avatar, Button, Card, Input, Label, Select, cx, staggerClass, useConfirm } from '@/components/ui';
import { api } from '@/lib/api';
import { isAbortError, useLatest } from '@/lib/hooks';
import type { DirUser } from './access-panel';
import type { Doc } from './types';

export function OwnerActions(props: {
  doc: Doc; busy: string | null;
  onTrash: () => Promise<boolean>; onRestore: () => Promise<boolean>; onPurge: () => Promise<boolean>;
  onTransfer: (id: string) => Promise<void>; onMove: (folderId: string | null) => Promise<boolean>;
}) {
  const { doc, busy } = props;
  const [confirm, confirmDialog] = useConfirm();
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [owners, setOwners] = useState<DirUser[]>([]);
  const [ownersFor, setOwnersFor] = useState('');
  const [ownerQuery, setOwnerQuery] = useState('');
  const ownersLatest = useLatest();
  useEffect(() => {
    let live = true;
    api.get<{ folders: { id: string; name: string }[] }>('/folders').then((r) => { if (live) setFolders(r.folders); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const oq = ownerQuery.trim();
  useEffect(() => {
    if (oq.length < 2) {
      ownersLatest.cancel();
      setOwners([]);
      setOwnersFor('');
      return;
    }
    const timer = setTimeout(async () => {
      const t = ownersLatest.begin();
      try {
        const r = await api.get<{ users: DirUser[] }>(`/directory?q=${encodeURIComponent(oq)}`, { signal: t.signal });
        if (!t.isLatest()) return;
        setOwners(r.users.filter((u) => u.role === 'OWNER' && u.id !== doc.owner.id));
        setOwnersFor(oq);
      } catch (err) {
        if (!t.isLatest() || isAbortError(err)) return;
        setOwners([]);
        setOwnersFor(oq);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [oq, ownersLatest, doc.owner.id]);

  // Transfer cannot be undone: always confirm first (P2). The dialog runs it,
  // so its button spins and an error stays in the dialog.
  const askTransfer = (o: DirUser) => {
    void confirm({
      title: `Transfer “${doc.title}” to ${o.displayName}?`,
      body: <>They become the owner, with full control. <span className="font-semibold">You lose all access</span> unless they share it back with you (or a group you are in still has it). This cannot be undone.</>,
      confirmLabel: 'Yes, transfer',
      danger: true,
      icon: <ArrowsLeftRight size={20} />,
      onConfirm: () => props.onTransfer(o.id),
    });
  };

  if (doc.status === 'DELETED') {
    return (
      <Card title="In the trash" icon={<Trash size={20} />}>
        <p className="mb-4 text-sm text-fg-subtle">Only you can see it. It is removed permanently after the retention period.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon={<ArrowCounterClockwise size={16} />} loading={busy === 'restore'} disabled={!!busy} onClick={() => void props.onRestore()}>Restore</Button>
          {confirmPurge ? (
            <div className="flex animate-fade-in flex-wrap gap-2">
              <Button variant="danger" icon={<Fire size={16} />} loading={busy === 'purge'} disabled={!!busy} onClick={() => void props.onPurge()}>Yes, delete forever</Button>
              <Button variant="ghost" disabled={busy === 'purge'} onClick={() => setConfirmPurge(false)}>Cancel</Button>
            </div>
          ) : <Button variant="danger" icon={<Trash size={16} />} disabled={!!busy} onClick={() => setConfirmPurge(true)}>Delete permanently</Button>}
        </div>
      </Card>
    );
  }
  return (
    <Card title="Owner actions" icon={<Crown size={20} />}>
      <div className="space-y-5 text-sm">
        {folders.length > 0 && (
          <Label label="Folder">
            <Select value={doc.folder?.id ?? ''} disabled={!!busy} aria-busy={busy === 'move' || undefined} onChange={(e) => void props.onMove(e.target.value || null)}>
              <option value="">No folder</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
          </Label>
        )}
        <div>
          <Label label="Transfer ownership" hint="The new owner gets full control. You keep no access unless they share it back.">
            <Input icon={<ArrowsLeftRight size={18} />} placeholder="Search document owners" autoComplete="off" value={ownerQuery} onChange={(e) => setOwnerQuery(e.target.value)} />
          </Label>
          {owners.map((o, oi) => (
            <div key={o.id} className={cx('mt-2 flex animate-rise items-center gap-3 rounded-xl border border-line p-2.5', staggerClass(oi))}>
              <Avatar name={o.displayName} size="sm" />
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{o.displayName}</span><span className="block truncate text-xs text-fg-subtle">{o.email}</span></span>
              <Button size="sm" icon={<ArrowsLeftRight size={14} />} disabled={!!busy} onClick={() => askTransfer(o)}>Transfer…</Button>
            </div>
          ))}
          {oq.length >= 2 && ownersFor === oq && owners.length === 0 && (
            <p className="mt-2 animate-fade-in text-xs text-fg-subtle">No document owners match “{oq}”. Only people with the Owner role can own documents.</p>
          )}
        </div>
        <div className="rounded-xl border border-danger-300/60 bg-danger-50/50 p-4 dark:border-danger-500/25 dark:bg-danger-500/5">
          <p className="flex items-center gap-2 font-semibold text-danger-700 dark:text-danger-300"><WarningOctagon size={18} />Danger zone</p>
          <p className="mt-1 text-xs text-danger-700 dark:text-danger-300/80">Moving to the trash removes everyone else&apos;s access at once. You can restore it later.</p>
          <div className="mt-3">
            {confirmTrash
              ? (
                <div className="flex animate-fade-in flex-wrap gap-2">
                  <Button variant="danger" icon={<Trash size={16} />} loading={busy === 'trash'} disabled={!!busy} onClick={() => void props.onTrash().then((ok) => { if (ok) setConfirmTrash(false); })}>Yes, move to trash</Button>
                  <Button variant="ghost" disabled={busy === 'trash'} onClick={() => setConfirmTrash(false)}>Cancel</Button>
                </div>
              )
              : <Button variant="danger" icon={<Trash size={16} />} disabled={!!busy} onClick={() => setConfirmTrash(true)}>Move to trash</Button>}
          </div>
        </div>
      </div>
      {confirmDialog}
    </Card>
  );
}
