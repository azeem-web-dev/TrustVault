#!/usr/bin/env node
// Offline verifier for a TrustVault audit bundle (Admin → Audit → Export).
//
//   node tools/verify-audit.mjs trustvault-audit-1-500.json [expected-public-key-base64]
//
// Needs nothing but Node. It does not talk to the server or the database,
// so it is a check you can run without trusting either. It verifies:
//   1. every event's hash = SHA-256(prev_hash || canonical bytes of the event)
//   2. every event's prev_hash is the previous event's hash (no gaps,
//      insertions, reordering or deletions inside the range)
//   3. every signed checkpoint matches the chain at its seq, and its
//      Ed25519 signature is valid for the bundle's public key — and, if you
//      pass the key you recorded earlier, that it is the same key.
// Exit code 0 = intact, 1 = tampered or malformed.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Same encoding as audit_field() in the database: NULL -> "~", value -> "<utf8 bytes>:<value>". */
const field = (v) => (v === null || v === undefined ? '~' : `${Buffer.byteLength(String(v), 'utf8')}:${v}`);

export function canonical(e) {
  return Buffer.from(
    field('tv-audit-v1') + field(e.seq) + field(e.id) + field(e.occurred_at) + field(e.actor_id) + field(e.actor_email) +
      field(e.action) + field(e.outcome) + field(e.reason) + field(e.target_type) + field(e.target_id) + field(e.document_id) +
      field(e.ip) + field(e.user_agent) + field(e.request_id) + field(e.details),
    'utf8',
  );
}

export function verifyBundle(bundle, expectedKey) {
  const problems = [];
  if (bundle.format !== 'trustvault-audit-bundle-v1') problems.push('unknown bundle format');
  const events = bundle.events ?? [];
  if (events.length === 0) problems.push('bundle has no events');

  let prev = bundle.genesisPrevHash ?? null;
  const hashes = new Map();
  for (const e of events) {
    if (prev !== null && e.prev_hash !== prev) problems.push(`seq ${e.seq}: prev_hash does not link to the previous event`);
    const expected = createHash('sha256').update(Buffer.from(e.prev_hash, 'hex')).update(canonical(e)).digest('hex');
    if (expected !== e.hash) problems.push(`seq ${e.seq}: hash does not match its contents`);
    hashes.set(String(e.seq), e.hash);
    prev = e.hash;
  }

  const key = bundle.signingKey?.publicKey;
  if (expectedKey && key !== expectedKey) problems.push('signing key differs from the one you expected');
  let pub = null;
  try {
    pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(key, 'base64')]), format: 'der', type: 'spki' });
  } catch {
    problems.push('invalid signing key');
  }
  for (const c of bundle.checkpoints ?? []) {
    const chainHash = hashes.get(String(c.seq));
    if (chainHash && chainHash !== c.headHash) problems.push(`checkpoint ${c.seq}: does not match the chain`);
    const msg = Buffer.from(`tv-checkpoint-v1|${c.seq}|${c.headHash}`, 'utf8');
    if (pub && !verify(null, msg, pub, Buffer.from(c.signature, 'base64'))) problems.push(`checkpoint ${c.seq}: bad signature`);
  }
  return { ok: problems.length === 0, events: events.length, checkpoints: (bundle.checkpoints ?? []).length, problems };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('verify-audit.mjs')) {
  const [file, expectedKey] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node tools/verify-audit.mjs <bundle.json> [expected-public-key-base64]');
    process.exit(2);
  }
  const result = verifyBundle(JSON.parse(readFileSync(file, 'utf8')), expectedKey);
  if (result.ok) {
    console.log(`INTACT: ${result.events} events and ${result.checkpoints} signed checkpoints verified.`);
    process.exit(0);
  }
  console.log(`TAMPERED: ${result.problems.length} problem(s)`);
  for (const p of result.problems) console.log(` - ${p}`);
  process.exit(1);
}
