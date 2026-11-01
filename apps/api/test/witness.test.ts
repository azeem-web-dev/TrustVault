import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, keys, login, resetState, startApp, withDb, appDb, type TestApp } from './helpers.js';
import { AuditAdminService, checkpointMessage } from '../src/audit/audit-admin.service.js';
import { LocalKeyProvider } from '../src/crypto/key-provider.js';

// The tools are plain .mjs (they must run with nothing but Node), so load
// them by URL and describe the parts the tests use.
interface Checkpoint { seq: string; headHash: string; signature: string; keyId: string; createdAt: string }
interface Witnessed extends Checkpoint { witnessedAt: string }
interface ServerView { signingKey: { publicKey: string; keyId: string }; checkpoints: Checkpoint[]; eventHashAtLast: string | null }
interface WitnessResult { ok: boolean; problems: string[]; newEntries: Witnessed[] }
const tool = (name: string) => pathToFileURL(resolve(__dirname, `../../../tools/${name}`)).href;
let witness: (log: Witnessed[], pinned: string | null, server: ServerView) => WitnessResult;
let verifyBundle: (bundle: unknown, key?: string, witnessed?: Witnessed[] | null) => { ok: boolean; problems: string[]; witnessMatched: number };
let canonical: (e: Record<string, unknown>) => Buffer;

let t: TestApp;
let svc: AuditAdminService;

beforeAll(async () => {
  ({ witness } = await import(tool('witness.mjs')));
  ({ verifyBundle, canonical } = await import(tool('verify-audit.mjs')));
  t = await startApp();
  svc = t.app.get(AuditAdminService);
  await resetState(t.app);
});
afterAll(async () => {
  await t.close();
});

/** Some audit activity, then a signed checkpoint of the head. */
async function activityThenCheckpoint(n: number) {
  const u = await createUser({ email: `w${n}-${Date.now()}@t.io`, role: 'VIEWER' });
  await login(t, u);
  await svc.checkpoint();
}

/** What tools/witness.mjs fetchServer() gathers, but through the test app. */
async function serverView(anchorSeq?: string): Promise<ServerView> {
  // Checkpoints accumulate in the test database across runs (they cannot be
  // deleted), so page through them exactly like the real tool does.
  const checkpoints: Checkpoint[] = [];
  let signingKey = null;
  let since = 1n;
  for (;;) {
    const page = (await t.http.get(`/api/witness/checkpoints?since=${since}&limit=1000`).expect(200)).body;
    signingKey = page.signingKey;
    checkpoints.push(...page.checkpoints);
    if (!page.hasMore) break;
    since = BigInt(page.checkpoints.at(-1).seq) + 1n;
  }
  let eventHashAtLast = null;
  if (anchorSeq) eventHashAtLast = (await t.http.get(`/api/witness/checkpoints?since=${anchorSeq}&limit=1`).expect(200)).body.eventHashAtSince;
  return { signingKey, checkpoints, eventHashAtLast };
}

describe('the public witness endpoint', () => {
  it('answers without signing in and reveals no event content', async () => {
    await activityThenCheckpoint(0);
    const res = await t.http.get('/api/witness/checkpoints').expect(200);
    expect(res.body.format).toBe('trustvault-witness-v1');
    expect(res.body.checkpoints.length).toBeGreaterThan(0);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/@t\.io|actor|email|document/i);
    expect(Object.keys(res.body.checkpoints[0]).sort()).toEqual(['createdAt', 'headHash', 'keyId', 'seq', 'signature']);
  });

  it('reports the chain hash the database holds right now at the requested seq', async () => {
    const last = (await serverView()).checkpoints.at(-1)!;
    const res = await t.http.get(`/api/witness/checkpoints?since=${last.seq}&limit=1`).expect(200);
    const db = await withDb(appDb(), async (c) => (await c.query(`SELECT encode(hash, 'hex') AS h FROM audit_events WHERE seq = $1`, [last.seq])).rows[0].h);
    expect(res.body.eventHashAtSince).toBe(db);
  });

  it('rejects bad parameters', async () => {
    await t.http.get('/api/witness/checkpoints?limit=5000').expect(400);
    await t.http.get('/api/witness/checkpoints?since=-1').expect(400);
    await t.http.get('/api/witness/checkpoints?evil=1').expect(400);
  });
});

describe('the outside witness', () => {
  let log: Witnessed[] = [];
  let pinned: string;

  beforeAll(async () => {
    await activityThenCheckpoint(1);
    const first = witness([], null, await serverView());
    expect(first.problems).toEqual([]);
    log = first.newEntries;
    pinned = (await serverView()).signingKey.publicKey;
  });

  it('records new checkpoints and accepts an honest server', async () => {
    await activityThenCheckpoint(2);
    const r = witness(log, pinned, await serverView(log.at(-1)!.seq));
    expect(r.problems).toEqual([]);
    expect(r.newEntries).toHaveLength(1);
    log = [...log, ...r.newEntries];
    // Nothing new: still fine, nothing recorded.
    const again = witness(log, pinned, await serverView(log.at(-1)!.seq));
    expect(again).toMatchObject({ ok: true, newEntries: [] });
  });

  it('catches a rewrite even when the forger holds the real signing key', async () => {
    // Root on the server rewrote history, recomputed the chain and had keyd
    // sign the forged head. Every signature is valid, but the hash at the
    // witnessed seq is not the one the witness recorded.
    const honest = await serverView(log.at(-1)!.seq);
    const k = keys();
    const forged = await Promise.all(honest.checkpoints.map(async (c) => {
      const headHash = createHash('sha256').update(`forged-${c.seq}`).digest();
      const { signature } = await k.sign(checkpointMessage(BigInt(c.seq), headHash));
      return { ...c, headHash: headHash.toString('hex'), signature: signature.toString('base64') };
    }));
    const forgedHead = forged.find((c) => c.seq === log.at(-1)!.seq)!.headHash;
    const r = witness(log, pinned, { ...honest, checkpoints: forged, eventHashAtLast: forgedHead });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/changed since it was witnessed/);
    expect(r.problems.join('\n')).toMatch(/no longer the witnessed hash/);
  });

  it('catches events rewritten behind checkpoints that were left alone', async () => {
    const honest = await serverView(log.at(-1)!.seq);
    const r = witness(log, pinned, { ...honest, eventHashAtLast: 'ab'.repeat(32) });
    expect(r.problems.join('\n')).toMatch(/history before it was rewritten/);
  });

  it('catches a deleted checkpoint, a backdated one, a bad signature and a new key', async () => {
    const honest = await serverView(log.at(-1)!.seq);
    const without = witness(log, pinned, { ...honest, checkpoints: honest.checkpoints.filter((c) => c.seq !== log[0]!.seq) });
    expect(without.problems.join('\n')).toMatch(/gone from the server/);

    const early = { ...log[0]!, seq: (BigInt(log[0]!.seq) - 1n).toString() };
    const backdated = witness(log, pinned, { ...honest, checkpoints: [early, ...honest.checkpoints] });
    expect(backdated.problems.join('\n')).toMatch(/appeared after later checkpoints/);

    const bogus = { ...honest.checkpoints.at(-1)!, seq: (BigInt(honest.checkpoints.at(-1)!.seq) + 5n).toString(), signature: Buffer.alloc(64).toString('base64') };
    const badSig = witness(log, pinned, { ...honest, checkpoints: [...honest.checkpoints, bogus] });
    expect(badSig.problems.join('\n')).toMatch(/bad signature/);

    const other = new LocalKeyProvider(Buffer.alloc(32, 7));
    const otherKey = (await other.publicKey()).publicKey.toString('base64');
    const swapped = witness(log, pinned, { ...honest, signingKey: { ...honest.signingKey, publicKey: otherKey } });
    expect(swapped.problems.join('\n')).toMatch(/signing key changed/);
  });

  it('an exported bundle that agrees with the witness verifies; a recomputed forgery does not', async () => {
    const fromSeq = BigInt(log[0]!.seq);
    const bundle = (await svc.export({} as never, fromSeq, undefined)) as unknown as { events: Record<string, unknown>[]; checkpoints: unknown[] };
    const honest = verifyBundle(bundle, undefined, log);
    expect(honest.problems).toEqual([]);
    expect(honest.witnessMatched).toBeGreaterThanOrEqual(2);

    // The forger edits one event and recomputes every later hash, and drops
    // the signed checkpoints: on its own, the bundle is self-consistent...
    const events = structuredClone(bundle.events);
    events[1]!.action = 'auth.nothing_to_see_here';
    let prev = events[0]!.hash as string;
    for (const e of events.slice(1)) {
      e.prev_hash = prev;
      e.hash = createHash('sha256').update(Buffer.from(prev, 'hex')).update(canonical(e)).digest('hex');
      prev = e.hash as string;
    }
    const forged = { ...bundle, events, checkpoints: [] };
    expect(verifyBundle(forged, undefined, null).ok).toBe(true);
    // ...but it no longer matches what the outside witness recorded.
    const withWitness = verifyBundle(forged, undefined, log);
    expect(withWitness.ok).toBe(false);
    expect(withWitness.problems.join('\n')).toMatch(/outside witness recorded/);
  });
});
