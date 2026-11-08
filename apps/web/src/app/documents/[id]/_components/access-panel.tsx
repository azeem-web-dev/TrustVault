'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowsLeftRight, DownloadSimple, Info, LockKey, MagnifyingGlass, PencilSimple, Prohibit, ShareNetwork, Sparkle, Trash, UserPlus, Siren, UsersFour, Crown, EyeSlash } from '@phosphor-icons/react';
import { useToast } from '@/components/toast';
import { ACCESS_LABEL, ACCESS_TONE, Alert, Avatar, Badge, Button, Card, IconButton, IconTile, Input, Label, LoadError, Modal, Select, SkeletonRows, Textarea, cx, staggerClass, useConfirm, useListNav } from '@/components/ui';
import { api, errorText, formatDate, type Level } from '@/lib/api';
import { isAbortError, useAction, useLatest } from '@/lib/hooks';
import { localDayEndISO, localTodayISO } from '@/lib/dates';
import { ConditionBadges, PolicyFields, type SharePolicy, type SharePolicyView } from '@/components/access-policy';
import { type Doc, LEVEL_WORD } from './types';

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
export interface DirUser { id: string; displayName: string; email: string; role: string; accessExpiresAt: string | null }
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

export function AccessPanel({ doc, onError }: { doc: Doc; onError: (m: string | null) => void }) {
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
