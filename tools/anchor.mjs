#!/usr/bin/env node
// Puts every signed audit checkpoint into Sigstore's public transparency log.
//
//   node tools/anchor.mjs --source http://127.0.0.1:4000 --state /var/lib/trustvault-anchor
//
// Runs on the TrustVault server every minute (trustvault-anchor.timer). It
// is deliberately separate from the API: the API is the internet-facing
// process and has no outbound network access at all; this one has outbound
// access but no database password, no key service access and no open port.
// It only reads the public checkpoint list on localhost and submits new
// checkpoints to Rekor (see tools/rekor.mjs).
//
// Why: checkpoints are signed every minute, but until they leave this
// server, someone with root here could rewrite recent history and re-sign
// it. Once a checkpoint is in Rekor it cannot be withdrawn, and anyone can
// later compare the chain against it (tools/witness.mjs, verify-audit.mjs).
//
// State directory:
//   signing-key.json   the audit signing key, pinned on the first run
//   anchored.jsonl     one line per anchored checkpoint: seq, Rekor log index, uuid, time
// A checkpoint is recorded only after Rekor's signed receipt for exactly
// that checkpoint has been verified. Any problem: exit 1, retry next minute.

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkpointValid, readLog } from './witness.mjs';
import { REKOR_URL, submit } from './rekor.mjs';

/**
 * Pure decision: which checkpoints to submit. `server` is a page of the
 * witness endpoint. Returns { problems, todo }.
 */
export function plan(pinnedKey, lastSeq, server, max = 100) {
  const problems = [];
  const key = server.signingKey?.publicKey;
  if (!key) problems.push('the server reported no signing key');
  else if (pinnedKey && key !== pinnedKey) problems.push('the server signing key changed from the pinned key; refusing to anchor');
  const todo = [];
  let prev = lastSeq;
  for (const c of server.checkpoints ?? []) {
    const seq = BigInt(c.seq);
    if (seq <= lastSeq) continue;
    if (seq <= prev) { problems.push(`checkpoint ${c.seq} is out of order`); break; }
    if (!key || !checkpointValid(c, pinnedKey ?? key)) { problems.push(`checkpoint ${c.seq} has a bad signature; refusing to anchor it`); break; }
    prev = seq;
    todo.push(c);
    if (todo.length >= max) break;
  }
  return { problems, todo };
}

/** One run. Returns { anchored: [...], problems: [...] }. */
export async function anchorOnce({ source, stateDir, rekorUrl = REKOR_URL, rekorKey, fetchImpl = fetch, max = 100 }) {
  const keyFile = join(stateDir, 'signing-key.json');
  const logFile = join(stateDir, 'anchored.jsonl');
  const pinned = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, 'utf8')).publicKey : null;
  const done = readLog(logFile);
  const lastSeq = done.length ? BigInt(done.at(-1).seq) : 0n;

  const res = await fetchImpl(`${source}/api/witness/checkpoints?since=${lastSeq + 1n}&limit=${Math.min(max, 1000)}`, {
    headers: { accept: 'application/json', 'user-agent': 'trustvault-anchor' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`the checkpoint list answered ${res.status}`);
  const server = await res.json();
  if (server.format !== 'trustvault-witness-v1') throw new Error('unexpected checkpoint list format');

  const { problems, todo } = plan(pinned, lastSeq, server, max);
  if (problems.length) return { anchored: [], problems };
  if (!pinned) {
    const tmp = `${keyFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...server.signingKey, pinnedAt: new Date().toISOString() }, null, 2) + '\n');
    renameSync(tmp, keyFile);
  }
  const key = pinned ?? server.signingKey.publicKey;
  const anchored = [];
  for (const c of todo) {
    // In order, one at a time: a failure leaves the rest for the next run,
    // so the log's order always follows the chain's order.
    const r = await submit(c, key, { url: rekorUrl, rekorKey, fetchImpl });
    const line = { seq: String(c.seq), headHash: c.headHash, logIndex: r.logIndex, uuid: r.uuid, integratedTime: r.integratedTime };
    appendFileSync(logFile, JSON.stringify(line) + '\n');
    anchored.push(line);
  }
  return { anchored, problems: [] };
}

async function main() {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const source = arg('--source')?.replace(/\/+$/, '');
  const stateDir = arg('--state');
  const rekorUrl = arg('--rekor') ?? REKOR_URL;
  if (!source || !stateDir) {
    console.error('usage: node tools/anchor.mjs --source http://127.0.0.1:<port> --state <dir> [--rekor https://rekor.sigstore.dev]');
    process.exit(2);
  }
  const { anchored, problems } = await anchorOnce({ source, stateDir, rekorUrl });
  if (problems.length) {
    console.log(`ANCHOR ALARM: ${problems.length} problem(s); nothing was submitted.`);
    for (const p of problems) console.log(` - ${p}`);
    process.exit(1);
  }
  for (const a of anchored) console.log(`anchored checkpoint ${a.seq} as Rekor log index ${a.logIndex}`);
  if (!anchored.length) console.log('nothing new to anchor');
}

if (process.argv[1]?.endsWith('anchor.mjs')) {
  main().catch((err) => { console.error(`anchor failed: ${err.message}`); process.exit(1); });
}
