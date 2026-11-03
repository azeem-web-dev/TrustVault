'use client';

// A VS Code-style explorer for an owner's folders and the documents inside
// them. It reads only data that already exists: GET /folders (passed in) and
// GET /documents?scope=mine&folderId=<id> for a folder's contents, loaded
// lazily the first time a folder is opened. Keyboard-navigable as an ARIA
// tree: ↑/↓ move, →/← expand/collapse, Enter opens.

import Link from 'next/link';
import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { CaretRight, FolderOpen, FolderSimple, Stack } from '@phosphor-icons/react';
import { api } from '@/lib/api';
import { FileIcon, cx } from './ui';

export interface TreeFolder { id: string; name: string; documents: number }
interface DocLite { id: string; title: string; current: { fileName: string } | null }
type DocState = DocLite[] | 'loading' | 'error' | undefined;

export function FolderTree({
  folders, selectedFolderId, onSelectFolder, activeDocId, className,
}: {
  folders: TreeFolder[];
  selectedFolderId: string | null;
  onSelectFolder: (id: string | null) => void;
  activeDocId?: string;
  className?: string;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [docs, setDocs] = useState<Record<string, DocState>>({});
  const [activeKey, setActiveKey] = useState<string>('root');
  const rows = useRef<Map<string, HTMLElement>>(new Map());

  const loadDocs = useCallback(async (id: string) => {
    setDocs((d) => (d[id] && d[id] !== 'error' ? d : { ...d, [id]: 'loading' }));
    try {
      const r = await api.get<{ documents: DocLite[] }>(`/documents?scope=mine&folderId=${id}&page=1`);
      setDocs((d) => ({ ...d, [id]: r.documents }));
    } catch {
      setDocs((d) => ({ ...d, [id]: 'error' }));
    }
  }, []);

  const open = (id: string) => {
    setExpanded((e) => ({ ...e, [id]: true }));
    if (!Array.isArray(docs[id])) void loadDocs(id);
  };
  const toggle = (id: string) => {
    const willOpen = !expanded[id];
    setExpanded((e) => ({ ...e, [id]: willOpen }));
    if (willOpen && !Array.isArray(docs[id])) void loadDocs(id);
  };

  // Keys of every focusable row, in visible (top-to-bottom) order.
  const order: string[] = ['root'];
  for (const f of folders) {
    order.push(`f:${f.id}`);
    if (expanded[f.id]) {
      const list = docs[f.id];
      if (Array.isArray(list)) for (const d of list) order.push(`d:${d.id}`);
    }
  }

  const focusKey = (key: string) => { setActiveKey(key); rows.current.get(key)?.focus(); };
  const register = (key: string) => (el: HTMLElement | null) => { if (el) rows.current.set(key, el); else rows.current.delete(key); };

  const onKey = (e: KeyboardEvent, key: string, folderId?: string) => {
    const i = order.indexOf(key);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusKey(order[Math.min(order.length - 1, i + 1)]!); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusKey(order[Math.max(0, i - 1)]!); }
    else if (e.key === 'Home') { e.preventDefault(); focusKey(order[0]!); }
    else if (e.key === 'End') { e.preventDefault(); focusKey(order[order.length - 1]!); }
    else if (folderId && e.key === 'ArrowRight') {
      e.preventDefault();
      if (!expanded[folderId]) open(folderId);
      else focusKey(order[Math.min(order.length - 1, i + 1)]!);
    } else if (folderId && e.key === 'ArrowLeft') {
      e.preventDefault();
      if (expanded[folderId]) setExpanded((ex) => ({ ...ex, [folderId]: false }));
    }
  };

  const rowBase = 'group flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-brand-500/50';

  return (
    <div className={cx('select-none', className)} role="tree" aria-label="Folders and documents">
      {/* All documents */}
      <button
        ref={register('root')}
        type="button"
        role="treeitem"
        aria-selected={selectedFolderId === null}
        tabIndex={activeKey === 'root' ? 0 : -1}
        onFocus={() => setActiveKey('root')}
        onKeyDown={(e) => onKey(e, 'root')}
        onClick={() => onSelectFolder(null)}
        className={cx(rowBase, 'pl-2', selectedFolderId === null ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-100' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/5')}
      >
        <Stack size={16} className="shrink-0 text-slate-400" />
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
                tabIndex={activeKey === `f:${f.id}` ? 0 : -1}
                onFocus={() => setActiveKey(`f:${f.id}`)}
                onKeyDown={(e) => onKey(e, `f:${f.id}`, f.id)}
                onClick={() => { onSelectFolder(f.id); if (!isOpen) open(f.id); }}
                className={cx(rowBase, 'cursor-pointer pl-1', selected ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-100' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/5')}
              >
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={isOpen ? `Collapse ${f.name}` : `Expand ${f.name}`}
                  onClick={(e) => { e.stopPropagation(); toggle(f.id); }}
                  className="grid size-5 shrink-0 place-items-center rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  <CaretRight size={13} weight="bold" className={cx('transition', isOpen && 'rotate-90')} />
                </span>
                {isOpen ? <FolderOpen size={16} weight="fill" className="shrink-0 text-amber-500" /> : <FolderSimple size={16} weight="fill" className="shrink-0 text-amber-500" />}
                <span className="flex-1 truncate">{f.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-slate-400">{f.documents}</span>
              </div>

              {isOpen && (
                <ul role="group" className="ml-[1.4rem] space-y-0.5 border-l border-slate-200 pl-1.5 dark:border-white/10">
                  {list === 'loading' && <li role="none" className="px-2 py-1.5 text-xs text-slate-400">Loading…</li>}
                  {list === 'error' && <li role="none" className="px-2 py-1.5 text-xs text-red-500">Could not load</li>}
                  {Array.isArray(list) && list.length === 0 && <li role="none" className="px-2 py-1.5 text-xs italic text-slate-400">Empty folder</li>}
                  {Array.isArray(list) && list.map((d) => {
                    const on = d.id === activeDocId;
                    return (
                      <li key={d.id} role="none">
                        <Link
                          ref={register(`d:${d.id}`)}
                          role="treeitem"
                          aria-selected={on}
                          tabIndex={activeKey === `d:${d.id}` ? 0 : -1}
                          onFocus={() => setActiveKey(`d:${d.id}`)}
                          onKeyDown={(e) => onKey(e, `d:${d.id}`)}
                          href={`/documents/${d.id}`}
                          className={cx(rowBase, 'pl-1.5', on ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-100' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/5')}
                          title={d.title}
                        >
                          <FileIcon fileName={d.current?.fileName} size="sm" />
                          <span className="flex-1 truncate">{d.title}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {folders.length === 0 && (
        <p className="px-2 py-3 text-xs text-slate-400">No folders yet. Create one to group your documents.</p>
      )}
    </div>
  );
}
