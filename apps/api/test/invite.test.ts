import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MailService } from '../src/mail/mail.service.js';
import { ENV, type Env } from '../src/config/env.js';
import { as, auditRows, createUser, login, ORIGIN, ownerDb, PDF, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from './helpers.js';

// Accounts are created by invitation (THREATS.md S18): the admin gives an
// email, a role and maybe an end date; the person chooses their own name and
// password from an emailed link. MAIL_TRANSPORT=memory: nothing is sent.

let t: TestApp;
let mail: MailService;
let alice: TestUser, admin: TestUser;
let A: Session, ADM: Session;

beforeAll(async () => {
  t = await startApp({ MAIL_TRANSPORT: 'memory' });
  mail = t.app.get(MailService);
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t.app);
  alice = await createUser({ email: 'alice@t.io', role: 'OWNER' });
  admin = await createUser({ email: 'admin@t.io', role: 'ADMIN' });
  [A, ADM] = await Promise.all([login(t, alice), login(t, admin)]);
  await settle();
  mail.outbox.length = 0;
});

const PW = 'my-own-chosen-password';
const invite = (body: object, headers: Record<string, string> = {}) => {
  let r = as(t, ADM).post('/api/admin/users', body);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r;
};
const accept = (token: string, displayName = 'Nina New', password = PW) =>
  t.http.post('/api/auth/invite/accept').set('Origin', ORIGIN).send({ token, displayName, password });
const check = (token: string) => t.http.post('/api/auth/invite/check').set('Origin', ORIGIN).send({ token });
const resetWith = (token: string) => t.http.post('/api/auth/password/reset').set('Origin', ORIGIN).send({ token, newPassword: 'a-completely-new-password' });
const sentTo = (email: string) => mail.outbox.filter((m) => m.to === email);
const invites = (email: string) => sentTo(email).filter((m) => /invited/i.test(m.subject));
const tokenIn = (text: string, path = 'invite') => new RegExp(`/${path}#token=([A-Za-z0-9_-]+)`).exec(text)?.[1] ?? null;
const lastInvite = (email: string) => tokenIn(invites(email).at(-1)!.text)!;
const dbNow = () => withDb(ownerDb(), async (db) => (await db.query('SELECT now() AS t')).rows[0].t as Date);
const settle = () => new Promise((r) => setTimeout(r, 150));
const outcomes = async (action: string, since: Date) =>
  (await auditRows(`action = $1 AND occurred_at >= $2`, [action, since])).map((r) => `${r.outcome}:${r.reason ?? ''}`);

describe('an admin invites; nobody but the person chooses the password', () => {
  it('creates an INVITED account and emails a one-time link; no password is involved', async () => {
    const since = await dbNow();
    const r = await invite({ email: 'Nina@T.io', role: 'VIEWER' }).expect(201);
    expect(r.body.invited).toBe(true);
    expect(r.body.user).toMatchObject({ email: 'nina@t.io', role: 'VIEWER', status: 'INVITED', displayName: 'nina', activatedAt: null });
    expect(JSON.stringify(r.body)).not.toMatch(/token|password/i);
    const m = invites('nina@t.io');
    expect(m).toHaveLength(1);
    expect(m[0]!.subject).toBe("You've been invited to TrustVault");
    expect(m[0]!.text).toContain('https://vault.test/invite#token=');
    expect(m[0]!.text).toMatch(/as a viewer/);
    expect(m[0]!.text).toMatch(/works once and expires in 72 hours/);
    expect(await outcomes('user.create', since)).toEqual(['ALLOWED:']);
    expect((await auditRows(`action = 'user.invite' AND occurred_at >= $1`, [since]))[0]).toMatchObject({ outcome: 'ALLOWED', actor_id: admin.id, target_id: r.body.user.id });
  });

  it('builds the link from the configured site, never from the Host header', async () => {
    await invite({ email: 'nina@t.io', role: 'VIEWER' }, { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example' }).expect(201);
    const m = invites('nina@t.io')[0]!;
    expect(m.text).toContain('https://vault.test/invite#token=');
    expect(m.text + m.html).not.toContain('evil.example');
  });

  it('only a hash of the link is stored, marked as an invitation', async () => {
    await invite({ email: 'nina@t.io', role: 'VIEWER' }).expect(201);
    const token = lastInvite('nina@t.io');
    const rows = await withDb(ownerDb(), async (db) => (await db.query(`SELECT encode(token_hash, 'hex') AS h, purpose FROM password_reset_tokens`)).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe('INVITE');
    expect(rows[0].h).not.toContain(Buffer.from(token).toString('hex'));
    expect(rows[0].h).toHaveLength(64);
  });

  it('external invitations still need a future end date, and mention it', async () => {
    await invite({ email: 'ext@p.io', role: 'EXTERNAL' }).expect(400);
    const until = new Date(Date.now() + 7 * 86_400_000);
    await invite({ email: 'ext@p.io', role: 'EXTERNAL', accessExpiresAt: until.toISOString() }).expect(201);
    expect(invites('ext@p.io')[0]!.text).toMatch(/Your access ends/);
  });

  it('non-admins cannot invite, and a duplicate email is refused', async () => {
    await as(t, A).post('/api/admin/users', { email: 'nina@t.io', role: 'VIEWER' }).expect(403);
    expect(mail.outbox).toHaveLength(0);
    await invite({ email: 'alice@t.io', role: 'VIEWER' }).expect(409);
  });

  it('says invited: false when mail is off, and the account still waits', async () => {
    const env = t.app.get<Env>(ENV);
    env.MAIL_TRANSPORT = 'off';
    try {
      const r = await invite({ email: 'quiet@t.io', role: 'VIEWER' }).expect(201);
      expect(r.body).toMatchObject({ invited: false, user: { status: 'INVITED' } });
      expect((await auditRows(`action = 'user.invite' AND target_id = $1`, [r.body.user.id]))[0]).toMatchObject({ outcome: 'DENIED', reason: 'mail_off' });
      expect(await withDb(ownerDb(), async (db) => (await db.query('SELECT count(*)::int AS n FROM password_reset_tokens')).rows[0].n)).toBe(0);
    } finally {
      env.MAIL_TRANSPORT = 'memory';
    }
  });
});

describe('an invited account can do nothing until it is accepted', () => {
  it('cannot sign in (audited as not activated, same message as any failure) and cannot be shared with or grouped', async () => {
    const r = await invite({ email: 'nina@t.io', role: 'VIEWER' }).expect(201);
    const id = r.body.user.id as string;
    const since = await dbNow();
    const res = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'nina@t.io', password: PW }).expect(401);
    expect(res.body.message).toBe('Invalid email or password');
    expect(await outcomes('auth.login', since)).toEqual(['DENIED:account_not_activated']);
    const up = await as(t, A).upload('/api/documents', PDF, 'a.pdf', { title: 'Plan', category: 'Ops' }).expect(201);
    await as(t, A).put(`/api/documents/${up.body.id}/access`, { userId: id, level: 'READ' }).expect(400);
    const g = await as(t, ADM).post('/api/admin/groups', { name: 'Team' }).expect(201);
    await as(t, ADM).post(`/api/admin/groups/${g.body.id}/members`, { userId: id }).expect(400);
    // Forgot-password does not work either: the invitation is the way in.
    await t.http.post('/api/auth/password/forgot').set('Origin', ORIGIN).send({ email: 'nina@t.io' }).expect(202);
    expect(sentTo('nina@t.io').filter((m) => /reset/i.test(m.subject))).toHaveLength(0);
  });

  it('an admin cannot set an invited person’s password or send them a reset link', async () => {
    const r = await invite({ email: 'nina@t.io', role: 'VIEWER' }).expect(201);
    await as(t, ADM).post(`/api/admin/users/${r.body.user.id}/password`, { password: 'admin-chosen-password' }).expect(404); // no such route at all
    await as(t, ADM).post(`/api/admin/users/${r.body.user.id}/reset-link`).expect(400);
  });
});

describe('accepting an invitation', () => {
  it('works once: sets the chosen name and password, activates the account, and the person signs in', async () => {
    const r = await invite({ email: 'nina@t.io', role: 'OWNER' }).expect(201);
    const token = lastInvite('nina@t.io');
    const shown = await check(token).expect(200);
    expect(shown.body).toMatchObject({ email: 'nina@t.io', role: 'OWNER' });
    const since = await dbNow();
    await accept(token, '  Nina New  ').expect(204);
    const users = (await as(t, ADM).get('/api/admin/users')).body.users as { id: string; status: string; displayName: string; activatedAt: string | null }[];
    expect(users.find((u) => u.id === r.body.user.id)).toMatchObject({ status: 'ACTIVE', displayName: 'Nina New' });
    expect(users.find((u) => u.id === r.body.user.id)!.activatedAt).not.toBeNull();
    const N = await login(t, { email: 'nina@t.io', password: PW });
    expect((await as(t, N).get('/api/auth/me')).body.user).toMatchObject({ displayName: 'Nina New', role: 'OWNER' });
    await settle();
    expect(sentTo('nina@t.io').some((m) => /account is ready/i.test(m.subject))).toBe(true);
    // Used once: never again, and the check says so too.
    await accept(token, 'Someone Else', 'another-password-123').expect(400);
    await check(token).expect(400);
    expect(await outcomes('auth.invite_accepted', since)).toEqual(['ALLOWED:', 'DENIED:link_used']);
  });

  it('a new admin must set up a second factor at first sign-in', async () => {
    await invite({ email: 'boss@t.io', role: 'ADMIN' }).expect(201);
    expect(invites('boss@t.io')[0]!.text).toMatch(/second factor/);
    await accept(lastInvite('boss@t.io'), 'Boss').expect(204);
    const res = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'boss@t.io', password: PW }).expect(200);
    expect(res.body).toMatchObject({ mfaRequired: true, mfaEnrolled: false });
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Host-tv_session='))!.split(';')[0]!;
    const blocked = await t.http.get('/api/admin/users').set('Cookie', cookie).expect(403);
    expect(blocked.body.code).toBe('mfa_enrolment_required');
  });

  it('a weak password or empty name is refused without spending the link', async () => {
    await invite({ email: 'nina@t.io', role: 'VIEWER' }).expect(201);
    const token = lastInvite('nina@t.io');
    await accept(token, 'Nina', 'short').expect(400);
    await accept(token, '   ').expect(400);
    await accept(token).expect(204);
  });

  it('a link for an account that is no longer waiting is refused', async () => {
    await invite({ email: 'nina@t.io', role: 'VIEWER' }).expect(201);
    const token = lastInvite('nina@t.io');
    // Deactivated behind the app's back, so the link itself is still unused.
    await withDb(ownerDb(), (db) => db.query(`UPDATE users SET status = 'DEACTIVATED', deactivated_at = now() WHERE email = 'nina@t.io'`));
    const since = await dbNow();
    await accept(token).expect(400);
    expect(await outcomes('auth.invite_accepted', since)).toEqual(['DENIED:not_eligible']);
  });

  it('an expired link is refused and recorded', async () => {
    await invite({ email: 'nina@t.io', role: 'VIEWER' }).expect(201);
    const token = lastInvite('nina@t.io');
    await withDb(ownerDb(), (db) => db.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'`));
    const since = await dbNow();
    await accept(token).expect(400);
    expect(await outcomes('auth.invite_accepted', since)).toEqual(['DENIED:link_expired']);
  });

  it('a made-up or malformed link is refused and recorded', async () => {
    const since = await dbNow();
    await accept('x'.repeat(43)).expect(400);
    await accept('../../etc').expect(400);
    await check('y'.repeat(43)).expect(400);
    expect(await outcomes('auth.invite_accepted', since)).toEqual(['DENIED:unknown_link', 'DENIED:malformed_link']);
    expect(await outcomes('auth.invite_check', since)).toEqual(['DENIED:unknown_link']);
  });

  it('a reset link is not an invitation, and an invitation is not a reset link', async () => {
    await invite({ email: 'nina@t.io', role: 'VIEWER' }).expect(201);
    const inviteToken = lastInvite('nina@t.io');
    await t.http.post('/api/auth/password/forgot').set('Origin', ORIGIN).send({ email: 'alice@t.io' }).expect(202);
    const resetToken = tokenIn(sentTo('alice@t.io').find((m) => /reset your/i.test(m.subject))!.text, 'reset')!;
    const since = await dbNow();
    await accept(resetToken).expect(400);
    await check(resetToken).expect(400);
    await resetWith(inviteToken).expect(400);
    expect(await outcomes('auth.invite_accepted', since)).toEqual(['DENIED:wrong_link_type']);
    expect(await outcomes('auth.password_reset_link', since)).toEqual(['DENIED:wrong_link_type']);
    // Neither was spent by the wrong use.
    await accept(inviteToken).expect(204);
    await resetWith(resetToken).expect(204);
  });
});

describe('sending again, cancelling and reactivating', () => {
  it('sending again cancels the earlier link', async () => {
    const r = await invite({ email: 'nina@t.io', role: 'VIEWER' }).expect(201);
    const first = lastInvite('nina@t.io');
    const again = await as(t, ADM).post(`/api/admin/users/${r.body.user.id}/invite`).expect(202);
    expect(again.body).toEqual({ ok: true, sent: true });
    const second = lastInvite('nina@t.io');
    expect(second).not.toBe(first);
    await accept(first).expect(400);
    await accept(second).expect(204);
    // Accepted: nothing more to send.
    await as(t, ADM).post(`/api/admin/users/${r.body.user.id}/invite`).expect(400);
    await as(t, A).post(`/api/admin/users/${r.body.user.id}/invite`).expect(403);
  });

  it('deactivating cancels the invitation; reactivating returns it to INVITED, never ACTIVE', async () => {
    const r = await invite({ email: 'nina@t.io', role: 'VIEWER' }).expect(201);
    const id = r.body.user.id as string;
    const token = lastInvite('nina@t.io');
    await as(t, ADM).post(`/api/admin/users/${id}/deactivate`).expect(200);
    await accept(token).expect(400);
    await as(t, ADM).post(`/api/admin/users/${id}/invite`).expect(400);
    const back = await as(t, ADM).post(`/api/admin/users/${id}/reactivate`).expect(200);
    expect(back.body.user.status).toBe('INVITED');
    // The old link stays dead; a new one works.
    await accept(token).expect(400);
    await as(t, ADM).post(`/api/admin/users/${id}/invite`).expect(202);
    await accept(lastInvite('nina@t.io')).expect(204);
  });

  it('an accepted account that is deactivated and reactivated is ACTIVE again', async () => {
    const r = await invite({ email: 'nina@t.io', role: 'VIEWER' }).expect(201);
    await accept(lastInvite('nina@t.io')).expect(204);
    await as(t, ADM).post(`/api/admin/users/${r.body.user.id}/deactivate`).expect(200);
    expect((await as(t, ADM).post(`/api/admin/users/${r.body.user.id}/reactivate`).expect(200)).body.user.status).toBe('ACTIVE');
    await login(t, { email: 'nina@t.io', password: PW });
  });

  it('the database refuses an ACTIVE account that was never activated', async () => {
    const r = await invite({ email: 'nina@t.io', role: 'VIEWER' }).expect(201);
    await expect(withDb(ownerDb(), (db) => db.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [r.body.user.id]))).rejects.toThrow(/users_active_was_activated/);
  });

  it('role and end date can be changed before the invitation is accepted', async () => {
    const r = await invite({ email: 'nina@t.io', role: 'VIEWER' }).expect(201);
    await as(t, ADM).patch(`/api/admin/users/${r.body.user.id}`, { role: 'OWNER' }).expect(200);
    await accept(lastInvite('nina@t.io')).expect(204);
    const N = await login(t, { email: 'nina@t.io', password: PW });
    expect((await as(t, N).get('/api/auth/me')).body.user.role).toBe('OWNER');
  });
});
