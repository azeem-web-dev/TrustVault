import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, keys, login, resetState, startApp, type TestApp } from './helpers.js';
import { AuditAdminService, checkpointMessage } from '../src/audit/audit-admin.service.js';
import { LocalKeyProvider } from '../src/crypto/key-provider.js';
import { FakeRekor } from './fake-rekor.js';

// Publishing checkpoints to Sigstore's public log (tools/anchor.mjs) and
// checking the server against it (tools/witness.mjs, verify-audit.mjs).
// The log is FakeRekor, which follows Rekor's rules and signs receipts.

interface Checkpoint { seq: string; headHash: string; signature: string; keyId: string; createdAt: string }
interface Entry { uuid: string; logIndex: number; integratedTime: string; digest: string; signature: string }
interface Seen { uuid: string; logIndex: number; integratedTime: string; digest: string; seq: string }
type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;
interface AnchorOpts { source: string; stateDir: string; rekorUrl: string; rekorKey: string; fetchImpl: FetchLike; max?: number }

const tool = (name: string) => pathToFileURL(resolve(__dirname, `../../../tools/${name}`)).href;
let anchorOnce: (o: AnchorOpts) => Promise<{ anchored: { seq: string; logIndex: number }[]; problems: string[] }>;
let compareRekor: (server: Checkpoint[], seen: Seen[], fresh: { entries: Entry[]; invalid: string[] }, now?: Date) => { problems: string[]; newSeen: Seen[] };
let entriesForKey: (key: string, o: { url: string; rekorKey: string; fetchImpl: FetchLike; known?: Set<string> }) => Promise<{ entries: Entry[]; invalid: string[] }>;
let submit: (c: Checkpoint, key: string, o: { url: string; rekorKey: string; fetchImpl: FetchLike }) => Promise<Entry>;
let verifyBundle: (bundle: unknown) => { ok: boolean; problems: string[] };
let rekorReport: (bundle: unknown, entries: Entry[]) => { ok: boolean; anchored: number; latest: { seq: string } | null; problems: string[]; unmatchedOutside: number };
let canonical: (e: Record<string, unknown>) => Buffer;

const SOURCE = 'http://tv.local';
let t: TestApp;
let svc: AuditAdminService;
let publicKey: string;

beforeAll(async () => {
  ({ anchorOnce } = await import(tool('anchor.mjs')));
  ({ compareRekor } = await import(tool('witness.mjs')));
  ({ entriesForKey, submit } = await import(tool('rekor.mjs')));
  ({ verifyBundle, rekorReport, canonical } = await import(tool('verify-audit.mjs')));
  t = await startApp();
  svc = t.app.get(AuditAdminService);
  await resetState(t.app);
  publicKey = (await keys().publicKey()).publicKey.toString('base64');
});
afterAll(async () => {
  await t.close();
});

/** Routes the anchor's localhost calls to the test app and the rest to the fake log. */
const fetchVia = (rekor: FakeRekor): FetchLike => async (url, init) => {
  const u = String(url);
  if (!u.startsWith(SOURCE)) return rekor.fetch(u, init);
  const res = await t.http.get(u.slice(SOURCE.length));
  return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
};

async function activityThenCheckpoint() {
  const u = await createUser({ email: `anchor-${Date.now()}-${Math.random()}@t.io`, role: 'VIEWER' });
  await login(t, u);
  await svc.checkpoint();
}

/** Anchors until nothing is left (the test database keeps old checkpoints). */
async function anchorAll(o: AnchorOpts) {
  let total = 0;
  for (;;) {
    const r = await anchorOnce({ max: 1000, ...o });
    expect(r.problems).toEqual([]);
    if (r.anchored.length === 0) return total;
    total += r.anchored.length;
  }
}

async function allCheckpoints(): Promise<Checkpoint[]> {
  const out: Checkpoint[] = [];
  let since = 1n;
  for (;;) {
    const page = (await t.http.get(`/api/witness/checkpoints?since=${since}&limit=1000`).expect(200)).body;
    out.push(...page.checkpoints);
    if (!page.hasMore) return out;
    since = BigInt(page.checkpoints.at(-1).seq) + 1n;
  }
}

describe('anchoring checkpoints in the public log', () => {
  let rekor: FakeRekor;
  let dir: string;
  let opts: AnchorOpts;

  beforeEach(() => {
    rekor = new FakeRekor();
    dir = mkdtempSync(join(tmpdir(), 'tv-anchor-'));
    opts = { source: SOURCE, stateDir: dir, rekorUrl: rekor.base, rekorKey: rekor.publicKeyPem, fetchImpl: fetchVia(rekor) };
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it('publishes every checkpoint once, in chain order, and records each receipt', async () => {
    await activityThenCheckpoint();
    const n = await anchorAll(opts);
    const checkpoints = await allCheckpoints();
    expect(n).toBe(checkpoints.length);
    expect(rekor.size).toBe(checkpoints.length);

    const lines = readFileSync(join(dir, 'anchored.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.seq)).toEqual(checkpoints.map((c) => c.seq));
    const indexes = lines.map((l) => l.logIndex);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(JSON.parse(readFileSync(join(dir, 'signing-key.json'), 'utf8')).publicKey).toBe(publicKey);

    // Later: only the new checkpoint goes out.
    await activityThenCheckpoint();
    const before = rekor.submissions;
    expect(await anchorAll(opts)).toBe(1);
    expect(rekor.submissions - before).toBe(1);
  });

  it('records nothing when the log is down, and catches up when it is back', async () => {
    await activityThenCheckpoint();
    rekor.mode = 'down';
    await expect(anchorOnce(opts)).rejects.toThrow(/Rekor answered 503/);
    expect(() => readFileSync(join(dir, 'anchored.jsonl'), 'utf8')).toThrow();
    rekor.mode = 'normal';
    expect(await anchorAll(opts)).toBe((await allCheckpoints()).length);
  });

  it('refuses a receipt for a different entry or one not signed by the pinned log key', async () => {
    await activityThenCheckpoint();
    await anchorAll(opts); // the log now has entries a lying log could hand back
    const anchoredBefore = readFileSync(join(dir, 'anchored.jsonl'), 'utf8');
    await activityThenCheckpoint();

    rekor.mode = 'wrong-entry';
    await expect(anchorOnce(opts)).rejects.toThrow(/for a different entry/);
    rekor.mode = 'bad-receipt';
    await expect(anchorOnce(opts)).rejects.toThrow(/receipt .* is invalid/);
    expect(readFileSync(join(dir, 'anchored.jsonl'), 'utf8')).toBe(anchoredBefore);
  });

  it('after losing its state, re-anchors without creating duplicates', async () => {
    await activityThenCheckpoint();
    await anchorAll(opts);
    const size = rekor.size;
    rmSync(join(dir, 'anchored.jsonl'));
    await anchorAll(opts); // every submission answers 409 and the existing receipt is recorded
    expect(rekor.size).toBe(size);
    expect(readFileSync(join(dir, 'anchored.jsonl'), 'utf8').trim().split('\n')).toHaveLength(size);
  });

  it('refuses to anchor anything if the server starts signing with another key', async () => {
    const other = (await new LocalKeyProvider(Buffer.alloc(32, 9)).publicKey()).publicKey.toString('base64');
    writeFileSync(join(dir, 'signing-key.json'), JSON.stringify({ publicKey: other }));
    const r = await anchorOnce(opts);
    expect(r.problems.join('\n')).toMatch(/signing key changed/);
    expect(rekor.submissions).toBe(0);
  });
});

describe('the witness compares the server with the public log', () => {
  let rekor: FakeRekor;
  let opts: AnchorOpts;
  let dir: string;
  const lookup = (known?: Set<string>) => entriesForKey(publicKey, { url: rekor.base, rekorKey: rekor.publicKeyPem, fetchImpl: rekor.fetch, known });

  beforeAll(async () => {
    rekor = new FakeRekor();
    dir = mkdtempSync(join(tmpdir(), 'tv-anchor-w-'));
    opts = { source: SOURCE, stateDir: dir, rekorUrl: rekor.base, rekorKey: rekor.publicKeyPem, fetchImpl: fetchVia(rekor) };
    await activityThenCheckpoint();
    await anchorAll(opts);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('an honest server matches every public entry; later runs fetch only new ones', async () => {
    const server = await allCheckpoints();
    const fresh = await lookup();
    expect(fresh.invalid).toEqual([]);
    const r = compareRekor(server, [], fresh);
    expect(r.problems).toEqual([]);
    expect(r.newSeen.map((e) => e.seq)).toEqual(server.map((c) => c.seq));

    const again = await lookup(new Set(r.newSeen.map((e) => e.uuid)));
    expect(again.entries).toEqual([]);
  });

  it('catches a checkpoint changed after it was published, even re-signed with the real key', async () => {
    const server = await allCheckpoints();
    const victim = server.at(-1)!;
    const headHash = createHash('sha256').update('rewritten').digest();
    const { signature } = await keys().sign(checkpointMessage(BigInt(victim.seq), headHash));
    const forged = server.map((c) => (c === victim ? { ...c, headHash: headHash.toString('hex'), signature: signature.toString('base64') } : c));
    const r = compareRekor(forged, [], await lookup());
    expect(r.problems.join('\n')).toMatch(/matches no checkpoint on the server/);
  });

  it('catches a checkpoint deleted after it was published', async () => {
    const server = await allCheckpoints();
    const r = compareRekor(server.slice(0, -1), [], await lookup());
    expect(r.problems.join('\n')).toMatch(/matches no checkpoint on the server/);
  });

  it('raises the alarm when a checkpoint stays unpublished for over an hour', async () => {
    await activityThenCheckpoint(); // signed, not anchored
    const server = await allCheckpoints();
    const fresh = await lookup();
    expect(compareRekor(server, [], fresh).problems).toEqual([]); // just signed: fine
    const later = new Date(Date.now() + 61 * 60_000);
    expect(compareRekor(server, [], fresh, later).problems.join('\n')).toMatch(/still not in the public log/);
  });
});

describe('verify-audit --rekor', () => {
  // A small self-contained chain: events, checkpoints signed with the real
  // key, published to a fresh log.
  const k = keys();
  const genesis = '00'.repeat(32);
  function chain(n: number, edit?: (e: Record<string, unknown>) => void) {
    const events: Record<string, unknown>[] = [];
    let prev = genesis;
    for (let i = 1; i <= n; i++) {
      const e: Record<string, unknown> = {
        seq: String(i), id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, occurred_at: `2026-11-01T10:00:${String(i).padStart(2, '0')}.000000Z`,
        actor_id: null, actor_email: 'a@t.io', action: 'document.view', outcome: 'ALLOWED', reason: null, target_type: 'document', target_id: null,
        document_id: null, ip: '127.0.0.1', user_agent: null, request_id: null, details: null,
      };
      if (edit && i === 3) edit(e);
      e.prev_hash = prev;
      e.hash = createHash('sha256').update(Buffer.from(prev, 'hex')).update(canonical(e)).digest('hex');
      prev = e.hash as string;
      events.push(e);
    }
    return events;
  }
  async function checkpointsFor(events: Record<string, unknown>[], seqs: number[]): Promise<Checkpoint[]> {
    return Promise.all(seqs.map(async (s) => {
      const e = events[s - 1]!;
      const { signature, keyId } = await k.sign(checkpointMessage(BigInt(s), Buffer.from(e.hash as string, 'hex')));
      return { seq: String(s), headHash: e.hash as string, signature: signature.toString('base64'), keyId, createdAt: new Date().toISOString() };
    }));
  }
  const bundleOf = (events: Record<string, unknown>[], checkpoints: Checkpoint[], fromOne = true) => ({
    format: 'trustvault-audit-bundle-v1', genesisPrevHash: fromOne ? genesis : null, exportedAt: new Date().toISOString(), events, checkpoints,
    signingKey: { keyId: 'k', publicKey, algorithm: 'Ed25519' },
  });

  it('reports what was published, and rejects a recomputed forgery that verifies on its own', async () => {
    const rekor = new FakeRekor();
    const o = { url: rekor.base, rekorKey: rekor.publicKeyPem, fetchImpl: rekor.fetch };
    const honest = chain(8);
    const cps = await checkpointsFor(honest, [4, 8]);
    for (const c of cps) await submit(c, publicKey, o);
    const { entries } = await entriesForKey(publicKey, o);

    const good = rekorReport(bundleOf(honest, cps), entries);
    expect(good).toMatchObject({ ok: true, anchored: 2, latest: { seq: '8' } });

    // Root rewrites event 3, recomputes the chain and has keyd re-sign a
    // new checkpoint at 8. The bundle is self-consistent and well signed...
    const forgedEvents = chain(8, (e) => { e.action = 'document.nothing'; });
    const forgedCps = await checkpointsFor(forgedEvents, [8]);
    await submit(forgedCps[0]!, publicKey, o); // it may even publish the forgery
    const forged = bundleOf(forgedEvents, forgedCps);
    expect(verifyBundle(forged).ok).toBe(true);
    // ...but the public log still holds the honest checkpoint at 4, published earlier.
    const r = rekorReport(forged, (await entriesForKey(publicKey, o)).entries);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/this bundle does not contain/); // the removed-tail check itself, not a later fallback
  });

  it('for a bundle that starts later, does not guess about entries before its range', async () => {
    const rekor = new FakeRekor();
    const o = { url: rekor.base, rekorKey: rekor.publicKeyPem, fetchImpl: rekor.fetch };
    const events = chain(8);
    const cps = await checkpointsFor(events, [2, 6]);
    for (const c of cps) await submit(c, publicKey, o);
    const partial = bundleOf(events.slice(4), cps.slice(1), false);
    const r = rekorReport(partial, (await entriesForKey(publicKey, o)).entries);
    expect(r).toMatchObject({ ok: true, anchored: 1, unmatchedOutside: 1 });
  });
});
