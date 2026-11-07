import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createUser, ORIGIN, ownerDb, resetState, startApp, withDb, type TestApp, type TestUser } from './helpers.js';

// THREATS.md S21a: with DEMO_ADMIN_NO_MFA on, the published (protected) demo
// administrators sign in with a password only, so reviewers need no
// authenticator. Any other administrator still needs a second factor.

const cookieOf = (res: { headers: Record<string, unknown> }) =>
  ([] as string[]).concat((res.headers['set-cookie'] as string[]) ?? []).find((c) => c.startsWith('__Host-tv_session='))!.split(';')[0]!;

async function passwordOnly(t: TestApp, u: TestUser) {
  const res = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: u.email, password: u.password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { res, s: { cookie: cookieOf(res), csrf: res.body.csrfToken as string, userId: res.body.user.id as string } };
}

async function protectedAdmin(email: string): Promise<TestUser> {
  const u = await createUser({ email, role: 'ADMIN' }); // enrolled in TOTP, like the seeded demo admins
  await withDb(ownerDb(), (db) => db.query('UPDATE users SET is_protected = true WHERE id = $1', [u.id]));
  return u;
}

describe('DEMO_ADMIN_NO_MFA=true', () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp({ DEMO_ADMIN_NO_MFA: 'true' }); });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetState(t.app); });

  it('a protected demo admin is fully signed in with the password alone', async () => {
    const demo = await protectedAdmin('demo-admin@t.io');
    const { res, s } = await passwordOnly(t, demo);
    expect(res.body.mfaRequired).toBe(false);
    const users = await as(t, s).get('/api/admin/users');
    expect(users.status, JSON.stringify(users.body)).toBe(200);
  });

  it('a real (unprotected) admin still needs the second factor', async () => {
    const real = await createUser({ email: 'real-admin@t.io', role: 'ADMIN' });
    const { res, s } = await passwordOnly(t, real);
    expect(res.body.mfaRequired).toBe(true);
    const users = await as(t, s).get('/api/admin/users');
    expect(users.status).toBe(403);
    expect(users.body.code).toBe('mfa_required');
  });
});

describe('DEMO_ADMIN_NO_MFA off (the default)', () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp(); });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetState(t.app); });

  it('a protected demo admin needs the second factor like any admin', async () => {
    const demo = await protectedAdmin('demo-admin@t.io');
    const { res, s } = await passwordOnly(t, demo);
    expect(res.body.mfaRequired).toBe(true);
    const users = await as(t, s).get('/api/admin/users');
    expect(users.status).toBe(403);
  });
});
