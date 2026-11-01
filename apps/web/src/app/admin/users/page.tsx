'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';
import { api, ApiError, type Role } from '@/lib/api';

interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: 'ACTIVE' | 'DEACTIVATED';
  accessExpiresAt: string | null;
  lockedUntil: string | null;
  createdAt: string;
}

const ROLES: Role[] = ['ADMIN', 'OWNER', 'VIEWER', 'EXTERNAL'];
const input = 'w-full rounded-md border border-slate-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-brand-600 dark:border-slate-700';

export default function AdminUsersPage() {
  const { user: me } = useSession();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ users: AdminUser[] }>('/admin/users');
      setUsers(r.users);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load users');
    }
  }, []);

  useEffect(() => {
    if (me?.role === 'ADMIN') void load();
  }, [me, load]);

  async function run(action: () => Promise<unknown>, success: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Request failed');
    }
  }

  return (
    <Shell>
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-slate-500">Role changes, deactivation and password resets sign the user out everywhere immediately.</p>
      </div>
      {error && <p role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {notice && <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">{notice}</p>}

      <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Access expires</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                <td className="px-4 py-3">
                  <div className="font-medium">{u.displayName}</div>
                  <div className="text-xs text-slate-500">{u.email}</div>
                </td>
                <td className="px-4 py-3">
                  <select
                    aria-label={`Role for ${u.email}`}
                    value={u.role}
                    disabled={u.id === me?.id}
                    onChange={(e) => void run(() => api.patch(`/admin/users/${u.id}`, { role: e.target.value }), `Role changed for ${u.email}`)}
                    className="rounded-md border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700"
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${u.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}>
                    {u.status === 'ACTIVE' ? 'Active' : 'Deactivated'}
                  </span>
                  {u.lockedUntil && new Date(u.lockedUntil) > new Date() && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Locked</span>}
                </td>
                <td className="px-4 py-3 text-slate-500">{u.accessExpiresAt ? new Date(u.accessExpiresAt).toLocaleDateString() : '—'}</td>
                <td className="px-4 py-3 text-right">
                  {u.id !== me?.id && (u.status === 'ACTIVE' ? (
                    <button onClick={() => void run(() => api.post(`/admin/users/${u.id}/deactivate`), `${u.email} deactivated and signed out`)} className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950">Deactivate</button>
                  ) : (
                    <button onClick={() => void run(() => api.post(`/admin/users/${u.id}/reactivate`), `${u.email} reactivated`)} className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">Reactivate</button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CreateUser onCreated={(email) => run(async () => undefined, `Created ${email}`)} onError={setError} />
    </Shell>
  );
}

function CreateUser({ onCreated, onError }: { onCreated: (email: string) => Promise<void>; onError: (m: string) => void }) {
  const [form, setForm] = useState({ email: '', displayName: '', role: 'VIEWER' as Role, password: '', accessExpiresAt: '' });

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post('/admin/users', {
        email: form.email,
        displayName: form.displayName,
        role: form.role,
        password: form.password,
        ...(form.accessExpiresAt ? { accessExpiresAt: new Date(form.accessExpiresAt).toISOString() } : {}),
      });
      const email = form.email;
      setForm({ email: '', displayName: '', role: 'VIEWER', password: '', accessExpiresAt: '' });
      await onCreated(email);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not create user');
    }
  }

  return (
    <form onSubmit={submit} className="mt-8 grid gap-3 rounded-xl border border-slate-200 bg-white p-6 sm:grid-cols-2 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-lg font-semibold sm:col-span-2">Add a user</h2>
      <input className={input} placeholder="Email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <input className={input} placeholder="Display name" required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
      <select className={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      <input className={input} placeholder="Initial password (12+ characters)" type="password" autoComplete="new-password" required minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      {form.role === 'EXTERNAL' && (
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-slate-500">External access ends on (required)</span>
          <input className={input} type="date" required value={form.accessExpiresAt} onChange={(e) => setForm({ ...form, accessExpiresAt: e.target.value })} />
        </label>
      )}
      <button type="submit" className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 sm:col-span-2 sm:justify-self-start">Create user</button>
    </form>
  );
}
