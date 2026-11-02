#!/usr/bin/env node
// Standalone tests for tools/verify-audit.mjs. No network, no dependencies:
//   node tools/verify-audit.test.mjs
// Builds synthetic bundles with a throwaway Ed25519 key and a fake public log.

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { checkpointDigest } from './rekor.mjs';
import { checkpointMessage, eventHash, EXIT, run } from './verify-audit.mjs';

const ZERO = '0'.repeat(64);
const T0 = Date.parse('2026-11-01T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
  return { pub: raw, priv: privateKey };
}

/** Event i occurs at T0 + i seconds. */
function makeEvents(n, { tamperFrom = null, prevHash = ZERO, startSeq = 1 } = {}) {
  const events = [];
  let prev = prevHash;
  for (let s = startSeq; s < startSeq + n; s++) {
    const e = {
      seq: String(s), id: `00000000-0000-0000-0000-${String(s).padStart(12, '0')}`, occurred_at: iso(T0 + s * 1000),
      actor_id: null, actor_email: 'admin@example.com', action: tamperFrom !== null && s >= tamperFrom ? 'document.view' : 'document.download',
      outcome: 'ALLOWED', reason: null, target_type: 'document', target_id: null, document_id: null,
      ip: '10.0.0.1', user_agent: 'test', request_id: null, details: '{}', prev_hash: prev,
    };
    e.hash = eventHash(e);
    prev = e.hash;
    events.push(e);
  }
  return events;
}

const checkpoint = (events, seq, key, createdAt) => {
  const headHash = events.find((e) => e.seq === String(seq)).hash;
  const c = { seq: String(seq), headHash, keyId: 'test-key' };
  c.signature = sign(null, checkpointMessage(c), key.priv).toString('base64');
  c.createdAt = iso(createdAt ?? T0 + seq * 1000 + 30_000);
  return c;
};

function bundleOf(events, checkpoints, key, exportedAt) {
  return {
    format: 'trustvault-audit-bundle-v1',
    exportedAt: iso(exportedAt),
    genesisPrevHash: events[0].prev_hash === ZERO ? ZERO : null,
    events,
    checkpoints,
    signingKey: { keyId: 'test-key', publicKey: key.pub, algorithm: 'Ed25519' },
  };
}

/** A fake Rekor entry for a checkpoint, as tools/rekor.mjs parseEntry returns it. */
let logIndex = 1000;
const rekorEntry = (c, integratedAt) => ({ uuid: `u${logIndex}`, logIndex: logIndex++, integratedTime: iso(integratedAt), digest: checkpointDigest(c) });
const witnessRecord = (c, witnessedAt) => ({ seq: c.seq, headHash: c.headHash, signature: c.signature, keyId: c.keyId, createdAt: c.createdAt, witnessedAt: iso(witnessedAt) });

/** Runs the CLI with in-memory files and an injected public log. */
async function cli(args, { bundle, witness = null, rekor = [] }) {
  const lines = [];
  const files = { 'bundle.json': JSON.stringify(bundle), 'witness.jsonl': witness ? witness.map((w) => JSON.stringify(w)).join('\n') + '\n' : '' };
  const code = await run(['bundle.json', ...args], {
    readFile: (p) => { if (!(p in files)) throw new Error(`no file ${p}`); return files[p]; },
    entriesForKey: async () => ({ entries: rekor, invalid: [] }),
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    now: () => bundle ? Date.parse(bundle.exportedAt) + 1000 : Date.now(),
  });
  return { code, out: lines.join('\n') };
}

// ---- fixtures -------------------------------------------------------------
const real = keypair();
const other = keypair();

// The real log: 300 events, checkpoints at 100/200/300, each anchored in Rekor a minute later and witnessed.
const realEvents = makeEvents(300);
const realCps = [100, 200, 300].map((s) => checkpoint(realEvents, s, real));
const publicLog = realCps.map((c) => rekorEntry(c, Date.parse(c.createdAt) + 60_000));
const witnessLog = realCps.map((c) => witnessRecord(c, Date.parse(c.createdAt) + 120_000));
const exportAt = Date.parse(realCps[2].createdAt) + 60 * 60_000; // an hour after the last checkpoint
const good = bundleOf(realEvents, realCps, real, exportAt);

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n${err.message}`);
    process.exitCode = 1;
  }
}

await test('good bundle with --key passes', async () => {
  const r = await cli(['--key', real.pub], { bundle: good });
  assert.equal(r.code, EXIT.INTACT, r.out);
  assert.match(r.out, /^INTACT: 300 events and 3 signed checkpoints verified/m);
});

await test('good bundle with --key --rekor --witness passes', async () => {
  const r = await cli(['--key', real.pub, '--rekor', '--witness', 'witness.jsonl'], { bundle: good, witness: witnessLog, rekor: publicLog });
  assert.equal(r.code, EXIT.INTACT, r.out);
  assert.match(r.out, /3 of the bundle's checkpoints are in Sigstore's public log; the newest, seq 300/);
  assert.match(r.out, /3 head\(s\) recorded by the outside witness match/);
});

await test('old positional key form still works', async () => {
  const r = await cli([real.pub], { bundle: good });
  assert.equal(r.code, EXIT.INTACT, r.out);
});

await test('wrong --key fails', async () => {
  const r = await cli(['--key', other.pub], { bundle: good });
  assert.equal(r.code, EXIT.TAMPERED, r.out);
  assert.match(r.out, /not the key you pinned with --key/);
});

await test('no key, no rekor, no witness exits 2 with a loud warning', async () => {
  const r = await cli([], { bundle: good });
  assert.equal(r.code, EXIT.UNANCHORED, r.out);
  assert.match(r.out, /only proves the bundle is/);
  assert.match(r.out, /^UNVERIFIED:/m);
});

await test('--self-consistency-only accepts an unanchored bundle with exit 0', async () => {
  const r = await cli(['--self-consistency-only'], { bundle: good });
  assert.equal(r.code, EXIT.INTACT, r.out);
  assert.match(r.out, /^CONSISTENT:/m);
});

await test('zero checkpoints fails', async () => {
  const r = await cli(['--key', real.pub], { bundle: bundleOf(realEvents, [], real, exportAt) });
  assert.equal(r.code, EXIT.TAMPERED, r.out);
  assert.match(r.out, /no signed checkpoints/);
});

await test('forged chain recomputed and signed with another key fails with --key', async () => {
  const forged = makeEvents(300, { tamperFrom: 150 });
  const cps = [100, 200, 300].map((s) => checkpoint(forged, s, other));
  const r = await cli(['--key', real.pub], { bundle: bundleOf(forged, cps, other, exportAt) });
  assert.equal(r.code, EXIT.TAMPERED, r.out);
  assert.match(r.out, /not the key you pinned/);
  assert.match(r.out, /bad signature/);
});

await test('same forged chain without --key only gets exit 2, not INTACT', async () => {
  const forged = makeEvents(300, { tamperFrom: 150 });
  const cps = [100, 200, 300].map((s) => checkpoint(forged, s, other));
  const r = await cli([], { bundle: bundleOf(forged, cps, other, exportAt) });
  assert.equal(r.code, EXIT.UNANCHORED, r.out);
  assert.doesNotMatch(r.out, /^INTACT/m);
});

await test('forged chain with its own key fails --rekor when none of it is in the public log', async () => {
  const forged = makeEvents(300, { tamperFrom: 150 });
  const cps = [100, 200, 300].map((s) => checkpoint(forged, s, other));
  const r = await cli(['--rekor'], { bundle: bundleOf(forged, cps, other, exportAt), rekor: [] });
  assert.equal(r.code, EXIT.TAMPERED, r.out);
  assert.match(r.out, /none of this bundle's 3 checkpoint\(s\) is in Sigstore/);
});

// The attack: rewrite events from seq 250, delete checkpoint 300, export from seq 1.
const truncated = (() => {
  const events = makeEvents(300, { tamperFrom: 250 });
  assert.equal(events[199].hash, realEvents[199].hash); // history up to 249 is unchanged
  const cps = [100, 200].map((s) => checkpoint(events, s, real));
  return bundleOf(events, cps, real, exportAt);
})();

await test('tail truncation: unprotected tail long after the last checkpoint fails even without public logs', async () => {
  const r = await cli(['--key', real.pub], { bundle: truncated });
  assert.equal(r.code, EXIT.TAMPERED, r.out);
  assert.match(r.out, /unprotected tail: 100 event\(s\) after seq 200/);
});

// Make the truncated bundle look fresh (exported right after checkpoint 200) and cut the events
// after 200, so only the public log can catch it.
const cleanTruncated = (() => {
  const events = realEvents.slice(0, 200);
  const cps = realCps.slice(0, 2);
  return bundleOf(events, cps, real, exportAt);
})();

await test('tail truncation detected via Rekor (checkpoint 300 is public, bundle stops at 200)', async () => {
  const r = await cli(['--key', real.pub, '--rekor'], { bundle: cleanTruncated, rekor: publicLog });
  assert.equal(r.code, EXIT.TAMPERED, r.out);
  assert.match(r.out, /public log has checkpoint entry \d+ .* that this bundle does not contain — history after it was removed or rewritten/);
});

await test('tail truncation detected via the witness (seq 300 witnessed, bundle stops at 200)', async () => {
  const r = await cli(['--key', real.pub, '--witness', 'witness.jsonl'], { bundle: cleanTruncated, witness: witnessLog });
  assert.equal(r.code, EXIT.TAMPERED, r.out);
  assert.match(r.out, /checkpoint seq 300 .* that this bundle does not contain — history after it was removed or rewritten/);
});

await test('rewritten tail with checkpoint 300 deleted, re-signed by the real key at 260: caught by Rekor', async () => {
  const events = makeEvents(260, { tamperFrom: 250 });
  const cps = [checkpoint(events, 100, real), checkpoint(events, 200, real), checkpoint(events, 260, real, exportAt - 60_000)];
  const r = await cli(['--key', real.pub, '--rekor'], { bundle: bundleOf(events, cps, real, exportAt), rekor: publicLog });
  assert.equal(r.code, EXIT.TAMPERED, r.out);
  assert.match(r.out, /does not contain — history after it was removed or rewritten/);
});

await test('public entries published after the export are not held against the bundle', async () => {
  const later = makeEvents(400);
  const c400 = checkpoint(later, 400, real);
  const r = await cli(['--key', real.pub, '--rekor'], { bundle: good, rekor: [...publicLog, rekorEntry(c400, exportAt + 10 * 60_000)] });
  assert.equal(r.code, EXIT.INTACT, r.out);
  assert.match(r.out, /1 later public entry was published after the export/);
});

await test('unprotected tail within 5 minutes of the newest checkpoint is only a warning', async () => {
  const cps = [checkpoint(realEvents, 100, real), checkpoint(realEvents, 290, real)];
  const b = bundleOf(realEvents, cps, real, Date.parse(cps[1].createdAt) + 2 * 60_000);
  const r = await cli(['--key', real.pub], { bundle: b });
  assert.equal(r.code, EXIT.INTACT, r.out);
  assert.match(r.out, /^WARNING: unprotected tail: 10 event\(s\) after seq 290/m);
});

await test('bundle not starting at seq 1 fails unless --partial', async () => {
  const events = realEvents.slice(150);
  const b = bundleOf(events, [realCps[1], realCps[2]], real, exportAt);
  const r1 = await cli(['--key', real.pub], { bundle: b });
  assert.equal(r1.code, EXIT.TAMPERED, r1.out);
  assert.match(r1.out, /starts at seq 151, not at the beginning/);
  const r2 = await cli(['--key', real.pub, '--partial', '--rekor'], { bundle: b, rekor: publicLog });
  assert.equal(r2.code, EXIT.INTACT, r2.out);
  assert.match(r2.out, /tail checks are limited/);
});

await test('stripping genesisPrevHash does not turn a seq-1 bundle into a partial one', async () => {
  const b = { ...cleanTruncated, genesisPrevHash: null };
  const r = await cli(['--key', real.pub, '--rekor'], { bundle: b, rekor: publicLog });
  assert.equal(r.code, EXIT.TAMPERED, r.out);
});

await test('edited event inside the range fails', async () => {
  const events = realEvents.map((e) => ({ ...e }));
  events[49].action = 'document.delete';
  const r = await cli(['--key', real.pub], { bundle: bundleOf(events, realCps, real, exportAt) });
  assert.equal(r.code, EXIT.TAMPERED, r.out);
  assert.match(r.out, /seq 50: hash does not match/);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
