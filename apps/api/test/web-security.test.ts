import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import type { NestContainer } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLIC_KEY } from '../src/auth/decorators.js';
import { auditRows, createUser, login, ORIGIN, resetState, startApp, type Session, type TestApp } from './helpers.js';

// Web security regressions on the API itself (THREATS.md W1-W8): every
// state-changing route found from Nest's own router - so a route added
// later is covered without editing this file - refuses cross-site
// requests and requests without the CSRF token; security headers and
// no-store on every response; error bodies never echo the request.

interface Route { method: string; path: string; isPublic: boolean; handler: string }

let t: TestApp;
let S: Session;
let routes: Route[];

/** Every controller route, from the metadata Nest itself routes by. */
function nestRoutes(app: TestApp['app']): Route[] {
  const container = (app as unknown as { container: NestContainer }).container;
  const out: Route[] = [];
  for (const mod of container.getModules().values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctrl = wrapper.metatype as (new (...a: unknown[]) => unknown) | null;
      if (!ctrl) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
      const classPublic = Reflect.getMetadata(PUBLIC_KEY, ctrl) === true;
      for (const key of Object.getOwnPropertyNames(ctrl.prototype)) {
        const fn = (ctrl.prototype as Record<string, unknown>)[key];
        if (key === 'constructor' || typeof fn !== 'function') continue;
        const sub = Reflect.getMetadata(PATH_METADATA, fn);
        const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
        if (sub === undefined || method === undefined) continue;
        const path = ['/api', base, String(sub)].join('/').replace(/\/+/g, '/').replace(/\/$/, '');
        out.push({ method: RequestMethod[method]!, path, isPublic: classPublic || Reflect.getMetadata(PUBLIC_KEY, fn) === true, handler: `${ctrl.name}.${key}` });
      }
    }
  }
  return out;
}

/** The same routes, as Express actually registered them. */
function expressRoutes(app: TestApp['app']): string[] {
  const inst = app.getHttpAdapter().getInstance() as { router?: { stack: unknown[] }; _router?: { stack: unknown[] } };
  const stack = (inst.router ?? inst._router)!.stack as { route?: { path: string; methods: Record<string, boolean> } }[];
  return stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route!.methods).filter((m) => m !== '_all').map((m) => `${m.toUpperCase()} ${l.route!.path}`));
}

const fill = (path: string) => path.replace(/:(\w+)/g, (_, name: string) => (/No$/.test(name) ? '1' : '3f0e7a52-5b1a-4c1e-9d2a-1b2c3d4e5f60'));
const call = (method: string, path: string) => (t.http as unknown as Record<string, (p: string) => import('supertest').Test>)[method.toLowerCase()]!(path);

/** Public routes that change state. A new one fails this test until someone has looked at it. */
const PUBLIC_MUTATING = new Set([
  'POST /api/auth/login',
  'POST /api/auth/password/forgot',
  'POST /api/auth/password/reset',
  'POST /api/auth/invite/check',
  'POST /api/auth/invite/accept',
]);

beforeAll(async () => {
  t = await startApp();
  await resetState(t.app);
  const u = await createUser({ email: 'websec@t.io', role: 'OWNER' });
  S = await login(t, u);
  routes = nestRoutes(t.app);
});
afterAll(async () => {
  await t.close();
});

describe('the route list is complete', () => {
  it('finds every route Express serves (nothing registered outside a controller)', () => {
    const fromNest = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const fromExpress = expressRoutes(t.app).filter((r) => r.includes('/api/'));
    expect(fromExpress.length).toBeGreaterThan(40);
    for (const r of fromExpress) expect(fromNest, r).toContain(r);
    expect(fromNest.size).toBe(new Set(fromExpress).size);
  });

  it('the public state-changing routes are exactly the reviewed list', () => {
    const publicMutating = routes.filter((r) => r.isPublic && r.method !== 'GET').map((r) => `${r.method} ${r.path}`).sort();
    expect(publicMutating).toEqual([...PUBLIC_MUTATING].sort());
  });
});

describe('CSRF: every state-changing route', () => {
  it('refuses a cross-site Origin, even with a valid session and CSRF token, and audits it', async () => {
    const mutating = routes.filter((r) => r.method !== 'GET');
    expect(mutating.length).toBeGreaterThan(25);
    for (const r of mutating) {
      const res = await call(r.method, fill(r.path)).set('Cookie', S.cookie).set('X-CSRF-Token', S.csrf).set('Origin', 'https://evil.example').send({});
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      expect(res.body.message, `${r.method} ${r.path}`).toBe('Cross-origin request refused');
    }
    const rows = await auditRows(`action = 'security.origin_refused' AND details->>'origin' = 'https://evil.example'`);
    expect(rows.length).toBeGreaterThanOrEqual(mutating.length);
  });

  it('refuses a same-site request with no CSRF token, or the wrong one (every non-public route)', async () => {
    for (const r of routes.filter((x) => x.method !== 'GET' && !x.isPublic)) {
      for (const token of [undefined, 'not-the-token', S.csrf.slice(0, -1)]) {
        let req = call(r.method, fill(r.path)).set('Cookie', S.cookie).set('Origin', ORIGIN);
        if (token !== undefined) req = req.set('X-CSRF-Token', token);
        const res = await req.send({});
        expect(res.status, `${r.method} ${r.path} token=${token}`).toBe(403);
        expect(res.body.message).toBe('Missing or invalid CSRF token');
      }
      // No Origin at all (not a browser): still needs the token.
      const bare = await call(r.method, fill(r.path)).set('Cookie', S.cookie).send({});
      expect(bare.status, `${r.method} ${r.path} without Origin`).toBe(403);
    }
  });

  it('a different Origin spelling is not the same origin (scheme, port, case, trailing slash, null)', async () => {
    for (const origin of ['http://vault.test', 'https://vault.test:444', 'https://VAULT.test.evil.example', `${ORIGIN}/`, 'null', `${ORIGIN}.evil.example`]) {
      const res = await t.http.post('/api/auth/logout').set('Cookie', S.cookie).set('X-CSRF-Token', S.csrf).set('Origin', origin).send({});
      expect(res.status, origin).toBe(403);
    }
  });

  it('the session cookie is __Host-, HttpOnly, Secure and SameSite=Strict', async () => {
    const u = await createUser({ email: 'websec-cookie@t.io', role: 'OWNER' });
    const res = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email: u.email, password: u.password });
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Host-tv_session='))!;
    expect(cookie).toBeDefined();
    const attrs = cookie.split(';').map((a) => a.trim().toLowerCase());
    expect(attrs).toContain('httponly');
    expect(attrs).toContain('secure');
    expect(attrs).toContain('samesite=strict');
    expect(attrs).toContain('path=/');
    expect(attrs.some((a) => a.startsWith('domain='))).toBe(false);
  });

  it('no CORS: a cross-origin preflight gets no Access-Control-Allow-* headers', async () => {
    const res = await t.http.options('/api/documents').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('headers on every API response', () => {
  const EXPECTED_CSP = "default-src 'none';frame-ancestors 'none';sandbox";

  it('every GET route (signed in, any status) is no-store, framed by nobody, sandboxed, nosniff, HSTS', async () => {
    const gets = routes.filter((r) => r.method === 'GET');
    expect(gets.length).toBeGreaterThan(15);
    for (const r of gets) {
      const res = await t.http.get(fill(r.path)).set('Cookie', S.cookie);
      const where = `GET ${r.path} -> ${res.status}`;
      expect(res.headers['cache-control'], where).toMatch(/no-store/);
      expect(res.headers['content-security-policy'], where).toBe(EXPECTED_CSP);
      expect(res.headers['x-frame-options'], where).toBe('DENY');
      expect(res.headers['x-content-type-options'], where).toBe('nosniff');
      expect(res.headers['strict-transport-security'], where).toBe('max-age=63072000; includeSubDomains');
      expect(res.headers['referrer-policy'], where).toBe('no-referrer');
      expect(res.headers['x-powered-by'], where).toBeUndefined();
    }
  });

  it('errors and unknown routes carry the same headers', async () => {
    for (const path of ['/api/nope', '/api/documents/not-a-uuid', '/api/health/../../etc/passwd']) {
      const res = await t.http.get(path);
      expect(res.headers['cache-control']).toMatch(/no-store/);
      expect(res.headers['content-security-policy']).toBe(EXPECTED_CSP);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
    }
  });
});

describe('error responses never echo the request', () => {
  const PAYLOAD = '<script>alert(1)</script>';

  it('unknown routes', async () => {
    for (const method of ['get', 'post', 'put', 'delete'] as const) {
      const res = await t.http[method](`/api/${encodeURIComponent(PAYLOAD)}/x?q=${encodeURIComponent(PAYLOAD)}`).set('Origin', ORIGIN);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Not found');
      expect(res.text).not.toContain('script');
    }
  });

  it('validation errors (unknown keys, bad values, bad JSON)', async () => {
    const asUser = (r: import('supertest').Test) => r.set('Cookie', S.cookie).set('Origin', ORIGIN).set('X-CSRF-Token', S.csrf);
    const unknownKey = await asUser(t.http.post('/api/folders')).send({ name: 'x', [PAYLOAD]: 1 });
    expect(unknownKey.status).toBe(400);
    expect(unknownKey.text).not.toContain('script');
    const badValue = await asUser(t.http.get(`/api/documents?scope=${encodeURIComponent(PAYLOAD)}`));
    expect(badValue.status).toBe(400);
    expect(badValue.text).not.toContain('script');
    const badJson = await asUser(t.http.post('/api/folders')).set('Content-Type', 'application/json').send(`{"name": "${PAYLOAD}`);
    expect(badJson.status).toBe(400);
    expect(badJson.text).not.toContain('script');
    const badId = await t.http.get(`/api/documents/${encodeURIComponent(PAYLOAD)}`).set('Cookie', S.cookie);
    expect(badId.status).toBe(404);
    expect(badId.text).not.toContain('script');
  });
});

describe('HSTS and headers at the edge (nginx)', () => {
  const conf = readFileSync(resolve(__dirname, '../../../infra/nginx/vault.conf'), 'utf8');

  it('sends HSTS for two years on every response, including errors', () => {
    expect(conf).toMatch(/add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;/);
  });

  it('no location block has its own add_header (which would silently drop the server-level HSTS)', () => {
    const locations = conf.split(/\n\s*location\s/).slice(1);
    expect(locations.length).toBeGreaterThan(1);
    for (const l of locations) expect(l).not.toMatch(/add_header/);
  });

  it('hides the version, caps bodies, and overwrites X-Forwarded-For', () => {
    expect(conf).toMatch(/server_tokens off;/);
    expect(conf).toMatch(/client_max_body_size \d+m;/);
    expect(conf).toMatch(/proxy_set_header X-Forwarded-For\s+\$remote_addr;/);
  });
});
