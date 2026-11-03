import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MailService } from '../src/mail/mail.service.js';
import { as, auditRows, createUser, login, ownerDb, PDF, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from './helpers.js';

// A VIEW-only grantee may ask the owner (or a nominated manager) for permission
// to download ONE document, and, once approved, download THAT document+version
// only (THREATS.md V1, P8-P10). Everything else about their VIEW access is
// unchanged, and a VIEW holder with no usable approval is still refused the
// bytes. The database lock is tested on its own in view-download-db.test.ts.

let t: TestApp;
let mail: MailService;
let alice: TestUser, bob: TestUser, vic: TestUser, mgr: TestUser, ext: TestUser;
let A: Session, B: Session, V: Session, M: Session, X: Session;
let doc: string, other: string;

const PDF2 = Buffer.from(PDF.toString('latin1').replace('%%EOF', '% v2\n%%EOF'), 'latin1');
const settle = () => new Promise((r) => setTimeout(r, 150));
const sentTo = (email: string) => mail.outbox.filter((m) => m.to === email && !/shared a document with you/.test(m.subject));
const share = (s: Session, id: string, userId: string, level: string, policy?: object) =>
  as(t, s).put(`/api/documents/${id}/access`, { userId, level, ...(policy ? { policy } : {}) });
const dl = (d: string) => as(t, V).get(`/api/documents/${d}/download`);
const viewDownload = async (s: Session, d: string) => (await as(t, s).get(`/api/documents/${d}`).expect(200)).body.download;

beforeAll(async () => {
  t = await startApp({ MAIL_TRANSPORT: 'memory' });
  mail = t.app.get(MailService);
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t.app);
  alice = await createUser({ email: 'alice@vd.io', role: 'OWNER' });
  bob = await createUser({ email: 'bob@vd.io', role: 'OWNER' });
  vic = await createUser({ email: 'vic@vd.io', role: 'VIEWER' });
  mgr = await createUser({ email: 'mgr@vd.io', role: 'VIEWER' });
  ext = await createUser({ email: 'ext@vd.io', role: 'EXTERNAL' });
  [A, B, V, M, X] = await Promise.all([login(t, alice), login(t, bob), login(t, vic), login(t, mgr), login(t, ext)]);
  doc = (await as(t, A).upload('/api/documents', PDF, 'payroll.pdf', { title: 'Payroll', category: 'HR' }).expect(201)).body.id;
  other = (await as(t, A).upload('/api/documents', PDF, 'other.pdf', { title: 'Other', category: 'HR' }).expect(201)).body.id;
  await settle();
  mail.outbox.length = 0;
});

describe('a VIEW holder downloads one file by owner approval', () => {
  it('request → owner emailed → approve → one download of THAT file only → refused again; every step audited and in history', async () => {
    await share(A, doc, vic.id, 'VIEW').expect(200);
    // The viewer can open the document but not its bytes, and the response says
    // they may ask (THREATS.md V1).
    expect(await viewDownload(V, doc)).toEqual({ allowed: false, requestable: true, requestStatus: 'NONE' });
    await dl(doc).expect(404);   // no download right, and no approval: the same 404 as before

    const req = await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'Needed for the year-end audit' }).expect(201);
    await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'Needed for the year-end audit' }).expect(409);  // one open request
    await settle();
    expect(sentTo('alice@vd.io').map((m) => m.subject)).toEqual(['vic@vd.io asks to download “Payroll”']);
    expect(await viewDownload(V, doc)).toMatchObject({ allowed: false, requestable: false, requestStatus: 'PENDING' });

    // Owner sees it in the inbox; the requester cannot approve their own.
    expect((await as(t, A).get('/api/download-requests').expect(200)).body.requests.map((r: { id: string }) => r.id)).toEqual([req.body.id]);
    await as(t, V).post(`/api/download-requests/${req.body.id}/approve`, {}).expect(403);
    await as(t, A).post(`/api/download-requests/${req.body.id}/approve`, { hours: 24, uses: 1, note: 'ok for audit' }).expect(200);
    await settle();
    expect(sentTo('vic@vd.io').map((m) => m.subject)).toEqual(['Download approved: “Payroll”']);
    expect(await viewDownload(V, doc)).toEqual({ allowed: true, requestable: false, requestStatus: 'APPROVED' });

    // The one download works, app + DB RLS + keyd ticket all allowing it: a 200
    // means the blob policy released the bytes and the key service minted a
    // ticket for a holder below READ.
    const got = await dl(doc).expect(200);
    expect(createHash('sha256').update(Buffer.from(got.body)).digest('hex')).toBe(got.headers['x-document-sha256']);
    // Single use: nothing more, and the viewer may ask again.
    await dl(doc).expect(404);
    expect(await viewDownload(V, doc)).toEqual({ allowed: false, requestable: true, requestStatus: 'NONE' });

    // Nothing else changed: no access to any other document, approval or not.
    await as(t, V).get(`/api/documents/${other}`).expect(404);
    await as(t, V).get(`/api/documents/${other}/download`).expect(404);

    const rows = await auditRows(`document_id = $1 AND (action LIKE 'download_approval.%' OR action = 'document.download')`, [doc]);
    expect(rows.map((r) => `${r.action}:${r.outcome}:${r.reason ?? ''}`)).toEqual([
      'document.download:DENIED:needs_read',
      'download_approval.request:ALLOWED:',
      'download_approval.approve:DENIED:self_approval',
      'download_approval.approve:ALLOWED:',
      'download_approval.use:ALLOWED:',
      'document.download:ALLOWED:download_approval',
      'document.download:DENIED:needs_read',
    ]);
    expect((rows[5]!.details as { approvalId: string }).approvalId).toBe(req.body.id);

    // The owner sees the request, the approval and the download in the history.
    const hist = (await as(t, A).get(`/api/documents/${doc}/history`).expect(200)).body.events.map((e: { action: string }) => e.action);
    expect(hist).toEqual(expect.arrayContaining(['download_approval.request', 'download_approval.approve', 'document.download']));
  });

  it('a nominated manager may approve a VIEW holder’s request', async () => {
    await share(A, doc, mgr.id, 'MANAGE').expect(200);
    await share(A, doc, vic.id, 'VIEW', { downloadApproval: true, approverId: mgr.id }).expect(200);
    const req = await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'Client asked for the signed copy' }).expect(201);
    await settle();
    expect(sentTo('mgr@vd.io')).toHaveLength(1);
    await as(t, B).post(`/api/download-requests/${req.body.id}/approve`, {}).expect(404);   // unrelated owner never sees it
    await as(t, M).post(`/api/download-requests/${req.body.id}/approve`, {}).expect(200);
    await dl(doc).expect(200);
  });

  it('the approval is bound to one version: the current version moves, the old-version approval does not download it', async () => {
    await share(A, doc, vic.id, 'VIEW').expect(200);
    const req = await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'Version one please, for the record' }).expect(201);
    await as(t, A).upload(`/api/documents/${doc}/versions`, PDF2, 'payroll.pdf').expect(201);   // current is now v2
    await as(t, A).post(`/api/download-requests/${req.body.id}/approve`, { uses: 2 }).expect(200);
    // The approval is still usable (for v1), so the current-version download
    // reaches the per-version check and is refused there, not at the door.
    expect((await dl(doc).expect(403)).body.code).toBe('approval_required');      // current version is 2, approval is for 1
    await as(t, V).get(`/api/documents/${doc}/versions/1/download`).expect(200);  // the approved version
  });

  it('multi-use terms: exactly N downloads, then refused', async () => {
    await share(A, doc, vic.id, 'VIEW').expect(200);
    const req = await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'Several copies for the board' }).expect(201);
    await as(t, A).post(`/api/download-requests/${req.body.id}/approve`, { uses: 2 }).expect(200);
    await dl(doc).expect(200);
    await dl(doc).expect(200);
    await dl(doc).expect(404);
  });

  it('revoking the VIEW grant stops an approved, partly used approval at once', async () => {
    const g = await share(A, doc, vic.id, 'VIEW').expect(200);
    const req = await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'Several copies for the board' }).expect(201);
    await as(t, A).post(`/api/download-requests/${req.body.id}/approve`, { uses: 5 }).expect(200);
    await dl(doc).expect(200);
    const rv = await as(t, A).delete(`/api/documents/${doc}/access/${g.body.id}`).expect(200);
    expect((rv.body as { stillHas: unknown }).stillHas).toBeNull();
    await dl(doc).expect(404);
    await as(t, V).get(`/api/documents/${doc}`).expect(404);
    expect(((await auditRows(`target_id = $1 AND action = 'access.revoke'`, [g.body.id]))[0]!.details as { approvalsCancelled: number }).approvalsCancelled).toBe(1);
  });

  it('a rejected request releases nothing and is recorded', async () => {
    await share(A, doc, vic.id, 'VIEW').expect(200);
    const req = await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'I would like a local copy' }).expect(201);
    await as(t, A).post(`/api/download-requests/${req.body.id}/reject`, { note: 'Read it in the app' }).expect(200);
    await dl(doc).expect(404);
    expect(await viewDownload(V, doc)).toMatchObject({ allowed: false, requestStatus: 'REJECTED' });
    // After a rejection the viewer may ask again (not pending/approved).
    expect((await viewDownload(V, doc)).requestable).toBe(true);
  });

  it('an external VIEW holder may also download one file once the owner approves (externals capped at READ otherwise)', async () => {
    // External grants must carry an expiry (THREATS.md V10).
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await as(t, A).put(`/api/documents/${doc}/access`, { userId: ext.id, level: 'VIEW', expiresAt }).expect(200);
    const req = await as(t, X).post(`/api/documents/${doc}/download-requests`, { reason: 'Signed copy for our records' }).expect(201);
    await as(t, A).post(`/api/download-requests/${req.body.id}/approve`, {}).expect(200);
    await as(t, X).get(`/api/documents/${doc}/download`).expect(200);
    await as(t, X).get(`/api/documents/${doc}/download`).expect(404);   // single use
  });

  it('a VIEW holder with no approval cannot download, and asking twice without a grant at all is refused', async () => {
    // No share: no view, no request.
    await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'no access at all here' }).expect(404);
    // With VIEW but no approval: the bytes are refused and nothing is released.
    await share(A, doc, vic.id, 'VIEW').expect(200);
    await dl(doc).expect(404);
    expect(await viewDownload(V, doc)).toMatchObject({ allowed: false, requestable: true });
  });
});
