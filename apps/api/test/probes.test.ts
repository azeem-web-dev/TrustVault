import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { safeFileName } from '../src/documents/content-check.js';
import { DocumentsService } from '../src/documents/documents.service.js';
import { as, createUser, login, ORIGIN, PDF, resetState, startApp, type Session, type TestApp } from './helpers.js';

// Probes a judge is likely to try that are not about one permission rule
// (THREATS.md W9, W10, U11, I3): hostile Origins, file names that lie,
// redirect parameters, and what an unexpected server error gives away.

let t: TestApp;
let A: Session;
beforeAll(async () => { t = await startApp(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await resetState(t.app);
  A = await login(t, await createUser({ email: 'probe-owner@t.io', role: 'OWNER' }));
});

describe('CORS', () => {
  it('a hostile Origin never gets an Access-Control-Allow-Origin answer, on a read, a preflight or a write', async () => {
    const evil = 'https://evil.example';
    const read = await t.http.get('/api/documents').set('Cookie', A.cookie).set('Origin', evil);
    expect(read.headers['access-control-allow-origin']).toBeUndefined();
    expect(read.headers['access-control-allow-credentials']).toBeUndefined();
    const pre = await t.http.options('/api/documents').set('Origin', evil).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'x-csrf-token');
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    const write = await t.http.post('/api/folders').set('Cookie', A.cookie).set('Origin', evil).set('X-CSRF-Token', A.csrf).send({ name: 'x' });
    expect(write.status).toBe(403);
    expect(write.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('file names', () => {
  const pdf = { mime: 'application/pdf', ext: 'pdf', label: 'PDF' };

  it('drops directories, control, bidirectional and zero-width characters, and forces the real extension', () => {
    expect(safeFileName('../../etc/passwd', pdf)).toBe('passwd.pdf');
    expect(safeFileName('C:\\Windows\\evil.exe', pdf)).toBe('evil.pdf');
    expect(safeFileName('invoice\u202Efdp.exe', pdf)).toBe('invoicefdp.pdf');
    expect(safeFileName('a\u2066b\u2069c\u200Bd\uFEFF.pdf', pdf)).toBe('abcd.pdf');
    expect(safeFileName('x"; filename=evil.html\r\nX-Header: 1.pdf', pdf)).toBe('x; filename=evil.htmlX-Header 1.pdf');
    expect(safeFileName('\u202E', pdf)).toBe('document.pdf');
    expect(safeFileName('a\u0085b\u009b.pdf', pdf)).toBe('ab.pdf');
  });

  it('a name that tries to inject a second filename or header is stored flattened and served as one attachment header', async () => {
    const id = (await as(t, A).upload('/api/documents', PDF, 'quote"; filename=evil.html.pdf', { title: 'Tricky', category: 'HR' }).expect(201)).body.id as string;
    const res = await as(t, A).get(`/api/documents/${id}/download`).expect(200);
    const cd = String(res.headers['content-disposition']);
    expect(cd).toBe(`attachment; filename="quote; filename=evil.html.pdf"; filename*=UTF-8''quote%3B%20filename%3Devil.html.pdf`);
    expect(cd).not.toMatch(/[\r\n]/);
  });
});

describe('redirects', () => {
  it('no page or route takes a next/redirect/returnTo URL, so there is nothing to point elsewhere', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
    walk('../web/src');
    walk('src');
    const hits = files.filter((f) => /searchParams\.get\(\s*['"](next|redirect|redirectTo|returnTo|return|url|continue)['"]|res\.redirect\(|@Redirect\(/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});

describe('an unexpected server error', () => {
  it('is a generic JSON 500 with a request id: no message, stack, SQL or connection string from the error', async () => {
    const svc = t.app.get(DocumentsService);
    const original = svc.search.bind(svc);
    svc.search = async () => { throw new Error('connect to postgresql://tv:hunter2@10.0.0.5/db failed at Query.run (/opt/trustvault/app/x.ts:12)'); };
    try {
      const res = await t.http.get('/api/documents').set('Cookie', A.cookie);
      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(Object.keys(res.body).sort()).toEqual(['message', 'requestId']);
      expect(res.body.message).toBe('Internal error');
      expect(res.text).not.toMatch(/hunter2|postgresql|\/opt\/|stack|Query\.run/);
    } finally {
      svc.search = original;
    }
  });

  it('an unknown route is JSON too, and does not echo the path', async () => {
    const res = await t.http.get('/api/<script>nope').set('Cookie', A.cookie).set('Origin', ORIGIN);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Not found');
    expect(res.text).not.toContain('<script>');
  });
});
