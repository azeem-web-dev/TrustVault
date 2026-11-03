import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MailService } from '../src/mail/mail.service.js';
import { appDb, approved, as, auditRows, createUser, login, ORIGIN, ownerDb, PDF, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from './helpers.js';

// Holes found on 2026-11-02 by an adversarial review and confirmed live
// against a local copy before they were fixed (THREATS.md A17, R7, A15, L10).
// Each test fails if its fix is removed.

let t: TestApp;
let alice: TestUser, bob: TestUser, victor: TestUser, admin: TestUser;
let A: Session, B: Session, V: Session, ADM: Session;

beforeAll(async () => {
  // Mail kept in memory: the stand-in test below reads its invitation.
  t = await startApp({ MAIL_TRANSPORT: 'memory' });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t.app);
  alice = await createUser({ email: 'alice@t.io', role: 'OWNER' });
  bob = await createUser({ email: 'bob@t.io', role: 'OWNER' });
  victor = await createUser({ email: 'victor@t.io', role: 'VIEWER' });
  admin = await createUser({ email: 'admin@t.io', role: 'ADMIN' });
  [A, B, V, ADM] = await Promise.all([login(t, alice), login(t, bob), login(t, victor), login(t, admin)]);
});

async function upload(s: Session, title = 'Salary letter') {
  const res = await as(t, s).upload('/api/documents', PDF, 'letter.pdf', { title, category: 'HR' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}
const grant = (s: Session, docId: string, body: object) => as(t, s).put(`/api/documents/${docId}/access`, body);
const group = async (name: string, members: string[]) => {
  const g = await as(t, ADM).post('/api/admin/groups', { name }).expect(201);
  for (const m of members) await as(t, ADM).post(`/api/admin/groups/${g.body.id}/members`, { userId: m }).expect(204);
  return g.body.id as string;
};

describe('admins never read documents, whatever grants or groups say (A17)', () => {
  it('an admin cannot join a group or be given a grant', async () => {
    const doc = await upload(A);
    const grp = await group('Finance', []);
    await as(t, ADM).post(`/api/admin/groups/${grp}/members`, { userId: ADM.userId }).expect(400);
    await grant(A, doc, { userId: ADM.userId, level: 'READ' }).expect(400);
    await as(t, ADM).get(`/api/documents/${doc}/download`).expect(404);
  });

  it('even with a group membership planted behind the API, both locks refuse the admin', async () => {
    const doc = await upload(A);
    const grp = await group('Finance', []);
    await grant(A, doc, { groupId: grp, level: 'MANAGE' }).expect(200);
    // The database refuses an admin member too; plant one with the guard off,
    // as a bug or an old row would, to test the locks on their own.
    await withDb(ownerDb(), async (db) => {
      await db.query('BEGIN');
      await db.query('ALTER TABLE group_members DISABLE TRIGGER USER');
      await db.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [grp, ADM.userId]);
      await db.query('ALTER TABLE group_members ENABLE TRIGGER USER');
      await db.query('COMMIT');
    });
    await as(t, ADM).get(`/api/documents/${doc}`).expect(404);
    await as(t, ADM).get(`/api/documents/${doc}/download`).expect(404);
    const level = await withDb(appDb(), async (db) => (await db.query('SELECT tv_doc_level($1, $2) AS l', [doc, ADM.userId])).rows[0].l);
    expect(level).toBe(0);
    const seen = await withDb(appDb(), async (db) => {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.user_id', $1, true)`, [ADM.userId]);
      const r = await db.query('SELECT id FROM documents WHERE id = $1', [doc]);
      await db.query('ROLLBACK');
      return r.rowCount;
    });
    expect(seen).toBe(0);
  });

  it('promotion to admin drops the person’s grants and groups, and is refused while they own documents', async () => {
    const doc = await upload(A);
    await group('Finance', [V.userId]);
    await grant(A, doc, { userId: V.userId, level: 'EDIT' }).expect(200);
    await as(t, ADM).patch(`/api/admin/users/${V.userId}`, { role: 'ADMIN' }).expect(200);
    const left = await withDb(ownerDb(), async (db) => (await db.query(
      'SELECT (SELECT count(*) FROM grants WHERE user_id = $1)::int AS g, (SELECT count(*) FROM group_members WHERE user_id = $1)::int AS m', [V.userId])).rows[0]);
    expect(left).toEqual({ g: 0, m: 0 });
    const ev = await auditRows(`action = 'user.update' AND target_id = $1`, [V.userId]);
    expect(ev.at(-1)!.details).toMatchObject({ promotion: { grantsRemoved: 1, groupsLeft: 1 } });
    // Bob owns a document: making him an admin would leave it unreachable.
    await upload(B);
    await as(t, ADM).patch(`/api/admin/users/${B.userId}`, { role: 'ADMIN' }).expect(400);
  });
});

describe('revoking a person leaves them nothing they gave themselves (R7)', () => {
  it('a manager cannot share with a group they belong to, in the API or the database', async () => {
    const doc = await upload(A);
    const grp = await group('Sales', [V.userId]);
    await grant(A, doc, { userId: V.userId, level: 'MANAGE' }).expect(200);
    await grant(V, doc, { groupId: grp, level: 'READ' }).expect(403);
    // Second lock on its own: the same insert straight into the database as Victor.
    const err = await withDb(appDb(), async (db) => {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.user_id', $1, true)`, [V.userId]);
      try {
        await db.query(`INSERT INTO grants (document_id, group_id, level, granted_by_id) VALUES ($1, $2, 'READ', $3)`, [doc, grp, V.userId]);
        return null;
      } catch (e) {
        return (e as Error).message;
      } finally {
        await db.query('ROLLBACK');
      }
    });
    expect(err).toMatch(/group the sharer belongs to/);
    // So revoking Victor really ends it.
    const vg = (await as(t, A).get(`/api/documents/${doc}/access`)).body.grants.find((g: { subject: { id: string } }) => g.subject.id === V.userId);
    const r = await as(t, A).delete(`/api/documents/${doc}/access/${vg.id}`).expect(200);
    expect(r.body.stillHas).toBeNull();
    await as(t, V).get(`/api/documents/${doc}`).expect(404);
  });

  it('the owner can still share with their own group', async () => {
    const doc = await upload(A);
    const grp = await group('Team', [A.userId]);
    await grant(A, doc, { groupId: grp, level: 'READ' }).expect(200);
  });

  it('revoke says when a group grant still covers the person, instead of claiming it ended', async () => {
    const doc = await upload(A);
    const grp = await group('Finance', [V.userId]);
    await grant(A, doc, { groupId: grp, level: 'READ' }).expect(200);
    const g = await grant(A, doc, { userId: V.userId, level: 'EDIT' }).expect(200);
    const r = await as(t, A).delete(`/api/documents/${doc}/access/${g.body.id}`).expect(200);
    expect(r.body.stillHas).toBe('READ');
    const ev = await auditRows(`action = 'access.revoke' AND document_id = $1`, [doc]);
    expect(ev.at(-1)!.details).toMatchObject({ stillHas: 'READ' });
  });

  it('transfer says when the former owner keeps access through a group (A15)', async () => {
    const doc = await upload(A);
    const grp = await group('Team', [A.userId]);
    await grant(A, doc, { groupId: grp, level: 'READ' }).expect(200);
    const r = await as(t, A).post(`/api/documents/${doc}/transfer`, { newOwnerId: B.userId }).expect(200);
    expect(r.body.stillHas).toBe('READ');
    const plain = await upload(A, 'Other');
    expect((await as(t, A).post(`/api/documents/${plain}/transfer`, { newOwnerId: B.userId }).expect(200)).body.stillHas).toBeNull();
  });
});

describe('only the owner decides who a group share reaches (A19)', () => {
  it('an admin’s stand-in account added to a shared group cannot read until the owner confirms', async () => {
    const doc = await upload(A);
    const grp = await group('Finance', [V.userId]);
    await grant(A, doc, { groupId: grp, level: 'READ' }).expect(200);
    await as(t, V).get(`/api/documents/${doc}`).expect(200);
    // The admin invites a mailbox they control, accepts it, and puts the stand-in in the group.
    const pw = 'stand-in-password-123';
    const made = await as(t, ADM).post('/api/admin/users', { email: 'standin@t.io', role: 'VIEWER' }).expect(201);
    // Not before the invitation is accepted: an invited account cannot join a group.
    await as(t, ADM).post(`/api/admin/groups/${grp}/members`, { userId: made.body.user.id }).expect(400);
    const invite = t.app.get(MailService).outbox.filter((m) => m.to === 'standin@t.io').at(-1)!;
    const token = /\/invite#token=([A-Za-z0-9_-]+)/.exec(invite.text)![1];
    await t.http.post('/api/auth/invite/accept').set('Origin', ORIGIN).send({ token, displayName: 'Stand In', password: pw }).expect(204);
    await as(t, ADM).post(`/api/admin/groups/${grp}/members`, { userId: made.body.user.id }).expect(204);
    const W = await login(t, { email: 'standin@t.io', password: pw });
    await as(t, W).get(`/api/documents/${doc}/download`).expect(404);
    expect((await as(t, W).get('/api/documents?scope=shared')).body.total).toBe(0);
    // Second lock on its own.
    expect(await withDb(appDb(), async (db) => (await db.query('SELECT tv_doc_level($1, $2) AS l', [doc, W.userId])).rows[0].l)).toBe(0);
    // The owner sees who is waiting, and confirms.
    const list = (await as(t, A).get(`/api/documents/${doc}/access`)).body.grants;
    expect(list.find((g: { subject: { id: string } }) => g.subject.id === grp).subject).toMatchObject({ members: 2, covered: 1, pending: 1 });
    await grant(A, doc, { groupId: grp, level: 'READ' }).expect(200);
    await as(t, W).get(`/api/documents/${doc}`).expect(200);
    // Removed and added back: waits again.
    await as(t, ADM).delete(`/api/admin/groups/${grp}/members/${W.userId}`).expect(204);
    await as(t, ADM).post(`/api/admin/groups/${grp}/members`, { userId: W.userId }).expect(204);
    await as(t, W).get(`/api/documents/${doc}`).expect(404);
  });
});

describe('roles and ownership stay consistent (A20, A21)', () => {
  it('an owner of documents cannot be demoted to viewer or external', async () => {
    await upload(A);
    await as(t, ADM).patch(`/api/admin/users/${A.userId}`, { role: 'VIEWER' }).expect(400);
    await as(t, ADM).patch(`/api/admin/users/${A.userId}`, { role: 'EXTERNAL', accessExpiresAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(400);
  });

  it('becoming external drops grants and groups, so access must be given again with an expiry', async () => {
    const doc = await upload(A);
    await group('Finance', [V.userId]);
    await grant(A, doc, { userId: V.userId, level: 'EDIT' }).expect(200);
    await as(t, ADM).patch(`/api/admin/users/${V.userId}`, { role: 'EXTERNAL', accessExpiresAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(200);
    const left = await withDb(ownerDb(), async (db) => (await db.query(
      'SELECT (SELECT count(*) FROM grants WHERE user_id = $1)::int AS g, (SELECT count(*) FROM group_members WHERE user_id = $1)::int AS m', [V.userId])).rows[0]);
    expect(left).toEqual({ g: 0, m: 0 });
  });

  it('deactivating an admin ends their open break-glass window', async () => {
    const doc = await upload(A);
    const other = await createUser({ email: 'admin2@t.io', role: 'ADMIN' });
    const ADM2 = await login(t, other);
    const ok = await approved(t, ADM2, ADM, { action: 'BREAK_GLASS', documentId: doc, reason: 'Incident response ticket IR-2207 needs this' });
    await as(t, ADM2).post('/api/admin/break-glass', { documentId: doc, approvalId: ok }).expect(201);
    await as(t, ADM).post(`/api/admin/users/${ADM2.userId}/deactivate`).expect(200);
    const open = await withDb(ownerDb(), async (db) => (await db.query('SELECT count(*)::int AS n FROM break_glass WHERE admin_id = $1 AND expires_at > now()', [ADM2.userId])).rows[0].n);
    expect(open).toBe(0);
  });

  it('a break-glass row cannot be made to last longer than an hour, even straight in the database', async () => {
    const doc = await upload(A);
    const ADM2 = await login(t, await createUser({ email: 'admin2@t.io', role: 'ADMIN' }));
    const ok = await approved(t, ADM, ADM2, { action: 'BREAK_GLASS', documentId: doc });
    const err = await withDb(appDb(), async (db) => {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.user_id', $1, true)`, [ADM.userId]);
      try {
        // A genuinely approved request, used in this transaction: only the hour is wrong.
        await db.query('UPDATE admin_approvals SET consumed_at = now() WHERE id = $1', [ok]);
        await db.query(`INSERT INTO break_glass (id, admin_id, document_id, reason, expires_at, created_at, approval_id) VALUES (gen_random_uuid(), $1, $2, 'a long enough reason here', now() + interval '30 days', now() + interval '29 days 23 hours', $3)`, [ADM.userId, doc, ok]);
        return null;
      } catch (e) {
        return (e as Error).message;
      } finally {
        await db.query('ROLLBACK');
      }
    });
    expect(err).toMatch(/one hour/);
  });
});

describe('sessions cannot outlive the credentials that made them (R9)', () => {
  it('extending an external’s lapsed access does not revive their old session', async () => {
    const ext = await createUser({ email: 'ext@partner.io', role: 'EXTERNAL', accessExpiresAt: new Date(Date.now() + 86_400_000) });
    const X = await login(t, ext);
    await withDb(ownerDb(), (db) => db.query(`UPDATE users SET access_expires_at = now() - interval '1 minute' WHERE id = $1`, [X.userId]));
    await as(t, ADM).patch(`/api/admin/users/${X.userId}`, { accessExpiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }).expect(200);
    await as(t, X).get('/api/documents').expect(401);
  });
});

describe('attempts after access ended are in the record (L10)', () => {
  it('a deactivated user trying again is audited once, with why the session ended', async () => {
    const doc = await upload(A);
    await grant(A, doc, { userId: V.userId, level: 'READ' }).expect(200);
    await as(t, ADM).post(`/api/admin/users/${V.userId}/deactivate`).expect(200);
    for (let i = 0; i < 3; i++) await as(t, V).get(`/api/documents/${doc}/download`).expect(401);
    const rows = await auditRows(`action = 'auth.session_rejected' AND actor_id = $1`, [V.userId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'DENIED', reason: 'deactivated' });
  });

  it('an ended session being used raises an alert', async () => {
    await as(t, ADM).post(`/api/admin/users/${V.userId}/deactivate`).expect(200);
    await as(t, V).get('/api/documents').expect(401);
    const alerts = (await as(t, ADM).get('/api/admin/alerts').expect(200)).body.alerts as { kind: string; message: string }[];
    expect(alerts.find((a) => a.kind === 'ended_session_used')?.message).toMatch(/victor@t\.io.*deactivated/);
  });

  it('an admin resetting a second factor and that account then signing in raises an alert (S15)', async () => {
    await as(t, ADM).post(`/api/admin/users/${V.userId}/mfa/reset`).expect(204);
    await login(t, victor);
    const alerts = (await as(t, ADM).get('/api/admin/alerts').expect(200)).body.alerts as { kind: string; message: string }[];
    expect(alerts.find((a) => a.kind === 'reset_then_sign_in')?.message).toMatch(/victor@t\.io signed in after admin@t\.io reset their second factor/);
  });

  it('a cookie used after logout is refused and recorded as such', async () => {
    const s = await login(t, bob);
    await as(t, s).post('/api/auth/logout').expect(204);
    await as(t, s).get('/api/documents').expect(401);
    const rows = await auditRows(`action = 'auth.session_rejected' AND actor_id = $1`, [bob.id]);
    expect(rows.at(-1)).toMatchObject({ reason: 'logged_out' });
  });
});
