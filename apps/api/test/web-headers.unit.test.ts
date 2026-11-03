import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Loaded by path at run time: the web app is a separate TypeScript project.
const WEB_PROXY: string = new URL('../../web/src/proxy.ts', import.meta.url).href;
const NEXT_SERVER: string = 'next/server';
const { NextRequest } = (await import(NEXT_SERVER)) as { NextRequest: new (url: string) => unknown };
const { config, proxy } = (await import(WEB_PROXY)) as { config: { matcher: unknown[] }; proxy: (r: unknown) => Response };

// The web app's security headers, straight from the Next.js proxy
// (apps/web/src/proxy.ts), so the main suite and the mutation check cover
// them without a browser. The browser test (test/e2e/web-security.e2e.ts)
// checks the same headers on the real production build. THREATS.md W2, W3.

const run = (path = '/') => proxy(new NextRequest(`https://vault.test${path}`));

// The proxy reads NODE_ENV on every request. Pin production here: a
// developer's .env (NODE_ENV=development, loaded by tools/mutation-check.mjs)
// must not turn this into a test of the development policy.
const savedNodeEnv = process.env.NODE_ENV;
beforeAll(() => { (process.env as Record<string, string>).NODE_ENV = 'production'; });
afterAll(() => { (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv; });
const directives = (csp: string) => new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(' ')[0]!, d.split(' ').slice(1)]));

describe('page headers from the Next.js proxy (production mode)', () => {
  it('a strict CSP: nonce scripts, nonce styles, nothing inline, no framing, no plugins, no base tag', () => {
    const csp = run().headers.get('content-security-policy')!;
    const d = directives(csp);
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    expect(d.get('default-src')).toEqual(["'self'"]);
    expect(d.get('script-src')).toEqual(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]);
    expect(d.get('style-src')).toEqual(["'self'", `'nonce-${nonce}'`]);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(d.get('object-src')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'none'"]);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
    expect(d.get('form-action')).toEqual(["'self'"]);
    expect(d.has('upgrade-insecure-requests')).toBe(true);
  });

  it('a fresh nonce for every request, handed to the page (x-nonce) and nowhere else', () => {
    const a = run();
    const b = run();
    const na = /'nonce-([^']+)'/.exec(a.headers.get('content-security-policy')!)![1];
    const nb = /'nonce-([^']+)'/.exec(b.headers.get('content-security-policy')!)![1];
    expect(na).not.toBe(nb);
    expect(Buffer.from(na!, 'base64').length).toBeGreaterThanOrEqual(16);
    // The nonce reaches the layout through the forwarded request headers,
    // never as a response header a page script could read cross-origin.
    expect(a.headers.get('x-nonce')).toBeNull();
    expect(a.headers.get('x-middleware-request-x-nonce')).toBe(na);
  });

  it('clickjacking, sniffing, referrer, permissions, opener isolation, caching', () => {
    const h = run('/documents/x').headers;
    expect(h.get('x-frame-options')).toBe('DENY');
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('referrer-policy')).toBe('no-referrer');
    expect(h.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=(), payment=()');
    expect(h.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(h.get('cache-control')).toBe('no-store');
  });

  it('applies to every page path (only /api and static assets are excluded)', () => {
    const source = (config.matcher[0] as { source: string }).source;
    const re = new RegExp(`^${source}$`);
    for (const p of ['/', '/login', '/documents/abc', '/admin/audit', '/account', '/invite', '/reset']) expect(re.test(p), p).toBe(true);
    for (const p of ['/api/documents', '/_next/static/x.js']) expect(re.test(p), p).toBe(false);
  });
});
