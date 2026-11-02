'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { FileText, MagnifyingGlass, Plus, Trash, UserMinus, UserPlus, UsersFour } from '@phosphor-icons/react';
import { Shell } from '@/components/shell';
import { useToast } from '@/components/toast';
import { SpotArt } from '@/components/art';
import { Alert, Avatar, AvatarStack, Badge, Button, EmptyState, IconButton, IconTile, Input, PageTitle, Skeleton } from '@/components/ui';
import { api, errorText } from '@/lib/api';

interface Member { id: string; displayName: string; email: string; role: string; status: string }
interface Group { id: string; name: string; description: string | null; documentGrants: number; members: Member[] }
interface DirUser { id: string; displayName: string; email: string; role: string }

export default function GroupsPage() {
  const toast = useToast();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(() => api.get<{ groups: Group[] }>('/admin/groups').then((r) => setGroups(r.groups)).catch((e) => setError(errorText(e))), []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setError(null);
    try {
      await fn();
      toast(msg);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => { await api.post('/admin/groups', { name }); setName(''); }, `Group “${name}” created`);
  };

  return (
    <Shell>
      <PageTitle
        title="Groups"
        icon={<UsersFour size={26} />}
        subtitle="Share a document with a team in one grant. Removing someone from a group removes their access through it on their next request. External people cannot join groups."
      />

      <form onSubmit={create} className="mb-6 flex flex-wrap gap-2 rounded-2xl border border-slate-200/80 bg-white p-3 shadow-soft dark:border-white/[0.08] dark:bg-white/[0.03]">
        <Input className="min-w-[220px] flex-1" icon={<UsersFour size={18} />} placeholder="New group name, e.g. Finance team" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        <Button type="submit" variant="primary" icon={<Plus size={16} weight="bold" />}>Create group</Button>
      </form>

      {error && <div className="mb-4"><Alert onDismiss={() => setError(null)}>{error}</Alert></div>}

      {!groups ? (
        <div className="grid gap-6 md:grid-cols-2">{[0, 1].map((i) => <Skeleton key={i} className="h-64 rounded-2xl" />)}</div>
      ) : groups.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 dark:border-white/10">
          <EmptyState art={<SpotArt icon={<UsersFour size={30} />} />} title="No groups yet">Create one above, then share documents with the whole team at once.</EmptyState>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          {groups.map((g, i) => (
            <section key={g.id} style={{ animationDelay: `${i * 50}ms` }} className="flex animate-rise flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-soft dark:border-white/[0.08] dark:bg-white/[0.03]">
              <header className="relative overflow-hidden border-b border-slate-100 p-5 dark:border-white/[0.06]">
                <div className="pointer-events-none absolute -right-10 -top-10 size-40 rounded-full bg-brand-500/10 blur-2xl" />
                <div className="relative flex items-start gap-3">
                  <IconTile tone="blue" size="lg"><UsersFour size={24} /></IconTile>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-base font-semibold">{g.name}</h2>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <Badge>{g.members.length} member{g.members.length === 1 ? '' : 's'}</Badge>
                      <Badge tone="blue" icon={<FileText size={11} />}>{g.documentGrants} document grant{g.documentGrants === 1 ? '' : 's'}</Badge>
                    </div>
                  </div>
                  {confirmDelete === g.id ? (
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="danger" onClick={() => { setConfirmDelete(null); void run(() => api.delete(`/admin/groups/${g.id}`), `Deleted ${g.name} and its ${g.documentGrants} grants`); }}>Delete</Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>Keep</Button>
                    </div>
                  ) : (
                    <IconButton label={`Delete group ${g.name}`} onClick={() => setConfirmDelete(g.id)} className="hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"><Trash size={18} /></IconButton>
                  )}
                </div>
                {g.members.length > 0 && <div className="relative mt-4"><AvatarStack names={g.members.map((m) => m.displayName)} max={6} /></div>}
              </header>
              <ul className="flex-1 divide-y divide-slate-100 dark:divide-white/[0.05]">
                {g.members.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-5 py-2.5">
                    <Avatar name={m.displayName} size="sm" />
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{m.displayName}</span><span className="block truncate text-xs text-slate-500">{m.email}</span></span>
                    <IconButton label={`Remove ${m.email} from ${g.name}`} onClick={() => void run(() => api.delete(`/admin/groups/${g.id}/members/${m.id}`), `Removed ${m.email} from ${g.name}`)} className="size-8 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"><UserMinus size={16} /></IconButton>
                  </li>
                ))}
                {g.members.length === 0 && <li className="px-5 py-6 text-center text-sm text-slate-500">No members yet.</li>}
              </ul>
              <AddMember existing={g.members.map((m) => m.id)} onAdd={(u) => run(() => api.post(`/admin/groups/${g.id}/members`, { userId: u.id }), `Added ${u.displayName} to ${g.name}`)} />
            </section>
          ))}
        </div>
      )}
    </Shell>
  );
}

function AddMember({ existing, onAdd }: { existing: string[]; onAdd: (u: DirUser) => void }) {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<DirUser[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return setUsers([]);
    const t = setTimeout(() => api.get<{ users: DirUser[] }>(`/directory?q=${encodeURIComponent(q.trim())}`).then((r) => setUsers(r.users.filter((u) => u.role !== 'EXTERNAL' && !existing.includes(u.id)))).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [q, existing]);
  return (
    <div className="border-t border-slate-100 bg-slate-50/50 p-4 dark:border-white/[0.06] dark:bg-white/[0.02]">
      <Input icon={<MagnifyingGlass size={18} />} placeholder="Add a member: type a name or email" value={q} onChange={(e) => setQ(e.target.value)} />
      {users.length > 0 && (
        <ul className="mt-2 animate-pop space-y-1">
          {users.map((u) => (
            <li key={u.id} className="flex items-center gap-3 rounded-xl bg-white p-2 shadow-sm dark:bg-white/5">
              <Avatar name={u.displayName} size="sm" />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{u.displayName}</span><span className="block truncate text-xs text-slate-500">{u.email}</span></span>
              <Button size="sm" icon={<UserPlus size={14} />} onClick={() => { onAdd(u); setQ(''); }}>Add</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
