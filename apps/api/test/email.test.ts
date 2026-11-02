import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MailService } from '../src/mail/mail.service.js';
import { as, auditRows, createUser, login, ORIGIN, ownerDb, PDF, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from './helpers.js';

// Password reset by email and account notices (THREATS.md S15, S16, S17).
// MAIL_TRANSPORT=memory: messages are kept in MailService.outbox, never sent.

let t: TestApp;
let mail: MailService;
let alice: TestUser, victor: TestUser, admin: TestUser;
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
  victor = await createUser({ email: 'victor@t.io', role: 'VIEWER' });
  admin = await createUser({ email: 'admin@t.io', role: 'ADMIN' });
  [A, ADM] = await Promise.all([login(t, alice), login(t, admin)]);
  await settle(); // let the sign-in notices from these logins arrive first
  mail.outbox.length = 0;
});

const forgot = (email: string, headers: Record<string, string> = {}) => {
  let r = t.http.post('/api/auth/password/forgot').set('Origin', ORIGIN);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send({ email });
};
const reset = (token: string, newPassword: string) => t.http.post('/api/auth/password/reset').set('Origin', ORIGIN).send({ token, newPassword });
const tokenIn = (text: string) => /\/reset#token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null;
const sentTo = (email: string) => mail.outbox.filter((m) => m.to === email);
const resets = (email: string) => sentTo(email).filter((m) => /reset your/i.test(m.subject));
// The database's clock, not this machine's: audit times come from the database.
const dbNow = () => withDb(ownerDb(), async (db) => (await db.query('SELECT now() AS t')).rows[0].t as Date);
const settle = () => new Promise((r) => setTimeout(r, 150)); // notices are sent after the response

describe('asking for a reset link reveals nothing', () => {
  it('answers the same for an unknown email and a real one, and only the real one gets mail', async () => {
    const since = await dbNow();
    const unknown = await forgot('nobody@t.io').expect(202);
    const real = await forgot('victor@t.io').expect(202);
    expect(unknown.body).toEqual(real.body);
    expect(sentTo('nobody@t.io')).toHaveLength(0);
    expect(resets('victor@t.io')).toHaveLength(1);
    const rows = await auditRows(`action = 'auth.reset_requested' AND occurred_at >= $1`, [since]);
    expect(rows.map((r) => r.reason)).toEqual(['no_account', 'sent']);
  });

  it('builds the link from the configured site, never from the Host header', async () => {
    await forgot('victor@t.io', { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example' }).expect(202);
    const m = resets('victor@t.io')[0]!;
    expect(m.text).toContain('https://vault.test/reset#token=');
    expect(m.text + m.html).not.toContain('evil.example');
  });

  it('demo (protected) accounts never get mail and cannot be reset', async () => {
    await withDb(ownerDb(), (db) => db.query(`UPDATE users SET is_protected = true WHERE id = $1`, [victor.id]));
    await forgot('victor@t.io').expect(202);
    expect(mail.outbox).toHaveLength(0);
    const r = await as(t, ADM).post(`/api/admin/users/${victor.id}/reset-link`).expect(202);
    expect(r.body).toEqual({ ok: true, sent: false });
  });

  it('stops sending after three requests an hour for one address, still answering 202', async () => {
    for (let i = 0; i < 5; i++) await forgot('victor@t.io').expect(202);
    expect(resets('victor@t.io')).toHaveLength(3);
  });
});

describe('a reset link works once, for a short time, and signs out everywhere', () => {
  it('sets the password, ends every session, and tells the person', async () => {
    const since = await dbNow();
    const V = await login(t, victor);
    await forgot('victor@t.io').expect(202);
    const token = tokenIn(resets('victor@t.io')[0]!.text)!;
    expect(token).toBeTruthy();
    await reset(token, 'a-completely-new-password').expect(204);
    await as(t, V).get('/api/documents').expect(401);
    await login(t, { email: victor.email, password: 'a-completely-new-password' });
    await settle();
    expect(sentTo('victor@t.io').some((m) => /password was changed/i.test(m.subject))).toBe(true);
    // Used once: never again.
    await reset(token, 'another-new-password-123').expect(400);
    const rows = await auditRows(`action = 'auth.password_reset_link' AND occurred_at >= $1`, [since]);
    expect(rows.map((r) => `${r.outcome}:${r.reason ?? ''}`)).toEqual(['ALLOWED:', 'DENIED:link_used']);
  });

  it('an expired link is refused', async () => {
    await forgot('victor@t.io').expect(202);
    const token = tokenIn(resets('victor@t.io')[0]!.text)!;
    await withDb(ownerDb(), (db) => db.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'`));
    await reset(token, 'a-completely-new-password').expect(400);
  });

  it('asking again cancels the earlier link', async () => {
    await forgot('victor@t.io').expect(202);
    await forgot('victor@t.io').expect(202);
    const [first, second] = resets('victor@t.io').map((m) => tokenIn(m.text)!);
    await reset(first!, 'a-completely-new-password').expect(400);
    await reset(second!, 'a-completely-new-password').expect(204);
  });

  it('a made-up or malformed link is refused and recorded; a weak password is refused', async () => {
    await reset('x'.repeat(43), 'a-completely-new-password').expect(400);
    await reset('../../etc', 'a-completely-new-password').expect(400);
    await forgot('victor@t.io').expect(202);
    await reset(tokenIn(resets('victor@t.io')[0]!.text)!, 'short').expect(400);
    expect((await auditRows(`action = 'auth.password_reset_link' AND outcome = 'DENIED'`)).length).toBeGreaterThanOrEqual(2);
  });

  it('only a hash of the link is stored', async () => {
    await forgot('victor@t.io').expect(202);
    const token = tokenIn(resets('victor@t.io')[0]!.text)!;
    const stored = await withDb(ownerDb(), async (db) => (await db.query(`SELECT encode(token_hash, 'hex') AS h FROM password_reset_tokens`)).rows[0].h as string);
    expect(stored).not.toContain(Buffer.from(token).toString('hex'));
    expect(stored).toHaveLength(64);
  });
});

describe('admins send links instead of choosing passwords (S15)', () => {
  it('emails the person a link; the admin gets no token and never sees the password', async () => {
    const r = await as(t, ADM).post(`/api/admin/users/${victor.id}/reset-link`).expect(202);
    expect(r.body).toEqual({ ok: true, sent: true });
    expect(JSON.stringify(r.body)).not.toMatch(/token/i);
    const m = resets('victor@t.io')[0]!;
    expect(m.text).toMatch(/administrator asked/);
    expect((await auditRows(`action = 'user.reset_link_sent' AND target_id = $1`, [victor.id]))[0]).toMatchObject({ outcome: 'ALLOWED', actor_id: admin.id });
  });

  it('non-admins cannot send reset links', async () => {
    await as(t, A).post(`/api/admin/users/${victor.id}/reset-link`).expect(403);
    expect(mail.outbox).toHaveLength(0);
  });
});

describe('account notices', () => {
  it('a sign-in sends a notice; with a second factor it is sent only once that step succeeds', async () => {
    await login(t, victor);
    await settle();
    expect(sentTo('victor@t.io').some((m) => /new sign-in/i.test(m.subject))).toBe(true);
    // The admin signed in (with TOTP) in beforeEach, before the outbox was cleared: sign in again.
    await login(t, admin);
    await settle();
    expect(sentTo('admin@t.io').filter((m) => /new sign-in/i.test(m.subject))).toHaveLength(1);
  });

  it('sharing with a person tells them; the email names the document only to them', async () => {
    const up = await as(t, A).upload('/api/documents', PDF, 'a.pdf', { title: 'Offer letter', category: 'HR' }).expect(201);
    await as(t, A).put(`/api/documents/${up.body.id}/access`, { userId: victor.id, level: 'READ' }).expect(200);
    await settle();
    const m = sentTo('victor@t.io').find((x) => /shared a document/.test(x.subject))!;
    expect(m.text).toContain('Offer letter');
    expect(m.text).toContain(`https://vault.test/documents/${up.body.id}`);
    expect(mail.outbox.filter((x) => x.to !== 'victor@t.io' && /shared/.test(x.subject))).toHaveLength(0);
  });

  it('an admin resetting someone’s second factor tells them', async () => {
    const other = await createUser({ email: 'two@t.io', role: 'VIEWER', mfa: true });
    await as(t, ADM).post(`/api/admin/users/${other.id}/mfa/reset`).expect(204);
    await settle();
    expect(sentTo('two@t.io').some((m) => /security changed/.test(m.subject))).toBe(true);
  });

  it('nothing is sent when mail is off', () => {
    const off = new MailService({ MAIL_TRANSPORT: 'off' } as never);
    expect(off.send({ email: 'victor@t.io', displayName: 'V', isProtected: false }, { subject: 's', text: 't', html: 'h' })).toBe(false);
    expect(off.outbox).toHaveLength(0);
  });
});
