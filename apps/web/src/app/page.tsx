'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { ACCESS_TONE, Alert, Badge, Button, Card, Empty, Input, Label, PageTitle, Select, Textarea } from '@/components/ui';
import { api, errorText, formatBytes, formatDate, type Access } from '@/lib/api';

interface DocItem {
  id: string;
  title: string;
  category: string;
  status: 'ACTIVE' | 'DELETED';
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  owner: { id: string; displayName: string; email: string };
  isOwner: boolean;
  myAccess: Access;
  folderId: string | null;
  current: { versionNo: number; fileName: string; sizeBytes: number } | null;
}

interface Folder {
  id: string;
  name: string;
  documents: number;
}

type Scope = 'all' | 'mine' | 'shared' | 'trash';
const SCOPES: { id: Scope; label: string; ownerOnly?: boolean }[] = [
  { id: 'all', label: 'All I can access' },
  { id: 'mine', label: 'Mine', ownerOnly: true },
  { id: 'shared', label: 'Shared with me' },
  { id: 'trash', label: 'Trash', ownerOnly: true },
];

const EMPTY_FILTERS = { q: '', owner: '', category: '', from: '', to: '', folderId: '' };

export default function DocumentsPage() {
  const { user } = useSession();
  const isOwnerRole = user?.role === 'OWNER';
  const [scope, setScope] = useState<Scope>('all');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; pageSize: number; documents: DocItem[] } | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ scope, page: String(page) });
    for (const [k, v] of Object.entries(applied)) if (v) params.set(k, k === 'to' ? `${v}T23:59:59` : v);
    try {
      setData(await api.get(`/documents?${params}`));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [scope, page, applied]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  useEffect(() => {
    if (!user) return;
    api.get<{ categories: string[] }>('/documents/categories').then((r) => setCategories(r.categories)).catch(() => undefined);
    if (user.role === 'OWNER') api.get<{ folders: Folder[] }>('/folders').then((r) => setFolders(r.folders)).catch(() => undefined);
  }, [user, data?.total]);

  const search = (e: FormEvent) => {
    e.preventDefault();
    setPage(1);
    setApplied(filters);
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Shell>
      <PageTitle
        title="Documents"
        subtitle="Only documents you own or have been given access to appear here. Search never shows anything else."
        actions={isOwnerRole && <Button variant="primary" onClick={() => setUploading(true)}>Upload document</Button>}
      />

      {uploading && (
        <UploadForm
          folders={folders}
          onClose={() => setUploading(false)}
          onUploaded={() => { setUploading(false); setScope('mine'); setPage(1); void load(); }}
        />
      )}

      <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {SCOPES.filter((s) => !s.ownerOnly || isOwnerRole).map((s) => (
          <button
            key={s.id}
            onClick={() => { setScope(s.id); setPage(1); }}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${scope === s.id ? 'border-brand-600 font-medium' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <form onSubmit={search} className="mb-6 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="lg:col-span-2"><Label label="Name or description"><Input value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} placeholder="e.g. board minutes" /></Label></div>
        <Label label="Owner"><Input value={filters.owner} onChange={(e) => setFilters({ ...filters, owner: e.target.value })} placeholder="name or email" /></Label>
        <Label label="Category">
          <Select value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
            <option value="">Any</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Label>
        <Label label="Uploaded from"><Input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></Label>
        <Label label="to"><Input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></Label>
        {isOwnerRole && folders.length > 0 && scope !== 'shared' && (
          <Label label="Folder">
            <Select value={filters.folderId} onChange={(e) => setFilters({ ...filters, folderId: e.target.value })}>
              <option value="">Any</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.documents})</option>)}
            </Select>
          </Label>
        )}
        <div className="flex items-end gap-2 lg:col-span-6">
          <Button type="submit" variant="primary">Search</Button>
          <Button type="button" variant="ghost" onClick={() => { setFilters(EMPTY_FILTERS); setApplied(EMPTY_FILTERS); setPage(1); }}>Clear</Button>
          {isOwnerRole && <FolderManager folders={folders} onChange={() => api.get<{ folders: Folder[] }>('/folders').then((r) => setFolders(r.folders))} />}
        </div>
      </form>

      {error && <div className="mb-4"><Alert>{error}</Alert></div>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
            <tr>
              <th className="px-4 py-3">Document</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Owner</th>
              <th className="px-4 py-3">Your access</th>
              <th className="px-4 py-3">{scope === 'trash' ? 'Deleted' : 'Updated'}</th>
            </tr>
          </thead>
          <tbody>
            {data?.documents.map((d) => (
              <tr key={d.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50">
                <td className="px-4 py-3">
                  <Link href={`/documents/${d.id}`} className="font-medium text-brand-600 hover:underline">{d.title}</Link>
                  {d.current && <div className="text-xs text-slate-500">{d.current.fileName} · v{d.current.versionNo} · {formatBytes(d.current.sizeBytes)}</div>}
                </td>
                <td className="px-4 py-3">{d.category}</td>
                <td className="px-4 py-3">{d.isOwner ? 'You' : d.owner.displayName}</td>
                <td className="px-4 py-3"><Badge tone={ACCESS_TONE[d.myAccess]}>{d.myAccess}</Badge></td>
                <td className="px-4 py-3 text-slate-500">{formatDate(scope === 'trash' ? d.deletedAt : d.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.documents.length === 0 && <Empty>{scope === 'trash' ? 'The trash is empty.' : 'No documents match.'}</Empty>}
      </div>

      {data && data.total > data.pageSize && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
          <span>{data.total} documents</span>
          <div className="flex gap-2">
            <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <span className="px-2 py-1.5">Page {page} of {pages}</span>
            <Button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        </div>
      )}
    </Shell>
  );
}

function UploadForm({ folders, onClose, onUploaded }: { folders: Folder[]; onClose: () => void; onUploaded: () => void }) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [folderId, setFolderId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set('title', title);
    form.set('category', category);
    if (description) form.set('description', description);
    if (folderId) form.set('folderId', folderId);
    form.set('file', file);
    try {
      await api.upload('/documents', form);
      onUploaded();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Upload a document" className="mb-6" actions={<Button variant="ghost" onClick={onClose}>Cancel</Button>}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Label label="Title"><Input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></Label>
        <Label label="Category" hint="e.g. HR, Legal, Finance"><Input required maxLength={60} value={category} onChange={(e) => setCategory(e.target.value)} /></Label>
        <div className="sm:col-span-2"><Label label="Description (optional)"><Textarea rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} /></Label></div>
        {folders.length > 0 && (
          <Label label="Folder (optional)">
            <Select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">None</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
          </Label>
        )}
        <Label label="File" hint="PDF, PNG, JPEG, Word, Excel, PowerPoint, text, CSV or Markdown. Up to 25 MB. Checked by content, not by name.">
          <Input type="file" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.pptx,.txt,.csv,.md" />
        </Label>
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" disabled={busy || !file}>{busy ? 'Encrypting and uploading…' : 'Upload'}</Button>
          <span className="ml-3 text-xs text-slate-500">Nobody else can see it until you share it.</span>
        </div>
      </form>
    </Card>
  );
}

function FolderManager({ folders, onChange }: { folders: Folder[]; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!open) return <Button type="button" variant="ghost" className="ml-auto" onClick={() => setOpen(true)}>Manage folders</Button>;
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      onChange();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      {folders.map((f) => (
        <span key={f.id} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">
          {f.name}
          <button type="button" aria-label={`Delete folder ${f.name}`} className="text-slate-500 hover:text-red-600" onClick={() => void act(() => api.delete(`/folders/${f.id}`))}>×</button>
        </span>
      ))}
      <Input className="w-40" placeholder="New folder" value={name} onChange={(e) => setName(e.target.value)} />
      <Button type="button" onClick={() => void act(async () => { await api.post('/folders', { name }); setName(''); })} disabled={!name.trim()}>Add</Button>
      <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Done</Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
