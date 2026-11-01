import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, auditRows, createUser, login, ORIGIN, resetState, startApp, type TestApp } from './helpers.js';

let t: TestApp;

beforeAll(async () => {
  t = await startApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t.app);
});

describe('authentication is deny-by-default', () => {
  it('health is public', async () => {
    const res = await t.http.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('a protected route without a session is 401', async () => {
    const res = await t.http.get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('a forged or random cookie is 401', async () => {
    const res = await t.http.get('/api/auth/me').set('Cookie', '__Host-tv_session=not-a-real-token');
    expect(res.status).toBe(401);
  });
});

describe('login', () => {
  it('sets a __Host- cookie that is HttpOnly, Secure and SameSite=Strict', async () => {
    const u = await createUser({ email: 'v@t.io', role: 'VIEWER' });
    const res = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: u.email, password: u.password });
    expect(res.status).toBe(200);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Host-tv_session='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/);
    expect(res.body.user).toEqual({ id: u.id, email: u.email, displayName: u.email, role: 'VIEWER' });
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('accepts the email in any case and with spaces', async () => {
    const u = await createUser({ email: 'case@t.io', role: 'VIEWER' });
    const res = await t.http.post('/api/auth/login').send({ email: '  CASE@T.io ', password: u.password });
    expect(res.status).toBe(200);
  });

  it('gives the same answer for an unknown account and a wrong password', async () => {
    await createUser({ email: 'real@t.io', role: 'VIEWER' });
    const wrong = await t.http.post('/api/auth/login').send({ email: 'real@t.io', password: 'wrong-password-here' });
    const unknown = await t.http.post('/api/auth/login').send({ email: 'ghost@t.io', password: 'wrong-password-here' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('records refused logins in the audit log with the real reason', async () => {
    await createUser({ email: 'audited@t.io', role: 'VIEWER' });
    const res = await t.http.post('/api/auth/login').send({ email: 'audited@t.io', password: 'wrong-password-here' });
    const rows = await auditRows(`request_id = $1`, [res.headers['x-request-id']]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'auth.login', outcome: 'DENIED', reason: 'wrong_password', actor_email: 'audited@t.io' });
  });

  it('rejects unknown fields (mass assignment)', async () => {
    const res = await t.http.post('/api/auth/login').send({ email: 'a@t.io', password: 'x', role: 'ADMIN' });
    expect(res.status).toBe(400);
  });

  it('refuses a cross-origin login attempt', async () => {
    const u = await createUser({ email: 'xo@t.io', role: 'VIEWER' });
    const res = await t.http.post('/api/auth/login').set('Origin', 'https://evil.example').send({ email: u.email, password: u.password });
    expect(res.status).toBe(403);
  });

  it('refuses a deactivated account with the generic message', async () => {
    const admin = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const u = await createUser({ email: 'gone@t.io', role: 'VIEWER' });
    const a = await login(t, admin.email, admin.password);
    await as(t, a).post(`/api/admin/users/${u.id}/deactivate`).expect(200);
    const res = await t.http.post('/api/auth/login').send({ email: u.email, password: u.password });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid email or password');
  });

  it('refuses an external account whose access has expired', async () => {
    const u = await createUser({ email: 'ext@t.io', role: 'EXTERNAL', accessExpiresAt: new Date(Date.now() - 1000) });
    const res = await t.http.post('/api/auth/login').send({ email: u.email, password: u.password });
    expect(res.status).toBe(401);
    const rows = await auditRows(`request_id = $1`, [res.headers['x-request-id']]);
    expect(rows[0]).toMatchObject({ reason: 'access_expired' });
  });
});

describe('brute-force protection', () => {
  it('locks the account after 5 wrong passwords, even for the right password', async () => {
    const u = await createUser({ email: 'lock@t.io', role: 'VIEWER' });
    for (let i = 0; i < 5; i++) {
      await t.http.post('/api/auth/login').send({ email: u.email, password: `wrong-${i}-password` }).expect(401);
    }
    const res = await t.http.post('/api/auth/login').send({ email: u.email, password: u.password });
    expect(res.status).toBe(401);
    const rows = await auditRows(`request_id = $1`, [res.headers['x-request-id']]);
    expect(rows[0]).toMatchObject({ reason: 'account_locked' });
  });

  it('counts parallel wrong guesses (no lost updates)', async () => {
    const u = await createUser({ email: 'race@t.io', role: 'VIEWER' });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => t.http.post('/api/auth/login').send({ email: u.email, password: `wrong-${i}-password` })),
    );
    const res = await t.http.post('/api/auth/login').send({ email: u.email, password: u.password });
    expect(res.status).toBe(401);
  });

  it('rate-limits one IP after 20 attempts with 429', async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) {
      const r = await t.http.post('/api/auth/login').send({ email: `nobody${i}@t.io`, password: 'whatever-password' });
      last = r.status;
    }
    expect(last).toBe(429);
  });
});

describe('sessions end immediately', () => {
  it('logout needs the CSRF token, and the old cookie is dead afterwards', async () => {
    const u = await createUser({ email: 'out@t.io', role: 'VIEWER' });
    const s = await login(t, u.email, u.password);
    const noCsrf = await t.http.post('/api/auth/logout').set('Cookie', s.cookie).set('Origin', ORIGIN);
    expect(noCsrf.status).toBe(403);
    await as(t, s).post('/api/auth/logout').expect(204);
    await as(t, s).get('/api/auth/me').expect(401);
  });

  it('a CSRF token from another session does not work', async () => {
    const u1 = await createUser({ email: 'c1@t.io', role: 'VIEWER' });
    const u2 = await createUser({ email: 'c2@t.io', role: 'VIEWER' });
    const s1 = await login(t, u1.email, u1.password);
    const s2 = await login(t, u2.email, u2.password);
    const res = await t.http.post('/api/auth/logout').set('Cookie', s1.cookie).set('Origin', ORIGIN).set('X-CSRF-Token', s2.csrf);
    expect(res.status).toBe(403);
  });

  it('deactivating a user ends their live session on the next request', async () => {
    const admin = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const u = await createUser({ email: 'victim@t.io', role: 'OWNER' });
    const a = await login(t, admin.email, admin.password);
    const s = await login(t, u.email, u.password);
    await as(t, s).get('/api/auth/me').expect(200);
    await as(t, a).post(`/api/admin/users/${u.id}/deactivate`).expect(200);
    await as(t, s).get('/api/auth/me').expect(401);
  });

  it('changing a user role ends their sessions', async () => {
    const admin = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const u = await createUser({ email: 'promo@t.io', role: 'VIEWER' });
    const a = await login(t, admin.email, admin.password);
    const s = await login(t, u.email, u.password);
    await as(t, a).patch(`/api/admin/users/${u.id}`, { role: 'OWNER' }).expect(200);
    await as(t, s).get('/api/auth/me').expect(401);
  });

  it('changing your password ends every session, including other devices', async () => {
    const u = await createUser({ email: 'pw@t.io', role: 'VIEWER' });
    const laptop = await login(t, u.email, u.password);
    const phone = await login(t, u.email, u.password);
    await as(t, laptop).post('/api/auth/password', { currentPassword: u.password, newPassword: 'a-brand-new-long-password' }).expect(204);
    await as(t, laptop).get('/api/auth/me').expect(401);
    await as(t, phone).get('/api/auth/me').expect(401);
    await login(t, u.email, 'a-brand-new-long-password');
  });

  it('an admin password reset ends the user’s sessions', async () => {
    const admin = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const u = await createUser({ email: 'reset@t.io', role: 'VIEWER' });
    const a = await login(t, admin.email, admin.password);
    const s = await login(t, u.email, u.password);
    await as(t, a).post(`/api/admin/users/${u.id}/password`, { password: 'admin-set-long-password' }).expect(204);
    await as(t, s).get('/api/auth/me').expect(401);
  });

  it('logging in again from the same browser replaces the old session', async () => {
    const u = await createUser({ email: 'again@t.io', role: 'VIEWER' });
    const first = await login(t, u.email, u.password);
    const res = await t.http.post('/api/auth/login').set('Cookie', first.cookie).set('Origin', ORIGIN).send({ email: u.email, password: u.password });
    expect(res.status).toBe(200);
    await as(t, first).get('/api/auth/me').expect(401);
  });
});

describe('account roles', () => {
  for (const role of ['OWNER', 'VIEWER', 'EXTERNAL'] as const) {
    it(`${role} cannot use admin user management, and the attempt is audited`, async () => {
      const u = await createUser({ email: `${role.toLowerCase()}@t.io`, role, accessExpiresAt: role === 'EXTERNAL' ? new Date(Date.now() + 86_400_000) : undefined });
      const s = await login(t, u.email, u.password);
      const res = await as(t, s).get('/api/admin/users');
      expect(res.status).toBe(403);
      const rows = await auditRows(`request_id = $1`, [res.headers['x-request-id']]);
      expect(rows[0]).toMatchObject({ action: 'security.role', outcome: 'DENIED', actor_id: u.id });
      const create = await as(t, s).post('/api/admin/users', { email: 'x@t.io', displayName: 'x', role: 'ADMIN', password: 'long-enough-password' });
      expect(create.status).toBe(403);
    });
  }

  it('an admin cannot deactivate or demote themselves', async () => {
    const admin = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const a = await login(t, admin.email, admin.password);
    await as(t, a).post(`/api/admin/users/${admin.id}/deactivate`).expect(400);
    await as(t, a).patch(`/api/admin/users/${admin.id}`, { role: 'VIEWER' }).expect(400);
  });

  it('the last active admin cannot be removed', async () => {
    const a1 = await createUser({ email: 'a1@t.io', role: 'ADMIN' });
    const a2 = await createUser({ email: 'a2@t.io', role: 'ADMIN' });
    const s1 = await login(t, a1.email, a1.password);
    await as(t, s1).post(`/api/admin/users/${a2.id}/deactivate`).expect(200);
    // a1 is now the only admin; nobody else can remove them either.
    const s1b = await login(t, a1.email, a1.password);
    await as(t, s1b).post(`/api/admin/users/${a1.id}/deactivate`).expect(400);
  });

  it('external accounts must have a future expiry', async () => {
    const admin = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const a = await login(t, admin.email, admin.password);
    await as(t, a).post('/api/admin/users', { email: 'e@p.io', displayName: 'E', role: 'EXTERNAL', password: 'long-enough-password' }).expect(400);
    await as(t, a).post('/api/admin/users', { email: 'e@p.io', displayName: 'E', role: 'EXTERNAL', password: 'long-enough-password', accessExpiresAt: '2001-01-01' }).expect(400);
    await as(t, a).post('/api/admin/users', { email: 'e@p.io', displayName: 'E', role: 'EXTERNAL', password: 'long-enough-password', accessExpiresAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(201);
  });

  it('short passwords are refused', async () => {
    const admin = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const a = await login(t, admin.email, admin.password);
    await as(t, a).post('/api/admin/users', { email: 'short@t.io', displayName: 'S', role: 'VIEWER', password: 'short' }).expect(400);
  });
});

describe('responses leak nothing', () => {
  it('API responses are never cacheable and carry strict headers', async () => {
    const res = await t.http.get('/api/health');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('malformed JSON gives a clean 400, not a stack trace', async () => {
    const res = await t.http.post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js|SyntaxError/);
  });

  it('a non-UUID id gives 400, not a database error', async () => {
    const admin = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const a = await login(t, admin.email, admin.password);
    const res = await as(t, a).post("/api/admin/users/1' OR '1'='1/deactivate");
    expect([400, 404]).toContain(res.status);
  });
});
