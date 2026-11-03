import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MailService } from '../src/mail/mail.service.js';
import { as, auditRows, createUser, login, ownerDb, PDF, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from './helpers.js';

// Access policies through the API (THREATS.md P1-P12): download approval,
// time windows, network allowlists, emergency exceptions, role rules.
// The database lock is tested on its own in access-policy-db.test.ts.

let t: TestApp;
let mail: MailService;
let alice: TestUser, bob: TestUser, vic: TestUser, mgr: TestUser, mgr2: TestUser, admin: TestUser;
let A: Session, B: Session, V: Session, M: Session, M2: Session, ADM: Session;
let doc: string;

const PDF2 = Buffer.from(PDF.toString('latin1').replace('%%EOF', '% v2\n%%EOF'), 'latin1');
const settle = () => new Promise((r) => setTimeout(r, 150));
// Share notices ("... shared a document with you") are not what these tests are about.
const sentTo = (email: string) => mail.outbox.filter((m) => m.to === email && !/shared a document with you/.test(m.subject));
const dbNow = () => withDb(ownerDb(), async (db) => (await db.query('SELECT now() AS t')).rows[0].t as Date);
const todayUtc = () => ((new Date().getUTCDay() + 6) % 7) + 1;
const notToday = () => [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== todayUtc());
const fromIp = (s: Session, url: string, xff?: string, app: TestApp = t) => {
  const r = app.http.get(url).set('Cookie', s.cookie);
  return xff ? r.set('X-Forwarded-For', xff) : r;
};
const share = (s: Session, userId: string, level: string, policy?: object) =>
  as(t, s).put(`/api/documents/${doc}/access`, { userId, level, ...(policy ? { policy } : {}) });

beforeAll(async () => {
  t = await startApp({ MAIL_TRANSPORT: 'memory' });
  mail = t.app.get(MailService);
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t.app);
  await withDb(ownerDb(), (db) => db.query('DELETE FROM role_access_policies'));
  alice = await createUser({ email: 'alice@ap.io', role: 'OWNER' });
  bob = await createUser({ email: 'bob@ap.io', role: 'OWNER' });
  vic = await createUser({ email: 'vic@ap.io', role: 'VIEWER' });
  mgr = await createUser({ email: 'mgr@ap.io', role: 'VIEWER' });
  mgr2 = await createUser({ email: 'mgr2@ap.io', role: 'VIEWER' });
  admin = await createUser({ email: 'admin@ap.io', role: 'ADMIN' });
  [A, B, V, M, M2, ADM] = await Promise.all([login(t, alice), login(t, bob), login(t, vic), login(t, mgr), login(t, mgr2), login(t, admin)]);
  doc = (await as(t, A).upload('/api/documents', PDF, 'payroll.pdf', { title: 'Payroll', category: 'HR' }).expect(201)).body.id;
  await settle();
  mail.outbox.length = 0;
});

describe('downloads that need approval', () => {
  it('request → owner emailed → approve → one download → refused again; every step audited', async () => {
    const since = await dbNow();
    await share(A, vic.id, 'READ', { downloadApproval: true }).expect(200);
    // Viewing the details stays allowed; the bytes do not.
    expect((await as(t, V).get(`/api/documents/${doc}`).expect(200)).body.downloadNeedsApproval).toBe(true);
    const refused = await as(t, V).get(`/api/documents/${doc}/download`).expect(403);
    expect(refused.body.code).toBe('approval_required');

    const req = await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'Needed for the year-end audit' }).expect(201);
    await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'Needed for the year-end audit' }).expect(409);
    await settle();
    expect(sentTo('alice@ap.io').map((m) => m.subject)).toEqual(['vic@ap.io asks to download “Payroll”']);
    expect(sentTo('alice@ap.io')[0]!.text).toContain('Needed for the year-end audit');

    const inbox = await as(t, A).get('/api/download-requests').expect(200);
    expect(inbox.body.requests.map((r: { id: string }) => r.id)).toEqual([req.body.id]);
    expect((await as(t, V).get('/api/download-requests').expect(200)).body.requests).toEqual([]); // not their inbox

    // The requester cannot approve their own request.
    await as(t, V).post(`/api/download-requests/${req.body.id}/approve`, {}).expect(403);
    await as(t, A).post(`/api/download-requests/${req.body.id}/approve`, { hours: 24, uses: 1, note: 'ok for audit' }).expect(200);
    await settle();
    expect(sentTo('vic@ap.io').map((m) => m.subject)).toEqual(['Download approved: “Payroll”']);

    const got = await as(t, V).get(`/api/documents/${doc}/download`).expect(200);
    expect(Buffer.from(got.body).equals(PDF)).toBe(true);
    expect((await as(t, V).get(`/api/documents/${doc}/download`).expect(403)).body.code).toBe('approval_required');

    const rows = await auditRows(`document_id = $1 AND occurred_at >= $2 AND (action LIKE 'download_approval.%' OR action = 'document.download')`, [doc, since]);
    expect(rows.map((r) => `${r.action}:${r.outcome}:${r.reason ?? ''}`)).toEqual([
      'document.download:DENIED:approval_required',
      'download_approval.request:ALLOWED:',
      'download_approval.approve:DENIED:self_approval',
      'download_approval.approve:ALLOWED:',
      'download_approval.use:ALLOWED:',
      'document.download:ALLOWED:grant',
      'document.download:DENIED:approval_required',
    ]);
    expect((rows[5]!.details as { approvalId: string }).approvalId).toBe(req.body.id);
  });

  it('an approval is bound to one version and one person', async () => {
    await share(A, vic.id, 'READ', { downloadApproval: true }).expect(200);
    await share(A, mgr.id, 'READ', { downloadApproval: true }).expect(200);
    const req = await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'Version one please, for the record' }).expect(201);
    await as(t, A).upload(`/api/documents/${doc}/versions`, PDF2, 'payroll.pdf').expect(201);
    await as(t, A).post(`/api/download-requests/${req.body.id}/approve`, { uses: 2 }).expect(200);
    await as(t, M).get(`/api/documents/${doc}/versions/1/download`).expect(403);   // someone else
    await as(t, V).get(`/api/documents/${doc}/download`).expect(403);              // current version is 2
    await as(t, V).get(`/api/documents/${doc}/versions/1/download`).expect(200);
  });

  it('a rejected request releases nothing and is recorded; the requester is told', async () => {
    await share(A, vic.id, 'READ', { downloadApproval: true }).expect(200);
    const req = await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'I would like a local copy' }).expect(201);
    const r = await as(t, A).post(`/api/download-requests/${req.body.id}/reject`, { note: 'Read it in the app' }).expect(200);
    expect(r.body.status).toBe('REJECTED');
    await as(t, A).post(`/api/download-requests/${req.body.id}/approve`, {}).expect(409);
    await as(t, V).get(`/api/documents/${doc}/download`).expect(403);
    const mine = await as(t, V).get(`/api/documents/${doc}/download-requests`).expect(200);
    expect(mine.body.requests[0]).toMatchObject({ status: 'REJECTED', note: 'Read it in the app', mine: true });
    await settle();
    expect(sentTo('vic@ap.io').map((m) => m.subject)).toEqual(['Download not approved: “Payroll”']);
  });

  it('a nominated manager may decide; another manager may not; a manager never decides their own request', async () => {
    await share(A, mgr.id, 'MANAGE').expect(200);
    await share(A, mgr2.id, 'MANAGE', { downloadApproval: true }).expect(200);
    await share(A, vic.id, 'READ', { downloadApproval: true, approverId: mgr.id }).expect(200);
    const req = await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'Client asked for the signed copy' }).expect(201);
    await settle();
    expect(sentTo('mgr@ap.io')).toHaveLength(1);                     // the nominee is told too
    // Another manager does not even see it; the attempt is recorded.
    await as(t, M2).post(`/api/download-requests/${req.body.id}/approve`, {}).expect(404);
    expect((await auditRows(`target_id = $1 AND action = 'download_approval.approve' AND outcome = 'DENIED'`, [req.body.id])).map((r) => r.reason)).toEqual(['no_such_request']);
    expect((await as(t, M).get('/api/download-requests').expect(200)).body.requests).toHaveLength(1);
    await as(t, B).post(`/api/download-requests/${req.body.id}/approve`, {}).expect(404);     // an unrelated owner
    await as(t, M).post(`/api/download-requests/${req.body.id}/approve`, {}).expect(200);

    const own = await as(t, M2).post(`/api/documents/${doc}/download-requests`, { reason: 'I need it for my own work' }).expect(201);
    await as(t, M2).post(`/api/download-requests/${own.body.id}/approve`, {}).expect(403);
    const rows = await auditRows(`target_id = $1 AND action = 'download_approval.approve'`, [own.body.id]);
    expect(rows.map((r) => `${r.outcome}:${r.reason}`)).toEqual(['DENIED:self_approval']);
  });

  it('an EDIT recipient whose downloads need approval can still upload a version, and gets back only what they uploaded', async () => {
    await share(A, vic.id, 'EDIT', { downloadApproval: true }).expect(200);
    await as(t, V).upload(`/api/documents/${doc}/versions`, PDF2, 'payroll.pdf').expect(201);
    await as(t, V).get(`/api/documents/${doc}/versions/2/download`).expect(200);   // their own upload
    expect((await as(t, V).get(`/api/documents/${doc}/versions/1/download`).expect(403)).body.code).toBe('approval_required');
  });

  it('a share without the condition needs no approval; asking is refused', async () => {
    await share(A, vic.id, 'READ').expect(200);
    await as(t, V).get(`/api/documents/${doc}/download`).expect(200);
    await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'just checking the flow' }).expect(400);
  });

  it('a protected demo owner is never emailed', async () => {
    await withDb(ownerDb(), (db) => db.query('UPDATE users SET is_protected = true WHERE id = $1', [alice.id]));
    await share(A, vic.id, 'READ', { downloadApproval: true }).expect(200);
    await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'Needed for the year-end audit' }).expect(201);
    await settle();
    expect(sentTo('alice@ap.io')).toHaveLength(0);
  });

  it('revocation stays immediate: an approved, partly used approval stops working the moment the share is removed', async () => {
    const g = await share(A, vic.id, 'READ', { downloadApproval: true }).expect(200);
    const req = await as(t, V).post(`/api/documents/${doc}/download-requests`, { reason: 'Several copies for the board' }).expect(201);
    await as(t, A).post(`/api/download-requests/${req.body.id}/approve`, { uses: 5 }).expect(200);
    await as(t, V).get(`/api/documents/${doc}/download`).expect(200);
    const rv = await as(t, A).delete(`/api/documents/${doc}/access/${g.body.id}`).expect(200);
    expect(rv.body.stillHas).toBeNull();
    await as(t, V).get(`/api/documents/${doc}/download`).expect(404);
    await as(t, V).get(`/api/documents/${doc}`).expect(404);
    const revoke = await auditRows(`target_id = $1 AND action = 'access.revoke'`, [g.body.id]);
    expect((revoke[0]!.details as { approvalsCancelled: number }).approvalsCancelled).toBe(1);
  });
});

describe('time windows and emergency exceptions', () => {
  it('outside the window the share gives nothing (with a reason); an owner exception lifts it until ended', async () => {
    const since = await dbNow();
    await share(A, vic.id, 'READ', { window: { days: notToday(), start: '00:00', end: '24:00', timeZone: 'UTC' } }).expect(200);
    const r = await as(t, V).get(`/api/documents/${doc}`).expect(403);
    expect(r.body.code).toBe('outside_time_window');
    expect(r.body.message).toMatch(/available only/);
    await as(t, V).get(`/api/documents/${doc}/download`).expect(403);
    expect((await as(t, V).get('/api/documents').expect(200)).body.total).toBe(0);

    // Only the owner gives exceptions.
    await as(t, V).post(`/api/documents/${doc}/overrides`, { userId: vic.id, reason: 'I need it right now please', hours: 2 }).expect(403);
    await share(A, mgr.id, 'MANAGE').expect(200);
    await as(t, M).post(`/api/documents/${doc}/overrides`, { userId: vic.id, reason: 'I need it right now please', hours: 2 }).expect(404);
    const o = await as(t, A).post(`/api/documents/${doc}/overrides`, { userId: vic.id, reason: 'Month-end close, approved by CFO', hours: 2 }).expect(201);
    await as(t, V).get(`/api/documents/${doc}`).expect(200);
    await as(t, V).get(`/api/documents/${doc}/download`).expect(200);
    await settle();
    expect(sentTo('vic@ap.io').map((m) => m.subject)).toEqual(['Temporary exception on “Payroll”']);
    expect(sentTo('alice@ap.io').map((m) => m.subject)).toEqual(['You gave an exception on “Payroll”']);

    await as(t, A).delete(`/api/documents/${doc}/overrides/${o.body.id}`).expect(204);
    await as(t, V).get(`/api/documents/${doc}`).expect(403);
    const rows = await auditRows(`document_id = $1 AND occurred_at >= $2 AND action IN ('access.override', 'access.override_end', 'document.view')`, [doc, since]);
    expect(rows.map((x) => `${x.action}:${x.outcome}:${x.reason ?? ''}`)).toEqual([
      'document.view:DENIED:outside_time_window',
      'access.override:ALLOWED:',
      'document.view:ALLOWED:grant',
      'access.override_end:ALLOWED:',
      'document.view:DENIED:outside_time_window',
    ]);
  });

  it('inside the window the share works', async () => {
    await share(A, vic.id, 'READ', { window: { days: [todayUtc()], start: '00:00', end: '24:00', timeZone: 'UTC' } }).expect(200);
    await as(t, V).get(`/api/documents/${doc}/download`).expect(200);
  });

  it('bad windows are refused with a clear message', async () => {
    const bad = async (window: object) => (await share(A, vic.id, 'READ', { window }).expect(400)).body.message as string;
    expect(await bad({ days: [1], start: '17:00', end: '09:00', timeZone: 'UTC' })).toMatch(/end after it starts/);
    expect(await bad({ days: [1], start: '09:00', end: '17:00', timeZone: 'UTC+5' })).toMatch(/Unknown time zone/);
    expect(await bad({ days: [1], start: '09:00', end: '17:00', timeZone: 'Mars/Olympus' })).toMatch(/Unknown time zone/);
  });

  it('a manager cannot change conditions the owner put on a share', async () => {
    await share(A, mgr.id, 'MANAGE').expect(200);
    await share(A, vic.id, 'READ', { downloadApproval: true }).expect(200);
    await share(M, vic.id, 'READ', { downloadApproval: false }).expect(403);
    await share(M, vic.id, 'EDIT').expect(200);      // level changes keep the conditions
    expect((await as(t, V).get(`/api/documents/${doc}`).expect(200)).body.downloadNeedsApproval).toBe(true);
  });
});

describe('network allowlists and the client address', () => {
  it('IPv4 and IPv6 ranges, on the address set by the trusted proxy; a spoofed left-most X-Forwarded-For is ignored', async () => {
    await share(A, vic.id, 'READ', { networks: ['10.0.0.0/8', '2001:db8::/32'] }).expect(200);
    const url = `/api/documents/${doc}`;
    expect((await fromIp(V, url).expect(403)).body.code).toBe('network_not_allowed');   // 127.0.0.1
    await fromIp(V, url, '10.1.2.3').expect(200);
    await fromIp(V, url, '2001:db8:0:1::5').expect(200);
    await fromIp(V, url, '2001:db9::5').expect(403);
    // nginx appending the real address after a client-supplied one: only the right-most counts.
    await fromIp(V, url, '10.1.2.3, 198.51.100.7').expect(403);
    const rows = await auditRows(`document_id = $1 AND reason = 'network_not_allowed'`, [doc]);
    expect(rows.at(-1)!.ip).toBe('198.51.100.7');
    // The download path is gated the same way (both locks).
    await fromIp(V, `${url}/download`, '10.9.9.9').expect(200);
    await fromIp(V, `${url}/download`, '11.9.9.9').expect(403);
  });

  it('X-Forwarded-For from a peer that is not a configured proxy is not believed', async () => {
    await share(A, vic.id, 'READ', { networks: ['10.0.0.0/8'] }).expect(200);
    const other = await startApp({ MAIL_TRANSPORT: 'memory', TRUSTED_PROXIES: '192.0.2.1' });
    try {
      await fromIp(V, `/api/documents/${doc}`, '10.1.2.3', other).expect(403);
    } finally {
      await other.close();
    }
  });

  it('host bits and junk ranges are refused', async () => {
    const r = await share(A, vic.id, 'READ', { networks: ['10.0.0.1/8'] }).expect(400);
    expect(r.body.message).toMatch(/did you mean 10.0.0.0\/8/);
    await share(A, vic.id, 'READ', { networks: ['intranet'] }).expect(400);
  });
});

describe('role rules (administrators)', () => {
  it('apply on top of every share for people with that role, never to owners on their own documents; audited', async () => {
    await share(A, vic.id, 'READ').expect(200);
    await as(t, A).put('/api/admin/access-policies/VIEWER', { networks: ['10.0.0.0/8'] }).expect(403);
    await as(t, ADM).put('/api/admin/access-policies/ADMIN', { networks: ['10.0.0.0/8'] }).expect(400);
    await as(t, ADM).put('/api/admin/access-policies/VIEWER', { networks: ['10.0.0.0/8'] }).expect(200);
    expect((await fromIp(V, `/api/documents/${doc}`, '8.8.8.8').expect(403)).body.message).toMatch(/Your role/);
    await fromIp(V, `/api/documents/${doc}`, '10.0.0.8').expect(200);
    await as(t, ADM).put('/api/admin/access-policies/OWNER', { window: { days: notToday(), start: '00:00', end: '24:00', timeZone: 'UTC' } }).expect(200);
    await as(t, A).get(`/api/documents/${doc}/download`).expect(200);  // own document
    const list = await as(t, ADM).get('/api/admin/access-policies').expect(200);
    expect(list.body.policies.map((p: { role: string }) => p.role).sort()).toEqual(['OWNER', 'VIEWER']);
    await as(t, ADM).delete('/api/admin/access-policies/VIEWER').expect(204);
    await fromIp(V, `/api/documents/${doc}`, '8.8.8.8').expect(200);
    const rows = await auditRows(`action IN ('policy.role_set', 'policy.role_clear') AND actor_id = $1`, [admin.id]);
    expect(rows.map((r) => `${r.action}:${r.target_id}`)).toEqual(['policy.role_set:VIEWER', 'policy.role_set:OWNER', 'policy.role_clear:VIEWER']);
  });
});

