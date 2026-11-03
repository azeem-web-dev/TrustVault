import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { KeyProvider } from '../crypto/key-provider.js';
import { blobAad } from '../crypto/file-crypto.js';

/**
 * Key rotation, verification and emergency re-encryption (docs/KEYS.md).
 * Run by the operator through `node dist/cli/keys.js`, connected as the
 * schema OWNER (the application role may not update stored blobs), talking
 * to keyd as the trustvault user. Every step is resumable and idempotent:
 * each row is updated with a compare-and-swap on its old value, in small
 * transactions, so an interruption at any point leaves every row either
 * fully old or fully new, and running again continues.
 */

export type Log = (msg: string) => void;
const quiet: Log = () => {};

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const totpAad = (userId: string) => `tv-totp-v1|${userId}`;
// Same layout as mfa.service.ts packWrapped/unpackWrapped: [id length][key id][wrapped].
const pack = (keyId: string, wrapped: Buffer) => Buffer.concat([Buffer.from([Buffer.byteLength(keyId)]), Buffer.from(keyId), wrapped]);
const unpack = (stored: Buffer) => ({ keyId: stored.subarray(1, 1 + (stored[0] ?? 0)).toString('utf8'), wrapped: stored.subarray(1 + (stored[0] ?? 0)) });

/** Audit event written directly as the owner (the chain trigger still assigns seq and hash). */
async function audit(db: pg.Client, e: { action: string; outcome: 'ALLOWED' | 'FAILED'; reason?: string; targetType?: string; targetId?: string; documentId?: string; details: unknown }): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO audit_events (id, actor_email, action, outcome, reason, target_type, target_id, document_id, details)
     VALUES (gen_random_uuid(), 'key-rotation', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [e.action, e.outcome, e.reason ?? null, e.targetType ?? null, e.targetId ?? null, e.documentId ?? null, JSON.stringify(e.details)],
  );
  return rows[0]!.id;
}

interface BlobRow { version_id: string; document_id: string; version_no: number; key_id: string; wrapped_key: Buffer }

export interface RotateResult {
  target: { blob: string; totp: string };
  blobs: { rewrapped: number; alreadyCurrent: number; changedMeanwhile: number; failed: string[] };
  totp: { rewrapped: number; alreadyCurrent: number; changedMeanwhile: number; failed: string[] };
}

/**
 * Re-wraps every document data key and TOTP secret that is not on the key
 * service's current generation. keyd unwraps and re-wraps internally
 * (`rewrap`): no data key or secret is ever visible to this tool.
 */
export async function rotateKeys(db: pg.Client, keys: KeyProvider, { batch = 100, log = quiet }: { batch?: number; log?: Log } = {}): Promise<RotateResult> {
  const { wrapKeyIds: target } = await keys.status();
  const res: RotateResult = { target, blobs: { rewrapped: 0, alreadyCurrent: 0, changedMeanwhile: 0, failed: [] }, totp: { rewrapped: 0, alreadyCurrent: 0, changedMeanwhile: 0, failed: [] } };
  const { rows: [todo] } = await db.query<{ n: string }>('SELECT count(*) AS n FROM document_blobs WHERE key_id <> $1', [target.blob]);
  log(`document keys to re-wrap under ${target.blob}: ${todo!.n}`);

  let cursor = ZERO_UUID;
  for (;;) {
    const { rows } = await db.query<BlobRow>(
      `SELECT b.version_id, v.document_id, v.version_no, b.key_id, b.wrapped_key
         FROM document_blobs b JOIN document_versions v ON v.id = b.version_id
        WHERE b.version_id > $1 AND b.key_id <> $2 ORDER BY b.version_id LIMIT $3`, [cursor, target.blob, batch]);
    if (rows.length === 0) break;
    await db.query('BEGIN');
    try {
      for (const r of rows) {
        try {
          const out = await keys.rewrap(r.wrapped_key, r.key_id, blobAad(r.document_id, r.version_id, r.version_no));
          if (!out.changed) { res.blobs.alreadyCurrent++; continue; }
          const u = await db.query('UPDATE document_blobs SET wrapped_key = $1, key_id = $2 WHERE version_id = $3 AND key_id = $4 AND wrapped_key = $5',
            [out.wrapped, out.keyId, r.version_id, r.key_id, r.wrapped_key]);
          if (u.rowCount === 1) res.blobs.rewrapped++; else res.blobs.changedMeanwhile++;
        } catch (err) {
          res.blobs.failed.push(`${r.version_id}: ${(err as Error).message}`);
        }
      }
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    cursor = rows.at(-1)!.version_id;
    log(`  ... re-wrapped ${res.blobs.rewrapped} document keys (${res.blobs.failed.length} failed), at ${cursor}`);
  }

  cursor = ZERO_UUID;
  for (;;) {
    const { rows } = await db.query<{ id: string; totp_secret_enc: Buffer }>(
      'SELECT id, totp_secret_enc FROM users WHERE id > $1 AND totp_secret_enc IS NOT NULL ORDER BY id LIMIT $2', [cursor, batch]);
    if (rows.length === 0) break;
    await db.query('BEGIN');
    try {
      for (const r of rows) {
        const { keyId, wrapped } = unpack(r.totp_secret_enc);
        if (keyId === target.totp) { res.totp.alreadyCurrent++; continue; }
        try {
          const out = await keys.rewrap(wrapped, keyId, totpAad(r.id));
          if (!out.changed) { res.totp.alreadyCurrent++; continue; }
          const u = await db.query('UPDATE users SET totp_secret_enc = $1 WHERE id = $2 AND totp_secret_enc = $3', [pack(out.keyId, out.wrapped), r.id, r.totp_secret_enc]);
          if (u.rowCount === 1) res.totp.rewrapped++; else res.totp.changedMeanwhile++;
        } catch (err) {
          res.totp.failed.push(`${r.id}: ${(err as Error).message}`);
        }
      }
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    cursor = rows.at(-1)!.id;
  }
  log(`TOTP secrets re-wrapped: ${res.totp.rewrapped} (${res.totp.failed.length} failed)`);
  const failed = res.blobs.failed.length + res.totp.failed.length;
  await audit(db, {
    action: 'keys.rotate', outcome: failed ? 'FAILED' : 'ALLOWED', ...(failed ? { reason: 'some_values_failed' } : {}),
    details: { target, blobs: { ...res.blobs, failed: res.blobs.failed.slice(0, 50) }, totp: { ...res.totp, failed: res.totp.failed.slice(0, 50) } },
  });
  return res;
}

export interface VerifyResult {
  ok: boolean;
  target: { blob: string; totp: string };
  blobs: { total: number; current: number; notCurrent: string[]; broken: string[] };
  totp: { total: number; current: number; notCurrent: string[]; broken: string[] };
}

/**
 * Asks keyd (`check`) whether every wrapped value still opens with the key
 * it names and whether that is the current generation. Nothing is returned
 * by keyd but yes/no. ok = every value opens and is current.
 */
export async function verifyKeys(db: pg.Client, keys: KeyProvider, { batch = 500, log = quiet }: { batch?: number; log?: Log } = {}): Promise<VerifyResult> {
  const { wrapKeyIds: target } = await keys.status();
  const res: VerifyResult = { ok: false, target, blobs: { total: 0, current: 0, notCurrent: [], broken: [] }, totp: { total: 0, current: 0, notCurrent: [], broken: [] } };
  let cursor = ZERO_UUID;
  for (;;) {
    const { rows } = await db.query<BlobRow>(
      `SELECT b.version_id, v.document_id, v.version_no, b.key_id, b.wrapped_key
         FROM document_blobs b JOIN document_versions v ON v.id = b.version_id
        WHERE b.version_id > $1 ORDER BY b.version_id LIMIT $2`, [cursor, batch]);
    if (rows.length === 0) break;
    for (const r of rows) {
      res.blobs.total++;
      const c = await keys.check(r.wrapped_key, r.key_id, blobAad(r.document_id, r.version_id, r.version_no));
      if (!c.ok) res.blobs.broken.push(r.version_id);
      else if (!c.current) res.blobs.notCurrent.push(r.version_id);
      else res.blobs.current++;
    }
    cursor = rows.at(-1)!.version_id;
  }
  cursor = ZERO_UUID;
  for (;;) {
    const { rows } = await db.query<{ id: string; totp_secret_enc: Buffer }>(
      'SELECT id, totp_secret_enc FROM users WHERE id > $1 AND totp_secret_enc IS NOT NULL ORDER BY id LIMIT $2', [cursor, batch]);
    if (rows.length === 0) break;
    for (const r of rows) {
      res.totp.total++;
      const { keyId, wrapped } = unpack(r.totp_secret_enc);
      const c = await keys.check(wrapped, keyId, totpAad(r.id));
      if (!c.ok) res.totp.broken.push(r.id);
      else if (!c.current) res.totp.notCurrent.push(r.id);
      else res.totp.current++;
    }
    cursor = rows.at(-1)!.id;
  }
  res.ok = res.blobs.broken.length + res.blobs.notCurrent.length + res.totp.broken.length + res.totp.notCurrent.length === 0;
  log(`document keys: ${res.blobs.current}/${res.blobs.total} current, ${res.blobs.notCurrent.length} on an older key, ${res.blobs.broken.length} do not open`);
  log(`TOTP secrets: ${res.totp.current}/${res.totp.total} current, ${res.totp.notCurrent.length} on an older key, ${res.totp.broken.length} do not open`);
  return res;
}

export interface ReencryptResult {
  run: string;
  resumed: boolean;
  reencrypted: number;
  failed: string[];
  done: boolean;
}

/**
 * EMERGENCY: after a suspected compromise of document DATA keys (not just
 * the wrapping key), gives every stored version a new random data key and a
 * new ciphertext. Same AAD (document, version, number), so the AAD binding
 * is preserved; the plaintext's SHA-256 is checked against the stored hash
 * before anything is written, and the new ciphertext is decrypted again
 * before the old one is replaced.
 *
 * Each version: one transaction that writes a keys.reencrypt_version audit
 * event, obtains an owner-only maintenance ticket for it, unwraps the old
 * data key through keyd, re-encrypts, and swaps the row (compare-and-swap).
 * keyd refuses maintenance tickets unless the operator set
 * KEYD_LIMIT_MAINT_PER_HOUR for the duration. Resumable: a run is named in
 * its keys.reencrypt start event; versions with a committed per-version
 * event for that run are skipped when it is continued.
 */
export async function reencryptAll(db: pg.Client, keys: KeyProvider, { batch = 20, maxVersions = Number.MAX_SAFE_INTEGER, log = quiet }: { batch?: number; maxVersions?: number; log?: Log } = {}): Promise<ReencryptResult> {
  const { rows: [open] } = await db.query<{ run: string }>(
    `SELECT s.details ->> 'run' AS run FROM audit_events s
      WHERE s.action = 'keys.reencrypt' AND s.reason = 'started'
        AND NOT EXISTS (SELECT 1 FROM audit_events f WHERE f.action = 'keys.reencrypt' AND f.reason IN ('finished', 'finished_with_failures')
                          AND f.details ->> 'run' = s.details ->> 'run')
      ORDER BY s.seq DESC LIMIT 1`);
  const run = open?.run ?? randomUUID();
  if (!open) await audit(db, { action: 'keys.reencrypt', outcome: 'ALLOWED', reason: 'started', details: { run } });
  log(`${open ? 'continuing' : 'starting'} re-encryption run ${run}`);
  const res: ReencryptResult = { run, resumed: Boolean(open), reencrypted: 0, failed: [], done: false };
  let cursor = ZERO_UUID;
  let attempted = 0;
  for (;;) {
    const { rows } = await db.query<{ id: string; document_id: string; version_no: number }>(
      `SELECT v.id, v.document_id, v.version_no FROM document_versions v
        WHERE v.id > $1 AND NOT EXISTS (SELECT 1 FROM audit_events e WHERE e.action = 'keys.reencrypt_version' AND e.target_id = v.id::text AND e.details ->> 'run' = $2)
        ORDER BY v.id LIMIT $3`, [cursor, run, batch]);
    if (rows.length === 0) { res.done = true; break; }
    for (const v of rows) {
      if (attempted >= maxVersions) break;
      attempted++;
      try {
        await reencryptOne(db, keys, run, v);
        res.reencrypted++;
      } catch (err) {
        res.failed.push(`${v.id}: ${(err as Error).message}`);
      }
      cursor = v.id;
    }
    if (attempted >= maxVersions) break;
    log(`  ... re-encrypted ${res.reencrypted} versions (${res.failed.length} failed)`);
  }
  if (res.done) {
    await audit(db, {
      action: 'keys.reencrypt', outcome: res.failed.length ? 'FAILED' : 'ALLOWED', reason: res.failed.length ? 'finished_with_failures' : 'finished',
      details: { run, reencrypted: res.reencrypted, failed: res.failed.slice(0, 50) },
    });
  }
  return res;
}

async function reencryptOne(db: pg.Client, keys: KeyProvider, run: string, v: { id: string; document_id: string; version_no: number }) {
  const aad = blobAad(v.document_id, v.id, v.version_no);
  await db.query('BEGIN');
  let dek: Buffer | null = null;
  let newDek: Buffer | null = null;
  try {
    const { rows: [blob] } = await db.query<{ wrapped_key: Buffer; key_id: string; nonce: Buffer; auth_tag: Buffer; ciphertext: Buffer; sha256: Buffer }>(
      `SELECT b.wrapped_key, b.key_id, b.nonce, b.auth_tag, b.ciphertext, dv.sha256
         FROM document_blobs b JOIN document_versions dv ON dv.id = b.version_id WHERE b.version_id = $1 FOR UPDATE OF b`, [v.id]);
    if (!blob) throw new Error('no stored blob');
    const eventId = await audit(db, {
      action: 'keys.reencrypt_version', outcome: 'ALLOWED', reason: 'emergency_reencryption',
      targetType: 'document_version', targetId: v.id, documentId: v.document_id, details: { run, versionNo: v.version_no, oldKeyId: blob.key_id },
    });
    const { rows: [t] } = await db.query<{ ticket: string }>('SELECT tv_issue_maintenance_ticket($1, $2) AS ticket', [v.id, eventId]);
    dek = await keys.unwrap(blob.wrapped_key, blob.key_id, aad, t!.ticket);
    const d = createDecipheriv('aes-256-gcm', dek, blob.nonce);
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(blob.auth_tag);
    const plaintext = Buffer.concat([d.update(blob.ciphertext), d.final()]);
    if (!createHash('sha256').update(plaintext).digest().equals(blob.sha256)) throw new Error('stored file does not match its recorded SHA-256; left unchanged');
    newDek = randomBytes(32);
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', newDek, nonce);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
    const tag = c.getAuthTag();
    // Prove the new ciphertext opens before the old one is replaced.
    const check = createDecipheriv('aes-256-gcm', newDek, nonce);
    check.setAAD(Buffer.from(aad, 'utf8'));
    check.setAuthTag(tag);
    if (!createHash('sha256').update(Buffer.concat([check.update(ciphertext), check.final()])).digest().equals(blob.sha256)) throw new Error('re-encryption self-check failed');
    plaintext.fill(0);
    const { wrapped, keyId } = await keys.wrap(newDek, aad);
    const u = await db.query(
      `UPDATE document_blobs SET wrapped_key = $1, key_id = $2, nonce = $3, auth_tag = $4, ciphertext = $5
        WHERE version_id = $6 AND wrapped_key = $7`, [wrapped, keyId, nonce, tag, ciphertext, v.id, blob.wrapped_key]);
    if (u.rowCount !== 1) throw new Error('the stored blob changed during re-encryption');
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    dek?.fill(0);
    newDek?.fill(0);
  }
}

/** Installs keyd's ticket key in the database (raw 32 bytes or base64 text). Returns the key id. */
export async function installTicketKey(db: pg.Client, input: Buffer): Promise<string> {
  const key = input.length === 32 ? input : Buffer.from(input.toString('utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error('the ticket key must be 32 bytes (raw or base64)');
  const { rows } = await db.query<{ kid: string }>('SELECT tv_install_ticket_key($1) AS kid', [key]);
  key.fill(0);
  return rows[0]!.kid;
}
