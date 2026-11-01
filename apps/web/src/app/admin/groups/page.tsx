'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Shell } from '@/components/shell';
import { Alert, Badge, Button, Card, Empty, Input, PageTitle } from '@/components/ui';
import { api, errorText } from '@/lib/api';

interface Member { id: string; displayName: string; email: string; role: string; status: string }
interface Group { id: string; name: string; description: string | null; documentGrants: number; members: Member[] }
interface DirUser { id: string; displayName: string; email: string; role: string }

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => api.get<{ groups: Group[] }>('/admin/groups').then((r) => setGroups(r.groups)).catch((e) => setError(errorText(e))), []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(msg);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => { await api.post('/admin/groups', { name }); setName(''); }, 'Group created');
  };

  return (
    <Shell>
      <PageTitle title="Groups" subtitle="Share a document with a team in one grant. Removing someone from a group removes their access through it on their next request. External people cannot join groups." />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {notice && <div className="mb-4"><Alert tone="green">{notice}</Alert></div>}
      <form onSubmit={create} className="mb-6 flex gap-2">
        <Input className="max-w-xs" placeholder="New group name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        <Button type="submit" variant="primary">Create group</Button>
      </form>
      <div className="grid gap-6 md:grid-cols-2">
        {groups.map((g) => (
          <Card key={g.id} title={g.name} actions={<><Badge>{g.documentGrants} document grants</Badge><Button variant="danger" onClick={() => void run(() => api.delete(`/admin/groups/${g.id}`), `Deleted ${g.name} and its ${g.documentGrants} grants`)}>Delete</Button></>}>
            <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {g.members.map((m) => (
                <li key={m.id} className="flex items-center justify-between py-2">
                  <span>{m.displayName} <span className="text-slate-500">{m.email}</span></span>
                  <Button variant="ghost" onClick={() => void run(() => api.delete(`/admin/groups/${g.id}/members/${m.id}`), `Removed ${m.email} from ${g.name}`)}>Remove</Button>
                </li>
              ))}
            </ul>
            {g.members.length === 0 && <Empty>No members yet.</Empty>}
            <AddMember onAdd={(userId) => run(() => api.post(`/admin/groups/${g.id}/members`, { userId }), `Added to ${g.name}`)} />
          </Card>
        ))}
      </div>
    </Shell>
  );
}

function AddMember({ onAdd }: { onAdd: (userId: string) => void }) {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<DirUser[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return setUsers([]);
    const t = setTimeout(() => api.get<{ users: DirUser[] }>(`/directory?q=${encodeURIComponent(q.trim())}`).then((r) => setUsers(r.users.filter((u) => u.role !== 'EXTERNAL'))).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
      <Input placeholder="Add a member: type a name or email" value={q} onChange={(e) => setQ(e.target.value)} />
      {users.map((u) => (
        <div key={u.id} className="mt-2 flex items-center justify-between text-sm">
          <span>{u.displayName} <span className="text-slate-500">{u.email}</span></span>
          <Button onClick={() => { onAdd(u.id); setQ(''); }}>Add</Button>
        </div>
      ))}
    </div>
  );
}
