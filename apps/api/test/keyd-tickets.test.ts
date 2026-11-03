import { createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDb, as, auditRows, createUser, login, ownerDb, PDF, resetState, startApp, testEnv, withDb, type Session, type TestApp, type TestUser } from './helpers.js';
import { KEY_PROVIDER, LocalKeyProvider, localTicketKey } from '../src/crypto/key-provider.js';
import { mintTicket, verifyLedgerRun, ZERO_HASH } from '../src/crypto/key-ledger.js';
import { blobAad } from '../src/crypto/file-crypto.js';
import { KeyLedgerService } from '../src/keys/key-ledger.service.js';
import { AuditAdminService } from '../src/audit/audit-admin.service.js';

// THREATS.md K1-K8, docs/KEYS.md. The API process is assumed compromised:
// the tests act with its database role (trustvault_app) and its key
// service connection, and show what that does NOT get them.

let t: TestApp;
let keys: LocalKeyProvider;
let ledger: KeyLedgerService;
let owner: TestUser;
let stranger: TestUser;
let admin: TestUser;
let ownerS: Session;
const master = Buffer.from(testEnv().LOCAL_MASTER_KEY!, 'base64');

interface Version { docId: string; versionId: string; versionNo: number; wrapped: Buffer; keyId: string; nonce: Buffer; tag: Buffer; ct: Buffer; sha: Buffer }

async function upload(title: string, body = PDF): Promise<Version> {
  const res = await as(t, ownerS).upload('/api/documents', body, 'f.pdf', { title, category: 'Keys' }).expect(201);
  return version(res.body.id as string);
}

async function version(docId: string): Promise<Version> {
  return withDb(ownerDb(), async (db) => {
    const { rows: [r] } = await db.query(
      `SELECT v.id, v.version_no, v.sha256, b.wrapped_key, b.key_id, b.nonce, b.auth_tag, b.ciphertext FROM document_versions v
         JOIN document_blobs b ON b.version_id = v.id WHERE v.document_id = $1 ORDER BY v.version_no DESC LIMIT 1`, [docId]);
    return { docId, versionId: r.id, versionNo: r.version_no, wrapped: r.wrapped_key, keyId: r.key_id, nonce: r.nonce, tag: r.auth_tag, ct: r.ciphertext, sha: r.sha256 };
  });
}

/**
 * What a compromised API can do with its own database role: set any user
 * id, write an audit event, ask for a ticket. `finish` decides whether the
 * transaction commits.
 */
async function ticketAsApp(v: Version, userId: string | null, opts: { action?: string; auditAction?: string; outcome?: string; versionNo?: number; actorId?: string | null; finish?: 'COMMIT' | 'ROLLBACK'; reuseEvent?: string } = {}) {
  return withDb(appDb(), async (db) => {
    await db.query('BEGIN');
    try {
      if (userId) await db.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
      let eventId = opts.reuseEvent;
      if (!eventId) {
        const { rows: [e] } = await db.query<{ id: string }>(
          `INSERT INTO audit_events (id, actor_id, actor_email, action, outcome, document_id, details) VALUES (gen_random_uuid(), $1, 'attacker', $2, $3, $4, $5) RETURNING id`,
          [opts.actorId === undefined ? userId : opts.actorId, opts.auditAction ?? 'document.download', opts.outcome ?? 'ALLOWED', v.docId, JSON.stringify({ versionNo: opts.versionNo ?? v.versionNo })]);
        eventId = e!.id;
      }
      const { rows: [r] } = await db.query<{ ticket: string }>('SELECT tv_issue_unwrap_ticket($1, $2, $3) AS ticket', [v.versionId, opts.action ?? 'download', eventId]);
      await db.query(opts.finish ?? 'COMMIT');
      return { ticket: r!.ticket, eventId: eventId! };
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  });
}

const aadOf = (v: Version) => blobAad(v.docId, v.versionId, v.versionNo);

function decrypt(v: Version, dek: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', dek, v.nonce);
  d.setAAD(Buffer.from(aadOf(v)));
  d.setAuthTag(v.tag);
  return Buffer.concat([d.update(v.ct), d.final()]);
}

const sqlError = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as Error).message;
  }
};

beforeAll(async () => {
  t = await startApp();
  await resetState(t.app);
  keys = t.app.get(KEY_PROVIDER) as LocalKeyProvider;
  ledger = t.app.get(KeyLedgerService);
  owner = await createUser({ email: 'keys-owner@t.io', role: 'OWNER' });
  stranger = await createUser({ email: 'keys-stranger@t.io', role: 'VIEWER' });
  admin = await createUser({ email: 'keys-admin@t.io', role: 'ADMIN' });
  ownerS = await login(t, owner);
  // Absorb a previous run's ledger (each app instance starts a new chain).
  await ledger.mirror();
});
afterAll(async () => {
  await t.close();
});

describe('keyd authorises decryption itself (compromised API)', () => {
  it('a download goes through a database ticket and lands in the key ledger', async () => {
    const v = await upload('Ticketed');
    expect(v.keyId).toBe('local-g1-blob');
    const before = keys.ledger.head().seq;
    const res = await as(t, ownerS).get(`/api/documents/${v.docId}/download`).expect(200);
    // The stored copy (a PDF is stored rebuilt, THREATS.md C9), sent unchanged: a page-less PDF has nothing to stamp.
    expect(createHash('sha256').update(Buffer.from(res.body)).digest('hex')).toBe(res.headers['x-document-sha256']);
    const [entry] = keys.ledger.read(before + 1, 10).filter((e) => e.event === 'unwrap');
    expect(entry).toMatchObject({ result: 'ok', action: 'download', user: owner.id, doc: v.docId, ver: v.versionId });
    const [event] = await auditRows(`id = $1`, [entry!.audit_id]);
    expect(event).toMatchObject({ action: 'document.download', outcome: 'ALLOWED', actor_id: owner.id, seq: String(entry!.audit_seq) });
    const { rows } = await withDb(appDb(), (db) => db.query('SELECT * FROM unwrap_tickets WHERE id = $1', [entry!.tid]));
    expect(rows[0]).toMatchObject({ action: 'download', user_id: owner.id, version_id: v.versionId, audit_event_id: entry!.audit_id });
  });

  it('unwrapping a document key without a ticket fails', async () => {
    const v = await upload('No ticket');
    await expect(keys.unwrap(v.wrapped, v.keyId, aadOf(v))).rejects.toThrow('ticket required');
  });

  it('a forged ticket fails: the application role cannot read or use the ticket key', async () => {
    const v = await upload('Forged');
    const now = Math.floor(Date.now() / 1000);
    const fields = {
      tid: randomUUID(), action: 'download', doc: v.docId, ver: v.versionId, user: owner.id,
      aadSha256: createHash('sha256').update(aadOf(v)).digest('hex'), wkSha256: createHash('sha256').update(v.wrapped).digest('hex'),
      auditId: randomUUID(), auditSeq: 1n, iat: now, exp: now + 30,
    };
    // Attacker's own key: unknown key id.
    await expect(keys.unwrap(v.wrapped, v.keyId, aadOf(v), mintTicket(randomBytes(32), fields))).rejects.toThrow('unknown ticket key');
    // Attacker's key with the real key id: MAC fails.
    const real = mintTicket(localTicketKey(master), fields);
    const kid = real.split('|')[1]!;
    const forged = mintTicket(randomBytes(32), fields).split('|');
    forged[1] = kid;
    const body = forged.slice(0, 13).join('|');
    await expect(keys.unwrap(v.wrapped, v.keyId, aadOf(v), `${body}|${forged[13]}`)).rejects.toThrow('bad ticket mac');
    // The secret is out of the application role's reach, and so are the minting functions.
    await withDb(appDb(), async (db) => {
      expect(await sqlError(db.query('SELECT secret FROM keyd_ticket_keys'))).toMatch(/permission denied/);
      expect(await sqlError(db.query('SELECT tv_hmac_sha256($1, $2)', [Buffer.alloc(32), Buffer.from('x')]))).toMatch(/permission denied/);
      expect(await sqlError(db.query(`SELECT tv_mint_unwrap_ticket('download', $1, $2, $3, 1)`, [v.versionId, owner.id, randomUUID()]))).toMatch(/permission denied/);
      expect(await sqlError(db.query('SELECT tv_issue_maintenance_ticket($1, $2)', [v.versionId, randomUUID()]))).toMatch(/permission denied/);
      expect(await sqlError(db.query('SELECT tv_install_ticket_key($1)', [randomBytes(32)]))).toMatch(/permission denied/);
      expect(await sqlError(db.query(`UPDATE unwrap_actions SET min_level = 0 WHERE action = 'download'`))).toMatch(/permission denied/);
      expect(await sqlError(db.query(`DELETE FROM unwrap_tickets`))).toMatch(/permission denied/);
    });
  });

  it('the database refuses tickets to people without access, admins, and without a matching audit event', async () => {
    const v = await upload('Refusals');
    const refused = /unwrap ticket refused/;
    // An ALLOWED download row for someone without READ is refused even
    // before the ticket (the audit trigger, THREATS.md R11)...
    expect(await sqlError(ticketAsApp(v, stranger.id))).toMatch(/access ended during the request/);
    // ...so the ticket function's own level check is shown on the page-render action.
    const render = { action: 'view_page', auditAction: 'document.render' };
    expect(await sqlError(ticketAsApp(v, stranger.id, render))).toMatch(/no access/);
    expect(await sqlError(ticketAsApp(v, admin.id, render))).toMatch(/no access/);       // admins never read documents (A17)
    expect(await sqlError(ticketAsApp(v, null, render))).toMatch(/no access/);           // no user at all
    expect(await sqlError(ticketAsApp(v, null, { action: 'rescan', auditAction: 'document.rescan_decrypt', actorId: owner.id }))).toMatch(/no matching audit event/);
    expect(await sqlError(ticketAsApp(v, owner.id, { action: 'rescan' }))).toMatch(/system action inside a user transaction/);
    expect(await sqlError(ticketAsApp(v, owner.id, { auditAction: 'document.view' }))).toMatch(/no matching audit event/);
    expect(await sqlError(ticketAsApp(v, owner.id, { outcome: 'DENIED' }))).toMatch(/no matching audit event/);
    expect(await sqlError(ticketAsApp(v, owner.id, { versionNo: 7 }))).toMatch(/no matching audit event/);
    expect(await sqlError(ticketAsApp(v, owner.id, { ...render, actorId: stranger.id }))).toMatch(/no matching audit event/);
    expect(await sqlError(ticketAsApp(v, owner.id, { action: 'dump_all' }))).toMatch(/unknown action/);
    // One audit event backs one ticket.
    const first = await ticketAsApp(v, owner.id);
    expect(await sqlError(ticketAsApp(v, owner.id, { reuseEvent: first.eventId }))).toMatch(refused);
  });

  it('a ticket works once, only for its own document version and wrapped key, and only until it expires', async () => {
    const a = await upload('Doc A');
    const b = await upload('Doc B');
    const { ticket } = await ticketAsApp(a, owner.id);
    // Doc A's ticket on doc B (B's wrapped key and AAD).
    await expect(keys.unwrap(b.wrapped, b.keyId, aadOf(b), ticket)).rejects.toThrow('ticket is for another document version');
    // Doc A's AAD but B's wrapped key.
    await expect(keys.unwrap(b.wrapped, b.keyId, aadOf(a), ticket)).rejects.toThrow('ticket is for another wrapped key');
    const dek = await keys.unwrap(a.wrapped, a.keyId, aadOf(a), ticket);
    expect(createHash('sha256').update(decrypt(a, dek)).digest()).toEqual(a.sha);
    await expect(keys.unwrap(a.wrapped, a.keyId, aadOf(a), ticket)).rejects.toThrow('ticket already used');
    // A later key service (clock 2 minutes ahead) refuses a fresh ticket as expired.
    const late = new LocalKeyProvider(master, { clock: () => Date.now() + 120_000 });
    const { ticket: t2 } = await ticketAsApp(a, owner.id);
    await expect(late.unwrap(a.wrapped, a.keyId, aadOf(a), t2)).rejects.toThrow('ticket expired');
  });

  it('a quarantined version gets no download ticket', async () => {
    const v = await upload('Quarantined');
    await withDb(ownerDb(), (db) => db.query(`INSERT INTO version_quarantine (version_id, signature, scanner) VALUES ($1, 'Test.Sig', 'test')`, [v.versionId]));
    expect(await sqlError(ticketAsApp(v, owner.id))).toMatch(/quarantined/);
  });

  it('keyd rate-limits each user, so impersonating one user cannot drain the store quickly', async () => {
    const v = await upload('Limited');
    const limited = new LocalKeyProvider(master, { limits: { userPerMin: 2 } });
    // The limit counts per clock minute (as keyd does): start well inside a
    // minute so the three unwraps below cannot straddle two windows.
    const intoMinute = Date.now() % 60_000;
    if (intoMinute > 45_000) await new Promise((r) => setTimeout(r, 60_000 - intoMinute + 200));
    for (let i = 0; i < 2; i++) {
      const { ticket } = await ticketAsApp(v, owner.id);
      await limited.unwrap(v.wrapped, v.keyId, aadOf(v), ticket);
    }
    const { ticket } = await ticketAsApp(v, owner.id);
    await expect(limited.unwrap(v.wrapped, v.keyId, aadOf(v), ticket)).rejects.toThrow('rate limited');
    expect(limited.ledger.read(1, 100).at(-1)).toMatchObject({ event: 'refuse', result: 'rate limited', user: owner.id });
  });

  it('a download refused by keyd is not reported as an integrity failure', async () => {
    const v = await upload('Throttled');
    const realUnwrap = keys.unwrap.bind(keys);
    keys.unwrap = async () => { throw new Error('keyd: rate limited'); };
    try {
      await as(t, ownerS).get(`/api/documents/${v.docId}/download`).expect(429);
    } finally {
      keys.unwrap = realUnwrap;
    }
    const rows = await auditRows(`document_id = $1 AND outcome <> 'ALLOWED'`, [v.docId]);
    expect(rows.map((r) => [r.action, r.reason])).toEqual([['document.download', 'key_service_refused']]);
  });

  it('TOTP secrets need no ticket but cannot be used to open a document key', async () => {
    const v = await upload('Class');
    const totpAad = `tv-totp-v1|${owner.id}`;
    await expect(keys.unwrap(v.wrapped, v.keyId, totpAad)).rejects.toThrow();
    await expect(keys.unwrap(v.wrapped, 'local-g1-totp', totpAad)).rejects.toThrow();
    await expect(keys.unwrap(v.wrapped, 'local-g1-totp', aadOf(v))).rejects.toThrow(/ticket required|does not match/);
  });
});

describe('the key ledger is reconciled with the audit log', () => {
  it('normal downloads reconcile cleanly', async () => {
    const v = await upload('Clean');
    await as(t, ownerS).get(`/api/documents/${v.docId}/download`).expect(200);
    const r = await ledger.reconcile({ graceMs: 0 });
    const mine = r.findings.filter((f) => f.documentId === v.docId);
    expect(mine).toEqual([]);
    expect(r.counts.unwraps).toBeGreaterThanOrEqual(1);
    const { rows } = await withDb(appDb(), (db) => db.query('SELECT count(*)::int AS n FROM keyd_ledger_checkpoints'));
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('a key released on a ticket from a rolled-back transaction is caught (no audit event, no ticket record)', async () => {
    const v = await upload('Rolled back');
    const { ticket } = await ticketAsApp(v, owner.id, { finish: 'ROLLBACK' });
    await keys.unwrap(v.wrapped, v.keyId, aadOf(v), ticket); // succeeds: keyd cannot see the database...
    const r = await ledger.reconcile({ graceMs: 0 });          // ...but reconciliation can.
    const mine = r.findings.filter((f) => f.documentId === v.docId).map((f) => f.kind).sort();
    expect(mine).toEqual(['release_without_audit', 'release_without_issued_ticket']);
    expect(r.ok).toBe(false);
    const alerts = await t.app.get(AuditAdminService).alerts(1);
    expect(alerts.alerts.some((a) => a.kind === 'key_ledger_mismatch')).toBe(true);
  });

  it('an ALLOWED download recorded without the key service is caught', async () => {
    const v = await upload('Bypass');
    // The API writes a download event and serves bytes from a cached key.
    await withDb(appDb(), (db) => db.query(
      `INSERT INTO audit_events (id, actor_id, actor_email, action, outcome, document_id, details) VALUES (gen_random_uuid(), $1, 'x', 'document.download', 'ALLOWED', $2, $3)`,
      [owner.id, v.docId, JSON.stringify({ versionNo: 1 })]));
    const r = await ledger.reconcile({ graceMs: 0 });
    expect(r.findings.filter((f) => f.documentId === v.docId).map((f) => f.kind)).toEqual(['release_without_ticket']);
  });

  it('probing keyd with forged tickets is reported', async () => {
    const v = await upload('Probe');
    await expect(keys.unwrap(v.wrapped, v.keyId, aadOf(v), 'tv-unwrap-ticket-v1|nonsense')).rejects.toThrow();
    const r = await ledger.reconcile({ graceMs: 0 });
    expect(r.findings.some((f) => f.kind === 'keyd_probe' && /malformed ticket/.test(f.message))).toBe(true);
  });

  it('a ledger edited after the fact fails verification, and the mirror refuses to extend a different chain', async () => {
    await ledger.mirror();
    const entries = keys.ledger.read(1, 500);
    expect(verifyLedgerRun(0, ZERO_HASH, entries)).toBeNull();
    const edited = entries.map((e) => ({ ...e }));
    edited[1] = { ...edited[1]!, user: stranger.id };
    expect(verifyLedgerRun(0, ZERO_HASH, edited)).toMatch(/hash mismatch/);
    // The database itself refuses a mirrored row that does not link.
    const [last] = entries.slice(-1);
    const err = await sqlError(withDb(appDb(), (db) => db.query(
      `INSERT INTO keyd_ledger_entries (epoch, seq, ts_ms, event, result, prev_hash, hash) VALUES ($1, $2, 0, 'unwrap', 'ok', $3, $3)`,
      [entries[0]!.hash, last!.seq + 5, 'a'.repeat(64)])));
    expect(err).toMatch(/does not extend/);
    expect(await sqlError(withDb(appDb(), (db) => db.query('DELETE FROM keyd_ledger_entries')))).toMatch(/permission denied|append-only/);
  });

  it('a key service that starts a new ledger (state wiped) is reported', async () => {
    const replaced = new LocalKeyProvider(master);
    const svc = new KeyLedgerService(t.app.get(KeyLedgerService)['prisma'], t.app.get(KeyLedgerService)['audit'], replaced);
    const r = await svc.mirror();
    expect(r.problems.join(' ')).toMatch(/started a new ledger/);
    const [ev] = (await auditRows(`action = 'keyd.ledger'`)).slice(-1);
    expect(ev).toMatchObject({ outcome: 'FAILED' });
  });

  it('the witness endpoint publishes signed ledger heads without signing in', async () => {
    await ledger.mirror();
    const res = await t.http.get('/api/witness/keyd-ledger?since=1').expect(200);
    expect(res.body.format).toBe('trustvault-keyd-ledger-v1');
    expect(res.body.checkpoints.length).toBeGreaterThanOrEqual(1);
    expect(res.body.checkpoints[0]).toMatchObject({ seq: expect.any(String), headHash: expect.stringMatching(/^[0-9a-f]{64}$/), signature: expect.any(String) });
  });

  // Last: it leaves this key service's ledger broken on purpose.
  it('an entry altered before it is mirrored is refused, and reported', async () => {
    await ledger.mirror();
    const v = await upload('Tampered ledger');
    await expect(keys.unwrap(v.wrapped, v.keyId, aadOf(v))).rejects.toThrow();
    const entries = (keys.ledger as unknown as { entries: { user: string | null }[] }).entries;
    entries[entries.length - 1]!.user = stranger.id;
    const r = await ledger.mirror();
    expect(r.problems.join(' ')).toMatch(/hash mismatch/);
    const [ev] = (await auditRows(`action = 'keyd.ledger'`)).slice(-1);
    expect(ev).toMatchObject({ outcome: 'FAILED' });
  });
});
