'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, KeyReturn, MagnifyingGlass } from '@phosphor-icons/react';
import { api } from '@/lib/api';
import { FileIcon, Kbd, cx } from './ui';

export interface CommandLink { href: string; label: string; icon: ReactNode; hint?: string }
interface DocHit { id: string; title: string; category: string; current: { fileName: string } | null; owner: { displayName: string }; isOwner: boolean }

/** Ctrl/⌘+K: jump to any page, or find a document by name. Search only ever returns documents you can access. */
export function CommandPalette({ open, onClose, links }: { open: boolean; onClose: () => void; links: CommandLink[] }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [docs, setDocs] = useState<DocHit[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setDocs([]);
    setActive(0);
    input.current?.focus();
  }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (!open || term.length < 2) return setDocs([]);
    const t = setTimeout(() => {
      api.get<{ documents: DocHit[] }>(`/documents?scope=all&page=1&q=${encodeURIComponent(term)}`).then((r) => setDocs(r.documents.slice(0, 6))).catch(() => setDocs([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  const pages = useMemo(() => links.filter((l) => l.label.toLowerCase().includes(q.trim().toLowerCase())), [links, q]);
  const items = useMemo(
    () => [
      ...docs.map((d) => ({ key: `d-${d.id}`, href: `/documents/${d.id}`, node: <DocRow d={d} /> })),
      ...pages.map((l) => ({ key: `p-${l.href}`, href: l.href, node: <PageRow l={l} /> })),
    ],
    [docs, pages],
  );

  useEffect(() => setActive(0), [items.length]);

  if (!open) return null;

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  return (
    <div className="fixed inset-0 z-[55] flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="absolute inset-0 animate-fade-in bg-slate-950/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl animate-pop overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-lift dark:border-white/10 dark:bg-ink-900">
        <div className="flex items-center gap-3 border-b border-slate-100 px-4 dark:border-white/[0.06]">
          <MagnifyingGlass size={20} className="text-slate-400" />
          <input
            ref={input}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              else if (e.key === 'Enter' && items[active]) go(items[active].href);
            }}
            placeholder="Search documents or jump to a page…"
            className="h-14 flex-1 bg-transparent text-[0.9375rem] outline-none placeholder:text-slate-400"
            aria-label="Search"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {docs.length > 0 && <p className="px-3 pb-1 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-400">Documents</p>}
          {items.map((it, i) => (
            <div key={it.key}>
              {i === docs.length && pages.length > 0 && <p className="px-3 pb-1 pt-3 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-400">Go to</p>}
              <button
                onMouseEnter={() => setActive(i)}
                onClick={() => go(it.href)}
                className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition', i === active ? 'bg-brand-50 text-brand-900 dark:bg-brand-500/15 dark:text-white' : 'text-slate-700 dark:text-slate-300')}
              >
                {it.node}
                {i === active && <KeyReturn size={16} className="ml-auto text-brand-500" />}
              </button>
            </div>
          ))}
          {items.length === 0 && <p className="px-3 py-10 text-center text-sm text-slate-500">{q.trim().length < 2 ? 'Type to search.' : 'Nothing you can access matches.'}</p>}
        </div>
        <div className="flex items-center gap-4 border-t border-slate-100 px-4 py-2.5 text-[0.6875rem] text-slate-400 dark:border-white/[0.06]">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
          <span className="flex items-center gap-1"><Kbd>Enter</Kbd> open</span>
          <span className="ml-auto">Results only include documents you can access</span>
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
        <span className="block truncate text-xs text-slate-500">{d.category} · {d.isOwner ? 'You' : d.owner.displayName}</span>
      </span>
    </>
  );
}

function PageRow({ l }: { l: CommandLink }) {
  return (
    <>
      <span className="inline-flex size-8 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300">{l.icon}</span>
      <span className="font-medium">{l.label}</span>
      {l.hint && <span className="truncate text-xs text-slate-400">{l.hint}</span>}
      <ArrowRight size={14} className="text-slate-300" />
    </>
  );
}
