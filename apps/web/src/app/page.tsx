'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import {
  ArrowClockwise, CaretLeft, CaretRight, CloudArrowUp, Files, FolderSimple, FolderSimplePlus, FunnelSimple, GearSix, MagnifyingGlass, Plus, ShareNetwork,
  SquaresFour, Rows, Tag, Trash, User, UsersThree, X, FileMagnifyingGlass, Vault, Stack,
} from '@phosphor-icons/react';
import { Shell, useCloseAtDesktop } from '@/components/shell';
import { FolderTree } from '@/components/folder-tree';
import { useSession } from '@/components/session';
import { useToast } from '@/components/toast';
import { removedNotice, type UploadResult } from '@/lib/sanitized';
import { SpotArt } from '@/components/art';
import {
  ACCESS_LABEL, ACCESS_TONE, Alert, Avatar, Badge, Button, Drawer, EmptyState, FileIcon, IconButton, IconTile, Input, Label, LoadError, Modal, PageTitle, Segmented, Select,
  SkeletonRows, StatCard, Textarea, cx, fileType, relativeTime, staggerClass, useConfirm,
} from '@/components/ui';
import { api, errorText, formatBytes, formatDate, type Access } from '@/lib/api';
import { useAction, useLatest } from '@/lib/hooks';
import { localDayEndISO, localDayStartISO } from '@/lib/dates';

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
/** A result page remembers the scope it was fetched for, so rows never render under another scope's columns (D6). */
interface DocPage { total: number; pageSize: number; documents: DocItem[]; scope: Scope }

const EMPTY_FILTERS = { q: '', owner: '', category: '', from: '', to: '', folderId: '' };

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** Query value for one filter: date-only inputs become the local day's bounds (X6). */
function filterParam(k: keyof typeof EMPTY_FILTERS, v: string): string | undefined {
  if (k === 'from') return localDayStartISO(v);
  if (k === 'to') return localDayEndISO(v);
  return v;
}

export default function DocumentsPage() {
  const { user } = useSession();
  const toast = useToast();
  const userId = user?.id;
  const role = user?.role;
  const isOwnerRole = role === 'OWNER';
  const [scope, setScope] = useState<Scope>('all');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [treeVersion, setTreeVersion] = useState(0);
  const [data, setData] = useState<DocPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [counts, setCounts] = useState<Partial<Record<Scope, number>>>({});
  const [categories, setCategories] = useState<string[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [treeDrawer, setTreeDrawer] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [view, setView] = useState<View>('list');
  const latest = useLatest();
  useCloseAtDesktop(treeDrawer, () => setTreeDrawer(false));
  const appliedRef = useRef(applied);
  useEffect(() => { appliedRef.current = applied; });

  useEffect(() => {
    try {
      if (localStorage.getItem('tv-docs-view') === 'grid') setView('grid');
    } catch { /* ignore */ }
  }, []);
  const changeView = (v: View) => {
    setView(v);
    try { localStorage.setItem('tv-docs-view', v); } catch { /* ignore */ }
  };

  // One list request at a time: a newer one aborts the older, and only the
  // newest response is used (D1, X5). `reloadKey` forces a refetch.
  const load = useCallback(async () => {
    const ticket = latest.begin();
    const params = new URLSearchParams({ scope, page: String(page) });
    for (const [k, v] of Object.entries(applied) as [keyof typeof EMPTY_FILTERS, string][]) {
      const value = v ? filterParam(k, v) : undefined;
      if (value) params.set(k, value);
    }
    setLoading(true);
    try {
      const r = await api.get<Omit<DocPage, 'scope'>>(`/documents?${params}`, { signal: ticket.signal });
      if (!ticket.isLatest()) return;
      setData({ ...r, scope });
      setError(null);
    } catch (err) {
      if (!ticket.isLatest()) return;
      setError(errorText(err));
    } finally {
      if (ticket.isLatest()) setLoading(false);
    }
  }, [scope, page, applied, reloadKey, latest]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (userId) void load();
  }, [userId, load]);
  const reload = () => setReloadKey((k) => k + 1);

  // Instant search: apply the text box shortly after typing stops.
  useEffect(() => {
    if (filters.q === appliedRef.current.q) return;
    const t = setTimeout(() => { setPage(1); setApplied((a) => ({ ...a, q: filters.q })); }, 300);
    return () => clearTimeout(t);
  }, [filters.q]);

  const loadCounts = useCallback(async () => {
    if (!userId) return;
    const scopes: Scope[] = role === 'OWNER' ? ['all', 'mine', 'shared', 'trash'] : ['all', 'shared'];
    const entries = await Promise.all(scopes.map(async (s) => {
      try {
        const r = await api.get<{ total: number }>(`/documents?scope=${s}&page=1`);
        return [s, r.total] as const;
      } catch {
        return [s, undefined] as const;
      }
    }));
    setCounts(Object.fromEntries(entries));
  }, [userId, role]);

  const loadCategories = useCallback(
    () => api.get<{ categories: string[] }>('/documents/categories').then((r) => setCategories(r.categories)).catch(() => setCategories((c) => c ?? [])),
    [],
  );
  const loadFolders = useCallback(() => api.get<{ folders: Folder[] }>('/folders').then((r) => setFolders(r.folders)).catch(() => undefined), []);

  // Counts, categories and folders load once per user and again after a
  // mutation on this page, not on every search result (D8).
  useEffect(() => {
    if (!userId) return;
    void loadCounts();
    void loadCategories();
    if (role === 'OWNER') void loadFolders();
  }, [userId, role, loadCounts, loadCategories, loadFolders]);

  // Keep the page in range when the total shrinks.
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  useEffect(() => {
    if (data && data.scope === scope && page > pages) setPage(pages);
  }, [data, scope, page, pages]);

  const changeScope = (s: Scope, opts: { keepFolder?: boolean } = {}) => {
    if (s !== scope) {
      setScope(s);
      setData(null); // show the skeleton, not the previous scope's rows (D6)
      setError(null);
    }
    setPage(1);
    // Folders only hold your own documents: a folder filter can never match "Shared with me" (D6).
    if (s === 'shared' && !opts.keepFolder) {
      setFilters((f) => ({ ...f, folderId: '' }));
      setApplied((a) => (a.folderId ? { ...a, folderId: '' } : a));
    }
  };

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
  // Picking a folder in the explorer filters the list to it (folders only
  // apply to your own documents, so switch scope accordingly).
  const selectFolder = (id: string | null) => {
    if (id) changeScope('mine');
    setPage(1);
    setFilters((f) => ({ ...f, folderId: id ?? '' }));
    setApplied((a) => ({ ...a, folderId: id ?? '' }));
    setTreeDrawer(false);
  };
  const removeChip = (k: keyof typeof EMPTY_FILTERS) => {
    const f = { ...appliedRef.current, [k]: '' };
    setFilters((cur) => ({ ...cur, [k]: '' }));
    setApplied(f);
    setPage(1); // D7
  };

  const onFolderDeleted = (id: string) => {
    if (appliedRef.current.folderId === id) {
      setFilters((f) => ({ ...f, folderId: '' }));
      setApplied((a) => ({ ...a, folderId: '' }));
      setPage(1);
    }
    void loadFolders();
    setTreeVersion((v) => v + 1);
    reload();
  };

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

  const tree = (
    <FolderTree folders={folders} selectedFolderId={applied.folderId || null} onSelectFolder={selectFolder} version={treeVersion} />
  );

  return (
    <Shell>
      <PageTitle
        eyebrow={`${greeting()}, ${user?.displayName.split(' ')[0] ?? ''}`}
        title="Documents"
        icon={<Files size={26} />}
        subtitle="Only documents you own or have been given access to appear here. Search never shows anything else."
        actions={isOwnerRole && (
          <Button variant="primary" icon={<CloudArrowUp size={18} />} onClick={() => setUploading(true)}>Upload document</Button>
        )}
      />

      <div className="mb-7 grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatCard label="You can open" value={counts.all ?? '–'} icon={<Vault size={22} />} hint="Owned by you or shared with you" />
        {isOwnerRole
          ? <StatCard label="Owned by you" value={counts.mine ?? '–'} icon={<User size={22} />} tone="violet" hint="Only you decide who sees these" delay={40} />
          : <StatCard label="Your role" value={<span className="text-lg">{role === 'EXTERNAL' ? 'External' : role === 'ADMIN' ? 'Admin' : 'Viewer'}</span>} icon={<User size={22} />} tone="violet" hint={role === 'EXTERNAL' ? 'Read-only, until access ends' : role === 'ADMIN' ? 'Admins manage people, not documents' : 'You can open what is shared'} delay={40} />}
        <StatCard label="Shared with you" value={counts.shared ?? '–'} icon={<UsersThree size={22} />} tone="green" hint="Directly or through a group" delay={80} />
        <StatCard label="Categories" value={categories ? categories.length : '–'} icon={<Tag size={22} />} tone="amber" hint={categories ? categories.slice(0, 3).join(', ') || 'None yet' : 'Loading…'} delay={120} />
      </div>

      <div className="flex gap-6">
        {isOwnerRole && (
          <aside className="hidden w-[16.5rem] shrink-0 lg:block" aria-label="Folder explorer">
            <div className="sticky top-24 flex max-h-[calc(100dvh-7rem)] animate-rise flex-col rounded-2xl border border-line bg-surface p-2 shadow-soft">
              <div className="flex items-center justify-between px-2 py-1">
                <p className="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle"><FolderSimple size={14} weight="fill" aria-hidden className="text-amber-500" />Explorer</p>
                <IconButton label="Create and manage folders" className="size-8" onClick={() => setFoldersOpen(true)}><GearSix size={16} /></IconButton>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">{tree}</div>
            </div>
          </aside>
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 max-w-full items-center gap-2">
              {isOwnerRole && (
                <Button
                  className="lg:hidden"
                  icon={<FolderSimple size={18} />}
                  aria-haspopup="dialog"
                  aria-expanded={treeDrawer}
                  onClick={() => setTreeDrawer(true)}
                >
                  Folders
                </Button>
              )}
              <Segmented mode="filter" label="Show" className="min-w-0" value={scope} onChange={(s) => changeScope(s)} options={scopeOptions} />
            </div>
            <div role="group" aria-label="Layout" className="flex shrink-0 items-center gap-1 rounded-xl border border-line bg-surface p-1 shadow-sm">
              <IconButton label="List view" aria-pressed={view === 'list'} onClick={() => changeView('list')} className={cx('size-8', view === 'list' && 'bg-brand-50 text-brand-700 hover:bg-brand-100 hover:text-brand-700 dark:bg-brand-500/15 dark:text-brand-200 dark:hover:bg-brand-500/25 dark:hover:text-brand-100')}><Rows size={18} /></IconButton>
              <IconButton label="Grid view" aria-pressed={view === 'grid'} onClick={() => changeView('grid')} className={cx('size-8', view === 'grid' && 'bg-brand-50 text-brand-700 hover:bg-brand-100 hover:text-brand-700 dark:bg-brand-500/15 dark:text-brand-200 dark:hover:bg-brand-500/25 dark:hover:text-brand-100')}><SquaresFour size={18} /></IconButton>
            </div>
          </div>

          <form onSubmit={search} role="search" className="mb-4 rounded-2xl border border-line bg-surface p-3 shadow-soft">
            <div className="flex flex-wrap gap-2">
              <Input
                className="min-w-[min(13.75rem,100%)] flex-1"
                icon={<MagnifyingGlass size={18} />}
                type="search"
                value={filters.q}
                onChange={(e) => setFilters({ ...filters, q: e.target.value })}
                placeholder="Search by name or description, e.g. board minutes"
                aria-label="Name or description"
              />
              <Button
                type="button"
                icon={<FunnelSimple size={18} />}
                aria-expanded={showFilters}
                aria-controls="doc-filters"
                onClick={() => setShowFilters((s) => !s)}
                className={cx(showFilters && 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-400/40 dark:bg-brand-500/15 dark:text-brand-200')}
              >
                Filters{activeChips.length > 0 && <span className="animate-pop rounded-md bg-brand-600 px-1.5 text-[0.6875rem] tabular-nums text-white">{activeChips.length}</span>}
              </Button>
            </div>
            {/* Expands and collapses (grid 0fr -> 1fr); the closed panel is inert. */}
            <div
              className={cx('grid transition-[grid-template-rows,opacity] duration-200 ease-out', showFilters ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}
              inert={!showFilters || undefined}
            >
              <div className="-mx-1 min-h-0 overflow-hidden px-1">
              <div id="doc-filters" className="mb-1 mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-5">
                <Label label="Owner"><Input value={filters.owner} onChange={(e) => setFilters({ ...filters, owner: e.target.value })} placeholder="name or email" /></Label>
                <Label label="Category">
                  <Select value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
                    <option value="">Any</option>
                    {(categories ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                </Label>
                <Label label="Uploaded from"><Input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></Label>
                <Label label="Uploaded to"><Input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></Label>
                {isOwnerRole && folders.length > 0 && scope !== 'shared' ? (
                  <Label label="Folder">
                    <Select value={filters.folderId} onChange={(e) => setFilters({ ...filters, folderId: e.target.value })}>
                      <option value="">Any</option>
                      {folders.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.documents})</option>)}
                    </Select>
                  </Label>
                ) : <span className="hidden lg:block" />}
                <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-5">
                  <Button type="submit" variant="primary" icon={<MagnifyingGlass size={16} />}>Apply filters</Button>
                  <Button type="button" variant="ghost" icon={<X size={16} weight="bold" />} onClick={clearAll}>Clear all</Button>
                </div>
              </div>
              </div>
            </div>
          </form>

          {((categories?.length ?? 0) > 0 || activeChips.length > 0) && (
            <div className="mb-5 flex animate-fade-in flex-wrap items-center gap-2">
              {(categories ?? []).map((c) => {
                const on = applied.category === c;
                return (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setCategory(c)}
                    className={cx(
                      'relative inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50',
                      'pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-1.5',
                      on ? 'border-brand-500 bg-brand-gradient text-white shadow-glow' : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg active:bg-slate-100 dark:active:bg-white/10',
                    )}
                  >
                    <Tag size={14} aria-hidden />{c}
                  </button>
                );
              })}
              {activeChips.map((chip) => (
                <span key={chip.k} className="inline-flex min-h-8 animate-pop items-center gap-1 rounded-full bg-fg py-1 pl-3 pr-1.5 text-xs font-medium text-bg shadow-sm">
                  {chip.label}
                  <button
                    type="button"
                    aria-label={`Remove ${chip.label}`}
                    onClick={() => removeChip(chip.k)}
                    className="relative grid size-6 place-items-center rounded-full transition duration-150 hover:bg-bg/20 active:scale-90 active:bg-bg/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 after:absolute after:-inset-2.5"
                  >
                    <X size={12} weight="bold" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {error && data && (
            <div className="mb-4 animate-fade-in">
              <Alert
                onDismiss={() => setError(null)}
                action={<Button size="sm" icon={<ArrowClockwise size={14} weight="bold" />} loading={loading} onClick={reload}>Try again</Button>}
              >
                {error}
              </Alert>
            </div>
          )}

          {!data ? (
            <div className="animate-fade-in rounded-2xl border border-line bg-surface shadow-soft">
              {error
                ? <LoadError error={error} title="Couldn't load your documents" onRetry={reload} retrying={loading} />
                : <SkeletonRows rows={6} label="Loading documents…" />}
            </div>
          ) : data.documents.length === 0 ? (
            <div className="animate-fade-in rounded-2xl border border-dashed border-line-strong bg-white/60 dark:bg-white/[0.02]">
              {data.scope === 'trash' ? (
                <EmptyState art={<SpotArt icon={<Trash size={30} />} tone="slate" />} title="The trash is empty">Documents you delete stay here, visible only to you, until the retention period ends.</EmptyState>
              ) : Object.values(applied).some(Boolean) ? (
                <EmptyState art={<SpotArt icon={<FileMagnifyingGlass size={30} />} />} title="No documents match" action={<Button icon={<X size={16} weight="bold" />} onClick={clearAll}>Clear search and filters</Button>}>
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
            <DocTable docs={data.documents} trash={data.scope === 'trash'} busy={loading} />
          ) : (
            <DocGrid docs={data.documents} trash={data.scope === 'trash'} busy={loading} />
          )}

          {data && data.total > data.pageSize && (
            <nav aria-label="Pages" className="mt-5 flex animate-fade-in flex-wrap items-center justify-between gap-3 text-sm text-fg-subtle">
              <span className="tabular-nums">Showing {(page - 1) * data.pageSize + 1}–{Math.min(page * data.pageSize, data.total)} of {data.total}</span>
              <div className="flex items-center gap-2">
                <Button size="sm" icon={<CaretLeft size={14} weight="bold" />} disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <span aria-current="page" className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium tabular-nums text-fg-muted shadow-sm">Page {page} of {pages}</span>
                <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next <CaretRight size={14} weight="bold" aria-hidden /></Button>
              </div>
            </nav>
          )}
        </div>
      </div>

      {isOwnerRole && (
        <Drawer
          open={treeDrawer}
          onClose={() => setTreeDrawer(false)}
          title="Folders"
          closeLabel="Close folders"
          rootClassName="lg:hidden"
          footer={<Button className="w-full" icon={<GearSix size={16} />} onClick={() => { setTreeDrawer(false); setFoldersOpen(true); }}>Manage folders</Button>}
        >
          <div className="p-2">{tree}</div>
        </Drawer>
      )}

      <UploadModal
        open={uploading}
        folders={folders}
        categories={categories ?? []}
        defaultFolderId={applied.folderId}
        onClose={() => setUploading(false)}
        onUploaded={(title, removed) => {
          setUploading(false);
          // Land on page 1 of "Mine", where the new document is. The list
          // effect refetches once with the new scope (no stale load(), D1).
          changeScope('mine', { keepFolder: true });
          reload();
          void loadCounts();
          void loadCategories();
          void loadFolders();
          setTreeVersion((v) => v + 1);
          const note = removedNotice(removed);
          if (note) toast(`“${title}” uploaded. ${note} The rest of the document is unchanged.`, 'info');
          else toast(`“${title}” uploaded. Nobody else can see it until you share it.`);
        }}
      />
      <FolderModal
        open={foldersOpen}
        folders={folders}
        onClose={() => setFoldersOpen(false)}
        onChange={() => void loadFolders()}
        onDeleted={onFolderDeleted}
      />
    </Shell>
  );
}

function DocTable({ docs, trash, busy }: { docs: DocItem[]; trash: boolean; busy?: boolean }) {
  const router = useRouter();
  return (
    <div aria-busy={busy || undefined} className={cx('animate-fade-in overflow-hidden rounded-2xl border border-line bg-surface shadow-soft transition-opacity duration-200', busy && 'opacity-70')}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-slate-50/70 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle dark:bg-white/[0.02]">
            <tr>
              <th scope="col" className="px-5 py-3">Document</th>
              <th scope="col" className="hidden px-4 py-3 md:table-cell">Category</th>
              <th scope="col" className="hidden px-4 py-3 sm:table-cell">Owner</th>
              <th scope="col" className="px-4 py-3">Your access</th>
              <th scope="col" className="hidden px-4 py-3 lg:table-cell">{trash ? 'Deleted' : 'Updated'}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {docs.map((d, i) => (
              <tr
                key={d.id}
                onClick={() => router.push(`/documents/${d.id}`)}
                className={cx('group animate-rise cursor-pointer transition-colors hover:bg-brand-50/40 active:bg-brand-50/70 dark:hover:bg-white/[0.03] dark:active:bg-white/[0.05]', staggerClass(i))}
              >
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <FileIcon fileName={d.current?.fileName} />
                    <div className="min-w-0">
                      <Link href={`/documents/${d.id}`} onClick={(e) => e.stopPropagation()} className="block truncate rounded font-semibold text-fg transition-colors duration-150 group-hover:text-brand-700 dark:group-hover:text-brand-200">{d.title}</Link>
                      {d.current && <div className="truncate text-xs text-fg-subtle">{d.current.fileName} · v{d.current.versionNo} · {formatBytes(d.current.sizeBytes)}</div>}
                    </div>
                  </div>
                </td>
                <td className="hidden px-4 py-3.5 md:table-cell"><Badge icon={<Tag size={11} />}>{d.category}</Badge></td>
                <td className="hidden px-4 py-3.5 sm:table-cell">
                  <div className="flex items-center gap-2">
                    <Avatar name={d.owner.displayName} size="xs" />
                    <span className="truncate text-fg-muted">{d.isOwner ? 'You' : d.owner.displayName}</span>
                  </div>
                </td>
                <td className="px-4 py-3.5"><Badge dot tone={ACCESS_TONE[d.myAccess]}>{ACCESS_LABEL[d.myAccess]}</Badge></td>
                <td className="hidden whitespace-nowrap px-4 py-3.5 text-fg-subtle lg:table-cell" title={formatDate(trash ? d.deletedAt : d.updatedAt)}>{relativeTime(trash ? d.deletedAt : d.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DocGrid({ docs, trash, busy }: { docs: DocItem[]; trash: boolean; busy?: boolean }) {
  return (
    <div aria-busy={busy || undefined} className={cx('grid gap-4 transition-opacity duration-200 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4', busy && 'opacity-70')}>
      {docs.map((d, i) => (
        <Link
          key={d.id}
          href={`/documents/${d.id}`}
          className={cx(
            'group relative flex animate-rise flex-col overflow-hidden rounded-2xl border border-line bg-surface p-4 shadow-soft transition duration-200 ease-out hover:-translate-y-1 hover:border-brand-200 hover:shadow-lift active:translate-y-0 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 dark:hover:border-brand-400/30',
            staggerClass(i),
          )}
        >
          <div aria-hidden className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-slate-50 to-transparent dark:from-white/[0.03]" />
          <div className="relative flex items-start justify-between gap-2">
            <FileIcon fileName={d.current?.fileName} size="lg" />
            <Badge dot tone={ACCESS_TONE[d.myAccess]}>{ACCESS_LABEL[d.myAccess]}</Badge>
          </div>
          <p className="relative mt-4 line-clamp-2 font-semibold leading-snug break-words text-fg transition-colors duration-150 group-hover:text-brand-700 dark:group-hover:text-brand-200">{d.title}</p>
          <p className="relative mt-1 truncate text-xs text-fg-subtle">
            {d.current ? `${fileType(d.current.fileName).label} · ${formatBytes(d.current.sizeBytes)} · v${d.current.versionNo}` : 'No file'}
          </p>
          <span className="relative mb-4 mt-3 flex min-w-0"><Badge icon={<Tag size={11} />} className="max-w-full truncate">{d.category}</Badge></span>
          <div className="relative mt-auto flex items-center justify-between gap-2 border-t border-line pt-3 text-xs">
            <span className="flex min-w-0 items-center gap-2"><Avatar name={d.owner.displayName} size="xs" /><span className="truncate text-fg-muted">{d.isOwner ? 'You' : d.owner.displayName}</span></span>
            <span className="shrink-0 text-fg-subtle" title={formatDate(trash ? d.deletedAt : d.updatedAt)}>{relativeTime(trash ? d.deletedAt : d.updatedAt)}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.docx,.xlsx,.pptx,.txt,.csv,.md';
const ACCEPT_EXT = new Set(ACCEPT.split(',').map((e) => e.slice(1)));
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function UploadModal({ open, folders, categories, defaultFolderId, onClose, onUploaded }: {
  open: boolean; folders: Folder[]; categories: string[]; defaultFolderId?: string; onClose: () => void; onUploaded: (title: string, removed: string[]) => void;
}) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [folderId, setFolderId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const defaults = useRef({ defaultFolderId, folders });
  useEffect(() => { defaults.current = { defaultFolderId, folders }; });

  useEffect(() => {
    if (!open) return;
    // Default to the folder being browsed (D10).
    const { defaultFolderId: def, folders: list } = defaults.current;
    setTitle(''); setCategory(''); setDescription(''); setFile(null); setError(null); setDrag(false);
    setFolderId(def && list.some((f) => f.id === def) ? def : '');
  }, [open]);

  const pick = (f: File | null) => {
    if (!f) return;
    // Check before sending 25 MB+ over the wire; the server still checks content (D10).
    const ext = f.name.includes('.') ? f.name.split('.').pop()!.toLowerCase() : '';
    if (!ACCEPT_EXT.has(ext)) {
      setFile(null);
      setError(`“${f.name}” isn't a supported file type. Use PDF, PNG, JPG, Word, Excel, PowerPoint, text, CSV or Markdown.`);
      return;
    }
    if (f.size > MAX_UPLOAD_BYTES) {
      setFile(null);
      setError(`“${f.name}” is ${formatBytes(f.size)}. Files can be up to 25 MB.`);
      return;
    }
    if (f.size === 0) {
      setFile(null);
      setError(`“${f.name}” is empty.`);
      return;
    }
    setError(null);
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim().slice(0, 200));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (busy) return;
    pick(e.dataTransfer.files?.[0] ?? null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set('title', title);
    form.set('category', category);
    if (description) form.set('description', description);
    if (folderId) form.set('folderId', folderId);
    form.set('file', file);
    try {
      const r = await api.upload<UploadResult>('/documents', form);
      onUploaded(title, r?.sanitized?.removed ?? []);
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
          data-autofocus
          onDragOver={(e) => { e.preventDefault(); if (!drag) setDrag(true); }}
          onDragLeave={(e) => {
            // Moving over the icon or text inside fires dragleave too; ignore those (D11).
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setDrag(false);
          }}
          onDrop={onDrop}
          onClick={() => { if (!busy) picker.current?.click(); }}
          role="button"
          tabIndex={0}
          aria-label={file ? `Selected file ${file.name}. Choose a different file` : 'Choose a file to upload'}
          aria-disabled={busy || undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault(); // Space would also scroll the dialog (D11)
              if (!busy) picker.current?.click();
            }
          }}
          className={cx(
            'flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 text-center transition duration-200 ease-out outline-none active:scale-[0.995] focus-visible:ring-2 focus-visible:ring-brand-500/50 focus-visible:ring-offset-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 sm:col-span-2 dark:focus-visible:ring-offset-ink-900',
            drag ? 'scale-[1.01] border-brand-500 bg-brand-50 dark:bg-brand-500/10' : file ? 'border-success-300 bg-success-50/50 dark:border-success-500/40 dark:bg-success-500/5' : 'border-line-strong hover:border-brand-400 hover:bg-slate-50 dark:hover:bg-white/[0.03]',
          )}
        >
          <input
            ref={picker}
            type="file"
            className="hidden"
            accept={ACCEPT}
            tabIndex={-1}
            onChange={(e) => {
              pick(e.target.files?.[0] ?? null);
              e.target.value = ''; // so picking the same file again still fires (D10)
            }}
            aria-label="File"
          />
          {file ? (
            <div className="flex min-w-0 max-w-full animate-pop items-center gap-3 text-left">
              <FileIcon fileName={file.name} size="lg" />
              <div className="min-w-0">
                <p className="truncate font-semibold">{file.name}</p>
                <p className="text-xs text-fg-subtle">{formatBytes(file.size)} · {fileType(file.name).label} · click to change</p>
              </div>
            </div>
          ) : (
            <>
              <span aria-hidden className={cx('mb-3 inline-flex size-12 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-glow transition-transform duration-200', drag && '-translate-y-1 scale-105')}><CloudArrowUp size={24} /></span>
              <p className="text-sm font-semibold">{drag ? 'Drop to choose this file' : <>Drop a file here, or <span className="text-brand-600 dark:text-brand-300">browse</span></>}</p>
              <p className="mt-1 text-xs text-fg-subtle">PDF, images, Word, Excel, PowerPoint, text, CSV or Markdown · up to 25 MB · checked by content, not by name</p>
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
        {error && <div className="animate-fade-in sm:col-span-2"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}
      </form>
    </Modal>
  );
}

function FolderModal({ open, folders, onClose, onChange, onDeleted }: {
  open: boolean; folders: Folder[]; onClose: () => void; onChange: () => void; onDeleted: (id: string) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();
  const [confirm, confirmDialog] = useConfirm();

  useEffect(() => { if (open) setError(null); }, [open]);

  const create = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    void run('add', async () => {
      try {
        await api.post('/folders', { name: n });
        setName('');
        setError(null);
        toast(`Folder “${n}” created`);
        onChange();
      } catch (err) {
        setError(errorText(err));
      }
    });
  };

  // D5: confirm first; the dialog shows its own busy state and any error.
  const remove = async (f: Folder) => {
    if (busy) return;
    setError(null);
    const ok = await confirm({
      title: `Delete the folder “${f.name}”?`,
      body: f.documents > 0
        ? `Its ${f.documents} document${f.documents === 1 ? '' : 's'} stay${f.documents === 1 ? 's' : ''} exactly as ${f.documents === 1 ? 'it is' : 'they are'}, with the same access; they just leave this folder.`
        : 'The folder is empty. Nothing else changes.',
      confirmLabel: 'Delete folder',
      danger: true,
      icon: <Trash size={20} />,
      onConfirm: () => api.delete(`/folders/${f.id}`),
    });
    if (!ok) return;
    toast(`Folder “${f.name}” deleted`);
    onDeleted(f.id);
  };

  return (
    <>
      <Modal open={open} onClose={onClose} icon={<FolderSimple size={22} />} title="Your folders" description="Folders only organise your own documents. They are never shared: access is always granted per document.">
        <div className="space-y-4">
          <form onSubmit={create} className="flex gap-2">
            <Input wrapperClassName="min-w-0 flex-1" icon={<FolderSimplePlus size={18} />} placeholder="New folder name" aria-label="New folder name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            <Button type="submit" variant="primary" icon={<Plus size={16} weight="bold" />} loading={busy === 'add'} disabled={!name.trim() || !!busy}>Add</Button>
          </form>
          {error && <div className="animate-fade-in"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}
          {folders.length === 0 ? (
            <EmptyState art={<SpotArt icon={<FolderSimple size={30} />} tone="amber" />} title="No folders yet">Create one to keep your documents tidy.</EmptyState>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {folders.map((f, i) => (
                <li key={f.id} className={cx('flex animate-rise items-center gap-3 px-3 py-2.5 transition-colors duration-150 hover:bg-slate-50 dark:hover:bg-white/[0.03]', staggerClass(i))}>
                  <IconTile tone="amber" size="sm"><FolderSimple size={18} weight="fill" /></IconTile>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">{f.name}</span>
                    <span className="block text-xs tabular-nums text-fg-subtle">{f.documents} document{f.documents === 1 ? '' : 's'}</span>
                  </span>
                  <IconButton
                    label={`Delete folder ${f.name}`}
                    disabled={!!busy}
                    onClick={() => void remove(f)}
                    className="hover:bg-danger-50 hover:text-danger-600 active:bg-danger-100 dark:hover:bg-danger-500/10 dark:hover:text-danger-300 dark:active:bg-danger-500/20"
                  >
                    <Trash size={18} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>
      {confirmDialog}
    </>
  );
}
