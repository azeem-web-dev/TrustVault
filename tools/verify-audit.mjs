#!/usr/bin/env node
// Offline verifier for a TrustVault audit bundle (Admin → Audit → Export).
//
//   node tools/verify-audit.mjs trustvault-audit-1-500.json [expected-public-key-base64] [--witness checkpoints.jsonl] [--rekor]
//
// Needs nothing but Node. It never talks to the TrustVault server or its
// database, so it is a check you can run without trusting either. It verifies:
//   1. every event's hash = SHA-256(prev_hash || canonical bytes of the event)
//   2. every event's prev_hash is the previous event's hash (no gaps,
//      insertions, reordering or deletions inside the range)
//   3. every signed checkpoint matches the chain at its seq, and its
//      Ed25519 signature is valid for the bundle's public key — and, if you
//      pass the key you recorded earlier, that it is the same key.
//   4. with --witness: every head recorded by the outside witness (the
//      `witness` branch, see tools/witness.mjs) that falls inside the bundle
//      matches the bundle's chain. The server cannot have rewritten history
//      after the witness saw it without failing this check.
//   5. with --rekor: looks up every checkpoint signed with the bundle's key
//      in Sigstore's public log (the only network call). Shows how many of
//      the bundle's checkpoints were published there and when. For a bundle
//      that starts at event 1, every entry published before the bundle's
//      newest published checkpoint must match the bundle's chain; one that
//      does not is a checkpoint of a history that has since been rewritten.
// Exit code 0 = intact, 1 = tampered or malformed.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkpointDigest, entriesForKey } from './rekor.mjs';

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

export function verifyBundle(bundle, expectedKey, witnessed = null) {
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
  let witnessMatched = 0;
  for (const w of witnessed ?? []) {
    const chainHash = hashes.get(String(w.seq));
    if (!chainHash) continue; // outside this bundle's range
    if (chainHash !== w.headHash) problems.push(`seq ${w.seq}: differs from the head the outside witness recorded at ${w.witnessedAt}`);
    else witnessMatched++;
  }
  return { ok: problems.length === 0, events: events.length, checkpoints: (bundle.checkpoints ?? []).length, witnessMatched, problems };
}

/**
 * Pure: compares a bundle (already checked by verifyBundle) with the public
 * log entries signed with its key. Returns { ok, anchored, latest, problems, unmatchedOutside }.
 */
export function rekorReport(bundle, entries) {
  const problems = [];
  const candidates = new Map();
  for (const e of bundle.events ?? []) candidates.set(checkpointDigest({ seq: e.seq, headHash: e.hash }), String(e.seq));
  const matched = entries.filter((e) => candidates.has(e.digest));
  const latest = matched.reduce((a, e) => (!a || e.logIndex > a.logIndex ? e : a), null);
  const checkpointDigests = new Set((bundle.checkpoints ?? []).map((c) => checkpointDigest(c)));
  const anchored = matched.filter((e) => checkpointDigests.has(e.digest)).length;
  let unmatchedOutside = 0;
  if (latest) {
    for (const e of entries) {
      if (e.logIndex >= latest.logIndex || candidates.has(e.digest)) continue;
      // Anchoring is in chain order, so this entry is for an earlier seq.
      if (bundle.genesisPrevHash) problems.push(`public log entry ${e.logIndex} (anchored ${e.integratedTime}) matches no event in this bundle: it is a checkpoint of a different history`);
      else unmatchedOutside++;
    }
  }
  return {
    ok: problems.length === 0,
    anchored,
    latest: latest ? { seq: candidates.get(latest.digest), logIndex: latest.logIndex, integratedTime: latest.integratedTime } : null,
    problems,
    unmatchedOutside,
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('verify-audit.mjs')) {
  const args = process.argv.slice(2);
  const ri = args.indexOf('--rekor');
  const useRekor = ri >= 0;
  if (useRekor) args.splice(ri, 1);
  const wi = args.indexOf('--witness');
  const witnessFile = wi >= 0 ? args.splice(wi, 2)[1] : null;
  const [file, expectedKey] = args;
  if (!file || (wi >= 0 && !witnessFile)) {
    console.error('usage: node tools/verify-audit.mjs <bundle.json> [expected-public-key-base64] [--witness checkpoints.jsonl] [--rekor]');
    process.exit(2);
  }
  const witnessed = witnessFile
    ? readFileSync(witnessFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    : null;
  const bundle = JSON.parse(readFileSync(file, 'utf8'));
  const result = verifyBundle(bundle, expectedKey, witnessed);
  let rekorLine = '';
  if (useRekor && bundle.signingKey?.publicKey) {
    const { entries, invalid } = await entriesForKey(expectedKey ?? bundle.signingKey.publicKey);
    const r = rekorReport(bundle, entries);
    result.problems.push(...r.problems, ...invalid.map((u) => `public log entry ${u} has an invalid receipt`));
    result.ok = result.problems.length === 0;
    rekorLine = r.latest
      ? ` ${r.anchored} of the bundle's checkpoints are in Sigstore's public log; the newest, seq ${r.latest.seq}, was published at ${r.latest.integratedTime} (log index ${r.latest.logIndex}).`
      : ' None of this bundle is in the Sigstore public log yet.';
    if (r.unmatchedOutside) rekorLine += ` ${r.unmatchedOutside} earlier public entries fall before this bundle's range and were not checked.`;
  }
  if (result.ok) {
    const w = witnessed ? `, and ${result.witnessMatched} head(s) recorded by the outside witness match` : '';
    console.log(`INTACT: ${result.events} events and ${result.checkpoints} signed checkpoints verified${w}.${rekorLine}`);
    process.exit(0);
  }
  console.log(`TAMPERED: ${result.problems.length} problem(s)`);
  for (const p of result.problems) console.log(` - ${p}`);
  process.exit(1);
}
