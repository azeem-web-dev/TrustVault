import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createUser, login, ownerDb, PDF, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from '../helpers.js';

// ACCESS-CONTROL BYPASS hunt probes. Each test is an attack that MUST fail.
let t: TestApp;
let alice: TestUser, bob: TestUser, mgr: TestUser, admin: TestUser;
let A: Session, B: Session, M: Session, ADM: Session;

const share = (s: Session, doc: string, userId: string, level: string, policy?: object) =>
  as(t, s).put(`/api/documents/${doc}/access`, { userId, level, ...(policy ? { policy } : {}) });

async function newDoc(owner: Session, body = Buffer.from('secret v1\n'), name = 'v1.txt'): Promise<string> {
  const r = await as(t, owner).upload('/api/documents', body, name, { title: 'Doc', category: 'Finance' });
  expect(r.status).toBe(201);
  return r.body.id;
}

beforeAll(async () => { t = await startApp({ MAIL_TRANSPORT: 'memory' }); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await resetState(t.app);
  alice = await createUser({ email: 'alice@h.io', role: 'OWNER' });
  bob = await createUser({ email: 'bob@h.io', role: 'OWNER' });
  mgr = await createUser({ email: 'mgr@h.io', role: 'OWNER' });
  admin = await createUser({ email: 'admin@h.io', role: 'ADMIN' });
  A = await login(t, alice); B = await login(t, bob); M = await login(t, mgr); ADM = await login(t, admin);
});

describe('download approval bypass attempts', () => {
  it('an approval for version 1 cannot download version 2', async () => {
    const doc = await newDoc(A);
    await share(A, doc, bob.id, 'READ', { downloadApproval: true }).expect(200);
    // Bob asks for v1, Alice approves.
    const req = await as(t, B).post(`/api/documents/${doc}/download-requests`, { reason: 'please let me read v1' });
    expect(req.status).toBe(201);
    const inbox = await as(t, A).get('/api/download-requests').expect(200);
    const rid = inbox.body.requests[0].id;
    await as(t, A).post(`/api/download-requests/${rid}/approve`, { hours: 24, uses: 5 }).expect(200);
    // Alice uploads v2 -> current is now v2 (uploaded by Alice, not Bob).
    await as(t, A).upload(`/api/documents/${doc}/versions`, Buffer.from('secret v2\n'), 'v2.txt').expect(201);
    // Bob downloads current (v2): approval was for v1 only -> must be refused.
    const dl = await as(t, B).get(`/api/documents/${doc}/download`);
    expect(dl.status).toBe(403);
    // v1 (his approval) still works.
    await as(t, B).get(`/api/documents/${doc}/versions/1/download`).expect(200);
  });

  it('a requester cannot approve their own download request', async () => {
    const doc = await newDoc(A);
    await share(A, doc, bob.id, 'READ', { downloadApproval: true }).expect(200);
    const req = await as(t, B).post(`/api/documents/${doc}/download-requests`, { reason: 'please approve me self' });
    const rid = req.body.id;
    const self = await as(t, B).post(`/api/download-requests/${rid}/approve`, {});
    expect(self.status).toBe(403);
    const dl = await as(t, B).get(`/api/documents/${doc}/download`);
    expect(dl.status).toBe(403);
  });

  it('an approval is single-use when uses=1', async () => {
    const doc = await newDoc(A);
    await share(A, doc, bob.id, 'READ', { downloadApproval: true }).expect(200);
    const req = await as(t, B).post(`/api/documents/${doc}/download-requests`, { reason: 'one download only here' });
    const inbox = await as(t, A).get('/api/download-requests').expect(200);
    await as(t, A).post(`/api/download-requests/${inbox.body.requests[0].id}/approve`, { uses: 1 }).expect(200);
    await as(t, B).get(`/api/documents/${doc}/download`).expect(200);
    const second = await as(t, B).get(`/api/documents/${doc}/download`);
    expect(second.status).toBe(403);
  });
});

describe('level confusion', () => {
  it('VIEW holder cannot download, get offline key, or request download', async () => {
    const doc = await newDoc(A);
    await share(A, doc, bob.id, 'VIEW').expect(200);
    expect((await as(t, B).get(`/api/documents/${doc}/download`)).status).toBe(404);
    expect((await as(t, B).post(`/api/documents/${doc}/offline-key`)).status).toBe(404);
    // A VIEW holder may now ASK for download permission (THREATS.md V1), but the
    // request alone releases nothing: without the owner's approval the bytes and
    // the Android key are still refused.
    expect((await as(t, B).post(`/api/documents/${doc}/download-requests`, { reason: 'view wants a download copy' })).status).toBe(201);
    expect((await as(t, B).get(`/api/documents/${doc}/download`)).status).toBe(404);
    expect((await as(t, B).post(`/api/documents/${doc}/offline-key`)).status).toBe(404);
    // But pages are allowed.
    expect((await as(t, B).get(`/api/documents/${doc}/pages`)).status).toBe(200);
  });

  it('READ holder cannot manage, share, view access list or history', async () => {
    const doc = await newDoc(A);
    await share(A, doc, bob.id, 'READ').expect(200);
    expect((await as(t, B).get(`/api/documents/${doc}/access`)).status).toBe(404);
    expect((await as(t, B).get(`/api/documents/${doc}/history`)).status).toBe(404);
    expect((await share(B, doc, mgr.id, 'VIEW')).status).toBe(404);
  });

  it('EDIT holder cannot share', async () => {
    const doc = await newDoc(A);
    await share(A, doc, bob.id, 'EDIT').expect(200);
    expect((await share(B, doc, mgr.id, 'VIEW')).status).toBe(404);
  });

  it('MANAGE holder cannot grant MANAGE or override (owner-only)', async () => {
    const doc = await newDoc(A);
    await share(A, doc, mgr.id, 'MANAGE').expect(200);
    // MANAGE can share lower levels but not MANAGE.
    expect((await share(M, doc, bob.id, 'MANAGE')).status).toBe(403);
    // Override is owner-only.
    expect((await as(t, M).post(`/api/documents/${doc}/overrides`, { userId: bob.id, reason: 'mgr tries override' })).status).toBe(404);
  });
});

describe('second lock (direct SQL as the app role)', () => {
  const appUrl = () => process.env.TEST_DATABASE_URL!;

  it('an EDIT holder cannot seize ownership or untrash via direct UPDATE', async () => {
    const doc = await newDoc(A);
    await share(A, doc, bob.id, 'EDIT').expect(200);
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: appUrl(), options: '-c TimeZone=UTC' });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [bob.id]);
      // Try to make Bob the owner.
      let seized = false;
      try {
        const r = await c.query('UPDATE documents SET owner_id = $1 WHERE id = $2', [bob.id, doc]);
        seized = r.rowCount! > 0;
      } catch { seized = false; }
      expect(seized).toBe(false);
      await c.query('ROLLBACK');
      // Confirm ownership unchanged.
      const owner = await withDb(ownerDb(), async (db) => (await db.query('SELECT owner_id FROM documents WHERE id=$1', [doc])).rows[0].owner_id);
      expect(owner).toBe(alice.id);
    } finally { await c.end(); }
  });

  it('a VIEW holder sees no blob row directly', async () => {
    const doc = await newDoc(A, PDF, 'v1.pdf');
    await share(A, doc, bob.id, 'VIEW').expect(200);
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: appUrl(), options: '-c TimeZone=UTC' });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [bob.id]);
      const r = await c.query(`SELECT b.* FROM document_blobs b JOIN document_versions v ON v.id=b.version_id WHERE v.document_id=$1`, [doc]);
      expect(r.rowCount).toBe(0);
      await c.query('ROLLBACK');
    } finally { await c.end(); }
  });
});
