import type request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailService } from '../src/mail/mail.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { logger } from '../src/common/logger.js';
import { currentStep, totpAt } from '../src/auth/totp.js';
import { as, auditRows, appDb, createUser, login, ORIGIN, ownerDb, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from './helpers.js';

// Email codes as a second factor (THREATS.md S30): turning them on needs an
// emailed code, signing in can use one, turning them off needs a fresh
// second factor (step-up), and they are never an administrator's factor.

let t: TestApp;
let mail: MailService;
beforeAll(async () => {
  t = await startApp({ MAIL_TRANSPORT: 'memory' });
  mail = t.app.get(MailService);
});
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await resetState(t.app);
  mail.outbox.length = 0;
});
afterEach(() => { vi.restoreAllMocks(); });

const cookieFrom = (res: request.Response): string | undefined =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Host-tv_session='))?.split(';')[0];

/** The newest code emailed to this address. */
const lastCode = (email: string): string => {
  const m = mail.outbox.filter((x) => x.to === email && x.subject === 'Your TrustVault code').at(-1);
  if (!m) throw new Error(`no code emailed to ${email}`);
  return /code in TrustVault: (\d{6})/.exec(m.text)![1]!;
};
const codesSent = (email: string) => mail.outbox.filter((x) => x.to === email && x.subject === 'Your TrustVault code').length;

const turnOnEmail = (userId: string) => withDb(ownerDb(), (db) => db.query('UPDATE users SET email_otp_enabled_at = now() WHERE id = $1', [userId]));
const ageFactor = (userId: string, minutes: number) =>
  withDb(ownerDb(), (db) => db.query(`UPDATE sessions SET mfa_verified_at = now() - $2::float8 * interval '1 minute' WHERE user_id = $1`, [userId, minutes]));
const setPolicy = (roles: string[]) => withDb(ownerDb(), (db) => db.query('UPDATE app_settings SET mfa_required_roles = $1::"Role"[]', [roles]));
/** Clears the per-session and per-account second-factor try limits (to reach the per-code limit). */
const clearLimits = async (kinds: string[]) => {
  const redis = t.app.get(RedisService).client;
  for (const k of kinds) {
    let cursor = '0';
    const prefix = (redis.options.keyPrefix ?? '') as string;
    do {
      const [next, found] = await redis.scan(cursor, 'MATCH', `${prefix}rl:${k}*`, 'COUNT', 500);
      cursor = next;
      if (found.length) await redis.del(...found.map((x) => x.slice(prefix.length)));
    } while (cursor !== '0');
  }
};

/** Password step only: the session may still owe a second factor. */
async function passwordStep(user: TestUser): Promise<{ s: Session; body: Record<string, unknown> }> {
  const res = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: user.email, password: user.password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { s: { cookie: cookieFrom(res)!, csrf: res.body.csrfToken as string, userId: res.body.user.id as string }, body: res.body };
}

/** Full sign-in with an emailed code. */
async function signInWithEmail(user: TestUser): Promise<Session> {
  const { s } = await passwordStep(user);
  await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'signin' }).expect(200);
  const v = await as(t, s).post('/api/auth/mfa/email/verify', { code: lastCode(user.email) });
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  return { cookie: cookieFrom(v)!, csrf: v.body.csrfToken as string, userId: s.userId };
}

describe('turning email codes on', () => {
  it('needs the code emailed to the account; the email has the code and no link', async () => {
    const viewer = await createUser({ email: 'eo-on@gmail.com', role: 'VIEWER' });
    const s = await login(t, viewer);
    const before = (await as(t, s).get('/api/auth/mfa').expect(200)).body;
    expect(before).toMatchObject({ email: false, emailTo: 'e***@gmail.com', emailUnavailable: null });

    const sent = await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'enable' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body).toEqual({ sentTo: 'e***@gmail.com', expiresInSeconds: 600 });
    const code = lastCode(viewer.email);
    const msg = mail.outbox.at(-1)!;
    expect(msg.subject).toBe('Your TrustVault code');
    expect(msg.text).toContain(code);
    expect(msg.text).toMatch(/change your password/);
    expect(msg.text).not.toMatch(/https?:\/\//);
    expect(msg.html).not.toMatch(/<a\s/i);

    const wrong = await as(t, s).post('/api/auth/mfa/email/enable', { code: code === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('wrong_code');
    expect((await as(t, s).get('/api/auth/mfa')).body.email).toBe(false);

    const ok = await as(t, s).post('/api/auth/mfa/email/enable', { code });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // First factor: the password-level session is replaced by a full one.
    const full: Session = { cookie: cookieFrom(ok)!, csrf: ok.body.csrfToken as string, userId: viewer.id };
    expect(full.cookie).toBeDefined();
    expect((await as(t, full).get('/api/auth/mfa').expect(200)).body).toMatchObject({ email: true, satisfied: true, required: true });

    const rows = await auditRows(`target_id = $1 AND action LIKE 'mfa.email%'`, [viewer.id]);
    expect(rows.map((r) => [r.action, r.outcome, r.reason])).toEqual([
      ['mfa.email_send', 'ALLOWED', null],
      ['mfa.email_enable', 'DENIED', 'wrong_code'],
      ['mfa.email_enable', 'ALLOWED', null],
    ]);
    expect(rows[0]!.details).toEqual({ purpose: 'enable' });
    // A notice that the account's sign-in changed.
    expect(mail.outbox.some((m) => m.to === viewer.email && /sign-in security changed/.test(m.subject))).toBe(true);
  });

  it('an expired code, a reused code and a code for another purpose are refused', async () => {
    const viewer = await createUser({ email: 'eo-exp@t.io', role: 'VIEWER' });
    const s = await login(t, viewer);
    await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'enable' }).expect(200);
    const code = lastCode(viewer.email);
    // Expire it in Redis (the TTL is 10 minutes).
    const redis = t.app.get(RedisService).client;
    await redis.del(`emailcode:enable:${(await withDb(ownerDb(), (db) => db.query('SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [viewer.id]))).rows[0].id}`);
    const expired = await as(t, s).post('/api/auth/mfa/email/enable', { code });
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('code_expired');

    // Turned on; then the same code again.
    await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'enable' }).expect(200);
    const fresh = lastCode(viewer.email);
    const ok = await as(t, s).post('/api/auth/mfa/email/enable', { code: fresh }).expect(200);
    const full: Session = { cookie: cookieFrom(ok)!, csrf: ok.body.csrfToken as string, userId: viewer.id };

    // A step-up code is only for step-up: not for finishing a sign-in...
    await as(t, full).post('/api/auth/mfa/email/send', { purpose: 'stepup' }).expect(200);
    const stepCode = lastCode(viewer.email);
    const asSignIn = await as(t, full).post('/api/auth/mfa/email/verify', { code: stepCode });
    expect(asSignIn.status).toBe(401);
    // ...nor from another session of the same person...
    await clearLimits(['emailcode:']);
    const other = await signInWithEmail(viewer);
    const elsewhere = await as(t, other).post('/api/auth/mfa/step-up', { code: stepCode, method: 'email' });
    expect(elsewhere.status).toBe(401);
    // ...nor as an authenticator code.
    expect((await as(t, full).post('/api/auth/mfa/step-up', { code: stepCode })).status).toBe(400);
    // It still works where it belongs, once.
    await as(t, full).post('/api/auth/mfa/step-up', { code: stepCode, method: 'email' }).expect(200);
    const replay = await as(t, full).post('/api/auth/mfa/step-up', { code: stepCode, method: 'email' });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('code_expired');

    const denied = await auditRows(`target_id = $1 AND outcome = 'DENIED' AND details->>'method' = 'email'`, [viewer.id]);
    expect(denied.map((r) => r.reason)).toEqual(expect.arrayContaining(['no_code']));
  });

  it('asking again replaces the earlier code', async () => {
    const viewer = await createUser({ email: 'eo-resend@t.io', role: 'VIEWER' });
    const s = await login(t, viewer);
    await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'enable' }).expect(200);
    const first = lastCode(viewer.email);
    await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'enable' }).expect(200);
    const second = lastCode(viewer.email);
    if (first !== second) {
      expect((await as(t, s).post('/api/auth/mfa/email/enable', { code: first })).status).toBe(401);
    }
    await as(t, s).post('/api/auth/mfa/email/enable', { code: second }).expect(200);
  });

  it('five wrong tries end the code', async () => {
    const viewer = await createUser({ email: 'eo-tries@t.io', role: 'VIEWER' });
    const s = await login(t, viewer);
    await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'enable' }).expect(200);
    const code = lastCode(viewer.email);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 5; i++) {
      const r = await as(t, s).post('/api/auth/mfa/email/enable', { code: wrong });
      expect(r.status, JSON.stringify(r.body)).toBe(401);
    }
    // Past the session's own try limit, to show the code itself is gone.
    await clearLimits(['mfa:']);
    const right = await as(t, s).post('/api/auth/mfa/email/enable', { code });
    expect(right.status).toBe(401);
    expect(right.body.code).toBe('code_expired');
    expect((await as(t, s).get('/api/auth/mfa')).body.email).toBe(false);
  });

  it('sends are limited per account (3 per 10 minutes), and the refusal is audited', async () => {
    const viewer = await createUser({ email: 'eo-send@t.io', role: 'VIEWER' });
    const s = await login(t, viewer);
    for (let i = 0; i < 3; i++) await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'enable' }).expect(200);
    const fourth = await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'enable' });
    expect(fourth.status).toBe(429);
    expect(codesSent(viewer.email)).toBe(3);
    // Another session of the same account shares the budget.
    const again = await as(t, await login(t, viewer)).post('/api/auth/mfa/email/send', { purpose: 'enable' });
    expect(again.status).toBe(429);
    const rows = await auditRows(`target_id = $1 AND action = 'mfa.email_send' AND outcome = 'DENIED'`, [viewer.id]);
    expect(rows.at(-1)).toMatchObject({ reason: 'rate_limited', details: { purpose: 'enable' } });
  });

  it('sends are limited per IP across accounts', async () => {
    const people = await Promise.all(Array.from({ length: 4 }, (_, i) => createUser({ email: `eo-ip${i}@t.io`, role: 'VIEWER' })));
    let ok = 0;
    let limited = 0;
    for (const p of people) {
      const s = await login(t, p);
      for (let i = 0; i < 3; i++) {
        const r = await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'enable' });
        if (r.status === 200) ok++;
        else if (r.status === 429) limited++;
      }
    }
    expect(ok).toBe(10);
    expect(limited).toBe(2);
  });

  it('someone who already has a factor must have used it in this session', async () => {
    const owner = await createUser({ email: 'eo-has-totp@t.io', role: 'OWNER', mfa: true });
    const { s } = await passwordStep(owner);
    const r = await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'enable' });
    expect(r.status).toBe(403);
    expect(codesSent(owner.email)).toBe(0);
    // With the authenticator used, adding email codes keeps the session.
    const full = await login(t, owner);
    await as(t, full).post('/api/auth/mfa/email/send', { purpose: 'enable' }).expect(200);
    const on = await as(t, full).post('/api/auth/mfa/email/enable', { code: lastCode(owner.email) }).expect(200);
    expect(cookieFrom(on)).toBeUndefined();
    expect((await as(t, full).get('/api/auth/mfa')).body).toMatchObject({ email: true, totp: true });
  });
});

describe('signing in with an email code', () => {
  it('after the password, a code sent to the account finishes the sign-in', async () => {
    const viewer = await createUser({ email: 'eo-signin@t.io', role: 'VIEWER' });
    await turnOnEmail(viewer.id);
    const { s, body } = await passwordStep(viewer);
    expect(body).toMatchObject({ mfaRequired: true, mfaEnrolled: true, mfaMethods: ['email'] });
    const blocked = await as(t, s).get('/api/documents');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('mfa_required');
    expect((await as(t, s).get('/api/auth/mfa')).body).toMatchObject({ email: true, satisfied: false });

    const sent = await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'signin' }).expect(200);
    expect(sent.body.sentTo).toBe('e***@t.io');
    const wrong = await as(t, s).post('/api/auth/mfa/email/verify', { code: lastCode(viewer.email) === '123456' ? '654321' : '123456' });
    expect(wrong.status).toBe(401);
    const v = await as(t, s).post('/api/auth/mfa/email/verify', { code: lastCode(viewer.email) });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    const full: Session = { cookie: cookieFrom(v)!, csrf: v.body.csrfToken as string, userId: viewer.id };
    await as(t, full).get('/api/documents').expect(200);
    // The password-only token stopped working.
    expect((await as(t, s).get('/api/auth/me')).status).toBe(401);

    const rows = await auditRows(`target_id = $1 AND action = 'mfa.email_verify'`, [viewer.id]);
    expect(rows.map((r) => [r.outcome, r.reason])).toEqual([['DENIED', 'wrong_code'], ['ALLOWED', null]]);
  });

  it('lists every method, authenticator first, and a sign-in code cannot be sent to a full session', async () => {
    const owner = await createUser({ email: 'eo-both@t.io', role: 'OWNER', mfa: true });
    await turnOnEmail(owner.id);
    const { body } = await passwordStep(owner);
    expect(body.mfaMethods).toEqual(['totp', 'email']);
    const full = await login(t, owner);
    expect((await as(t, full).post('/api/auth/mfa/email/send', { purpose: 'signin' })).status).toBe(400);
  });

  it('nobody can ask for a sign-in code for an account without email codes', async () => {
    const owner = await createUser({ email: 'eo-off@t.io', role: 'OWNER', mfa: true });
    const { s } = await passwordStep(owner);
    const r = await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'signin' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('email_codes_off');
    expect(codesSent(owner.email)).toBe(0);
    expect((await as(t, s).post('/api/auth/mfa/email/verify', { code: '123456' })).status).toBe(400);
  });
});

describe('turning email codes off', () => {
  it('needs a fresh second factor, which an emailed code can be; then sign-in is password only', async () => {
    const viewer = await createUser({ email: 'eo-offok@t.io', role: 'VIEWER' });
    await turnOnEmail(viewer.id);
    const s = await signInWithEmail(viewer);
    await ageFactor(viewer.id, 6);
    const refused = await as(t, s).delete('/api/auth/mfa/email');
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('step_up_required');

    await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'stepup' }).expect(200);
    const up = await as(t, s).post('/api/auth/mfa/step-up', { code: lastCode(viewer.email), method: 'email' });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    await as(t, s).delete('/api/auth/mfa/email').expect(204);
    expect((await as(t, s).get('/api/auth/mfa')).body).toMatchObject({ email: false, required: false });

    const { body } = await passwordStep(viewer);
    expect(body).toMatchObject({ mfaRequired: false, mfaMethods: [] });
    const rows = await auditRows(`target_id = $1 AND action IN ('mfa.step_up', 'mfa.email_disable')`, [viewer.id]);
    expect(rows.map((r) => [r.action, r.outcome, r.details])).toEqual([
      ['mfa.step_up', 'ALLOWED', { method: 'email' }],
      ['mfa.email_disable', 'ALLOWED', null],
    ]);
  });

  it('an authenticator code also works as the fresh factor', async () => {
    const owner = await createUser({ email: 'eo-off-totp@t.io', role: 'OWNER', mfa: true });
    await turnOnEmail(owner.id);
    const s = await login(t, owner);
    await ageFactor(owner.id, 6);
    expect((await as(t, s).delete('/api/auth/mfa/email')).status).toBe(403);
    await withDb(ownerDb(), (db) => db.query('UPDATE users SET totp_last_step = NULL WHERE id = $1', [owner.id]));
    await as(t, s).post('/api/auth/mfa/step-up', { code: totpAt(owner.totpSecret!, currentStep()) }).expect(200);
    await as(t, s).delete('/api/auth/mfa/email').expect(204);
    expect((await as(t, s).get('/api/auth/mfa')).body).toMatchObject({ email: false, totp: true });
  });

  it('a role the MFA policy covers cannot turn off its last factor', async () => {
    await setPolicy(['ADMIN', 'OWNER']);
    const owner = await createUser({ email: 'eo-policy@t.io', role: 'OWNER' });
    await turnOnEmail(owner.id);
    const s = await signInWithEmail(owner);
    const status = (await as(t, s).get('/api/auth/mfa')).body;
    expect(status).toMatchObject({ requiredByRole: true, email: true });
    const r = await as(t, s).delete('/api/auth/mfa/email');
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/must keep at least one second factor/);
    expect((await as(t, s).get('/api/auth/mfa')).body.email).toBe(true);
  });

  it('removing the authenticator keeps a policy-covered account with email codes allowed', async () => {
    await setPolicy(['ADMIN', 'OWNER']);
    const owner = await createUser({ email: 'eo-policy2@t.io', role: 'OWNER', mfa: true });
    await turnOnEmail(owner.id);
    const s = await login(t, owner);
    await as(t, s).delete('/api/auth/mfa/totp').expect(204);
    expect((await as(t, s).get('/api/auth/mfa')).body).toMatchObject({ totp: false, email: true });
  });
});

describe('who cannot use email codes', () => {
  it('administrators: not offered, refused, and the database agrees', async () => {
    const admin = await createUser({ email: 'eo-admin@t.io', role: 'ADMIN' });
    const s = await login(t, admin);
    const st = (await as(t, s).get('/api/auth/mfa')).body;
    expect(st.emailUnavailable).toMatch(/Administrators must use an authenticator app or a passkey/);
    const r = await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'enable' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('email_codes_not_for_admins');
    expect(codesSent(admin.email)).toBe(0);
    expect((await as(t, s).post('/api/auth/mfa/email/enable', { code: '123456' })).status).toBe(403);
    const rows = await auditRows(`target_id = $1 AND action = 'mfa.email_send'`, [admin.id]);
    expect(rows.at(-1)).toMatchObject({ outcome: 'DENIED', reason: 'admin_not_allowed' });
    // Not even the schema owner can give an admin email codes.
    await expect(turnOnEmail(admin.id)).rejects.toThrow(/users_email_otp_not_admin/);
  });

  it('promoting someone who uses email codes turns them off: an admin must use an app or passkey', async () => {
    const admin = await createUser({ email: 'eo-promoter@t.io', role: 'ADMIN' });
    const viewer = await createUser({ email: 'eo-promoted@t.io', role: 'VIEWER' });
    await turnOnEmail(viewer.id);
    const a = await login(t, admin);
    await as(t, a).patch(`/api/admin/users/${viewer.id}`, { role: 'ADMIN' }).expect(200);
    const { rows } = await withDb(ownerDb(), (db) => db.query('SELECT role, email_otp_enabled_at FROM users WHERE id = $1', [viewer.id]));
    expect(rows[0]).toMatchObject({ role: 'ADMIN', email_otp_enabled_at: null });
    // The new admin must enrol a real factor.
    const { body } = await passwordStep(viewer);
    expect(body).toMatchObject({ mfaRequired: true, mfaEnrolled: false, mfaMethods: [] });
  });

  it('demo accounts: refused (they never get mail), and the database agrees', async () => {
    const demo = await createUser({ email: 'eo-demo@demo.com', role: 'VIEWER' });
    await withDb(ownerDb(), (db) => db.query('UPDATE users SET is_protected = true WHERE id = $1', [demo.id]));
    const s = await login(t, demo);
    expect((await as(t, s).get('/api/auth/mfa')).body.emailUnavailable).toMatch(/Demo accounts/);
    const r = await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'enable' });
    expect(r.status).toBe(403);
    expect((await as(t, s).post('/api/auth/mfa/email/enable', { code: '123456' })).status).toBe(403);
    expect(mail.outbox.filter((m) => m.to === demo.email)).toHaveLength(0);
    const rows = await auditRows(`target_id = $1 AND action = 'mfa.email_send'`, [demo.id]);
    expect(rows.at(-1)).toMatchObject({ outcome: 'DENIED', reason: 'demo_account' });
    await expect(turnOnEmail(demo.id)).rejects.toThrow(/users_email_otp_not_demo/);
  });

  it('the app role cannot turn email codes on or off for someone else', async () => {
    const viewer = await createUser({ email: 'eo-db-v@t.io', role: 'VIEWER' });
    const other = await createUser({ email: 'eo-db-o@t.io', role: 'VIEWER' });
    await withDb(appDb(), async (db) => {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.user_id', $1, true)`, [other.id]);
      await expect(db.query('UPDATE users SET email_otp_enabled_at = now() WHERE id = $1', [viewer.id])).rejects.toThrow(/turned on only by their owner/);
      await db.query('ROLLBACK');
      // Nobody at all (no app.user_id).
      await expect(db.query('UPDATE users SET email_otp_enabled_at = now() WHERE id = $1', [viewer.id])).rejects.toThrow(/turned on only by their owner/);
    });
    await turnOnEmail(viewer.id);
    await withDb(appDb(), async (db) => {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.user_id', $1, true)`, [other.id]);
      await expect(db.query('UPDATE users SET email_otp_enabled_at = NULL WHERE id = $1', [viewer.id])).rejects.toThrow(/turned on only by their owner/);
      await db.query('ROLLBACK');
    });
  });

  it('an admin MFA reset clears email codes too', async () => {
    const admin = await createUser({ email: 'eo-reset-admin@t.io', role: 'ADMIN' });
    const viewer = await createUser({ email: 'eo-reset-v@t.io', role: 'VIEWER' });
    await turnOnEmail(viewer.id);
    const a = await login(t, admin);
    await as(t, a).post(`/api/admin/users/${viewer.id}/mfa/reset`).expect(204);
    const { rows } = await withDb(ownerDb(), (db) => db.query('SELECT email_otp_enabled_at FROM users WHERE id = $1', [viewer.id]));
    expect(rows[0].email_otp_enabled_at).toBeNull();
  });
});

describe('codes never leak', () => {
  it('no code in responses, audit rows or logs', async () => {
    const logged: string[] = [];
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push(JSON.stringify(args)); }) as never);
    }
    const viewer = await createUser({ email: 'eo-leak@t.io', role: 'VIEWER' });
    const s = await login(t, viewer);
    const bodies: string[] = [];
    const sent = await as(t, s).post('/api/auth/mfa/email/send', { purpose: 'enable' }).expect(200);
    bodies.push(JSON.stringify(sent.body), JSON.stringify(sent.headers));
    const code = lastCode(viewer.email);
    const bad = await as(t, s).post('/api/auth/mfa/email/enable', { code: code === '999999' ? '999998' : '999999' });
    bodies.push(JSON.stringify(bad.body));
    const ok = await as(t, s).post('/api/auth/mfa/email/enable', { code }).expect(200);
    bodies.push(JSON.stringify(ok.body), JSON.stringify(ok.headers));
    const full: Session = { cookie: cookieFrom(ok)!, csrf: ok.body.csrfToken as string, userId: viewer.id };
    bodies.push(JSON.stringify((await as(t, full).get('/api/auth/mfa')).body));
    for (const b of bodies) expect(b).not.toContain(code);
    const rows = await auditRows('target_id = $1::text OR actor_id = $1::uuid', [viewer.id]);
    expect(rows.length).toBeGreaterThan(2);
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(logged.join('\n')).not.toContain(code);
    // Redis holds only a MAC.
    const redis = t.app.get(RedisService).client;
    await as(t, full).post('/api/auth/mfa/email/send', { purpose: 'stepup' }).expect(200);
    const stepCode = lastCode(viewer.email);
    const { rows: [sess] } = await withDb(ownerDb(), (db) => db.query('SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND auth_level = $2', [viewer.id, 'mfa']));
    const stored = await redis.hgetall(`emailcode:stepup:${sess.id}`);
    expect(Object.keys(stored).sort()).toEqual(['mac', 'salt', 'tries', 'uid']);
    expect(JSON.stringify(stored)).not.toContain(stepCode);
    expect(await redis.ttl(`emailcode:stepup:${sess.id}`)).toBeGreaterThan(590);
  });
});
