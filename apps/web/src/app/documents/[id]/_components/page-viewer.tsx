'use client';

import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Eye, CaretLeft, CaretRight, EyeSlash, ArrowClockwise } from '@phosphor-icons/react';
import { Alert, Button, Card, IconButton, LoadError, Skeleton, cx } from '@/components/ui';
import { api, beacon, errorText } from '@/lib/api';
import { CAPTURE_VEIL_MS, CLIPBOARD_NOTICE, captureMethod, shouldReport } from '@/lib/capture-guard';
import type { Doc } from './types';

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
export function PageViewer({ doc, canDownload, approved }: { doc: Doc; canDownload: boolean; approved: boolean }) {
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
