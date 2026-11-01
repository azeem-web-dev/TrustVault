'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Shell } from '@/components/shell';
import { ACCESS_TONE, Alert, Badge, Button, Card, Empty, Input, Label, Select, Textarea } from '@/components/ui';
import { api, ApiError, errorText, formatBytes, formatDate, type Access, type Level } from '@/lib/api';

interface Version {
  versionNo: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  sha256: string;
  uploadedBy: string;
}

interface Doc {
  id: string;
  title: string;
  category: string;
  description: string | null;
  status: 'ACTIVE' | 'DELETED';
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  owner: { id: string; displayName: string; email: string };
  isOwner: boolean;
  myAccess: Access;
  folder: { id: string; name: string } | null;
  versions: Version[];
}

const RANK: Record<Access, number> = { NONE: 0, READ: 1, EDIT: 2, MANAGE: 3, OWNER: 4 };

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDoc(await api.get<Doc>(`/documents/${id}`));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else setError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, success: string, after?: () => void) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(success);
      if (after) after();
      else await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (notFound) {
    return (
      <Shell>
        <Card>
          <Empty>
            This document does not exist, or you do not have access to it.<br />
            <Link href="/" className="text-brand-600 hover:underline">Back to documents</Link>
          </Empty>
        </Card>
      </Shell>
    );
  }
  if (!doc) return <Shell><p className="text-sm text-slate-500">{error ?? 'Loading…'}</p></Shell>;

  const level = RANK[doc.myAccess];
  const trashed = doc.status === 'DELETED';
  const current = doc.versions[0];

  return (
    <Shell>
      <div className="mb-2 text-sm"><Link href="/" className="text-slate-500 hover:underline">← Documents</Link></div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{doc.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <Badge>{doc.category}</Badge>
            <Badge tone={ACCESS_TONE[doc.myAccess]}>Your access: {doc.myAccess}</Badge>
            {trashed && <Badge tone="red">In the trash</Badge>}
            {doc.folder && <Badge tone="blue">Folder: {doc.folder.name}</Badge>}
          </div>
        </div>
        {current && (
          <a href={`/api/documents/${doc.id}/download`} className="inline-flex items-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
            Download {current.fileName}
          </a>
        )}
      </div>

      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {notice && <div className="mb-4"><Alert tone="green">{notice}</Alert></div>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Details doc={doc} canEdit={level >= RANK.EDIT && !trashed} onSave={(patch) => act(() => api.patch(`/documents/${doc.id}`, patch), 'Saved')} />
          <Versions doc={doc} canUpload={level >= RANK.EDIT && !trashed} onUploaded={() => act(async () => undefined, 'New version uploaded')} onError={setError} />
          {level >= RANK.MANAGE && !trashed && <AccessPanel doc={doc} onError={setError} onNotice={setNotice} />}
          {level >= RANK.MANAGE && <History docId={doc.id} />}
        </div>
        <div className="space-y-6">
          <Card title="About">
            <dl className="space-y-2 text-sm">
              <div><dt className="text-slate-500">Owner</dt><dd>{doc.isOwner ? 'You' : `${doc.owner.displayName} (${doc.owner.email})`}</dd></div>
              <div><dt className="text-slate-500">Created</dt><dd>{formatDate(doc.createdAt)}</dd></div>
              <div><dt className="text-slate-500">Last changed</dt><dd>{formatDate(doc.updatedAt)}</dd></div>
              {current && <div><dt className="text-slate-500">SHA-256 of current version</dt><dd className="break-all font-mono text-xs">{current.sha256}</dd></div>}
            </dl>
            {level < RANK.MANAGE && (
              <p className="mt-4 text-xs text-slate-500">You can see this document because someone shared it with you. Only people with MANAGE access can see who else has it.</p>
            )}
          </Card>
          {doc.isOwner && (
            <OwnerActions
              doc={doc}
              onTrash={() => act(() => api.post(`/documents/${doc.id}/trash`), 'Moved to the trash. Nobody else can reach it now.')}
              onRestore={() => act(() => api.post(`/documents/${doc.id}/restore`), 'Restored')}
              onPurge={() => act(() => api.delete(`/documents/${doc.id}`), 'Deleted permanently', () => router.replace('/'))}
              onTransfer={(newOwnerId) => act(() => api.post(`/documents/${doc.id}/transfer`, { newOwnerId }), 'Ownership transferred', () => router.replace('/'))}
              onMove={(folderId) => act(() => api.patch(`/documents/${doc.id}`, { folderId }), 'Moved')}
            />
          )}
        </div>
      </div>
    </Shell>
  );
}

function Details({ doc, canEdit, onSave }: { doc: Doc; canEdit: boolean; onSave: (patch: object) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ title: doc.title, category: doc.category, description: doc.description ?? '' });
  useEffect(() => setForm({ title: doc.title, category: doc.category, description: doc.description ?? '' }), [doc]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await onSave({ title: form.title, category: form.category, description: form.description || null });
    setEditing(false);
  };
  return (
    <Card title="Details" actions={canEdit && !editing && <Button onClick={() => setEditing(true)}>Edit</Button>}>
      {editing ? (
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Label label="Title"><Input required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Label>
          <Label label="Category"><Input required maxLength={60} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Label>
          <div className="sm:col-span-2"><Label label="Description"><Textarea rows={3} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Label></div>
          <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary">Save</Button><Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
        </form>
      ) : (
        <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">{doc.description || <span className="text-slate-400">No description.</span>}</p>
      )}
    </Card>
  );
}

function Versions({ doc, canUpload, onUploaded, onError }: { doc: Doc; canUpload: boolean; onUploaded: () => void; onError: (m: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    const form = new FormData();
    form.set('file', file);
    try {
      await api.upload(`/documents/${doc.id}/versions`, form);
      setFile(null);
      onUploaded();
    } catch (err) {
      onError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={`Versions (${doc.versions.length})`}>
      <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {doc.versions.map((v) => (
          <li key={v.versionNo} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div>
              <span className="font-medium">v{v.versionNo}</span> · {v.fileName} · {formatBytes(v.sizeBytes)}
              <div className="text-xs text-slate-500">by {v.uploadedBy}, {formatDate(v.createdAt)}</div>
            </div>
            <a className="text-brand-600 hover:underline" href={`/api/documents/${doc.id}/versions/${v.versionNo}/download`}>Download</a>
          </li>
        ))}
      </ul>
      {canUpload && (
        <form onSubmit={upload} className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
          <div className="flex-1"><Label label="Upload a new version"><Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Label></div>
          <Button type="submit" disabled={!file || busy}>{busy ? 'Uploading…' : 'Upload version'}</Button>
        </form>
      )}
    </Card>
  );
}

interface GrantRow {
  id: string;
  level: Level;
  expiresAt: string | null;
  expired: boolean;
  grantedBy: string;
  subject: { type: 'user'; id: string; name: string; email: string; role: string; active: boolean } | { type: 'group'; id: string; name: string; members: number };
}

interface Suggestion {
  type: 'user' | 'group';
  id: string;
  name: string;
  detail: string;
  level: Level;
  why: string;
}

interface DirUser { id: string; displayName: string; email: string; role: string; accessExpiresAt: string | null }
interface DirGroup { id: string; name: string; members: number }

function AccessPanel({ doc, onError, onNotice }: { doc: Doc; onError: (m: string | null) => void; onNotice: (m: string | null) => void }) {
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ users: DirUser[]; groups: DirGroup[] }>({ users: [], groups: [] });
  const [target, setTarget] = useState<{ type: 'user' | 'group'; id: string; label: string; external: boolean } | null>(null);
  const [level, setLevel] = useState<Level>('READ');
  const [expires, setExpires] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ grants: GrantRow[] }>(`/documents/${doc.id}/access`);
      setGrants(r.grants);
    } catch (err) {
      onError(errorText(err));
    }
  }, [doc.id, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults({ users: [], groups: [] });
      return;
    }
    const t = setTimeout(() => {
      api.get<{ users: DirUser[]; groups: DirGroup[] }>(`/directory?q=${encodeURIComponent(query.trim())}`).then(setResults).catch(() => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const share = async (subject: { userId?: string; groupId?: string }, lvl: Level, expiresAt: string | null, fromSuggestion = false, label = '') => {
    onError(null);
    try {
      await api.put(`/documents/${doc.id}/access`, { ...subject, level: lvl, expiresAt, fromSuggestion });
      onNotice(`${label || 'Access'} updated (${lvl}).`);
      setTarget(null);
      setQuery('');
      setExpires('');
      await load();
      if (suggestions) setSuggestions(suggestions.filter((s) => s.id !== (subject.userId ?? subject.groupId)));
    } catch (err) {
      onError(errorText(err));
    }
  };

  const revoke = async (g: GrantRow) => {
    onError(null);
    try {
      await api.delete(`/documents/${doc.id}/access/${g.id}`);
      onNotice(`Access removed for ${g.subject.name}. It stops working on their next request.`);
      await load();
    } catch (err) {
      onError(errorText(err));
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!target) return;
    void share(target.type === 'user' ? { userId: target.id } : { groupId: target.id }, level, expires ? new Date(`${expires}T23:59:59`).toISOString() : null, false, target.label);
  };

  return (
    <Card title="Who has access" actions={<span className="text-xs text-slate-500">Changes take effect immediately</span>}>
      <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        <li className="flex items-center justify-between py-2">
          <span>{doc.owner.displayName} <span className="text-slate-500">({doc.owner.email})</span></span>
          <Badge tone="violet">OWNER</Badge>
        </li>
        {grants.map((g) => (
          <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div>
              {g.subject.type === 'group' ? <>Group: <span className="font-medium">{g.subject.name}</span> <span className="text-slate-500">({g.subject.members} members)</span></>
                : <>{g.subject.name} <span className="text-slate-500">({g.subject.email})</span> {g.subject.role === 'EXTERNAL' && <Badge tone="amber">External</Badge>} {!g.subject.active && <Badge tone="red">Inactive</Badge>}</>}
              <div className="text-xs text-slate-500">
                Granted by {g.grantedBy}{g.expiresAt && <> · {g.expired ? <span className="text-red-600">expired</span> : 'expires'} {formatDate(g.expiresAt)}</>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={ACCESS_TONE[g.level]}>{g.level}</Badge>
              {(doc.isOwner || g.level !== 'MANAGE') && <Button variant="danger" onClick={() => void revoke(g)}>Remove</Button>}
            </div>
          </li>
        ))}
      </ul>

      <form onSubmit={submit} className="mt-4 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
        <h3 className="text-sm font-semibold">Share</h3>
        {target ? (
          <div className="flex items-center gap-2 text-sm">
            <span>Sharing with <span className="font-medium">{target.label}</span></span>
            <Button type="button" variant="ghost" onClick={() => setTarget(null)}>Change</Button>
          </div>
        ) : (
          <div className="relative">
            <Input placeholder="Type a name, email or group (2+ letters)" value={query} onChange={(e) => setQuery(e.target.value)} />
            {(results.users.length > 0 || results.groups.length > 0) && (
              <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-slate-200 bg-white text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
                {results.groups.map((g) => (
                  <li key={g.id}><button type="button" className="w-full px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => { setTarget({ type: 'group', id: g.id, label: `group ${g.name}`, external: false }); setResults({ users: [], groups: [] }); }}>Group: {g.name} <span className="text-slate-500">({g.members})</span></button></li>
                ))}
                {results.users.filter((u) => u.id !== doc.owner.id).map((u) => (
                  <li key={u.id}><button type="button" className="w-full px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => { setTarget({ type: 'user', id: u.id, label: u.displayName, external: u.role === 'EXTERNAL' }); setLevel('READ'); setResults({ users: [], groups: [] }); }}>{u.displayName} <span className="text-slate-500">{u.email}</span> {u.role === 'EXTERNAL' && <Badge tone="amber">External</Badge>}</button></li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Label label="Access">
            <Select value={level} onChange={(e) => setLevel(e.target.value as Level)} disabled={target?.external}>
              <option value="READ">READ: view and download</option>
              {!target?.external && <option value="EDIT">EDIT: also rename and upload versions</option>}
              {!target?.external && doc.isOwner && <option value="MANAGE">MANAGE: also share and see history</option>}
            </Select>
          </Label>
          <Label label={target?.external ? 'Expires on (required for external)' : 'Expires on (optional)'}>
            <Input type="date" value={expires} required={target?.external} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setExpires(e.target.value)} />
          </Label>
          <div className="flex items-end"><Button type="submit" variant="primary" disabled={!target}>Share</Button></div>
        </div>
      </form>

      <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Suggested people</h3>
          <Button variant="ghost" onClick={() => api.get<{ suggestions: Suggestion[] }>(`/documents/${doc.id}/suggestions`).then((r) => setSuggestions(r.suggestions)).catch((err) => onError(errorText(err)))}>
            {suggestions ? 'Refresh' : 'Show suggestions'}
          </Button>
        </div>
        <p className="mt-1 text-xs text-slate-500">Based on who you shared similar documents with. Suggestions never grant access by themselves: you confirm each one, and both the suggestion and your decision are recorded.</p>
        {suggestions && suggestions.length === 0 && <p className="mt-2 text-sm text-slate-500">No suggestions for this document.</p>}
        {suggestions && suggestions.length > 0 && (
          <ul className="mt-2 divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {suggestions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>{s.type === 'group' ? `Group: ${s.name}` : s.name} <span className="text-slate-500">{s.type === 'user' ? s.detail : ''}</span><div className="text-xs text-slate-500">{s.why}</div></div>
                <Button onClick={() => void share(s.type === 'user' ? { userId: s.id } : { groupId: s.id }, s.level, null, true, s.name)}>Share {s.level}</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

interface HistoryEvent { seq: string; occurredAt: string; actorEmail: string | null; action: string; outcome: 'ALLOWED' | 'DENIED' | 'FAILED'; reason: string | null }

function History({ docId }: { docId: string }) {
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  useEffect(() => {
    api.get<{ events: HistoryEvent[] }>(`/documents/${docId}/history`).then((r) => setEvents(r.events)).catch(() => setEvents([]));
  }, [docId]);
  return (
    <Card title="History" actions={<span className="text-xs text-slate-500">Including refused attempts</span>}>
      {!events ? <p className="text-sm text-slate-500">Loading…</p> : events.length === 0 ? <Empty>No activity yet.</Empty> : (
        <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto text-sm dark:divide-slate-800">
          {events.map((e) => (
            <li key={e.seq} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <span className="font-mono text-xs">{e.action}</span> · {e.actorEmail ?? 'system'}
                {e.reason && <span className="text-xs text-slate-500"> ({e.reason})</span>}
                <div className="text-xs text-slate-500">{formatDate(e.occurredAt)}</div>
              </div>
              <Badge tone={e.outcome === 'ALLOWED' ? 'green' : e.outcome === 'DENIED' ? 'red' : 'amber'}>{e.outcome}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function OwnerActions(props: { doc: Doc; onTrash: () => void; onRestore: () => void; onPurge: () => void; onTransfer: (id: string) => void; onMove: (folderId: string | null) => void }) {
  const { doc } = props;
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [owners, setOwners] = useState<DirUser[]>([]);
  const [ownerQuery, setOwnerQuery] = useState('');
  useEffect(() => {
    api.get<{ folders: { id: string; name: string }[] }>('/folders').then((r) => setFolders(r.folders)).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (ownerQuery.trim().length < 2) return setOwners([]);
    const t = setTimeout(() => api.get<{ users: DirUser[] }>(`/directory?q=${encodeURIComponent(ownerQuery.trim())}`).then((r) => setOwners(r.users.filter((u) => u.role === 'OWNER'))).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [ownerQuery]);

  if (doc.status === 'DELETED') {
    return (
      <Card title="In the trash">
        <p className="mb-3 text-sm text-slate-500">Only you can see it. It is removed permanently after the retention period.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={props.onRestore}>Restore</Button>
          {confirmPurge
            ? <Button variant="danger" onClick={props.onPurge}>Yes, delete forever</Button>
            : <Button variant="danger" onClick={() => setConfirmPurge(true)}>Delete permanently</Button>}
        </div>
      </Card>
    );
  }
  return (
    <Card title="Owner actions">
      <div className="space-y-4 text-sm">
        {folders.length > 0 && (
          <Label label="Folder">
            <Select value={doc.folder?.id ?? ''} onChange={(e) => props.onMove(e.target.value || null)}>
              <option value="">No folder</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
          </Label>
        )}
        <div>
          <Label label="Transfer ownership" hint="The new owner gets full control. You keep no access unless they share it back.">
            <Input placeholder="Search document owners" value={ownerQuery} onChange={(e) => setOwnerQuery(e.target.value)} />
          </Label>
          {owners.map((o) => (
            <div key={o.id} className="mt-2 flex items-center justify-between">
              <span>{o.displayName} <span className="text-slate-500">{o.email}</span></span>
              <Button onClick={() => props.onTransfer(o.id)}>Transfer</Button>
            </div>
          ))}
        </div>
        <Button variant="danger" onClick={props.onTrash}>Move to trash</Button>
      </div>
    </Card>
  );
}
