import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { currentStep, totpAt } from '../src/auth/totp.js';
import { as, auditRows, createUser, login, ORIGIN, ownerDb, PDF, resetState, startApp, withDb, type TestApp } from './helpers.js';

let t: TestApp;
const VERIFIER = resolve(__dirname, '../../../tools/verify-audit.mjs');

beforeAll(async () => {
  t = await startApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t.app);
});

const cookieOf = (res: { headers: Record<string, unknown> }) =>
  ([] as string[]).concat((res.headers['set-cookie'] as string[]) ?? []).find((c) => c.startsWith('__Host-tv_session='))!.split(';')[0]!;

describe('second factor', () => {
  it('an admin with only a password reaches nothing but the sign-in routes', async () => {
    const adm = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const res = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: adm.email, password: adm.password });
    expect(res.body.mfaRequired).toBe(true);
    const s = { cookie: cookieOf(res), csrf: res.body.csrfToken, userId: adm.id };
    const blocked = await as(t, s).get('/api/admin/users');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('mfa_required');
    await as(t, s).get('/api/documents').expect(403);
    await as(t, s).get('/api/auth/me').expect(200); // partial routes still work
  });

  it('an admin who never enrolled must enrol first', async () => {
    const adm = await createUser({ email: 'new-adm@t.io', role: 'ADMIN', mfa: false });
    const s = await login(t, adm);
    const blocked = await as(t, s).get('/api/admin/users');
    expect(blocked.body.code).toBe('mfa_enrolment_required');
    const setup = await as(t, s).post('/api/auth/mfa/totp/setup').expect(200);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const secret = Buffer.from(base32ToHex(setup.body.secret), 'hex');
    const enabled = await as(t, s).post('/api/auth/mfa/totp/enable', { code: totpAt(secret, currentStep()) }).expect(200);
    const upgraded = { cookie: cookieOf(enabled), csrf: enabled.body.csrfToken, userId: adm.id };
    await as(t, upgraded).get('/api/admin/users').expect(200);
    // The password-only session token no longer works at all.
    await as(t, s).get('/api/auth/me').expect(401);
  });

  it('a wrong code is refused and audited; a used code cannot be replayed', async () => {
    const adm = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const login1 = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: adm.email, password: adm.password });
    const s = { cookie: cookieOf(login1), csrf: login1.body.csrfToken, userId: adm.id };
    const bad = await as(t, s).post('/api/auth/mfa/totp/verify', { code: '000000' });
    expect(bad.status).toBe(401);
    const code = totpAt(adm.totpSecret!, currentStep());
    await as(t, s).post('/api/auth/mfa/totp/verify', { code }).expect(200);
    // Same code, new password session: refused as a replay.
    const login2 = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: adm.email, password: adm.password });
    const s2 = { cookie: cookieOf(login2), csrf: login2.body.csrfToken, userId: adm.id };
    await as(t, s2).post('/api/auth/mfa/totp/verify', { code }).expect(401);
    const reasons = (await auditRows(`actor_id = $1 AND action = 'mfa.totp_verify' AND outcome = 'DENIED'`, [adm.id])).map((r) => r.reason);
    expect(reasons).toEqual(expect.arrayContaining(['wrong_code', 'code_replayed']));
  });

  it('guessing codes is rate limited', async () => {
    const adm = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const r = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: adm.email, password: adm.password });
    const s = { cookie: cookieOf(r), csrf: r.body.csrfToken, userId: adm.id };
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await as(t, s).post('/api/auth/mfa/totp/verify', { code: String(100000 + i) })).status;
    expect(last).toBe(429);
  });

  it('an owner without a second factor is not forced to have one', async () => {
    const o = await createUser({ email: 'o@t.io', role: 'OWNER' });
    const s = await login(t, o);
    await as(t, s).get('/api/documents').expect(200);
  });
});

describe('protected demo accounts', () => {
  it('cannot be deactivated, demoted, have their password or MFA reset, or change their own password', async () => {
    const adm = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const demo = await createUser({ email: 'demo@t.io', role: 'VIEWER' });
    await withDb(ownerDb(), (db) => db.query('UPDATE users SET is_protected = true WHERE id = $1', [demo.id]));
    const a = await login(t, adm);
    await as(t, a).post(`/api/admin/users/${demo.id}/deactivate`).expect(403);
    await as(t, a).patch(`/api/admin/users/${demo.id}`, { role: 'OWNER' }).expect(403);
    await as(t, a).post(`/api/admin/users/${demo.id}/mfa/reset`).expect(403);
    const d = await login(t, demo);
    await as(t, d).post('/api/auth/password', { currentPassword: demo.password, newPassword: 'another-long-password' }).expect(403);
  });
});

describe('admin audit view', () => {
  async function activity() {
    const o = await createUser({ email: 'o@t.io', role: 'OWNER' });
    const v = await createUser({ email: 'v@t.io', role: 'VIEWER' });
    const adm = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const [so, sv, sa] = await Promise.all([login(t, o), login(t, v), login(t, adm)]);
    const doc = (await as(t, so).upload('/api/documents', PDF, 'a.pdf', { title: 'Audit me', category: 'Audit' })).body.id as string;
    const g = await as(t, so).put(`/api/documents/${doc}/access`, { userId: v.id, level: 'READ' });
    await as(t, sv).get(`/api/documents/${doc}/download`).expect(200);
    await as(t, so).delete(`/api/documents/${doc}/access/${g.body.id}`).expect(200);
    await as(t, sv).get(`/api/documents/${doc}/download`).expect(404);
    return { sa, doc, v };
  }

  it('lists document activity and permission changes, with document titles', async () => {
    const { sa, doc } = await activity();
    const res = await as(t, sa).get(`/api/admin/audit?documentId=${doc}`).expect(200);
    const actions = res.body.events.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['document.upload', 'access.grant', 'document.download', 'access.revoke']));
    expect(res.body.events[0].documentTitle).toBe('Audit me');
  });

  it('flags an attempt to reach a document after access was revoked', async () => {
    const { sa } = await activity();
    const res = await as(t, sa).get('/api/admin/alerts').expect(200);
    const alert = res.body.alerts.find((a: { kind: string }) => a.kind === 'access_after_revoke');
    expect(alert?.message).toContain('v@t.io');
  });

  it('verifies the chain and signed checkpoints', async () => {
    const { sa } = await activity();
    await as(t, sa).post('/api/admin/audit/checkpoint').expect(200);
    const res = await as(t, sa).post('/api/admin/audit/verify').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.checkpointsChecked).toBeGreaterThan(0);
  });

  it('exports a bundle the offline tool verifies — and the tool catches an edited event', async () => {
    const { sa } = await activity();
    await as(t, sa).post('/api/admin/audit/checkpoint').expect(200);
    const res = await as(t, sa).get('/api/admin/audit/export?fromSeq=1').buffer(true);
    const bundle = JSON.parse(res.text);
    const dir = mkdtempSync(join(tmpdir(), 'tv-'));
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify(bundle));
    let out = '';
    try {
      out = execFileSync(process.execPath, [VERIFIER, good, bundle.signingKey.publicKey]).toString();
    } catch (err) {
      out = String((err as { stdout: Buffer }).stdout);
    }
    expect(out).toContain('INTACT');

    bundle.events[Math.floor(bundle.events.length / 2)].actor_email = 'someone-else@t.io';
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify(bundle));
    let failed = false;
    try {
      execFileSync(process.execPath, [VERIFIER, bad]);
    } catch (err) {
      failed = true;
      expect(String((err as { stdout: Buffer }).stdout)).toContain('TAMPERED');
    }
    expect(failed).toBe(true);
  });

  it('non-admins cannot read the audit log, alerts or export', async () => {
    const o = await createUser({ email: 'o@t.io', role: 'OWNER' });
    const s = await login(t, o);
    await as(t, s).get('/api/admin/audit').expect(403);
    await as(t, s).get('/api/admin/alerts').expect(403);
    await as(t, s).get('/api/admin/audit/export').expect(403);
    await as(t, s).post('/api/admin/audit/verify').expect(403);
  });
});

function base32ToHex(b32: string): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of b32) bits += A.indexOf(c).toString(2).padStart(5, '0');
  let hex = '';
  for (let i = 0; i + 8 <= bits.length; i += 8) hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, '0');
  return hex;
}
