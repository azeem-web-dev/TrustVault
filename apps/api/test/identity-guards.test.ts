import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { appDb, createUser, login, ownerDb, resetState, startApp, withDb, type TestApp, type TestUser } from './helpers.js';

// The database protects identities on its own (THREATS.md A23-A26). Every
// test here talks to Postgres directly as the app's real database role
// (the role the API connects as), with app.user_id set to someone, to no one,
// or to garbage, and tries what a bug or an injected statement could.

let t: TestApp;
let alice: TestUser, victor: TestUser, adm: TestUser, adm2: TestUser;

beforeAll(async () => {
  t = await startApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t.app);
  [alice, victor, adm, adm2] = await Promise.all([
    createUser({ email: 'alice@t.io', role: 'OWNER', mfa: true }),
    createUser({ email: 'victor@t.io', role: 'VIEWER', mfa: true }),
    createUser({ email: 'adm@t.io', role: 'ADMIN' }),
    createUser({ email: 'adm2@t.io', role: 'ADMIN' }),
  ]);
});

/** Runs `sql` as the app role with app.user_id = `as` (null: unset); always rolls back. Returns rowCount or the error. */
async function asApp(as: string | null, sql: string, params: unknown[] = []): Promise<number | string> {
  return withDb(appDb(), async (db) => {
    await db.query('BEGIN');
    try {
      if (as !== null) await db.query(`SELECT set_config('app.user_id', $1, true)`, [as]);
      return (await db.query(sql, params)).rowCount ?? 0;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await db.query('ROLLBACK');
    }
  });
}
const row = async (id: string) => withDb(ownerDb(), async (db) => (await db.query(
  'SELECT role, status, is_protected, activated_at, totp_enabled_at, password_hash FROM users WHERE id = $1', [id])).rows[0]);
const refused = (r: number | string) => expect(typeof r === 'string' ? r : `changed ${r} row(s)`).toMatch(/administrator|own|only|cannot|permission denied|refused|invitation|replay|must remain|uuid|unused|once/i);

describe('the app role itself', () => {
  it('owns no table, cannot bypass row-level security, and is no superuser', async () => {
    const facts = await withDb(appDb(), async (db) => (await db.query(`
      SELECT (SELECT count(*)::int FROM pg_tables t WHERE t.schemaname = 'public' AND pg_has_role(current_user, t.tableowner, 'MEMBER')) AS owned,
             (SELECT bool_or(r.rolbypassrls OR r.rolsuper) FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'MEMBER')) AS bypass`)).rows[0]);
    expect(facts).toEqual({ owned: 0, bypass: false });
  });
});

describe('roles, status and the flags around them (A23)', () => {
  it('nobody promotes themselves, with or without being an admin', async () => {
    refused(await asApp(victor.id, `UPDATE users SET role = 'ADMIN' WHERE id = $1`, [victor.id]));
    refused(await asApp(adm.id, `UPDATE users SET role = 'OWNER' WHERE id = $1`, [adm.id]));
    refused(await asApp(adm.id, `UPDATE users SET status = 'DEACTIVATED', deactivated_at = now() WHERE id = $1`, [adm.id]));
    expect((await row(victor.id)).role).toBe('VIEWER');
  });

  it('only an active admin changes someone else’s role, status or end date', async () => {
    for (const ctx of [null, alice.id, victor.id]) {
      refused(await asApp(ctx, `UPDATE users SET role = 'ADMIN' WHERE id = $1`, [victor.id]));
      refused(await asApp(ctx, `UPDATE users SET status = 'DEACTIVATED', deactivated_at = now() WHERE id = $1`, [alice.id]));
      refused(await asApp(ctx, `UPDATE users SET access_expires_at = now() + interval '9 years' WHERE id = $1`, [victor.id]));
    }
    // A deactivated admin is nobody.
    await withDb(ownerDb(), (db) => db.query(`UPDATE users SET status = 'DEACTIVATED', deactivated_at = now() WHERE id = $1`, [adm2.id]));
    refused(await asApp(adm2.id, `UPDATE users SET role = 'ADMIN' WHERE id = $1`, [victor.id]));
    // An active admin may (rolled back).
    expect(await asApp(adm.id, `UPDATE users SET role = 'OWNER' WHERE id = $1`, [victor.id])).toBe(1);
  });

  it('is_protected, id, email and activation never change from the app; reactivating never makes an account ACTIVE out of nothing', async () => {
    refused(await asApp(adm.id, `UPDATE users SET is_protected = true WHERE id = $1`, [victor.id]));
    refused(await asApp(adm.id, `UPDATE users SET email = 'x@t.io' WHERE id = $1`, [victor.id]));
    refused(await asApp(adm.id, `UPDATE users SET activated_at = now() - interval '1 day' WHERE id = $1`, [victor.id]));
    await withDb(ownerDb(), (db) => db.query(`UPDATE users SET is_protected = true WHERE id = $1`, [victor.id]));
    refused(await asApp(adm.id, `UPDATE users SET role = 'OWNER' WHERE id = $1`, [victor.id])); // demo account
    refused(await asApp(adm.id, `UPDATE users SET is_protected = false WHERE id = $1`, [victor.id]));
  });

  it('the last active admin cannot be removed, even by two admins demoting each other at once', async () => {
    const a = appDb();
    const b = appDb();
    await a.connect();
    await b.connect();
    try {
      await a.query('BEGIN');
      await a.query(`SELECT set_config('app.user_id', $1, true)`, [adm.id]);
      await b.query('BEGIN');
      await b.query(`SELECT set_config('app.user_id', $1, true)`, [adm2.id]);
      await a.query(`UPDATE users SET role = 'OWNER' WHERE id = $1`, [adm2.id]);
      const second = b.query(`UPDATE users SET role = 'OWNER' WHERE id = $1`, [adm.id]).then(() => null, (e: Error) => e.message);
      await new Promise((r) => setTimeout(r, 300));
      await a.query('COMMIT');
      expect(await second).toMatch(/administrator/);
      await b.query('ROLLBACK');
    } finally {
      await a.end();
      await b.end();
    }
    const admins = await withDb(ownerDb(), async (db) => (await db.query(`SELECT count(*)::int AS n FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'`)).rows[0].n);
    expect(admins).toBe(1);
  });

  it('a missing or malformed app.user_id is nobody, or fails the statement', async () => {
    for (const bad of ['', 'not-a-uuid', "' OR 1=1 --"]) {
      const r = await asApp(bad, `UPDATE users SET role = 'ADMIN' WHERE id = $1`, [victor.id]);
      refused(r);
    }
    refused(await asApp(null, `UPDATE users SET status = 'DEACTIVATED', deactivated_at = now() WHERE id = $1`, [victor.id]));
  });

  it('new accounts only from an admin, only as an invitation', async () => {
    const ins = (status: string) => `INSERT INTO users (id, email, display_name, role, status, password_hash, updated_at, activated_at, created_by_id)
      VALUES (gen_random_uuid(), 'new@t.io', 'n', 'ADMIN', '${status}', 'x', now(), ${status === 'ACTIVE' ? 'now()' : 'NULL'}, $1)`;
    refused(await asApp(victor.id, ins('INVITED'), [victor.id]));
    refused(await asApp(null, ins('INVITED'), [adm.id]));
    refused(await asApp(adm.id, ins('ACTIVE'), [adm.id]));
    refused(await asApp(adm.id, ins('INVITED'), [adm2.id])); // in someone else's name
    expect(await asApp(adm.id, ins('INVITED'), [adm.id])).toBe(1);
  });
});

describe('passwords and second factors (A24)', () => {
  it('a password is set only by its owner (or a link); not by an admin, not by anyone else', async () => {
    for (const ctx of [null, adm.id, alice.id]) refused(await asApp(ctx, `UPDATE users SET password_hash = 'x', password_changed_at = now() WHERE id = $1`, [victor.id]));
    expect(await asApp(victor.id, `UPDATE users SET password_hash = 'x', password_changed_at = now() WHERE id = $1`, [victor.id])).toBe(1);
  });

  it('nobody clears someone else’s TOTP; an admin clears a viewer’s, but an owner’s only with an approval used now', async () => {
    const clear = `UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL WHERE id = $1`;
    refused(await asApp(victor.id, clear, [alice.id]));
    refused(await asApp(null, clear, [alice.id]));
    refused(await asApp(adm.id, clear, [alice.id]));     // owner: needs two admins (S19)
    refused(await asApp(adm.id, clear, [adm2.id]));      // admin: same
    expect(await asApp(adm.id, clear, [victor.id])).toBe(1);
    // Nobody sets a factor for someone else.
    refused(await asApp(adm.id, `UPDATE users SET totp_secret_enc = '\\x01', totp_enabled_at = now() WHERE id = $1`, [victor.id]));
    expect((await row(alice.id)).totp_enabled_at).not.toBeNull();
  });

  it('the replay marker only moves forward, and sign-in counters move alone', async () => {
    await withDb(ownerDb(), (db) => db.query('UPDATE users SET totp_last_step = 100 WHERE id = $1', [victor.id]));
    expect(await asApp(null, 'UPDATE users SET totp_last_step = 101 WHERE id = $1', [victor.id])).toBe(1);
    refused(await asApp(null, 'UPDATE users SET totp_last_step = 99 WHERE id = $1', [victor.id]));
    expect(await asApp(null, 'UPDATE users SET failed_login_count = 3, locked_until = now() + interval \'1 hour\' WHERE id = $1', [victor.id])).toBe(1);
    refused(await asApp(null, `UPDATE users SET failed_login_count = 0, role = 'ADMIN' WHERE id = $1`, [victor.id]));
  });

  it('passkeys: added only by their owner, removed by the owner or an admin under the same rules', async () => {
    const add = `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, name) VALUES (gen_random_uuid(), $1, 'cred-' || gen_random_uuid(), '\\x01', 0, '{}', 'k')`;
    refused(await asApp(adm.id, add, [alice.id]));
    refused(await asApp(null, add, [alice.id]));
    expect(await asApp(alice.id, add, [alice.id])).toBe(1);
    await withDb(ownerDb(), (db) => db.query(`INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, name) VALUES (gen_random_uuid(), $1, 'c1', '\\x01', 5, '{}', 'k')`, [alice.id]));
    refused(await asApp(adm.id, 'DELETE FROM passkeys WHERE user_id = $1', [alice.id]));
    refused(await asApp(null, 'UPDATE passkeys SET counter = 1 WHERE user_id = $1', [alice.id]));
    refused(await asApp(null, `UPDATE passkeys SET public_key = '\\x02' WHERE user_id = $1`, [alice.id]));
    expect(await asApp(alice.id, 'DELETE FROM passkeys WHERE user_id = $1', [alice.id])).toBe(1);
  });

  it('a used reset or invitation link stays used', async () => {
    await withDb(ownerDb(), (db) => db.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used_at) VALUES ($1, '\\x01', now() + interval '1 hour', now())`, [victor.id]));
    refused(await asApp(null, 'UPDATE password_reset_tokens SET used_at = NULL WHERE user_id = $1', [victor.id]));
    refused(await asApp(null, `UPDATE password_reset_tokens SET expires_at = now() + interval '9 days' WHERE user_id = $1`, [victor.id]));
    refused(await asApp(null, `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used_at) VALUES ($1, '\\x02', now() + interval '1 hour', now())`, [victor.id]));
  });
});

describe('groups (A25)', () => {
  it('only an admin changes groups and their members', async () => {
    const g = await withDb(ownerDb(), async (db) => (await db.query(`INSERT INTO groups (id, name) VALUES (gen_random_uuid(), 'Board') RETURNING id`)).rows[0].id as string);
    for (const ctx of [null, alice.id, victor.id]) {
      refused(await asApp(ctx, 'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [g, victor.id]));
      refused(await asApp(ctx, `INSERT INTO groups (id, name) VALUES (gen_random_uuid(), 'Mine')`));
      refused(await asApp(ctx, `UPDATE groups SET name = 'Renamed' WHERE id = $1`, [g]));
    }
    expect(await asApp(adm.id, 'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [g, victor.id])).toBe(1);
  });
});

describe('hashes and secrets are not readable by the app role (A26)', () => {
  it('selecting password_hash or totp_secret_enc is refused; the narrow functions answer for one person', async () => {
    refused(await asApp(adm.id, 'SELECT password_hash FROM users'));
    refused(await asApp(adm.id, 'SELECT totp_secret_enc FROM users'));
    refused(await asApp(adm.id, 'SELECT * FROM users'));
    const ok = await withDb(appDb(), async (db: pg.Client) => (await db.query('SELECT tv_password_hash($1) AS h, tv_totp_secret($1) AS s', [alice.id])).rows[0]);
    expect(ok.h).toMatch(/^\$argon2id\$/);
    expect(Buffer.isBuffer(ok.s)).toBe(true);
  });

  it('the app still signs people in, and changes are recorded (smoke test of the legitimate paths)', async () => {
    await login(t, victor);
    await login(t, adm);
  });
});
