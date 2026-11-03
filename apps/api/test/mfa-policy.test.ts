import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, auditRows, appDb, createUser, login, ORIGIN, ownerDb, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from './helpers.js';

// Per-role second-factor policy (THREATS.md S21). ADMIN is always covered;
// an admin chooses which of OWNER, VIEWER and EXTERNAL are too.

let t: TestApp;
beforeAll(async () => { t = await startApp(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await resetState(t.app); });

const cookieFrom = (res: request.Response): string =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Host-tv_session='))!.split(';')[0]!;

const ageFactor = (userId: string, minutes: number) =>
  withDb(ownerDb(), (db) => db.query(`UPDATE sessions SET mfa_verified_at = now() - $2::float8 * interval '1 minute' WHERE user_id = $1`, [userId, minutes]));

describe('MFA policy', () => {
  let admin: TestUser;
  let a: Session;
  beforeEach(async () => {
    admin = await createUser({ email: 'pol-admin@t.io', role: 'ADMIN' });
    a = await login(t, admin);
  });

  it('starts as ADMIN only', async () => {
    expect((await as(t, a).get('/api/admin/settings/mfa-policy').expect(200)).body).toEqual({ requiredRoles: ['ADMIN'] });
  });

  it('adding a role forces its password-only sessions to enrol at once, and new sign-ins too', async () => {
    const viewer = await createUser({ email: 'pol-viewer@t.io', role: 'VIEWER' });
    const v = await login(t, viewer);
    await as(t, v).get('/api/documents').expect(200);

    const put = await as(t, a).put('/api/admin/settings/mfa-policy', { requiredRoles: ['VIEWER', 'ADMIN'] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.requiredRoles).toEqual(['ADMIN', 'VIEWER']);

    // The existing session, on its very next request.
    const blocked = await as(t, v).get('/api/documents');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('mfa_enrolment_required');
    expect((await as(t, v).get('/api/auth/me').expect(200)).body).toMatchObject({ mfaRequired: true, mfaSatisfied: false });
    // A new sign-in says so up front.
    const res = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: viewer.email, password: viewer.password }).expect(200);
    expect(res.body.mfaRequired).toBe(true);
    // Owners are not affected.
    const owner = await createUser({ email: 'pol-owner@t.io', role: 'OWNER' });
    await as(t, await login(t, owner)).get('/api/documents').expect(200);

    const rows = await auditRows(`actor_id = $1 AND action = 'settings.mfa_policy'`, [admin.id]);
    expect(rows.at(-1)).toMatchObject({ outcome: 'ALLOWED', details: { from: ['ADMIN'], to: ['ADMIN', 'VIEWER'] } });
  });

  it('a session that already passed a second factor stays valid', async () => {
    const owner = await createUser({ email: 'pol-mfa-owner@t.io', role: 'OWNER', mfa: true });
    const o = await login(t, owner);
    await as(t, a).put('/api/admin/settings/mfa-policy', { requiredRoles: ['ADMIN', 'OWNER'] }).expect(200);
    await as(t, o).get('/api/documents').expect(200);
  });

  it('a covered role cannot remove its last factor', async () => {
    const owner = await createUser({ email: 'pol-last@t.io', role: 'OWNER', mfa: true });
    const o = await login(t, owner);
    await as(t, a).put('/api/admin/settings/mfa-policy', { requiredRoles: ['ADMIN', 'OWNER'] }).expect(200);
    const res = await as(t, o).delete('/api/auth/mfa/totp');
    expect(res.status).toBe(400);
    // Not covered any more: now it may.
    await as(t, a).put('/api/admin/settings/mfa-policy', { requiredRoles: ['ADMIN'] }).expect(200);
    await as(t, o).delete('/api/auth/mfa/totp').expect(204);
    expect((await auditRows(`actor_id = $1 AND action = 'mfa.totp_remove'`, [owner.id])).length).toBe(1);
  });

  it('ADMIN cannot be taken out: not by the API, not by a direct UPDATE', async () => {
    const res = await as(t, a).put('/api/admin/settings/mfa-policy', { requiredRoles: ['OWNER'] });
    expect(res.status).toBe(400);
    // Even in an active admin's own transaction, the CHECK constraint holds.
    const asAdmin = (sql: string) => withDb(appDb(), async (db) => {
      await db.query('BEGIN');
      try {
        await db.query(`SELECT set_config('app.user_id', $1, true)`, [admin.id]);
        await db.query(sql);
      } finally { await db.query('ROLLBACK'); }
    });
    await expect(asAdmin(`UPDATE app_settings SET mfa_required_roles = '{OWNER}'`)).rejects.toThrow(/app_settings_admin_needs_mfa/);
    // Outside an admin's transaction the row cannot be touched at all.
    await expect(withDb(appDb(), (db) => db.query(`UPDATE app_settings SET mfa_required_roles = '{ADMIN,OWNER}'`))).rejects.toThrow(/changed only by an administrator/);
    await expect(withDb(appDb(), (db) => db.query(`DELETE FROM app_settings`))).rejects.toThrow(/permission denied/);
    expect((await as(t, a).get('/api/admin/settings/mfa-policy')).body.requiredRoles).toEqual(['ADMIN']);
  });

  it('only admins may read or change it, and the refusal is audited', async () => {
    const owner = await createUser({ email: 'pol-nope@t.io', role: 'OWNER' });
    const o = await login(t, owner);
    await as(t, o).get('/api/admin/settings/mfa-policy').expect(403);
    await as(t, o).put('/api/admin/settings/mfa-policy', { requiredRoles: ['ADMIN'] }).expect(403);
    const rows = await auditRows(`actor_id = $1 AND action = 'security.role'`, [owner.id]);
    expect(rows.length).toBe(2);
  });

  it('changing it needs a fresh second factor', async () => {
    await ageFactor(admin.id, 10);
    const res = await as(t, a).put('/api/admin/settings/mfa-policy', { requiredRoles: ['ADMIN', 'EXTERNAL'] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('step_up_required');
    expect((await as(t, a).get('/api/admin/settings/mfa-policy')).body.requiredRoles).toEqual(['ADMIN']);
  });

  it('rejects unknown roles', async () => {
    await as(t, a).put('/api/admin/settings/mfa-policy', { requiredRoles: ['ADMIN', 'ROOT'] }).expect(400);
  });

  it('GET /auth/mfa tells the user their role requires a factor', async () => {
    const ext = await createUser({ email: 'pol-ext@t.io', role: 'EXTERNAL' });
    await as(t, a).put('/api/admin/settings/mfa-policy', { requiredRoles: ['ADMIN', 'EXTERNAL'] }).expect(200);
    const res = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: ext.email, password: ext.password }).expect(200);
    const e = { cookie: cookieFrom(res), csrf: res.body.csrfToken, userId: ext.id };
    expect((await as(t, e).get('/api/auth/mfa').expect(200)).body).toMatchObject({ required: true, requiredByRole: true, satisfied: false });
  });
});
