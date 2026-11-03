import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisService } from '../src/redis/redis.service.js';
import { MailService } from '../src/mail/mail.service.js';
import { emailKey, LIMITS } from '../src/auth/login-throttle.service.js';
import { PARAMS } from '../src/auth/password.service.js';
import { createUser, ORIGIN, resetState, startApp, type TestApp, type TestUser } from './helpers.js';

/**
 * Does response time say whether an email has an account (THREATS.md S2)?
 * An automated, CI-safe version of the manual measurement in
 * test/timing/login-timing.measure.ts.
 *
 * Method. For each pair of cases, N requests of each are sent through the
 * full HTTP stack, interleaved in random order (so load spikes and drift hit
 * both cases alike), with every rate-limit counter cleared before each one.
 * The two samples are compared with a Mann-Whitney U test, which uses ranks
 * only: robust to outliers and makes no assumption about the shape of the
 * distribution. A pair fails only if BOTH
 *   - the difference is large: AUC (the chance a random sample of one case
 *     is slower than one of the other) is outside 0.5 ± 0.2, and
 *   - it is not chance: two-sided p < 0.001,
 * and it fails the same way again on a fresh re-measurement. With no real
 * difference the chance of a false failure is about 1e-6; a real leak of a
 * few milliseconds against ~1-2 ms of jitter gives AUC > 0.9 and fails both
 * times.
 *
 * What is compared, with the production rule that failures are padded to
 * LOGIN_FAILURE_FLOOR_MS (here 120 ms; test Argon2 is light, so the real
 * work is well under it; 400 ms if production Argon2 is in force):
 *   login     unknown email      vs real account, wrong password
 *   login     under attack: wrong password vs the right one (which also
 *             issues and emails a sign-in link) — both answer 202
 *   forgot    unknown email      vs real account (which issues and emails a link)
 *
 * Environment:
 *   SKIP_TIMING_TESTS=1  skip (e.g. on a CI runner too overloaded to hold a
 *                        120 ms floor). Not set in this repository's CI.
 *   TIMING_STRICT=1      also run login unknown-vs-wrong with the floor OFF,
 *                        which checks the code paths themselves do the same
 *                        work. Noisier, so not on by default.
 *   TIMING_SAMPLES=n     samples per case (default 60).
 */

const N = Number(process.env.TIMING_SAMPLES ?? 60);
// The floor must stay above the real work. The suite normally uses light
// test Argon2 parameters; when production parameters are in force (NODE_ENV
// not "test", e.g. a .env loaded by tools/mutation-check.mjs) one verify
// alone takes 100-200 ms, so the floor is raised to keep the check meaningful.
const FLOOR_MS = PARAMS.memoryCost >= 65536 ? 400 : 120;
const AUC_MARGIN = 0.2;
const P_MAX = 0.001;

/** Complementary error function (Numerical Recipes erfcc, |error| < 1.2e-7). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** Mann-Whitney U: AUC = P(a sample of `a` > a sample of `b`), and the two-sided p-value (normal approximation, tie-corrected ranks). */
export function mannWhitney(a: number[], b: number[]): { auc: number; p: number } {
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array<number>(all.length);
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.v === all[i]!.v) j++;
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1;
    i = j + 1;
  }
  const rA = all.reduce((s, x, i) => (x.g === 0 ? s + ranks[i]! : s), 0);
  const n1 = a.length;
  const n2 = b.length;
  const u = rA - (n1 * (n1 + 1)) / 2;
  const z = (u - (n1 * n2) / 2) / Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  return { auc: u / (n1 * n2), p: erfc(Math.abs(z) / Math.SQRT2) };
}

const leaks = (r: { auc: number; p: number }) => Math.abs(r.auc - 0.5) > AUC_MARGIN && r.p < P_MAX;
const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;

describe('the statistics', () => {
  it('sees no difference between two samples of the same thing, and a clear one when there is', () => {
    // Deterministic pseudo-random jitter (no flake in the checker itself).
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const noise = (base: number) => Array.from({ length: 200 }, () => base + rnd() * 4 + rnd() * 4);
    expect(leaks(mannWhitney(noise(120), noise(120)))).toBe(false);
    const shifted = mannWhitney(noise(123), noise(120));
    expect(shifted.auc).toBeGreaterThan(0.75);
    expect(leaks(shifted)).toBe(true);
    expect(mannWhitney([1, 2, 3], [1, 2, 3]).auc).toBe(0.5);
  });
});

describe.skipIf(process.env.SKIP_TIMING_TESTS === '1')('response time does not reveal accounts', () => {
  let t: TestApp;
  let real: TestUser;
  let strict: TestApp | null = null;

  beforeAll(async () => {
    t = await startApp({ MAIL_TRANSPORT: 'memory', LOGIN_FAILURE_FLOOR_MS: String(FLOOR_MS) });
    await resetState(t.app);
    real = await createUser({ email: 'timing-real@t.io', role: 'VIEWER' });
    if (process.env.TIMING_STRICT === '1') strict = await startApp({ MAIL_TRANSPORT: 'memory', LOGIN_FAILURE_FLOOR_MS: '0' });
  });
  afterAll(async () => {
    await t.close();
    await strict?.close();
  });

  async function clearLimits(app: TestApp) {
    const redis = app.app.get(RedisService).client;
    const prefix = (redis.options.keyPrefix ?? '') as string;
    let cursor = '0';
    do {
      const [next, found] = await redis.scan(cursor, 'MATCH', `${prefix}rl:*`, 'COUNT', 500);
      cursor = next;
      if (found.length) await redis.del(...found.map((k) => k.slice(prefix.length)));
    } while (cursor !== '0');
    app.app.get(MailService).outbox.length = 0;
  }

  /** Puts an account "under attack" (over the per-account soft limit) without making any requests. */
  async function underAttack(app: TestApp, email: string) {
    await app.app.get(RedisService).client.set(`rl:login:acct:${emailKey(email)}`, String(LIMITS.account.soft + 5), 'EX', 600);
  }

  type Probe = { name: string; prepare?: (app: TestApp) => Promise<void>; send: (app: TestApp) => Promise<number>; expect: number };
  const unknownEmail = () => `nobody-${Math.random().toString(36).slice(2)}@t.io`;
  const login = (email: string, password: string) => async (app: TestApp) =>
    (await app.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email, password })).status;
  const forgot = (email: () => string) => async (app: TestApp) =>
    (await app.http.post('/api/auth/password/forgot').set('Origin', ORIGIN).send({ email: email() })).status;

  async function sample(app: TestApp, a: Probe, b: Probe): Promise<{ a: number[]; b: number[] }> {
    const out = { a: [] as number[], b: [] as number[] };
    const order = [...Array<0>(N).fill(0), ...Array<1>(N).fill(1)];
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
    // Warm up both paths (JIT, pools, the dummy hash) before measuring.
    for (const p of [a, b, a, b]) { await clearLimits(app); await p.prepare?.(app); await p.send(app); }
    for (const which of order) {
      const p = which === 0 ? a : b;
      await clearLimits(app);
      await p.prepare?.(app);
      const start = process.hrtime.bigint();
      const status = await p.send(app);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      if (status !== p.expect) throw new Error(`${p.name}: expected ${p.expect}, got ${status}`);
      (which === 0 ? out.a : out.b).push(ms);
    }
    return out;
  }

  /** Measure; if it looks like a leak, measure again from scratch; fail only if both do. */
  async function expectIndistinguishable(app: TestApp, a: Probe, b: Probe, floor: number) {
    let tries = 0;
    let last = { auc: 0.5, p: 1 };
    let s = { a: [] as number[], b: [] as number[] };
    while (tries < 2) {
      tries++;
      s = await sample(app, a, b);
      last = mannWhitney(s.a, s.b);
      if (!leaks(last)) break;
    }
    const summary = `${a.name} median ${median(s.a).toFixed(1)} ms vs ${b.name} ${median(s.b).toFixed(1)} ms; AUC ${last.auc.toFixed(3)}, p ${last.p.toExponential(1)} (${tries} run${tries > 1 ? 's' : ''})`;
    console.log(`[timing] ${summary}`);
    expect(leaks(last), summary).toBe(false);
    // The floor really is applied to both (when it is on).
    if (floor > 0) {
      expect(Math.min(...s.a), summary).toBeGreaterThanOrEqual(floor);
      expect(Math.min(...s.b), summary).toBeGreaterThanOrEqual(floor);
    }
  }

  it('login: unknown email vs real account with a wrong password', { timeout: 300_000 }, async () => {
    await expectIndistinguishable(t,
      { name: 'unknown', send: (app) => login(unknownEmail(), 'definitely-not-the-password')(app), expect: 401 },
      { name: 'wrong password', send: login(real.email, 'definitely-not-the-password'), expect: 401 },
      FLOOR_MS);
  });

  it('login under attack: wrong password vs the right one (which emails a link)', { timeout: 300_000 }, async () => {
    await expectIndistinguishable(t,
      { name: 'wrong', prepare: (app) => underAttack(app, real.email), send: login(real.email, 'definitely-not-the-password'), expect: 202 },
      { name: 'right', prepare: (app) => underAttack(app, real.email), send: login(real.email, real.password), expect: 202 },
      FLOOR_MS);
  });

  it('forgot password: unknown email vs real account (which emails a link)', { timeout: 300_000 }, async () => {
    await expectIndistinguishable(t,
      { name: 'unknown', send: forgot(unknownEmail), expect: 202 },
      { name: 'real', send: forgot(() => real.email), expect: 202 },
      FLOOR_MS);
  });

  it.runIf(process.env.TIMING_STRICT === '1')('strict, floor off: login unknown vs wrong password do the same work', { timeout: 300_000 }, async () => {
    await expectIndistinguishable(strict!,
      { name: 'unknown', send: (app) => login(unknownEmail(), 'definitely-not-the-password')(app), expect: 401 },
      { name: 'wrong password', send: login(real.email, 'definitely-not-the-password'), expect: 401 },
      0);
  });
});
