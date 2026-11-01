// Sigstore Rekor helpers shared by tools/anchor.mjs, tools/witness.mjs and
// tools/verify-audit.mjs. Plain Node, no dependencies.
//
// Rekor (https://rekor.sigstore.dev) is a public, append-only transparency
// log run by the Sigstore project. Once an entry is in it, nobody — not us,
// not someone with root on our server — can remove or change it, and
// anyone can look it up.
//
// Each TrustVault checkpoint goes in as a `rekord` entry: the signed
// message `tv-checkpoint-v1|<seq>|<head hash>`, the Ed25519 signature and
// the public key. Rekor checks the signature before accepting it and keeps
// the SHA-256 of the message, the signature and the key. So the log holds,
// for every checkpoint, a fingerprint that only the real chain at that seq
// can reproduce, and the time Rekor received it.

import { createHash, createPublicKey, verify } from 'node:crypto';

export const REKOR_URL = 'https://rekor.sigstore.dev';

/**
 * Rekor's public key (GET /api/v1/log/publicKey), pinned so a fake log
 * cannot hand us made-up receipts. Its SHA-256 is the log ID in every entry.
 */
export const REKOR_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwr
kBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==
-----END PUBLIC KEY-----
`;

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export const checkpointMessage = (c) => Buffer.from(`tv-checkpoint-v1|${c.seq}|${c.headHash}`, 'utf8');
/** The fingerprint Rekor stores for a checkpoint. */
export const checkpointDigest = (c) => sha256(checkpointMessage(c));

/** PEM of a raw base64 Ed25519 public key, as Rekor's x509 format wants it. */
export function ed25519Pem(publicKeyB64) {
  const der = Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyB64, 'base64')]);
  return `-----BEGIN PUBLIC KEY-----\n${der.toString('base64')}\n-----END PUBLIC KEY-----\n`;
}

/** The entry we submit for one checkpoint. */
export function rekordEntry(c, publicKeyB64) {
  return {
    apiVersion: '0.0.1',
    kind: 'rekord',
    spec: {
      signature: { format: 'x509', content: c.signature, publicKey: { content: Buffer.from(ed25519Pem(publicKeyB64)).toString('base64') } },
      data: { content: checkpointMessage(c).toString('base64') },
    },
  };
}

/** RFC 8785-style canonical JSON (sorted keys, no spaces): what Rekor signs. */
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * Checks Rekor's signed entry timestamp: Rekor's promise, signed with its
 * key, that this exact entry is in the log at `logIndex` since
 * `integratedTime`. Also checks the log ID is that key's fingerprint.
 */
export function verifySet(e, rekorKeyPem = REKOR_PUBLIC_KEY) {
  try {
    const key = createPublicKey(rekorKeyPem);
    if (sha256(key.export({ type: 'spki', format: 'der' })) !== e.logID) return false;
    const payload = canonicalJson({ body: e.body, integratedTime: e.integratedTime, logID: e.logID, logIndex: e.logIndex });
    return verify('sha256', Buffer.from(payload), key, Buffer.from(e.verification?.signedEntryTimestamp ?? '', 'base64'));
  } catch {
    return false;
  }
}

/**
 * Reads one log entry. Returns null unless it is a validly receipted rekord
 * entry signed with `publicKeyB64`.
 */
export function parseEntry(uuid, e, publicKeyB64, rekorKeyPem = REKOR_PUBLIC_KEY) {
  if (!e || !verifySet(e, rekorKeyPem)) return null;
  let body;
  try {
    body = JSON.parse(Buffer.from(e.body, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (body.kind !== 'rekord' || body.spec?.data?.hash?.algorithm !== 'sha256') return null;
  const pem = Buffer.from(body.spec.signature?.publicKey?.content ?? '', 'base64').toString('utf8');
  if (pem.replace(/\s/g, '') !== ed25519Pem(publicKeyB64).replace(/\s/g, '')) return null;
  return {
    uuid,
    logIndex: e.logIndex,
    integratedTime: new Date(e.integratedTime * 1000).toISOString(),
    digest: body.spec.data.hash.value,
    signature: body.spec.signature.content,
  };
}

async function call(fetchImpl, url, init = {}) {
  const res = await fetchImpl(url, {
    ...init,
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'trustvault-anchor', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  return res;
}

/**
 * Puts one checkpoint in the log and returns its receipt. If it is already
 * there (409), returns the existing entry. Throws unless the receipt is
 * valid and is for exactly this checkpoint.
 */
export async function submit(c, publicKeyB64, { url = REKOR_URL, rekorKey = REKOR_PUBLIC_KEY, fetchImpl = fetch } = {}) {
  const res = await call(fetchImpl, `${url}/api/v1/log/entries`, { method: 'POST', body: JSON.stringify(rekordEntry(c, publicKeyB64)) });
  let entries;
  if (res.status === 201) entries = await res.json();
  else if (res.status === 409) {
    const loc = res.headers.get('location');
    if (!loc || !/^\/api\/v1\/log\/entries\/[0-9a-f]+$/.test(loc)) throw new Error('Rekor said the entry exists but gave no valid location');
    const got = await call(fetchImpl, `${url}${loc}`);
    if (!got.ok) throw new Error(`Rekor answered ${got.status} for the existing entry`);
    entries = await got.json();
  } else {
    throw new Error(`Rekor answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const [uuid, e] = Object.entries(entries ?? {})[0] ?? [];
  const parsed = parseEntry(uuid, e, publicKeyB64, rekorKey);
  if (!parsed) throw new Error(`Rekor's receipt for checkpoint ${c.seq} is invalid`);
  if (parsed.digest !== checkpointDigest(c) || parsed.signature !== c.signature) throw new Error(`Rekor's receipt for checkpoint ${c.seq} is for a different entry`);
  return parsed;
}

/**
 * Every entry in the log signed with this key, oldest first, except those
 * whose uuid is in `known` (already checked on an earlier run). Entries
 * with an invalid receipt are reported in `invalid`, never dropped.
 */
export async function entriesForKey(publicKeyB64, { url = REKOR_URL, rekorKey = REKOR_PUBLIC_KEY, fetchImpl = fetch, known = new Set() } = {}) {
  const res = await call(fetchImpl, `${url}/api/v1/index/retrieve`, {
    method: 'POST',
    body: JSON.stringify({ publicKey: { format: 'x509', content: Buffer.from(ed25519Pem(publicKeyB64)).toString('base64') } }),
  });
  if (!res.ok) throw new Error(`Rekor search answered ${res.status}`);
  const uuids = [...new Set(await res.json())].filter((u) => typeof u === 'string' && /^[0-9a-f]{64,80}$/.test(u) && !known.has(u));
  const entries = [];
  const invalid = [];
  for (let i = 0; i < uuids.length; i += 10) {
    const r = await call(fetchImpl, `${url}/api/v1/log/entries/retrieve`, { method: 'POST', body: JSON.stringify({ entryUUIDs: uuids.slice(i, i + 10) }) });
    if (!r.ok) throw new Error(`Rekor answered ${r.status} fetching entries`);
    for (const obj of await r.json()) {
      for (const [uuid, e] of Object.entries(obj)) {
        const p = parseEntry(uuid, e, publicKeyB64, rekorKey);
        if (p) entries.push(p);
        else invalid.push(uuid);
      }
    }
  }
  // One checkpoint can show up under two UUIDs (Rekor shards); keep the first.
  const seen = new Set();
  const unique = entries.sort((a, b) => a.logIndex - b.logIndex).filter((e) => !seen.has(e.digest) && seen.add(e.digest));
  return { entries: unique, invalid };
}
