'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Biohazard, ClockCounterClockwise, DownloadSimple, Eye, FolderSimple, Info, LockKey, Prohibit, ShareNetwork, Stack, Tag, Trash, HourglassMedium } from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import { ACCESS_LABEL, ACCESS_TONE, Alert, Avatar, Badge, Button, ButtonLink, EmptyState, FileIcon, LoadError, Segmented, Skeleton, fileType, relativeTime, tabPanelProps } from '@/components/ui';
import { api, ApiError, errorText, formatBytes, formatDate } from '@/lib/api';
import { isAbortError, prefersReducedMotion, useAction, useLatest } from '@/lib/hooks';
import { DownloadRequestCard } from '@/components/access-policy';
import { AccessPanel } from './_components/access-panel';
import { History } from './_components/history';
import { AboutCard, Details, ProtectionCard } from './_components/overview';
import { OwnerActions } from './_components/owner-actions';
import { PageViewer } from './_components/page-viewer';
import { type Doc, LEVEL_WORD, RANK, type Tab } from './_components/types';
import { Versions } from './_components/versions';

const TABS_ID = 'doc-tabs';

/** The tabs this viewer can open on this document, in display order. */
function tabIdsFor(doc: Doc): Tab[] {
  const canManage = RANK[doc.myAccess] >= RANK.MANAGE;
  const trashed = doc.status === 'DELETED';
  return [
    ...(doc.versions[0] ? ['pages' as const] : []),
    'overview',
    'versions',
    ...(canManage && !trashed ? ['access' as const] : []),
    ...(canManage ? ['history' as const] : []),
  ];
}

/** Scrolls to an element on the page after the next paint (the target may only render after a tab change). */
function scrollToId(id: string, focusSelector?: string) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    if (focusSelector) el.querySelector<HTMLElement>(focusSelector)?.focus({ preventScroll: true });
  }));
}

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [notFound, setNotFound] = useState(false);
  // A share that exists but does not apply right now (time window, network).
  const [policyBlock, setPolicyBlock] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const first = useRef(true);
  const latest = useLatest();
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    const t = latest.begin();
    try {
      const d = await api.get<Doc>(`/documents/${id}`, { signal: t.signal });
      if (!t.isLatest()) return;
      setDoc(d);
      // View-only people land on the pages: it is all they can open.
      if (first.current) {
        first.current = false;
        if (d.myAccess === 'VIEW') setTab('pages');
        // Links in owner emails (e.g. a capture attempt) open the history.
        else if (window.location.hash === '#history' && (d.myAccess === 'MANAGE' || d.myAccess === 'OWNER')) setTab('history');
      }
    } catch (err) {
      if (!t.isLatest() || isAbortError(err)) return;
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else if (err instanceof ApiError && err.status === 403 && (err.body?.code === 'outside_time_window' || err.body?.code === 'network_not_allowed')) setPolicyBlock(err.message);
      else setError(errorText(err));
    }
  }, [id, latest]);

  useEffect(() => {
    void load();
  }, [load]);

  // A tab that is no longer available (e.g. Access after moving to the trash)
  // falls back to Overview instead of rendering nothing (P6).
  if (doc && !tabIdsFor(doc).includes(tab)) setTab('overview');

  /**
   * Runs one mutation at a time (a double click sends one request), shows a
   * toast on success and the error banner on failure. Resolves true on success.
   */
  const act = async (key: string, fn: () => Promise<unknown>, success: string, after?: () => void): Promise<boolean> => {
    const ok = await run(key, async () => {
      setError(null);
      try {
        await fn();
        toast(success);
        if (after) after();
        else await load();
        return true;
      } catch (err) {
        setError(errorText(err));
        return false;
      }
    });
    return ok === true;
  };

  if (notFound) {
    return (
      <Shell>
        <div className="rounded-2xl border border-line bg-surface shadow-soft">
          <EmptyState
            art={<SpotArt icon={<Prohibit size={30} />} tone="slate" />}
            title="Nothing to see here"
            action={<ButtonLink href="/" icon={<ArrowLeft size={16} />}>Back to documents</ButtonLink>}
          >
            This document does not exist, or you do not have access to it. We deliberately don&apos;t say which.
          </EmptyState>
        </div>
      </Shell>
    );
  }
  if (policyBlock) {
    return (
      <Shell>
        <div className="rounded-2xl border border-line bg-surface shadow-soft">
          <EmptyState
            art={<SpotArt icon={<LockKey size={30} />} tone="amber" />}
            title="Not available right now"
            action={<ButtonLink href="/" icon={<ArrowLeft size={16} />}>Back to documents</ButtonLink>}
          >
            {policyBlock}. The owner set this condition on your share; if you need it now, ask them for a temporary exception.
          </EmptyState>
        </div>
      </Shell>
    );
  }
  if (!doc) {
    return (
      <Shell>
        {error ? (
          <div className="rounded-2xl border border-line bg-surface shadow-soft">
            <LoadError title="Couldn't open this document" error={error} onRetry={() => { setError(null); void load(); }} />
          </div>
        ) : (
          <div role="status" aria-busy="true">
            <span className="sr-only">Loading the document…</span>
            <Skeleton className="h-4 w-24" />
            <div className="mt-6 flex items-center gap-4"><Skeleton className="size-16 rounded-2xl" /><div className="flex-1 space-y-3"><Skeleton className="h-7 w-72 max-w-full" /><Skeleton className="h-4 w-96 max-w-full" /></div></div>
            <div className="mt-8 grid gap-6 lg:grid-cols-3"><Skeleton className="h-80 rounded-2xl lg:col-span-2" /><Skeleton className="h-80 rounded-2xl" /></div>
          </div>
        )}
      </Shell>
    );
  }

  const level = RANK[doc.myAccess];
  const trashed = doc.status === 'DELETED';
  const current = doc.versions[0];
  const canManage = level >= RANK.MANAGE;
  const canDownload = level >= RANK.READ;
  // Prefer the API's download object when present; otherwise fall back to the
  // older shape (READ access + the downloadNeedsApproval flag).
  const dl = doc.download;
  const canDownloadNow = dl ? dl.allowed : (canDownload && !doc.downloadNeedsApproval);
  const requestStatus = dl?.requestStatus ?? 'NONE';
  // The request flow is shown when the viewer cannot download yet but either
  // may ask, or already has an ask in progress/decided.
  const inRequestFlow = dl
    ? (!dl.allowed && (dl.requestable || requestStatus !== 'NONE'))
    : Boolean(doc.downloadNeedsApproval && !canDownloadNow);
  const canAskAgain = dl ? dl.requestable : true;
  const tabs = [
    ...(current ? [{ id: 'pages' as const, label: 'View', icon: <Eye size={16} /> }] : []),
    { id: 'overview' as const, label: 'Overview', icon: <Info size={16} /> },
    { id: 'versions' as const, label: 'Versions', icon: <Stack size={16} />, count: doc.versions.length },
    ...(canManage && !trashed ? [{ id: 'access' as const, label: 'Access', icon: <ShareNetwork size={16} /> }] : []),
    ...(canManage ? [{ id: 'history' as const, label: 'History', icon: <ClockCounterClockwise size={16} /> }] : []),
  ];
  const activeTab: Tab = tabs.some((t) => t.id === tab) ? tab : 'overview';
  // Header buttons that point at the request card: switch to Overview, then
  // scroll once it has rendered (a plain #hash link fired too early).
  const toRequest = () => {
    setTab('overview');
    scrollToId('download-request', 'textarea');
  };

  const transfer = async (newOwnerId: string) => {
    setError(null);
    const r = await api.post<{ stillHas: string | null }>(`/documents/${doc.id}/transfer`, { newOwnerId });
    if (r?.stillHas) toast(`You no longer own it, but you can still ${LEVEL_WORD[r.stillHas] ?? 'open'} it through a group.`, 'info');
    toast('Ownership transferred');
    router.replace('/');
  };

  return (
    <Shell>
      <Link href="/" className="mb-5 inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-fg-subtle transition-colors hover:text-fg pointer-coarse:min-h-11">
        <ArrowLeft size={16} />Documents
      </Link>

      <section className="relative mb-6 animate-rise overflow-hidden rounded-3xl border border-line bg-surface p-5 shadow-soft sm:p-6">
        <div className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-brand-500/10 blur-3xl" />
        <div className="relative flex flex-wrap items-start gap-5">
          <FileIcon fileName={current?.fileName} size="xl" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge icon={<Tag size={11} />} className="max-w-full"><span className="truncate">{doc.category}</span></Badge>
              <Badge dot tone={ACCESS_TONE[doc.myAccess]}>Your access: {ACCESS_LABEL[doc.myAccess]}</Badge>
              {trashed && <Badge tone="red" icon={<Trash size={11} />}>In the trash</Badge>}
              {doc.folder && <Badge tone="blue" icon={<FolderSimple size={11} />} className="max-w-full"><span className="truncate">{doc.folder.name}</span></Badge>}
              {current?.quarantine && <Badge tone="red" icon={<Biohazard size={11} />}>Quarantined</Badge>}
            </div>
            <h1 className="mt-2.5 break-words text-2xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-[1.75rem]">{doc.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-subtle">
              <span className="flex min-w-0 items-center gap-1.5"><Avatar name={doc.owner.displayName} size="xs" /><span className="truncate">{doc.isOwner ? 'You own this' : doc.owner.displayName}</span></span>
              {current && <span>{fileType(current.fileName).label} · {formatBytes(current.sizeBytes)}</span>}
              <span title={formatDate(doc.updatedAt)}>Updated {relativeTime(doc.updatedAt)}</span>
            </div>
          </div>
          {current && (
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              {current.quarantine ? (
                <Button disabled size="lg" icon={<Prohibit size={18} />}>Download blocked</Button>
              ) : inRequestFlow ? (
                requestStatus === 'PENDING' ? (
                  <Button variant="soft" size="lg" icon={<HourglassMedium size={18} />} onClick={toRequest}>Awaiting approval</Button>
                ) : requestStatus === 'REJECTED' && !canAskAgain ? (
                  <Button variant="secondary" size="lg" icon={<Prohibit size={18} />} onClick={toRequest}>Request declined</Button>
                ) : (
                  <Button variant="primary" size="lg" icon={<DownloadSimple size={18} />} onClick={toRequest}>{requestStatus === 'REJECTED' ? 'Ask again to download' : 'Ask to download'}</Button>
                )
              ) : !canDownloadNow ? (
                <Button variant="soft" size="lg" icon={<Eye size={18} />} onClick={() => setTab('pages')}>View only</Button>
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

      {error && <div className="mb-4 animate-fade-in"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}

      <div className="mb-5"><Segmented value={activeTab} onChange={setTab} options={tabs} idBase={TABS_ID} label="Document sections" /></div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div key={activeTab} {...tabPanelProps(TABS_ID, activeTab)} className="min-w-0 animate-fade-in space-y-6 rounded-2xl lg:col-span-2">
          {activeTab === 'pages' && current && <PageViewer doc={doc} canDownload={canDownloadNow} approved={requestStatus === 'APPROVED' && canDownloadNow && !canDownload} />}
          {activeTab === 'overview' && (
            <>
              {inRequestFlow && current && !current.quarantine && (
                <div id="download-request" className="scroll-mt-24">
                  <DownloadRequestCard docId={doc.id} versionNo={current.versionNo} onChanged={() => void load()} />
                </div>
              )}
              <Details
                doc={doc}
                canEdit={level >= RANK.EDIT && !trashed}
                onSave={async (patch) => {
                  await api.patch(`/documents/${doc.id}`, patch);
                  toast('Details saved');
                  await load();
                }}
              />
              <ProtectionCard doc={doc} />
            </>
          )}
          {activeTab === 'versions' && (
            <Versions
              doc={doc}
              canDownload={canDownload || canDownloadNow}
              canDownloadNow={canDownloadNow}
              needsApproval={inRequestFlow}
              canUpload={level >= RANK.EDIT && !trashed}
              onUploaded={(note) => {
                setError(null);
                toast(note ? `New version uploaded. ${note}` : 'New version uploaded');
                void load();
              }}
              onError={setError}
            />
          )}
          {activeTab === 'access' && canManage && !trashed && <AccessPanel doc={doc} onError={setError} />}
          {activeTab === 'history' && canManage && <History docId={doc.id} />}
        </div>
        <div className="space-y-6">
          <AboutCard doc={doc} canManage={canManage} />
          {doc.isOwner && (
            <OwnerActions
              doc={doc}
              busy={busy}
              onTrash={() => act('trash', () => api.post(`/documents/${doc.id}/trash`), 'Moved to the trash. Nobody else can reach it now.')}
              onRestore={() => act('restore', () => api.post(`/documents/${doc.id}/restore`), 'Restored')}
              onPurge={() => act('purge', () => api.delete(`/documents/${doc.id}`), 'Deleted permanently', () => router.replace('/'))}
              onTransfer={transfer}
              onMove={(folderId) => act('move', () => api.patch(`/documents/${doc.id}`, { folderId }), 'Moved')}
            />
          )}
        </div>
      </div>
    </Shell>
  );
}
