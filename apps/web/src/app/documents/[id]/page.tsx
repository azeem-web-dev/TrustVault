'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft, ArrowsLeftRight, Biohazard, CalendarBlank, Check, ClockCounterClockwise, CloudArrowUp, Copy, DownloadSimple, Eye, FolderSimple,
  Fingerprint, Info, LockKey, MagnifyingGlass, PencilSimple, Prohibit, ShareNetwork, ShieldCheck, Sparkle, Stack, Tag, Trash, UserPlus,
  UsersFour, Warning, ArrowCounterClockwise, Fire, Crown, Bug, Hash,
} from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import { ActionIcon, actionMeta } from '@/components/audit-ui';
import {
  ACCESS_LABEL, ACCESS_TONE, Alert, Avatar, Badge, Button, ButtonLink, Card, EmptyState, FileIcon, IconButton, IconTile, Input, Label,
  OUTCOME_TONE, Segmented, Select, Skeleton, SkeletonRows, Textarea, cx, fileType, relativeTime,
} from '@/components/ui';
import { api, ApiError, errorText, formatBytes, formatDate, type Access, type Level } from '@/lib/api';

interface Version {
  versionNo: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  sha256: string;
  uploadedBy: string;
  /** Set when the nightly malware re-scan found something in this version. */
  quarantine: { signature: string; foundAt: string } | null;
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

type Tab = 'overview' | 'versions' | 'access' | 'history';
const LEVEL_WORD: Record<string, string> = { READ: 'read', EDIT: 'edit', MANAGE: 'manage', OWNER: 'own' };
const RANK: Record<Access, number> = { NONE: 0, READ: 1, EDIT: 2, MANAGE: 3, OWNER: 4 };

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

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
    try {
      await fn();
      toast(success);
      if (after) after();
      else await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (notFound) {
    return (
      <Shell>
        <div className="rounded-2xl border border-slate-200/80 bg-white shadow-soft dark:border-white/[0.08] dark:bg-white/[0.03]">
          <EmptyState
            art={<SpotArt icon={<Prohibit size={30} />} tone="slate" />}
            title="Nothing to see here"
            action={<Link href="/"><Button icon={<ArrowLeft size={16} />}>Back to documents</Button></Link>}
          >
            This document does not exist, or you do not have access to it. We deliberately don&apos;t say which.
          </EmptyState>
        </div>
      </Shell>
    );
  }
  if (!doc) {
    return (
      <Shell>
        {error ? <Alert>{error}</Alert> : (
          <>
            <Skeleton className="h-4 w-24" />
            <div className="mt-6 flex items-center gap-4"><Skeleton className="size-16 rounded-2xl" /><div className="flex-1 space-y-3"><Skeleton className="h-7 w-72" /><Skeleton className="h-4 w-96 max-w-full" /></div></div>
            <div className="mt-8 grid gap-6 lg:grid-cols-3"><Skeleton className="h-80 rounded-2xl lg:col-span-2" /><Skeleton className="h-80 rounded-2xl" /></div>
          </>
        )}
      </Shell>
    );
  }

  const level = RANK[doc.myAccess];
  const trashed = doc.status === 'DELETED';
  const current = doc.versions[0];
  const canManage = level >= RANK.MANAGE;
  const tabs = [
    { id: 'overview' as const, label: 'Overview', icon: <Info size={16} /> },
    { id: 'versions' as const, label: 'Versions', icon: <Stack size={16} />, count: doc.versions.length },
    ...(canManage && !trashed ? [{ id: 'access' as const, label: 'Access', icon: <ShareNetwork size={16} /> }] : []),
    ...(canManage ? [{ id: 'history' as const, label: 'History', icon: <ClockCounterClockwise size={16} /> }] : []),
  ];

  return (
    <Shell>
      <Link href="/" className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-900 dark:hover:text-white">
        <ArrowLeft size={16} />Documents
      </Link>

      <section className="relative mb-6 animate-rise overflow-hidden rounded-3xl border border-slate-200/80 bg-white p-6 shadow-soft dark:border-white/[0.08] dark:bg-white/[0.03]">
        <div className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-brand-500/10 blur-3xl" />
        <div className="relative flex flex-wrap items-start gap-5">
          <FileIcon fileName={current?.fileName} size="xl" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge icon={<Tag size={11} />}>{doc.category}</Badge>
              <Badge dot tone={ACCESS_TONE[doc.myAccess]}>Your access: {ACCESS_LABEL[doc.myAccess]}</Badge>
              {trashed && <Badge tone="red" icon={<Trash size={11} />}>In the trash</Badge>}
              {doc.folder && <Badge tone="blue" icon={<FolderSimple size={11} />}>{doc.folder.name}</Badge>}
              {current?.quarantine && <Badge tone="red" icon={<Biohazard size={11} />}>Quarantined</Badge>}
            </div>
            <h1 className="mt-2.5 text-2xl font-semibold tracking-tight sm:text-[28px]">{doc.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
              <span className="flex items-center gap-1.5"><Avatar name={doc.owner.displayName} size="xs" />{doc.isOwner ? 'You own this' : doc.owner.displayName}</span>
              {current && <span>{fileType(current.fileName).label} · {formatBytes(current.sizeBytes)}</span>}
              <span title={formatDate(doc.updatedAt)}>Updated {relativeTime(doc.updatedAt)}</span>
            </div>
          </div>
          {current && (
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              {current.quarantine ? (
                <Button disabled icon={<Prohibit size={18} />}>Download blocked</Button>
              ) : current.mimeType.startsWith('text/csv') ? (
                // CSV: by default a copy with spreadsheet formulas disabled
                // (cells starting = + - @ get a leading '), so opening it in
                // Excel cannot run anything. The original bytes stay available.
                <>
                  <ButtonLink href={`/api/documents/${doc.id}/download?variant=formulas-disabled`} variant="primary" size="lg" icon={<DownloadSimple size={18} />}>
                    Download (formulas disabled)
                  </ButtonLink>
                  <ButtonLink href={`/api/documents/${doc.id}/download`} size="lg" icon={<DownloadSimple size={18} />}>Original file</ButtonLink>
                </>
              ) : (
                <ButtonLink href={`/api/documents/${doc.id}/download`} variant="primary" size="lg" icon={<DownloadSimple size={18} />}>
                  Download <span className="hidden max-w-[12rem] truncate font-normal opacity-80 md:inline">{current.fileName}</span>
                </ButtonLink>
              )}
            </div>
          )}
        </div>
      </section>

      {error && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}

      <div className="mb-5"><Segmented value={tab} onChange={setTab} options={tabs} /></div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {tab === 'overview' && (
            <>
              <Details doc={doc} canEdit={level >= RANK.EDIT && !trashed} onSave={(patch) => act(() => api.patch(`/documents/${doc.id}`, patch), 'Details saved')} />
              <ProtectionCard doc={doc} />
            </>
          )}
          {tab === 'versions' && <Versions doc={doc} canUpload={level >= RANK.EDIT && !trashed} onUploaded={() => act(async () => undefined, 'New version uploaded')} onError={setError} />}
          {tab === 'access' && canManage && !trashed && <AccessPanel doc={doc} onError={setError} />}
          {tab === 'history' && canManage && <History docId={doc.id} />}
        </div>
        <div className="space-y-6">
          <AboutCard doc={doc} canManage={canManage} />
          {doc.isOwner && (
            <OwnerActions
              doc={doc}
              onTrash={() => act(() => api.post(`/documents/${doc.id}/trash`), 'Moved to the trash. Nobody else can reach it now.')}
              onRestore={() => act(() => api.post(`/documents/${doc.id}/restore`), 'Restored')}
              onPurge={() => act(() => api.delete(`/documents/${doc.id}`), 'Deleted permanently', () => router.replace('/'))}
              onTransfer={(newOwnerId) => act(async () => {
                const r = await api.post<{ stillHas: string | null }>(`/documents/${doc.id}/transfer`, { newOwnerId });
                if (r?.stillHas) toast(`You no longer own it, but you can still ${LEVEL_WORD[r.stillHas] ?? 'open'} it through a group.`, 'info');
              }, 'Ownership transferred', () => router.replace('/'))}
              onMove={(folderId) => act(() => api.patch(`/documents/${doc.id}`, { folderId }), 'Moved')}
            />
          )}
        </div>
      </div>
    </Shell>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={label}
      className="size-7"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); });
      }}
    >
      {done ? <Check size={14} weight="bold" className="text-emerald-500" /> : <Copy size={14} />}
    </IconButton>
  );
}

function AboutCard({ doc, canManage }: { doc: Doc; canManage: boolean }) {
  const current = doc.versions[0];
  const rows: { icon: ReactNode; label: string; value: ReactNode }[] = [
    { icon: <Crown size={16} />, label: 'Owner', value: doc.isOwner ? 'You' : <>{doc.owner.displayName}<span className="block text-xs text-slate-500">{doc.owner.email}</span></> },
    { icon: <CalendarBlank size={16} />, label: 'Created', value: formatDate(doc.createdAt) },
    { icon: <PencilSimple size={16} />, label: 'Last changed', value: formatDate(doc.updatedAt) },
  ];
  return (
    <Card title="About" icon={<Info size={20} />}>
      <dl className="space-y-4 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex gap-3">
            <span className="mt-0.5 text-slate-400">{r.icon}</span>
            <div className="min-w-0"><dt className="text-xs text-slate-500 dark:text-slate-400">{r.label}</dt><dd className="mt-0.5 font-medium">{r.value}</dd></div>
          </div>
        ))}
        {current && (
          <div className="flex gap-3">
            <span className="mt-0.5 text-slate-400"><Hash size={16} /></span>
            <div className="min-w-0 flex-1">
              <dt className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">SHA-256 of current version<CopyButton value={current.sha256} label="Copy SHA-256" /></dt>
              <dd className="mt-0.5 break-all rounded-lg bg-slate-50 p-2 font-mono text-[11px] leading-4 text-slate-600 dark:bg-white/5 dark:text-slate-300">{current.sha256}</dd>
            </div>
          </div>
        )}
      </dl>
      {!canManage && (
        <p className="mt-5 flex gap-2 rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-500 dark:bg-white/5 dark:text-slate-400">
          <Eye size={16} className="shrink-0" />You can see this document because someone shared it with you. Only people with Manage access can see who else has it.
        </p>
      )}
    </Card>
  );
}

function ProtectionCard({ doc }: { doc: Doc }) {
  const items = [
    { icon: <LockKey size={18} />, title: 'Encrypted at rest', text: 'Its own key, wrapped by a separate key service.', tone: 'brand' as const },
    { icon: <Bug size={18} />, title: 'Malware-scanned', text: 'On upload, and again every night with new signatures.', tone: 'green' as const },
    { icon: <Fingerprint size={18} />, title: 'Every access recorded', text: 'Views, downloads and refusals go into the signed audit trail.', tone: 'violet' as const },
    { icon: <ShieldCheck size={18} />, title: doc.isOwner ? 'Only you decide' : 'Shared on purpose', text: doc.isOwner ? 'Nobody sees it unless you share it with them.' : 'Access was granted to you for this document only.', tone: 'amber' as const },
  ];
  return (
    <Card title="How this document is protected" icon={<ShieldCheck size={20} />}>
      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((i) => (
          <div key={i.title} className="flex gap-3 rounded-xl border border-slate-100 p-3 dark:border-white/[0.06]">
            <IconTile tone={i.tone} size="sm">{i.icon}</IconTile>
            <div><p className="text-sm font-semibold">{i.title}</p><p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{i.text}</p></div>
          </div>
        ))}
      </div>
    </Card>
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
    <Card title="Details" icon={<PencilSimple size={20} />} actions={canEdit && !editing && <Button size="sm" icon={<PencilSimple size={14} />} onClick={() => setEditing(true)}>Edit</Button>}>
      {editing ? (
        <form onSubmit={submit} className="grid animate-pop gap-4 sm:grid-cols-2">
          <Label label="Title"><Input required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Label>
          <Label label="Category"><Input required maxLength={60} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Label>
          <div className="sm:col-span-2"><Label label="Description"><Textarea rows={4} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Label></div>
          <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" icon={<Check size={16} weight="bold" />}>Save</Button><Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
        </form>
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700 dark:text-slate-300">{doc.description || <span className="italic text-slate-400">No description.</span>}</p>
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
    <Card title="Versions" icon={<Stack size={20} />} description="Every version is kept, encrypted and hash-checked on download.">
      <ol className="relative space-y-1">
        {doc.versions.map((v, i) => (
          <li key={v.versionNo} className="relative flex gap-4 pb-4 last:pb-0">
            {i < doc.versions.length - 1 && <span className="absolute left-5 top-11 h-[calc(100%-2.75rem)] w-px bg-slate-200 dark:bg-white/10" />}
            <FileIcon fileName={v.fileName} />
            <div className={cx('min-w-0 flex-1 rounded-xl border p-3 transition', i === 0 ? 'border-brand-200 bg-brand-50/40 dark:border-brand-400/25 dark:bg-brand-500/5' : 'border-slate-100 dark:border-white/[0.06]', v.quarantine && 'border-red-200 bg-red-50/50 dark:border-red-500/30 dark:bg-red-500/5')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    Version {v.versionNo}{i === 0 && <Badge tone="violet">Current</Badge>}
                  </p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">{v.fileName} · {formatBytes(v.sizeBytes)} · by {v.uploadedBy}, {relativeTime(v.createdAt)}</p>
                </div>
                {v.quarantine ? (
                  <Badge tone="red" icon={<Prohibit size={11} />}>Download blocked</Badge>
                ) : (
                  <ButtonLink size="sm" href={`/api/documents/${doc.id}/versions/${v.versionNo}/download`} icon={<DownloadSimple size={14} />}>Download</ButtonLink>
                )}
              </div>
              {v.quarantine && (
                <p className="mt-2 flex items-start gap-2 text-xs font-medium text-red-700 dark:text-red-300">
                  <Biohazard size={16} className="shrink-0" />Quarantined {formatDate(v.quarantine.foundAt)}: the malware scanner found {v.quarantine.signature}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
      {canUpload && (
        <form onSubmit={upload} className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-slate-300 p-4 dark:border-white/15">
          <div className="min-w-[200px] flex-1"><Label label="Upload a new version" hint="Scanned for malware and encrypted before it is stored."><Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Label></div>
          <Button type="submit" variant="primary" icon={<CloudArrowUp size={18} />} disabled={!file} loading={busy}>{busy ? 'Uploading…' : 'Upload version'}</Button>
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
  subject: { type: 'user'; id: string; name: string; email: string; role: string; active: boolean } | { type: 'group'; id: string; name: string; members: number; covered?: number; pending?: number };
}

interface Suggestion { type: 'user' | 'group'; id: string; name: string; detail: string; level: Level; why: string }
interface DirUser { id: string; displayName: string; email: string; role: string; accessExpiresAt: string | null }
interface DirGroup { id: string; name: string; members: number }

const LEVELS: { id: Level; title: string; text: string; icon: ReactNode }[] = [
  { id: 'READ', title: 'Read', text: 'View and download', icon: <Eye size={18} /> },
  { id: 'EDIT', title: 'Edit', text: 'Also rename, upload versions', icon: <PencilSimple size={18} /> },
  { id: 'MANAGE', title: 'Manage', text: 'Also share, see history', icon: <ShareNetwork size={18} /> },
];

function AccessPanel({ doc, onError }: { doc: Doc; onError: (m: string | null) => void }) {
  const toast = useToast();
  const [grants, setGrants] = useState<GrantRow[] | null>(null);
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
      toast(`${label || 'Access'} can now ${lvl === 'READ' ? 'read' : lvl === 'EDIT' ? 'edit' : 'manage'} this document.`);
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
      const r = await api.delete<{ stillHas: string | null }>(`/documents/${doc.id}/access/${g.id}`);
      // Their own grant is gone, but a group grant may still cover them. Say so.
      if (r?.stillHas) toast(`Removed ${g.subject.name}'s own access, but they can still ${LEVEL_WORD[r.stillHas] ?? 'open'} it through a group. Remove that group's grant to cut them off.`, 'info');
      else toast(`Access removed for ${g.subject.name}. It stops working on their next request.`);
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

  const levels = LEVELS.filter((l) => l.id === 'READ' || (!target?.external && (l.id === 'EDIT' || doc.isOwner)));
  const hasResults = results.users.length > 0 || results.groups.length > 0;

  return (
    <>
      <Card title="Share this document" icon={<UserPlus size={20} />} description="Access is granted to this one document only. Changes take effect immediately.">
        <form onSubmit={submit} className="space-y-4">
          {target ? (
            <div className="flex animate-pop items-center gap-3 rounded-xl border border-brand-200 bg-brand-50/60 p-3 dark:border-brand-400/25 dark:bg-brand-500/10">
              {target.type === 'group' ? <IconTile size="sm" tone="blue"><UsersFour size={16} /></IconTile> : <Avatar name={target.label} size="sm" />}
              <span className="flex-1 text-sm">Sharing with <span className="font-semibold">{target.label}</span>{target.external && <Badge tone="amber" className="ml-2">External</Badge>}</span>
              <Button type="button" size="sm" variant="ghost" onClick={() => setTarget(null)}>Change</Button>
            </div>
          ) : (
            <div className="relative">
              <Input icon={<MagnifyingGlass size={18} />} placeholder="Type a name, email or group (2+ letters)" value={query} onChange={(e) => setQuery(e.target.value)} />
              {hasResults && (
                <ul className="absolute z-10 mt-2 w-full animate-pop overflow-hidden rounded-xl border border-slate-200 bg-white p-1 text-sm shadow-lift dark:border-white/10 dark:bg-ink-900">
                  {results.groups.map((g) => (
                    <li key={g.id}>
                      <button type="button" className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-white/5" onClick={() => { setTarget({ type: 'group', id: g.id, label: `group ${g.name}`, external: false }); setResults({ users: [], groups: [] }); }}>
                        <IconTile size="sm" tone="blue"><UsersFour size={16} /></IconTile>
                        <span className="flex-1"><span className="font-medium">{g.name}</span><span className="block text-xs text-slate-500">Group · {g.members} members</span></span>
                      </button>
                    </li>
                  ))}
                  {results.users.filter((u) => u.id !== doc.owner.id).map((u) => (
                    <li key={u.id}>
                      <button type="button" className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-white/5" onClick={() => { setTarget({ type: 'user', id: u.id, label: u.displayName, external: u.role === 'EXTERNAL' }); setLevel('READ'); setResults({ users: [], groups: [] }); }}>
                        <Avatar name={u.displayName} size="sm" />
                        <span className="min-w-0 flex-1"><span className="font-medium">{u.displayName}</span><span className="block truncate text-xs text-slate-500">{u.email}</span></span>
                        {u.role === 'EXTERNAL' && <Badge tone="amber">External</Badge>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div>
            <p className="mb-2 text-[13px] font-medium text-slate-700 dark:text-slate-300">Access level</p>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Access">
              {levels.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  aria-checked={level === l.id}
                  onClick={() => setLevel(l.id)}
                  className={cx('flex items-start gap-3 rounded-xl border p-3 text-left transition', level === l.id ? 'border-brand-400 bg-brand-50 ring-4 ring-brand-500/10 dark:border-brand-400/60 dark:bg-brand-500/10' : 'border-slate-200 hover:border-slate-300 dark:border-white/10 dark:hover:border-white/20')}
                >
                  <span className={cx('mt-0.5', level === l.id ? 'text-brand-600 dark:text-brand-300' : 'text-slate-400')}>{l.icon}</span>
                  <span><span className="block text-sm font-semibold">{l.title}</span><span className="block text-xs text-slate-500 dark:text-slate-400">{l.text}</span></span>
                </button>
              ))}
            </div>
            {target?.external && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">External people can only be given Read access, and it must end on a date.</p>}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full sm:w-56">
              <Label label={target?.external ? 'Expires on (required for external)' : 'Expires on (optional)'}>
                <Input type="date" value={expires} required={target?.external} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setExpires(e.target.value)} />
              </Label>
            </div>
            <Button type="submit" variant="primary" size="lg" icon={<ShareNetwork size={18} />} disabled={!target}>Share</Button>
          </div>
        </form>
      </Card>

      <Card title="Who has access" icon={<UsersFour size={20} />} actions={grants && <Badge>{grants.length + 1} with access</Badge>} padded={false}>
        {!grants ? <SkeletonRows rows={3} /> : (
          <ul className="divide-y divide-slate-100 dark:divide-white/[0.05]">
            <li className="flex items-center gap-3 px-5 py-3.5">
              <Avatar name={doc.owner.displayName} />
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{doc.owner.displayName}{doc.isOwner && <span className="font-normal text-slate-500"> (you)</span>}</p><p className="truncate text-xs text-slate-500">{doc.owner.email}</p></div>
              <Badge tone="violet" icon={<Crown size={11} />}>Owner</Badge>
            </li>
            {grants.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                {g.subject.type === 'group' ? <IconTile tone="blue"><UsersFour size={18} /></IconTile> : <Avatar name={g.subject.name} />}
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                    {g.subject.type === 'group' ? <>{g.subject.name}<span className="font-normal text-slate-500">· group of {g.subject.members}</span></> : g.subject.name}
                    {g.subject.type === 'user' && g.subject.role === 'EXTERNAL' && <Badge tone="amber">External</Badge>}
                    {g.subject.type === 'user' && !g.subject.active && <Badge tone="red">Inactive</Badge>}
                  </p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {g.subject.type === 'user' && <>{g.subject.email} · </>}granted by {g.grantedBy}
                    {g.expiresAt && <> · {g.expired ? <span className="font-medium text-red-600">expired</span> : 'expires'} {formatDate(g.expiresAt)}</>}
                  </p>
                  {g.subject.type === 'group' && (g.subject.pending ?? 0) > 0 && (
                    <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
                      {g.subject.pending} added to the group since you shared. They cannot open it until you confirm.
                      <Button size="sm" variant="soft" icon={<UserPlus size={14} />} onClick={() => void share({ groupId: g.subject.id }, g.level, g.expiresAt, false, `group ${g.subject.name}`)}>Confirm</Button>
                    </p>
                  )}
                </div>
                <Badge dot tone={ACCESS_TONE[g.level]}>{ACCESS_LABEL[g.level]}</Badge>
                {(doc.isOwner || g.level !== 'MANAGE') && (
                  <IconButton label={`Remove access for ${g.subject.name}`} onClick={() => void revoke(g)} className="hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"><Trash size={18} /></IconButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {grants && grants.length === 0 && <p className="border-t border-slate-100 px-5 py-4 text-sm text-slate-500 dark:border-white/[0.05]">Only the owner can open this document.</p>}
      </Card>

      <Card
        title="Suggested people"
        icon={<Sparkle size={20} />}
        description="Based on who you shared similar documents with. Never grants access by itself."
        actions={
          <Button size="sm" variant="soft" icon={<Sparkle size={14} />} onClick={() => api.get<{ suggestions: Suggestion[] }>(`/documents/${doc.id}/suggestions`).then((r) => setSuggestions(r.suggestions)).catch((err) => onError(errorText(err)))}>
            {suggestions ? 'Refresh' : 'Show suggestions'}
          </Button>
        }
      >
        {!suggestions ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">You confirm each one, and both the suggestion and your decision are recorded.</p>
        ) : suggestions.length === 0 ? (
          <p className="text-sm text-slate-500">No suggestions for this document.</p>
        ) : (
          <ul className="space-y-2">
            {suggestions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 p-3 dark:border-white/[0.06]">
                {s.type === 'group' ? <IconTile size="sm" tone="blue"><UsersFour size={16} /></IconTile> : <Avatar name={s.name} size="sm" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{s.type === 'group' ? `Group: ${s.name}` : s.name} <span className="font-normal text-slate-500">{s.type === 'user' ? s.detail : ''}</span></p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{s.why}</p>
                </div>
                <Button size="sm" icon={<UserPlus size={14} />} onClick={() => void share(s.type === 'user' ? { userId: s.id } : { groupId: s.id }, s.level, null, true, s.name)}>Share {ACCESS_LABEL[s.level]}</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

interface HistoryEvent { seq: string; occurredAt: string; actorEmail: string | null; action: string; outcome: 'ALLOWED' | 'DENIED' | 'FAILED'; reason: string | null }

function History({ docId }: { docId: string }) {
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  useEffect(() => {
    api.get<{ events: HistoryEvent[] }>(`/documents/${docId}/history`).then((r) => setEvents(r.events)).catch(() => setEvents([]));
  }, [docId]);
  return (
    <Card title="History" icon={<ClockCounterClockwise size={20} />} description="Everything that happened to this document, including refused attempts." padded={false}>
      {!events ? <SkeletonRows rows={5} /> : events.length === 0 ? (
        <EmptyState art={<SpotArt icon={<ClockCounterClockwise size={30} />} />} title="No activity yet" />
      ) : (
        <ol className="max-h-[36rem] overflow-y-auto px-5 py-4">
          {events.map((e, i) => (
            <li key={e.seq} className="relative flex gap-3 pb-5 last:pb-0">
              {i < events.length - 1 && <span className="absolute left-4 top-9 h-[calc(100%-2rem)] w-px bg-slate-200 dark:bg-white/10" />}
              <ActionIcon action={e.action} outcome={e.outcome} />
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold">{actionMeta(e.action).label}</p>
                  {e.outcome !== 'ALLOWED' && <Badge tone={OUTCOME_TONE[e.outcome]}>{e.outcome === 'DENIED' ? 'Refused' : 'Failed'}</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {e.actorEmail ?? 'system'} · <span title={formatDate(e.occurredAt)}>{relativeTime(e.occurredAt)}</span>
                  {e.reason && <> · {e.reason.replace(/_/g, ' ')}</>}
                </p>
              </div>
              <span className="hidden pt-1 font-mono text-[11px] text-slate-400 sm:block">#{e.seq}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function OwnerActions(props: { doc: Doc; onTrash: () => void; onRestore: () => void; onPurge: () => void; onTransfer: (id: string) => void; onMove: (folderId: string | null) => void }) {
  const { doc } = props;
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);
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
      <Card title="In the trash" icon={<Trash size={20} />}>
        <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">Only you can see it. It is removed permanently after the retention period.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon={<ArrowCounterClockwise size={16} />} onClick={props.onRestore}>Restore</Button>
          {confirmPurge
            ? <Button variant="danger" icon={<Fire size={16} />} onClick={props.onPurge}>Yes, delete forever</Button>
            : <Button variant="danger" icon={<Trash size={16} />} onClick={() => setConfirmPurge(true)}>Delete permanently</Button>}
        </div>
      </Card>
    );
  }
  return (
    <Card title="Owner actions" icon={<Crown size={20} />}>
      <div className="space-y-5 text-sm">
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
            <Input icon={<ArrowsLeftRight size={18} />} placeholder="Search document owners" value={ownerQuery} onChange={(e) => setOwnerQuery(e.target.value)} />
          </Label>
          {owners.map((o) => (
            <div key={o.id} className="mt-2 flex animate-pop items-center gap-3 rounded-xl border border-slate-100 p-2.5 dark:border-white/[0.06]">
              <Avatar name={o.displayName} size="sm" />
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{o.displayName}</span><span className="block truncate text-xs text-slate-500">{o.email}</span></span>
              <Button size="sm" onClick={() => props.onTransfer(o.id)}>Transfer</Button>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-red-200 bg-red-50/50 p-4 dark:border-red-500/25 dark:bg-red-500/5">
          <p className="flex items-center gap-2 font-semibold text-red-700 dark:text-red-300"><Warning size={18} />Danger zone</p>
          <p className="mt-1 text-xs text-red-700/80 dark:text-red-300/70">Moving to the trash removes everyone else&apos;s access at once. You can restore it later.</p>
          <div className="mt-3">
            {confirmTrash
              ? <div className="flex gap-2"><Button variant="danger" icon={<Trash size={16} />} onClick={props.onTrash}>Yes, move to trash</Button><Button variant="ghost" onClick={() => setConfirmTrash(false)}>Cancel</Button></div>
              : <Button variant="danger" icon={<Trash size={16} />} onClick={() => setConfirmTrash(true)}>Move to trash</Button>}
          </div>
        </div>
      </div>
    </Card>
  );
}
