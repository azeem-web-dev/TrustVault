import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MailService } from '../src/mail/mail.service.js';
import { SignInLinkService } from '../src/auth/signin-link.service.js';
import { as, auditRows, createUser, login, ORIGIN, ownerDb, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from './helpers.js';

// The shared public demo (THREATS.md I15). Every visitor uses the same
// published accounts, so one visitor must not change what the next one can
// do, and the demo admin login must not become a way to mail strangers.

const settle = () => new Promise((r) => setTimeout(r, 200));
/** Invitation, reset and sign-in-link messages, to anyone. */
const linksSent = (mail: MailService) => mail.outbox.filter((m) => /invited to TrustVault|Reset your TrustVault password|Confirm your TrustVault sign-in/.test(m.subject));

const linkCount = (userId: string, purpose: string) =>
  withDb(ownerDb(), async (db) => (await db.query('SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1 AND purpose = $2', [userId, purpose])).rows[0].n as number);

describe('DEMO_MODE=true', () => {
  let t: TestApp;
  let mail: MailService;
  let admin: TestUser;
  let a: Session;
  beforeAll(async () => {
    t = await startApp({ MAIL_TRANSPORT: 'memory', DEMO_MODE: 'true' });
    mail = t.app.get(MailService);
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => {
    await resetState(t.app);
    admin = await createUser({ email: 'demo-admin@t.io', role: 'ADMIN' });
    a = await login(t, admin);
    await settle(); // the admin's own sign-in notice arrives after the login
    mail.outbox.length = 0;
  });

  it('an invitation is recorded in the audit log but not sent, and no link exists', async () => {
    const res = await as(t, a).post('/api/admin/users', { email: 'stranger@elsewhere.io', role: 'VIEWER' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.invited).toBe(false);
    await settle();
    expect(linksSent(mail)).toEqual([]);
    expect(mail.outbox.filter((m) => m.to !== admin.email)).toEqual([]);
    expect(await linkCount(res.body.user.id, 'INVITE')).toBe(0);
    const rows = await auditRows(`action = 'user.invite' AND target_id = $1`, [res.body.user.id]);
    expect(rows.at(-1)).toMatchObject({ outcome: 'DENIED', reason: 'demo_mode', details: expect.objectContaining({ email: 'stranger@elsewhere.io', notSent: true }) });
  });

  it('a password reset link (asked for by the person or sent by an admin) is recorded but not sent', async () => {
    const viewer = await createUser({ email: 'demo-viewer@t.io', role: 'VIEWER' });
    await t.http.post('/api/auth/password/forgot').set('Origin', ORIGIN).send({ email: viewer.email }).expect(202);
    const sent = await as(t, a).post(`/api/admin/users/${viewer.id}/reset-link`).expect(202);
    expect(sent.body.sent).toBe(false);
    await settle();
    expect(linksSent(mail)).toEqual([]);
    expect(mail.outbox.filter((m) => m.to !== admin.email)).toEqual([]);
    expect(await linkCount(viewer.id, 'RESET')).toBe(0);
    expect((await auditRows(`action = 'auth.reset_requested' AND target_id = $1`, [viewer.id])).at(-1)).toMatchObject({ outcome: 'DENIED', reason: 'demo_mode' });
    expect((await auditRows(`action = 'user.reset_link_sent' AND target_id = $1`, [viewer.id])).at(-1)).toMatchObject({ outcome: 'DENIED', reason: 'demo_mode' });
  });

  it('a sign-in link is never made or sent; the reason the caller records says why', async () => {
    const viewer = await createUser({ email: 'demo-link@t.io', role: 'VIEWER' });
    const reason = await t.app.get(SignInLinkService).offer({ id: viewer.id, email: viewer.email, displayName: 'V', isProtected: false }, '203.0.113.5');
    expect(reason).toBe('stepup_link_demo_mode');
    await settle();
    expect(linksSent(mail)).toEqual([]);
    expect(mail.outbox.filter((m) => m.to !== admin.email)).toEqual([]);
    expect(await linkCount(viewer.id, 'SIGNIN')).toBe(0);
  });

  it('refuses an MFA policy covering non-admin roles with a clear 403, and records it', async () => {
    const res = await as(t, a).put('/api/admin/settings/mfa-policy', { requiredRoles: ['ADMIN', 'VIEWER'] });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'demo_mode', message: expect.stringContaining('shared public demo') });
    expect((await as(t, a).get('/api/admin/settings/mfa-policy').expect(200)).body).toEqual({ requiredRoles: ['ADMIN'] });
    expect((await auditRows(`actor_id = $1 AND action = 'settings.mfa_policy'`, [admin.id])).at(-1)).toMatchObject({ outcome: 'DENIED', reason: 'demo_mode' });
    // ADMIN only is still a valid answer.
    await as(t, a).put('/api/admin/settings/mfa-policy', { requiredRoles: ['ADMIN'] }).expect(200);
  });

  it('refuses role-wide time or network rules with a clear 403, and records it', async () => {
    for (const body of [{ networks: ['10.0.0.0/8'] }, { window: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', timeZone: 'Europe/London' } }]) {
      const res = await as(t, a).put('/api/admin/access-policies/VIEWER', body);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.code).toBe('demo_mode');
    }
    expect((await as(t, a).get('/api/admin/access-policies').expect(200)).body.policies).toEqual([]);
    expect((await auditRows(`actor_id = $1 AND action = 'policy.role_set'`, [admin.id])).at(-1)).toMatchObject({ outcome: 'DENIED', reason: 'demo_mode' });
  });
});

describe('invitation limits', () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp({ MAIL_TRANSPORT: 'memory', INVITE_LIMIT_PER_ADMIN: '2', INVITE_LIMIT_GLOBAL: '3' }); });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetState(t.app); });

  const exists = (email: string) => withDb(ownerDb(), async (db) => (await db.query('SELECT 1 FROM users WHERE email = $1', [email])).rowCount === 1);

  it('per admin: the next invitation is refused (429) before any account is made, and recorded', async () => {
    const admin = await createUser({ email: 'lim-admin@t.io', role: 'ADMIN' });
    const a = await login(t, admin);
    await as(t, a).post('/api/admin/users', { email: 'n1@t.io', role: 'VIEWER' }).expect(201);
    const second = await as(t, a).post('/api/admin/users', { email: 'n2@t.io', role: 'VIEWER' }).expect(201);
    expect((await as(t, a).post('/api/admin/users', { email: 'n3@t.io', role: 'VIEWER' })).status).toBe(429);
    expect(await exists('n3@t.io')).toBe(false);
    // Sending one again counts too.
    expect((await as(t, a).post(`/api/admin/users/${second.body.user.id}/invite`)).status).toBe(429);
    expect((await auditRows(`actor_id = $1 AND action = 'user.invite' AND reason = 'rate_limited'`, [admin.id])).length).toBe(2);
  });

  it('globally: a second admin is refused once all admins together reach the limit', async () => {
    const [x, y] = await Promise.all([createUser({ email: 'lim-x@t.io', role: 'ADMIN' }), createUser({ email: 'lim-y@t.io', role: 'ADMIN' })]);
    const X = await login(t, x);
    const Y = await login(t, y);
    await as(t, X).post('/api/admin/users', { email: 'g1@t.io', role: 'VIEWER' }).expect(201);
    await as(t, X).post('/api/admin/users', { email: 'g2@t.io', role: 'VIEWER' }).expect(201);
    await as(t, Y).post('/api/admin/users', { email: 'g3@t.io', role: 'VIEWER' }).expect(201);
    expect((await as(t, Y).post('/api/admin/users', { email: 'g4@t.io', role: 'VIEWER' })).status).toBe(429);
    expect(await exists('g4@t.io')).toBe(false);
  });
});
