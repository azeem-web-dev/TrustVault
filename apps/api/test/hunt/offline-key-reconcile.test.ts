import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDb, as, createUser, login, PDF, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from '../helpers.js';
import { KeyLedgerService } from '../../src/keys/key-ledger.service.js';

/**
 * HUNT key-01 (THREATS.md K7/K8). The key-use reconciler must not flag the
 * first Android copy key of a document as `release_without_ticket`.
 *
 * `ViewingService.offlineKey()` generates a fresh random copy key the first
 * time a person opens a document on the phone and hands it over directly
 * (audit `document.offline_key`, `created:true`) — no stored ciphertext is
 * unwrapped, so there is legitimately no ticket and no keyd ledger entry.
 * Before the fix, reconcile() counted every such first open as a CRITICAL
 * `release_without_ticket` (bytes released outside the protocol), making
 * reconcile.ok permanently false and training admins to ignore the
 * `key_ledger_mismatch` alert that exists to catch a real bypass. This test
 * fails without the exclusion added to reconcile()'s audit-side check, and
 * confirms a genuine release_without_ticket is still caught.
 */
let t: TestApp;
let ledger: KeyLedgerService;
let owner: TestUser;
let phone: TestUser;
let ownerS: Session;
let phoneS: Session;

const upload = async (title: string) =>
  (await as(t, ownerS).upload('/api/documents', PDF, 'f.pdf', { title, category: 'OKR' }).expect(201)).body.id as string;

beforeAll(async () => {
  t = await startApp();
  await resetState(t.app);
  ledger = t.app.get(KeyLedgerService);
  owner = await createUser({ email: 'okr-owner@t.io', role: 'OWNER' });
  phone = await createUser({ email: 'okr-phone@t.io', role: 'OWNER' });
  ownerS = await login(t, owner);
  phoneS = await login(t, phone);
  await ledger.mirror();
});
afterAll(async () => { await t.close(); });

describe('key-use reconciliation and the first Android copy key', () => {
  it('a first offline key (fresh, no unwrap) does not read as a key released without a ticket', async () => {
    // A real download first, so at least one ticket exists and the audit-side
    // check's "after tickets were introduced" guard is active.
    const seed = await upload('Seed');
    await as(t, ownerS).get(`/api/documents/${seed}/download`).expect(200);

    const doc = await upload('Shared to phone');
    await as(t, ownerS).put(`/api/documents/${doc}/access`, { userId: phone.id, level: 'READ' }).expect(200);
    // First open: created:true, key handed over without a ticket.
    await as(t, phoneS).post(`/api/documents/${doc}/offline-key`).expect(200);

    const r = await ledger.reconcile({ graceMs: 0 });
    const forDoc = r.findings.filter((f) => f.documentId === doc);
    expect(forDoc).toEqual([]);
    expect(forDoc.some((f) => f.kind === 'release_without_ticket')).toBe(false);
  });

  it('the second open uses a ticket, and still reconciles cleanly', async () => {
    const doc = await upload('Opened twice');
    await as(t, ownerS).put(`/api/documents/${doc}/access`, { userId: phone.id, level: 'READ' }).expect(200);
    await as(t, phoneS).post(`/api/documents/${doc}/offline-key`).expect(200); // created:true
    await as(t, phoneS).post(`/api/documents/${doc}/offline-key`).expect(200); // created:false, ticket + unwrap
    const r = await ledger.reconcile({ graceMs: 0 });
    expect(r.findings.filter((f) => f.documentId === doc && f.severity === 'critical')).toEqual([]);
  });

  it('a genuine key release without a ticket is still caught (the fix is narrow)', async () => {
    const doc = await upload('Bypass');
    // A download recorded as ALLOWED with no ticket and no key service use.
    await withDb(appDb(), (db) => db.query(
      `INSERT INTO audit_events (id, actor_id, actor_email, action, outcome, document_id, details)
       VALUES (gen_random_uuid(), $1, 'x', 'document.download', 'ALLOWED', $2, $3)`,
      [owner.id, doc, JSON.stringify({ versionNo: 1 })]));
    const r = await ledger.reconcile({ graceMs: 0 });
    expect(r.findings.filter((f) => f.documentId === doc).map((f) => f.kind)).toEqual(['release_without_ticket']);
  });
});
