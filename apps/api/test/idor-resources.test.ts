import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appDb, as, auditRows, createUser, login, PDF, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from './helpers.js';

// IDOR on the resources that are not documents (THREATS.md A27): folders,
// download requests, groups and their members, invitations. Documents and
// their versions are in documents.test.ts; sessions in devices.test.ts;
// two-admin approvals in approvals.test.ts; alerts and the audit log in
// admin-mfa.test.ts.

let t: TestApp;
let alice: TestUser, bob: TestUser, vic: TestUser, rita: TestUser, admin: TestUser;
let A: Session, B: Session, V: Session, R: Session, ADM: Session;

beforeAll(async () => { t = await startApp(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await resetState(t.app);
  alice = await createUser({ email: 'alice@idor.io', role: 'OWNER' });
  bob = await createUser({ email: 'bob@idor.io', role: 'OWNER' });
  vic = await createUser({ email: 'vic@idor.io', role: 'VIEWER' });
  rita = await createUser({ email: 'rita@idor.io', role: 'VIEWER' });
  admin = await createUser({ email: 'admin@idor.io', role: 'ADMIN' });
  [A, B, V, R, ADM] = await Promise.all([login(t, alice), login(t, bob), login(t, vic), login(t, rita), login(t, admin)]);
});

/** As the app's own database role, acting as `userId`: what row-level security lets it see and change. */
const asAppRole = <T>(userId: string, fn: (q: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }>) => Promise<T>) =>
  withDb(appDb(), async (db) => {
    await db.query('BEGIN');
    try {
      await db.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
      return await fn((sql, params = []) => db.query(sql, params));
    } finally {
      await db.query('ROLLBACK');
    }
  });

describe('folders', () => {
  it('another owner’s folder is not listed, cannot be renamed or deleted (404), and cannot be used for an upload or a move', async () => {
    const f = (await as(t, A).post('/api/folders', { name: 'HR private' }).expect(201)).body.id as string;
    expect((await as(t, B).get('/api/folders').expect(200)).body.folders).toEqual([]);
    await as(t, B).patch(`/api/folders/${f}`, { name: 'pwned' }).expect(404);
    await as(t, B).delete(`/api/folders/${f}`).expect(404);
    expect((await as(t, A).get('/api/folders').expect(200)).body.folders).toEqual([{ id: f, name: 'HR private', documents: 0 }]);

    const mine = (await as(t, B).upload('/api/documents', PDF, 'b.pdf', { title: 'Bob doc', category: 'Misc' }).expect(201)).body.id as string;
    expect((await as(t, B).patch(`/api/documents/${mine}`, { folderId: f })).status).toBe(400);
    expect((await as(t, B).upload('/api/documents', PDF, 'c.pdf', { title: 'Bob doc 2', category: 'Misc', folderId: f })).status).toBe(400);
    expect((await as(t, A).get('/api/folders').expect(200)).body.folders[0].documents).toBe(0);
  });

  it('the database alone: one owner can neither see nor change another owner’s folder', async () => {
    const f = (await as(t, A).post('/api/folders', { name: 'Board' }).expect(201)).body.id as string;
    await asAppRole(bob.id, async (q) => {
      expect((await q('SELECT id FROM folders WHERE id = $1', [f])).rowCount).toBe(0);
      expect((await q(`UPDATE folders SET name = 'pwned' WHERE id = $1`, [f])).rowCount).toBe(0);
      expect((await q('DELETE FROM folders WHERE id = $1', [f])).rowCount).toBe(0);
    });
    await asAppRole(alice.id, async (q) => {
      expect((await q('SELECT name FROM folders WHERE id = $1', [f])).rows).toEqual([{ name: 'Board' }]);
    });
  });
});

describe('download requests', () => {
  it('someone who is neither the requester, the owner nor the approver gets 404, even with a grant on the document; each try is recorded and the request stays pending', async () => {
    const doc = (await as(t, A).upload('/api/documents', PDF, 'pay.pdf', { title: 'Payroll', category: 'HR' }).expect(201)).body.id as string;
    await as(t, A).put(`/api/documents/${doc}/access`, { userId: vic.id, level: 'READ', policy: { downloadApproval: true } }).expect(200);
    await as(t, A).put(`/api/documents/${doc}/access`, { userId: rita.id, level: 'READ' }).expect(200);
    const req = (await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'Needed for the year-end audit' }).expect(201)).body.id as string;

    for (const s of [B, R]) {
      await as(t, s).post(`/api/download-requests/${req}/approve`, { hours: 24, uses: 1 }).expect(404);
      await as(t, s).post(`/api/download-requests/${req}/reject`, {}).expect(404);
      expect((await as(t, s).get('/api/download-requests').expect(200)).body.requests).toEqual([]);
    }
    const refused = await auditRows(`action LIKE 'download_approval.%' AND outcome = 'DENIED' AND target_id = $1`, [req]);
    expect(refused).toHaveLength(4);
    expect(new Set(refused.map((r) => r.actor_id))).toEqual(new Set([bob.id, rita.id]));
    expect((await as(t, A).get('/api/download-requests').expect(200)).body.requests.map((r: { id: string }) => r.id)).toEqual([req]);
  });

  it('the database alone: the request row is invisible to an outsider and to a reader of the same document', async () => {
    const doc = (await as(t, A).upload('/api/documents', PDF, 'pay.pdf', { title: 'Payroll', category: 'HR' }).expect(201)).body.id as string;
    await as(t, A).put(`/api/documents/${doc}/access`, { userId: vic.id, level: 'READ', policy: { downloadApproval: true } }).expect(200);
    await as(t, A).put(`/api/documents/${doc}/access`, { userId: rita.id, level: 'READ' }).expect(200);
    const req = (await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'Needed for the year-end audit' }).expect(201)).body.id as string;
    for (const who of [bob.id, rita.id]) {
      await asAppRole(who, async (q) => expect((await q('SELECT id FROM download_approvals WHERE id = $1', [req])).rowCount).toBe(0));
    }
    await asAppRole(alice.id, async (q) => expect((await q('SELECT id FROM download_approvals WHERE id = $1', [req])).rowCount).toBe(1));
  });
});

describe('groups, members and invitations are administrator-only', () => {
  it('owners and viewers get 403 on every group and invitation route, and nothing changes', async () => {
    const g = (await as(t, ADM).post('/api/admin/groups', { name: 'Payroll team' }).expect(201)).body;
    const groupId = (g.id ?? g.group?.id) as string;
    await as(t, ADM).post(`/api/admin/groups/${groupId}/members`, { userId: vic.id }).expect((r) => expect(r.status).toBeLessThan(300));
    for (const s of [A, V]) {
      await as(t, s).get('/api/admin/groups').expect(403);
      await as(t, s).post('/api/admin/groups', { name: 'Mine' }).expect(403);
      await as(t, s).patch(`/api/admin/groups/${groupId}`, { name: 'Renamed' }).expect(403);
      await as(t, s).delete(`/api/admin/groups/${groupId}`).expect(403);
      await as(t, s).post(`/api/admin/groups/${groupId}/members`, { userId: rita.id }).expect(403);
      await as(t, s).delete(`/api/admin/groups/${groupId}/members/${vic.id}`).expect(403);
      await as(t, s).post('/api/admin/users', { email: 'new@idor.io', role: 'VIEWER' }).expect(403);
      await as(t, s).post(`/api/admin/users/${rita.id}/invite`).expect(403);
    }
    const groups = (await as(t, ADM).get('/api/admin/groups').expect(200)).body.groups as { name: string; members: { id?: string; userId?: string }[] }[];
    expect(groups.map((x) => x.name)).toEqual(['Payroll team']);
    expect(groups[0]!.members.map((m) => m.id ?? m.userId)).toEqual([vic.id]);
  });
});
