import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { checkpointMessage } from '../src/audit/audit-admin.service.js';
import { appDb, keys } from './helpers.js';

// A compromised API process holds the app role's INSERT on
// audit_checkpoints. These tests talk to Postgres directly as that role to
// prove the database itself refuses a checkpoint that does not describe the
// real chain (missing event, wrong head hash) or that does not move forward
// — otherwise a single far-future checkpoint would stop all later signing.

let app: pg.Client;

beforeAll(async () => {
  app = appDb();
  await app.connect();
});
afterAll(async () => {
  await app.end();
});

const event = async (action = 'test.checkpoint_guard') =>
  (await app.query<{ seq: string; hash: Buffer }>(
    `INSERT INTO audit_events (id, action, outcome) VALUES (gen_random_uuid(), $1, 'ALLOWED') RETURNING seq, hash`,
    [action],
  )).rows[0]!;

/** Signed with the test key, so a stored row still passes /audit/verify in other tests. */
const insertCheckpoint = async (seq: bigint, headHash: Buffer) => {
  const { signature, keyId } = await keys().sign(checkpointMessage(seq, headHash));
  return app.query(
    `INSERT INTO audit_checkpoints (seq, head_hash, signature, key_id) VALUES ($1, $2, $3, $4)`,
    [seq.toString(), headHash, signature, keyId],
  );
};

describe('audit checkpoints: the database only accepts real, forward-moving checkpoints', () => {
  it('refuses a checkpoint for a seq that has no audit event (e.g. 2^62)', async () => {
    const head = await event();
    await expect(insertCheckpoint(2n ** 62n, randomBytes(32))).rejects.toThrow(/no audit event/);
    await expect(insertCheckpoint(BigInt(head.seq) + 1_000_000n, head.hash)).rejects.toThrow(/no audit event/);
  });

  it('refuses a checkpoint whose head hash is not the event hash', async () => {
    const head = await event();
    await expect(insertCheckpoint(BigInt(head.seq), randomBytes(32))).rejects.toThrow(/head hash does not match/);
  });

  it('accepts a correct checkpoint, then refuses one at or below it', async () => {
    const earlier = await event();
    const head = await event();
    await expect(insertCheckpoint(BigInt(head.seq), head.hash)).resolves.toBeDefined();
    const { rows } = await app.query<{ seq: string }>(`SELECT max(seq)::text AS seq FROM audit_checkpoints`);
    expect(rows[0]!.seq).toBe(head.seq);

    // A real event with its real hash, but behind the latest checkpoint.
    await expect(insertCheckpoint(BigInt(earlier.seq), earlier.hash)).rejects.toThrow(/not above the latest checkpoint/);
    // The same seq again.
    await expect(insertCheckpoint(BigInt(head.seq), head.hash)).rejects.toThrow(/not above the latest checkpoint/);

    // And the chain can still be checkpointed further on.
    const next = await event();
    await expect(insertCheckpoint(BigInt(next.seq), next.hash)).resolves.toBeDefined();
  });
});
