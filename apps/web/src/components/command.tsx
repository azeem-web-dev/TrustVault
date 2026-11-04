'use client';

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, FileMagnifyingGlass, KeyReturn, MagnifyingGlass } from '@phosphor-icons/react';
import { api } from '@/lib/api';
import { useExitState, useLatest } from '@/lib/hooks';
import { FileIcon, IconTile, Kbd, Spinner, cx, useLayer, useListNav } from './ui';

export interface CommandLink { href: string; label: string; icon: ReactNode; hint?: string }
interface DocHit { id: string; title: string; category: string; current: { fileName: string } | null; owner: { displayName: string }; isOwner: boolean }

/**
 * Ctrl/⌘+K: jump to any page, or find a document by name. Search only ever
 * returns documents you can access. An ARIA combobox over a listbox: ↑/↓
 * move (the active row scrolls into view), Enter opens, Escape closes only
 * the palette (never a dialog underneath), Tab stays inside, and focus goes
 * back to wherever it was when the palette opened.
 */
export function CommandPalette({ open, onClose, links }: { open: boolean; onClose: () => void; links: CommandLink[] }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [docs, setDocs] = useState<DocHit[]>([]);
  const [searching, setSearching] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const latest = useLatest();
  const { mounted, state } = useExitState(open, 160);
  const headingId = useId();

  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });

  // Escape (topmost layer only, D3) and a Tab trap inside the panel (D4).
  useLayer(open, () => close.current(), { panel, trap: true });

  // Reset on open; move focus in, and give it back on close.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    setQ('');
    setDocs([]);
    setSearching(false);
    input.current?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      const ours = !now || now === document.body || (panel.current?.contains(now) ?? false);
      if (ours && opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  // Debounced document search; only the newest response is used (X5).
  useEffect(() => {
    const term = q.trim();
    if (!open || term.length < 2) {
      latest.cancel();
      setDocs([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      const ticket = latest.begin();
      api.get<{ documents: DocHit[] }>(`/documents?scope=all&page=1&q=${encodeURIComponent(term)}`, { signal: ticket.signal })
        .then((r) => { if (ticket.isLatest()) { setDocs(r.documents.slice(0, 6)); setSearching(false); } })
        .catch(() => { if (ticket.isLatest()) { setDocs([]); setSearching(false); } });
    }, 200);
    return () => clearTimeout(t);
  }, [q, open, latest]);

  const pages = useMemo(() => links.filter((l) => l.label.toLowerCase().includes(q.trim().toLowerCase())), [links, q]);
  const items = useMemo(
    () => [
      ...docs.map((d) => ({ key: `d-${d.id}`, href: `/documents/${d.id}`, label: d.title, node: <DocRow d={d} /> })),
      ...pages.map((l) => ({ key: `p-${l.href}`, href: l.href, label: l.label, node: <PageRow l={l} /> })),
    ],
    [docs, pages],
  );

  const go = (href: string) => {
    onClose();
    router.push(href);
  };
  const nav = useListNav({ count: items.length, open, onSelect: (i) => { const it = items[i]; if (it) go(it.href); } });
  const { setActive } = nav;

  // New results: highlight the first one again.
  useEffect(() => { setActive(items.length ? 0 : -1); }, [items, setActive]);

  if (!mounted) return null;

  const term = q.trim();
  const docItems = items.slice(0, docs.length);
  const pageItems = items.slice(docs.length);
  const option = (it: (typeof items)[number], i: number) => {
    const on = i === nav.active;
    return (
      <button
        key={it.key}
        type="button"
        tabIndex={-1}
        {...nav.optionProps(i)}
        className={cx(
          'flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors duration-100 active:bg-brand-100/70 dark:active:bg-brand-500/20',
          on ? 'bg-brand-50 text-brand-900 dark:bg-brand-500/15 dark:text-white' : 'text-fg hover:bg-slate-50 dark:hover:bg-white/5',
        )}
      >
        {it.node}
        <KeyReturn size={16} aria-hidden className={cx('ml-auto shrink-0 text-brand-500 transition duration-150', on ? 'translate-x-0 opacity-100' : '-translate-x-1 opacity-0')} />
      </button>
    );
  };

  const status = term.length < 2
    ? (pages.length ? '' : 'Type at least two letters to search documents.')
    : searching ? 'Searching…' : `${docs.length} document${docs.length === 1 ? '' : 's'} and ${pages.length} page${pages.length === 1 ? '' : 's'} found.`;

  return (
    <div
      className="fixed inset-0 z-[55] flex items-start justify-center px-4 pt-[max(1rem,12vh)]"
      data-state={state}
      inert={state === 'closed' || undefined}
    >
      <div aria-hidden data-state={state} className="absolute inset-0 animate-fade-in bg-slate-950/50 backdrop-blur-sm data-[state=closed]:animate-fade-out" onClick={() => close.current()} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-state={state}
        className="relative w-full max-w-xl origin-top animate-pop overflow-hidden rounded-2xl border border-line bg-raised shadow-lift data-[state=closed]:animate-pop-out dark:border-white/10"
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          {searching ? <Spinner className="size-5 shrink-0 text-brand-500" /> : <MagnifyingGlass size={20} aria-hidden className="shrink-0 animate-fade-in text-fg-subtle" />}
          <input
            ref={input}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            {...nav.inputProps}
            aria-label="Search documents or pages"
            aria-busy={searching || undefined}
            placeholder="Search documents or jump to a page…"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="go"
            className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-slate-400 sm:text-[0.9375rem] dark:placeholder:text-slate-500"
          />
          <button
            type="button"
            tabIndex={-1}
            onClick={() => close.current()}
            className="hidden rounded-md transition duration-150 hover:opacity-75 active:scale-95 sm:block"
            aria-label="Close"
          >
            <Kbd>Esc</Kbd>
          </button>
        </div>
        <div {...nav.listProps} aria-label="Results" className="max-h-[50vh] overflow-y-auto overscroll-contain p-2">
          {docItems.length > 0 && (
            <div role="group" aria-labelledby={`${headingId}-docs`} className="animate-fade-in">
              <p id={`${headingId}-docs`} className="px-3 pb-1 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">Documents</p>
              {docItems.map((it, i) => option(it, i))}
            </div>
          )}
          {pageItems.length > 0 && (
            <div role="group" aria-labelledby={`${headingId}-pages`}>
              <p id={`${headingId}-pages`} className={cx('px-3 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle', docItems.length ? 'pt-3' : 'pt-2')}>Go to</p>
              {pageItems.map((it, i) => option(it, docs.length + i))}
            </div>
          )}
          {items.length === 0 && (
            <div className="flex animate-fade-in flex-col items-center justify-center gap-3 px-3 py-10 text-center text-sm text-fg-subtle">
              {term.length < 2
                ? <><IconTile tone="slate"><MagnifyingGlass size={20} /></IconTile>Type to search.</>
                : searching
                  ? <><Spinner className="size-5 text-brand-500" />Searching…</>
                  : <><IconTile tone="slate"><FileMagnifyingGlass size={20} /></IconTile>Nothing you can access matches.</>}
            </div>
          )}
        </div>
        <p className="sr-only" role="status" aria-live="polite">{status}</p>
        <div className="flex items-center gap-4 border-t border-line px-4 py-2.5 text-[0.6875rem] text-fg-subtle">
          <span className="hidden items-center gap-1 sm:flex"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
          <span className="hidden items-center gap-1 sm:flex"><Kbd>Enter</Kbd> open</span>
          <span className="sm:ml-auto">Results only include documents you can access</span>
        </div>
      </div>
    </div>
  );
}

function DocRow({ d }: { d: DocHit }) {
  return (
    <>
      <FileIcon fileName={d.current?.fileName} size="sm" />
      <span className="min-w-0">
        <span className="block truncate font-medium">{d.title}</span>
        <span className="block truncate text-xs text-fg-subtle">{d.category} · {d.isOwner ? 'You' : d.owner.displayName}</span>
      </span>
    </>
  );
}

function PageRow({ l }: { l: CommandLink }) {
  return (
    <>
      <IconTile tone="slate" size="sm">{l.icon}</IconTile>
      <span className="shrink-0 font-medium">{l.label}</span>
      {l.hint && <span className="min-w-0 truncate text-xs text-fg-subtle">{l.hint}</span>}
      <ArrowRight size={14} aria-hidden className="ml-auto shrink-0 text-fg-subtle opacity-60" />
    </>
  );
}
