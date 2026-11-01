#!/usr/bin/env node
// Outside witness for the TrustVault audit chain.
//
//   node tools/witness.mjs --url https://vault.rayyanazeem.cloud --dir <witness-folder>
//
// Signed checkpoints prove the audit chain has not changed, but they are
// stored on the same server as the chain. Someone with root there could
// rewrite the database and have the key service sign a new, forged head.
// This tool keeps a copy of every checkpoint somewhere that server cannot
// touch: GitHub Actions runs it on a schedule and commits the result to the
// protected `witness` branch of the public repository.
//
// Each run it:
//   1. checks the server still signs with the key pinned in signing-key.json
//   2. checks every checkpoint it witnessed before is still on the server,
//      byte for byte (none removed, none changed, none slipped in earlier)
//   3. checks the chain's current hash at the last witnessed checkpoint is
//      still the witnessed hash (each hash commits to every event before it,
//      so any rewrite of older history changes it)
//   4. verifies the signature of every new checkpoint and appends it.
// If anything fails it writes nothing and exits 1, so the workflow fails
// and GitHub emails the repository owner.
//
// The witnessed heads are also checked against exported evidence bundles:
//   node tools/verify-audit.mjs bundle.json --witness <witness-folder>/checkpoints.jsonl

import { createPublicKey, verify } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function checkpointValid(c, publicKeyB64) {
  try {
    const pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyB64, 'base64')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(`tv-checkpoint-v1|${c.seq}|${c.headHash}`, 'utf8'), pub, Buffer.from(c.signature, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Pure decision. `log`: entries witnessed so far, oldest first. `pinnedKey`:
 * base64 public key or null (first run). `server`: { signingKey, checkpoints
 * (all of them, oldest first), eventHashAtLast (current chain hash at the
 * last witnessed seq, or null) }.
 * Returns { ok, problems, newEntries }.
 */
export function witness(log, pinnedKey, server, now = new Date()) {
  const problems = [];
  const key = server.signingKey?.publicKey;
  if (!key) problems.push('server did not report a signing key');
  else if (pinnedKey && key !== pinnedKey) problems.push('server signing key changed from the pinned key');

  const onServer = new Map(server.checkpoints.map((c) => [String(c.seq), c]));
  for (const w of log) {
    const s = onServer.get(String(w.seq));
    if (!s) problems.push(`checkpoint ${w.seq} was witnessed but is gone from the server`);
    else if (s.headHash !== w.headHash || s.signature !== w.signature) problems.push(`checkpoint ${w.seq} changed since it was witnessed`);
  }

  const last = log.at(-1);
  const lastSeq = last ? BigInt(last.seq) : 0n;
  if (last && server.eventHashAtLast !== last.headHash) {
    problems.push(`the chain's hash at seq ${last.seq} is no longer the witnessed hash: history before it was rewritten`);
  }
  const witnessed = new Set(log.map((w) => String(w.seq)));
  for (const c of server.checkpoints) {
    if (BigInt(c.seq) < lastSeq && !witnessed.has(String(c.seq))) problems.push(`checkpoint ${c.seq} appeared after later checkpoints were witnessed`);
  }

  const newEntries = [];
  let prev = lastSeq;
  for (const c of server.checkpoints) {
    const seq = BigInt(c.seq);
    if (seq <= lastSeq) continue;
    if (seq <= prev) { problems.push(`checkpoint ${c.seq} is out of order`); continue; }
    if (!/^[0-9a-f]{64}$/.test(c.headHash) || !key || !checkpointValid(c, pinnedKey ?? key)) { problems.push(`checkpoint ${c.seq} has a bad signature`); continue; }
    prev = seq;
    newEntries.push({ seq: String(c.seq), headHash: c.headHash, signature: c.signature, keyId: c.keyId, createdAt: c.createdAt, witnessedAt: now.toISOString() });
  }
  return { ok: problems.length === 0, problems, newEntries };
}

export function readLog(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'trustvault-witness' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/** Every checkpoint on the server, plus the chain hash at `anchorSeq`. */
export async function fetchServer(base, anchorSeq) {
  const checkpoints = [];
  let signingKey = null;
  let since = 1n;
  for (;;) {
    const page = await getJson(`${base}/api/witness/checkpoints?since=${since}&limit=1000`);
    if (page.format !== 'trustvault-witness-v1') throw new Error('unexpected response format');
    signingKey = page.signingKey;
    checkpoints.push(...page.checkpoints);
    if (!page.hasMore || page.checkpoints.length === 0) break;
    since = BigInt(page.checkpoints.at(-1).seq) + 1n;
  }
  let eventHashAtLast = null;
  if (anchorSeq) eventHashAtLast = (await getJson(`${base}/api/witness/checkpoints?since=${anchorSeq}&limit=1`)).eventHashAtSince;
  return { signingKey, checkpoints, eventHashAtLast };
}

async function main() {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const base = arg('--url')?.replace(/\/+$/, '');
  const dir = arg('--dir');
  if (!base || !dir || !base.startsWith('https://')) {
    console.error('usage: node tools/witness.mjs --url https://<host> --dir <witness-folder>');
    process.exit(2);
  }
  const logFile = join(dir, 'checkpoints.jsonl');
  const keyFile = join(dir, 'signing-key.json');
  const log = readLog(logFile);
  const pinned = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, 'utf8')).publicKey : null;

  const server = await fetchServer(base, log.at(-1)?.seq);
  const result = witness(log, pinned, server);
  if (!result.ok) {
    console.log(`WITNESS ALARM: ${result.problems.length} problem(s). Nothing was recorded.`);
    for (const p of result.problems) console.log(` - ${p}`);
    process.exit(1);
  }
  if (!pinned) {
    writeFileSync(keyFile, JSON.stringify({ ...server.signingKey, pinnedAt: new Date().toISOString() }, null, 2) + '\n');
    console.log(`pinned signing key ${server.signingKey.keyId}`);
  }
  if (result.newEntries.length) appendFileSync(logFile, result.newEntries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.log(`OK: ${log.length} earlier checkpoints still match; ${result.newEntries.length} new checkpoint(s) witnessed.`);
}

if (process.argv[1]?.endsWith('witness.mjs')) {
  main().catch((err) => { console.error(`witness failed: ${err.message}`); process.exit(1); });
}
