'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import {
  ArrowLeft, ArrowsLeftRight, Biohazard, CalendarBlank, Check, ClockCounterClockwise, CloudArrowUp, Copy, DownloadSimple, Eye, FolderSimple,
  Fingerprint, Info, LockKey, MagnifyingGlass, PencilSimple, Prohibit, ShareNetwork, ShieldCheck, Sparkle, Stack, Tag, Trash, UserPlus, WarningOctagon, Siren,
  UsersFour, ArrowCounterClockwise, Fire, Crown, Bug, Hash, CaretLeft, CaretRight, EyeSlash, HourglassMedium, HandPalm, ArrowClockwise,
} from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useToast } from '@/components/toast';
import { removedNotice, type UploadResult } from '@/lib/sanitized';
import { SpotArt } from '@/components/art';
import { ActionIcon, actionMeta } from '@/components/audit-ui';
import {
  ACCESS_LABEL, ACCESS_TONE, Alert, Avatar, Badge, Button, ButtonLink, Card, EmptyState, FileIcon, IconButton, IconTile, Input, Label,
  LoadError, Modal, OUTCOME_TONE, Segmented, Select, Skeleton, SkeletonRows, Textarea, cx, fileType, relativeTime, staggerClass, tabPanelProps, useConfirm, useListNav,
} from '@/components/ui';
import { api, ApiError, beacon, errorText, formatBytes, formatDate, type Access, type Level } from '@/lib/api';
import { isAbortError, prefersReducedMotion, useAction, useLatest } from '@/lib/hooks';
import { localDayEndISO, localTodayISO } from '@/lib/dates';
import { CAPTURE_METHOD_LABEL, CAPTURE_VEIL_MS, CLIPBOARD_NOTICE, captureMethod, shouldReport, type CaptureMethod } from '@/lib/capture-guard';
import { ConditionBadges, DownloadRequestCard, PolicyFields, type SharePolicy, type SharePolicyView } from '@/components/access-policy';

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
  /** Downloads need the owner's approval (a condition on the share). */
  downloadNeedsApproval?: boolean;
  /**
   * Download state for the current viewer (sent by the API). `allowed`: a
   * Download button is shown. `requestable`: a view-only viewer may ask the
   * owner for a one-file download. `requestStatus`: where that ask stands.
   * Absent on older responses, in which case we fall back gracefully.
   */
  download?: { allowed: boolean; requestable: boolean; requestStatus: 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED' };
  folder: { id: string; name: string } | null;
  versions: Version[];
}

type Tab = 'pages' | 'overview' | 'versions' | 'access' | 'history';
const LEVEL_WORD: Record<string, string> = { VIEW: 'view', READ: 'read', EDIT: 'edit', MANAGE: 'manage', OWNER: 'own' };
const RANK: Record<Access, number> = { NONE: 0, VIEW: 1, READ: 2, EDIT: 3, MANAGE: 4, OWNER: 5 };
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

/** Documents reported in this page load, for the 10-second debounce. */
const reported = new Map<string, number>();

/**
 * Server-drawn page images with the viewer's name, the time and a trace
 * code across them (THREATS.md V2-V4). The browser never gets the original
 * file. Blurring when the window loses focus, blocking print, the context
 * menu and dragging are speed bumps only: anyone who can see a page can
 * photograph it (THREATS.md V3). Key presses that usually start a screen
 * capture blank the pages for a moment and are reported to the owner,
 * silently (V11); the screenshot itself cannot be stopped from a web page.
 */
function PageViewer({ doc, canDownload, approved }: { doc: Doc; canDownload: boolean; approved: boolean }) {
  const [info, setInfo] = useState<{ pages: number; preview: boolean; message: string | null; versionNo: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [infoAttempt, setInfoAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const [veiled, setVeiled] = useState(false);
  const [captureVeil, setCaptureVeil] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // One failed page image (e.g. the 429 page-view limit) shows an inline
  // error with Retry for that page; the pager keeps working (P7).
  const [pageError, setPageError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const pageRef = useRef(1);
  useEffect(() => { pageRef.current = page; }, [page]);

  useEffect(() => {
    let live = true;
    api.get<{ pages: number; preview: boolean; message: string | null; versionNo: number }>(`/documents/${doc.id}/pages`)
      .then((r) => { if (!live) return; setInfo(r); setError(null); setPage(1); setLoaded(false); setPageError(false); })
      .catch((err) => { if (live) setError(errorText(err)); });
    return () => { live = false; };
  }, [doc.id, doc.versions.length, infoAttempt]);

  useEffect(() => {
    const hide = () => setVeiled(true);
    const show = () => setVeiled(document.hidden || !document.hasFocus());
    const onVisibility = () => (document.hidden ? hide() : show());
    // Likely screen captures (THREATS.md V11): blank the pages at once, keep
    // them blank for a moment, overwrite the clipboard and quietly report it.
    // The viewer is not told about the report (the owner asked for that).
    let unveil: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P' || e.key === 's' || e.key === 'S')) e.preventDefault();
      const method = captureMethod(e, navigator.platform || navigator.userAgent);
      if (!method) return;
      flushSync(() => setCaptureVeil(true));
      clearTimeout(unveil);
      unveil = setTimeout(() => setCaptureVeil(false), CAPTURE_VEIL_MS);
      if (method === 'printscreen') {
        const overwrite = () => { try { void navigator.clipboard?.writeText(CLIPBOARD_NOTICE).catch(() => undefined); } catch { /* best effort */ } };
        overwrite();
        setTimeout(overwrite, 800); // the OS may write its picture a moment later
      }
      if (shouldReport(reported, doc.id, Date.now())) beacon(`/documents/${doc.id}/capture-attempt`, { method, page: pageRef.current });
    };
    window.addEventListener('blur', hide);
    window.addEventListener('focus', show);
    window.addEventListener('beforeprint', hide);
    window.addEventListener('afterprint', show);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      clearTimeout(unveil);
      window.removeEventListener('blur', hide);
      window.removeEventListener('focus', show);
      window.removeEventListener('beforeprint', hide);
      window.removeEventListener('afterprint', show);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, [doc.id]);

  const total = info?.pages ?? 0;
  const goTo = (next: number) => {
    const p = Math.min(Math.max(1, next), Math.max(1, total));
    if (p === page) return;
    setPage(p);
    setLoaded(false);
    setPageError(false);
  };
  const retryPage = () => {
    setPageError(false);
    setLoaded(false);
    setAttempt((a) => a + 1);
  };
  return (
    <Card
      title={canDownload ? 'View' : 'View only'}
      icon={<Eye size={20} />}
      description={approved ? 'The owner approved a download. Pages are drawn by TrustVault, marked with your name; the Download button gives you a copy stamped the same way.' : canDownload ? 'Pages drawn by TrustVault, marked with your name. Download gives you a copy stamped the same way.' : 'You can read this document here. It cannot be downloaded, and every page carries your name, the time and a trace code.'}
      actions={total > 1 && (
        <div className="flex items-center gap-1">
          <IconButton label="Previous page" onClick={() => goTo(page - 1)} disabled={page <= 1}><CaretLeft size={16} weight="bold" /></IconButton>
          <span className="min-w-16 text-center text-xs tabular-nums text-fg-subtle" aria-live="polite">{page} / {total}</span>
          <IconButton label="Next page" onClick={() => goTo(page + 1)} disabled={page >= total}><CaretRight size={16} weight="bold" /></IconButton>
        </div>
      )}
    >
      {error && !info ? (
        <LoadError compact title="The pages could not be loaded" error={error} onRetry={() => { setError(null); setInfoAttempt((a) => a + 1); }} />
      ) : !info ? <Skeleton className="aspect-[1/1.41] w-full rounded-xl" /> : !info.preview ? (
        <Alert tone="amber" title="No preview for this file type">{info.message}</Alert>
      ) : total === 0 ? (
        <Alert tone="amber">This file has no pages to show.</Alert>
      ) : pageError ? (
        <Alert
          title={`Page ${page} could not be shown`}
          action={<Button size="sm" icon={<ArrowClockwise size={14} weight="bold" />} onClick={retryPage}>Try again</Button>}
        >
          You may have viewed many pages in a short time, or your access may have changed. Wait a moment and try again, or reload the page.
        </Alert>
      ) : (
        <div
          className={cx(
            'tv-protected relative select-none overflow-hidden rounded-xl border border-line bg-surface-2',
            // Keep the box a page's size while the image loads, so the layout and the pager don't jump.
            !loaded && 'aspect-[1/1.41]',
          )}
          onContextMenu={(e) => e.preventDefault()} onDragStart={(e) => e.preventDefault()} onCopy={(e) => e.preventDefault()}
          aria-busy={!loaded || undefined}
        >
          {!loaded && <div aria-hidden className="skeleton absolute inset-0" />}
          <img
            key={`${page}-${attempt}`}
            src={`/api/documents/${doc.id}/pages/${page}`}
            alt={`Page ${page} of ${doc.title}`}
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            onLoad={() => setLoaded(true)}
            onError={() => setPageError(true)}
            className={cx(
              'pointer-events-none block h-auto w-full transition-[opacity,filter] duration-200',
              loaded ? 'opacity-100' : 'opacity-0',
              (veiled || captureVeil) && 'blur-xl',
            )}
          />
          {/* Opaque at once, no transition: a capture right after the key press sees a blank panel. */}
          {captureVeil && <div className="absolute inset-0 bg-slate-100 dark:bg-slate-900" aria-hidden="true" />}
          {veiled && !captureVeil && (
            <div className="absolute inset-0 grid place-items-center bg-white/40 text-sm font-medium text-fg dark:bg-black/40">
              <span className="flex items-center gap-2"><EyeSlash size={18} />Hidden while this window is not in front</span>
            </div>
          )}
        </div>
      )}
      <p className="tv-print-note hidden">Printing is turned off for this document.</p>
    </Card>
  );
}

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

function AboutCard({ doc, canManage }: { doc: Doc; canManage: boolean }) {
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

function Details({ doc, canEdit, onSave }: { doc: Doc; canEdit: boolean; onSave: (patch: object) => Promise<void> }) {
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

function Versions({ doc, canDownload, canDownloadNow, needsApproval, canUpload, onUploaded, onError }: {
  doc: Doc; canDownload: boolean; canDownloadNow: boolean; needsApproval: boolean; canUpload: boolean;
  onUploaded: (removedNote: string | null) => void; onError: (m: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  // Remounts the file input so it clears after a successful upload (P9).
  const [inputKey, setInputKey] = useState(0);
  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    const form = new FormData();
    form.set('file', file);
    try {
      const r = await api.upload<UploadResult>(`/documents/${doc.id}/versions`, form);
      setFile(null);
      setInputKey((k) => k + 1);
      onUploaded(removedNotice(r?.sanitized?.removed));
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
          <li key={v.versionNo} className={cx('relative flex animate-rise gap-4 pb-4 last:pb-0', staggerClass(i))}>
            {i < doc.versions.length - 1 && <span className="absolute left-5 top-11 h-[calc(100%-2.75rem)] w-px bg-line-strong" />}
            <FileIcon fileName={v.fileName} />
            <div className={cx('min-w-0 flex-1 rounded-xl border p-3 transition', i === 0 ? 'border-brand-200 bg-brand-50/40 dark:border-brand-400/25 dark:bg-brand-500/5' : 'border-line', v.quarantine && 'border-danger-300/60 bg-danger-50/50 dark:border-danger-500/30 dark:bg-danger-500/5')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    Version {v.versionNo}{i === 0 && <Badge tone="violet">Current</Badge>}
                  </p>
                  <p className="truncate text-xs text-fg-subtle" title={v.fileName}>{v.fileName} · {formatBytes(v.sizeBytes)} · by {v.uploadedBy}, {relativeTime(v.createdAt)}</p>
                </div>
                {v.quarantine ? (
                  <Badge tone="red" icon={<Prohibit size={11} />}>Download blocked</Badge>
                ) : !canDownload ? (
                  <Badge icon={<EyeSlash size={11} />}>View only</Badge>
                ) : !canDownloadNow ? (
                  // The API refuses this download (P5): say why instead of offering a link that fails.
                  needsApproval
                    ? <Badge tone="amber" icon={<HandPalm size={11} />}>Needs approval</Badge>
                    : <Badge icon={<EyeSlash size={11} />}>View only</Badge>
                ) : (
                  <ButtonLink size="sm" href={`/api/documents/${doc.id}/versions/${v.versionNo}/download`} icon={<DownloadSimple size={14} />}>Download</ButtonLink>
                )}
              </div>
              {v.quarantine && (
                <p className="mt-2 flex items-start gap-2 break-words text-xs font-medium text-danger-700 dark:text-danger-300">
                  <Biohazard size={16} className="shrink-0" />Quarantined {formatDate(v.quarantine.foundAt)}: the malware scanner found {v.quarantine.signature}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
      {canUpload && (
        <form onSubmit={upload} className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-line-strong p-4 transition-colors focus-within:border-brand-400 dark:focus-within:border-brand-400/60">
          <div className="min-w-[12.5rem] flex-1"><Label label="Upload a new version" hint="Scanned for malware and encrypted before it is stored."><Input key={inputKey} type="file" disabled={busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Label></div>
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
  policy?: SharePolicyView;
}

interface OverrideRow { id: string; reason: string; createdAt: string; expiresAt: string; user: { id: string; displayName: string; email: string } }

interface Suggestion { type: 'user' | 'group'; id: string; name: string; detail: string; level: Level; why: string }
interface DirUser { id: string; displayName: string; email: string; role: string; accessExpiresAt: string | null }
interface DirGroup { id: string; name: string; members: number }

const LEVELS: { id: Level; title: string; text: string; icon: ReactNode }[] = [
  { id: 'VIEW', title: 'View only', text: 'Pages in TrustVault, marked with their name. No download', icon: <EyeSlash size={18} /> },
  { id: 'READ', title: 'Download', text: 'Also download a copy stamped with their name', icon: <DownloadSimple size={18} /> },
  { id: 'EDIT', title: 'Edit', text: 'Also rename, upload versions', icon: <PencilSimple size={18} /> },
  { id: 'MANAGE', title: 'Manage', text: 'Also share, see history', icon: <ShareNetwork size={18} /> },
];
/** "Give view-only access", "Give download access", … */
const giveLabel = (l: Level) => `Give ${l === 'VIEW' ? 'view-only' : (ACCESS_LABEL[l] ?? l).toLowerCase()} access`;

const NO_RESULTS: { users: DirUser[]; groups: DirGroup[] } = { users: [], groups: [] };

/** A deleted grant's conditions, in the shape the share API takes (for Undo). */
function policyOf(v?: SharePolicyView): SharePolicy | undefined {
  if (!v || (!v.downloadApproval && !v.window && !v.networks)) return undefined;
  return { downloadApproval: v.downloadApproval, approverId: v.approver?.id ?? null, window: v.window, networks: v.networks };
}

type Pick = { kind: 'group'; group: DirGroup } | { kind: 'user'; user: DirUser };

function AccessPanel({ doc, onError }: { doc: Doc; onError: (m: string | null) => void }) {
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const { busy, run } = useAction();
  const [grants, setGrants] = useState<GrantRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(NO_RESULTS);
  const [resultsFor, setResultsFor] = useState('');
  const [searching, setSearching] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [target, setTarget] = useState<{ type: 'user' | 'group'; id: string; label: string; external: boolean } | null>(null);
  const [level, setLevel] = useState<Level>('READ');
  const [expires, setExpires] = useState('');
  const [policy, setPolicy] = useState<SharePolicy | undefined>(undefined);
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [exceptionFor, setExceptionFor] = useState<{ id: string; name: string } | null>(null);
  const searchLatest = useLatest();
  const grantsLatest = useLatest();
  const searchRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const t = grantsLatest.begin();
    try {
      const r = await api.get<{ grants: GrantRow[]; overrides?: OverrideRow[] }>(`/documents/${doc.id}/access`, { signal: t.signal });
      if (!t.isLatest()) return;
      setGrants(r.grants);
      setOverrides(r.overrides ?? []);
      setLoadError(null);
    } catch (err) {
      if (!t.isLatest() || isAbortError(err)) return;
      setLoadError(errorText(err));
    }
  }, [doc.id, grantsLatest]);

  useEffect(() => {
    void load();
  }, [load]);

  // Directory search: debounced, and an older reply can never overwrite a newer one (P11).
  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) {
      searchLatest.cancel();
      setResults(NO_RESULTS);
      setResultsFor('');
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      const t = searchLatest.begin();
      try {
        const r = await api.get<{ users: DirUser[]; groups: DirGroup[] }>(`/directory?q=${encodeURIComponent(q)}`, { signal: t.signal });
        if (!t.isLatest()) return;
        setResults(r);
        setResultsFor(q);
      } catch (err) {
        if (!t.isLatest() || isAbortError(err)) return;
        setResults(NO_RESULTS);
        setResultsFor(q);
      } finally {
        if (t.isLatest()) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [q, searchLatest]);

  const options: Pick[] = [
    ...results.groups.map((group) => ({ kind: 'group' as const, group })),
    ...results.users.filter((u) => u.id !== doc.owner.id).map((user) => ({ kind: 'user' as const, user })),
  ];
  const noMatch = q.length >= 2 && resultsFor === q && !searching && options.length === 0;
  const showList = listOpen && q.length >= 2 && (options.length > 0 || noMatch);

  const pick = (o: Pick | undefined) => {
    if (!o) return;
    if (o.kind === 'group') setTarget({ type: 'group', id: o.group.id, label: `group ${o.group.name}`, external: false });
    else {
      setTarget({ type: 'user', id: o.user.id, label: o.user.displayName, external: o.user.role === 'EXTERNAL' });
      setLevel(o.user.role === 'EXTERNAL' ? 'VIEW' : 'READ');
    }
    setQuery('');
    setResults(NO_RESULTS);
    setListOpen(false);
  };
  const nav = useListNav({ count: options.length, onSelect: (i) => pick(options[i]), open: showList });

  const share = async (key: string, subject: { userId?: string; groupId?: string }, lvl: Level, expiresAt: string | null, fromSuggestion = false, label = '', withPolicy?: SharePolicy) => {
    const ok = await run(key, async () => {
      onError(null);
      try {
        await api.put(`/documents/${doc.id}/access`, { ...subject, level: lvl, expiresAt, fromSuggestion, ...(withPolicy ? { policy: withPolicy } : {}) });
        toast(`${label || 'Access'} can now ${lvl === 'VIEW' ? 'view (not download)' : lvl === 'READ' ? 'view and download' : lvl === 'EDIT' ? 'edit' : 'manage'} this document.`);
        await load();
        setSuggestions((s) => (s ? s.filter((x) => x.id !== (subject.userId ?? subject.groupId)) : s));
        return true;
      } catch (err) {
        onError(errorText(err));
        return false;
      }
    });
    return ok === true;
  };

  // Undo for a removal: share again with the same level, end date and conditions.
  const undoRevoke = (g: GrantRow) => {
    void share(
      `undo:${g.id}`,
      g.subject.type === 'user' ? { userId: g.subject.id } : { groupId: g.subject.id },
      g.level,
      g.expiresAt,
      false,
      g.subject.type === 'group' ? `group ${g.subject.name}` : g.subject.name,
      policyOf(g.policy),
    );
  };

  const revoke = (g: GrantRow) => {
    if (busy) return;
    onError(null);
    void confirm({
      title: `Remove ${g.subject.name}'s access?`,
      body: g.subject.type === 'group'
        ? `Members of ${g.subject.name} lose this share on their next request, unless they have their own.`
        : `${g.subject.name} loses this share on their next request. You can share it with them again later.`,
      confirmLabel: 'Remove access',
      danger: true,
      icon: <Trash size={20} />,
      onConfirm: async () => {
        const r = await api.delete<{ stillHas: string | null }>(`/documents/${doc.id}/access/${g.id}`);
        const undo = { action: { label: 'Undo', onClick: () => undoRevoke(g) } };
        // Their own grant is gone, but a group grant may still cover them. Say so.
        if (r?.stillHas) toast(`Removed ${g.subject.name}'s own access, but they can still ${LEVEL_WORD[r.stillHas] ?? 'open'} it through a group. Remove that group's grant to cut them off.`, 'info', undo);
        else toast(`Access removed for ${g.subject.name}. It stops working on their next request.`, 'success', undo);
        await load();
      },
    });
  };

  const endOverride = (o: OverrideRow) => run(`end:${o.id}`, async () => {
    onError(null);
    try {
      await api.delete(`/documents/${doc.id}/overrides/${o.id}`);
      toast('Exception ended. The share conditions apply again.');
      await load();
    } catch (err) {
      onError(errorText(err));
    }
  });

  const loadSuggestions = async () => {
    if (loadingSuggestions) return;
    setLoadingSuggestions(true);
    try {
      const r = await api.get<{ suggestions: Suggestion[] }>(`/documents/${doc.id}/suggestions`);
      setSuggestions(r.suggestions);
    } catch (err) {
      onError(errorText(err));
    } finally {
      setLoadingSuggestions(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target) return;
    if (policy?.networks && policy.networks.length === 0) {
      onError('Add at least one network range, or untick "Only from these networks".');
      return;
    }
    const ok = await share('share', target.type === 'user' ? { userId: target.id } : { groupId: target.id }, level, localDayEndISO(expires) ?? null, false, target.label, policy);
    if (ok) {
      setTarget(null);
      setQuery('');
      setExpires('');
      setPolicy(undefined);
    }
  };

  const levels = LEVELS.filter((l) => l.id === 'VIEW' || l.id === 'READ' || (!target?.external && (l.id === 'EDIT' || doc.isOwner)));

  return (
    <>
      <Card title="Share this document" icon={<UserPlus size={20} />} description="Access is granted to this one document only. Changes take effect immediately.">
        <form onSubmit={submit} className="space-y-4">
          {target ? (
            <div className="flex animate-pop items-center gap-3 rounded-xl border border-brand-200 bg-brand-50/60 p-3 dark:border-brand-400/25 dark:bg-brand-500/10">
              {target.type === 'group' ? <IconTile size="sm" tone="blue"><UsersFour size={16} /></IconTile> : <Avatar name={target.label} size="sm" />}
              <span className="min-w-0 flex-1 break-words text-sm">Sharing with <span className="font-semibold">{target.label}</span>{target.external && <Badge tone="amber" className="ml-2">External</Badge>}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                icon={<ArrowsLeftRight size={14} />}
                disabled={busy === 'share'}
                onClick={() => {
                  setTarget(null);
                  setQuery('');
                  requestAnimationFrame(() => searchRef.current?.querySelector('input')?.focus());
                }}
              >Change</Button>
            </div>
          ) : (
            <div className="relative" ref={searchRef}>
              <Input
                icon={<MagnifyingGlass size={18} />}
                placeholder="Type a name, email or group (2+ letters)"
                aria-label="Find a person or group"
                autoComplete="off"
                value={query}
                {...nav.inputProps}
                onChange={(e) => { setQuery(e.target.value); setListOpen(true); }}
                onFocus={() => setListOpen(true)}
                onBlur={() => setListOpen(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && showList) {
                    e.preventDefault();
                    e.stopPropagation();
                    setListOpen(false);
                    return;
                  }
                  if (!listOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) setListOpen(true);
                  nav.onKeyDown(e);
                }}
              />
              {searching && q.length >= 2 && <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin rounded-full border-2 border-line-strong border-r-transparent dark:border-r-transparent" />}
              {showList && (
                <ul {...nav.listProps} aria-label="People and groups" className="absolute z-10 mt-2 max-h-80 w-full animate-pop overflow-y-auto overflow-x-hidden rounded-xl border border-line bg-raised p-1 text-sm shadow-lift">
                  {noMatch ? (
                    <li role="presentation" className="px-3 py-2.5 text-fg-subtle">No people or groups match “{q}”.</li>
                  ) : options.map((o, i) => (
                    <li
                      key={o.kind === 'group' ? `g-${o.group.id}` : `u-${o.user.id}`}
                      {...nav.optionProps(i)}
                      className={cx('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors duration-150 pointer-coarse:min-h-11', nav.active === i ? 'bg-surface-2 dark:bg-white/[0.07]' : 'hover:bg-surface-2/70 dark:hover:bg-white/5')}
                    >
                      {o.kind === 'group' ? (
                        <>
                          <IconTile size="sm" tone="blue"><UsersFour size={16} /></IconTile>
                          <span className="min-w-0 flex-1"><span className="block truncate font-medium">{o.group.name}</span><span className="block text-xs text-fg-subtle">Group · {o.group.members} members</span></span>
                        </>
                      ) : (
                        <>
                          <Avatar name={o.user.displayName} size="sm" />
                          <span className="min-w-0 flex-1"><span className="block truncate font-medium">{o.user.displayName}</span><span className="block truncate text-xs text-fg-subtle">{o.user.email}</span></span>
                          {o.user.role === 'EXTERNAL' && <Badge tone="amber">External</Badge>}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div>
            <p className="mb-2 text-[0.8125rem] font-medium text-fg-muted">Access level</p>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Access">
              {levels.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  aria-checked={level === l.id}
                  onClick={() => setLevel(l.id)}
                  className={cx('flex items-start gap-3 rounded-xl border p-3 text-left transition duration-150 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50', level === l.id ? 'border-brand-400 bg-brand-50 ring-4 ring-brand-500/10 dark:border-brand-400/60 dark:bg-brand-500/10' : 'border-line hover:border-line-strong hover:bg-surface-2/60 dark:hover:bg-white/[0.03]')}
                >
                  <span className={cx('mt-0.5 transition-colors', level === l.id ? 'text-brand-600 dark:text-brand-300' : 'text-fg-subtle')}>{l.icon}</span>
                  <span><span className="block text-sm font-semibold">{l.title}</span><span className="block text-xs text-fg-subtle">{l.text}</span></span>
                </button>
              ))}
            </div>
            {target?.external && <p className="mt-2 animate-fade-in text-xs text-warning-700 dark:text-warning-300">External people get View only or Download, and it must end on a date. View only is suggested: the file never leaves TrustVault.</p>}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full sm:w-56">
              <Label label={target?.external ? 'Expires on (required for external)' : 'Expires on (optional)'}>
                <Input type="date" value={expires} required={target?.external} min={localTodayISO()} onChange={(e) => setExpires(e.target.value)} />
              </Label>
            </div>
            <Button type="submit" variant="primary" size="lg" icon={<ShareNetwork size={18} />} disabled={!target || (!!busy && busy !== 'share')} loading={busy === 'share'}>
              {busy === 'share' ? 'Sharing…' : 'Share'}
            </Button>
          </div>
          <PolicyFields
            value={policy}
            onChange={setPolicy}
            managers={(grants ?? []).filter((g) => g.level === 'MANAGE' && g.subject.type === 'user' && g.subject.id !== target?.id).map((g) => ({ id: g.subject.id, name: g.subject.name }))}
          />
        </form>
      </Card>

      <Card title="Who has access" icon={<UsersFour size={20} />} actions={grants && <Badge>{grants.length} {grants.length === 1 ? 'share' : 'shares'}</Badge>} padded={false}>
        {!grants ? (
          loadError
            ? <div className="p-5"><LoadError compact title="Couldn't load who has access" error={loadError} retrying={reloading} onRetry={() => { setReloading(true); void load().finally(() => setReloading(false)); }} /></div>
            : <SkeletonRows rows={3} />
        ) : (
          <>
            {loadError && <div className="border-b border-line px-5 py-3"><Alert tone="amber" onDismiss={() => setLoadError(null)}>This list may be out of date: {loadError}</Alert></div>}
            <ul className="divide-y divide-line">
              <li className="flex items-center gap-3 px-5 py-3.5">
                <Avatar name={doc.owner.displayName} />
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{doc.owner.displayName}{doc.isOwner && <span className="font-normal text-fg-subtle"> (you)</span>}</p><p className="truncate text-xs text-fg-subtle">{doc.owner.email}</p></div>
                <Badge tone="violet" icon={<Crown size={11} />}>Owner</Badge>
              </li>
              {grants.map((g, gi) => {
                const revoking = busy === `undo:${g.id}`;
                return (
                  <li key={g.id} className={cx('flex animate-rise flex-wrap items-center gap-3 px-5 py-3.5', staggerClass(gi + 1))}>
                    {g.subject.type === 'group' ? <IconTile tone="blue"><UsersFour size={18} /></IconTile> : <Avatar name={g.subject.name} />}
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 break-words text-sm font-semibold">
                        {g.subject.type === 'group' ? <>{g.subject.name}<span className="font-normal text-fg-subtle">· group of {g.subject.members}</span></> : g.subject.name}
                        {g.subject.type === 'user' && g.subject.role === 'EXTERNAL' && <Badge tone="amber">External</Badge>}
                        {g.subject.type === 'user' && !g.subject.active && <Badge tone="red">Inactive</Badge>}
                      </p>
                      <p className="truncate text-xs text-fg-subtle">
                        {g.subject.type === 'user' && <>{g.subject.email} · </>}granted by {g.grantedBy}
                        {g.expiresAt && <> · {g.expired ? <span className="font-medium text-danger-700 dark:text-danger-300">expired</span> : 'expires'} {formatDate(g.expiresAt)}</>}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1"><ConditionBadges policy={g.policy} /></div>
                      {doc.isOwner && g.subject.type === 'user' && g.policy && (g.policy.downloadApproval || g.policy.window || g.policy.networks) && (
                        <Button size="sm" variant="ghost" className="mt-1 -ml-2.5" icon={<Siren size={14} />} onClick={() => setExceptionFor({ id: g.subject.id, name: g.subject.name })}>Emergency exception…</Button>
                      )}
                      {g.subject.type === 'group' && (g.subject.pending ?? 0) > 0 && (
                        <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-warning-700 dark:text-warning-300">
                          {g.subject.pending} added to the group since you shared. They cannot open it until you confirm.
                          <Button
                            size="sm"
                            variant="soft"
                            icon={<UserPlus size={14} />}
                            loading={busy === `confirm:${g.id}`}
                            disabled={!!busy}
                            onClick={() => void share(`confirm:${g.id}`, { groupId: g.subject.id }, g.level, g.expiresAt, false, `group ${g.subject.name}`)}
                          >Confirm</Button>
                        </p>
                      )}
                    </div>
                    <Badge dot tone={ACCESS_TONE[g.level]}>{ACCESS_LABEL[g.level]}</Badge>
                    {(doc.isOwner || g.level !== 'MANAGE') && (
                      <IconButton
                        label={`Remove access for ${g.subject.name}`}
                        disabled={!!busy || revoking}
                        onClick={() => revoke(g)}
                        className="hover:bg-danger-50 hover:text-danger-600 active:bg-danger-100 dark:hover:bg-danger-500/10 dark:hover:text-danger-300 dark:active:bg-danger-500/20"
                      ><Trash size={18} /></IconButton>
                    )}
                  </li>
                );
              })}
            </ul>
            {grants.length === 0 && <p className="flex animate-fade-in items-center gap-2 border-t border-line px-5 py-4 text-sm text-fg-subtle"><LockKey size={16} className="shrink-0" />Only the owner can open this document.</p>}
          </>
        )}
        {overrides.length > 0 && (
          <div className="border-t border-line px-5 py-4">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-warning-700 dark:text-warning-300"><Siren size={14} />Emergency exceptions in force</p>
            <ul className="space-y-2 text-sm">
              {overrides.map((o) => (
                <li key={o.id} className="flex animate-fade-in flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 break-words"><span className="font-medium">{o.user.displayName}</span> until {formatDate(o.expiresAt)}: “{o.reason}”</span>
                  <Button size="sm" variant="soft" icon={<Prohibit size={14} />} loading={busy === `end:${o.id}`} disabled={!!busy} onClick={() => void endOverride(o)}>End now</Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      <ExceptionDialog
        target={exceptionFor}
        onClose={() => setExceptionFor(null)}
        onSubmit={async (who, reason, hours) => {
          await api.post(`/documents/${doc.id}/overrides`, { userId: who.id, reason, hours });
          toast(`${who.name} can use this document without its conditions for ${hours} hour${hours === 1 ? '' : 's'}. You were emailed a receipt.`);
          setExceptionFor(null);
          await load();
        }}
      />
      {confirmDialog}

      <Card
        title="Suggested people"
        icon={<Sparkle size={20} />}
        description="Based on who you shared similar documents with. Never grants access by itself."
        actions={
          <Button size="sm" variant="soft" icon={<Sparkle size={14} />} loading={loadingSuggestions} onClick={() => void loadSuggestions()}>
            {suggestions ? 'Refresh' : 'Show suggestions'}
          </Button>
        }
      >
        {!suggestions ? (
          <p className="flex items-start gap-2 text-sm text-fg-subtle"><Info size={16} className="mt-0.5 shrink-0" />You confirm each one, and both the suggestion and your decision are recorded.</p>
        ) : suggestions.length === 0 ? (
          <p className="flex animate-fade-in items-center gap-2 text-sm text-fg-subtle"><Sparkle size={16} className="shrink-0" />No suggestions for this document.</p>
        ) : (
          <ul className="space-y-2">
            {suggestions.map((s, si) => (
              <li key={s.id} className={cx('flex animate-rise flex-wrap items-center gap-3 rounded-xl border border-line p-3 transition-colors hover:border-line-strong', staggerClass(si))}>
                {s.type === 'group' ? <IconTile size="sm" tone="blue"><UsersFour size={16} /></IconTile> : <Avatar name={s.name} size="sm" />}
                <div className="min-w-0 flex-1 break-words">
                  <p className="text-sm font-semibold">{s.type === 'group' ? `Group: ${s.name}` : s.name} <span className="font-normal text-fg-subtle">{s.type === 'user' ? s.detail : ''}</span></p>
                  <p className="text-xs text-fg-subtle">{s.why}</p>
                </div>
                <Button
                  size="sm"
                  icon={<UserPlus size={14} />}
                  loading={busy === `suggest:${s.id}`}
                  disabled={!!busy}
                  onClick={() => void share(`suggest:${s.id}`, s.type === 'user' ? { userId: s.id } : { groupId: s.id }, s.level, null, true, s.name)}
                >{giveLabel(s.level)}</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

interface HistoryEvent { seq: string; occurredAt: string; actorEmail: string | null; action: string; outcome: 'ALLOWED' | 'DENIED' | 'FAILED'; reason: string | null; details?: { sanitized?: { removed?: string[] } } | null }

/** A capture attempt names its method: "Tried to take a screenshot (Print Screen)" (THREATS.md V11). */
function historyLabel(e: HistoryEvent): string {
  if (e.action === 'document.capture_attempt') {
    const how = CAPTURE_METHOD_LABEL[e.reason as CaptureMethod];
    return how ? `Tried to take a screenshot (${how})` : 'Tried to take a screenshot';
  }
  return actionMeta(e.action).label;
}

function History({ docId }: { docId: string }) {
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    api.get<{ events: HistoryEvent[] }>(`/documents/${docId}/history`)
      .then((r) => { if (live) { setEvents(r.events); setError(null); } })
      // A failure is an error with Retry, never "No activity yet" (P8).
      .catch((err) => { if (live) setError(errorText(err)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [docId, attempt]);
  return (
    <Card title="History" icon={<ClockCounterClockwise size={20} />} description="Everything that happened to this document, including refused attempts." padded={false}>
      {error && !events ? (
        <div className="p-5"><LoadError compact title="Couldn't load the history" error={error} retrying={loading} onRetry={() => setAttempt((a) => a + 1)} /></div>
      ) : !events ? <SkeletonRows rows={5} label="Loading the history…" /> : events.length === 0 ? (
        <EmptyState art={<SpotArt icon={<ClockCounterClockwise size={30} />} />} title="No activity yet" />
      ) : (
        <ol className="max-h-[36rem] animate-fade-in overflow-y-auto px-5 py-4">
          {events.map((e, i) => (
            <li key={e.seq} className={cx('relative flex animate-rise gap-3 pb-5 last:pb-0', staggerClass(i))}>
              {i < events.length - 1 && <span className="absolute left-4 top-9 h-[calc(100%-2rem)] w-px bg-line-strong" />}
              <ActionIcon action={e.action} outcome={e.outcome} />
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold">{historyLabel(e)}</p>
                  {e.outcome !== 'ALLOWED' && <Badge tone={OUTCOME_TONE[e.outcome]}>{e.outcome === 'DENIED' ? 'Refused' : 'Failed'}</Badge>}
                </div>
                <p className="mt-0.5 break-words text-xs text-fg-subtle">
                  {e.actorEmail ?? 'system'} · <span title={formatDate(e.occurredAt)}>{relativeTime(e.occurredAt)}</span>
                  {e.reason && e.action !== 'document.capture_attempt' && <> · {e.reason.replace(/_/g, ' ')}</>}
                </p>
                {removedNotice(e.details?.sanitized?.removed) && <p className="mt-0.5 text-xs text-fg-subtle">{removedNotice(e.details?.sanitized?.removed)}</p>}
              </div>
              <span className="hidden pt-1 font-mono text-[0.6875rem] text-fg-subtle sm:block">#{e.seq}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function OwnerActions(props: {
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

function ExceptionDialog({ target, onClose, onSubmit }: {
  target: { id: string; name: string } | null;
  onClose: () => void;
  onSubmit: (who: { id: string; name: string }, reason: string, hours: number) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(4);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Keep the last person while the dialog animates out; start fresh for a new one.
  const [shown, setShown] = useState(target);
  if (target && target !== shown) {
    setShown(target);
    if (target.id !== shown?.id) { setReason(''); setHours(4); setError(null); }
  }
  const valid = reason.trim().length >= 10;
  const submit = async () => {
    if (!shown || !valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(shown, reason.trim(), hours);
      setReason('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={Boolean(target)}
      onClose={() => { if (!busy) { setError(null); onClose(); } }}
      dismissible={!busy}
      title={`Emergency exception for ${shown?.name ?? ''}`}
      description="Lifts the time window, network and download-approval conditions of their share for a few hours. It never gives more than the share's level, and organisation-wide role rules still apply. Recorded, and they are emailed."
      icon={<Siren size={20} />}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={<Siren size={16} />} disabled={!valid} loading={busy} onClick={() => void submit()}>Give exception</Button>
      </>}
    >
      <div className="space-y-3">
        <Label label="Reason (recorded and emailed)" hint={`At least 10 characters.${reason.trim().length > 0 && !valid ? ` ${10 - reason.trim().length} more to go.` : ''}`}>
          <Textarea data-autofocus rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} disabled={busy} />
        </Label>
        <Label label="For how long">
          <Select value={hours} disabled={busy} onChange={(e) => setHours(Number(e.target.value))}>
            {[1, 2, 4, 8, 12, 24].map((h) => <option key={h} value={h}>{h} hour{h === 1 ? '' : 's'}</option>)}
          </Select>
        </Label>
        {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
      </div>
    </Modal>
  );
}
