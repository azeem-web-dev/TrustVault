'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { FileText, LockKey, MagnifyingGlass, Plus, Trash, UserMinus, UserPlus, UsersFour, ArrowLeft, UsersThree } from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import { Alert, Avatar, AvatarStack, Badge, Button, EmptyState, IconButton, IconTile, Input, LoadError, PageTitle, Skeleton, Spinner, cx, staggerClass, ButtonLink } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { isAbortError, useAction, useDebounced, useLatest } from '@/lib/hooks';

interface Member { id: string; displayName: string; email: string; role: string; status: string }
interface Group { id: string; name: string; description: string | null; documentGrants: number; members: Member[] }
interface DirUser { id: string; displayName: string; email: string; role: string }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function GroupsPage() {
  const { user: me } = useSession();
  const toast = useToast();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const { busy, run: runAction } = useAction();

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ groups: Group[] }>('/admin/groups');
      setGroups(r.groups);
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
      setError(errorText(e));
    }
  }, []);
  const isAdmin = me?.role === 'ADMIN';
  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  const retry = async () => {
    setRetrying(true);
    setError(null);
    try { await load(); } finally { setRetrying(false); }
  };

  /** Runs one mutation at a time; resolves true when it succeeded. */
  const run = async (key: string, fn: () => Promise<unknown>, msg: string): Promise<boolean> => {
    setError(null);
    const ok = await runAction(key, async () => {
      try {
        await fn();
        toast(msg);
        await load();
        return true;
      } catch (err) {
        setError(errorText(err));
        return false;
      }
    });
    return ok === true;
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    if (await run('create', () => api.post('/admin/groups', { name: n }), `Group “${n}” created`)) setName('');
  };

  if (me && !isAdmin) {
    return (
      <Shell>
        <EmptyState art={<SpotArt tone="amber" icon={<LockKey size={30} />} />} title="Administrators only" action={<ButtonLink href="/" variant="soft" icon={<ArrowLeft size={16} weight="bold" />}>Back to documents</ButtonLink>}>
          Groups are managed by administrators.
        </EmptyState>
      </Shell>
    );
  }

  return (
    <Shell>
      <PageTitle
        title="Groups"
        icon={<UsersFour size={26} />}
        subtitle="Share a document with a team in one grant. Removing someone from a group removes their access through it on their next request. External people and administrators cannot join groups."
      />

      <form onSubmit={create} className="mb-6 flex flex-wrap gap-2 rounded-2xl border border-line bg-surface p-3 shadow-soft">
        <Input className="min-w-[13.75rem] flex-1" icon={<UsersFour size={18} />} aria-label="New group name" placeholder="New group name, e.g. Finance team" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        <Button type="submit" variant="primary" icon={<Plus size={16} weight="bold" />} loading={busy === 'create'} disabled={!!busy && busy !== 'create'}>Create group</Button>
      </form>

      {error && groups && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}

      {!groups ? (
        loadError ? (
          <div className="rounded-2xl border border-line bg-surface">
            <LoadError error={loadError} title="Couldn't load groups" onRetry={() => void retry()} retrying={retrying} />
          </div>
        ) : (
          <div role="status" aria-busy="true" className="grid gap-6 md:grid-cols-2">
            <span className="sr-only">Loading groups…</span>
            {[0, 1].map((i) => <Skeleton key={i} className="h-64 rounded-2xl" />)}
          </div>
        )
      ) : groups.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-strong">
          <EmptyState art={<SpotArt icon={<UsersFour size={30} />} />} title="No groups yet">Create one above, then share documents with the whole team at once.</EmptyState>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          {groups.map((g, i) => (
            <section key={g.id} className={cx('flex animate-rise flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-soft', staggerClass(i))}>
              <header className="relative overflow-hidden border-b border-line p-5">
                <div className="pointer-events-none absolute -right-10 -top-10 size-40 rounded-full bg-brand-500/10 blur-2xl" />
                <div className="relative flex items-start gap-3">
                  <IconTile tone="blue" size="lg"><UsersFour size={24} /></IconTile>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-base font-semibold">{g.name}</h2>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
                      <Badge icon={<UsersThree size={11} />}>{plural(g.members.length, 'member')}</Badge>
                      <Badge tone="blue" icon={<FileText size={11} />}>{plural(g.documentGrants, 'document grant')}</Badge>
                    </div>
                  </div>
                  {confirmDelete === g.id ? (
                    <div className="flex animate-fade-in gap-1.5">
                      <Button
                        size="sm"
                        variant="danger"
                        loading={busy === `delete:${g.id}`}
                        disabled={!!busy && busy !== `delete:${g.id}`}
                        onClick={() => void run(`delete:${g.id}`, () => api.delete(`/admin/groups/${g.id}`), `Deleted ${g.name}${g.documentGrants ? ` and its ${plural(g.documentGrants, 'grant')}` : ''}`).then(() => setConfirmDelete(null))}
                      >
                        Delete
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy === `delete:${g.id}`} onClick={() => setConfirmDelete(null)}>Keep</Button>
                    </div>
                  ) : (
                    <IconButton label={`Delete group ${g.name}`} disabled={!!busy} onClick={() => setConfirmDelete(g.id)} className="hover:bg-danger-50 hover:text-danger-600 dark:hover:bg-danger-500/10 dark:hover:text-danger-300"><Trash size={18} /></IconButton>
                  )}
                </div>
                {g.members.length > 0 && <div className="relative mt-4"><AvatarStack names={g.members.map((m) => m.displayName)} max={6} /></div>}
              </header>
              <ul className="flex-1 divide-y divide-line">
                {g.members.map((m, mi) => {
                  const inactive = m.status !== 'ACTIVE';
                  const key = `remove:${g.id}:${m.id}`;
                  return (
                    <li key={m.id} className={cx('flex animate-fade-in items-center gap-3 px-5 py-2.5 transition-[opacity,background-color] duration-200 hover:bg-fg/[0.02]', staggerClass(mi), busy === key && 'opacity-50')}>
                        <span className={cx('shrink-0', inactive && 'opacity-60')}><Avatar name={m.displayName} size="sm" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className={cx('block truncate text-sm font-medium', inactive && 'opacity-60')}>{m.displayName}</span>
                            {inactive && <Badge>{m.status === 'INVITED' ? 'Invited' : 'Deactivated'}</Badge>}
                          </span>
                          <span className={cx('block truncate text-xs text-fg-subtle', inactive && 'opacity-60')}>{m.email}</span>
                        </span>
                        <IconButton
                          label={`Remove ${m.email} from ${g.name}`}
                          disabled={!!busy}
                          aria-busy={busy === key || undefined}
                          onClick={() => void run(key, () => api.delete(`/admin/groups/${g.id}/members/${m.id}`), `Removed ${m.email} from ${g.name}`)}
                          className="hover:bg-danger-50 hover:text-danger-600 dark:hover:bg-danger-500/10 dark:hover:text-danger-300"
                        >
                          {busy === key ? <Spinner /> : <UserMinus size={16} />}
                        </IconButton>
                    </li>
                  );
                })}
                {g.members.length === 0 && <li className="flex animate-fade-in flex-col items-center gap-2 px-5 py-8 text-center text-sm text-fg-subtle"><IconTile tone="slate"><UserPlus size={20} /></IconTile>No members yet. Search below to add someone.</li>}
              </ul>
              <AddMember
                groupName={g.name}
                existing={g.members}
                busy={busy === `add:${g.id}`}
                disabled={!!busy}
                onAdd={(u) => run(`add:${g.id}`, () => api.post(`/admin/groups/${g.id}/members`, { userId: u.id }), `Added ${u.displayName} to ${g.name}`)}
              />
            </section>
          ))}
        </div>
      )}
    </Shell>
  );
}

function AddMember({ groupName, existing, busy, disabled, onAdd }: { groupName: string; existing: Member[]; busy: boolean; disabled: boolean; onAdd: (u: DirUser) => Promise<boolean> }) {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<DirUser[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const term = useDebounced(q.trim(), 250);
  const latest = useLatest();
  // A stable key, so a reload of the groups list doesn't search again.
  const existingKey = useMemo(() => existing.map((m) => m.id).sort().join(','), [existing]);

  useEffect(() => {
    if (term.length < 2) {
      latest.cancel();
      setUsers(null);
      setSearching(false);
      setSearchError(null);
      return;
    }
    const t = latest.begin();
    const have = new Set(existingKey.split(','));
    setSearching(true);
    setSearchError(null);
    api.get<{ users: DirUser[] }>(`/directory?q=${encodeURIComponent(term)}`, { signal: t.signal })
      // Only owners and viewers can join: the API refuses administrators and external people (G1).
      .then((r) => { if (t.isLatest()) setUsers(r.users.filter((u) => (u.role === 'OWNER' || u.role === 'VIEWER') && !have.has(u.id))); })
      .catch((e) => { if (t.isLatest() && !isAbortError(e)) { setUsers(null); setSearchError(errorText(e, 'Search failed')); } })
      .finally(() => { if (t.isLatest()) setSearching(false); });
  }, [term, existingKey, latest]);

  const add = async (u: DirUser) => {
    setAdding(u.id);
    try {
      // Keep the search on failure so the admin can try again.
      if (await onAdd(u)) { setQ(''); setUsers(null); }
    } finally {
      setAdding(null);
    }
  };

  const pending = q.trim().length >= 2 && (searching || term !== q.trim());
  return (
    <div className="border-t border-line bg-surface-2/50 p-4 dark:bg-white/[0.02]">
      <Input
        icon={pending ? <Spinner /> : <MagnifyingGlass size={18} />}
        type="search"
        aria-label={`Add a member to ${groupName}`}
        placeholder="Add a member: type a name or email"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div aria-live="polite">
        {searchError && q.trim().length >= 2 && <p className="mt-2 animate-fade-in text-xs text-danger-600 dark:text-danger-300">{searchError}</p>}
        {!pending && !searchError && users && users.length === 0 && (
          <p className="mt-2 animate-fade-in text-xs text-fg-subtle">No one matches who can join. Administrators and external people cannot be members.</p>
        )}
      </div>
      {users && users.length > 0 && q.trim().length >= 2 && (
        <ul className={cx('mt-2 animate-pop space-y-1 transition-opacity duration-150', pending && 'opacity-60')}>
          {users.map((u, ui) => (
            <li key={u.id} className={cx('flex animate-fade-in items-center gap-3 rounded-xl bg-surface p-2 shadow-sm ring-1 ring-line', staggerClass(ui))}>
              <Avatar name={u.displayName} size="sm" />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{u.displayName}</span><span className="block truncate text-xs text-fg-subtle">{u.email}</span></span>
              <Button size="sm" icon={<UserPlus size={14} />} loading={busy && adding === u.id} disabled={disabled && adding !== u.id} onClick={() => void add(u)}>Add</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
