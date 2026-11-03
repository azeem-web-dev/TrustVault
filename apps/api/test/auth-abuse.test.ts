import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type request from 'supertest';
import { MailService } from '../src/mail/mail.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { DeviceTrustService } from '../src/auth/device-trust.service.js';
import { STEP_UP_MESSAGE } from '../src/auth/auth.controller.js';
import { emailKey, LIMITS } from '../src/auth/login-throttle.service.js';
import { clientNetwork } from '../src/auth/client-network.js';
import { currentStep, totpAt } from '../src/auth/totp.js';
import { authAbuseAlerts } from '../src/audit/auth-abuse-alerts.js';
import { PrismaService } from '../src/db/prisma.service.js';
import { as, auditRows, createUser, login, ORIGIN, ownerDb, resetState, startApp, withDb, type TestApp, type TestUser } from './helpers.js';

// Authentication abuse (THREATS.md S1, S7, S9, S19): a stranger must not be
// able to lock a person out, and must not be able to guess, stuff or race
// their way in unnoticed. Different client IPs are simulated with
// X-Forwarded-For, which the API trusts from loopback only (as from nginx).

let t: TestApp;
let mail: MailService;

beforeAll(async () => {
  t = await startApp({ MAIL_TRANSPORT: 'memory' });
  mail = t.app.get(MailService);
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t.app);
  mail.outbox.length = 0;
});

const X = '203.0.113.7'; // the attacker
const Y = '198.51.100.20'; // the victim, elsewhere
// The audit log outlives every test (it cannot be deleted), so checks on
// alerts use addresses and names no earlier run has used.
const RUN = `${Math.floor(Math.random() * 250)}.${Date.now() % 250}`;
const STUFFER = `10.77.${RUN}`;

const cookiesOf = (res: request.Response): string[] => ([] as string[]).concat(res.headers['set-cookie'] ?? []);
const cookieValue = (res: request.Response, name: string) => cookiesOf(res).find((c) => c.startsWith(`${name}=`))?.split(';')[0];
const sessionCookie = (res: request.Response) => cookieValue(res, '__Host-tv_session');
const deviceCookie = (res: request.Response) => cookieValue(res, '__Host-tv_device');

function attempt(email: string, password: string, opts: { ip?: string; cookie?: string } = {}) {
  let r = t.http.post('/api/auth/login').set('Origin', ORIGIN);
  if (opts.ip) r = r.set('X-Forwarded-For', opts.ip);
  if (opts.cookie) r = r.set('Cookie', opts.cookie);
  return r.send({ email, password });
}
const withLink = (token: string, ip?: string) => {
  const r = t.http.post('/api/auth/login/link').set('Origin', ORIGIN);
  return (ip ? r.set('X-Forwarded-For', ip) : r).send({ token });
};
const signInLinks = (email: string) => mail.outbox.filter((m) => m.to === email && /Confirm your TrustVault sign-in/.test(m.subject));
const tokenIn = (text: string, path: string) => new RegExp(`/${path}#token=([A-Za-z0-9_-]+)`).exec(text)?.[1] ?? null;
const me = (cookie: string) => t.http.get('/api/auth/me').set('Cookie', cookie);
const reasons = async (email: string, since: Date) =>
  (await auditRows(`action = 'auth.login' AND actor_email = $1 AND occurred_at >= $2`, [email, since])).map((r) => `${r.outcome}:${r.reason ?? ''}`);
const dbNow = () => withDb(ownerDb(), async (db) => (await db.query('SELECT now() AS t')).rows[0].t as Date);

/** Sign in from `ip` and return the trusted-device cookie the browser was given. */
async function trustedDevice(u: TestUser, ip = Y): Promise<string> {
  const res = await attempt(u.email, u.password, { ip });
  expect(res.status).toBe(200);
  let device = deviceCookie(res);
  if (res.body.mfaRequired) {
    expect(device).toBeUndefined(); // the password alone never makes a device trusted
    await withDb(ownerDb(), (db) => db.query('UPDATE users SET totp_last_step = NULL WHERE id = $1', [u.id]));
    const v = await t.http.post('/api/auth/mfa/totp/verify').set('Origin', ORIGIN).set('X-Forwarded-For', ip)
      .set('Cookie', sessionCookie(res)!).set('X-CSRF-Token', res.body.csrfToken).send({ code: totpAt(u.totpSecret!, currentStep()) });
    expect(v.status).toBe(200);
    device = deviceCookie(v);
  }
  expect(device).toMatch(/^__Host-tv_device=v1\./);
  return device!;
}

/** A stranger at `ip` throws wrong passwords at the account. */
async function attack(email: string, n: number, ip = X): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await attempt(email, `wrong-guess-${i}-password`, { ip })).status);
  return statuses;
}

describe('a stranger cannot lock the owner out (lockout DoS)', () => {
  it('attacker at X fails 50 times; the owner at Y with their device cookie signs straight in', async () => {
    const u = await createUser({ email: 'victim@t.io', role: 'OWNER' });
    const device = await trustedDevice(u);
    const statuses = await attack(u.email, 50);
    // The attacker is held off: 5 tries, then 429 for their client only.
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(new Set(statuses.slice(5))).toEqual(new Set([429]));

    const res = await attempt(u.email, u.password, { ip: Y, cookie: device });
    expect(res.status).toBe(200);
    expect((await me(sessionCookie(res)!)).status).toBe(200);
    // The device cookie is rotated at every full sign-in.
    expect(deviceCookie(res)).toBeDefined();
    expect(deviceCookie(res)).not.toBe(device);
    // Even from the attacker's own address the device is let through.
    expect((await attempt(u.email, u.password, { ip: X, cookie: device })).status).toBe(200);
    const audit = await auditRows(`action = 'auth.login' AND outcome = 'ALLOWED' AND actor_id = $1`, [u.id]);
    expect(audit.at(-1)!.details).toMatchObject({ via: 'trusted_device' });
  });

  it('without the cookie the owner gets a step-up — an emailed one-time link — not a block', async () => {
    const u = await createUser({ email: 'victim2@t.io', role: 'VIEWER' });
    await attack(u.email, 50);
    const res = await attempt(u.email, u.password, { ip: Y });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ signInLinkSent: true, message: STEP_UP_MESSAGE });
    expect(sessionCookie(res)).toBeUndefined(); // the password alone gives no session
    expect(signInLinks(u.email)).toHaveLength(1);
    const token = tokenIn(signInLinks(u.email)[0]!.text, 'signin-link')!;
    expect(signInLinks(u.email)[0]!.text).toContain(`${ORIGIN}/signin-link#token=`);

    const done = await withLink(token, Y);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ user: { email: u.email }, mfaRequired: false });
    expect((await me(sessionCookie(done)!)).status).toBe(200);
    // That browser is now trusted: next time it goes straight in.
    const device = deviceCookie(done)!;
    expect((await attempt(u.email, u.password, { ip: Y, cookie: device })).status).toBe(200);
    // The link worked once.
    expect((await withLink(token, Y)).status).toBe(400);
    const allowed = await auditRows(`action = 'auth.login' AND outcome = 'ALLOWED' AND actor_id = $1`, [u.id]);
    expect(allowed.map((r) => (r.details as { via: string }).via)).toEqual(['signin_link', 'trusted_device']);
  });

  it('an admin: the cookie comes only after the second factor, and still needs it afterwards', async () => {
    const adm = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const device = await trustedDevice(adm);
    await attack(adm.email, 30);
    const res = await attempt(adm.email, adm.password, { ip: Y, cookie: device });
    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    // Password-level session: nothing but the MFA routes.
    expect((await t.http.get('/api/documents').set('Cookie', sessionCookie(res)!)).status).toBe(403);
    // Through the emailed link too, the second factor is still asked for.
    const other = await attempt(adm.email, adm.password, { ip: Y });
    expect(other.status).toBe(202);
    const link = await withLink(tokenIn(signInLinks(adm.email).at(-1)!.text, 'signin-link')!, Y);
    expect(link.status).toBe(200);
    expect(link.body.mfaRequired).toBe(true);
    expect(deviceCookie(link)).toBeUndefined();
  });

  it('under attack, a wrong password, the right one and an unknown email get the same answer', async () => {
    const u = await createUser({ email: 'same@t.io', role: 'VIEWER' });
    const since = await dbNow();
    await attack(u.email, 12);
    await attack('nobody-here@t.io', 12);
    const answers = await Promise.all([
      attempt(u.email, 'still-the-wrong-password', { ip: Y }),
      attempt(u.email, u.password, { ip: '198.51.100.21' }),
      attempt('nobody-here@t.io', 'any-password-at-all', { ip: '198.51.100.22' }),
    ]);
    for (const a of answers) {
      expect(a.status).toBe(202);
      expect(a.body).toEqual({ signInLinkSent: true, message: STEP_UP_MESSAGE });
      expect(sessionCookie(a)).toBeUndefined();
    }
    // Only the right password emailed anything; the log says what really happened.
    expect(signInLinks(u.email)).toHaveLength(1);
    expect(mail.outbox.filter((m) => m.to === 'nobody-here@t.io')).toHaveLength(0);
    const mine = await reasons(u.email, since);
    expect(mine).toContain('DENIED:stepup_wrong_password');
    expect(mine).toContain('DENIED:stepup_link_sent');
    expect(await reasons('nobody-here@t.io', since)).toContain('DENIED:stepup_unknown_account');
    // Entering the "under attack" state is itself recorded, once per account.
    const flagged = await auditRows(`action = 'auth.account_under_attack' AND actor_email = $1 AND occurred_at >= $2`, [u.email, since]);
    expect(flagged).toHaveLength(1);
  });

  it('confirmation emails are capped at 3 an hour; the answer does not change', async () => {
    const u = await createUser({ email: 'cap@t.io', role: 'VIEWER' });
    await attack(u.email, 12);
    for (let i = 0; i < 5; i++) {
      const r = await attempt(u.email, u.password, { ip: `198.51.100.${30 + i}` });
      expect(r.status).toBe(202);
    }
    expect(signInLinks(u.email)).toHaveLength(LIMITS.linkMails.max);
  });

  it('a device cookie for another account, a forged one, or one older than a password change does not help', async () => {
    const u = await createUser({ email: 'owner@t.io', role: 'VIEWER' });
    const other = await createUser({ email: 'other@t.io', role: 'VIEWER' });
    const mine = await trustedDevice(u);
    const theirs = await trustedDevice(other);
    await attack(u.email, 15);
    const forged = mine.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    const devices = t.app.get(DeviceTrustService);
    const expired = `__Host-tv_device=${devices.issue(u.id, Date.now() - 400 * 86_400_000).value}`;
    expect(devices.verify(forged.split('=')[1])).toBeNull();
    expect(devices.verify(expired.split('=')[1])).toBeNull();
    for (const cookie of [theirs, forged, expired]) {
      expect((await attempt(u.email, u.password, { ip: Y, cookie })).status).toBe(202);
    }
    // The real one works ...
    expect((await attempt(u.email, u.password, { ip: Y, cookie: mine })).status).toBe(200);
    // ... until the password changes: then it is just another browser.
    await withDb(ownerDb(), (db) => db.query(`UPDATE users SET password_changed_at = now() WHERE id = $1`, [u.id]));
    expect((await attempt(u.email, u.password, { ip: Y, cookie: mine })).status).toBe(202);
  });

  it('a trusted device has its own budget: after 10 failures with it, it is treated like any browser', async () => {
    const u = await createUser({ email: 'budget@t.io', role: 'VIEWER' });
    const device = await trustedDevice(u, X);
    for (let i = 0; i < LIMITS.device.max; i++) {
      expect((await attempt(u.email, `wrong-${i}-password`, { ip: X, cookie: device })).status).toBe(401);
    }
    // Over budget: the normal limits apply again (this client has used none of its 5 yet).
    const next = await attempt(u.email, 'wrong-again-password', { ip: X, cookie: device });
    expect(next.status).toBe(401);
    const row = (await auditRows(`request_id = $1`, [next.headers['x-request-id']]))[0]!;
    expect(row.details).toMatchObject({ trustedDevice: false });
  });

  it('the per-client backoff is 5 tries, then 15 minutes, doubling; other clients are not affected', async () => {
    const u = await createUser({ email: 'pair@t.io', role: 'VIEWER' });
    expect(await attack(u.email, 6)).toEqual([401, 401, 401, 401, 401, 429]);
    const redis = t.app.get(RedisService).client;
    const key = `rl:login:pair:${emailKey(u.email)}:${clientNetwork(X).client}`;
    expect(await redis.ttl(`${key}:lock`)).toBeGreaterThan(14 * 60);
    // A 429 says only "too many attempts", the same for an unknown address.
    const locked = await attempt(u.email, u.password, { ip: X });
    await attack('ghost@t.io', 5);
    const ghost = await attempt('ghost@t.io', 'whatever-password', { ip: X });
    expect(locked.status).toBe(429);
    expect(ghost.status).toBe(429);
    expect(locked.body.message).toBe(ghost.body.message);
    expect(Object.keys(locked.body).sort()).toEqual(Object.keys(ghost.body).sort());
    // The right password from elsewhere still works.
    expect((await attempt(u.email, u.password, { ip: Y })).status).toBe(200);
    // The lock runs out (and the account's hour cools down); five more failures lock for twice as long.
    await redis.del(`${key}:lock`, `rl:login:acct:${emailKey(u.email)}`);
    expect(await attack(u.email, 6)).toEqual([401, 401, 401, 401, 401, 429]);
    expect(await redis.ttl(`${key}:lock`)).toBeGreaterThan(29 * 60);
    expect((await reasons(u.email, new Date(0))).filter((r) => r === 'DENIED:rate_limited_pair').length).toBeGreaterThanOrEqual(2);
  });

  it('one IP gets 20 sign-in attempts per 15 minutes, successful ones included', async () => {
    const u = await createUser({ email: 'busy@t.io', role: 'VIEWER' });
    for (let i = 0; i < LIMITS.ip.max; i++) expect((await attempt(u.email, u.password, { ip: X })).status).toBe(200);
    const over = await attempt(u.email, u.password, { ip: X });
    expect(over.status).toBe(429);
    expect((await auditRows(`request_id = $1`, [over.headers['x-request-id']]))[0]).toMatchObject({ reason: 'rate_limited_ip' });
    // ... except from the account's own trusted device.
    const device = await trustedDevice(u, Y);
    expect((await attempt(u.email, u.password, { ip: X, cookie: device })).status).toBe(200);
  });

  it('parallel guesses from one client cannot get past the 5-try limit', async () => {
    const u = await createUser({ email: 'parallel@t.io', role: 'VIEWER' });
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => attempt(u.email, `wrong-${i}-password`, { ip: X })));
    const statuses = res.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  });

  it('an IPv6 attacker rotating through their /64 is still one client', async () => {
    const u = await createUser({ email: 'v6@t.io', role: 'VIEWER' });
    const statuses: number[] = [];
    for (let i = 1; i <= 7; i++) statuses.push((await attempt(u.email, `wrong-${i}-password`, { ip: `2001:db8:1:2::${i.toString(16)}` })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });

  it('the old per-account lock is gone: no failure writes to the users row', async () => {
    const u = await createUser({ email: 'norow@t.io', role: 'VIEWER' });
    await attack(u.email, 8);
    const row = await withDb(ownerDb(), async (db) => (await db.query(`SELECT failed_login_count, locked_until FROM users WHERE id = $1`, [u.id])).rows[0]);
    expect(row).toMatchObject({ failed_login_count: 0, locked_until: null });
  });

  it('a demo (protected) account is never put behind the email step: its password is public anyway', async () => {
    const demo = await createUser({ email: 'demo-viewer@t.io', role: 'VIEWER' });
    await withDb(ownerDb(), (db) => db.query(`UPDATE users SET is_protected = true WHERE id = $1`, [demo.id]));
    await attack(demo.email, 15);
    expect((await attempt(demo.email, demo.password, { ip: Y })).status).toBe(200);
  });
});

describe('credential stuffing and spraying are detected', () => {
  it('one IP failing on 6 accounts is recorded once, refused for an hour, and alerted', async () => {
    const since = await dbNow();
    const X = STUFFER;
    for (let i = 0; i < LIMITS.detect.accountsPerIp; i++) {
      expect((await attempt(`list-${i}@t.io`, 'Summer2026!', { ip: X })).status).toBe(401);
    }
    const blocked = await attempt('list-99@t.io', 'Summer2026!', { ip: X });
    expect(blocked.status).toBe(429);
    expect((await auditRows(`request_id = $1`, [blocked.headers['x-request-id']]))[0]).toMatchObject({ reason: 'rate_limited_stuffing_ip' });
    for (let i = 0; i < 3; i++) await attempt(`list-${i}@t.io`, 'Summer2026!', { ip: X });
    const events = await auditRows(`action = 'auth.credential_stuffing' AND occurred_at >= $1`, [since]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: 'many_accounts_from_ip', details: { ip: X, accounts: 6 } });
    // Somebody else is unaffected.
    const u = await createUser({ email: 'fine@t.io', role: 'VIEWER' });
    expect((await attempt(u.email, u.password, { ip: Y })).status).toBe(200);

    const adm = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const { alerts } = (await as(t, await login(t, adm)).get('/api/admin/alerts')).body as { alerts: { kind: string; severity: string; message: string }[] };
    expect(alerts.find((a) => a.kind === 'auth_abuse_detected')).toMatchObject({ severity: 'high' });
    const mine = (await authAbuseAlerts(t.app.get(PrismaService), since)).find((a) => a.kind === 'stuffing_from_ip' && a.message.startsWith(`${X} `));
    // 6 accounts that failed, plus list-99 refused by the block; 10 attempts in all.
    expect(mine).toMatchObject({ severity: 'high', message: `${X} failed to sign in to 7 different accounts (10 attempts)` });
  });

  it('a whole /24 spraying many accounts gets a lower limit, even when each IP stays under 6', async () => {
    const since = await dbNow();
    let n = 0;
    for (let host = 1; n < LIMITS.detect.accountsPerNetwork; host++) {
      for (let k = 0; k < 4 && n < LIMITS.detect.accountsPerNetwork; k++, n++) {
        expect((await attempt(`spray-${n}@t.io`, 'Autumn2026!', { ip: `192.0.2.${host}` })).status).toBe(401);
      }
    }
    const events = await auditRows(`action = 'auth.credential_stuffing' AND reason = 'many_accounts_from_network' AND occurred_at >= $1`, [since]);
    expect(events).toHaveLength(1);
    expect(events[0]!.details).toMatchObject({ network: '192.0.2.0/24' });
    // 20 attempts already used: the flagged network's limit is now 20 per 15 minutes.
    const next = await attempt('spray-next@t.io', 'Autumn2026!', { ip: '192.0.2.200' });
    expect(next.status).toBe(429);
    expect((await auditRows(`request_id = $1`, [next.headers['x-request-id']]))[0]).toMatchObject({ reason: 'rate_limited_network' });
    // Another network is not affected.
    expect((await attempt('spray-next@t.io', 'Autumn2026!', { ip: '192.0.3.1' })).status).toBe(401);
  });

  it('many networks failing on one account: recorded as distributed guessing and alerted', async () => {
    const u = await createUser({ email: `target-${RUN}@t.io`, role: 'VIEWER' });
    const since = await dbNow();
    for (let net = 0; net < 12; net++) await attempt(u.email, `wrong-${net}-password`, { ip: `100.64.${net}.9` });
    const events = await auditRows(`action = 'auth.distributed_guessing' AND occurred_at >= $1`, [since]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_email: u.email, target_id: u.id, reason: 'many_networks_on_account' });
    const adm = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const { alerts } = (await as(t, await login(t, adm)).get('/api/admin/alerts')).body as { alerts: { kind: string; message: string }[] };
    expect(alerts.filter((a) => a.kind === 'auth_abuse_detected').map((a) => a.message)).toContain(`${u.email}: many networks tried the same account (distributed guessing)`);
    // The per-account rule, over just this test's window (the shared test log has bigger offenders).
    const recent = await authAbuseAlerts(t.app.get(PrismaService), since);
    expect(recent.find((a) => a.kind === 'failed_sign_in_burst')).toMatchObject({ severity: 'medium', message: `${u.email} had 12 failed sign-ins from 12 addresses` });
  });

  it('the alerts come from the audit log, so they survive the throttles being reset', async () => {
    const X = `10.78.${RUN}`;
    const since = await dbNow();
    for (let i = 0; i < 6; i++) await attempt(`gone-${i}@t.io`, 'Winter2026!', { ip: X });
    const redis = t.app.get(RedisService).client;
    let cursor = '0';
    const prefix = (t.app.get(RedisService).client.options.keyPrefix ?? '') as string;
    do {
      const [next, found] = await redis.scan(cursor, 'MATCH', `${prefix}rl:*`, 'COUNT', 500);
      cursor = next;
      if (found.length) await redis.del(...found.map((k) => k.slice(prefix.length)));
    } while (cursor !== '0');
    // Over this test's window (the shared test log holds bigger offenders from other tests).
    const recent = await authAbuseAlerts(t.app.get(PrismaService), since);
    expect(recent.some((a) => a.kind === 'stuffing_from_ip' && a.message.startsWith(`${X} `))).toBe(true);
  });
});

describe('one-time links: no replay, no race', () => {
  async function linkFor(u: TestUser): Promise<string> {
    await attack(u.email, 12);
    expect((await attempt(u.email, u.password, { ip: Y })).status).toBe(202);
    return tokenIn(signInLinks(u.email).at(-1)!.text, 'signin-link')!;
  }

  it('a sign-in link clicked many times at once signs in exactly once', async () => {
    const u = await createUser({ email: 'race-link@t.io', role: 'VIEWER' });
    const token = await linkFor(u);
    const res = await Promise.all(Array.from({ length: 8 }, () => withLink(token, Y)));
    expect(res.map((r) => r.status).sort()).toEqual([200, 400, 400, 400, 400, 400, 400, 400]);
    const sessions = await withDb(ownerDb(), async (db) => (await db.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`, [u.id])).rows[0].n);
    expect(sessions).toBe(1);
  });

  it('a new link cancels the old one; a password change voids it; reset and invitation links are not sign-in links', async () => {
    const u = await createUser({ email: 'void@t.io', role: 'VIEWER' });
    const first = await linkFor(u);
    expect((await attempt(u.email, u.password, { ip: '198.51.100.99' })).status).toBe(202);
    const second = tokenIn(signInLinks(u.email).at(-1)!.text, 'signin-link')!;
    expect((await withLink(first)).status).toBe(400);
    await withDb(ownerDb(), (db) => db.query(`UPDATE users SET password_changed_at = now() WHERE id = $1`, [u.id]));
    const refused = await withLink(second);
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe('This sign-in link is invalid or has expired. Sign in again to get a new one.');
    expect((await auditRows(`action = 'auth.signin_link' AND target_id = $1`, [u.id])).map((r) => r.reason)).toEqual(['link_used', 'password_changed']);

    // A reset link does not work here, and a sign-in link does not reset a password.
    await t.http.post('/api/auth/password/forgot').set('Origin', ORIGIN).send({ email: u.email }).expect(202);
    const reset = tokenIn(mail.outbox.filter((m) => /Reset your/.test(m.subject)).at(-1)!.text, 'reset')!;
    expect((await withLink(reset)).status).toBe(400);
    await attack(u.email, 1, '198.51.100.98');
    expect((await attempt(u.email, u.password, { ip: '198.51.100.97' })).status).toBe(202);
    const third = tokenIn(signInLinks(u.email).at(-1)!.text, 'signin-link')!;
    expect((await t.http.post('/api/auth/password/reset').set('Origin', ORIGIN).send({ token: third, newPassword: 'another-good-password' })).status).toBe(400);
    expect((await withLink(third)).status).toBe(200);
  });

  it('a reset link used many times at once changes the password exactly once and ends every session', async () => {
    const u = await createUser({ email: 'race-reset@t.io', role: 'VIEWER' });
    const s = await login(t, u);
    const device = await trustedDevice(u);
    await t.http.post('/api/auth/password/forgot').set('Origin', ORIGIN).send({ email: u.email }).expect(202);
    const token = tokenIn(mail.outbox.filter((m) => /Reset your/.test(m.subject)).at(-1)!.text, 'reset')!;
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      t.http.post('/api/auth/password/reset').set('Origin', ORIGIN).send({ token, newPassword: `brand-new-password-${i}` })));
    expect(res.map((r) => r.status).sort()).toEqual([204, 400, 400, 400, 400, 400]);
    expect((await as(t, s).get('/api/auth/me')).status).toBe(401);
    // Exactly one of the new passwords works.
    const works = [];
    for (let i = 0; i < 6; i++) works.push((await attempt(u.email, `brand-new-password-${i}`, { ip: `198.51.100.${60 + i}` })).status);
    expect(works.filter((x) => x === 200)).toHaveLength(1);
    // The device trusted before the reset is not trusted after it.
    const devices = t.app.get(DeviceTrustService);
    const row = await withDb(ownerDb(), async (db) => (await db.query(`SELECT id, password_changed_at FROM users WHERE id = $1`, [u.id])).rows[0]);
    expect(devices.trustedFor(device.split('=')[1], { id: row.id, passwordChangedAt: row.password_changed_at })).toBeNull();
  });

  it('an invitation accepted many times at once activates the account exactly once', async () => {
    const adm = await createUser({ email: 'adm@t.io', role: 'ADMIN' });
    const A = await login(t, adm);
    await as(t, A).post('/api/admin/users', { email: 'newbie@t.io', role: 'VIEWER' }).expect(201);
    const token = tokenIn(mail.outbox.filter((m) => m.to === 'newbie@t.io').at(-1)!.text, 'invite')!;
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      t.http.post('/api/auth/invite/accept').set('Origin', ORIGIN).send({ token, displayName: `Newbie ${i}`, password: `newbie-password-${i}` })));
    expect(res.map((r) => r.status).sort()).toEqual([204, 400, 400, 400, 400, 400]);
    const row = await withDb(ownerDb(), async (db) => (await db.query(`SELECT id, status, display_name FROM users WHERE email = 'newbie@t.io'`)).rows[0]);
    expect(row.status).toBe('ACTIVE');
    expect((await auditRows(`action = 'auth.invite_accepted' AND outcome = 'ALLOWED' AND actor_id = $1`, [row.id])).length).toBe(1);
    // Only the winner's password works.
    const winner = Number(String(row.display_name).replace('Newbie ', ''));
    expect((await attempt('newbie@t.io', `newbie-password-${winner}`, { ip: Y })).status).toBe(200);
    expect((await attempt('newbie@t.io', `newbie-password-${(winner + 1) % 6}`, { ip: Y })).status).toBe(401);
  });
});

describe('every auth route has its own limit, and refusals say nothing about the account', () => {
  it('forgot password: one answer for every case, 10 per IP then 429, and the per-address cap is silent', async () => {
    const real = await createUser({ email: 'real@t.io', role: 'VIEWER' });
    const gone = await createUser({ email: 'gone@t.io', role: 'VIEWER' });
    await withDb(ownerDb(), (db) => db.query(`UPDATE users SET status = 'DEACTIVATED', deactivated_at = now() WHERE id = $1`, [gone.id]));
    const ask = (email: string, ip: string) => t.http.post('/api/auth/password/forgot').set('Origin', ORIGIN).set('X-Forwarded-For', ip).send({ email });
    const answers = [await ask(real.email, '198.51.100.1'), await ask(gone.email, '198.51.100.1'), await ask('nobody@t.io', '198.51.100.1'), await ask(real.email, '198.51.100.2'), await ask(real.email, '198.51.100.3'), await ask(real.email, '198.51.100.4')];
    for (const a of answers) {
      expect(a.status).toBe(202);
      expect(a.body).toEqual({ ok: true });
    }
    // Three links an hour per address; the fourth request is answered the same but sends nothing.
    expect(mail.outbox.filter((m) => m.to === real.email)).toHaveLength(3);
    const statuses = [];
    for (let i = 0; i < 9; i++) statuses.push((await ask(`someone-${i}@t.io`, '198.51.100.1')).status);
    expect(statuses.slice(0, 7)).toEqual([202, 202, 202, 202, 202, 202, 202]);
    expect(statuses.slice(7)).toEqual([429, 429]);
  });

  it('reset: 20 tries per IP, then 429 (each try costs an Argon2 hash)', async () => {
    const statuses = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await t.http.post('/api/auth/password/reset').set('Origin', ORIGIN).set('X-Forwarded-For', X).send({ token: 'x'.repeat(43), newPassword: 'a-good-long-password' })).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('invitation check and accept share 20 tries per IP; every bad link gets one message', async () => {
    const bodies = new Set<string>();
    const statuses = [];
    for (let i = 0; i < 21; i++) {
      const path = i % 2 ? 'check' : 'accept';
      const r = await t.http.post(`/api/auth/invite/${path}`).set('Origin', ORIGIN).set('X-Forwarded-For', X)
        .send(path === 'check' ? { token: `${'a'.repeat(40)}${i}` } : { token: i === 0 ? 'short' : `${'b'.repeat(40)}${i}`, displayName: 'N', password: 'a-good-long-password' });
      statuses.push(r.status);
      if (r.status === 400) bodies.add(r.body.message);
    }
    expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect([...bodies]).toEqual(['This invitation link is invalid or has expired. Ask your administrator to send a new one.']);
  });

  it('sign-in links: 20 tries per IP, then 429; every bad link gets one message', async () => {
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await withLink(i % 2 ? 'nope' : `${'c'.repeat(43)}${i}`, X)).status);
    expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('second factor: 5 codes per session, 10 per account; the owner’s trusted device keeps its own budget', async () => {
    const adm = await createUser({ email: 'mfa@t.io', role: 'ADMIN' });
    const device = await trustedDevice(adm);
    // Start the account's budget from zero (setting up the device used one code).
    await t.app.get(RedisService).client.del(`rl:mfa:${adm.id}`);
    const code = (cookie: string, csrf: string, value: string, extra?: string) =>
      t.http.post('/api/auth/mfa/totp/verify').set('Origin', ORIGIN).set('Cookie', extra ? `${cookie}; ${extra}` : cookie).set('X-CSRF-Token', csrf).send({ code: value });
    // Someone with the password (from another device) burns through codes.
    const seen: number[] = [];
    for (let s = 0; s < 3; s++) {
      const r = await attempt(adm.email, adm.password, { ip: `198.51.100.${70 + s}` });
      for (let i = 0; i < 6; i++) seen.push((await code(sessionCookie(r)!, r.body.csrfToken, '000000')).status);
    }
    // Session 1: 5 wrong, then 429. Session 2: 5 wrong (account at 10), then 429. Session 3: account spent.
    expect(seen).toEqual([401, 401, 401, 401, 401, 429, 401, 401, 401, 401, 401, 429, 429, 429, 429, 429, 429, 429]);
    // The owner, on their trusted device, is not locked out of their second factor.
    const r = await attempt(adm.email, adm.password, { ip: Y, cookie: device });
    expect(r.status).toBe(200);
    await withDb(ownerDb(), (db) => db.query('UPDATE users SET totp_last_step = NULL WHERE id = $1', [adm.id]));
    const fin = await code(sessionCookie(r)!, r.body.csrfToken, totpAt(adm.totpSecret!, currentStep()), device); console.log("DBG", fin.status, fin.body, device);
    expect(fin.status).toBe(200);
    // Every wrong code is recorded.
    expect((await auditRows(`action = 'mfa.totp_verify' AND outcome = 'DENIED' AND target_id = $1`, [adm.id])).length).toBe(10);
  });

  it('passkey sign-in shares the second-factor limit', async () => {
    const adm = await createUser({ email: 'pk@t.io', role: 'ADMIN' });
    const r = await attempt(adm.email, adm.password, { ip: Y });
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await t.http.post('/api/auth/mfa/passkeys/verify').set('Origin', ORIGIN).set('Cookie', sessionCookie(r)!).set('X-CSRF-Token', r.body.csrfToken)
        .send({ response: { id: 'x', rawId: 'x', type: 'public-key', response: {} } })).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 400)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('changing the password: 5 tries at the current one per 15 minutes, so a stolen session cannot guess it', async () => {
    const u = await createUser({ email: 'pwc@t.io', role: 'VIEWER' });
    const s = await login(t, u);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await as(t, s).post('/api/auth/password', { currentPassword: `guess-${i}-password`, newPassword: 'a-brand-new-password' })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });
});

describe('sensitive changes end sessions', () => {
  it('a password change ends every session and stops the browsers being trusted devices', async () => {
    const u = await createUser({ email: 'change@t.io', role: 'VIEWER' });
    const other = await login(t, u);
    const device = await trustedDevice(u);
    const s = await login(t, u);
    await as(t, s).post('/api/auth/password', { currentPassword: u.password, newPassword: 'a-brand-new-password' }).expect(204);
    expect((await as(t, other).get('/api/auth/me')).status).toBe(401);
    expect((await as(t, s).get('/api/auth/me')).status).toBe(401);
    await attack(u.email, 12);
    // The old device cookie is no help now, even with the new password.
    expect((await attempt(u.email, 'a-brand-new-password', { ip: Y, cookie: device })).status).toBe(202);
  });
});

describe('client network', () => {
  it('groups IPv4 by /24 and IPv6 by /48, with the IPv6 /64 as one client', () => {
    expect(clientNetwork('203.0.113.7')).toEqual({ ip: '203.0.113.7', client: '203.0.113.7', network: '203.0.113.0/24' });
    expect(clientNetwork('::ffff:203.0.113.7')).toEqual({ ip: '203.0.113.7', client: '203.0.113.7', network: '203.0.113.0/24' });
    expect(clientNetwork('2001:db8:1:2::5')).toMatchObject({ client: '2001:db8:1:2::/64', network: '2001:db8:1::/48' });
    expect(clientNetwork('2001:DB8:1:2:aaaa:bbbb:cccc:dddd')).toMatchObject({ client: '2001:db8:1:2::/64', network: '2001:db8:1::/48' });
    expect(clientNetwork('::1')).toMatchObject({ client: '0:0:0:0::/64', network: '0:0:0::/48' });
    expect(clientNetwork(null)).toEqual({ ip: 'unknown', client: 'unknown', network: 'unknown' });
  });
});
