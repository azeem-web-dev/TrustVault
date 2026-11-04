'use client';

// A VS Code-style explorer for an owner's folders and the documents inside
// them. It reads only data that already exists: GET /folders (passed in) and
// GET /documents?scope=mine&folderId=<id> for a folder's contents, loaded
// lazily the first time a folder is opened. Keyboard-navigable as an ARIA
// tree: ↑/↓ move, → expands (or steps into), ← collapses (or steps out to the
// parent folder), Home/End jump, Enter/Space select a folder or open a document.

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, CaretRight, FolderOpen, FolderSimple, FolderSimplePlus, Stack, WarningCircle } from '@phosphor-icons/react';
import { api } from '@/lib/api';
import { FileIcon, Spinner, cx } from './ui';

export interface TreeFolder { id: string; name: string; documents: number }
interface DocLite { id: string; title: string; current: { fileName: string } | null }
interface DocPage { documents: DocLite[]; total: number }
type DocState = DocPage | 'loading' | 'error' | undefined;

const isPage = (s: DocState): s is DocPage => typeof s === 'object' && s !== null;

export function FolderTree({
  folders, selectedFolderId, onSelectFolder, activeDocId, className, version = 0,
}: {
  folders: TreeFolder[];
  selectedFolderId: string | null;
  onSelectFolder: (id: string | null) => void;
  activeDocId?: string;
  className?: string;
  /** Bump after uploads, trashes or folder changes: expanded folders reload their contents. */
  version?: number;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [docs, setDocs] = useState<Record<string, DocState>>({});
  const [activeKey, setActiveKey] = useState<string>('root');
  const rows = useRef<Map<string, HTMLElement>>(new Map());
  const seq = useRef<Record<string, number>>({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const loadDocs = useCallback(async (id: string) => {
    const n = (seq.current[id] ?? 0) + 1;
    seq.current[id] = n;
    // Keep what is already shown while refreshing; only an empty slot shows "Loading…".
    setDocs((d) => (isPage(d[id]) ? d : { ...d, [id]: 'loading' }));
    try {
      const r = await api.get<{ documents: DocLite[]; total: number }>(`/documents?scope=mine&folderId=${encodeURIComponent(id)}&page=1`);
      if (!alive.current || seq.current[id] !== n) return;
      setDocs((d) => ({ ...d, [id]: { documents: r.documents, total: r.total ?? r.documents.length } }));
    } catch {
      if (!alive.current || seq.current[id] !== n) return;
      setDocs((d) => ({ ...d, [id]: 'error' }));
    }
  }, []);

  // Invalidate the cache when the page says something changed (D9): drop
  // everything collapsed or gone, and quietly refresh what is open.
  const expandedRef = useRef(expanded);
  useEffect(() => { expandedRef.current = expanded; });
  const seenVersion = useRef(version);
  useEffect(() => {
    if (seenVersion.current === version) return;
    seenVersion.current = version;
    const open = Object.keys(expandedRef.current).filter((id) => expandedRef.current[id] && folders.some((f) => f.id === id));
    setDocs((d) => Object.fromEntries(open.filter((id) => d[id] !== undefined).map((id) => [id, d[id]])));
    for (const id of open) void loadDocs(id);
  }, [version, folders, loadDocs]);

  const open = (id: string) => {
    setExpanded((e) => ({ ...e, [id]: true }));
    if (!isPage(docs[id])) void loadDocs(id);
  };
  const collapse = (id: string) => {
    setExpanded((e) => ({ ...e, [id]: false }));
    // A focused child row is about to be hidden: keep the tab stop on its folder.
    if (activeKey.startsWith('d:') || activeKey.startsWith('m:')) {
      const list = docs[id];
      const child = activeKey === `m:${id}` || (isPage(list) && list.documents.some((d) => `d:${d.id}` === activeKey));
      if (child) setActiveKey(`f:${id}`);
    }
  };
  const toggle = (id: string) => (expanded[id] ? collapse(id) : open(id));

  // Keys of every focusable row, in visible (top-to-bottom) order, and each child's parent.
  const order: string[] = ['root'];
  const parentOf: Record<string, string> = {};
  for (const f of folders) {
    order.push(`f:${f.id}`);
    if (expanded[f.id]) {
      const list = docs[f.id];
      if (isPage(list)) {
        for (const d of list.documents) { order.push(`d:${d.id}`); parentOf[`d:${d.id}`] = f.id; }
        if (list.total > list.documents.length) { order.push(`m:${f.id}`); parentOf[`m:${f.id}`] = f.id; }
      }
    }
  }
  // If the remembered row is gone (deleted folder, collapsed child), the tree
  // must still have one Tab stop (D9).
  const tabKey = order.includes(activeKey) ? activeKey : 'root';

  const focusKey = (key: string) => { setActiveKey(key); rows.current.get(key)?.focus(); };
  const register = (key: string) => (el: HTMLElement | null) => { if (el) rows.current.set(key, el); else rows.current.delete(key); };

  const onKey = (e: KeyboardEvent<HTMLElement>, key: string, folderId?: string) => {
    const i = order.indexOf(key);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusKey(order[Math.min(order.length - 1, i + 1)]!); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusKey(order[Math.max(0, i - 1)]!); }
    else if (e.key === 'Home') { e.preventDefault(); focusKey(order[0]!); }
    else if (e.key === 'End') { e.preventDefault(); focusKey(order[order.length - 1]!); }
    else if (folderId && e.key === 'ArrowRight') {
      e.preventDefault();
      if (!expanded[folderId]) open(folderId);
      else if (parentOf[order[i + 1] ?? ''] === folderId) focusKey(order[i + 1]!);
    } else if (folderId && e.key === 'ArrowLeft') {
      e.preventDefault();
      if (expanded[folderId]) collapse(folderId);
    } else if (!folderId && e.key === 'ArrowLeft' && parentOf[key]) {
      e.preventDefault();
      focusKey(`f:${parentOf[key]}`);
    } else if (folderId && (e.key === 'Enter' || e.key === ' ')) {
      // D2: keyboard selection, same as a click.
      e.preventDefault();
      onSelectFolder(folderId);
      if (!expanded[folderId]) open(folderId);
    } else if (key.startsWith('d:') && e.key === ' ') {
      // Links only activate on Enter natively; treeitems also take Space.
      e.preventDefault();
      (e.currentTarget as HTMLElement).click();
    }
  };

  const rowBase = 'group relative flex w-full items-center gap-1.5 rounded-lg py-3 pr-2 text-left text-sm outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-brand-500/50 lg:py-1.5';
  const rowTone = (on: boolean) => (on
    ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-100'
    : 'text-fg-muted hover:bg-slate-100 hover:text-fg active:bg-slate-200/70 dark:hover:bg-white/5 dark:active:bg-white/10');

  return (
    <div className={cx('select-none', className)} role="tree" aria-label="Folders and documents">
      {/* All documents */}
      <button
        ref={register('root')}
        type="button"
        role="treeitem"
        aria-selected={selectedFolderId === null}
        tabIndex={tabKey === 'root' ? 0 : -1}
        onFocus={() => setActiveKey('root')}
        onKeyDown={(e) => onKey(e, 'root')}
        onClick={() => onSelectFolder(null)}
        className={cx(rowBase, 'pl-2', rowTone(selectedFolderId === null))}
      >
        <Stack size={16} aria-hidden className="shrink-0 text-fg-subtle" />
        <span className="flex-1 truncate">All documents</span>
      </button>

      <ul role="group" className="mt-0.5 space-y-0.5">
        {folders.map((f) => {
          const isOpen = !!expanded[f.id];
          const selected = selectedFolderId === f.id;
          const list = docs[f.id];
          return (
            <li key={f.id} role="none">
              <div
                ref={register(`f:${f.id}`)}
                role="treeitem"
                aria-expanded={isOpen}
                aria-selected={selected}
                tabIndex={tabKey === `f:${f.id}` ? 0 : -1}
                onFocus={() => setActiveKey(`f:${f.id}`)}
                onKeyDown={(e) => onKey(e, `f:${f.id}`, f.id)}
                onClick={() => { onSelectFolder(f.id); if (!isOpen) open(f.id); }}
                className={cx(rowBase, 'cursor-pointer pl-0.5 lg:pl-1', rowTone(selected))}
              >
                {/* Pointer-only shortcut to expand without selecting; keyboard users have → / ←. */}
                <span
                  aria-hidden
                  title={isOpen ? `Collapse ${f.name}` : `Expand ${f.name}`}
                  onClick={(e) => { e.stopPropagation(); toggle(f.id); }}
                  className="-my-1.5 grid size-8 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors duration-150 hover:bg-slate-200/70 hover:text-fg active:bg-slate-300/60 lg:my-0 lg:size-5 dark:hover:bg-white/10 dark:active:bg-white/15"
                >
                  <CaretRight size={12} weight="bold" className={cx('transition-transform duration-200 ease-out', isOpen && 'rotate-90')} />
                </span>
                {isOpen ? <FolderOpen size={16} weight="fill" aria-hidden className="shrink-0 animate-fade-in text-amber-500" /> : <FolderSimple size={16} weight="fill" aria-hidden className="shrink-0 text-amber-500" />}
                <span className="flex-1 truncate">{f.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-fg-subtle">{f.documents}</span>
              </div>

              {/* Expand/collapse animates the row height (grid 0fr → 1fr); collapsed content is inert. */}
              <div
                className={cx('grid transition-[grid-template-rows] duration-200 ease-out', isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}
                inert={!isOpen || undefined}
              >
                <div className="min-h-0 overflow-hidden">
                  {list !== undefined && (
                    <ul role="group" className="ml-[1.4rem] mt-0.5 space-y-0.5 border-l border-line pl-1.5">
                      {list === 'loading' && <li role="none" className="flex items-center gap-2 px-2 py-1.5 text-xs text-fg-subtle"><Spinner className="size-3.5" />Loading…</li>}
                      {list === 'error' && (
                        <li role="none" className="flex animate-fade-in items-center gap-1.5 px-2 py-1.5 text-xs text-danger-600 dark:text-danger-300">
                          <WarningCircle size={14} aria-hidden className="shrink-0" />
                          Could not load
                          <button type="button" tabIndex={isOpen ? 0 : -1} onClick={() => void loadDocs(f.id)} className="relative ml-auto rounded px-1 font-semibold underline underline-offset-2 transition hover:no-underline active:opacity-70 pointer-coarse:before:absolute pointer-coarse:before:-inset-2.5">Retry</button>
                        </li>
                      )}
                      {isPage(list) && list.documents.length === 0 && <li role="none" className="animate-fade-in px-2 py-1.5 text-xs italic text-fg-subtle">Empty folder</li>}
                      {isPage(list) && list.documents.map((d) => {
                        const on = d.id === activeDocId;
                        return (
                          <li key={d.id} role="none" className="animate-fade-in">
                            <Link
                              ref={register(`d:${d.id}`)}
                              role="treeitem"
                              aria-selected={on}
                              aria-current={on ? 'page' : undefined}
                              tabIndex={tabKey === `d:${d.id}` ? 0 : -1}
                              onFocus={() => setActiveKey(`d:${d.id}`)}
                              onKeyDown={(e) => onKey(e, `d:${d.id}`)}
                              href={`/documents/${d.id}`}
                              className={cx(rowBase, 'pl-1.5', rowTone(on))}
                              title={d.title}
                            >
                              <FileIcon fileName={d.current?.fileName} size="sm" />
                              <span className="flex-1 truncate">{d.title}</span>
                            </Link>
                          </li>
                        );
                      })}
                      {isPage(list) && list.total > list.documents.length && (
                        <li role="none">
                          <button
                            ref={register(`m:${f.id}`)}
                            type="button"
                            role="treeitem"
                            aria-selected={false}
                            tabIndex={tabKey === `m:${f.id}` ? 0 : -1}
                            onFocus={() => setActiveKey(`m:${f.id}`)}
                            onKeyDown={(e) => onKey(e, `m:${f.id}`)}
                            onClick={() => onSelectFolder(f.id)}
                            className={cx(rowBase, 'pl-2 text-xs font-medium text-brand-700 hover:bg-brand-50 active:bg-brand-100 dark:text-brand-300 dark:hover:bg-brand-500/10 dark:active:bg-brand-500/20')}
                          >
                            <span className="flex-1 truncate">Show all {list.total} in the list</span>
                            <ArrowRight size={14} weight="bold" aria-hidden className="shrink-0" />
                          </button>
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {folders.length === 0 && (
        <p className="flex animate-fade-in items-start gap-2 px-2 py-3 text-xs leading-5 text-fg-subtle"><FolderSimplePlus size={16} aria-hidden className="mt-0.5 shrink-0" />No folders yet. Create one to group your documents.</p>
      )}
    </div>
  );
}
