import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { auditRows, createUser, resetState, startApp, withDb, ownerDb, type TestApp, type TestUser } from '../helpers.js';

// Passkeys end to end in a real browser: the real Next.js pages, Chrome's
// own WebAuthn implementation, and the real API. The only stand-in is the
// authenticator: Chrome's built-in virtual authenticator (DevTools
// WebAuthn domain), which behaves like a platform passkey with user
// verification. The API runs in-process on :4100 against the test
// database; Next runs on :3005 and forwards /api to it, as in development.
//
//   npm run test:e2e -w apps/api      (needs Google Chrome installed)

const WEB = 'http://localhost:3005';
const CHROME = process.env.CHROME_PATH ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p));
const SHOTS = resolve(__dirname, 'out');

let t: TestApp;
let next: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let cdp: CDPSession;
let admin: TestUser;
let authenticatorId: string;

async function waitFor(url: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (r.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${url} did not come up`);
}

async function addAuthenticator(): Promise<string> {
  const r = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return r.authenticatorId;
}

async function signInWithPassword(user: TestUser) {
  await context.clearCookies();
  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.locator('form button[type=submit]').click();
  await page.waitForURL('**/login/mfa');
}

/** Status of an authenticated API call made by the page itself. */
const apiStatus = (path: string) => page.evaluate(async (p) => (await fetch(p)).status, path);

beforeAll(async () => {
  if (!CHROME) throw new Error('Google Chrome not found; set CHROME_PATH');
  mkdirSync(SHOTS, { recursive: true });
  t = await startApp({ PUBLIC_ORIGIN: WEB });
  await resetState(t.app);
  await t.app.listen(4100, '127.0.0.1');

  next = spawn('npx', ['next', 'dev', '-p', '3005'], { cwd: resolve(__dirname, '../../../web'), shell: true, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'development' } });
  await waitFor(`${WEB}/login`, 180_000);

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  context = await browser.newContext();
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  authenticatorId = await addAuthenticator();
  admin = await createUser({ email: `passkey-admin-${Date.now()}@t.io`, role: 'ADMIN', mfa: false });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  // Only the process tree this test started.
  if (next?.pid) {
    try {
      if (process.platform === 'win32') execSync(`taskkill /pid ${next.pid} /T /F`, { stdio: 'ignore' });
      else process.kill(-next.pid);
    } catch { /* already gone */ }
  }
  await t?.close();
});

describe('passkeys in a real browser', () => {
  it('an administrator without a second factor must enrol one, and can enrol a passkey', async () => {
    await signInWithPassword(admin);
    expect(await apiStatus('/api/documents')).toBe(403); // password alone is not enough
    await page.getByRole('button', { name: 'Use a passkey (this device)' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    expect(await apiStatus('/api/documents')).toBe(200);
    await page.screenshot({ path: resolve(SHOTS, '1-enrolled.png') });

    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    expect(credentials).toHaveLength(1);
    expect(credentials[0]!.rpId).toBe('localhost');
    const rows = await withDb(ownerDb(), (c) => c.query(`SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1`, [admin.id]));
    expect(rows.rows[0].n).toBe(1);
  });

  it('signs in with the passkey, and the authenticator counter moves forward', async () => {
    const before = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials[0]!.signCount;
    await signInWithPassword(admin);
    await page.getByRole('button', { name: 'Use a passkey' }).first().click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    expect(await apiStatus('/api/documents')).toBe(200);
    const after = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials[0]!.signCount;
    expect(after).toBeGreaterThan(before);
    expect(await auditRows(`actor_id = $1 AND action = 'mfa.passkey_register' AND outcome = 'ALLOWED'`, [admin.id])).toHaveLength(1);
    expect(await auditRows(`actor_id = $1 AND action = 'mfa.passkey_verify' AND outcome = 'ALLOWED'`, [admin.id])).toHaveLength(1);
  });

  it('adds a second passkey (another device) from the account page and signs in with it', async () => {
    await page.goto(`${WEB}/account`);
    // A different device: the first authenticator is gone, a new one is present.
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    authenticatorId = await addAuthenticator();
    await page.getByPlaceholder('Name, e.g. Work laptop').fill('Security key');
    await page.getByRole('button', { name: 'Add passkey' }).click();
    await expect.poll(async () => (await withDb(ownerDb(), (c) => c.query(`SELECT name FROM passkeys WHERE user_id = $1 ORDER BY created_at`, [admin.id]))).rows.map((r) => r.name), { timeout: 15_000 })
      .toEqual(['My passkey', 'Security key']);
    await page.locator('li', { hasText: 'Security key' }).waitFor({ timeout: 10_000 }); // the list on the page updates too
    await page.screenshot({ path: resolve(SHOTS, '2-two-passkeys.png') });

    await signInWithPassword(admin);
    await page.getByRole('button', { name: 'Use a passkey' }).first().click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    expect(await apiStatus('/api/documents')).toBe(200);
  });

  it('without a registered passkey on the device, the sign-in stays at the second step', async () => {
    await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
    await signInWithPassword(admin);
    await page.getByRole('button', { name: 'Use a passkey' }).first().click();
    await page.waitForTimeout(3000);
    expect(new URL(page.url()).pathname).toBe('/login/mfa');
    expect(await apiStatus('/api/documents')).toBe(403);
    await page.screenshot({ path: resolve(SHOTS, '3-no-passkey.png') });
  });
});
