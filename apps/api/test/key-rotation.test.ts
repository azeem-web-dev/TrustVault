import { createDecipheriv, createHash, hkdfSync } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDb, as, createUser, login, ownerDb, PDF, resetState, startApp, testEnv, withDb, type Session, type TestApp, type TestUser } from './helpers.js';
import { aesGcmOpen, aesGcmSeal, LocalKeyProvider, type KeyProvider } from '../src/crypto/key-provider.js';
import { blobAad } from '../src/crypto/file-crypto.js';
import { reencryptAll, rotateKeys, verifyKeys } from '../src/keys/rotation.js';

// Checklist item 7 / docs/KEYS.md: versioned wrapping keys, re-wrapping
// without exposing data keys, interruption, retirement, emergency
// re-encryption. The tools run as the schema owner, as on the server.

let t: TestApp;
let owner: TestUser;
let ownerS: Session;
const master = Buffer.from(testEnv().LOCAL_MASTER_KEY!, 'base64');
const master2 = Buffer.alloc(32, 0x42);
const gen2 = () => new LocalKeyProvider(master, { generations: new Map([[2, master2]]), limits: { maintPerHour: 10_000 } });
const hk = (m: Buffer, label: string) => Buffer.from(hkdfSync('sha256', m, Buffer.alloc(0), label, 32));

interface Row { versionId: string; docId: string; versionNo: number; keyId: string; wrapped: Buffer; nonce: Buffer; tag: Buffer; ct: Buffer; sha: Buffer }

async function rows(): Promise<Row[]> {
  return withDb(ownerDb(), async (db) => (await db.query(
    `SELECT v.id, v.document_id, v.version_no, v.sha256, b.key_id, b.wrapped_key, b.nonce, b.auth_tag, b.ciphertext
       FROM document_blobs b JOIN document_versions v ON v.id = b.version_id ORDER BY v.id`)).rows.map((r) => ({
    versionId: r.id, docId: r.document_id, versionNo: r.version_no, keyId: r.key_id, wrapped: r.wrapped_key, nonce: r.nonce, tag: r.auth_tag, ct: r.ciphertext, sha: r.sha256,
  })));
}

/** Decrypts one stored version the way the API does: audit event + database ticket + key service. */
async function openViaTicket(keys: KeyProvider, r: Row): Promise<Buffer> {
  const ticket = await withDb(appDb(), async (db) => {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.user_id', $1, true)`, [owner.id]);
    const { rows: [e] } = await db.query(`INSERT INTO audit_events (id, actor_id, action, outcome, document_id, details) VALUES (gen_random_uuid(), $1, 'document.download', 'ALLOWED', $2, $3) RETURNING id`,
      [owner.id, r.docId, JSON.stringify({ versionNo: r.versionNo })]);
    const { rows: [x] } = await db.query('SELECT tv_issue_unwrap_ticket($1, $2, $3) AS ticket', [r.versionId, 'download', e.id]);
    await db.query('COMMIT');
    return x.ticket as string;
  });
  const aad = blobAad(r.docId, r.versionId, r.versionNo);
  const dek = await keys.unwrap(r.wrapped, r.keyId, aad, ticket);
  const d = createDecipheriv('aes-256-gcm', dek, r.nonce);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(r.tag);
  return Buffer.concat([d.update(r.ct), d.final()]);
}

const owned = <T>(fn: (db: pg.Client) => Promise<T>) => withDb(ownerDb(), fn);

beforeAll(async () => {
  t = await startApp();
  await resetState(t.app);
  owner = await createUser({ email: 'rot-owner@t.io', role: 'OWNER', mfa: true });
  ownerS = await login(t, owner);
  for (let i = 0; i < 5; i++) {
    await as(t, ownerS).upload('/api/documents', Buffer.concat([PDF, Buffer.from(`%${i}\n`)]), `r${i}.pdf`, { title: `Rotate ${i}`, category: 'Keys' }).expect(201);
  }
  // One version as written before key generations existed (key id local-v1),
  // to prove legacy values migrate too.
  const [first] = await rows();
  const aad = blobAad(first!.docId, first!.versionId, first!.versionNo);
  const dek = aesGcmOpen(hk(master, 'tv-wrap-g1-blob'), first!.wrapped, aad);
  await owned((db) => db.query(`UPDATE document_blobs SET wrapped_key = $1, key_id = 'local-v1' WHERE version_id = $2`, [aesGcmSeal(hk(master, 'tv-wrap-v1'), dek, aad), first!.versionId]));
});
afterAll(async () => {
  await t.close();
});

describe('key rotation', () => {
  it('the legacy value still downloads before rotation', async () => {
    const [first] = await rows();
    expect(first!.keyId).toBe('local-v1');
    await as(t, ownerS).get(`/api/documents/${first!.docId}/download`).expect(200);
  });

  it('an interrupted rotation leaves every row old or new, and running again finishes it', async () => {
    const before = await rows();
    const keys = gen2();
    let calls = 0;
    const flaky = new Proxy(keys, {
      get(target, prop) {
        if (prop === 'rewrap') {
          return async (w: Buffer, id: string, aad: string) => {
            if (++calls === 3) throw new Error('simulated crash');
            return target.rewrap(w, id, aad);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as KeyProvider;
    const first = await owned((db) => rotateKeys(db, flaky, { batch: 2 }));
    expect(first.blobs.failed).toHaveLength(1);
    const mid = await rows();
    for (const r of mid) expect(['local-v1', 'local-g1-blob', 'local-g2-blob']).toContain(r.keyId);
    expect((await owned((db) => verifyKeys(db, keys))).ok).toBe(false);

    const second = await owned((db) => rotateKeys(db, keys, { batch: 2 }));
    expect(second.blobs.failed).toEqual([]);
    expect(first.blobs.rewrapped + second.blobs.rewrapped).toBe(before.length);
    expect(second.totp.rewrapped + first.totp.rewrapped).toBe(1);
    const v = await owned((db) => verifyKeys(db, keys));
    expect(v).toMatchObject({ ok: true, target: { blob: 'local-g2-blob', totp: 'local-g2-totp' } });
    expect(v.blobs.current).toBe(before.length);

    // Running again changes nothing.
    const third = await owned((db) => rotateKeys(db, keys));
    expect(third.blobs).toMatchObject({ rewrapped: 0, failed: [] });

    // Data keys did not change (ciphertexts untouched); every version still opens with its original content.
    const after = await rows();
    for (const [i, r] of after.entries()) {
      expect(r.ct).toEqual(before[i]!.ct);
      expect(createHash('sha256').update(await openViaTicket(keys, r)).digest()).toEqual(r.sha);
    }
    const audit = await owned((db) => db.query(`SELECT outcome FROM audit_events WHERE action = 'keys.rotate' ORDER BY seq DESC LIMIT 3`));
    expect(audit.rows.map((r) => r.outcome)).toEqual(['ALLOWED', 'ALLOWED', 'FAILED']);
  });

  it('the TOTP secret survives rotation', async () => {
    const keys = gen2();
    const { rows: [u] } = await owned((db) => db.query('SELECT totp_secret_enc FROM users WHERE id = $1', [owner.id]));
    const stored: Buffer = u.totp_secret_enc;
    const keyId = stored.subarray(1, 1 + stored[0]!).toString();
    expect(keyId).toBe('local-g2-totp');
    const secret = await keys.unwrap(stored.subarray(1 + stored[0]!), keyId, `tv-totp-v1|${owner.id}`);
    expect(secret).toEqual(owner.totpSecret);
  });

  it('a retired generation can no longer open anything, and the old master alone cannot open the new keys', async () => {
    const retired = new LocalKeyProvider(master, { generations: new Map([[2, master2]]), retired: [1] });
    expect((await owned((db) => verifyKeys(db, retired))).ok).toBe(true);
    const [r] = await rows();
    const oldOnly = new LocalKeyProvider(master);
    expect(await oldOnly.check(r!.wrapped, r!.keyId, blobAad(r!.docId, r!.versionId, r!.versionNo))).toEqual({ ok: false, current: false });
    // A value still wrapped under generation 1 is refused once 1 is retired.
    const g1 = await oldOnly.wrap(Buffer.alloc(32, 1), blobAad(r!.docId, r!.versionId, r!.versionNo));
    expect(await retired.check(g1.wrapped, g1.keyId, blobAad(r!.docId, r!.versionId, r!.versionNo))).toEqual({ ok: false, current: false });
  });
});

describe('emergency re-encryption', () => {
  it('is refused by the key service unless maintenance unwraps were enabled, and the app role cannot get maintenance tickets', async () => {
    const closed = new LocalKeyProvider(master, { generations: new Map([[2, master2]]) });
    const r = await owned((db) => reencryptAll(db, closed, { maxVersions: 1 }));
    expect(r.failed[0]).toMatch(/rate limited/);
    const [row] = await rows();
    const err = await withDb(appDb(), (db) => db.query('SELECT tv_issue_maintenance_ticket($1, gen_random_uuid())', [row!.versionId]).then(() => null, (e: Error) => e.message));
    expect(err).toMatch(/permission denied/);
  });

  it('gives every version a new data key and ciphertext, keeps the content and AAD binding, and resumes after interruption', async () => {
    const keys = gen2();
    const before = await rows();
    const part = await owned((db) => reencryptAll(db, keys, { maxVersions: 2 }));
    expect(part).toMatchObject({ done: false, reencrypted: 2 });
    const rest = await owned((db) => reencryptAll(db, keys));
    expect(rest).toMatchObject({ run: part.run, resumed: true, done: true });
    // Every version was re-encrypted exactly once in this run (the refused attempt above rolled back).
    const { rows: done } = await owned((db) => db.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'keys.reencrypt_version' AND details ->> 'run' = $1`, [part.run]));
    expect(done[0].n).toBe(before.length);
    const after = await rows();
    for (const [i, r] of after.entries()) {
      const old = before[i]!;
      expect(r.ct.equals(old.ct)).toBe(false);
      expect(r.wrapped.equals(old.wrapped)).toBe(false);
      expect(r.sha).toEqual(old.sha);
      const plain = await openViaTicket(keys, r);
      expect(createHash('sha256').update(plain).digest()).toEqual(r.sha);
    }
    // Moving a re-encrypted blob to another version breaks it (AAD binding kept).
    const [a, b] = after;
    await owned((db) => db.query('UPDATE document_blobs SET ciphertext = $1, nonce = $2, auth_tag = $3, wrapped_key = $4 WHERE version_id = $5', [a!.ct, a!.nonce, a!.tag, a!.wrapped, b!.versionId]));
    await expect(openViaTicket(keys, { ...a!, versionId: b!.versionId, docId: b!.docId, versionNo: b!.versionNo })).rejects.toThrow();
    await owned((db) => db.query('UPDATE document_blobs SET ciphertext = $1, nonce = $2, auth_tag = $3, wrapped_key = $4 WHERE version_id = $5', [b!.ct, b!.nonce, b!.tag, b!.wrapped, b!.versionId]));
    // Each re-encryption unwrap is a ledgered, ticketed 'reencrypt' with no user.
    const re = keys.ledger.read(1, 500).filter((e) => e.event === 'unwrap' && e.action === 'reencrypt');
    expect(re).toHaveLength(before.length);
    expect(re.every((e) => e.user === null && e.result === 'ok')).toBe(true);
  });
});
