import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { Response } from 'supertest';
import { as, auditRows, createUser, login, ownerDb, appDb, PDF, resetState, startApp, withDb, type Session, type TestApp } from './helpers.js';

// Downloads and the changes that take access away happen in one order
// (THREATS.md R11). Real concurrency: requests run in parallel against the
// real database, and the test pauses them by holding the same advisory locks
// the code takes (the audit chain's lock, a document's or a person's), then
// lets go and checks who won and that the audit log tells it in that order.

const AUDIT_LOCK = 7310001; // audit_chain_before_insert()
const USER_LOCK_CLASS = 7310100; // tv_lock_user()

let t: TestApp;
let A: Session, V: Session, W: Session, ADM: Session;

beforeAll(async () => {
  t = await startApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t.app);
  const [alice, victor, wendy, admin] = await Promise.all([
    createUser({ email: 'alice@t.io', role: 'OWNER' }),
    createUser({ email: 'victor@t.io', role: 'VIEWER' }),
    createUser({ email: 'wendy@t.io', role: 'VIEWER' }),
    createUser({ email: 'admin@t.io', role: 'ADMIN' }),
  ]);
  [A, V, W, ADM] = await Promise.all([login(t, alice), login(t, victor), login(t, wendy), login(t, admin)]);
});

async function upload(s: Session, title = 'Board minutes') {
  const res = await as(t, s).upload('/api/documents', PDF, 'minutes.pdf', { title, category: 'Board' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}
const share = (docId: string, body: object) => as(t, A).put(`/api/documents/${docId}/access`, body);
const grantId = async (docId: string, userId: string) =>
  ((await as(t, A).get(`/api/documents/${docId}/access`)).body.grants as { id: string; subject: { id: string } }[]).find((g) => g.subject.id === userId)!.id;
/** Starts the request now (supertest is lazy) and resolves with its response. */
const start = (req: PromiseLike<Response>): Promise<Response> => Promise.resolve(req.then((r) => r));

/** A separate owner connection that holds advisory locks until released. */
const open: pg.Client[] = [];
async function holder(): Promise<pg.Client & { release: () => Promise<void> }> {
  const c = ownerDb();
  await c.connect();
  open.push(c);
  return Object.assign(c, { release: async () => { open.splice(open.indexOf(c), 1); await c.query('SELECT pg_advisory_unlock_all()'); await c.end(); } });
}
// A failed test must not leave a lock held for the next one.
afterEach(async () => {
  for (const c of open.splice(0)) await c.end().catch(() => undefined);
});

/** Waits until `n` advisory lock requests in this database are queued (not granted). */
async function waiters(n: number, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const got = await withDb(ownerDb(), async (db) => Number((await db.query(
      `SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0].n));
    if (got >= n) return;
    if (Date.now() > until) throw new Error(`expected ${n} waiting lock requests, saw ${got}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Is someone waiting for this document's lock (in any mode)? */
async function waitingOnDoc(docId: string): Promise<boolean> {
  return withDb(ownerDb(), async (db) => (await db.query(
    `SELECT 1 FROM pg_locks l WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended($1::text, 0)`, [docId])).rowCount! > 0);
}

/** The audit rows of one document, oldest first, as [action, outcome, actor email]. */
async function story(docId: string) {
  return (await auditRows('document_id = $1', [docId])).map((r) => ({
    seq: Number(r.seq), action: r.action as string, outcome: r.outcome as string, reason: r.reason as string | null,
    actor: r.actor_email as string, details: r.details as Record<string, unknown> | null, at: r.occurred_at as Date,
  }));
}

describe('a download and a revoke never overlap (R11)', () => {
  it('a download decided after the revoke commits is refused, and recorded after it', async () => {
    const doc = await upload(A);
    await share(doc, { userId: V.userId, level: 'READ' }).expect(200);
    const gid = await grantId(doc, V.userId);

    // The revoke gets as far as its audit row and waits there, holding the
    // document's lock; then Victor's download starts.
    const audit = await holder();
    await audit.query('SELECT pg_advisory_lock($1)', [AUDIT_LOCK]);
    const revoke = start(as(t, A).delete(`/api/documents/${doc}/access/${gid}`));
    await waiters(1);
    const download = start(as(t, V).get(`/api/documents/${doc}/download`));
    await waiters(2);
    // Victor's download waits for the document, not for the audit log: it
    // has not decided anything yet.
    expect(await waitingOnDoc(doc)).toBe(true);
    await audit.release();

    expect((await revoke).status).toBe(200);
    expect((await download).status).toBe(404);
    const rows = await story(doc);
    const revoked = rows.find((r) => r.action === 'access.revoke')!;
    const dl = rows.filter((r) => r.action === 'document.download');
    expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({ outcome: 'DENIED', actor: 'victor@t.io' });
    expect(dl[0]!.seq).toBeGreaterThan(revoked.seq);
  });

  it('a download decided before the revoke finishes and is recorded before it; the revoke waits', async () => {
    const doc = await upload(A);
    await share(doc, { userId: V.userId, level: 'READ' }).expect(200);
    const gid = await grantId(doc, V.userId);

    // Victor's download has decided and waits at its audit row, holding the
    // document's lock shared; the revoke starts and must wait for it.
    const audit = await holder();
    await audit.query('SELECT pg_advisory_lock($1)', [AUDIT_LOCK]);
    const download = start(as(t, V).get(`/api/documents/${doc}/download`));
    await waiters(1);
    const revoke = start(as(t, A).delete(`/api/documents/${doc}/access/${gid}`));
    await waiters(2);
    expect(await waitingOnDoc(doc)).toBe(true); // the revoke, at the document lock
    await audit.release();

    expect((await download).status).toBe(200);
    expect((await revoke).status).toBe(200);
    const rows = await story(doc);
    const allowed = rows.find((r) => r.action === 'document.download')!;
    const revoked = rows.find((r) => r.action === 'access.revoke')!;
    expect(allowed.outcome).toBe('ALLOWED');
    expect(allowed.seq).toBeLessThan(revoked.seq);
    // And after the revoke, nothing.
    await as(t, V).get(`/api/documents/${doc}/download`).expect(404);
  });

  it('a share change: the download is recorded under the access it was decided with', async () => {
    const doc = await upload(A);
    await share(doc, { userId: V.userId, level: 'READ' }).expect(200);

    const audit = await holder();
    await audit.query('SELECT pg_advisory_lock($1)', [AUDIT_LOCK]);
    const change = start(share(doc, { userId: V.userId, level: 'EDIT' }));
    await waiters(1);
    const download = start(as(t, V).get(`/api/documents/${doc}/download`));
    await waiters(2);
    await audit.release();

    expect((await change).status).toBe(200);
    expect((await download).status).toBe(200);
    const rows = await story(doc);
    const changed = rows.find((r) => r.action === 'access.change')!;
    const allowed = rows.find((r) => r.action === 'document.download')!;
    // Decided after the change, so recorded after it, with the new level.
    expect(allowed.seq).toBeGreaterThan(changed.seq);
    expect(allowed.details).toMatchObject({ level: 'EDIT' });
  });

  it('a removal from a group: a download through the group waits for it and is refused', async () => {
    const doc = await upload(A);
    const g = await as(t, ADM).post('/api/admin/groups', { name: 'Board' }).expect(201);
    await as(t, ADM).post(`/api/admin/groups/${g.body.id}/members`, { userId: V.userId }).expect(204);
    await share(doc, { groupId: g.body.id, level: 'READ' }).expect(200);
    await as(t, V).get(`/api/documents/${doc}/download`).expect(200);

    const audit = await holder();
    await audit.query('SELECT pg_advisory_lock($1)', [AUDIT_LOCK]);
    const removal = start(as(t, ADM).delete(`/api/admin/groups/${g.body.id}/members/${V.userId}`));
    await waiters(1);
    const download = start(as(t, V).get(`/api/documents/${doc}/download`));
    await waiters(2);
    await audit.release();

    expect((await removal).status).toBe(204);
    expect((await download).status).toBe(404);
    const removed = (await auditRows(`action = 'group.member_remove' AND target_id = $1`, [g.body.id]))[0]!;
    const dl = (await story(doc)).filter((r) => r.action === 'document.download');
    expect(dl.at(-1)).toMatchObject({ outcome: 'DENIED', actor: 'victor@t.io' });
    expect(dl.at(-1)!.seq).toBeGreaterThan(Number(removed.seq));
  });

  it('a role change: a download by that person waits for it and is refused', async () => {
    const doc = await upload(A);
    await share(doc, { userId: V.userId, level: 'READ' }).expect(200);

    const audit = await holder();
    await audit.query('SELECT pg_advisory_lock($1)', [AUDIT_LOCK]);
    const promote = start(as(t, ADM).patch(`/api/admin/users/${V.userId}`, { role: 'ADMIN' }));
    await waiters(1);
    const download = start(as(t, V).get(`/api/documents/${doc}/download`));
    await waiters(2);
    await audit.release();

    expect((await promote).status).toBe(200);
    expect((await download).status).toBe(404);
    const changed = (await auditRows(`action = 'user.update' AND target_id = $1`, [V.userId])).at(-1)!;
    const dl = (await story(doc)).filter((r) => r.action === 'document.download');
    expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({ outcome: 'DENIED' });
    expect(dl[0]!.seq).toBeGreaterThan(Number(changed.seq));
  });

  it('a deactivation: a download by that person waits for it and is refused', async () => {
    const doc = await upload(A);
    await share(doc, { userId: V.userId, level: 'READ' }).expect(200);

    const audit = await holder();
    await audit.query('SELECT pg_advisory_lock($1)', [AUDIT_LOCK]);
    const deactivate = start(as(t, ADM).post(`/api/admin/users/${V.userId}/deactivate`));
    await waiters(1);
    const download = start(as(t, V).get(`/api/documents/${doc}/download`));
    await waiters(2);
    await audit.release();

    expect((await deactivate).status).toBe(200);
    expect((await download).status).toBe(404);
    const ended = (await auditRows(`action = 'user.deactivate' AND target_id = $1`, [V.userId]))[0]!;
    const dl = (await story(doc)).filter((r) => r.action === 'document.download');
    expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({ outcome: 'DENIED', reason: 'user_inactive' });
    expect(dl[0]!.seq).toBeGreaterThan(Number(ended.seq));
  });

  it('a session ended while the download waited (password reset, sign-out everywhere) is refused', async () => {
    const doc = await upload(A);
    await share(doc, { userId: V.userId, level: 'READ' }).expect(200);
    // Hold Victor's own lock so the download stops after the session check
    // at the door, then end the session behind the API's back.
    const lock = await holder();
    await lock.query('SELECT pg_advisory_lock($1, hashtext($2::text))', [USER_LOCK_CLASS, V.userId]);
    const download = start(as(t, V).get(`/api/documents/${doc}/download`));
    await waiters(1);
    await withDb(ownerDb(), (db) => db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_changed' WHERE user_id = $1`, [V.userId]));
    await lock.release();
    expect((await download).status).toBe(404);
    expect((await story(doc)).filter((r) => r.action === 'document.download').at(-1)).toMatchObject({ outcome: 'DENIED', reason: 'session_ended' });
  });

  it('expiry: an ALLOWED row is never dated after the grant expired, even if it lapses mid-request', async () => {
    const doc = await upload(A);
    // Expiry by the database clock (the lock that compares it), a few seconds out.
    const expires = await withDb(ownerDb(), async (db) => (await db.query(`SELECT clock_timestamp() + interval '4 seconds' AS e`)).rows[0].e as Date);
    await share(doc, { userId: V.userId, level: 'READ', expiresAt: expires.toISOString() }).expect(200);

    // Decided while the grant was live, then held at the audit row past the expiry.
    const audit = await holder();
    await audit.query('SELECT pg_advisory_lock($1)', [AUDIT_LOCK]);
    const download = start(as(t, V).get(`/api/documents/${doc}/download`));
    await waiters(1);
    for (;;) {
      const past = await withDb(ownerDb(), async (db) => (await db.query('SELECT clock_timestamp() > $1 AS p', [expires])).rows[0].p as boolean);
      if (past) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await audit.release();

    expect((await download).status).toBe(404);
    const dl = (await story(doc)).filter((r) => r.action === 'document.download');
    expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({ outcome: 'DENIED', reason: 'access_ended_during_request' });
    // And a fresh request after the expiry is refused at the decision.
    await as(t, V).get(`/api/documents/${doc}/download`).expect(404);
  });
});

describe('downloads still run side by side', () => {
  it('two downloads hold the document lock at the same time; an exclusive holder makes them wait', async () => {
    const doc = await upload(A);
    await share(doc, { userId: V.userId, level: 'READ' }).expect(200);
    await share(doc, { userId: W.userId, level: 'READ' }).expect(200);

    // Both reach their audit row while holding the document lock shared.
    const audit = await holder();
    await audit.query('SELECT pg_advisory_lock($1)', [AUDIT_LOCK]);
    const d1 = start(as(t, V).get(`/api/documents/${doc}/download`));
    const d2 = start(as(t, W).get(`/api/documents/${doc}/download`));
    await waiters(2);
    const sharedHolders = await withDb(ownerDb(), async (db) => Number((await db.query(
      `SELECT count(*) AS n FROM pg_locks l WHERE locktype = 'advisory' AND granted AND mode = 'ShareLock' AND objsubid = 1
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended($1::text, 0)`, [doc])).rows[0].n));
    expect(sharedHolders).toBe(2);
    await audit.release();
    expect((await d1).status).toBe(200);
    expect((await d2).status).toBe(200);

    // Someone changing the document holds it exclusively: a download waits.
    const lock = await holder();
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1::text, 0))', [doc]);
    let done = false;
    const d3 = start(as(t, V).get(`/api/documents/${doc}/download`)).then((r) => { done = true; return r; });
    await waiters(1);
    expect(done).toBe(false);
    await lock.release();
    expect((await d3).status).toBe(200);
  });

  it('a burst of parallel downloads, revokes, re-grants, group and role changes: no deadlock, and the log agrees with every decision', async () => {
    const d1 = await upload(A, 'One');
    const d2 = await upload(A, 'Two');
    const g = await as(t, ADM).post('/api/admin/groups', { name: 'Ops' }).expect(201);
    for (const u of [V.userId, W.userId]) await as(t, ADM).post(`/api/admin/groups/${g.body.id}/members`, { userId: u }).expect(204);
    await share(d2, { groupId: g.body.id, level: 'READ' }).expect(200);
    await share(d1, { userId: V.userId, level: 'READ' }).expect(200);
    await share(d1, { userId: W.userId, level: 'READ' }).expect(200);
    const deadlocksBefore = await withDb(ownerDb(), async (db) => Number((await db.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks));

    const statuses: number[] = [];
    const run = async (n: number, f: (i: number) => PromiseLike<{ status: number }>) => {
      for (let i = 0; i < n; i++) statuses.push((await f(i)).status);
    };
    const flip = async (i: number) => {
      const id = await grantId(d1, V.userId).catch(() => null);
      return id && i % 2 === 0 ? as(t, A).delete(`/api/documents/${d1}/access/${id}`) : share(d1, { userId: V.userId, level: i % 4 === 1 ? 'EDIT' : 'READ' });
    };
    await Promise.all([
      run(12, () => as(t, V).get(`/api/documents/${d1}/download`)),
      run(12, () => as(t, V).get(`/api/documents/${d2}/download`)),
      run(12, () => as(t, W).get(`/api/documents/${d1}/download`)),
      run(12, () => as(t, W).get(`/api/documents/${d2}/download`)),
      run(10, flip),
      run(6, (i) => i % 2 === 0
        ? as(t, ADM).delete(`/api/admin/groups/${g.body.id}/members/${W.userId}`)
        : as(t, ADM).post(`/api/admin/groups/${g.body.id}/members`, { userId: W.userId })),
      run(4, (i) => as(t, ADM).patch(`/api/admin/users/${W.userId}`, { displayName: `Wendy ${i}` })),
      run(2, (i) => as(t, ADM).patch(`/api/admin/users/${V.userId}`, { accessExpiresAt: new Date(Date.now() + (i + 2) * 86_400_000).toISOString() })),
    ]);
    // No request failed on a deadlock or anything else unexpected. (401: a
    // changed end date ends the person's sessions, as it should.)
    expect(statuses.filter((s) => ![200, 204, 401, 404].includes(s))).toEqual([]);
    await new Promise((r) => setTimeout(r, 1200)); // statistics are flushed about once a second
    const deadlocksAfter = await withDb(ownerDb(), async (db) => Number((await db.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks));
    expect(deadlocksAfter).toBe(deadlocksBefore);

    // Replay the log for Victor on document one: every ALLOWED download comes
    // after a grant to him with no revoke in between, and every refusal after
    // a revoke (or a session end).
    let has = true;
    for (const r of await story(d1)) {
      const subject = (r.details?.subject as { id?: string } | undefined)?.id;
      if ((r.action === 'access.grant' || r.action === 'access.change') && subject === V.userId) has = true;
      if (r.action === 'access.revoke' && subject === V.userId) has = false;
      if (r.action === 'document.download' && r.actor === 'victor@t.io') {
        if (r.outcome === 'ALLOWED') expect(has, `ALLOWED download at seq ${r.seq} while revoked`).toBe(true);
        else if (r.reason === 'no_grant') expect(has, `refusal at seq ${r.seq} while granted`).toBe(false);
      }
    }
  });
});

describe('the database takes the locks too, whatever path writes', () => {
  it('a grant change straight in the database waits for a download in progress', async () => {
    const doc = await upload(A);
    await share(doc, { userId: V.userId, level: 'READ' }).expect(200);
    const reader = await holder(); // stands in for a download holding the document shared
    await reader.query('SELECT pg_advisory_lock_shared(hashtextextended($1::text, 0))', [doc]);
    const app = appDb();
    await app.connect();
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.user_id', $1, true)`, [A.userId]);
    const del = app.query('DELETE FROM grants WHERE document_id = $1', [doc]);
    await waiters(1);
    await reader.release();
    expect((await del).rowCount).toBe(1);
    await app.query('ROLLBACK');
    await app.end();
  });

  it('a group membership or account change straight in the database waits for that person’s download', async () => {
    const g = await as(t, ADM).post('/api/admin/groups', { name: 'Ops' }).expect(201);
    const reader = await holder(); // stands in for Victor's download holding his lock shared
    await reader.query('SELECT pg_advisory_lock_shared($1, hashtext($2::text))', [USER_LOCK_CLASS, V.userId]);
    const db = ownerDb();
    await db.connect();
    await db.query('BEGIN');
    const add = db.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [g.body.id, V.userId]);
    await waiters(1);
    await reader.query('SELECT pg_advisory_unlock_all()');
    await add;
    await db.query('ROLLBACK');

    await reader.query('SELECT pg_advisory_lock_shared($1, hashtext($2::text))', [USER_LOCK_CLASS, V.userId]);
    await db.query('BEGIN');
    const off = db.query(`UPDATE users SET status = 'DEACTIVATED', deactivated_at = now() WHERE id = $1`, [V.userId]);
    await waiters(1);
    await reader.release();
    expect((await off).rowCount).toBe(1);
    await db.query('ROLLBACK');
    await db.end();
  });
});
