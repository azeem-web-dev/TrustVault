import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MailService } from '../src/mail/mail.service.js';
import { as, auditRows, createUser, login, ownerDb, PDF, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from './helpers.js';

// Screen-capture attempts on view-only pages (THREATS.md V11). A browser
// cannot block an OS screenshot; the web viewer reports the key presses
// that usually start one, and the owner hears about it. The viewer learns
// nothing from the answer. MAIL_TRANSPORT=memory keeps mail in an outbox.

let t: TestApp;
let mail: MailService;
let alice: TestUser, victor: TestUser, rita: TestUser;
let A: Session, V: Session, R: Session;
let doc: string;
let grantId: string;

beforeAll(async () => {
  t = await startApp({ MAIL_TRANSPORT: 'memory' });
  mail = t.app.get(MailService);
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t.app);
  alice = await createUser({ email: 'alice@cap.io', role: 'OWNER', displayName: 'Alice Owner' });
  victor = await createUser({ email: 'victor@cap.io', role: 'VIEWER', displayName: 'Victor Viewer' });
  rita = await createUser({ email: 'rita@cap.io', role: 'VIEWER' });
  [A, V, R] = await Promise.all([login(t, alice), login(t, victor), login(t, rita)]);
  const up = await as(t, A).upload('/api/documents', PDF, 'plan.pdf', { title: 'Merger plan', category: 'Board' });
  expect(up.status, JSON.stringify(up.body)).toBe(201);
  doc = up.body.id as string;
  grantId = (await as(t, A).put(`/api/documents/${doc}/access`, { userId: victor.id, level: 'VIEW' }).expect(200)).body.id as string;
  await settle();
  mail.outbox.length = 0;
});

const settle = () => new Promise((r) => setTimeout(r, 150)); // notices are sent after the response
const report = (s: Session, id: string, body: object) => as(t, s).post(`/api/documents/${id}/capture-attempt`, body);
const captures = (id: string) => auditRows(`document_id = $1 AND action = 'document.capture_attempt' AND outcome = 'ALLOWED'`, [id]);
const alertsFor = (userId: string) =>
  withDb(ownerDb(), async (db) => (await db.query(`SELECT id::text, rule, category, severity, document_id::text AS doc, audit_seq::text AS seq, message FROM security_alerts WHERE rule = 'capture_attempt' AND subject_user_id = $1`, [userId])).rows);
const sansId = (b: Record<string, unknown>) => { const { requestId: _r, ...rest } = b; void _r; return rest; };
const captureMails = () => mail.outbox.filter((m) => /tried to capture/i.test(m.subject));

describe('a viewer who presses a capture key is reported, silently', () => {
  it('records an audit row, raises one alert and emails the owner, never the viewer', async () => {
    const res = await report(V, doc, { method: 'printscreen', page: 2 }).expect(204);
    expect(res.text).toBe('');
    expect(res.headers['content-length'] ?? '0').toBe('0');

    const rows = await captures(doc);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: victor.id, actor_email: 'victor@cap.io', reason: 'printscreen' });
    expect(rows[0]!.details).toMatchObject({ method: 'printscreen', page: 2, access: 'grant' });

    const alerts = await alertsFor(victor.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ rule: 'capture_attempt', category: 'extraction', severity: 'medium', doc, seq: String(rows[0]!.seq) });

    await settle();
    const sent = captureMails();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('alice@cap.io');
    expect(sent[0]!.subject).toBe('Someone tried to capture “Merger plan”');
    expect(sent[0]!.text).toContain('Victor Viewer (victor@cap.io)');
    expect(sent[0]!.text).toContain('Print Screen');
    expect(sent[0]!.text).toContain(`https://vault.test/documents/${doc}#history`);
    expect(mail.outbox.some((m) => m.to === 'victor@cap.io')).toBe(false);
  });

  it('shows in the owner’s History of the document and in the admin audit trail', async () => {
    await report(V, doc, { method: 'snip_shortcut' }).expect(204);
    const h = await as(t, A).get(`/api/documents/${doc}/history`).expect(200);
    expect(h.body.events).toContainEqual(expect.objectContaining({ action: 'document.capture_attempt', actorEmail: 'victor@cap.io', outcome: 'ALLOWED', reason: 'snip_shortcut' }));
  });

  it('the viewer’s answer is the same empty 204 for a first report, a repeat and a report whose mail is skipped', async () => {
    const first = await report(V, doc, { method: 'printscreen' }).expect(204);
    const again = await report(V, doc, { method: 'mac_shortcut' }).expect(204);
    const own = await report(A, doc, { method: 'print_shortcut' }).expect(204);
    for (const r of [first, again, own]) {
      expect(r.text).toBe('');
      expect(r.headers['set-cookie']).toBeUndefined();
    }
  });
});

describe('only someone who can see the pages can report', () => {
  it('no access: the same 404 as any document route, nothing recorded as a capture, no alert, no mail', async () => {
    const view = await as(t, R).get(`/api/documents/${doc}`).expect(404);
    const res = await report(R, doc, { method: 'printscreen' }).expect(404);
    expect(sansId(res.body)).toEqual(sansId(view.body));
    const missing = await report(R, '6f1c2b8e-4a5d-4e3f-9a1b-2c3d4e5f6a7b', { method: 'printscreen' }).expect(404);
    expect(sansId(missing.body)).toEqual(sansId(view.body));
    expect(await captures(doc)).toHaveLength(0);
    expect(await alertsFor(rita.id)).toHaveLength(0);
    await settle();
    expect(captureMails()).toHaveLength(0);
    // The refusal itself is audited like any other.
    const refused = await auditRows(`document_id = $1 AND actor_id = $2 AND action = 'document.capture_attempt' AND outcome = 'DENIED'`, [doc, rita.id]);
    expect(refused.map((r) => r.reason)).toEqual(['no_grant']);
  });

  it('after a revoke the next report is refused', async () => {
    await as(t, A).delete(`/api/documents/${doc}/access/${grantId}`).expect(200);
    await report(V, doc, { method: 'printscreen' }).expect(404);
    expect(await captures(doc)).toHaveLength(0);
  });

  it('refuses unknown fields, unknown methods and silly pages', async () => {
    await report(V, doc, { method: 'printscreen', extra: 1 }).expect(400);
    await report(V, doc, { method: 'camera' }).expect(400);
    await report(V, doc, { method: 'printscreen', page: 0 }).expect(400);
    await report(V, doc, {}).expect(400);
    expect(await captures(doc)).toHaveLength(0);
  });

  it('needs a signed-in session and the CSRF token', async () => {
    await t.http.post(`/api/documents/${doc}/capture-attempt`).set('Origin', 'https://vault.test').send({ method: 'printscreen' }).expect(401);
    await t.http.post(`/api/documents/${doc}/capture-attempt`).set('Cookie', V.cookie).set('Origin', 'https://vault.test').send({ method: 'printscreen' }).expect(403);
    expect(await captures(doc)).toHaveLength(0);
  });
});

describe('no spam', () => {
  it('one alert and one email per viewer and document per hour; later attempts are attached and audited', async () => {
    await report(V, doc, { method: 'printscreen' }).expect(204);
    await report(V, doc, { method: 'snip_shortcut' }).expect(204);
    await Promise.all([report(V, doc, { method: 'mac_shortcut' }), report(V, doc, { method: 'mac_shortcut' })]);
    expect(await captures(doc)).toHaveLength(4);
    const alerts = await alertsFor(victor.id);
    expect(alerts).toHaveLength(1);
    const notes = await withDb(ownerDb(), async (db) => (await db.query(`SELECT action, note FROM security_alert_events WHERE alert_id = $1 ORDER BY id`, [alerts[0]!.id])).rows);
    expect(notes.filter((n) => n.action === 'comment')).toHaveLength(3);
    await settle();
    expect(captureMails()).toHaveLength(1);

    // An hour later (the alert is moved back), the next attempt alerts and mails again.
    await withDb(ownerDb(), (db) => db.query(`ALTER TABLE security_alerts DISABLE TRIGGER USER`).then(() =>
      db.query(`UPDATE security_alerts SET created_at = now() - interval '61 minutes' WHERE id = $1`, [alerts[0]!.id])).finally(() =>
      db.query(`ALTER TABLE security_alerts ENABLE TRIGGER USER`)));
    await report(V, doc, { method: 'printscreen' }).expect(204);
    expect(await alertsFor(victor.id)).toHaveLength(2);
    await settle();
    expect(captureMails()).toHaveLength(2);
  });

  it('a second document is its own alert and email', async () => {
    const up = await as(t, A).upload('/api/documents', PDF, 'other.pdf', { title: 'Other plan', category: 'Board' });
    const other = up.body.id as string;
    await as(t, A).put(`/api/documents/${other}/access`, { userId: victor.id, level: 'VIEW' }).expect(200);
    await report(V, doc, { method: 'printscreen' }).expect(204);
    await report(V, other, { method: 'printscreen' }).expect(204);
    expect(await alertsFor(victor.id)).toHaveLength(2);
    await settle();
    expect(captureMails().map((m) => m.subject).sort()).toEqual(['Someone tried to capture “Merger plan”', 'Someone tried to capture “Other plan”']);
  });

  it('is rate limited per person', async () => {
    for (let i = 0; i < 20; i++) await report(V, doc, { method: 'printscreen' }).expect(204);
    const r = await report(V, doc, { method: 'printscreen' }).expect(429);
    expect(r.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(await captures(doc)).toHaveLength(20);
  });

  it('the owner capturing their own document is recorded but not alerted or mailed', async () => {
    await report(A, doc, { method: 'printscreen' }).expect(204);
    expect(await captures(doc)).toHaveLength(1);
    expect(await alertsFor(alice.id)).toHaveLength(0);
    await settle();
    expect(captureMails()).toHaveLength(0);
  });

  it('a demo (protected) owner is never mailed; the alert is still raised', async () => {
    await withDb(ownerDb(), (db) => db.query(`UPDATE users SET is_protected = true WHERE id = $1`, [alice.id]));
    await report(V, doc, { method: 'printscreen' }).expect(204);
    expect(await alertsFor(victor.id)).toHaveLength(1);
    await settle();
    expect(captureMails()).toHaveLength(0);
  });
});
