import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { currentStep, totpAt } from '../src/auth/totp.js';
import { as, auditRows, createUser, login, ORIGIN, ownerDb, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from './helpers.js';
import { SoftAuthenticator } from './soft-authenticator.js';

// Step-up (THREATS.md S20): risky actions need a second factor presented in
// this session within STEP_UP_MINUTES (5 by default), not just at sign-in.

let t: TestApp;
beforeAll(async () => { t = await startApp(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await resetState(t.app); });

/** Pretend the second factor was presented `minutes` ago in every session of this user. */
const ageFactor = (userId: string, minutes: number) =>
  withDb(ownerDb(), (db) => db.query(`UPDATE sessions SET mfa_verified_at = now() - $2::float8 * interval '1 minute' WHERE user_id = $1`, [userId, minutes]));

/** Lets the next code be accepted again (the login helper used this step's code). */
const forgetLastStep = (userId: string) => withDb(ownerDb(), (db) => db.query('UPDATE users SET totp_last_step = NULL WHERE id = $1', [userId]));

const expectStepUp = (res: request.Response) => {
  expect(res.status, JSON.stringify(res.body)).toBe(403);
  expect(res.body.code).toBe('step_up_required');
};

describe('step-up for risky actions', () => {
  let admin: TestUser;
  let s: Session;
  let other: TestUser;

  beforeEach(async () => {
    admin = await createUser({ email: 'su-admin@t.io', role: 'ADMIN' });
    other = await createUser({ email: 'su-other@t.io', role: 'VIEWER' });
    s = await login(t, admin);
  });

  it('a factor presented at sign-in counts for a few minutes', async () => {
    const res = await as(t, s).post(`/api/admin/users/${other.id}/deactivate`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('a stale factor is refused with step_up_required, audited, and a fresh code lets the same request through', async () => {
    await ageFactor(admin.id, 6);
    const refused = await as(t, s).post(`/api/admin/users/${other.id}/deactivate`);
    expectStepUp(refused);
    const rows = await auditRows(`actor_id = $1 AND action = 'security.step_up_required'`, [admin.id]);
    expect(rows.at(-1)).toMatchObject({ outcome: 'DENIED', reason: 'second_factor_stale' });
    // Nothing happened.
    expect((await as(t, s).get('/api/admin/users')).body.users.find((u: { id: string }) => u.id === other.id).status).toBe('ACTIVE');

    await forgetLastStep(admin.id);
    const ok = await as(t, s).post('/api/auth/mfa/step-up', { code: totpAt(admin.totpSecret!, currentStep()) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // Same cookie and CSRF token: the session is not rotated by a step-up.
    expect(ok.headers['set-cookie']).toBeUndefined();
    await as(t, s).post(`/api/admin/users/${other.id}/deactivate`).expect(200);
    const success = await auditRows(`actor_id = $1 AND action = 'mfa.step_up' AND outcome = 'ALLOWED'`, [admin.id]);
    expect(success.at(-1)!.details).toEqual({ method: 'totp' });
  });

  it('protects every risky route, and nothing else', async () => {
    await ageFactor(admin.id, 6);
    const id = randomUUID();
    const a = as(t, s);
    const risky: [string, () => request.Test][] = [
      ['role change', () => a.patch(`/api/admin/users/${id}`, { role: 'OWNER' })],
      ['extend access window', () => a.patch(`/api/admin/users/${id}`, { accessExpiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString() })],
      ['deactivate', () => a.post(`/api/admin/users/${id}/deactivate`)],
      ['MFA reset', () => a.post(`/api/admin/users/${id}/mfa/reset`)],
      ['ask a second admin', () => a.post('/api/admin/approvals', { action: 'BREAK_GLASS', documentId: id, reason: 'x'.repeat(30) })],
      ['approve a request', () => a.post(`/api/admin/approvals/${id}/approve`)],
      ['reject a request', () => a.post(`/api/admin/approvals/${id}/reject`)],
      ['reset link', () => a.post(`/api/admin/users/${id}/reset-link`)],
      ['break-glass', () => a.post('/api/admin/break-glass', { documentId: id, approvalId: id })],
      ['MFA policy', () => a.put('/api/admin/settings/mfa-policy', { requiredRoles: ['ADMIN', 'OWNER'] })],
      ['access rules for a role', () => a.put('/api/admin/access-policies/VIEWER', { networks: ['10.0.0.0/8'] })],
      ['clear access rules for a role', () => a.delete('/api/admin/access-policies/VIEWER')],
      ['detection thresholds', () => a.put('/api/admin/risk-settings', { values: {}, reason: 'testing step-up' })],
      ['raise a download limit', () => a.post('/api/admin/download-limits/overrides', { userId: id })],
      ['end a raised download limit', () => a.post(`/api/admin/download-limits/overrides/${id}/revoke`)],
      ['remove passkey', () => a.delete(`/api/auth/mfa/passkeys/${id}`)],
      ['remove authenticator', () => a.delete('/api/auth/mfa/totp')],
      ['sign out a device', () => a.delete(`/api/auth/sessions/${id}`)],
      ['sign out other devices', () => a.post('/api/auth/sessions/revoke-others')],
    ];
    for (const [name, call] of risky) {
      const res = await call();
      expect(res.body.code, name).toBe('step_up_required');
    }
    // Ordinary admin work is not interrupted.
    await a.get('/api/admin/users').expect(200);
    await a.patch(`/api/admin/users/${other.id}`, { displayName: 'Renamed' }).expect(200);
    await a.post(`/api/admin/users/${other.id}/reactivate`).expect(200);
    await a.get('/api/auth/sessions').expect(200);
    // Inviting is ordinary admin work too: the account can do nothing until accepted.
    const inv = await a.post('/api/admin/users', { email: 'su-new@t.io', role: 'VIEWER' });
    expect(inv.body.code).not.toBe('step_up_required');
    expect(inv.status).toBe(201);
    expect((await a.post(`/api/admin/users/${inv.body.user.id}/invite`)).body.code).not.toBe('step_up_required');
  });

  it('document owners: transfer and permanent delete need it too', async () => {
    const owner = await createUser({ email: 'su-owner@t.io', role: 'OWNER', mfa: true });
    const o = await login(t, owner);
    await ageFactor(owner.id, 6);
    const id = randomUUID();
    expectStepUp(await as(t, o).post(`/api/documents/${id}/transfer`, { newOwnerId: other.id }));
    expectStepUp(await as(t, o).delete(`/api/documents/${id}`));
    expectStepUp(await as(t, o).post(`/api/documents/${id}/overrides`, { userId: other.id, reason: 'an emergency exception' }));
  });

  it('a used code cannot be replayed for a step-up, and wrong codes are audited and rate limited', async () => {
    await ageFactor(admin.id, 6);
    // The login helper just used the current step's code.
    const used = totpAt(admin.totpSecret!, currentStep());
    expect((await as(t, s).post('/api/auth/mfa/step-up', { code: used })).status).toBe(401);
    expect((await as(t, s).post('/api/auth/mfa/step-up', { code: '000000' })).status).toBe(401);
    const reasons = (await auditRows(`actor_id = $1 AND action = 'mfa.step_up' AND outcome = 'DENIED'`, [admin.id])).map((r) => r.reason);
    expect(reasons).toEqual(['code_replayed', 'wrong_code']);
    let last = 0;
    for (let i = 0; i < 4; i++) last = (await as(t, s).post('/api/auth/mfa/step-up', { code: String(200000 + i) })).status;
    expect(last).toBe(429);
    expectStepUp(await as(t, s).post(`/api/admin/users/${other.id}/deactivate`));
  });

  it('a password-only session cannot step up; it must finish signing in', async () => {
    const res = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: admin.email, password: admin.password });
    const partial = { cookie: ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]!.split(';')[0]!, csrf: res.body.csrfToken, userId: admin.id };
    await forgetLastStep(admin.id);
    const r = await as(t, partial).post('/api/auth/mfa/step-up', { code: totpAt(admin.totpSecret!, currentStep()) });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('mfa_required');
  });

  it('works with a passkey instead of a code', async () => {
    const v = await createUser({ email: 'su-pk@t.io', role: 'VIEWER' });
    const key = new SoftAuthenticator({ origin: ORIGIN });
    const first = await login(t, v);
    const options = (await as(t, first).post('/api/auth/mfa/passkeys/register/options').expect(200)).body;
    const reg = await as(t, first).post('/api/auth/mfa/passkeys/register', { name: 'Key', response: key.register(options) }).expect(200);
    const full = { cookie: ([] as string[]).concat(reg.headers['set-cookie'] ?? [])[0]!.split(';')[0]!, csrf: reg.body.csrfToken, userId: v.id };

    await ageFactor(v.id, 30);
    expectStepUp(await as(t, full).post('/api/auth/sessions/revoke-others'));
    const authOptions = (await as(t, full).post('/api/auth/mfa/passkeys/options').expect(200)).body;
    const r = await as(t, full).post('/api/auth/mfa/step-up', { response: key.authenticate(authOptions) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await as(t, full).post('/api/auth/sessions/revoke-others').expect(200);
    const rows = await auditRows(`actor_id = $1 AND action = 'mfa.step_up' AND outcome = 'ALLOWED'`, [v.id]);
    expect(rows.at(-1)!.details).toMatchObject({ method: 'passkey' });
  });

  it('people with no second factor, and not required to have one, are not blocked', async () => {
    const v = await createUser({ email: 'su-plain@t.io', role: 'VIEWER' });
    const vs = await login(t, v);
    await as(t, vs).post('/api/auth/sessions/revoke-others').expect(200);
  });

  it('the window follows STEP_UP_MINUTES', async () => {
    await ageFactor(admin.id, 4.5);
    await as(t, s).post(`/api/admin/users/${other.id}/deactivate`).expect(200);
    await ageFactor(admin.id, 5.5);
    expectStepUp(await as(t, s).post(`/api/admin/users/${other.id}/mfa/reset`));
  });
});
