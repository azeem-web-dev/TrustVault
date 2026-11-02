#!/usr/bin/env node
// Do the two verifiers agree?
//
//   node tools/independent-verify/agreement.test.mjs
//
// Builds valid and tampered audit bundles (throwaway Ed25519 keys, a fake
// public log) and runs each through BOTH tools/verify-audit.mjs (Node, the
// project's verifier) and tools/independent-verify/verify.py (Python,
// written only from docs/VERIFY.md). Every case states the exit code it
// expects; the test fails if either verifier disagrees with it. The Python
// verifier runs twice when `cryptography` is installed: once with it and
// once with its built-in pure-Python Ed25519 (TV_VERIFY_PURE=1).
//
// Needs python3 (or set PYTHON). No network, no database.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkpointDigest } from '../rekor.mjs';
import { checkpointMessage, eventHash, run } from '../verify-audit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PY_VERIFIER = join(HERE, 'verify.py');
const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const ZERO = '0'.repeat(64);
const T0 = Date.parse('2026-11-01T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64'), priv: privateKey };
}

const ACTORS = ['owner@example.com', 'zoë@example.com', null, 'system'];
/** n events, a mix of nulls, empty strings, non-ASCII text and JSON details, as the database produces them. */
function makeEvents(n, { startSeq = 1, prevHash = ZERO, mutate = null } = {}) {
  const events = [];
  let prev = prevHash;
  for (let s = startSeq; s < startSeq + n; s++) {
    const e = {
      seq: String(s), id: `00000000-0000-4000-8000-${String(s).padStart(12, '0')}`,
      occurred_at: iso(T0 + s * 1000).replace(/\.(\d{3})Z$/, '.$1123Z'),
      actor_id: s % 4 === 2 ? null : `11111111-1111-4111-8111-${String(s % 7).padStart(12, '0')}`,
      actor_email: ACTORS[s % ACTORS.length], action: s % 3 ? 'document.download' : 'access.grant',
      outcome: s % 5 ? 'ALLOWED' : 'DENIED', reason: s % 5 ? null : 'no_permission — refusé',
      target_type: 'document', target_id: null, document_id: `22222222-2222-4222-8222-${String(s % 3).padStart(12, '0')}`,
      ip: s % 6 ? '203.0.113.9' : null, user_agent: s % 2 ? 'Mozilla/5.0 (X11; Linux x86_64)' : '',
      request_id: `req-${s}`, details: s % 2 ? `{"title": "Plan ${s}", "sizeBytes": ${s * 10}}` : null, prev_hash: prev,
    };
    if (mutate) mutate(e);
    e.hash = eventHash(e);
    prev = e.hash;
    events.push(e);
  }
  return events;
}

function checkpoint(events, seq, key, createdAt) {
  const headHash = events.find((e) => e.seq === String(seq)).hash;
  const c = { seq: String(seq), headHash, keyId: 'test-ed25519' };
  c.signature = sign(null, checkpointMessage(c), key.priv).toString('base64');
  c.createdAt = iso(createdAt ?? T0 + seq * 1000 + 30_000);
  return c;
}

const bundleOf = (events, checkpoints, key, exportedAt) => ({
  format: 'trustvault-audit-bundle-v1', exportedAt: iso(exportedAt),
  genesisPrevHash: events[0]?.prev_hash === ZERO ? ZERO : null, events, checkpoints,
  signingKey: { keyId: 'test-ed25519', publicKey: key.pub, algorithm: 'Ed25519' },
});

let logIndex = 5000;
const rekorEntry = (c, at) => ({ uuid: `u${logIndex}`, logIndex: logIndex++, integratedTime: iso(at), digest: checkpointDigest(c) });
const witnessRecord = (c, at) => ({ seq: c.seq, headHash: c.headHash, signature: c.signature, keyId: c.keyId, createdAt: c.createdAt, witnessedAt: iso(at) });
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---- fixtures ------------------------------------------------------------
const real = keypair();
const other = keypair();
const events = makeEvents(120);
const cps = [40, 80, 120].map((s) => checkpoint(events, s, real));
const publicLog = cps.map((c) => rekorEntry(c, Date.parse(c.createdAt) + 60_000));
const witnessLog = cps.map((c) => witnessRecord(c, Date.parse(c.createdAt) + 120_000));
const exportAt = Date.parse(cps[2].createdAt) + 30 * 60_000;
const good = bundleOf(events, cps, real, exportAt);

/** Each case: name, bundle, args (same for both tools), expected exit code. */
const cases = [];
const add = (name, bundle, args, expected, extra = {}) => cases.push({ name, bundle, args, expected, ...extra });

add('valid bundle, pinned key', good, ['--key', real.pub], 0);
add('valid bundle, pinned key + witness + public log', good, ['--key', real.pub, '--witness', '@witness', '--rekor'], 0, { witness: witnessLog, rekor: publicLog });
add('valid bundle, nothing pinned: consistent only', good, [], 2);
add('valid bundle, --self-consistency-only', good, ['--self-consistency-only'], 0);
add('valid bundle, wrong pinned key', good, ['--key', other.pub], 1);

{ const b = clone(good); b.events[50].actor_email = 'someone-else@example.com'; add('one field edited, hashes not recomputed', b, ['--key', real.pub], 1); }
{ const b = clone(good); b.events[33].reason = ''; add('NULL changed to empty string', b, ['--key', real.pub], 1); }
{ const b = clone(good); const e = b.events[10]; e.action = e.action + e.outcome[0]; e.outcome = e.outcome.slice(1); add('characters shifted between adjacent fields', b, ['--key', real.pub], 1); }
{ const b = clone(good); b.events.splice(60, 1); add('one event deleted from the middle', b, ['--key', real.pub], 1); }
{ const b = clone(good); [b.events[20], b.events[21]] = [b.events[21], b.events[20]]; add('two events swapped', b, ['--key', real.pub], 1); }
{ const b = clone(good); const s = Buffer.from(b.checkpoints[1].signature, 'base64'); s[5] ^= 1; b.checkpoints[1].signature = s.toString('base64'); add('checkpoint signature flipped', b, ['--key', real.pub], 1); }
{ const b = clone(good); b.checkpoints = []; add('no checkpoints', b, ['--key', real.pub], 1); }
{ const b = clone(good); b.format = 'something-else'; add('unknown format', b, ['--key', real.pub], 1); }
{ const b = clone(good); b.exportedAt = 'yesterday'; add('invalid exportedAt', b, ['--key', real.pub], 1); }

{ // Whole chain rewritten from seq 70 and re-signed with an attacker key.
  const forged = makeEvents(120, { mutate: (e) => { if (Number(e.seq) >= 70) e.action = 'document.view'; } });
  const b = bundleOf(forged, [40, 80, 120].map((s) => checkpoint(forged, s, other)), other, exportAt);
  add('recomputed chain signed by another key, real key pinned', b, ['--key', real.pub], 1);
  add('recomputed chain signed by another key, nothing pinned (looks consistent!)', b, [], 2);
}
{ // Rewritten and re-signed with the REAL key (root on the server): only outside records catch it.
  const forged = makeEvents(120, { mutate: (e) => { if (Number(e.seq) >= 70) e.action = 'document.view'; } });
  const b = bundleOf(forged, [40, 80, 120].map((s) => checkpoint(forged, s, real)), real, exportAt);
  add('chain rewritten and re-signed with the real key, key only (not detectable this way)', b, ['--key', real.pub], 0);
  add('chain rewritten and re-signed with the real key, with witness', b, ['--key', real.pub, '--witness', '@witness'], 1, { witness: witnessLog });
  add('chain rewritten and re-signed with the real key, with public log', b, ['--key', real.pub, '--rekor'], 1, { rekor: publicLog });
}
{ // Tail cut after checkpoint 80 (events 81..120 and checkpoint 120 removed).
  const b = bundleOf(events.slice(0, 80), cps.slice(0, 2), real, exportAt);
  add('tail cut off, key only (not detectable this way)', b, ['--key', real.pub], 0);
  add('tail cut off, with witness', b, ['--key', real.pub, '--witness', '@witness'], 1, { witness: witnessLog });
  add('tail cut off, with public log', b, ['--key', real.pub, '--rekor'], 1, { rekor: publicLog });
}
{ // Events after the newest checkpoint.
  const more = makeEvents(130);
  const c = [40, 80, 120].map((s) => checkpoint(more, s, real));
  add('unsigned tail, exported 2 minutes after the checkpoint', bundleOf(more, c, real, Date.parse(c[2].createdAt) + 120_000), ['--key', real.pub], 0);
  add('unsigned tail, exported an hour after the checkpoint', bundleOf(more, c, real, Date.parse(c[2].createdAt) + 3_600_000), ['--key', real.pub], 1);
}
{ // A partial range.
  const part = clone(good); part.events = part.events.slice(30); part.checkpoints = part.checkpoints.slice(1); part.genesisPrevHash = null;
  add('partial range without --partial', part, ['--key', real.pub], 1);
  add('partial range with --partial', part, ['--key', real.pub, '--partial'], 0);
  const lying = clone(part); lying.genesisPrevHash = ZERO;
  add('partial range claiming to start at genesis', lying, ['--key', real.pub, '--partial'], 1);
}
{ const b = clone(good); b.checkpoints[0].headHash = b.events[38].hash; add('checkpoint does not match the chain at its seq', b, ['--key', real.pub], 1); }
{ const b = clone(good); b.checkpoints.splice(1, 1); add('a checkpoint removed, with witness', b, ['--key', real.pub, '--witness', '@witness'], 1, { witness: witnessLog }); }

// ---- runners -------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'tv-agree-'));

async function runNode(c) {
  const files = { 'bundle.json': JSON.stringify(c.bundle), '@witness': (c.witness ?? []).map((w) => JSON.stringify(w)).join('\n') + '\n' };
  const out = [];
  const code = await run(['bundle.json', ...c.args], {
    readFile: (p) => files[p], entriesForKey: async () => ({ entries: c.rekor ?? [], invalid: [] }),
    out: (l) => out.push(l), err: (l) => out.push(l), now: () => Date.parse(c.bundle.exportedAt) || Date.now(),
  });
  return { code, out: out.join('\n') };
}

function runPython(c, pure) {
  const bundleFile = join(dir, 'bundle.json');
  writeFileSync(bundleFile, JSON.stringify(c.bundle));
  const args = [];
  for (let i = 0; i < c.args.length; i++) {
    const a = c.args[i];
    if (a === '@witness') { const f = join(dir, 'witness.jsonl'); writeFileSync(f, (c.witness ?? []).map((w) => JSON.stringify(w)).join('\n') + '\n'); args.push(f); }
    else if (a === '--rekor') { const f = join(dir, 'rekor.json'); writeFileSync(f, JSON.stringify(c.rekor ?? [])); args.push('--rekor-entries', f); }
    else args.push(a);
  }
  const r = spawnSync(PYTHON, ['-I', PY_VERIFIER, bundleFile, ...args], { env: { ...process.env, TV_VERIFY_PURE: pure ? '1' : '0' }, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

let hasCryptography = false;
try { execFileSync(PYTHON, ['-I', '-c', 'import cryptography'], { stdio: 'ignore' }); hasCryptography = true; } catch { /* pure only */ }
const pythonModes = hasCryptography ? [false, true] : [true];

let failed = 0;
for (const c of cases) {
  const node = await runNode(c);
  const results = [`node=${node.code}`];
  let ok = node.code === c.expected;
  for (const pure of pythonModes) {
    const py = runPython(c, pure);
    results.push(`python${pure ? '(pure)' : ''}=${py.code}`);
    if (py.code !== c.expected) { ok = false; console.log(py.out); }
  }
  if (!ok) { failed++; console.log(node.out); }
  console.log(`${ok ? 'ok  ' : 'FAIL'} expect ${c.expected}: ${results.join(' ')}  ${c.name}`);
}

// A real Sigstore Rekor receipt (saved from the public log) must verify in both crypto modes; a modified one must not.
{
  const saved = JSON.parse(readFileSync(join(HERE, 'testdata', 'rekor-entry.json'), 'utf8'));
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(HERE)})
import verify as v
d = json.load(open(${JSON.stringify(join(HERE, 'testdata', 'rekor-entry.json'))}))
(u, e), = d.items()
good = v.parse_rekor_entry(u, e, v.PRODUCTION_KEY)
bad = v.parse_rekor_entry(u, dict(e, logIndex=e['logIndex'] + 1), v.PRODUCTION_KEY)
print('ok' if good and bad is None else 'bad')`;
  for (const pure of pythonModes) {
    const r = spawnSync(PYTHON, ['-I', '-c', script], { env: { ...process.env, TV_VERIFY_PURE: pure ? '1' : '0' }, encoding: 'utf8' });
    const ok = r.stdout.trim() === 'ok';
    if (!ok) { failed++; console.log(r.stdout, r.stderr); }
    console.log(`${ok ? 'ok  ' : 'FAIL'} real Rekor receipt (log index ${Object.values(saved)[0].logIndex}) verifies, a modified one does not${pure ? ' (pure Python ECDSA)' : ''}`);
  }
}

rmSync(dir, { recursive: true, force: true });
assert.equal(failed, 0, `${failed} case(s) disagree`);
console.log(`\n${cases.length} bundles: both verifiers agree on every case (python modes: ${pythonModes.map((p) => (p ? 'pure' : 'cryptography')).join(', ')}).`);
