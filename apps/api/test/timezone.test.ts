import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { as, createUser, login, ownerDb, resetState, startApp, withDb, type TestApp } from './helpers.js';
import { PrismaService } from '../src/db/prisma.service.js';

// Regression: with a database (or role) whose default TimeZone is not UTC,
// timestamps were read hours off and every session looked older than its
// password change, so each request after sign-in was refused as
// "password_changed". Every connection now asks for UTC at startup
// (UTC_SESSION in prisma.service.ts). This file switches the test
// database's default to Asia/Kolkata (+05:30) and back.

let t: TestApp;
let previous: string | null = null;

async function dbDefault(): Promise<string | null> {
  return withDb(ownerDb(), async (db) => {
    const { rows } = await db.query<{ tz: string | null }>(`
      SELECT (SELECT substr(c, length('TimeZone=') + 1) FROM unnest(s.setconfig) AS c WHERE lower(c) LIKE 'timezone=%') AS tz
        FROM pg_db_role_setting s WHERE s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) AND s.setrole = 0`);
    return rows[0]?.tz ?? null;
  });
}
const setDefault = (tz: string | null) => withDb(ownerDb(), async (db) => {
  const name = (await db.query<{ d: string }>('SELECT current_database() AS d')).rows[0]!.d;
  const ident = `"${name.replace(/"/g, '""')}"`;
  await db.query(tz === null ? `ALTER DATABASE ${ident} RESET timezone` : `ALTER DATABASE ${ident} SET timezone TO ${pg.escapeLiteral(tz)}`);
});

beforeAll(async () => {
  previous = await dbDefault();
  await setDefault('Asia/Kolkata');
  t = await startApp(); // a fresh pool: its connections start after the change
  await resetState(t.app);
});
afterAll(async () => {
  await t?.close();
  await setDefault(previous);
});

describe('every database connection runs in UTC, whatever the server default (regression)', () => {
  it('a plain connection without the option really gets the non-UTC default (the test is meaningful)', async () => {
    const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    try {
      expect((await c.query<{ tz: string }>("SELECT current_setting('TimeZone') AS tz")).rows[0]!.tz).toBe('Asia/Kolkata');
    } finally {
      await c.end();
    }
  });

  it('the app pool asks for UTC on every connection', async () => {
    const prisma = t.app.get(PrismaService);
    const zones = await Promise.all(Array.from({ length: 4 }, () => prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`));
    expect(zones.map((z) => z[0]!.tz)).toEqual(['UTC', 'UTC', 'UTC', 'UTC']);
  });

  it('a signed-in session keeps working: it is not mistaken for one older than the password', async () => {
    const owner = await createUser({ email: 'tz-owner@t.io', role: 'OWNER' });
    const s = await login(t, owner);
    await as(t, s).get('/api/auth/me').expect(200);
    await as(t, s).get('/api/documents').expect(200);
    const admin = await createUser({ email: 'tz-admin@t.io', role: 'ADMIN' });
    const a = await login(t, admin);
    await as(t, a).get('/api/admin/users').expect(200);
  });
});
