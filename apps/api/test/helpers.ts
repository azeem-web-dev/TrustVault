import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import request from 'supertest';
import { createApp } from '../src/bootstrap.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { PasswordService } from '../src/auth/password.service.js';
import type { Role } from '../src/generated/prisma/enums.js';

try { process.loadEnvFile('.env'); } catch { /* CI */ }

export const ORIGIN = 'https://vault.test';

export function testEnv(): Env {
  return loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: ORIGIN,
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    REDIS_PREFIX: 'tvdev:test:',
  });
}

/** Direct connection as the schema owner, for test setup/cleanup only. */
export function ownerDb(): pg.Client {
  return new pg.Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
}

/** Direct connection as the low-privilege app role, to prove what it cannot do. */
export function appDb(): pg.Client {
  return new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
}

export interface TestApp {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function startApp(): Promise<TestApp> {
  const app = await createApp(testEnv());
  await app.init();
  return { app, http: request(app.getHttpServer()), close: () => app.close() };
}

/**
 * Wipes users and sessions (not the audit log, which cannot be deleted —
 * by design) and the test Redis keys, so every test starts clean.
 */
export async function resetState(app: INestApplication): Promise<void> {
  const db = ownerDb();
  await db.connect();
  try {
    await db.query('TRUNCATE sessions, users CASCADE');
  } finally {
    await db.end();
  }
  const { RedisService } = await import('../src/redis/redis.service.js');
  const redis = app.get(RedisService).client;
  // KEYS is blocked by the Redis ACL (it is in @dangerous), so iterate with
  // SCAN. Names come back with the prefix; del() adds it again, so strip it.
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'tvdev:test:*', 'COUNT', 500);
    cursor = next;
    if (keys.length) await redis.del(...keys.map((k) => k.slice('tvdev:test:'.length)));
  } while (cursor !== '0');
}

const hasher = new PasswordService();

export async function createUser(opts: { email: string; role: Role; password?: string; accessExpiresAt?: Date; displayName?: string }): Promise<{ id: string; email: string; password: string }> {
  const password = opts.password ?? `pw-${opts.email}-correct-horse`;
  const db = appDb();
  await db.connect();
  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (id, email, display_name, role, password_hash, access_expires_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now()) RETURNING id`,
      [opts.email, opts.displayName ?? opts.email, opts.role, await hasher.hash(password), opts.accessExpiresAt ?? null],
    );
    return { id: rows[0]!.id, email: opts.email, password };
  } finally {
    await db.end();
  }
}

export interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}

export async function login(t: TestApp, email: string, password: string): Promise<Session> {
  const res = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = setCookie.find((c) => c.startsWith('__Host-tv_session='))!.split(';')[0]!;
  return { cookie, csrf: res.body.csrfToken as string, userId: res.body.user.id as string };
}

/** Authenticated request helpers that send cookie, Origin and CSRF token. */
export function as(t: TestApp, s: Session) {
  const withAuth = (r: request.Test) => r.set('Cookie', s.cookie).set('Origin', ORIGIN).set('X-CSRF-Token', s.csrf);
  return {
    get: (url: string) => t.http.get(url).set('Cookie', s.cookie),
    post: (url: string, body?: object) => withAuth(t.http.post(url)).send(body ?? {}),
    patch: (url: string, body: object) => withAuth(t.http.patch(url)).send(body),
  };
}

export async function auditRows(where: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const db = appDb();
  await db.connect();
  try {
    const { rows } = await db.query(`SELECT * FROM audit_events WHERE ${where} ORDER BY seq`, params);
    return rows;
  } finally {
    await db.end();
  }
}
