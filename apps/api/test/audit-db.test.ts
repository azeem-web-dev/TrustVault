import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { appDb, ownerDb } from './helpers.js';

// These tests talk to Postgres directly, bypassing the API, to prove the
// audit log is protected by the database itself — not by application code
// that a bug or a compromised process could skip.

let app: pg.Client;
let owner: pg.Client;

beforeAll(async () => {
  app = appDb();
  owner = ownerDb();
  await app.connect();
  await owner.connect();
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

const insert = (c: pg.Client, action = 'test.event') =>
  c.query<{ seq: string; prev_hash: Buffer; hash: Buffer; occurred_at: Date }>(
    `INSERT INTO audit_events (id, action, outcome) VALUES (gen_random_uuid(), $1, 'ALLOWED')
     RETURNING seq, prev_hash, hash, occurred_at`,
    [action],
  );

describe('audit log: append-only and hash-chained', () => {
  it('links each new event to the previous one', async () => {
    const a = (await insert(app)).rows[0]!;
    const b = (await insert(app)).rows[0]!;
    expect(BigInt(b.seq)).toBe(BigInt(a.seq) + 1n);
    expect(b.prev_hash.equals(a.hash)).toBe(true);
  });

  it('ignores a forged seq, timestamp and hash supplied by the app', async () => {
    const { rows } = await app.query<{ seq: string; occurred_at: Date; hash: Buffer }>(
      `INSERT INTO audit_events (seq, id, action, outcome, occurred_at, prev_hash, hash)
       VALUES (1, gen_random_uuid(), 'forge', 'ALLOWED', '2001-01-01', '\\x01', '\\x02')
       RETURNING seq, occurred_at, hash`,
    );
    expect(rows[0]!.seq).not.toBe('1');
    expect(rows[0]!.occurred_at.getFullYear()).toBeGreaterThan(2020);
    expect(rows[0]!.hash.length).toBe(32);
  });

  it.each([
    ['UPDATE', `UPDATE audit_events SET action = 'tampered'`],
    ['DELETE', `DELETE FROM audit_events`],
    ['TRUNCATE', `TRUNCATE audit_events`],
  ])('the app role cannot %s audit rows', async (_op, sql) => {
    await expect(app.query(sql)).rejects.toThrow(/permission denied/);
  });

  it.each([
    ['UPDATE', `UPDATE audit_events SET action = 'tampered'`],
    ['DELETE', `DELETE FROM audit_events`],
    ['TRUNCATE', `TRUNCATE audit_events`],
  ])('even the table owner cannot %s audit rows', async (_op, sql) => {
    await insert(app);
    await expect(owner.query(sql)).rejects.toThrow(/append-only/);
  });

  it('the app role cannot rewind the sequence', async () => {
    await expect(app.query(`SELECT setval('audit_seq', 1)`)).rejects.toThrow(/permission denied/);
  });

  it('refuses to write under REPEATABLE READ (could fork the chain)', async () => {
    await app.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await expect(insert(app)).rejects.toThrow(/READ COMMITTED/);
    await app.query('ROLLBACK');
  });

  it('concurrent writers produce one unbroken chain', async () => {
    const clients = Array.from({ length: 8 }, () => appDb());
    await Promise.all(clients.map((c) => c.connect()));
    try {
      await Promise.all(clients.flatMap((c) => Array.from({ length: 5 }, () => insert(c, 'test.concurrent'))));
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    const { rows } = await app.query(`SELECT * FROM audit_verify()`);
    expect(rows[0].first_bad_seq).toBeNull();
  });

  it('audit_verify finds the exact row if history is rewritten behind its back', async () => {
    // Simulate an attacker with superuser-level access: disable the guard
    // trigger as the owner, alter one row, and check verification catches it.
    const target = (await insert(app, 'test.victim')).rows[0]!;
    await insert(app, 'test.after');
    await owner.query('BEGIN');
    try {
      await owner.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete');
      await owner.query(`UPDATE audit_events SET action = 'test.rewritten' WHERE seq = $1`, [target.seq]);
      const { rows } = await owner.query(`SELECT * FROM audit_verify()`);
      expect(rows[0].first_bad_seq).toBe(target.seq);
    } finally {
      await owner.query('ROLLBACK');
    }
    const { rows } = await app.query(`SELECT * FROM audit_verify()`);
    expect(rows[0].first_bad_seq).toBeNull();
  });

  it('the app role cannot hard-delete users', async () => {
    await expect(app.query(`DELETE FROM users`)).rejects.toThrow(/permission denied/);
  });
});
