import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, auditRows, createUser, login, ORIGIN, PDF, resetState, startApp, type Session, type TestApp, type TestUser } from './helpers.js';

// "You can prove who reached a document, afterwards, from the record,
// including the attempts that were refused." Refusals that happen before
// AccessService.require() (validation, parsing, guard checks) must leave a
// row too, and a refusal must never be recorded twice.

let t: TestApp;
let alice: TestUser, bob: TestUser;
let A: Session, B: Session;

beforeAll(async () => {
  t = await startApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t.app);
  alice = await createUser({ email: 'alice@t.io', role: 'OWNER' });
  bob = await createUser({ email: 'bob@t.io', role: 'OWNER' });
  [A, B] = await Promise.all([login(t, alice), login(t, bob)]);
});

async function upload(s: Session): Promise<string> {
  const res = await as(t, s).upload('/api/documents', PDF, 'letter.pdf', { title: 'Salary letter', category: 'HR' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

const rowsFor = (res: { headers: Record<string, unknown> }) => auditRows(`request_id = $1`, [res.headers['x-request-id']]);

const cookieOf = (res: { headers: Record<string, unknown> }) =>
  ([] as string[]).concat((res.headers['set-cookie'] as string[]) ?? []).find((c) => c.startsWith('__Host-tv_session='))!.split(';')[0]!;

describe('refusals before the document access check are recorded', () => {
  it('a malformed PATCH body on someone else’s document is refused and recorded with that documentId', async () => {
    const doc = await upload(A);
    const res = await as(t, B).patch(`/api/documents/${doc}`, { ownerId: B.userId });
    expect(res.status).toBe(400);
    const rows = await rowsFor(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'document.request_refused', outcome: 'DENIED', reason: 'invalid_input',
      target_type: 'document', target_id: doc, document_id: doc, actor_id: bob.id, actor_email: bob.email,
    });
    expect(rows[0]!.details).toMatchObject({ method: 'PATCH', path: `/api/documents/${doc}`, status: 400 });
  });

  it('a PATCH with a bad body on your own document is recorded too', async () => {
    const doc = await upload(A);
    const res = await as(t, A).patch(`/api/documents/${doc}`, {});
    expect(res.status).toBe(400);
    const rows = await rowsFor(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'document.request_refused', outcome: 'DENIED', reason: 'invalid_input', document_id: doc, actor_id: alice.id });
  });

  it('a download with a versionNo that is not a number is recorded', async () => {
    const doc = await upload(A);
    const path = `/api/documents/${doc}/versions/abc/download`;
    const res = await as(t, B).get(path);
    expect(res.status).toBe(400);
    const rows = await rowsFor(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'document.request_refused', outcome: 'DENIED', reason: 'invalid_input', document_id: doc, actor_id: bob.id });
    expect(rows[0]!.details).toMatchObject({ method: 'GET', path, status: 400 });
  });

  it('a malformed document id is recorded with the id that was tried', async () => {
    const res = await as(t, B).get('/api/documents/not-a-uuid');
    expect(res.status).toBe(404);
    const rows = await rowsFor(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'document.request_refused', reason: 'invalid_document_id', target_id: 'not-a-uuid', document_id: null, actor_id: bob.id });
  });
});

describe('security guard refusals are recorded', () => {
  it('an admin with a password-only session gets 403 on a download and a security.mfa_required row names the path', async () => {
    const doc = await upload(A);
    const adm = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const r = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: adm.email, password: adm.password });
    expect(r.body.mfaRequired).toBe(true);
    const s = { cookie: cookieOf(r), csrf: r.body.csrfToken as string, userId: adm.id };
    const path = `/api/documents/${doc}/download`;
    const res = await as(t, s).get(path);
    expect(res.status).toBe(403);
    const rows = await rowsFor(res);
    // One row: the guard's, not a second one from the error filter.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'security.mfa_required', outcome: 'DENIED', reason: 'mfa_required', actor_id: adm.id, actor_email: adm.email });
    expect(rows[0]!.details).toMatchObject({ method: 'GET', path });
    const byPath = await auditRows(`action = 'security.mfa_required' AND actor_id = $1 AND details->>'path' = $2`, [adm.id, path]);
    expect(byPath.length).toBeGreaterThanOrEqual(1);
  });

  it('a state-changing request with a foreign Origin is recorded as security.origin_refused', async () => {
    const doc = await upload(A);
    const res = await t.http.patch(`/api/documents/${doc}`)
      .set('Cookie', A.cookie).set('Origin', 'https://evil.example').set('X-CSRF-Token', A.csrf)
      .send({ title: 'pwned' });
    expect(res.status).toBe(403);
    const rows = await rowsFor(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'security.origin_refused', outcome: 'DENIED', reason: 'cross_origin' });
    expect(rows[0]!.details).toMatchObject({ method: 'PATCH', path: `/api/documents/${doc}`, origin: 'https://evil.example' });
  });
});

describe('no double recording', () => {
  it('a document refusal from AccessService is recorded exactly once', async () => {
    const doc = await upload(A);
    const res = await as(t, B).get(`/api/documents/${doc}`);
    expect(res.status).toBe(404);
    const rows = await rowsFor(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'document.view', outcome: 'DENIED', reason: 'no_grant', document_id: doc, actor_id: bob.id });
    expect(await auditRows(`request_id = $1 AND action = 'document.request_refused'`, [res.headers['x-request-id']])).toHaveLength(0);
  });
});
