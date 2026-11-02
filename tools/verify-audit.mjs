#!/usr/bin/env node
// Offline verifier for a TrustVault audit bundle (Admin → Audit → Export).
//
//   node tools/verify-audit.mjs trustvault-audit.json --key <production public key> --rekor [--witness checkpoints.jsonl]
//
// Needs nothing but Node. It never talks to the TrustVault server or its
// database, so it is a check you can run without trusting either. It verifies:
//   1. every event's hash = SHA-256(prev_hash || canonical bytes of the event)
//   2. every event's prev_hash is the previous event's hash (no gaps,
//      insertions, reordering or deletions inside the range)
//   3. the bundle has signed checkpoints, every one matches the chain at its
//      seq, and its Ed25519 signature is valid for the key you pinned with
//      --key. The key inside the bundle is never trusted on its own: anyone
//      who rewrites the chain can make a new key and re-sign it.
//   4. the newest events are covered by a checkpoint. Events after the
//      newest checkpoint ("unprotected tail") are only acceptable if the
//      bundle was exported within 5 minutes of that checkpoint.
//   5. with --witness: every head recorded by the outside witness (the
//      `witness` branch, see tools/witness.mjs) that falls inside the bundle
//      matches the bundle's chain, and — for a bundle exported from seq 1 —
//      every checkpoint the witness saw before the export is in the bundle.
//   6. with --rekor: looks up every checkpoint signed with the key in
//      Sigstore's public log (the only network call). At least one of the
//      bundle's checkpoints must be there, and — for a bundle exported from
//      seq 1 — every entry published before the export must be one of the
//      bundle's checkpoints. A public checkpoint the bundle does not contain
//      means history after it was removed or rewritten (tail truncation).
//
// A bundle that does not start at seq 1 is refused unless you pass
// --partial (you exported a range on purpose); tail checks are then limited.
//
// Exit codes: 0 = intact, 1 = tampered or malformed, 2 = only internally
// consistent (no --key, --rekor or --witness: nothing ties it to the real
// key service; pass --self-consistency-only to accept that), 64 = usage.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkpointDigest, entriesForKey } from './rekor.mjs';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ZERO_HASH = '0'.repeat(64);

/** The production audit signing key (keyd). Pass it with --key. A PUBLIC key, published on purpose. */
export const PRODUCTION_KEY = 'OMFkgIVZnsaXmuQkQv/Ibi8oEEEXveEbML5CtjdH+VE='; // gitleaks:allow (Ed25519 public key, not a secret)
export const PRODUCTION_KEY_ID = 'keyd-ed25519-v1';
/** The scheduler checkpoints every minute; a longer unsigned tail is suspicious. */
export const TAIL_GRACE_MS = 5 * 60_000;

export const EXIT = { INTACT: 0, TAMPERED: 1, UNANCHORED: 2, USAGE: 64 };

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

/** hash = SHA-256(prev_hash || canonical(event)). */
export const eventHash = (e) => createHash('sha256').update(Buffer.from(e.prev_hash, 'hex')).update(canonical(e)).digest('hex');

/** The exact bytes a checkpoint signature covers (same as the API and tools/rekor.mjs). */
export const checkpointMessage = (c) => Buffer.from(`tv-checkpoint-v1|${c.seq}|${c.headHash}`, 'utf8');

const big = (s) => { try { return BigInt(s); } catch { return null; } };
const time = (s) => { const t = Date.parse(s ?? ''); return Number.isFinite(t) ? t : null; };

/**
 * Pure. Checks the bundle on its own, plus the outside witness's heads.
 * `expectedKey`: base64 Ed25519 key pinned by the auditor (or null).
 * `opts.partial`: the auditor exported a range on purpose (not from seq 1, or with an end seq).
 * Returns { ok, problems, warnings, events, checkpoints, witnessMatched, firstSeq, lastSeq, fromGenesis, newestCheckpoint }.
 */
export function verifyBundle(bundle, expectedKey, witnessed = null, opts = {}) {
  const partial = Boolean(opts.partial);
  const problems = [];
  const warnings = [];
  if (bundle?.format !== 'trustvault-audit-bundle-v1') problems.push('unknown bundle format');
  const events = bundle?.events ?? [];
  if (events.length === 0) problems.push('bundle has no events');

  // A bundle exported from seq 1 starts at the all-zero genesis hash. (seq 1
  // itself can be missing if the very first insert rolled back, so the
  // marker is the zero prev_hash, not the seq number.)
  const fromGenesis = events.length > 0 && events[0].prev_hash === ZERO_HASH;
  if (bundle?.genesisPrevHash != null && events.length && bundle.genesisPrevHash !== events[0].prev_hash) {
    problems.push('bundle says it starts at the beginning of the log, but its first event does not link to the genesis hash');
  }
  if (events.length && !fromGenesis && !partial) {
    problems.push(`bundle starts at seq ${events[0].seq}, not at the beginning of the log: events before it are missing (if you exported a partial range on purpose, pass --partial)`);
  }

  let prev = null;
  let prevSeq = null;
  const hashes = new Map();
  for (const e of events) {
    const seq = big(e.seq);
    if (seq === null) { problems.push(`event with invalid seq ${JSON.stringify(e.seq)}`); continue; }
    if (prevSeq !== null && seq <= prevSeq) problems.push(`seq ${e.seq}: out of order`);
    if (prev !== null && e.prev_hash !== prev) problems.push(`seq ${e.seq}: prev_hash does not link to the previous event`);
    let expected = null;
    try { expected = eventHash(e); } catch { /* malformed prev_hash */ }
    if (expected !== e.hash) problems.push(`seq ${e.seq}: hash does not match its contents`);
    hashes.set(seq.toString(), e.hash);
    prev = e.hash;
    prevSeq = seq;
  }
  const firstSeq = events.length ? String(events[0].seq) : null;
  const lastSeq = prevSeq;

  const key = bundle?.signingKey?.publicKey;
  if (expectedKey && key !== expectedKey) {
    problems.push(`bundle is signed with key ${key ?? '(none)'}${bundle?.signingKey?.keyId ? ` (${bundle.signingKey.keyId})` : ''}, not the key you pinned with --key (${expectedKey}): it was not produced by the production key service`);
  }
  let pub = null;
  try {
    pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(expectedKey ?? key, 'base64')]), format: 'der', type: 'spki' });
  } catch {
    problems.push('invalid signing key');
  }

  const checkpoints = bundle?.checkpoints ?? [];
  if (checkpoints.length === 0) problems.push('bundle has no signed checkpoints: nothing ties these events to the key service');
  const checkpointBySeq = new Map();
  let newest = null;
  for (const c of checkpoints) {
    const seq = big(c.seq);
    if (seq === null) { problems.push(`checkpoint with invalid seq ${JSON.stringify(c.seq)}`); continue; }
    checkpointBySeq.set(seq.toString(), c);
    const chainHash = hashes.get(seq.toString());
    if (!chainHash) problems.push(`checkpoint ${c.seq}: no event with that seq in this bundle`);
    else if (chainHash !== c.headHash) problems.push(`checkpoint ${c.seq}: does not match the chain`);
    let good = false;
    try { good = Boolean(pub) && verify(null, checkpointMessage(c), pub, Buffer.from(c.signature ?? '', 'base64')); } catch { good = false; }
    if (pub && !good) problems.push(`checkpoint ${c.seq}: bad signature`);
    if (!newest || seq > big(newest.seq)) newest = c;
  }

  // Events after the newest checkpoint are not signed by anything yet.
  const exportedAt = time(bundle?.exportedAt);
  if (exportedAt === null) problems.push('bundle has no valid exportedAt time');
  if (newest && lastSeq !== null && lastSeq > big(newest.seq)) {
    const tail = events.filter((e) => big(e.seq) !== null && big(e.seq) > big(newest.seq)).length;
    const signedAt = time(newest.createdAt);
    const msg = `unprotected tail: ${tail} event(s) after seq ${newest.seq} are not covered by a signed checkpoint`;
    if (exportedAt !== null && signedAt !== null && exportedAt - signedAt <= TAIL_GRACE_MS) {
      warnings.push(`${msg} (exported ${Math.max(0, Math.round((exportedAt - signedAt) / 1000))}s after that checkpoint was signed — normal, the next one is due within a minute)`);
    } else {
      problems.push(`${msg}, and the bundle was exported more than ${TAIL_GRACE_MS / 60_000} minutes after that checkpoint was signed (${newest.createdAt ?? 'unknown time'}): newer checkpoints were removed or the events were added afterwards`);
    }
  }

  let witnessMatched = 0;
  let witnessBeyond = 0;
  for (const w of witnessed ?? []) {
    const seq = big(w.seq);
    if (seq === null) { problems.push(`witness record with invalid seq ${JSON.stringify(w.seq)}`); continue; }
    const chainHash = hashes.get(seq.toString());
    if (chainHash) {
      if (chainHash !== w.headHash) problems.push(`seq ${w.seq}: differs from the head the outside witness recorded at ${w.witnessedAt}`);
      else witnessMatched++;
    }
    // Tail check: everything the witness saw before the export must be in a full bundle.
    const seenAt = time(w.witnessedAt);
    const beforeExport = seenAt !== null && exportedAt !== null && seenAt < exportedAt;
    if (!beforeExport) continue;
    if (fromGenesis && !partial) {
      const c = checkpointBySeq.get(seq.toString());
      if (lastSeq !== null && seq > lastSeq) {
        problems.push(`the outside witness has checkpoint seq ${w.seq} (witnessed ${w.witnessedAt}) that this bundle does not contain — history after it was removed or rewritten`);
      } else if (!c) {
        if (chainHash) problems.push(`the outside witness has checkpoint seq ${w.seq} (witnessed ${w.witnessedAt}) but this bundle has no checkpoint there: it was removed`);
        else problems.push(`the outside witness has checkpoint seq ${w.seq} (witnessed ${w.witnessedAt}) but this bundle has no event with that seq — it was removed`);
      } else if (c.headHash !== w.headHash) {
        problems.push(`checkpoint ${w.seq}: differs from the checkpoint the outside witness recorded at ${w.witnessedAt}`);
      }
    } else if (lastSeq !== null && seq > lastSeq) {
      witnessBeyond++;
    }
  }
  if (witnessBeyond) warnings.push(`${witnessBeyond} witnessed checkpoint(s) fall after this partial bundle's last seq ${lastSeq} and were not checked`);

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    events: events.length,
    checkpoints: checkpoints.length,
    witnessMatched,
    firstSeq,
    lastSeq: lastSeq === null ? null : lastSeq.toString(),
    fromGenesis,
    newestCheckpoint: newest ? String(newest.seq) : null,
  };
}

/**
 * Pure: compares a bundle with the public log entries signed with the key
 * ({ uuid, logIndex, integratedTime, digest }). Rekor stores only a
 * checkpoint's fingerprint, not its seq, so an entry is identified by
 * matching fingerprints. Returns { ok, anchored, latest, problems, warnings, unmatchedOutside, afterExport }.
 */
export function rekorReport(bundle, entries, opts = {}) {
  const partial = Boolean(opts.partial);
  const problems = [];
  const warnings = [];
  const events = bundle.events ?? [];
  const fromGenesis = events.length > 0 && events[0].prev_hash === ZERO_HASH;
  const exportedAt = time(bundle.exportedAt);

  const eventByDigest = new Map();
  for (const e of events) eventByDigest.set(checkpointDigest({ seq: e.seq, headHash: e.hash }), String(e.seq));
  const checkpointByDigest = new Map((bundle.checkpoints ?? []).map((c) => [checkpointDigest(c), String(c.seq)]));

  const anchoredEntries = entries.filter((e) => checkpointByDigest.has(e.digest));
  const latest = anchoredEntries.reduce((a, e) => (!a || e.logIndex > a.logIndex ? e : a), null);
  const anchored = anchoredEntries.length;
  if (anchored === 0) {
    problems.push(`none of this bundle's ${(bundle.checkpoints ?? []).length} checkpoint(s) is in Sigstore's public log: there is no independent record that this history existed`);
  }

  let unmatchedOutside = 0;
  let afterExport = 0;
  for (const e of entries) {
    if (checkpointByDigest.has(e.digest)) continue;
    const at = time(e.integratedTime);
    if (exportedAt !== null && at !== null && at >= exportedAt) { afterExport++; continue; } // published after the export
    const asEvent = eventByDigest.get(e.digest);
    if (fromGenesis && !partial) {
      if (asEvent) problems.push(`public log entry ${e.logIndex} (anchored ${e.integratedTime}) is the checkpoint of seq ${asEvent}, but this bundle has no checkpoint there: it was removed`);
      else problems.push(`public log has checkpoint entry ${e.logIndex} (anchored ${e.integratedTime}) that this bundle does not contain — history after it was removed or rewritten`);
    } else if (asEvent) {
      continue; // in range, matches the chain
    } else if (fromGenesis && latest && e.logIndex < latest.logIndex) {
      // Anchoring is in chain order, so this entry is for a seq inside the range.
      problems.push(`public log entry ${e.logIndex} (anchored ${e.integratedTime}) matches no event in this bundle: it is a checkpoint of a different history`);
    } else {
      unmatchedOutside++;
    }
  }
  if (unmatchedOutside) {
    warnings.push(`${unmatchedOutside} public log entr${unmatchedOutside === 1 ? 'y falls' : 'ies fall'} outside this partial bundle's range and could not be checked: tail checks are limited for a partial export — export from seq 1 with no end for the full check`);
  }
  return {
    ok: problems.length === 0,
    anchored,
    latest: latest ? { seq: checkpointByDigest.get(latest.digest), logIndex: latest.logIndex, integratedTime: latest.integratedTime } : null,
    problems,
    warnings,
    unmatchedOutside,
    afterExport,
  };
}

const USAGE = 'usage: node tools/verify-audit.mjs <bundle.json> --key <public-key-base64> [--rekor] [--witness checkpoints.jsonl] [--partial] [--self-consistency-only]';

/** Parses argv (without node and script). Returns options or { error }. */
export function parseArgs(argv) {
  const args = [...argv];
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const value = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v === undefined || v.startsWith('--') ? null : v;
  };
  const o = {
    rekor: flag('--rekor'),
    partial: flag('--partial'),
    selfConsistencyOnly: flag('--self-consistency-only'),
    witnessFile: value('--witness'),
    key: value('--key'),
  };
  if (o.witnessFile === null || o.key === null) return { error: USAGE };
  const unknown = args.find((a) => a.startsWith('--'));
  if (unknown) return { error: `unknown option ${unknown}\n${USAGE}` };
  const [file, legacyKey, ...rest] = args;
  if (!file || rest.length) return { error: USAGE };
  if (legacyKey && o.key && legacyKey !== o.key) return { error: 'two different expected keys given' };
  o.file = file;
  o.key = o.key ?? legacyKey ?? undefined; // the old positional form still works
  return o;
}

/**
 * The CLI. `io` lets tests inject everything that touches the outside:
 * readFile(path) → string, entriesForKey(key) → { entries, invalid }, out(line), now().
 * Returns the exit code.
 */
export async function run(argv, io = {}) {
  const out = io.out ?? ((l) => console.log(l));
  const readFile = io.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const lookup = io.entriesForKey ?? ((k) => entriesForKey(k));
  const now = io.now ?? (() => Date.now());

  const o = parseArgs(argv);
  if (o.error) { (io.err ?? ((l) => console.error(l)))(o.error); return EXIT.USAGE; }

  let bundle;
  let witnessed = null;
  try {
    bundle = JSON.parse(readFile(o.file));
    if (o.witnessFile) witnessed = readFile(o.witnessFile).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (err) {
    out(`TAMPERED: 1 problem(s)`);
    out(` - cannot read input: ${err.message}`);
    return EXIT.TAMPERED;
  }

  const result = verifyBundle(bundle, o.key, witnessed, { partial: o.partial });
  const warnings = [...result.warnings];
  const bundleKey = bundle?.signingKey?.publicKey;
  if (o.partial) warnings.push(`partial range (seq ${result.firstSeq}–${result.lastSeq}): tail checks are limited — this cannot show that later history was not removed or rewritten`);
  if (!o.key && bundleKey && bundleKey !== PRODUCTION_KEY) {
    warnings.push(`no --key given, and the bundle's key ${bundleKey} is not the production key ${PRODUCTION_KEY} (${PRODUCTION_KEY_ID}): anyone can make a key, sign a forged chain and publish it`);
  }
  const exportedAt = time(bundle?.exportedAt);
  if (exportedAt !== null && (o.rekor || witnessed) && now() - exportedAt > 60 * 60_000) {
    warnings.push(`the bundle says it was exported at ${bundle.exportedAt}; public records after that time were not compared. If you downloaded it later than that, the bundle is lying`);
  }

  let rekorLine = '';
  if (o.rekor && (o.key ?? bundleKey)) {
    try {
      const { entries, invalid } = await lookup(o.key ?? bundleKey);
      const r = rekorReport(bundle, entries, { partial: o.partial });
      result.problems.push(...r.problems, ...invalid.map((u) => `public log entry ${u} has an invalid receipt`));
      warnings.push(...r.warnings);
      if (r.latest) rekorLine = ` ${r.anchored} of the bundle's checkpoints are in Sigstore's public log; the newest, seq ${r.latest.seq}, was published at ${r.latest.integratedTime} (log index ${r.latest.logIndex}).`;
      if (r.afterExport) rekorLine += ` ${r.afterExport} later public entr${r.afterExport === 1 ? 'y was' : 'ies were'} published after the export and not compared.`;
    } catch (err) {
      result.problems.push(`could not check Sigstore's public log: ${err.message}`);
    }
  }
  result.ok = result.problems.length === 0;

  for (const w of warnings) out(`WARNING: ${w}`);
  if (!result.ok) {
    out(`TAMPERED: ${result.problems.length} problem(s)`);
    for (const p of result.problems) out(` - ${p}`);
    return EXIT.TAMPERED;
  }
  const w = witnessed ? `, and ${result.witnessMatched} head(s) recorded by the outside witness match` : '';
  const summary = `${result.events} events and ${result.checkpoints} signed checkpoints verified${w}.${rekorLine}`;
  if (!o.key && !o.rekor && !witnessed) {
    out('WARNING: ************************************************************************');
    out('WARNING: No --key, --rekor or --witness given. This only proves the bundle is');
    out('WARNING: internally consistent. Anyone who rewrites the log can recompute every');
    out('WARNING: hash and sign it with a key of their own, and it will look exactly like this.');
    out(`WARNING: Pin the production key: --key ${PRODUCTION_KEY}`);
    out('WARNING: ************************************************************************');
    if (!o.selfConsistencyOnly) {
      out(`UNVERIFIED: ${summary} Internally consistent only — not tied to the production key (pass --self-consistency-only to accept this).`);
      return EXIT.UNANCHORED;
    }
    out(`CONSISTENT: ${summary} (self-consistency only)`);
    return EXIT.INTACT;
  }
  out(`INTACT: ${summary}`);
  return EXIT.INTACT;
}

if (process.argv[1]?.endsWith('verify-audit.mjs')) {
  process.exit(await run(process.argv.slice(2)));
}
