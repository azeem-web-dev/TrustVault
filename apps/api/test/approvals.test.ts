import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { MailService } from '../src/mail/mail.service.js';
import { appDb, approved, as, auditRows, createUser, login, ownerDb, PDF, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from './helpers.js';

// Two administrators for clearing an owner's or admin's second factor and
// for break-glass (THREATS.md S15, S19). Every rule is tried through the API
// and again as direct SQL with the app's own database role.

let t: TestApp;
let mail: MailService;
let alice: TestUser, victor: TestUser, one: TestUser, two: TestUser;
let A: Session, V: Session, ADM: Session, ADM2: Session;

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
  [alice, victor, one, two] = await Promise.all([
    createUser({ email: 'alice@t.io', role: 'OWNER', mfa: true }),
    createUser({ email: 'victor@t.io', role: 'VIEWER', mfa: true }),
    createUser({ email: 'one@t.io', role: 'ADMIN' }),
    createUser({ email: 'two@t.io', role: 'ADMIN' }),
  ]);
  [A, V, ADM, ADM2] = await Promise.all([login(t, alice), login(t, victor), login(t, one), login(t, two)]);
});

async function upload(title = 'Merger plan') {
  const res = await as(t, A).upload('/api/documents', PDF, 'plan.pdf', { title, category: 'Legal' });
  expect(res.status).toBe(201);
  return res.body.id as string;
}
const ask = (s: Session, body: object) => as(t, s).post('/api/admin/approvals', { reason: 'Lost phone, confirmed on a video call, IT-311', ...body });
const settle = () => new Promise((r) => setTimeout(r, 150));
const sentTo = (email: string) => mail.outbox.filter((m) => m.to === email);

/** Runs `fn` as the app role in a transaction that says `userId` is asking; always rolls back. */
async function asAppRole<T>(userId: string | null, fn: (db: pg.Client) => Promise<T>): Promise<T | string> {
  return withDb(appDb(), async (db) => {
    await db.query('BEGIN');
    if (userId !== null) await db.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    try {
      return await fn(db);
    } catch (e) {
      return (e as Error).message;
    } finally {
      await db.query('ROLLBACK');
    }
  });
}

describe('one administrator alone cannot do either', () => {
  it('with no other active admin, asking is refused with a clear message, and both actions are impossible', async () => {
    await withDb(ownerDb(), (db) => db.query(`UPDATE users SET status = 'DEACTIVATED', deactivated_at = now() WHERE id = $1`, [two.id]));
    const doc = await upload();
    const r = await ask(ADM, { action: 'MFA_RESET', targetUserId: alice.id }).expect(409);
    expect(r.body.code).toBe('no_second_admin');
    expect(r.body.message).toMatch(/second active administrator/);
    await ask(ADM, { action: 'BREAK_GLASS', documentId: doc }).expect(409);
    // And without an approval, neither action happens.
    const reset = await as(t, ADM).post(`/api/admin/users/${alice.id}/mfa/reset`).expect(409);
    expect(reset.body.code).toBe('approval_required');
    await as(t, ADM).post('/api/admin/break-glass', { documentId: doc }).expect(400);
    await as(t, ADM).post('/api/admin/break-glass', { documentId: doc, approvalId: '6f1c2c1e-6c51-4c8e-9a51-2b6f5a1d9e01' }).expect(403);
    await as(t, ADM).get(`/api/documents/${doc}/download`).expect(404);
    const still = await withDb(ownerDb(), async (db) => (await db.query('SELECT totp_enabled_at FROM users WHERE id = $1', [alice.id])).rows[0].totp_enabled_at);
    expect(still).not.toBeNull();
    expect((await auditRows(`action = 'admin.approval_requested' AND outcome = 'DENIED' AND actor_id = $1`, [one.id])).map((r) => r.reason)).toContain('no_second_admin');
    expect((await auditRows(`action = 'user.mfa_reset' AND target_id = $1`, [alice.id])).at(-1)).toMatchObject({ outcome: 'DENIED', reason: 'approval_required' });
  });

  it('a viewer’s or external’s second factor still needs only one admin', async () => {
    await as(t, ADM).post(`/api/admin/users/${victor.id}/mfa/reset`).expect(204);
    await ask(ADM, { action: 'MFA_RESET', targetUserId: victor.id }).expect(400);
  });
});

describe('a person who signs in only with a passkey', () => {
  it('shows up with a passkey count and an admin can reset it', async () => {
    await withDb(ownerDb(), async (db) => {
      await db.query(`UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, email_otp_enabled_at = NULL WHERE id = $1`, [victor.id]);
      await db.query(`INSERT INTO passkeys (id, user_id, credential_id, public_key, transports, name) VALUES (gen_random_uuid(), $1, 'cred-only', 'x', '{}', 'Phone')`, [victor.id]);
    });
    const list = await as(t, ADM).get('/api/admin/users').expect(200);
    const row = list.body.users.find((u: { id: string }) => u.id === victor.id);
    expect(row).toMatchObject({ totpEnabledAt: null, passkeys: 1 });
    await as(t, ADM).post(`/api/admin/users/${victor.id}/mfa/reset`).expect(204);
    const left = await withDb(ownerDb(), async (db) => (await db.query('SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1', [victor.id])).rows[0].n);
    expect(left).toBe(0);
  });
});

describe('the same person cannot ask and approve', () => {
  it('in the API', async () => {
    const r = await ask(ADM, { action: 'MFA_RESET', targetUserId: alice.id }).expect(201);
    const self = await as(t, ADM).post(`/api/admin/approvals/${r.body.approval.id}/approve`).expect(409);
    expect(self.body.code).toBe('own_request');
    await as(t, ADM).post(`/api/admin/approvals/${r.body.approval.id}/reject`).expect(409);
    await as(t, ADM).post(`/api/admin/users/${alice.id}/mfa/reset`, { approvalId: r.body.approval.id }).expect(403); // not approved
    expect((await auditRows(`action = 'admin.approval_approved' AND target_id = $1`, [r.body.approval.id]))[0]).toMatchObject({ outcome: 'DENIED', reason: 'own_request' });
  });

  it('nor straight in the database as the app role, however the row is written', async () => {
    const r = await ask(ADM, { action: 'BREAK_GLASS', documentId: await upload() }).expect(201);
    const id = r.body.approval.id as string;
    // Approving your own request.
    expect(await asAppRole(one.id, (db) => db.query('UPDATE admin_approvals SET approved_by = $1, approved_at = now() WHERE id = $2', [one.id, id])))
      .toMatch(/another active administrator|approvals_two_people/);
    // Naming someone else as the approver while you are the one asking.
    expect(await asAppRole(one.id, (db) => db.query('UPDATE admin_approvals SET approved_by = $1, approved_at = now() WHERE id = $2', [two.id, id])))
      .toMatch(/as themselves/);
    // A request that arrives already approved.
    expect(await asAppRole(one.id, (db) => db.query(
      `INSERT INTO admin_approvals (action, target_user_id, reason, requested_by, expires_at, approved_by, approved_at)
       VALUES ('MFA_RESET', $1, 'a reason long enough to pass', $2, now() + interval '1 hour', $3, now())`, [alice.id, one.id, two.id])))
      .toMatch(/start unanswered|starts unanswered/);
    // A request in someone else's name.
    expect(await asAppRole(one.id, (db) => db.query(
      `INSERT INTO admin_approvals (action, target_user_id, reason, requested_by, expires_at) VALUES ('MFA_RESET', $1, 'a reason long enough to pass', $2, now() + interval '1 hour')`, [alice.id, two.id])))
      .toMatch(/as themselves/);
    // Not an admin, or nobody: nothing is visible, nothing changes.
    const asOwner = await asAppRole(alice.id, async (db) => (await db.query('UPDATE admin_approvals SET approved_by = $1, approved_at = now() WHERE id = $2', [alice.id, id])).rowCount);
    expect(asOwner).toBe(0);
    for (const bad of [null, '', 'not-a-uuid']) {
      const res = await asAppRole(bad === null ? null : one.id, async (db) => {
        if (bad !== null) await db.query(`SELECT set_config('app.user_id', $1, true)`, [bad]);
        return (await db.query('SELECT count(*)::int AS n FROM admin_approvals')).rows[0].n as number;
      });
      expect(res === 0 || /invalid input syntax for type uuid/.test(String(res))).toBe(true);
    }
    // No deleting the record.
    expect(await asAppRole(two.id, (db) => db.query('DELETE FROM admin_approvals WHERE id = $1', [id]))).toMatch(/permission denied|append-only/);
    const row = await withDb(ownerDb(), async (db) => (await db.query('SELECT approved_by, approved_at FROM admin_approvals WHERE id = $1', [id])).rows[0]);
    expect(row).toEqual({ approved_by: null, approved_at: null });
  });

  it('a deactivated admin cannot approve, even straight in the database', async () => {
    const r = await ask(ADM, { action: 'MFA_RESET', targetUserId: alice.id }).expect(201);
    await withDb(ownerDb(), (db) => db.query(`UPDATE users SET status = 'DEACTIVATED', deactivated_at = now() WHERE id = $1`, [two.id]));
    const res = await asAppRole(two.id, async (db) => (await db.query('UPDATE admin_approvals SET approved_by = $1, approved_at = now() WHERE id = $2', [two.id, r.body.approval.id])).rowCount);
    expect(res).toBe(0); // invisible to a non-admin
  });
});

describe('an approval is used once, by the person who asked, for exactly what was asked', () => {
  it('clearing an owner’s second factor: works once, emails the owner, and cannot be replayed or moved', async () => {
    const bob = await createUser({ email: 'bob@t.io', role: 'OWNER', mfa: true });
    const ok = await approved(t, ADM, ADM2, { action: 'MFA_RESET', targetUserId: alice.id });
    // The approver cannot use it; it cannot be pointed at someone else.
    await as(t, ADM2).post(`/api/admin/users/${alice.id}/mfa/reset`, { approvalId: ok }).expect(403);
    await as(t, ADM).post(`/api/admin/users/${bob.id}/mfa/reset`, { approvalId: ok }).expect(403);
    await as(t, ADM).post(`/api/admin/users/${alice.id}/mfa/reset`, { approvalId: ok }).expect(204);
    const after = await withDb(ownerDb(), async (db) => (await db.query('SELECT totp_enabled_at, totp_secret_enc FROM users WHERE id = $1', [alice.id])).rows[0]);
    expect(after).toEqual({ totp_enabled_at: null, totp_secret_enc: null });
    // Replay.
    await withDb(ownerDb(), (db) => db.query(`UPDATE users SET totp_enabled_at = now(), totp_secret_enc = '\\x00' WHERE id = $1`, [alice.id]));
    const again = await as(t, ADM).post(`/api/admin/users/${alice.id}/mfa/reset`, { approvalId: ok }).expect(403);
    expect(again.body.code).toBe('approval_not_usable');
    const used = await auditRows(`action = 'admin.approval_used' AND target_id = $1`, [ok]);
    expect(used.map((r) => [r.outcome, r.reason])).toEqual([['DENIED', 'not_your_request'], ['DENIED', 'wrong_target'], ['ALLOWED', null], ['DENIED', 'already_used']]);
    expect(used[2]!.details).toMatchObject({ requestedBy: one.id, approvedBy: two.id });
    expect(used[2]!.ip).toBeTruthy();
    await settle();
    expect(sentTo('alice@t.io').some((m) => /security changed/.test(m.subject))).toBe(true);
  });

  it('straight in the database: a second use is refused, and break-glass needs an approval used in the same transaction', async () => {
    const doc = await upload();
    const ok = await approved(t, ADM, ADM2, { action: 'BREAK_GLASS', documentId: doc });
    const insert = (db: pg.Client, approval: string | null) => db.query(
      `INSERT INTO break_glass (id, admin_id, document_id, reason, expires_at, approval_id) VALUES (gen_random_uuid(), $1, $2, 'a long enough reason here', now() + interval '30 minutes', $3)`, [one.id, doc, approval]);
    // No approval at all.
    expect(await asAppRole(one.id, (db) => insert(db, null))).toMatch(/second administrator/);
    // Approved but not used in this transaction.
    expect(await asAppRole(one.id, (db) => insert(db, ok))).toMatch(/second administrator/);
    // Used by someone else (the approver).
    expect(await asAppRole(two.id, (db) => db.query('UPDATE admin_approvals SET consumed_at = now() WHERE id = $1', [ok]))).toMatch(/admin who asked/);
    // Used properly, in this transaction: works (rolled back afterwards).
    expect(await asAppRole(one.id, async (db) => {
      await db.query('UPDATE admin_approvals SET consumed_at = now() WHERE id = $1', [ok]);
      return (await insert(db, ok)).rowCount;
    })).toBe(1);
    // Used for real through the API, then a second use in SQL is refused.
    await as(t, ADM).post('/api/admin/break-glass', { documentId: doc, approvalId: ok }).expect(201);
    expect(await asAppRole(one.id, (db) => db.query('UPDATE admin_approvals SET consumed_at = now() WHERE id = $1', [ok]))).toMatch(/cannot be used/);
    expect(await asAppRole(one.id, (db) => db.query('UPDATE admin_approvals SET consumed_at = NULL WHERE id = $1', [ok]))).toMatch(/cannot be used/);
  });

  it('break-glass: owner emailed on approval; one hour at most; only the asker reads; not for another document or action', async () => {
    const doc = await upload();
    const other = await upload('Other');
    const r = await ask(ADM, { action: 'BREAK_GLASS', documentId: doc, reason: 'Legal hold requested by counsel, LEG-142' }).expect(201);
    await settle();
    expect(sentTo('alice@t.io').filter((m) => /Emergency access/.test(m.subject))).toHaveLength(0); // not yet
    await as(t, ADM2).post(`/api/admin/approvals/${r.body.approval.id}/approve`).expect(200);
    await settle();
    const notice = sentTo('alice@t.io').find((m) => /Emergency access/.test(m.subject))!;
    expect(notice.text).toContain('Merger plan');
    expect(notice.text).toContain('Legal hold requested by counsel, LEG-142');
    expect(notice.text).toContain('two@t.io');

    const id = r.body.approval.id as string;
    await as(t, ADM).post('/api/admin/break-glass', { documentId: other, approvalId: id }).expect(403);
    await as(t, ADM).post(`/api/admin/users/${alice.id}/mfa/reset`, { approvalId: id }).expect(403); // wrong action
    await as(t, ADM2).post('/api/admin/break-glass', { documentId: doc, approvalId: id }).expect(403); // not theirs
    const g = await as(t, ADM).post('/api/admin/break-glass', { documentId: doc, approvalId: id }).expect(201);
    expect(new Date(g.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(3_600_000);
    const span = await withDb(ownerDb(), async (db) => (await db.query(`SELECT extract(epoch FROM expires_at - created_at)::int AS s, approval_id FROM break_glass WHERE document_id = $1`, [doc])).rows);
    expect(span).toEqual([{ s: 3600, approval_id: id }]);
    // Break-glass is VIEW: the document and its pages, never the original file (THREATS.md V9).
    await as(t, ADM).get(`/api/documents/${doc}`).expect(200);
    await as(t, ADM).get(`/api/documents/${doc}/download`).expect(404);
    await as(t, ADM2).get(`/api/documents/${doc}`).expect(404);
    await as(t, ADM).get(`/api/documents/${other}`).expect(404);
    await as(t, ADM).post('/api/admin/break-glass', { documentId: doc, approvalId: id }).expect(403); // once
    const bg = (await auditRows(`action = 'admin.break_glass' AND document_id = $1`, [doc]))[0]!;
    expect(bg.details).toMatchObject({ reason: 'Legal hold requested by counsel, LEG-142', approvalId: id, approvedBy: two.id });
    expect((await auditRows(`action = 'admin.approval_approved' AND target_id = $1`, [id]))[0]).toMatchObject({ outcome: 'ALLOWED', actor_id: two.id });
  });
});

describe('rejected and expired requests', () => {
  it('a rejected request cannot be used, and the rejection is recorded', async () => {
    const r = await ask(ADM, { action: 'MFA_RESET', targetUserId: alice.id }).expect(201);
    await as(t, ADM2).post(`/api/admin/approvals/${r.body.approval.id}/reject`).expect(200);
    await as(t, ADM2).post(`/api/admin/approvals/${r.body.approval.id}/approve`).expect(409); // already answered
    await as(t, ADM).post(`/api/admin/users/${alice.id}/mfa/reset`, { approvalId: r.body.approval.id }).expect(403);
    expect((await auditRows(`action = 'admin.approval_rejected' AND target_id = $1`, [r.body.approval.id]))[0]).toMatchObject({ outcome: 'ALLOWED', actor_id: two.id });
    expect((await auditRows(`action = 'admin.approval_used' AND target_id = $1`, [r.body.approval.id]))[0]).toMatchObject({ outcome: 'DENIED', reason: 'rejected' });
    const list = (await as(t, ADM).get('/api/admin/approvals').expect(200)).body.approvals;
    expect(list[0]).toMatchObject({ id: r.body.approval.id, status: 'REJECTED', rejectedBy: { email: 'two@t.io' } });
  });

  it('after 24 hours a request can be neither approved nor used, and its expiry is recorded once', async () => {
    const pending = await ask(ADM, { action: 'MFA_RESET', targetUserId: alice.id }).expect(201);
    const ok = await approved(t, ADM, ADM2, { action: 'BREAK_GLASS', documentId: await upload() });
    // Move both a day into the past (the owner may; the app role may not).
    expect(await asAppRole(one.id, (db) => db.query(`UPDATE admin_approvals SET created_at = created_at - interval '25 hours' WHERE id = $1`, [pending.body.approval.id]))).toMatch(/cannot be rewritten/);
    await withDb(ownerDb(), (db) => db.query(`ALTER TABLE admin_approvals DISABLE TRIGGER admin_approvals_guard_update;
      UPDATE admin_approvals SET created_at = created_at - interval '25 hours', expires_at = expires_at - interval '25 hours';
      ALTER TABLE admin_approvals ENABLE TRIGGER admin_approvals_guard_update`));
    const late = await as(t, ADM2).post(`/api/admin/approvals/${pending.body.approval.id}/approve`).expect(409);
    expect(late.body.code).toBe('expired');
    const doc = await withDb(ownerDb(), async (db) => (await db.query('SELECT target_document_id FROM admin_approvals WHERE id = $1', [ok])).rows[0].target_document_id as string);
    await as(t, ADM).post('/api/admin/break-glass', { documentId: doc, approvalId: ok }).expect(403);
    const list = (await as(t, ADM).get('/api/admin/approvals').expect(200)).body.approvals as { id: string; status: string }[];
    expect(list.map((a) => a.status)).toEqual(['EXPIRED', 'EXPIRED']);
    await as(t, ADM2).get('/api/admin/approvals').expect(200);
    const expired = await auditRows(`action = 'admin.approval_expired' AND target_id IN ($1, $2)`, [ok, pending.body.approval.id]);
    expect(expired.map((r) => [r.target_id, r.reason]).sort()).toEqual([[ok, 'approved_never_used'], [pending.body.approval.id, 'never_answered']].sort());
  });
});

describe('only administrators', () => {
  it('owners and viewers cannot ask, list, approve or use', async () => {
    const r = await ask(ADM, { action: 'MFA_RESET', targetUserId: alice.id }).expect(201);
    for (const s of [A, V]) {
      await as(t, s).get('/api/admin/approvals').expect(403);
      await ask(s, { action: 'MFA_RESET', targetUserId: alice.id }).expect(403);
      await as(t, s).post(`/api/admin/approvals/${r.body.approval.id}/approve`).expect(403);
    }
  });
});

describe('the two protected demo admins (README: admin@demo.com and admin2@demo.com)', () => {
  it('complete break-glass end to end, request, approve, use, and every demo safeguard still holds', async () => {
    const d1 = await createUser({ email: 'demo-admin-1@t.io', role: 'ADMIN' });
    const d2 = await createUser({ email: 'demo-admin-2@t.io', role: 'ADMIN' });
    // As the seed makes them: protected (schema owner only).
    await withDb(ownerDb(), (db) => db.query('UPDATE users SET is_protected = true WHERE id = ANY($1::uuid[])', [[d1.id, d2.id]]));
    const [S1, S2] = [await login(t, d1), await login(t, d2)];
    const doc = await upload('Demo board pack');

    // Request (Ada) -> approve (Ben) -> use (Ada, once).
    const approvalId = await approved(t, S1, S2, { action: 'BREAK_GLASS', documentId: doc, reason: 'Demo: legal hold request LEG-1 from counsel' });
    await as(t, S1).post('/api/admin/break-glass', { documentId: doc, approvalId }).expect(201);
    await as(t, S1).get(`/api/documents/${doc}`).expect(200);
    await as(t, S1).get(`/api/documents/${doc}/download`).expect(404); // VIEW only (THREATS.md V9)
    await as(t, S1).post('/api/admin/break-glass', { documentId: doc, approvalId }).expect(403); // once
    await as(t, S2).post('/api/admin/break-glass', { documentId: doc, approvalId }).expect(403); // not Ben's
    expect((await auditRows(`action = 'admin.break_glass' AND document_id = $1`, [doc]))[0]).toMatchObject({ actor_id: d1.id });

    // Neither can approve their own request.
    const own = await ask(S2, { action: 'BREAK_GLASS', documentId: doc }).expect(201);
    await as(t, S2).post(`/api/admin/approvals/${own.body.approval.id}/approve`).expect(409);

    // Demo safeguards: neither can deactivate, demote or clear the other's second factor; neither is ever emailed.
    await as(t, S2).post(`/api/admin/users/${d1.id}/deactivate`).expect(403);
    await as(t, S1).patch(`/api/admin/users/${d2.id}`, { role: 'OWNER' }).expect(403);
    // Clearing a protected admin's second factor cannot even be asked for.
    const reset = await ask(S2, { action: 'MFA_RESET', targetUserId: d1.id });
    expect(reset.status).toBe(403);
    expect(reset.body.message).toMatch(/protected demo account/);
    const after = await withDb(ownerDb(), async (db) => (await db.query('SELECT status, role, totp_enabled_at IS NOT NULL AS mfa FROM users WHERE id = ANY($1::uuid[]) ORDER BY email', [[d1.id, d2.id]])).rows);
    expect(after).toEqual([{ status: 'ACTIVE', role: 'ADMIN', mfa: true }, { status: 'ACTIVE', role: 'ADMIN', mfa: true }]);
    await settle();
    expect(sentTo(d1.email)).toHaveLength(0);
    expect(sentTo(d2.email)).toHaveLength(0);
  });
});
