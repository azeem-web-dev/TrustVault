import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MailService } from '../src/mail/mail.service.js';
import { appDb, auditRows, ORIGIN, ownerDb, resetState, startApp, withDb, type TestApp } from './helpers.js';

// Android beta signup (POST /beta/signup). MAIL_TRANSPORT=memory: nothing is sent.

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

let n = 0;
// Each call comes from its own address in a distinct /24, so the per-IP caps do not interfere.
const signup = (email: unknown, ip = `198.51.${++n % 250}.9`) =>
  t.http.post('/api/beta/signup').set('Origin', ORIGIN).set('X-Forwarded-For', ip).send({ email });
const sentTo = (email: string) => mail.outbox.filter((m) => m.to === email);

describe('beta signup', () => {
  it('answers the same for a new and a repeat address, and emails once', async () => {
    const first = await signup('Fan@T.io').expect(202);
    const again = await signup('fan@t.io').expect(202);
    expect(first.body).toEqual({ ok: true });
    expect(again.body).toEqual(first.body);
    const msgs = sentTo('fan@t.io');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.subject).toBe('Join the TrustVault Android beta');
    for (const u of ['https://groups.google.com/g/trust-vault-beta-users', 'https://play.google.com/apps/testing/cloud.rayyanazeem.trustvault', 'https://play.google.com/store/apps/details?id=cloud.rayyanazeem.trustvault']) {
      expect(msgs[0]!.text).toContain(u);
    }
    const rows = await withDb(ownerDb(), async (db) => (await db.query(`SELECT email, email_count FROM beta_signups`)).rows);
    expect(rows).toEqual([{ email: 'fan@t.io', email_count: 1 }]);
  });

  it('emails again after 24 hours', async () => {
    await signup('fan@t.io').expect(202);
    await withDb(ownerDb(), (db) => db.query(`UPDATE beta_signups SET last_emailed_at = now() - interval '25 hours'`));
    await signup('fan@t.io').expect(202);
    expect(sentTo('fan@t.io')).toHaveLength(2);
  });

  it('rejects a malformed or oversized email with 400', async () => {
    await signup('not-an-email').expect(400);
    await signup(`${'a'.repeat(250)}@t.io`).expect(400);
    await signup(42).expect(400);
    expect(mail.outbox).toHaveLength(0);
  });

  it('limits per IP with 429, and per address silently', async () => {
    for (let i = 0; i < 5; i++) await signup(`u${i}@t.io`, '203.0.113.5').expect(202);
    await signup('u9@t.io', '203.0.113.5').expect(429);
    // One address from many networks: always 202, never more than one email.
    for (let i = 0; i < 5; i++) await signup('same@t.io').expect(202);
    expect(sentTo('same@t.io')).toHaveLength(1);
  });

  it('audits without the address', async () => {
    const r = await signup('secret@t.io').expect(202);
    expect(r.body).toEqual({ ok: true });
    const rows = await auditRows(`action = 'beta.signup' AND created_at > now() - interval '1 minute'`);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('secret@t.io');
  });

  it('table grants: the app role can add and read, never delete or rewrite an address', async () => {
    await withDb(appDb(), async (db) => {
      await db.query(`INSERT INTO beta_signups (email) VALUES ('g@t.io')`);
      expect((await db.query(`SELECT count(*)::int AS n FROM beta_signups`)).rows[0].n).toBeGreaterThan(0);
      await db.query(`UPDATE beta_signups SET email_count = 2`);
      await expect(db.query(`DELETE FROM beta_signups`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`UPDATE beta_signups SET email = 'x@t.io'`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`INSERT INTO beta_signups (email) VALUES ('UPPER@t.io')`)).rejects.toThrow(/beta_signups_email_lower/);
    });
  });
});
