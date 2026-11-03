import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import request from 'supertest';
import { createApp } from '../src/bootstrap.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { PasswordService } from '../src/auth/password.service.js';
import { LocalKeyProvider } from '../src/crypto/key-provider.js';
import { packWrapped } from '../src/auth/mfa.service.js';
import { currentStep, newTotpSecret, totpAt } from '../src/auth/totp.js';
import type { Role } from '../src/generated/prisma/enums.js';
import { startFakeClamd, type FakeClamd } from './fake-clamd.js';

try { process.loadEnvFile('.env'); } catch { /* CI */ }

export const ORIGIN = 'https://vault.test';
// A second checkout can run the suite against the same Redis without
// clearing the other's keys.
const REDIS_TEST_PREFIX = process.env.TEST_REDIS_PREFIX ?? 'tvdev:test:';

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: ORIGIN,
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    REDIS_PREFIX: REDIS_TEST_PREFIX,
    KEY_PROVIDER: 'local',
    JOBS_ENABLED: 'false',
    // Failed logins are padded to a fixed time in production; the suite
    // makes hundreds of them, so no padding here (timing is measured
    // separately, with it on: npm run measure:timing).
    LOGIN_FAILURE_FLOOR_MS: '0',
    ...overrides,
  });
}

export const keys = (): LocalKeyProvider => new LocalKeyProvider(Buffer.from(testEnv().LOCAL_MASTER_KEY!, 'base64'));

/** Direct connection as the schema owner, for test setup/cleanup only. */
export function ownerDb(): pg.Client {
  return new pg.Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
}

/** Direct connection as the low-privilege app role, to prove what it cannot do. */
export function appDb(): pg.Client {
  return new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
}

export async function withDb<T>(client: pg.Client, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export interface TestApp {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  /** The malware scanner the app talks to (real clamd protocol, fake engine). */
  clamd: FakeClamd;
  close: () => Promise<void>;
}

export async function startApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const clamd = await startFakeClamd();
  const app = await createApp(testEnv({ SCANNER: 'clamd', CLAMD_SOCKET: clamd.address, CLAMD_TIMEOUT_MS: '1500', ...overrides }));
  await app.init();
  // The API refuses rather than queues while Redis is connecting (no offline
  // queue); over a slow link the first test could otherwise race it.
  const { RedisService } = await import('../src/redis/redis.service.js');
  const redis = app.get(RedisService).client;
  if (redis.status !== 'ready') await new Promise((ok) => redis.once('ready', ok));
  return {
    app, http: request(app.getHttpServer()), clamd,
    close: async () => { await app.close(); await clamd.close(); },
  };
}

/**
 * Wipes users (and, by cascade, sessions, documents, grants...), groups and
 * the test Redis keys. Not the audit log, which cannot be deleted — by
 * design — so tests look up their own rows by request id or document id.
 */
export async function resetState(app: INestApplication): Promise<void> {
  await withDb(ownerDb(), async (db) => {
    await db.query('TRUNCATE sessions, users, groups CASCADE');
    // Back to the default second-factor policy (ADMIN only).
    await db.query(`UPDATE app_settings SET mfa_required_roles = '{ADMIN}', updated_by_id = NULL`);
  });
  const { RedisService } = await import('../src/redis/redis.service.js');
  const redis = app.get(RedisService).client;
  // KEYS is blocked by the Redis ACL (it is in @dangerous), so iterate with
  // SCAN. Names come back with the prefix; del() adds it again, so strip it.
  let cursor = '0';
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', `${REDIS_TEST_PREFIX}*`, 'COUNT', 500);
    cursor = next;
    if (found.length) await redis.del(...found.map((k) => k.slice(REDIS_TEST_PREFIX.length)));
  } while (cursor !== '0');
}

const hasher = new PasswordService();

export interface TestUser {
  id: string;
  email: string;
  password: string;
  role: Role;
  totpSecret: Buffer | null;
}

/** Admins get an enrolled authenticator by default, as the app requires. */
export async function createUser(opts: { email: string; role: Role; password?: string; accessExpiresAt?: Date; displayName?: string; mfa?: boolean }): Promise<TestUser> {
  const password = opts.password ?? `pw-${opts.email}-correct-horse`;
  const wantMfa = opts.mfa ?? opts.role === 'ADMIN';
  const accessExpiresAt = opts.accessExpiresAt ?? (opts.role === 'EXTERNAL' ? new Date(Date.now() + 30 * 86_400_000) : null);
  const passwordHash = await hasher.hash(password);
  // As the schema owner: the app role may only create invitations (THREATS.md A23).
  const { rows } = await withDb(ownerDb(), (db) =>
    db.query<{ id: string }>(
      `INSERT INTO users (id, email, display_name, role, password_hash, access_expires_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now()) RETURNING id`,
      [opts.email, opts.displayName ?? opts.email, opts.role, passwordHash, accessExpiresAt],
    ),
  );
  const id = rows[0]!.id;
  let totpSecret: Buffer | null = null;
  if (wantMfa) {
    totpSecret = newTotpSecret();
    const { wrapped, keyId } = await keys().wrap(totpSecret, `tv-totp-v1|${id}`);
    await withDb(ownerDb(), (db) => db.query(`UPDATE users SET totp_secret_enc = $1, totp_enabled_at = now() WHERE id = $2`, [packWrapped(keyId, wrapped), id]));
  }
  return { id, email: opts.email, password, role: opts.role, totpSecret };
}

export interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}

const cookieFrom = (res: request.Response): string | undefined =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Host-tv_session='))?.split(';')[0];

/** Signs in, and completes the TOTP step if the account requires it. */
export async function login(t: TestApp, user: TestUser | { email: string; password: string; totpSecret?: Buffer | null }): Promise<Session> {
  const res = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed for ${user.email}: ${res.status} ${JSON.stringify(res.body)}`);
  let session: Session = { cookie: cookieFrom(res)!, csrf: res.body.csrfToken as string, userId: res.body.user.id as string };
  if (res.body.mfaRequired && user.totpSecret) {
    // Tests sign the same user in several times within one 30 s step; clear
    // the replay marker so each sign-in can use the current code.
    await withDb(ownerDb(), (db) => db.query('UPDATE users SET totp_last_step = NULL WHERE id = $1', [session.userId]));
    const v = await t.http.post('/api/auth/mfa/totp/verify')
      .set('Cookie', session.cookie).set('Origin', ORIGIN).set('X-CSRF-Token', session.csrf)
      .send({ code: totpAt(user.totpSecret, currentStep()) });
    if (v.status !== 200) throw new Error(`totp failed for ${user.email}: ${v.status} ${JSON.stringify(v.body)}`);
    session = { cookie: cookieFrom(v)!, csrf: v.body.csrfToken as string, userId: session.userId };
  }
  return session;
}

/** Authenticated request helpers that send cookie, Origin and CSRF token. */
export function as(t: TestApp, s: Session) {
  const withAuth = (r: request.Test) => r.set('Cookie', s.cookie).set('Origin', ORIGIN).set('X-CSRF-Token', s.csrf);
  return {
    get: (url: string) => t.http.get(url).set('Cookie', s.cookie),
    post: (url: string, body?: object) => withAuth(t.http.post(url)).send(body ?? {}),
    patch: (url: string, body: object) => withAuth(t.http.patch(url)).send(body),
    put: (url: string, body: object) => withAuth(t.http.put(url)).send(body),
    delete: (url: string) => withAuth(t.http.delete(url)),
    upload: (url: string, file: Buffer, fileName: string, fields: Record<string, string> = {}) => {
      let r = withAuth(t.http.post(url)).attach('file', file, fileName);
      for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
      return r;
    },
  };
}

export async function auditRows(where: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return withDb(appDb(), async (db) => (await db.query(`SELECT * FROM audit_events WHERE ${where} ORDER BY seq`, params)).rows);
}

/** A tiny valid PDF with no active content. */
export const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

/**
 * Two-admin approval (THREATS.md S19): `asker` asks, `approver` approves.
 * Returns the approval id for the asker to use.
 */
export async function approved(t: TestApp, asker: Session, approver: Session, body: { action: 'MFA_RESET' | 'BREAK_GLASS'; targetUserId?: string; documentId?: string; reason?: string }): Promise<string> {
  const r = await as(t, asker).post('/api/admin/approvals', { reason: 'Approved in a test, for a documented reason', ...body });
  if (r.status !== 201) throw new Error(`approval request failed: ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.approval.id as string;
  const a = await as(t, approver).post(`/api/admin/approvals/${id}/approve`);
  if (a.status !== 200) throw new Error(`approval failed: ${a.status} ${JSON.stringify(a.body)}`);
  return id;
}
