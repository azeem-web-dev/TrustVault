#!/usr/bin/env node
// Standalone tests for tools/reconcile-ledger.mjs. No network, no dependencies:
//   node tools/reconcile-ledger.test.mjs

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { entryHash, reconcile, run, verifyChain, ZERO } from './reconcile-ledger.mjs';

const T0 = Date.parse('2026-11-01T00:00:00Z');
const DOC = '11111111-1111-4111-8111-111111111111';
const VER = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Builds a valid ledger from partial entries (seq, ts, prev, hash filled in). */
function ledger(parts) {
  let prev = ZERO;
  return parts.map((p, i) => {
    const e = { seq: i + 1, ts: T0 + i * 1000, event: 'unwrap', action: null, tid: null, user: null, doc: null, ver: null, audit_id: null, audit_seq: null, key_id: null, aad_sha256: null, result: 'ok', detail: null, ...p, prev };
    e.hash = entryHash(prev, e);
    prev = e.hash;
    return e;
  });
}

const download = (n, seq, extra = {}) => ({ event: 'unwrap', action: 'download', tid: uuid(100 + n), user: USER, doc: DOC, ver: VER, audit_id: uuid(n), audit_seq: seq, key_id: 'keyd-g1-blob', result: 'ok', ...extra });
const event = (n, seq, extra = {}) => ({ seq: String(seq), id: uuid(n), occurred_at: new Date(T0 + n * 1000 - 500).toISOString(), actor_id: USER, action: 'document.download', outcome: 'ALLOWED', document_id: DOC, ...extra });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function scenario() {
  const entries = ledger([{ event: 'start', detail: 'boot' }, download(1, 10), download(2, 11), { event: 'start' }, ...Array.from({ length: 5 }, () => ({ event: 'start' }))]);
  // Spread the tail out so both events fall inside the checked window.
  entries.forEach((e, i) => { if (i >= 3) e.ts = T0 + 600_000 + i; });
  let prev = ZERO;
  for (const e of entries) { e.prev = prev; e.hash = entryHash(prev, e); prev = e.hash; }
  return { entries, bundle: { events: [event(1, 10), event(2, 11), event(3, 12, { action: 'document.view' })] } };
}

test('a consistent ledger and bundle reconcile', () => {
  const { entries, bundle } = scenario();
  const r = reconcile(entries, bundle);
  assert.deepEqual(r.findings, []);
  assert.equal(r.stats.unwraps, 2);
});

test('an edited ledger entry breaks the chain', () => {
  const { entries } = scenario();
  entries[1].user = uuid(999);
  assert.match(verifyChain(entries), /hash mismatch/);
  const { entries: e2 } = scenario();
  e2.splice(1, 1);
  assert.match(verifyChain(e2), /seq jumps/);
});

test('a key release with no matching audit event is critical', () => {
  const { entries, bundle } = scenario();
  bundle.events = bundle.events.filter((e) => e.seq !== '11');
  bundle.events.push(event(9, 11)); // seq 11 exists but is another event
  const r = reconcile(entries, bundle);
  assert.ok(r.findings.some((f) => f.kind === 'release_without_audit' && /no such audit event/.test(f.message)));
});

test('a release attributed to another user or document is critical', () => {
  const { entries, bundle } = scenario();
  bundle.events[0].actor_id = uuid(77);
  bundle.events[1].document_id = uuid(78);
  const kinds = reconcile(entries, bundle).findings.map((f) => f.message);
  assert.ok(kinds.some((m) => /audit user differs/.test(m)));
  assert.ok(kinds.some((m) => /audit document differs/.test(m)));
});

test('an ALLOWED download without any key release is critical', () => {
  const { entries, bundle } = scenario();
  bundle.events.push(event(4, 13));
  const r = reconcile(entries, bundle);
  assert.deepEqual(r.findings.map((f) => f.kind), ['release_without_key_service']);
});

test('forged-ticket probes and double releases are critical', () => {
  const entries = ledger([{ event: 'start' }, { event: 'refuse', result: 'bad ticket mac' }, download(1, 10), download(1, 10)]);
  const kinds = reconcile(entries, { events: [event(1, 10)] }).findings.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['keyd_probe', 'ticket_used_twice']);
});

test('a published head that no longer matches means the ledger was rewritten', () => {
  const { entries, bundle } = scenario();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
  const head = (seq, hash) => ({ epoch: entries[0].hash, seq: String(seq), headHash: hash, signature: sign(null, Buffer.from(`tv-unwrap-ledger-v1|${seq}|${hash}`), privateKey).toString('base64') });
  assert.deepEqual(reconcile(entries, bundle, [head(3, entries[2].hash)], key).findings, []);
  const rewritten = reconcile(entries, bundle, [head(3, 'f'.repeat(64))], key).findings.map((f) => f.kind);
  assert.deepEqual(rewritten, ['ledger_rewritten']);
  const truncated = reconcile(entries.slice(0, 2), bundle, [head(3, entries[2].hash)], key).findings.map((f) => f.kind);
  assert.ok(truncated.includes('ledger_truncated'));
  const badSig = { ...head(3, entries[2].hash), signature: head(2, entries[1].hash).signature };
  assert.ok(reconcile(entries, bundle, [badSig], key).findings.some((f) => f.kind === 'head_signature'));
});

test('the command line: exit codes', () => {
  const { entries, bundle } = scenario();
  const files = { 'l.jsonl': entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'b.json': JSON.stringify(bundle) };
  const lines = [];
  assert.equal(run(['--ledger', 'l.jsonl', '--audit', 'b.json'], (p) => files[p], (l) => lines.push(l)), 0);
  assert.equal(run(['--ledger', 'l.jsonl'], (p) => files[p], () => {}), 2);
  files['b.json'] = JSON.stringify({ events: [event(1, 10)] });
  assert.equal(run(['--ledger', 'l.jsonl', '--audit', 'b.json'], (p) => files[p], () => {}), 0, 'seq 11 outside the bundle is not a finding');
  files['l.jsonl'] = files['l.jsonl'].replace(USER, uuid(5));
  assert.equal(run(['--ledger', 'l.jsonl', '--audit', 'b.json'], (p) => files[p], () => {}), 1);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}
console.log(`\n${tests.length - failed} passed${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
