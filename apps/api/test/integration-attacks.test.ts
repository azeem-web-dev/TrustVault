import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { appDb, approved, as, auditRows, createUser, login, ownerDb, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from './helpers.js';

// Attacks across the features merged on 2026-11-03: View only (V), access
// policies and download approvals (P), key tickets (K), insider limits (U9),
// two-admin break-glass (S19). Each one tries to use one feature to get
// around another: the three promises must still hold together (reachable
// only if granted, a provable record, immediate revocation).

let t: TestApp;
let owner: TestUser, viewer: TestUser, other: TestUser, admin: TestUser, admin2: TestUser;
let A: Session, V: Session, O: Session, ADM: Session, ADM2: Session;

beforeAll(async () => { t = await startApp(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await resetState(t.app);
  owner = await createUser({ email: 'atk-owner@t.io', role: 'OWNER' });
  viewer = await createUser({ email: 'atk-viewer@t.io', role: 'VIEWER' });
  other = await createUser({ email: 'atk-other@t.io', role: 'VIEWER' });
  admin = await createUser({ email: 'atk-admin@t.io', role: 'ADMIN' });
  admin2 = await createUser({ email: 'atk-admin2@t.io', role: 'ADMIN' });
  [A, V, O, ADM, ADM2] = [await login(t, owner), await login(t, viewer), await login(t, other), await login(t, admin), await login(t, admin2)];
});

async function pdf(title: string): Promise<Buffer> {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([400, 400]).drawText(title, { x: 40, y: 340, size: 18, font });
  return Buffer.from(await d.save());
}
async function upload(title = 'Merger plan'): Promise<string> {
  const r = await as(t, A).upload('/api/documents', await pdf(title), 'plan.pdf', { title, category: 'Legal' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
const share = (doc: string, body: object) => as(t, A).put(`/api/documents/${doc}/access`, body);
const grantOf = async (doc: string, userId: string) =>
  ((await as(t, A).get(`/api/documents/${doc}/access`)).body.grants as { id: string; subject: { id: string } }[]).find((g) => g.subject.id === userId)!.id;
const tickets = (doc: string) => withDb(ownerDb(), async (db) => (await db.query(`SELECT action, user_id FROM unwrap_tickets WHERE document_id = $1 ORDER BY issued_at`, [doc])).rows);

describe('View only cannot be turned into the original file', () => {
  it('not by asking for a download approval, not by the Android key, not by an approval meant for someone else', async () => {
    const doc = await upload();
    await share(doc, { userId: viewer.id, level: 'VIEW' }).expect(200);
    await share(doc, { userId: other.id, level: 'READ', policy: { downloadApproval: true } }).expect(200);
    await as(t, V).get(`/api/documents/${doc}/pages/1`).expect(200);
    // A VIEW holder may ASK (THREATS.md V1), but asking alone releases nothing:
    // without their OWN approved request the bytes stay refused.
    await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'I would like the original please' }).expect(201);
    await as(t, V).get(`/api/documents/${doc}/download`).expect(404);
    // The person with READ asks and is approved; the VIEW holder still gets nothing
    // from an approval meant for someone else.
    const req = await as(t, O).post(`/api/documents/${doc}/download-requests`, { reason: 'Needed for the year-end audit' }).expect(201);
    await as(t, A).post(`/api/download-requests/${req.body.id}/approve`, { hours: 24, uses: 3 }).expect(200);
    await as(t, V).get(`/api/documents/${doc}/download`).expect(404);
    await as(t, V).post(`/api/documents/${doc}/offline-key`).expect(404);
    // Nothing was released by keyd for the VIEW holder but the page render.
    expect((await tickets(doc)).filter((r) => r.user_id === viewer.id).map((r) => r.action)).toEqual(['view_page']);
    // The approved person downloads with their approval: one ticket, the approval named in the record.
    await as(t, O).get(`/api/documents/${doc}/download`).expect(200);
    const row = (await auditRows(`action = 'document.download' AND outcome = 'ALLOWED' AND actor_id = $1`, [other.id]))[0]!;
    expect(row.details).toMatchObject({ approvalId: req.body.id, level: 'READ' });
  });

  it('a group View share does not waive the approval a direct Read share asks for', async () => {
    const doc = await upload();
    const g = await as(t, ADM).post('/api/admin/groups', { name: 'Atk viewers' }).expect(201);
    await as(t, ADM).post(`/api/admin/groups/${g.body.id}/members`, { userId: viewer.id }).expect(204);
    await share(doc, { groupId: g.body.id, level: 'VIEW' }).expect(200);
    await share(doc, { userId: viewer.id, level: 'READ', policy: { downloadApproval: true } }).expect(200);
    const r = await as(t, V).get(`/api/documents/${doc}/download`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('approval_required');
    expect(await tickets(doc)).toEqual([]);
  });
});

describe('revocation is immediate across the new paths', () => {
  it('a revoke cancels approvals, destroys the Android key and stops pages, downloads and keys at once', async () => {
    const doc = await upload();
    await share(doc, { userId: viewer.id, level: 'READ', policy: { downloadApproval: true } }).expect(200);
    const req = await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'Needed for the year-end audit' }).expect(201);
    await as(t, A).post(`/api/download-requests/${req.body.id}/approve`, { hours: 24, uses: 5 }).expect(200);
    await as(t, V).get(`/api/documents/${doc}/download`).expect(200);
    await as(t, V).post(`/api/documents/${doc}/offline-key`).expect(200);
    await as(t, V).get(`/api/documents/${doc}/pages/1`).expect(200);

    await as(t, A).delete(`/api/documents/${doc}/access/${await grantOf(doc, viewer.id)}`).expect(200);
    await as(t, V).get(`/api/documents/${doc}/pages/1`).expect(404); // even with the drawn file still cached in memory
    await as(t, V).get(`/api/documents/${doc}/download`).expect(404);
    await as(t, V).post(`/api/documents/${doc}/offline-key`).expect(404);
    const left = await withDb(ownerDb(), async (db) => ({
      keys: (await db.query(`SELECT 1 FROM offline_keys WHERE document_id = $1`, [doc])).rowCount,
      approval: (await db.query(`SELECT status FROM download_approvals WHERE id = $1`, [req.body.id])).rows[0].status,
    }));
    expect(left).toEqual({ keys: 0, approval: 'CANCELLED' });
    // Re-shared later: the old approval does not come back.
    await share(doc, { userId: viewer.id, level: 'READ', policy: { downloadApproval: true } }).expect(200);
    expect((await as(t, V).get(`/api/documents/${doc}/download`)).body.code).toBe('approval_required');
  });

  it('a time window closes pages too, and the database agrees on its own', async () => {
    const doc = await upload();
    const closed = { days: [((new Date().getUTCDay() + 3) % 7) + 1], start: '00:00', end: '01:00', timeZone: 'UTC' };
    await share(doc, { userId: viewer.id, level: 'VIEW', policy: { window: closed } }).expect(200);
    const r = await as(t, V).get(`/api/documents/${doc}/pages/1`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('outside_time_window');
    // The render source function refuses too, without the app's decision;
    // the same call for someone with an unconditioned share gets the row.
    await share(doc, { userId: other.id, level: 'VIEW' }).expect(200);
    const versionId = (await withDb(ownerDb(), (db) => db.query(`SELECT id FROM document_versions WHERE document_id = $1`, [doc]))).rows[0].id as string;
    const renderRows = (userId: string) => withDb(appDb(), async (db) => {
      await db.query('BEGIN');
      try {
        await db.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
        return (await db.query(`SELECT * FROM tv_render_source($1)`, [versionId])).rowCount;
      } finally { await db.query('ROLLBACK'); }
    });
    expect(await renderRows(viewer.id)).toBe(0);
    expect(await renderRows(other.id)).toBe(1);
  });
});

describe('two-admin break-glass and the other controls', () => {
  it('break-glass gives an admin the pages only: no download, no approval request, no Android key, and it ends with the role', async () => {
    const doc = await upload();
    const id = await approved(t, ADM, ADM2, { action: 'BREAK_GLASS', documentId: doc, reason: 'Legal hold request #4471 from counsel' });
    await as(t, ADM).post('/api/admin/break-glass', { documentId: doc, approvalId: id }).expect(201);
    await as(t, ADM).get(`/api/documents/${doc}/pages/1`).expect(200);
    await as(t, ADM).get(`/api/documents/${doc}/download`).expect(404);
    expect([403, 404]).toContain((await as(t, ADM).post(`/api/documents/${doc}/download-requests`, { reason: 'Give me the original file' })).status);
    await as(t, ADM).post(`/api/documents/${doc}/offline-key`).expect(404);
    expect((await tickets(doc)).map((r) => r.action)).toEqual(['view_page']);
    // The second admin demotes the first: the window ends at once.
    await as(t, ADM2).patch(`/api/admin/users/${admin.id}`, { role: 'OWNER' }).expect(200);
    await as(t, ADM).get(`/api/documents/${doc}/pages/1`).expect(401); // session ended by the role change
  });

  it('a download refused by the hard limit uses no approval and leaves no key release', async () => {
    const doc = await upload();
    await share(doc, { userId: viewer.id, level: 'READ', policy: { downloadApproval: true } }).expect(200);
    const req = await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'Needed for the year-end audit' }).expect(201);
    await as(t, A).post(`/api/download-requests/${req.body.id}/approve`, { hours: 24, uses: 10 }).expect(200);
    // The smallest session limit an admin may set is 5.
    await as(t, ADM).put('/api/admin/risk-settings', { values: { download_session_limit: 5 }, reason: 'test: five downloads per session' }).expect(200);
    for (let i = 0; i < 5; i++) await as(t, V).get(`/api/documents/${doc}/download`).expect(200);
    expect((await as(t, V).get(`/api/documents/${doc}/download`)).status).toBe(429);
    const a = await withDb(ownerDb(), async (db) => (await db.query(`SELECT uses, status FROM download_approvals WHERE id = $1`, [req.body.id])).rows[0]);
    expect(a).toEqual({ uses: 5, status: 'APPROVED' });
    expect((await tickets(doc)).map((r) => r.action)).toEqual(['download', 'download', 'download', 'download', 'download']);
  });
});
