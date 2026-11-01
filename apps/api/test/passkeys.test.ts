import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, auditRows, createUser, ORIGIN, resetState, startApp, type Session, type TestApp, type TestUser } from './helpers.js';
import { SoftAuthenticator } from './soft-authenticator.js';

// The whole passkey ceremony, end to end: real P-256 keys, real attestation
// and assertion bytes, verified by the production code path.

let t: TestApp;
beforeAll(async () => { t = await startApp(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await resetState(t.app); });

const cookieFrom = (res: request.Response): string =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Host-tv_session='))!.split(';')[0]!;

/** Password step only: no second factor yet. */
async function passwordOnly(u: TestUser): Promise<Session & { mfaRequired: boolean }> {
  const res = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: u.email, password: u.password }).expect(200);
  return { cookie: cookieFrom(res), csrf: res.body.csrfToken, userId: res.body.user.id, mfaRequired: res.body.mfaRequired };
}

/** Register `key` on the account behind `s`. Returns the (possibly upgraded) session. */
async function register(s: Session, key: SoftAuthenticator, overrides: Parameters<SoftAuthenticator['register']>[1] = {}) {
  const options = (await as(t, s).post('/api/auth/mfa/passkeys/register/options').expect(200)).body;
  return as(t, s).post('/api/auth/mfa/passkeys/register', { name: 'Test key', response: key.register(options, overrides) });
}

async function signInWithPasskey(s: Session, key: SoftAuthenticator, overrides: Parameters<SoftAuthenticator['authenticate']>[1] = {}) {
  const options = (await as(t, s).post('/api/auth/mfa/passkeys/options').expect(200)).body;
  return { options, res: await as(t, s).post('/api/auth/mfa/passkeys/verify', { response: key.authenticate(options, overrides) }) };
}

const upgraded = (s: Session, res: request.Response): Session => ({ cookie: cookieFrom(res), csrf: res.body.csrfToken, userId: s.userId });

describe('passkeys, end to end', () => {
  it('an admin with no second factor enrols a passkey, then signs in with it', async () => {
    const admin = await createUser({ email: 'pk-admin@t.io', role: 'ADMIN', mfa: false });
    const key = new SoftAuthenticator({ origin: ORIGIN });

    const first = await passwordOnly(admin);
    expect(first.mfaRequired).toBe(true);
    expect((await as(t, first).get('/api/admin/users')).body.code).toBe('mfa_enrolment_required');

    const reg = await register(first, key);
    expect(reg.status, JSON.stringify(reg.body)).toBe(200);
    expect(reg.body.mfa).toBe(true);
    const enrolled = upgraded(first, reg);
    await as(t, enrolled).get('/api/admin/users').expect(200);
    // The pre-enrolment session token was rotated away.
    expect((await as(t, first).get('/api/admin/users')).status).toBe(401);

    // A fresh sign-in needs the passkey.
    const next = await passwordOnly(admin);
    expect((await as(t, next).get('/api/admin/users')).body.code).toBe('mfa_required');
    const { res } = await signInWithPasskey(next, key);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await as(t, upgraded(next, res)).get('/api/admin/users').expect(200);

    const rows = await auditRows(`actor_id = $1 AND action LIKE 'mfa.passkey_%' AND outcome = 'ALLOWED'`, [admin.id]);
    expect(rows.map((r) => r.action)).toEqual(['mfa.passkey_register', 'mfa.passkey_verify']);
  });

  it('a viewer who adds a passkey must use it from then on', async () => {
    const viewer = await createUser({ email: 'pk-viewer@t.io', role: 'VIEWER' });
    const key = new SoftAuthenticator({ origin: ORIGIN });
    const s = await passwordOnly(viewer);
    expect(s.mfaRequired).toBe(false);
    expect((await register(s, key)).status).toBe(200);

    const next = await passwordOnly(viewer);
    expect(next.mfaRequired).toBe(true);
    expect((await as(t, next).get('/api/documents')).status).toBe(403);
  });

  describe('refusals', () => {
    let admin: TestUser;
    let key: SoftAuthenticator;
    let s: Session;

    beforeEach(async () => {
      admin = await createUser({ email: 'pk-refuse@t.io', role: 'ADMIN', mfa: false });
      key = new SoftAuthenticator({ origin: ORIGIN });
      expect((await register(await passwordOnly(admin), key)).status).toBe(200);
      s = await passwordOnly(admin);
    });

    const denied = async (reason: string) => {
      const rows = await auditRows(`actor_id = $1 AND action = 'mfa.passkey_verify' AND outcome = 'DENIED'`, [admin.id]);
      expect(rows.at(-1)!.reason).toBe(reason);
    };

    it('refuses an assertion made for another website (phishing origin)', async () => {
      const { res } = await signInWithPasskey(s, key, { origin: 'https://vault-login.evil.example' });
      expect(res.status).toBe(401);
      await denied('verification_failed');
      expect((await as(t, s).get('/api/admin/users')).status).toBe(403);
    });

    it('refuses a signature from a different key', async () => {
      const impostor = new SoftAuthenticator({ origin: ORIGIN });
      const { res } = await signInWithPasskey(s, key, { signWith: impostor });
      expect(res.status).toBe(401);
      await denied('verification_failed');
    });

    it('refuses a passkey that is not registered to this account', async () => {
      const stranger = new SoftAuthenticator({ origin: ORIGIN });
      const { res } = await signInWithPasskey(s, stranger);
      expect(res.status).toBe(401);
      await denied('unknown_credential');
    });

    it('refuses a replayed assertion: each challenge works once', async () => {
      const options = (await as(t, s).post('/api/auth/mfa/passkeys/options').expect(200)).body;
      const assertion = key.authenticate(options);
      const ok = await as(t, s).post('/api/auth/mfa/passkeys/verify', { response: assertion });
      expect(ok.status).toBe(200);
      const again = await as(t, upgraded(s, ok)).post('/api/auth/mfa/passkeys/verify', { response: assertion });
      expect(again.status).toBe(400);
    });

    it('refuses a cloned authenticator (signature counter went backwards)', async () => {
      const first = await signInWithPasskey(s, key, { counter: 10 });
      expect(first.res.status).toBe(200);
      const s2 = await passwordOnly(admin);
      const { res } = await signInWithPasskey(s2, key, { counter: 3 });
      expect(res.status).toBe(401);
    });

    it('refuses a challenge issued to a different session', async () => {
      const other = await passwordOnly(admin);
      const options = (await as(t, other).post('/api/auth/mfa/passkeys/options').expect(200)).body;
      const res = await as(t, s).post('/api/auth/mfa/passkeys/verify', { response: key.authenticate(options) });
      expect(res.status).toBe(400);
    });

    it('refuses a passkey that did not verify the user (no PIN or biometric)', async () => {
      const lazy = new SoftAuthenticator({ origin: ORIGIN, skipUserVerification: true });
      // Registration itself is refused for such an authenticator...
      const admin2 = await createUser({ email: 'pk-lazy@t.io', role: 'ADMIN', mfa: false });
      const reg = await register(await passwordOnly(admin2), lazy);
      expect(reg.status).toBe(400);
      const rows = await auditRows(`actor_id = $1 AND action = 'mfa.passkey_register'`, [admin2.id]);
      expect(rows.at(-1)!.outcome).toBe('DENIED');
    });

    it('refuses registration bound to another website', async () => {
      const admin3 = await createUser({ email: 'pk-rp@t.io', role: 'ADMIN', mfa: false });
      const other = new SoftAuthenticator({ origin: ORIGIN });
      const reg = await register(await passwordOnly(admin3), other, { rpId: 'evil.example' });
      expect(reg.status).toBe(400);
    });
  });
});
