import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus } from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createUser, ORIGIN, resetState, startApp, type TestApp, type TestUser } from '../helpers.js';
import { RedisService } from '../../src/redis/redis.service.js';
import { emailKey, LIMITS } from '../../src/auth/login-throttle.service.js';
import { PARAMS } from '../../src/auth/password.service.js';

/**
 * Does the login response time reveal whether an account exists?
 *
 * Interleaves, in random order, failed logins for:
 *   unknown   an email with no account
 *   wrong     a real account, wrong password
 *   locked    a real account under attack (more than 10 failed attempts
 *             in the hour), wrong password: answered 202 "check your email"
 *             (there is no per-account lock any more; THREATS.md S27)
 * through the full HTTP stack with production Argon2 parameters, then asks
 * how well an attacker could tell them apart: a threshold is fitted on half
 * of the samples and scored on the other half. 50% means "coin toss".
 * Writes docs/LOGIN_TIMING.md. The automated, CI-safe check is
 * test/timing.test.ts; this script is the slow, full-strength measurement.
 */

const N = Number(process.env.TIMING_SAMPLES ?? 250);
/** The production default unless overridden (TIMING_FLOOR_MS=0 measures the code paths alone). */
const FLOOR = process.env.TIMING_FLOOR_MS;
type Kind = 'unknown' | 'wrong' | 'locked';

let t: TestApp;
let real: TestUser;
let locked: TestUser;

beforeAll(async () => {
  t = await startApp(FLOOR === undefined ? { LOGIN_FAILURE_FLOOR_MS: '450' } : { LOGIN_FAILURE_FLOOR_MS: FLOOR });
  await resetState(t.app);
  real = await createUser({ email: 'timing-real@t.io', role: 'VIEWER' });
  locked = await createUser({ email: 'timing-locked@t.io', role: 'VIEWER' });
});
afterAll(async () => { await t.close(); });

async function clearLimits() {
  const redis = t.app.get(RedisService).client;
  let cursor = '0';
  do {
    const prefix = (redis.options.keyPrefix ?? '') as string;
    const [next, found] = await redis.scan(cursor, 'MATCH', `${prefix}rl:*`, 'COUNT', 500);
    cursor = next;
    if (found.length) await redis.del(...found.map((k) => k.slice(prefix.length)));
  } while (cursor !== '0');
}

async function prepare() {
  await clearLimits();
  await t.app.get(RedisService).client.set(`rl:login:acct:${emailKey(locked.email)}`, String(LIMITS.account.soft + 5), 'EX', 600);
}

async function timeOne(kind: Kind): Promise<number> {
  const email = kind === 'unknown' ? `nobody-${Math.random().toString(36).slice(2)}@t.io` : kind === 'wrong' ? real.email : locked.email;
  const start = process.hrtime.bigint();
  const res = await t.http.post('/api/auth/login').set('Origin', ORIGIN).send({ email, password: 'definitely-not-the-password' });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (res.status !== (kind === 'locked' ? 202 : 401)) throw new Error(`unexpected ${res.status} for ${kind}`);
  return ms;
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const q = (xs: number[], p: number) => sorted(xs)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };

/** Fit the best threshold on the first half, score it on the second half. */
function attackerAccuracy(a: number[], b: number[]): number {
  const half = (xs: number[]) => [xs.filter((_, i) => i % 2 === 0), xs.filter((_, i) => i % 2 === 1)] as const;
  const [aTrain, aTest] = half(a);
  const [bTrain, bTest] = half(b);
  let best = { acc: 0, thr: 0, aBelow: true };
  for (const thr of sorted([...aTrain, ...bTrain])) {
    for (const aBelow of [true, false]) {
      const hits = aTrain.filter((x) => (x <= thr) === aBelow).length + bTrain.filter((x) => (x > thr) === aBelow).length;
      const acc = hits / (aTrain.length + bTrain.length);
      if (acc > best.acc) best = { acc, thr, aBelow };
    }
  }
  const hits = aTest.filter((x) => (x <= best.thr) === best.aBelow).length + bTest.filter((x) => (x > best.thr) === best.aBelow).length;
  return hits / (aTest.length + bTest.length);
}

it(`login timing: ${N} samples per case`, async () => {
  // Warm up the JIT, connection pools and the dummy hash.
  for (const k of ['unknown', 'wrong', 'locked', 'unknown', 'wrong', 'locked'] as Kind[]) { await prepare(); await timeOne(k); }

  const order: Kind[] = (['unknown', 'wrong', 'locked'] as Kind[]).flatMap((k) => Array<Kind>(N).fill(k));
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
  const samples: Record<Kind, number[]> = { unknown: [], wrong: [], locked: [] };
  for (const kind of order) {
    await prepare();
    samples[kind].push(await timeOne(kind));
  }

  const row = (k: Kind) => `| ${k} | ${q(samples[k], 0.5).toFixed(1)} | ${mean(samples[k]).toFixed(1)} | ${sd(samples[k]).toFixed(1)} | ${q(samples[k], 0.1).toFixed(1)} | ${q(samples[k], 0.9).toFixed(1)} |`;
  const vsWrong = attackerAccuracy(samples.unknown, samples.wrong);
  const vsLocked = attackerAccuracy(samples.unknown, samples.locked);
  const diffWrong = q(samples.wrong, 0.5) - q(samples.unknown, 0.5);
  const diffLocked = q(samples.locked, 0.5) - q(samples.unknown, 0.5);

  const report = [
    '# Login timing measurement',
    '',
    `Generated by \`npm run measure:timing\` (apps/api/test/timing/login-timing.measure.ts) on ${new Date().toISOString()}.`,
    '',
    `Question: can someone tell from the response time of a failed login whether the email has an account? ${N} failed logins of each kind, interleaved in random order, through the full HTTP stack with production Argon2id (${PARAMS.memoryCost / 1024} MiB, ${PARAMS.timeCost} passes). Failed-login floor: ${FLOOR ?? '450'} ms. Machine: ${cpus()[0]?.model ?? 'unknown'}, ${process.platform}.`,
    '',
    '| Case | median ms | mean ms | sd ms | p10 ms | p90 ms |',
    '|---|---|---|---|---|---|',
    row('unknown'), row('wrong'), row('locked'),
    '',
    'An attacker\'s best single threshold, fitted on half the samples and tested on the other half (50% = coin toss):',
    '',
    `- unknown email vs real account, wrong password: **${(vsWrong * 100).toFixed(1)}%** (median difference ${diffWrong.toFixed(1)} ms)`,
    `- unknown email vs account under attack (202 "check your email"): **${(vsLocked * 100).toFixed(1)}%** (median difference ${diffLocked.toFixed(1)} ms)`,
    '',
    'Every failed login, whatever the reason, also gets the same response body and status (401, "Invalid email or password"), and is rate limited per account and per IP, which caps how many samples a real attacker could collect.',
    ...(FLOOR === undefined ? ['', 'The padding hides small differences; the code paths are also equal without it. With the padding off (`TIMING_FLOOR_MS=0`): [LOGIN_TIMING_floor0.md](LOGIN_TIMING_floor0.md).', ''] : []),
    '',
  ].join('\n');
  writeFileSync(resolve(__dirname, `../../../../docs/LOGIN_TIMING${FLOOR === undefined ? '' : `_floor${FLOOR}`}.md`), report);
  console.log(report);

  expect(vsWrong).toBeLessThan(0.6);
  expect(vsLocked).toBeLessThan(0.6);
});
