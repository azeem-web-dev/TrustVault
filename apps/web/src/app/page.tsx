'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import {
  CaretLeft, CaretRight, CloudArrowUp, Files, FolderSimple, FolderSimplePlus, FunnelSimple, MagnifyingGlass, Plus, ShareNetwork,
  SquaresFour, Rows, Tag, Trash, User, UsersThree, X, FileMagnifyingGlass, Vault, Stack,
} from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import {
  ACCESS_LABEL, ACCESS_TONE, Alert, Avatar, Badge, Button, EmptyState, FileIcon, IconButton, Input, Label, Modal, PageTitle, Segmented, Select,
  SkeletonRows, StatCard, Textarea, cx, fileType, relativeTime,
} from '@/components/ui';
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

interface Folder { id: string; name: string; documents: number }
type Scope = 'all' | 'mine' | 'shared' | 'trash';
type View = 'list' | 'grid';

const EMPTY_FILTERS = { q: '', owner: '', category: '', from: '', to: '', folderId: '' };

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function DocumentsPage() {
  const { user } = useSession();
  const toast = useToast();
  const isOwnerRole = user?.role === 'OWNER';
  const [scope, setScope] = useState<Scope>('all');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; pageSize: number; documents: DocItem[] } | null>(null);
  const [counts, setCounts] = useState<Partial<Record<Scope, number>>>({});
  const [categories, setCategories] = useState<string[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [view, setView] = useState<View>('list');

  useEffect(() => {
    try {
      if (localStorage.getItem('tv-docs-view') === 'grid') setView('grid');
    } catch { /* ignore */ }
  }, []);
  const changeView = (v: View) => {
    setView(v);
    try { localStorage.setItem('tv-docs-view', v); } catch { /* ignore */ }
  };

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

  // Instant search: apply the text box shortly after typing stops.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const t = setTimeout(() => { setPage(1); setApplied((a) => ({ ...a, q: filters.q })); }, 300);
    return () => clearTimeout(t);
  }, [filters.q]);

  const loadCounts = useCallback(async () => {
    if (!user) return;
    const scopes: Scope[] = user.role === 'OWNER' ? ['all', 'mine', 'shared', 'trash'] : ['all', 'shared'];
    const entries = await Promise.all(scopes.map(async (s) => {
      try {
        const r = await api.get<{ total: number }>(`/documents?scope=${s}&page=1`);
        return [s, r.total] as const;
      } catch {
        return [s, undefined] as const;
      }
    }));
    setCounts(Object.fromEntries(entries));
  }, [user]);

  const loadFolders = useCallback(() => api.get<{ folders: Folder[] }>('/folders').then((r) => setFolders(r.folders)).catch(() => undefined), []);

  useEffect(() => {
    if (!user) return;
    void loadCounts();
    api.get<{ categories: string[] }>('/documents/categories').then((r) => setCategories(r.categories)).catch(() => undefined);
    if (user.role === 'OWNER') void loadFolders();
  }, [user, data?.total, loadCounts, loadFolders]);

  const search = (e: FormEvent) => {
    e.preventDefault();
    setPage(1);
    setApplied(filters);
  };
  const setCategory = (c: string) => {
    const f = { ...filters, category: filters.category === c ? '' : c };
    setFilters(f);
    setApplied(f);
    setPage(1);
  };
  const clearAll = () => { setFilters(EMPTY_FILTERS); setApplied(EMPTY_FILTERS); setPage(1); };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const activeChips = [
    applied.owner && { k: 'owner', label: `Owner: ${applied.owner}` },
    applied.from && { k: 'from', label: `From ${applied.from}` },
    applied.to && { k: 'to', label: `To ${applied.to}` },
    applied.folderId && { k: 'folderId', label: `Folder: ${folders.find((f) => f.id === applied.folderId)?.name ?? '…'}` },
  ].filter(Boolean) as { k: keyof typeof EMPTY_FILTERS; label: string }[];

  const scopeOptions = [
    { id: 'all' as const, label: 'All I can access', icon: <Stack size={16} />, count: counts.all },
    ...(isOwnerRole ? [{ id: 'mine' as const, label: 'Mine', icon: <User size={16} />, count: counts.mine }] : []),
    { id: 'shared' as const, label: 'Shared with me', icon: <ShareNetwork size={16} />, count: counts.shared },
    ...(isOwnerRole ? [{ id: 'trash' as const, label: 'Trash', icon: <Trash size={16} />, count: counts.trash }] : []),
  ];

  return (
    <Shell>
      <PageTitle
        eyebrow={`${greeting()}, ${user?.displayName.split(' ')[0] ?? ''}`}
        title="Documents"
        icon={<Files size={26} />}
        subtitle="Only documents you own or have been given access to appear here. Search never shows anything else."
        actions={isOwnerRole && (
          <>
            <Button icon={<FolderSimple size={18} />} onClick={() => setFoldersOpen(true)}>Folders</Button>
            <Button variant="primary" icon={<CloudArrowUp size={18} />} onClick={() => setUploading(true)}>Upload document</Button>
          </>
        )}
      />

      <div className="mb-7 grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatCard label="You can open" value={counts.all ?? '–'} icon={<Vault size={22} />} hint="Owned by you or shared with you" />
        {isOwnerRole
          ? <StatCard label="Owned by you" value={counts.mine ?? '–'} icon={<User size={22} />} tone="violet" hint="Only you decide who sees these" delay={60} />
          : <StatCard label="Your role" value={<span className="text-lg">{user?.role === 'EXTERNAL' ? 'External' : user?.role === 'ADMIN' ? 'Admin' : 'Viewer'}</span>} icon={<User size={22} />} tone="violet" hint={user?.role === 'EXTERNAL' ? 'Read-only, until access ends' : user?.role === 'ADMIN' ? 'Admins manage people, not documents' : 'You can open what is shared'} delay={60} />}
        <StatCard label="Shared with you" value={counts.shared ?? '–'} icon={<UsersThree size={22} />} tone="green" hint="Directly or through a group" delay={120} />
        <StatCard label="Categories" value={categories.length} icon={<Tag size={22} />} tone="amber" hint={categories.slice(0, 3).join(', ') || 'None yet'} delay={180} />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented value={scope} onChange={(s) => { setScope(s); setPage(1); }} options={scopeOptions} />
        <div className="flex items-center gap-1 rounded-xl border border-slate-200/80 bg-white p-1 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.04]">
          <IconButton label="List view" onClick={() => changeView('list')} className={cx('size-8', view === 'list' && 'bg-slate-100 text-slate-900 dark:bg-white/10 dark:text-white')}><Rows size={18} /></IconButton>
          <IconButton label="Grid view" onClick={() => changeView('grid')} className={cx('size-8', view === 'grid' && 'bg-slate-100 text-slate-900 dark:bg-white/10 dark:text-white')}><SquaresFour size={18} /></IconButton>
        </div>
      </div>

      <form onSubmit={search} className="mb-4 rounded-2xl border border-slate-200/80 bg-white p-3 shadow-soft dark:border-white/[0.08] dark:bg-white/[0.03]">
        <div className="flex flex-wrap gap-2">
          <Input
            className="min-w-[220px] flex-1"
            icon={<MagnifyingGlass size={18} />}
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            placeholder="Search by name or description, e.g. board minutes"
            aria-label="Name or description"
          />
          <Button type="button" icon={<FunnelSimple size={18} />} onClick={() => setShowFilters((s) => !s)} className={cx(showFilters && 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-400/40 dark:bg-brand-500/15 dark:text-brand-200')}>
            Filters{activeChips.length > 0 && <span className="rounded-md bg-brand-600 px-1.5 text-[11px] text-white">{activeChips.length}</span>}
          </Button>
        </div>
        {showFilters && (
          <div className="mt-3 grid animate-pop gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2 lg:grid-cols-5 dark:border-white/[0.06]">
            <Label label="Owner"><Input value={filters.owner} onChange={(e) => setFilters({ ...filters, owner: e.target.value })} placeholder="name or email" /></Label>
            <Label label="Category">
              <Select value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
                <option value="">Any</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Label>
            <Label label="Uploaded from"><Input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></Label>
            <Label label="to"><Input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></Label>
            {isOwnerRole && folders.length > 0 && scope !== 'shared' ? (
              <Label label="Folder">
                <Select value={filters.folderId} onChange={(e) => setFilters({ ...filters, folderId: e.target.value })}>
                  <option value="">Any</option>
                  {folders.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.documents})</option>)}
                </Select>
              </Label>
            ) : <span className="hidden lg:block" />}
            <div className="flex gap-2 sm:col-span-2 lg:col-span-5">
              <Button type="submit" variant="primary" icon={<MagnifyingGlass size={16} />}>Apply filters</Button>
              <Button type="button" variant="ghost" onClick={clearAll}>Clear all</Button>
            </div>
          </div>
        )}
      </form>

      {(categories.length > 0 || activeChips.length > 0) && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={cx(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition',
                applied.category === c ? 'border-brand-500 bg-brand-gradient text-white shadow-glow' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900 dark:border-white/10 dark:bg-white/5 dark:text-slate-300 dark:hover:text-white',
              )}
            >
              <Tag size={13} />{c}
            </button>
          ))}
          {activeChips.map((chip) => (
            <span key={chip.k} className="inline-flex items-center gap-1 rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white dark:bg-white dark:text-slate-900">
              {chip.label}
              <button aria-label={`Remove ${chip.label}`} onClick={() => { const f = { ...applied, [chip.k]: '' }; setFilters(f); setApplied(f); }}><X size={12} weight="bold" /></button>
            </span>
          ))}
        </div>
      )}

      {error && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}

      {!data ? (
        <div className="rounded-2xl border border-slate-200/80 bg-white shadow-soft dark:border-white/[0.08] dark:bg-white/[0.03]"><SkeletonRows rows={6} /></div>
      ) : data.documents.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 dark:border-white/10 dark:bg-white/[0.02]">
          {scope === 'trash' ? (
            <EmptyState art={<SpotArt icon={<Trash size={30} />} tone="slate" />} title="The trash is empty">Documents you delete stay here, visible only to you, until the retention period ends.</EmptyState>
          ) : Object.values(applied).some(Boolean) ? (
            <EmptyState art={<SpotArt icon={<FileMagnifyingGlass size={30} />} />} title="No documents match" action={<Button onClick={clearAll}>Clear search and filters</Button>}>
              Search only covers documents you can access, so something shared with others but not you will never appear.
            </EmptyState>
          ) : (
            <EmptyState
              art={<SpotArt icon={<Files size={30} />} />}
              title={isOwnerRole ? 'Upload your first document' : 'Nothing has been shared with you yet'}
              action={isOwnerRole && <Button variant="primary" icon={<Plus size={16} weight="bold" />} onClick={() => setUploading(true)}>Upload document</Button>}
            >
              {isOwnerRole ? 'It is encrypted, scanned for malware, and visible to nobody until you share it.' : 'When someone shares a document with you, it appears here.'}
            </EmptyState>
          )}
        </div>
      ) : view === 'list' ? (
        <DocTable docs={data.documents} trash={scope === 'trash'} />
      ) : (
        <DocGrid docs={data.documents} trash={scope === 'trash'} />
      )}

      {data && data.total > data.pageSize && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
          <span>Showing {(page - 1) * data.pageSize + 1}–{Math.min(page * data.pageSize, data.total)} of {data.total}</span>
          <div className="flex items-center gap-2">
            <Button size="sm" icon={<CaretLeft size={14} weight="bold" />} disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <span className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium tabular-nums shadow-sm dark:bg-white/5">Page {page} of {pages}</span>
            <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next <CaretRight size={14} weight="bold" /></Button>
          </div>
        </div>
      )}

      <UploadModal
        open={uploading}
        folders={folders}
        categories={categories}
        onClose={() => setUploading(false)}
        onUploaded={(title) => { setUploading(false); setScope('mine'); setPage(1); toast(`“${title}” uploaded. Nobody else can see it until you share it.`); void load(); }}
      />
      <FolderModal open={foldersOpen} folders={folders} onClose={() => setFoldersOpen(false)} onChange={() => void loadFolders()} />
    </Shell>
  );
}

function DocTable({ docs, trash }: { docs: DocItem[]; trash: boolean }) {
  const router = useRouter();
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-soft dark:border-white/[0.08] dark:bg-white/[0.03]">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-100 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-slate-400">
            <tr>
              <th className="px-5 py-3">Document</th>
              <th className="hidden px-4 py-3 md:table-cell">Category</th>
              <th className="hidden px-4 py-3 sm:table-cell">Owner</th>
              <th className="px-4 py-3">Your access</th>
              <th className="hidden px-4 py-3 lg:table-cell">{trash ? 'Deleted' : 'Updated'}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-white/[0.05]">
            {docs.map((d, i) => (
              <tr
                key={d.id}
                style={{ animationDelay: `${i * 25}ms` }}
                onClick={() => router.push(`/documents/${d.id}`)}
                className="group animate-rise cursor-pointer transition hover:bg-brand-50/40 dark:hover:bg-white/[0.03]"
              >
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <FileIcon fileName={d.current?.fileName} />
                    <div className="min-w-0">
                      <Link href={`/documents/${d.id}`} onClick={(e) => e.stopPropagation()} className="block truncate font-semibold text-slate-900 group-hover:text-brand-700 dark:text-slate-100 dark:group-hover:text-brand-200">{d.title}</Link>
                      {d.current && <div className="truncate text-xs text-slate-500 dark:text-slate-400">{d.current.fileName} · v{d.current.versionNo} · {formatBytes(d.current.sizeBytes)}</div>}
                    </div>
                  </div>
                </td>
                <td className="hidden px-4 py-3.5 md:table-cell"><Badge icon={<Tag size={11} />}>{d.category}</Badge></td>
                <td className="hidden px-4 py-3.5 sm:table-cell">
                  <div className="flex items-center gap-2">
                    <Avatar name={d.owner.displayName} size="xs" />
                    <span className="truncate">{d.isOwner ? 'You' : d.owner.displayName}</span>
                  </div>
                </td>
                <td className="px-4 py-3.5"><Badge dot tone={ACCESS_TONE[d.myAccess]}>{ACCESS_LABEL[d.myAccess]}</Badge></td>
                <td className="hidden whitespace-nowrap px-4 py-3.5 text-slate-500 lg:table-cell dark:text-slate-400" title={formatDate(trash ? d.deletedAt : d.updatedAt)}>{relativeTime(trash ? d.deletedAt : d.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DocGrid({ docs, trash }: { docs: DocItem[]; trash: boolean }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {docs.map((d, i) => (
        <Link
          key={d.id}
          href={`/documents/${d.id}`}
          style={{ animationDelay: `${i * 30}ms` }}
          className="group relative flex animate-rise flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-4 shadow-soft transition hover:-translate-y-1 hover:border-brand-200 hover:shadow-lift dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:border-brand-400/30"
        >
          <div className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-slate-50 to-transparent dark:from-white/[0.03]" />
          <div className="relative flex items-start justify-between">
            <FileIcon fileName={d.current?.fileName} size="lg" />
            <Badge dot tone={ACCESS_TONE[d.myAccess]}>{ACCESS_LABEL[d.myAccess]}</Badge>
          </div>
          <p className="relative mt-4 line-clamp-2 font-semibold leading-snug group-hover:text-brand-700 dark:group-hover:text-brand-200">{d.title}</p>
          <p className="relative mt-1 truncate text-xs text-slate-500 dark:text-slate-400">
            {d.current ? `${fileType(d.current.fileName).label} · ${formatBytes(d.current.sizeBytes)} · v${d.current.versionNo}` : 'No file'}
          </p>
          <div className="relative mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs dark:border-white/[0.06]">
            <span className="flex min-w-0 items-center gap-2"><Avatar name={d.owner.displayName} size="xs" /><span className="truncate">{d.isOwner ? 'You' : d.owner.displayName}</span></span>
            <span className="shrink-0 text-slate-400">{relativeTime(trash ? d.deletedAt : d.updatedAt)}</span>
          </div>
          <span className="relative mt-2"><Badge icon={<Tag size={11} />}>{d.category}</Badge></span>
        </Link>
      ))}
    </div>
  );
}

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.docx,.xlsx,.pptx,.txt,.csv,.md';

function UploadModal({ open, folders, categories, onClose, onUploaded }: { open: boolean; folders: Folder[]; categories: string[]; onClose: () => void; onUploaded: (title: string) => void }) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [folderId, setFolderId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) { setTitle(''); setCategory(''); setDescription(''); setFolderId(''); setFile(null); setError(null); }
  }, [open]);

  const pick = (f: File | null) => {
    setFile(f);
    if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    pick(e.dataTransfer.files?.[0] ?? null);
  };

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
      onUploaded(title);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      icon={<CloudArrowUp size={22} />}
      title="Upload a document"
      description="Encrypted with its own key, scanned for malware, and private until you share it."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" form="upload-form" variant="primary" loading={busy} disabled={!file} icon={<CloudArrowUp size={18} />}>{busy ? 'Encrypting and uploading…' : 'Upload'}</Button>
      </>}
    >
      <form id="upload-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          onClick={() => picker.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && picker.current?.click()}
          className={cx(
            'flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 text-center transition sm:col-span-2',
            drag ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10' : file ? 'border-emerald-300 bg-emerald-50/50 dark:border-emerald-500/40 dark:bg-emerald-500/5' : 'border-slate-300 hover:border-brand-400 hover:bg-slate-50 dark:border-white/15 dark:hover:bg-white/[0.03]',
          )}
        >
          <input ref={picker} type="file" className="hidden" accept={ACCEPT} onChange={(e) => pick(e.target.files?.[0] ?? null)} aria-label="File" />
          {file ? (
            <div className="flex items-center gap-3 text-left">
              <FileIcon fileName={file.name} size="lg" />
              <div className="min-w-0">
                <p className="truncate font-semibold">{file.name}</p>
                <p className="text-xs text-slate-500">{formatBytes(file.size)} · {fileType(file.name).label} · click to change</p>
              </div>
            </div>
          ) : (
            <>
              <span className="mb-3 inline-flex size-12 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-glow"><CloudArrowUp size={24} /></span>
              <p className="text-sm font-semibold">Drop a file here, or <span className="text-brand-600 dark:text-brand-300">browse</span></p>
              <p className="mt-1 text-xs text-slate-500">PDF, images, Word, Excel, PowerPoint, text, CSV or Markdown · up to 25 MB · checked by content, not by name</p>
            </>
          )}
        </div>
        <Label label="Title"><Input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Salary letter 2026" /></Label>
        <Label label="Category" hint="e.g. HR, Legal, Finance">
          <Input required maxLength={60} value={category} onChange={(e) => setCategory(e.target.value)} list="tv-categories" placeholder="Pick or type" />
          <datalist id="tv-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Label>
        <div className="sm:col-span-2"><Label label="Description (optional)"><Textarea rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is it, who is it for?" /></Label></div>
        {folders.length > 0 && (
          <Label label="Folder (optional)">
            <Select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">None</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
          </Label>
        )}
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
      </form>
    </Modal>
  );
}

function FolderModal({ open, folders, onClose, onChange }: { open: boolean; folders: Folder[]; onClose: () => void; onChange: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      setError(null);
      toast(msg);
      onChange();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal open={open} onClose={onClose} icon={<FolderSimple size={22} />} title="Your folders" description="Folders only organise your own documents. They are never shared: access is always granted per document.">
      <div className="space-y-4">
        <form onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.post('/folders', { name }); setName(''); }, `Folder “${name}” created`); }} className="flex gap-2">
          <Input className="flex-1" icon={<FolderSimplePlus size={18} />} placeholder="New folder name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <Button type="submit" variant="primary" disabled={!name.trim()}>Add</Button>
        </form>
        {error && <Alert>{error}</Alert>}
        {folders.length === 0 ? (
          <EmptyState art={<SpotArt icon={<FolderSimple size={30} />} tone="amber" />} title="No folders yet">Create one to keep your documents tidy.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-white/[0.06] dark:border-white/10">
            {folders.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-3 py-2.5">
                <span className="inline-flex size-9 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300"><FolderSimple size={18} /></span>
                <span className="flex-1">
                  <span className="block text-sm font-medium">{f.name}</span>
                  <span className="block text-xs text-slate-500">{f.documents} document{f.documents === 1 ? '' : 's'}</span>
                </span>
                <IconButton label={`Delete folder ${f.name}`} onClick={() => void act(() => api.delete(`/folders/${f.id}`), `Folder “${f.name}” deleted`)} className="hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"><Trash size={18} /></IconButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
