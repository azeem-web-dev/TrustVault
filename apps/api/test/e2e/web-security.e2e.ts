/// <reference lib="dom" />
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { currentStep, totpAt } from '../../src/auth/totp.js';
import { createUser, ownerDb, resetState, startApp, withDb, type TestApp, type TestUser } from '../helpers.js';
import { startProdWeb, type ProdWeb } from './prod-web.js';

// Web security regressions in a real browser (THREATS.md W1-W8): stored
// XSS payloads in every user-controlled field the pages show, rendered by
// the PRODUCTION build of the web app behind an nginx-like proxy, in
// headless Chrome. A payload that ran would call window.__xss() or open a
// dialog; a script the CSP blocks fires a securitypolicyviolation event,
// which is collected too (and must be zero on ordinary pages).

const PORT = 3006;
const NEXT_PORT = 4102;
const API_PORT = 4100;
const CHROME = process.env.CHROME_PATH ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p));
const SHOTS = resolve(__dirname, 'out');

/** Payloads: each calls window.__xss(tag) if it ever runs. */
const P = {
  script: `<script>window.__xss('script')</script>`,
  img: `<img src=x onerror="window.__xss('img')">`,
  svg: `<svg/onload=window.__xss('svg')>`,
  iframe: `"><iframe srcdoc="<script>parent.__xss('iframe')</script>">`,
  href: `javascript:window.__xss('href')`,
  tpl: `{{constructor.constructor('window.__xss(1)')()}}`,
  attr: `" autofocus onfocus="window.__xss('attr')" x="`,
  style: `<style>*{background:url(//evil.example/leak)}</style><b onmouseover=window.__xss('b')>x</b>`,
  close: `</textarea></title></script><script>window.__xss('close')</script>`,
};
const ALL = Object.values(P).join(' | ');

let t: TestApp;
let web: ProdWeb;
let browser: Browser;
let WEB: string;
let owner: TestUser, viewer: TestUser, admin: TestUser;
let docId: string;
let bgAlertId: string;
const sessions = new Map<string, { cookie: string; csrf: string }>();

async function apiLogin(u: TestUser) {
  const r = await t.http.post('/api/auth/login').set('Origin', WEB).send({ email: u.email, password: u.password });
  if (r.status !== 200) throw new Error(`login ${u.email}: ${r.status}`);
  let cookie = ([] as string[]).concat(r.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Host-tv_session='))!.split(';')[0]!;
  let csrf = r.body.csrfToken as string;
  if (r.body.mfaRequired && u.totpSecret) {
    await withDb(ownerDb(), (db) => db.query('UPDATE users SET totp_last_step = NULL WHERE id = $1', [u.id]));
    const v = await t.http.post('/api/auth/mfa/totp/verify').set('Cookie', cookie).set('Origin', WEB).set('X-CSRF-Token', csrf).send({ code: totpAt(u.totpSecret, currentStep()) });
    if (v.status !== 200) throw new Error(`totp ${u.email}: ${v.status}`);
    cookie = ([] as string[]).concat(v.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Host-tv_session='))!.split(';')[0]!;
    csrf = v.body.csrfToken as string;
  }
  sessions.set(u.email, { cookie, csrf });
  return { cookie, csrf };
}

const api = (u: TestUser) => {
  const s = sessions.get(u.email)!;
  const w = (r: import('supertest').Test) => r.set('Cookie', s.cookie).set('Origin', WEB).set('X-CSRF-Token', s.csrf);
  return {
    post: (p: string, b: object) => w(t.http.post(p)).send(b),
    put: (p: string, b: object) => w(t.http.put(p)).send(b),
    upload: (p: string, file: Buffer, name: string, fields: Record<string, string>) => {
      let r = w(t.http.post(p)).attach('file', file, name);
      for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
      return r;
    },
  };
};

interface Watched { page: Page; context: BrowserContext; hits: string[]; dialogs: string[]; violations: string[] }

/** A fresh browser context signed in as `u`, watching for script execution and CSP violations. */
async function browse(u: TestUser | null): Promise<Watched> {
  const context = await browser.newContext();
  if (u) {
    const value = sessions.get(u.email)!.cookie.split('=').slice(1).join('=');
    await context.addCookies([{ name: '__Host-tv_session', value, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
  }
  const hits: string[] = [];
  const dialogs: string[] = [];
  const violations: string[] = [];
  await context.exposeFunction('__reportXss', (tag: string) => hits.push(tag));
  await context.exposeFunction('__reportCsp', (v: string) => violations.push(v));
  await context.addInitScript(() => {
    const w = window as unknown as { __xss: (t: unknown) => void; __reportXss: (t: string) => void; __reportCsp: (v: string) => void };
    w.__xss = (tag) => w.__reportXss(String(tag));
    document.addEventListener('securitypolicyviolation', (e) => w.__reportCsp(`${e.effectiveDirective} ${e.blockedURI} ${e.sample}`));
  });
  const page = await context.newPage();
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  return { page, context, hits, dialogs, violations };
}

/** Opens a page, waits for its data, and hovers/focuses everything a payload could hook. */
async function visit(w: Watched, path: string, expectText?: string) {
  const res = await w.page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
  if (expectText) await w.page.getByText(expectText, { exact: false }).first().waitFor({ timeout: 20_000 });
  // Give onmouseover/onfocus payloads every chance.
  for (const el of (await w.page.locator('b, a, button, [title]').all()).slice(0, 60)) {
    await el.hover({ timeout: 500, force: true }).catch(() => undefined);
  }
  await w.page.keyboard.press('Tab');
  await w.page.waitForTimeout(300);
  return res!;
}

beforeAll(async () => {
  if (!CHROME) throw new Error('Google Chrome not found; set CHROME_PATH');
  mkdirSync(SHOTS, { recursive: true });
  WEB = `http://localhost:${PORT}`;
  t = await startApp({ PUBLIC_ORIGIN: WEB });
  await resetState(t.app);
  await t.app.listen(API_PORT, '127.0.0.1');
  web = await startProdWeb({ port: PORT, nextPort: NEXT_PORT, apiPort: API_PORT });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });

  // Stored payloads, created through the API like any user would.
  owner = await createUser({ email: `xss-owner-${Date.now()}@t.io`, role: 'OWNER', displayName: `Owner ${P.img}` });
  viewer = await createUser({ email: `xss-viewer-${Date.now()}@t.io`, role: 'VIEWER', displayName: `Viewer ${P.svg}` });
  admin = await createUser({ email: `xss-admin-${Date.now()}@t.io`, role: 'ADMIN', displayName: `Admin ${P.attr}` });
  await Promise.all([apiLogin(owner), apiLogin(viewer), apiLogin(admin)]);

  const up = await api(owner).upload('/api/documents', Buffer.from('hello\n'), `${P.href}' onmouseover='window.__xss(1)' x='.txt`, {
    title: `Title ${P.script}`, category: `Cat ${P.svg}`.slice(0, 60), description: `Desc ${P.iframe} ${P.style} ${P.close} ${P.tpl}`,
  });
  if (up.status !== 201) throw new Error(`upload: ${up.status} ${JSON.stringify(up.body)}`);
  docId = up.body.id;
  await api(owner).put(`/api/documents/${docId}/access`, { userId: viewer.id, level: 'READ' }).expect(200);
  const folder = await api(owner).post('/api/folders', { name: `Folder ${P.img}` });
  if (folder.status !== 201) throw new Error(`folder: ${folder.status} ${JSON.stringify(folder.body)}`);
  const group = await api(admin).post('/api/admin/groups', { name: `Group ${P.svg}`, description: `GDesc ${P.script}` });
  if (group.status !== 201) throw new Error(`group: ${group.status} ${JSON.stringify(group.body)}`);
  // Break-glass needs a second admin's approval (THREATS.md S19); the stored
  // reason (with its payloads) is what the approver and the alerts show.
  const admin2 = await createUser({ email: `xss-admin2-${Date.now()}@t.io`, role: 'ADMIN' });
  await apiLogin(admin2);
  const ask = await api(admin).post('/api/admin/approvals', { action: 'BREAK_GLASS', documentId: docId, reason: `Emergency review ${P.img} ${P.script} of a document` });
  if (ask.status !== 201) throw new Error(`approval request: ${ask.status} ${JSON.stringify(ask.body)}`);
  const ok = await api(admin2).post(`/api/admin/approvals/${ask.body.approval.id}/approve`);
  if (ok.status !== 200) throw new Error(`approve: ${ok.status} ${JSON.stringify(ok.body)}`);
  const bg = await api(admin).post('/api/admin/break-glass', { documentId: docId, approvalId: ask.body.approval.id });
  if (bg.status !== 201 && bg.status !== 200) throw new Error(`break-glass: ${bg.status} ${JSON.stringify(bg.body)}`);
  // The alerts page opens on the persistent queue: evaluate the rules once so
  // the break-glass alert (with its stored reason) is in it.
  const { AlertGeneratorService } = await import('../../src/risk/alert-generator.service.js');
  await t.app.get(AlertGeneratorService).run();
  bgAlertId = (await withDb(ownerDb(), (db) => db.query(`SELECT id FROM security_alerts WHERE rule = 'break_glass' AND document_id = $1`, [docId]))).rows[0].id;
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await web?.stop();
  await t?.close();
});

describe('stored XSS: payloads render as text, never run', () => {
  const pages: [string, () => TestUser, () => string, string][] = [
    ['document list', () => owner, () => '/', 'Title <script>'],
    ['search results (query reflected in the page)', () => owner, () => `/?q=${encodeURIComponent('Title')}&category=${encodeURIComponent(P.svg)}`, 'Title'],
    ['document detail (title, category, description, file name, access list)', () => owner, () => `/documents/${docId}`, 'Desc '],
    ['document detail as a reader', () => viewer, () => `/documents/${docId}`, 'Title <script>'],
    ['account page (display name)', () => owner, () => '/account', 'Owner <img'],
    ['admin: audit log (titles, file names, reasons in details)', () => admin, () => '/admin/audit', 'Title'],
    ['admin: users (display names)', () => admin, () => '/admin/users', 'Viewer <svg'],
    ['admin: groups (names, descriptions)', () => admin, () => '/admin/groups', 'Group <svg'],
    // The persistent queue, opened on the break-glass alert (as escalation emails link to it).
    ['admin: alerts (break-glass reason, document titles)', () => admin, () => `/admin/alerts?alert=${bgAlertId}`, 'Emergency review'],
  ];
  for (const [name, who, path, text] of pages) {
    it(name, async () => {
      const w = await browse(who());
      try {
        await visit(w, path(), text);
        await w.page.screenshot({ path: resolve(SHOTS, `xss-${name.split(' ')[0]!.replace(/\W/g, '')}.png`) });
        expect(w.hits, 'a payload ran').toEqual([]);
        expect(w.dialogs, 'a dialog opened').toEqual([]);
        // The payload is on the page as text (so it really was rendered)...
        const body = await w.page.locator('body').innerText();
        expect(body).toContain(text);
        // ...and none of it became markup.
        expect(await w.page.locator('iframe, img[src="x"], svg[onload], b[onmouseover]').count()).toBe(0);
        const inline = await w.page.locator('script, style').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
        expect(inline.filter((t) => t.includes('__xss(') && !t.includes('self.__next_f') || t.includes('evil.example/leak'))).toEqual([]);
        expect(await w.page.locator('a[href^="javascript:" i]').count()).toBe(0);
        expect(w.violations, 'CSP violations on an ordinary page').toEqual([]);
      } finally {
        await w.context.close();
      }
    });
  }

  it('the download link uses the document id, never the file name, and is an attachment', async () => {
    const w = await browse(owner);
    try {
      await visit(w, `/documents/${docId}`, 'Desc ');
      const hrefs = await w.page.locator('a[href*="/download"]').evaluateAll((as) => as.map((a) => (a as Element).getAttribute('href')));
      expect(hrefs.length).toBeGreaterThan(0);
      for (const h of hrefs) expect(h).toMatch(/^\/api\/documents\/[0-9a-f-]{36}\/(versions\/\d+\/)?download(\?variant=formulas-disabled)?$/);
      const res = await w.page.request.get(`${WEB}/api/documents/${docId}/download`);
      expect(res.headers()['content-disposition']).toMatch(/^attachment;/);
      expect(res.headers()['content-security-policy']).toContain('sandbox');
    } finally {
      await w.context.close();
    }
  });
});

describe('CSP is enforced and reports violations', () => {
  it('markup injected into the page HTML is blocked and reported (the detector works)', async () => {
    // Simulates a server-side injection bug: the real page, with its real
    // CSP header, but with attacker markup spliced into the HTML. (Code run
    // through DevTools is exempt from CSP, so it cannot be the control.)
    const w = await browse(null);
    try {
      await w.page.route(`${WEB}/login`, async (route) => {
        const res = await route.fetch();
        const html = (await res.text()).replace('<body>', `<body><script>window.__xss('injected')</script><img src="x" onerror="window.__xss('handler')"><style>body{background:red}</style><div style="color:red">styled</div>`);
        await route.fulfill({ response: res, body: html });
      });
      await w.page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
      await w.page.waitForTimeout(500);
      expect(w.hits).toEqual([]);
      expect(w.dialogs).toEqual([]);
      expect(w.violations.some((v) => v.startsWith('script-src-elem'))).toBe(true);
      expect(w.violations.some((v) => v.startsWith('script-src-attr'))).toBe(true);
      // Styles: an injected <style> element and a style attribute are refused too.
      expect(w.violations.some((v) => v.startsWith('style-src-elem'))).toBe(true);
      expect(w.violations.some((v) => v.startsWith('style-src-attr'))).toBe(true);
      expect(await w.page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgb(255, 0, 0)');
    } finally {
      await w.context.close();
    }
  });

  it('the theme script runs with the nonce (dark mode from localStorage), and nothing else inline does', async () => {
    const w = await browse(null);
    try {
      await w.page.goto(`${WEB}/login`);
      await w.page.evaluate(() => localStorage.setItem('tv-theme', 'dark'));
      await w.page.reload({ waitUntil: 'networkidle' });
      expect(await w.page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
      expect(w.violations).toEqual([]);
    } finally {
      await w.context.close();
    }
  });

  it('every inline script carries this response\'s nonce, and the nonce changes per request', async () => {
    const nonces: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${WEB}/login`);
      const csp = res.headers.get('content-security-policy')!;
      const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
      nonces.push(nonce);
      const html = await res.text();
      const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]!);
      expect(scripts.length).toBeGreaterThan(0);
      for (const attrs of scripts) expect(attrs).toContain(`nonce="${nonce}"`);
      for (const m of html.matchAll(/<style\b([^>]*)>/g)) expect(m[1]).toContain(`nonce="${nonce}"`);
    }
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(nonces[0]!.length).toBeGreaterThanOrEqual(24);
  });
});

describe('page headers', () => {
  const EXPECTED = (nonce: string) => [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join('; ');

  for (const path of ['/login', '/', '/documents/3f0e7a52-5b1a-4c1e-9d2a-1b2c3d4e5f60', '/account', '/admin/audit', '/admin/users', '/does-not-exist']) {
    it(`${path}: exact CSP, no framing, no caching, the rest of the headers`, async () => {
      const res = await fetch(`${WEB}${path}`, { headers: { Cookie: sessions.get(owner.email)!.cookie } });
      const h = res.headers;
      const csp = h.get('content-security-policy')!;
      const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
      expect(csp).toBe(EXPECTED(nonce));
      expect(h.get('x-frame-options')).toBe('DENY');
      expect(h.get('x-content-type-options')).toBe('nosniff');
      expect(h.get('referrer-policy')).toBe('no-referrer');
      expect(h.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=(), payment=()');
      expect(h.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(h.get('cache-control')).toMatch(/no-store/);
      expect(h.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains');
      expect(h.get('x-powered-by')).toBeNull();
    });
  }

  it('another site cannot frame the app (frame-ancestors / X-Frame-Options)', async () => {
    const w = await browse(owner);
    try {
      // A page on a different origin (127.0.0.1 is not localhost) framing the app.
      await w.page.route('http://127.0.0.1:5999/**', (r) => r.fulfill({ contentType: 'text/html', body: `<iframe id=f src="${WEB}/"></iframe>` }));
      await w.page.goto('http://127.0.0.1:5999/attack');
      await w.page.waitForTimeout(2000);
      const child = w.page.frames().find((f) => f !== w.page.mainFrame());
      expect(child).toBeDefined();
      expect(child!.url()).not.toBe(`${WEB}/`); // chrome-error://chromewebdata/
      expect(await child!.evaluate(() => document.body?.innerText ?? '').catch(() => '')).not.toContain('Title');
    } finally {
      await w.context.close();
    }
  });
});

describe('error pages do not reflect input', () => {
  it('Next 404 for a path full of markup', async () => {
    const w = await browse(null);
    try {
      const res = await w.page.goto(`${WEB}/${encodeURIComponent(P.script)}/${encodeURIComponent(P.img)}?x=${encodeURIComponent(P.svg)}`, { waitUntil: 'networkidle' });
      expect(res!.status()).toBe(404);
      const html = await res!.text();
      // Next keeps the URL, percent-encoded, in its route data; it must never
      // appear as markup.
      for (const raw of [P.script, P.img, P.svg, '<script>window', 'onerror=', 'onload=']) expect(html).not.toContain(raw);
      expect(html).toContain('This page could not be found');
      expect(w.hits).toEqual([]);
      expect(w.violations).toEqual([]);
    } finally {
      await w.context.close();
    }
  });

  it('a document page for an id that is markup', async () => {
    const w = await browse(owner);
    try {
      await w.page.goto(`${WEB}/documents/${encodeURIComponent(P.img)}`, { waitUntil: 'networkidle' });
      await w.page.waitForTimeout(500);
      expect(w.hits).toEqual([]);
      expect(await w.page.locator('body img[src="x"]').count()).toBe(0);
    } finally {
      await w.context.close();
    }
  });

  it('API errors through the proxy are JSON with no echo', async () => {
    const res = await fetch(`${WEB}/api/${encodeURIComponent(P.script)}`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.text()).not.toContain('script');
  });
});

void ALL;
