import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { currentStep, totpAt } from '../src/auth/totp.js';
import { createUser, ORIGIN, ownerDb, resetState, startApp, withDb, type TestApp, type TestUser } from './helpers.js';

// THREATS.md R9: the password (or second-factor code) is checked outside the
// database transaction, so an admin can reset the password or deactivate the
// account in between. These tests hold the person's row lock in a separate
// transaction, start the sign-in, wait until it is really queued behind that
// lock, then commit the admin's change and let the sign-in continue. A
// session must never come out of it.

let t: TestApp;
beforeAll(async () => { t = await startApp(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await resetState(t.app); });

const open: pg.Client[] = [];
// A failed test must not leave the row locked for the next one.
afterEach(async () => { for (const db of open.splice(0)) { await db.query('ROLLBACK').catch(() => {}); await db.end().catch(() => {}); } });

/** The admin's side: lock the row, run `change`, but do not commit yet. */
async function adminHolding(userId: string, change: string): Promise<{ commit: () => Promise<void> }> {
  const db: pg.Client = ownerDb();
  await db.connect();
  await db.query('BEGIN');
  await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  await db.query(change, [userId]);
  open.push(db);
  return { commit: async () => { await db.query('COMMIT'); await db.end(); open.splice(open.indexOf(db), 1); } };
}

/** Waits until some application query is blocked on a lock. */
async function waitForBlocked(): Promise<void> {
  await withDb(ownerDb(), async (db) => {
    for (let i = 0; i < 200; i++) {
      // pg_locks is readable by every role; pg_stat_activity hides other roles' waits from the owner.
      const r = await db.query(`SELECT 1 FROM pg_locks WHERE NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
      if (r.rowCount) return;
      await new Promise((r2) => setTimeout(r2, 25));
    }
    throw new Error('the sign-in never queued behind the lock');
  });
}

const sessionsOf = (userId: string, level?: string) =>
  withDb(ownerDb(), async (db) => (await db.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ${level ? `AND auth_level = '${level}'` : ''}`, [userId])).rows[0].n as number);

const CHANGES: Record<string, string> = {
  'an admin resets the password': `UPDATE users SET password_hash = 'x-reset', password_changed_at = now() WHERE id = $1`,
  'an admin deactivates the account': `UPDATE users SET status = 'DEACTIVATED', deactivated_at = now() WHERE id = $1`,
};

describe('password step', () => {
  for (const [name, sql] of Object.entries(CHANGES)) {
    it(`no session when ${name} while the person signs in`, async () => {
      const u = await createUser({ email: 'race1@t.io', role: 'VIEWER' });
      const admin = await adminHolding(u.id, sql);
      const pending = t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: u.email, password: u.password }).then((r) => r);
      await waitForBlocked();
      await admin.commit();
      const res = await pending;
      expect(res.status).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await sessionsOf(u.id)).toBe(0);
    });
  }
});

describe('second-factor step', () => {
  let adm: TestUser;
  let partial: { cookie: string; csrf: string };
  beforeEach(async () => {
    adm = await createUser({ email: 'race2@t.io', role: 'ADMIN' });
    const res = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: adm.email, password: adm.password });
    expect(res.status).toBe(200);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-tv_session='))!.split(';')[0]!;
    partial = { cookie, csrf: res.body.csrfToken };
  });

  for (const [name, sql] of Object.entries(CHANGES)) {
    it(`no full session when ${name} before the code is accepted`, async () => {
      const admin = await adminHolding(adm.id, sql);
      const pending = t.http.post('/api/auth/mfa/totp/verify').set('Cookie', partial.cookie).set('Origin', ORIGIN).set('X-CSRF-Token', partial.csrf)
        .send({ code: totpAt(adm.totpSecret!, currentStep()) }).then((r) => r);
      await waitForBlocked();
      await admin.commit();
      const res = await pending;
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('session_required');
      expect(await sessionsOf(adm.id, 'mfa')).toBe(0);
    });
  }

  it('no full session when an admin clears the second factor before the code is accepted', async () => {
    const admin = await adminHolding(adm.id, `UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL WHERE id = $1`);
    const pending = t.http.post('/api/auth/mfa/totp/verify').set('Cookie', partial.cookie).set('Origin', ORIGIN).set('X-CSRF-Token', partial.csrf)
      .send({ code: totpAt(adm.totpSecret!, currentStep()) }).then((r) => r);
    await waitForBlocked();
    await admin.commit();
    const res = await pending;
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await sessionsOf(adm.id, 'mfa')).toBe(0);
  });
});
