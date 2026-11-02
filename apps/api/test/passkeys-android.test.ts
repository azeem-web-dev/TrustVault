import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createUser, ORIGIN, resetState, startApp, type Session, type TestApp } from './helpers.js';
import { SoftAuthenticator } from './soft-authenticator.js';

// A passkey ceremony from the Android app reports the app's signing-key
// origin instead of the web origin (THREATS.md S21). It is accepted only
// when that exact origin is configured.

const APP = 'android:apk-key-hash:Qgex5O_nGWmpGPUfNP8nxr6Qlz9SUw75xHSb2AJpR4g';
const OTHER_APP = 'android:apk-key-hash:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const cookieFrom = (res: request.Response): string =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Host-tv_session='))!.split(';')[0]!;

async function passwordOnly(t: TestApp, email: string, password: string): Promise<Session> {
  const res = await t.http.post('/api/auth/login').send({ email, password }).expect(200);
  return { cookie: cookieFrom(res), csrf: res.body.csrfToken, userId: res.body.user.id };
}

describe('passkeys from the Android app', () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp({ PASSKEY_ANDROID_ORIGINS: APP }); });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetState(t.app); });

  const registerWith = async (s: Session, key: SoftAuthenticator) => {
    const options = (await as(t, s).post('/api/auth/mfa/passkeys/register/options').expect(200)).body;
    return as(t, s).post('/api/auth/mfa/passkeys/register', { name: 'Phone', response: key.register(options) });
  };

  it('registers and signs in with the app origin; a passkey made on the web works in the app', async () => {
    const admin = await createUser({ email: 'and-admin@t.io', role: 'ADMIN', mfa: false });
    const web = new SoftAuthenticator({ origin: ORIGIN });
    expect((await registerWith(await passwordOnly(t, admin.email, admin.password), web)).status).toBe(200);

    const s = await passwordOnly(t, admin.email, admin.password);
    const options = (await as(t, s).post('/api/auth/mfa/passkeys/options').expect(200)).body;
    expect(options.rpId).toBe('vault.test');
    const res = await as(t, s).post('/api/auth/mfa/passkeys/verify', { response: web.authenticate(options, { origin: APP }) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const phone = new SoftAuthenticator({ origin: APP });
    const v = await createUser({ email: 'and-viewer@t.io', role: 'VIEWER' });
    expect((await registerWith(await passwordOnly(t, v.email, v.password), phone)).status).toBe(200);
  });

  it('refuses an app signed with a different key', async () => {
    const admin = await createUser({ email: 'and-other@t.io', role: 'ADMIN', mfa: false });
    const key = new SoftAuthenticator({ origin: OTHER_APP });
    expect((await registerWith(await passwordOnly(t, admin.email, admin.password), key)).status).toBe(400);
  });
});

describe('without PASSKEY_ANDROID_ORIGINS', () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp(); });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetState(t.app); });

  it('the app origin is refused', async () => {
    const admin = await createUser({ email: 'and-off@t.io', role: 'ADMIN', mfa: false });
    const s = await passwordOnly(t, admin.email, admin.password);
    const options = (await as(t, s).post('/api/auth/mfa/passkeys/register/options').expect(200)).body;
    const res = await as(t, s).post('/api/auth/mfa/passkeys/register', { name: 'Phone', response: new SoftAuthenticator({ origin: APP }).register(options) });
    expect(res.status).toBe(400);
  });
});
