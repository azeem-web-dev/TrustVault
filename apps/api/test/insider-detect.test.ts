import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Response } from 'express';
import { appDb, as, auditRows, createUser, login, ORIGIN, ownerDb, PDF, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from './helpers.js';
import { AlertGeneratorService } from '../src/risk/alert-generator.service.js';
import { AlertStoreService, type NewAlert } from '../src/risk/alert-store.service.js';
import { DownloadLifecycleService } from '../src/risk/download-lifecycle.service.js';
import { MailService } from '../src/mail/mail.service.js';

// Insider-extraction detection and enforcement (THREATS.md L15-L19, U9-U10,
// S19-S20). Rule inputs are download facts; the tests insert backdated ones
// as the schema owner (the app itself cannot choose their time), then run
// the generator exactly as the scheduler does.

let t: TestApp;
let alice: TestUser, vic: TestUser, admin: TestUser, admin2: TestUser;
let A: Session, V: Session, ADM: Session, ADM2: Session;
let gen: AlertGeneratorService;
let store: AlertStoreService;
let mail: MailService;

beforeAll(async () => {
  t = await startApp({ MAIL_TRANSPORT: 'memory' });
  gen = t.app.get(AlertGeneratorService);
  store = t.app.get(AlertStoreService);
  mail = t.app.get(MailService);
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t.app);
  await withDb(ownerDb(), async (db) => {
    await db.query('TRUNCATE risk_settings');
    // Earlier test files left events behind; start reading from now.
    await db.query('UPDATE alert_generator_state SET last_seq = (SELECT coalesce(max(seq), 0) FROM audit_events) WHERE id = 1');
  });
  mail.outbox.length = 0;
  alice = await createUser({ email: 'alice@t.io', role: 'OWNER' });
  vic = await createUser({ email: 'vic@t.io', role: 'VIEWER' });
  admin = await createUser({ email: 'admin@t.io', role: 'ADMIN' });
  admin2 = await createUser({ email: 'admin2@t.io', role: 'ADMIN' });
  [A, V, ADM, ADM2] = await Promise.all([login(t, alice), login(t, vic), login(t, admin), login(t, admin2)]);
});

/** Inserts `n` backdated downloads for a user, evenly spread over `hours` ending `endHoursAgo` hours ago. */
async function facts(userId: string, n: number, hours: number, opts: { endHoursAgo?: number; docs?: string[]; ip?: string; prefix?: string; sessionId?: string | null } = {}) {
  const end = opts.endHoursAgo ?? 0;
  await withDb(ownerDb(), (db) => db.query(
    `INSERT INTO download_facts (user_id, session_id, document_id, ip, ip_prefix, occurred_at)
     SELECT $1::uuid, $2::uuid,
            CASE WHEN cardinality($3::uuid[]) > 0 THEN ($3::uuid[])[1 + (i % cardinality($3::uuid[]))] ELSE gen_random_uuid() END,
            $4, $5, now() - make_interval(secs => ($6::float8 + ($7::float8 * i / $8::float8)) * 3600 + 1)
       FROM generate_series(0, $8 - 1) AS i`,
    [userId, opts.sessionId ?? null, opts.docs ?? [], opts.ip ?? '198.51.100.7', opts.prefix ?? '198.51.100.0/24', end, hours, n],
  ));
}

async function upload(s: Session, title: string) {
  const res = await as(t, s).upload('/api/documents', PDF, 'letter.pdf', { title, category: 'HR' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function queue(query = '', limit = 200) {
  const res = await as(t, ADM).get(`/api/admin/alert-queue?status=all&limit=${limit}${query}`).expect(200);
  return res.body as { alerts: { id: string; rule: string; severity: string; subjectUserId: string | null; message: string; status: string }[]; total: number; bySeverity: Record<string, number>; nextCursor: string | null };
}

const rulesFor = async (userId: string) => (await queue(`&subjectUserId=${userId}`)).alerts.map((a) => a.rule).sort();

const setLimits = (values: Record<string, number>) =>
  as(t, ADM).put('/api/admin/risk-settings', { values, reason: 'test: tighten limits for this scenario' });

describe('slow and distributed extraction is detected, not only bursts', () => {
  it('15 downloads an hour for three days never trips the hourly rule but trips the day and week rules', async () => {
    await facts(vic.id, 15 * 72, 72);
    await gen.run();
    const rules = await rulesFor(vic.id);
    expect(rules).not.toContain('bulk_download_hour');
    expect(rules).toEqual(expect.arrayContaining(['bulk_download_day', 'bulk_download_week']));
    const week = (await queue(`&subjectUserId=${vic.id}&rule=bulk_download_week`)).alerts[0]!;
    expect(week.severity).toBe('high');
    expect(week.message).toMatch(/vic@t\.io downloaded 10\d\d files within 7 days/);
  });

  it('500 spread across a week (about 3 an hour) is caught by the week rule alone', async () => {
    await facts(vic.id, 500, 7 * 24 - 1);
    await gen.run();
    const rules = await rulesFor(vic.id);
    expect(rules).toContain('bulk_download_week');
    expect(rules).not.toContain('bulk_download_day');
    expect(rules).not.toContain('bulk_download_hour');
  });

  it('a long, slow drain over 30 days is caught by the long window', async () => {
    await withDb(ownerDb(), (db) => db.query(`INSERT INTO risk_settings (key, value) VALUES ('long_alert', 400), ('week_alert', 20000), ('day_alert', 5000)`));
    await facts(vic.id, 450, 29 * 24);
    await gen.run();
    expect(await rulesFor(vic.id)).toEqual(['bulk_download_long']);
  });

  it('far above the person’s own baseline is noticed even under the fixed thresholds', async () => {
    // About 4 a day for 20 days, then 60 today.
    for (let d = 1; d <= 20; d++) await facts(vic.id, 4, 2, { endHoursAgo: d * 24 + 2 });
    await facts(vic.id, 60, 10);
    await gen.run();
    const rules = await rulesFor(vic.id);
    expect(rules).toContain('above_baseline');
    expect(rules).not.toContain('bulk_download_day'); // 60 < 100
  });

  it('far above people with the same role is noticed', async () => {
    const peers = await Promise.all([1, 2, 3].map((i) => createUser({ email: `peer${i}@t.io`, role: 'VIEWER' })));
    for (const p of peers) await facts(p.id, 3, 100);
    await facts(vic.id, 80, 100);
    await gen.run();
    const a = (await queue(`&subjectUserId=${vic.id}&rule=above_peers`)).alerts;
    expect(a).toHaveLength(1);
    expect(a[0]!.message).toMatch(/median for viewer accounts is 3/);
  });

  it('taking most of the documents one can open is noticed', async () => {
    await setLimits({ coverage_min_docs: 5 }).expect(200);
    const docs: string[] = [];
    for (let i = 0; i < 6; i++) docs.push(await upload(A, `doc ${i}`));
    for (const d of docs) await as(t, A).put(`/api/documents/${d}/access`, { userId: vic.id, level: 'READ' }).expect(200);
    await facts(vic.id, 8, 5, { docs: docs.slice(0, 4) });
    await gen.run();
    const a = (await queue(`&subjectUserId=${vic.id}&rule=document_coverage`)).alerts;
    expect(a).toHaveLength(1);
    expect(a[0]!.message).toMatch(/4 of the 6 documents they can open \(67%\)/);
  });

  it('several accounts on one network, each under the personal thresholds, are seen together', async () => {
    const others = await Promise.all([1, 2, 3].map((i) => createUser({ email: `mule${i}@t.io`, role: 'VIEWER' })));
    // Alerts are permanent, so each run uses its own network.
    const net = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    for (const u of [vic, ...others]) await facts(u.id, 40, 20, { ip: `${net}.9`, prefix: `${net}.0/24` });
    await gen.run();
    const a = (await queue('&rule=shared_network_extraction')).alerts.filter((x) => x.message.includes(`(${net}.0/24)`));
    expect(a).toHaveLength(1);
    expect(a[0]!.severity).toBe('high');
    expect(await rulesFor(vic.id)).not.toContain('bulk_download_day');
  });

  it('per-session volume and one session used from two networks are flagged', async () => {
    const sid = randomUUID();
    await facts(vic.id, 30, 3, { sessionId: sid, ip: '198.51.100.7', prefix: '198.51.100.0/24' });
    await facts(vic.id, 30, 3, { sessionId: sid, ip: '192.0.2.44', prefix: '192.0.2.0/24' });
    await gen.run();
    expect(await rulesFor(vic.id)).toEqual(expect.arrayContaining(['session_download_volume', 'session_network_changed']));
  });

  it('downloads at hours of the day the person never used are flagged', async () => {
    // History: 20 days, always within one two-hour slot about 12 hours from now.
    for (let d = 1; d <= 20; d++) await facts(vic.id, 3, 1, { endHoursAgo: d * 24 + 12 });
    await facts(vic.id, 25, 4); // the last four hours: never used before
    await gen.run();
    expect(await rulesFor(vic.id)).toContain('unusual_hours');
  });

  it('dedup: running the generator again does not duplicate an alert', async () => {
    await facts(vic.id, 150, 20);
    await gen.run();
    const first = (await queue(`&subjectUserId=${vic.id}`)).total;
    await gen.run();
    await gen.run();
    expect((await queue(`&subjectUserId=${vic.id}`)).total).toBe(first);
  });
});

describe('hard download limits are enforced before release, audited, and overridable', () => {
  let doc: string;
  beforeEach(async () => {
    doc = await upload(A, 'Board minutes');
    await as(t, A).put(`/api/documents/${doc}/access`, { userId: vic.id, level: 'READ' }).expect(200);
  });

  it('the daily limit refuses with 429 before any byte is sent, and the refusal is audited and alerted', async () => {
    await setLimits({ download_daily_limit: 5 }).expect(200);
    for (let i = 0; i < 5; i++) await as(t, V).get(`/api/documents/${doc}/download`).expect(200);
    const refused = await as(t, V).get(`/api/documents/${doc}/download`).expect(429);
    expect(refused.body.code).toBe('download_limit_daily');
    expect(refused.headers['content-disposition']).toBeUndefined();
    const denied = await auditRows(`action = 'document.download' AND actor_id = $1 AND outcome = 'DENIED'`, [vic.id]);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ reason: 'download_limit_daily' });
    expect(denied[0]!.details).toMatchObject({ usedDay: 5, dailyLimit: 5 });
    const allowed = await auditRows(`action = 'document.download' AND actor_id = $1 AND outcome = 'ALLOWED'`, [vic.id]);
    expect(allowed).toHaveLength(5);
    for (let i = 0; i < 5; i++) await as(t, V).get(`/api/documents/${doc}/download`).expect(429);
    await gen.run();
    const rules = await rulesFor(vic.id);
    expect(rules.filter((r) => r === 'download_limit_hit')).toHaveLength(1); // one per person, kind and day
    expect(rules).not.toContain('repeated_denials');
  });

  it('backdated history counts: 24 hours rolling, not a calendar day', async () => {
    await setLimits({ download_daily_limit: 10 }).expect(200);
    await facts(vic.id, 10, 20, { endHoursAgo: 1 }); // inside the window
    await as(t, V).get(`/api/documents/${doc}/download`).expect(429);
    await withDb(ownerDb(), (db) => db.query(`UPDATE download_facts SET occurred_at = occurred_at - interval '1 day' WHERE user_id = $1`, [vic.id]));
    await as(t, V).get(`/api/documents/${doc}/download`).expect(200);
  });

  it('the per-session limit stops one session; a new sign-in starts a new count', async () => {
    await setLimits({ download_session_limit: 5 }).expect(200);
    for (let i = 0; i < 5; i++) await as(t, V).get(`/api/documents/${doc}/download`).expect(200);
    const r = await as(t, V).get(`/api/documents/${doc}/download`).expect(429);
    expect(r.body.code).toBe('download_limit_session');
    const V2 = await login(t, vic);
    await as(t, V2).get(`/api/documents/${doc}/download`).expect(200);
  });

  it('parallel requests cannot slip past the limit', async () => {
    await setLimits({ download_daily_limit: 5 }).expect(200);
    const results = await Promise.all(Array.from({ length: 12 }, () => as(t, V).get(`/api/documents/${doc}/download`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
    const [c] = await withDb(ownerDb(), async (db) => (await db.query(`SELECT count(*)::int AS n FROM download_facts WHERE user_id = $1`, [vic.id])).rows);
    expect(c.n).toBe(5);
  });

  it('an admin override raises the limit for a while, is audited, expires on its own, and can be revoked', async () => {
    await setLimits({ download_daily_limit: 5 }).expect(200);
    for (let i = 0; i < 5; i++) await as(t, V).get(`/api/documents/${doc}/download`).expect(200);
    await as(t, V).get(`/api/documents/${doc}/download`).expect(429);

    await as(t, ADM).post('/api/admin/download-limits/overrides', { userId: vic.id, dailyLimit: 50, sessionLimit: 50, reason: 'short', expiresAt: new Date(Date.now() + 3_600_000) }).expect(400);
    await as(t, ADM).post('/api/admin/download-limits/overrides', { userId: vic.id, dailyLimit: 50, sessionLimit: 50, reason: 'Quarterly audit export requested by finance (ticket FIN-88)', expiresAt: new Date(Date.now() + 30 * 86_400_000) }).expect(400);
    await as(t, V).post('/api/admin/download-limits/overrides', { userId: vic.id, dailyLimit: 50, sessionLimit: 50, reason: 'Quarterly audit export requested by finance (ticket FIN-88)', expiresAt: new Date(Date.now() + 3_600_000) }).expect(403);
    const o = await as(t, ADM).post('/api/admin/download-limits/overrides', { userId: vic.id, dailyLimit: 50, sessionLimit: 50, reason: 'Quarterly audit export requested by finance (ticket FIN-88)', expiresAt: new Date(Date.now() + 2_500) }).expect(201);
    await as(t, V).get(`/api/documents/${doc}/download`).expect(200);
    const granted = await auditRows(`action = 'download.limit_override' AND target_id = $1`, [vic.id]);
    expect(granted).toHaveLength(1);
    expect(granted[0]!.actor_id).toBe(admin.id);
    await new Promise((r) => setTimeout(r, 3_000));
    await as(t, V).get(`/api/documents/${doc}/download`).expect(429); // expired

    const o2 = await as(t, ADM).post('/api/admin/download-limits/overrides', { userId: vic.id, dailyLimit: 50, sessionLimit: 50, reason: 'Quarterly audit export requested by finance (ticket FIN-88)', expiresAt: new Date(Date.now() + 3_600_000) }).expect(201);
    await as(t, V).get(`/api/documents/${doc}/download`).expect(200);
    await as(t, ADM).post(`/api/admin/download-limits/overrides/${o2.body.id}/revoke`).expect(204);
    await as(t, ADM).post(`/api/admin/download-limits/overrides/${o2.body.id}/revoke`).expect(404);
    await as(t, V).get(`/api/documents/${doc}/download`).expect(429);
    expect(await auditRows(`action = 'download.limit_override_revoke' AND target_id = $1`, [vic.id])).toHaveLength(1);
    const list = await as(t, ADM).get(`/api/admin/download-limits/overrides?userId=${vic.id}`).expect(200);
    expect(list.body.overrides.map((x: { id: string; active: boolean }) => [x.id, x.active])).toEqual(expect.arrayContaining([[o.body.id, false], [o2.body.id, false]]));
  });

  it('the database refuses an override longer than 14 days, for oneself, or edited after the fact', async () => {
    await withDb(appDb(), async (db) => {
      await expect(db.query(`INSERT INTO download_limit_overrides (user_id, daily_limit, session_limit, reason, granted_by, expires_at) VALUES ($1, 10, 10, 'a reason that is long enough', $2, now() + interval '20 days')`, [vic.id, admin.id])).rejects.toThrow(/at most 14 days/);
      await expect(db.query(`INSERT INTO download_limit_overrides (user_id, daily_limit, session_limit, reason, granted_by, expires_at) VALUES ($1, 10, 10, 'a reason that is long enough', $1, now() + interval '1 day')`, [vic.id])).rejects.toThrow(/not_self/);
      const { rows } = await db.query(`INSERT INTO download_limit_overrides (user_id, daily_limit, session_limit, reason, granted_by, expires_at) VALUES ($1, 10, 10, 'a reason that is long enough', $2, now() + interval '1 day') RETURNING id`, [vic.id, admin.id]);
      await expect(db.query(`UPDATE download_limit_overrides SET daily_limit = 99999 WHERE id = $1`, [rows[0].id])).rejects.toThrow(/permission denied/);
      await expect(db.query(`UPDATE download_limit_overrides SET revoked_at = now() WHERE id = $1`, [rows[0].id])).rejects.toThrow(/only be revoked/);
    });
  });

  it('false positive: legitimate bulk work under an override still raises an alert, which a reviewer resolves as benign', async () => {
    await setLimits({ download_daily_limit: 10, download_session_limit: 10 }).expect(200);
    await as(t, ADM).post('/api/admin/download-limits/overrides', { userId: vic.id, dailyLimit: 100, sessionLimit: 100, reason: 'Year-end records review for the auditors, ticket AUD-2026', expiresAt: new Date(Date.now() + 86_400_000) }).expect(201);
    for (let i = 0; i < 25; i++) await as(t, V).get(`/api/documents/${doc}/download`).expect(200);
    await gen.run();
    const hour = (await queue(`&subjectUserId=${vic.id}&rule=bulk_download_hour`)).alerts[0]!;
    expect(hour).toBeDefined();
    const policy = (await queue('&rule=download_limit_override')).alerts[0]!;
    expect(policy.message).toMatch(/admin@t\.io raised the download limit of vic@t\.io to 100/);
    await as(t, ADM2).post(`/api/admin/alert-queue/${hour.id}/resolve`, { resolution: 'benign', note: 'Covered by override for AUD-2026' }).expect(200);
    const after = (await as(t, ADM).get(`/api/admin/alert-queue/${hour.id}`).expect(200)).body;
    expect(after.alert.status).toBe('resolved');
    expect(after.alert.resolution).toBe('benign');
    // Resolved alerts leave the default (active) view but are never gone.
    const active = (await as(t, ADM).get(`/api/admin/alert-queue?subjectUserId=${vic.id}&rule=bulk_download_hour`).expect(200)).body;
    expect(active.total).toBe(0);
    expect((await queue(`&subjectUserId=${vic.id}&rule=bulk_download_hour`)).total).toBe(1);
  });
});

describe('a flood of low alerts cannot hide a critical one or make evidence disappear', () => {
  it('severity-first ordering, complete counts, and pagination through every alert', async () => {
    const low: NewAlert[] = Array.from({ length: 260 }, (_, i) => ({
      rule: 'login_blocked', category: 'auth', severity: i % 2 ? 'low' : 'info', subjectUserId: vic.id, subjectEmail: vic.email,
      dedupKey: `test-flood|${vic.id}|${i}`, message: `noise ${i}`,
    }));
    await store.raise(low.slice(0, 130));
    await store.raise([{ rule: 'file_integrity', category: 'integrity', severity: 'critical', dedupKey: `test-critical|${vic.id}`, message: 'the real incident', subjectUserId: vic.id }]);
    await store.raise(low.slice(130)); // more noise arrives after it
    const first = await queue(`&subjectUserId=${vic.id}`, 20);
    expect(first.alerts[0]!.message).toBe('the real incident');
    expect(first.total).toBe(261);
    expect(first.bySeverity.critical).toBe(1);
    // Walk every page: nothing is cut off at 20.
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = (await as(t, ADM).get(`/api/admin/alert-queue?status=all&subjectUserId=${vic.id}&limit=50${cursor ? `&cursor=${cursor}` : ''}`).expect(200)).body as { alerts: { id: string }[]; nextCursor: string | null };
      for (const a of page.alerts) seen.add(a.id);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(261);
    // Newest-first is available too; the critical one is still found by filter.
    const crit = (await as(t, ADM).get(`/api/admin/alert-queue?status=all&minSeverity=critical&sort=newest`).expect(200)).body;
    expect(crit.alerts.some((a: { message: string }) => a.message === 'the real incident')).toBe(true);
    // The flood itself becomes a high alert about that account.
    await gen.run();
    const flood = (await queue(`&subjectUserId=${vic.id}&rule=alert_flood`)).alerts;
    expect(flood).toHaveLength(1);
    expect(flood[0]!.severity).toBe('high');
    const summary = (await as(t, ADM).get('/api/admin/alert-queue/summary').expect(200)).body;
    expect(summary.unresolvedBySeverity.critical).toBeGreaterThanOrEqual(1);
    expect(summary.generator.stale).toBe(false);
  });

  it('alerts and their history are append-only, even for the table owner', async () => {
    const [a] = await store.raise([{ rule: 'break_glass', category: 'access', severity: 'medium', dedupKey: `test-ao|${vic.id}`, message: 'x', subjectUserId: vic.id }]);
    await as(t, ADM).post(`/api/admin/alert-queue/${a!.id}/acknowledge`, {}).expect(200);
    await withDb(appDb(), async (db) => {
      await expect(db.query(`UPDATE security_alerts SET severity = 'info' WHERE id = $1`, [a!.id])).rejects.toThrow(/permission denied/);
      await expect(db.query(`DELETE FROM security_alerts WHERE id = $1`, [a!.id])).rejects.toThrow(/permission denied/);
      await expect(db.query(`UPDATE security_alert_status SET status = 'resolved' WHERE alert_id = $1`, [a!.id])).rejects.toThrow(/permission denied/);
      await expect(db.query(`DELETE FROM security_alert_events WHERE alert_id = $1`, [a!.id])).rejects.toThrow(/permission denied/);
      await expect(db.query(`INSERT INTO download_facts (user_id, document_id, occurred_at) VALUES ($1, gen_random_uuid(), now() - interval '9 days')`, [vic.id])).rejects.toThrow(/permission denied/);
      await expect(db.query(`UPDATE alert_generator_state SET last_seq = 0 WHERE id = 1`)).rejects.toThrow(/backwards/);
      // Inserting a "resolve" event without a note is refused by the database itself.
      await expect(db.query(`INSERT INTO security_alert_events (alert_id, action, resolution) VALUES ($1, 'resolve', 'benign')`, [a!.id])).rejects.toThrow(/resolution and a note/);
    });
    await withDb(ownerDb(), async (db) => {
      await expect(db.query(`UPDATE security_alerts SET severity = 'info' WHERE id = $1`, [a!.id])).rejects.toThrow(/append-only/);
      await expect(db.query(`DELETE FROM security_alert_events WHERE alert_id = $1`, [a!.id])).rejects.toThrow(/append-only/);
      await expect(db.query(`UPDATE security_alert_status SET status = 'resolved' WHERE alert_id = $1`, [a!.id])).rejects.toThrow(/only through security_alert_events/);
      await expect(db.query(`TRUNCATE security_alerts CASCADE`)).rejects.toThrow(/append-only/);
    });
  });
});

describe('alert review: acknowledge, assign, resolve, with history; admins only', () => {
  it('each step is recorded in the alert history and in the audit log', async () => {
    const [a] = await store.raise([{ rule: 'repeated_denials', category: 'access', severity: 'high', dedupKey: `test-review|${vic.id}`, message: 'refused a lot', subjectUserId: vic.id, subjectEmail: vic.email }]);
    const id = a!.id;
    await as(t, ADM).post(`/api/admin/alert-queue/${id}/resolve`, { resolution: 'benign', note: 'no' }).expect(400);
    await as(t, ADM).post(`/api/admin/alert-queue/${id}/acknowledge`, { note: 'looking' }).expect(200);
    await as(t, ADM).post(`/api/admin/alert-queue/${id}/acknowledge`, {}).expect(409);
    await as(t, ADM).post(`/api/admin/alert-queue/${id}/assign`, { assigneeId: vic.id }).expect(400); // not an admin
    await as(t, ADM).post(`/api/admin/alert-queue/${id}/assign`, { assigneeId: admin2.id, note: 'yours' }).expect(200);
    await as(t, ADM2).post(`/api/admin/alert-queue/${id}/resolve`, { resolution: 'true_positive', note: 'Confirmed: copied files to USB; HR informed' }).expect(200);
    await as(t, ADM2).post(`/api/admin/alert-queue/${id}/resolve`, { resolution: 'benign', note: 'again again' }).expect(409);
    await as(t, ADM).post(`/api/admin/alert-queue/${id}/reopen`, { note: 'More activity seen today' }).expect(200);
    const detail = (await as(t, ADM).get(`/api/admin/alert-queue/${id}`).expect(200)).body;
    expect(detail.alert.status).toBe('open');
    expect(detail.history.map((h: { action: string; statusAfter: string; actorEmail: string }) => [h.action, h.statusAfter, h.actorEmail])).toEqual([
      ['acknowledge', 'acknowledged', 'admin@t.io'],
      ['assign', 'assigned', 'admin@t.io'],
      ['resolve', 'resolved', 'admin2@t.io'],
      ['reopen', 'open', 'admin@t.io'],
    ]);
    const audited = await auditRows(`target_type = 'alert' AND target_id = $1`, [id]);
    expect(audited.map((r) => [r.action, r.actor_id])).toEqual([
      ['alert.acknowledge', admin.id], ['alert.assign', admin.id], ['alert.resolve', admin2.id], ['alert.reopen', admin.id],
    ]);
    expect(audited[2]!.details).toMatchObject({ from: 'assigned', to: 'resolved', resolution: 'true_positive' });
  });

  it('non-admins cannot see or change alerts, settings or overrides', async () => {
    const [a] = await store.raise([{ rule: 'break_glass', category: 'access', severity: 'medium', dedupKey: `test-nonadmin|${vic.id}`, message: 'x' }]);
    for (const s of [A, V]) {
      await as(t, s).get('/api/admin/alert-queue').expect(403);
      await as(t, s).get(`/api/admin/alert-queue/${a!.id}`).expect(403);
      await as(t, s).get('/api/admin/alert-queue/summary').expect(403);
      await as(t, s).post(`/api/admin/alert-queue/${a!.id}/acknowledge`, {}).expect(403);
      await as(t, s).post(`/api/admin/alert-queue/${a!.id}/resolve`, { resolution: 'benign', note: 'nothing here' }).expect(403);
      await as(t, s).get('/api/admin/risk-settings').expect(403);
      await as(t, s).put('/api/admin/risk-settings', { values: { download_daily_limit: 5000 }, reason: 'I want more downloads' }).expect(403);
      await as(t, s).get('/api/admin/download-limits/overrides').expect(403);
      await as(t, s).post('/api/admin/alert-queue/evaluate').expect(403);
    }
    expect((await as(t, ADM).get(`/api/admin/alert-queue/${a!.id}`).expect(200)).body.alert.status).toBe('open');
  });

  it('threshold changes are bounded, audited with before and after, and alert the other admins; the changer cannot close that alert', async () => {
    await as(t, ADM).put('/api/admin/risk-settings', { values: { download_daily_limit: 1_000_000 }, reason: 'effectively turn it off' }).expect(400);
    await as(t, ADM).put('/api/admin/risk-settings', { values: { hour_alert: 1 }, reason: 'below the floor value' }).expect(400);
    await as(t, ADM).put('/api/admin/risk-settings', { values: { no_such: 3 }, reason: 'unknown key here' }).expect(400);
    await as(t, ADM).put('/api/admin/risk-settings', { values: { day_alert: 150 }, reason: 'x' }).expect(400); // reason too short
    const r = await as(t, ADM).put('/api/admin/risk-settings', { values: { day_alert: 150 }, reason: 'Finance team works in bulk at month end' }).expect(200);
    expect(r.body.settings.find((s: { key: string }) => s.key === 'day_alert')).toMatchObject({ value: 150, default: 100, updatedBy: 'admin@t.io' });
    const [ev] = await auditRows(`action = 'alert.policy_change' AND actor_id = $1`, [admin.id]);
    expect(ev!.details).toMatchObject({ changes: { day_alert: { before: 100, after: 150 } }, reason: 'Finance team works in bulk at month end' });
    await gen.run();
    const pol = (await queue(`&rule=alert_policy_changed&subjectUserId=${admin.id}`)).alerts;
    expect(pol).toHaveLength(1);
    await as(t, ADM).post(`/api/admin/alert-queue/${pol[0]!.id}/resolve`, { resolution: 'benign', note: 'my own change' }).expect(403);
    await as(t, ADM).post(`/api/admin/alert-queue/${pol[0]!.id}/assign`, { assigneeId: admin2.id }).expect(403);
    await as(t, ADM2).post(`/api/admin/alert-queue/${pol[0]!.id}/resolve`, { resolution: 'benign', note: 'Agreed with finance lead' }).expect(200);
  });
});

describe('escalation and existing alert kinds', () => {
  it('high and critical alerts are emailed to admins (never to protected demo accounts) and the escalation is in the history', async () => {
    await withDb(ownerDb(), (db) => db.query('UPDATE users SET is_protected = true WHERE id = $1', [admin2.id]));
    await facts(vic.id, 150, 20);
    await gen.run();
    const day = (await queue(`&subjectUserId=${vic.id}&rule=bulk_download_day`)).alerts[0]!;
    expect(day.severity).toBe('high');
    const toAdmin = mail.outbox.filter((m) => m.to === 'admin@t.io' && m.subject.startsWith('[TrustVault HIGH]'));
    expect(toAdmin.length).toBeGreaterThanOrEqual(1);
    expect(toAdmin.some((m) => m.text.includes('vic@t.io downloaded 150 files within 24 hours'))).toBe(true);
    expect(mail.outbox.some((m) => m.to === 'admin2@t.io' && m.subject.startsWith('[TrustVault'))).toBe(false);
    const hist = (await as(t, ADM).get(`/api/admin/alert-queue/${day.id}`).expect(200)).body.history;
    expect(hist).toEqual([expect.objectContaining({ action: 'escalate', actorEmail: 'system', statusAfter: 'open' })]);
  });

  it('events the old alert list showed become persistent alerts too (ended session, break-glass)', async () => {
    const doc = await upload(A, 'Contract');
    await as(t, ADM).post('/api/admin/break-glass', { documentId: doc, reason: 'Legal hold request #4471 from counsel' }).expect(201);
    await as(t, ADM).post(`/api/admin/users/${vic.id}/deactivate`).expect(200);
    await as(t, V).get('/api/documents').expect(401);
    await gen.run();
    const rules = (await queue()).alerts.map((a) => a.rule);
    expect(rules).toEqual(expect.arrayContaining(['break_glass', 'ended_session_used']));
    // The live list keeps working as before.
    const live = (await as(t, ADM).get('/api/admin/alerts').expect(200)).body.alerts as { kind: string }[];
    expect(live.map((a) => a.kind)).toEqual(expect.arrayContaining(['break_glass', 'ended_session_used']));
  });

  it('a failing run is recorded and re-read next time: no event is skipped', async () => {
    const before = (await withDb(ownerDb(), (db) => db.query('SELECT last_seq FROM alert_generator_state'))).rows[0].last_seq;
    const since = new Date(Date.now() - 1000).toISOString();
    const doc = await upload(A, 'Contract 2');
    await as(t, ADM).post('/api/admin/break-glass', { documentId: doc, reason: 'Incident response for ticket SEC-9001' }).expect(201);
    // Break the rule input for one run.
    await withDb(ownerDb(), (db) => db.query('REVOKE SELECT ON download_facts FROM trustvault_app'));
    try {
      await expect(gen.run()).rejects.toThrow();
    } finally {
      await withDb(ownerDb(), (db) => db.query('GRANT SELECT ON download_facts TO trustvault_app'));
    }
    const st = (await withDb(ownerDb(), (db) => db.query('SELECT last_seq, last_error FROM alert_generator_state'))).rows[0];
    expect(st.last_seq).toBe(before);
    expect(st.last_error).toMatch(/permission denied/);
    expect(await auditRows(`action = 'alert.generator' AND outcome = 'FAILED' AND seq > $1`, [before])).toHaveLength(1);
    await gen.run();
    expect((await queue('&rule=break_glass')).alerts.some((a) => a.message.includes('SEC-9001'))).toBe(true);
    expect((await queue(`&rule=alert_generator_failed&from=${since}`)).alerts).toHaveLength(1);
  });
});

describe('sign-in risk: new devices and networks, concurrent sessions', () => {
  const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
  const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
  const signIn = (ip: string, ua: string) =>
    t.http.post('/api/auth/login').set('Origin', ORIGIN).set('X-Forwarded-For', ip).set('User-Agent', ua).send({ email: vic.email, password: vic.password }).expect(200);

  it('a new device and network is alerted and the person is emailed; the usual one is not', async () => {
    // beforeEach signed vic in once from the test client: that is the history.
    await signIn('10.20.30.5', CHROME_WIN);
    await gen.run();
    const unusual = async () => (await queue(`&subjectUserId=${vic.id}&rule=unusual_sign_in`)).alerts;
    expect(await unusual()).toHaveLength(1); // Chrome on Windows was new
    await signIn('10.20.30.77', CHROME_WIN); // same /24, same browser: nothing new
    await gen.run();
    expect(await unusual()).toHaveLength(1);
    mail.outbox.length = 0;
    await signIn('203.0.113.50', FIREFOX_LINUX);
    await gen.run();
    const a = await unusual();
    expect(a).toHaveLength(2);
    expect(a[0]!.severity).toBe('medium');
    expect(a[0]!.message).toMatch(/new device and network \(Firefox on Linux, 203\.0\.113\.0\/24\)/);
    expect(mail.outbox.some((m) => m.to === 'vic@t.io' && /new device and network/.test(m.subject))).toBe(true);
    // A first-ever sign-in has no history to compare with: no alert.
    const nora = await createUser({ email: 'nora@t.io', role: 'VIEWER' });
    await login(t, nora);
    await gen.run();
    expect(await rulesFor(nora.id)).toEqual([]);
  });

  it('the same account live from two networks at once is noted', async () => {
    await as(t, V).post('/api/auth/logout').expect(204);
    await signIn('10.20.30.5', CHROME_WIN);
    await gen.run();
    expect((await queue(`&subjectUserId=${vic.id}&rule=concurrent_sessions`)).alerts).toHaveLength(0);
    await signIn('198.18.0.9', CHROME_WIN);
    await gen.run();
    const c = (await queue(`&subjectUserId=${vic.id}&rule=concurrent_sessions`)).alerts;
    expect(c).toHaveLength(1);
    expect(c[0]!.severity).toBe('medium'); // same kind of device on two networks
    expect(c[0]!.message).toMatch(/10\.20\.30\.0\/24, 198\.18\.0\.0\/24/);
  });
});

describe('download lifecycle: authorized, completed, interrupted', () => {
  it('a download records authorization before the bytes and completion after, under one downloadId', async () => {
    const doc = await upload(A, 'Lifecycle');
    await as(t, A).get(`/api/documents/${doc}/download`).expect(200);
    let done: Record<string, unknown>[] = [];
    for (let i = 0; i < 40 && done.length === 0; i++) {
      done = await auditRows(`action = 'document.download_completed' AND document_id = $1`, [doc]);
      if (!done.length) await new Promise((r) => setTimeout(r, 50));
    }
    const [auth] = await auditRows(`action = 'document.download' AND outcome = 'ALLOWED' AND document_id = $1`, [doc]);
    expect(done).toHaveLength(1);
    expect(Number(auth!.seq)).toBeLessThan(Number(done[0]!.seq));
    expect((done[0]!.details as { downloadId: string }).downloadId).toBe((auth!.details as { downloadId: string }).downloadId);
    expect(done[0]).toMatchObject({ outcome: 'ALLOWED', reason: 'all_bytes_handed_to_network' });
    expect((done[0]!.details as { bytesSent: number }).bytesSent).toBeGreaterThanOrEqual(PDF.length);
  });

  it('a connection closed before the end is recorded as interrupted, once', async () => {
    const lifecycle = t.app.get(DownloadLifecycleService);
    const docId = randomUUID();
    const res = Object.assign(new EventEmitter(), { writableFinished: false, socket: { bytesWritten: 1000 } });
    lifecycle.track(res as unknown as Response, { downloadId: 'dl-interrupted-test', documentId: docId, versionNo: 1, bytes: 5000 });
    res.socket.bytesWritten = 2500;
    res.emit('close');
    res.emit('close');
    let rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 40 && rows.length === 0; i++) {
      rows = await auditRows(`action = 'document.download_interrupted' AND document_id = $1`, [docId]);
      if (!rows.length) await new Promise((r) => setTimeout(r, 50));
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'FAILED', reason: 'connection_closed_early' });
    expect(rows[0]!.details).toMatchObject({ downloadId: 'dl-interrupted-test', fileBytes: 5000, bytesSent: 1500 });
  });
});
