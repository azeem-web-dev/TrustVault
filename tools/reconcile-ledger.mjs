#!/usr/bin/env node
// Offline reconciliation of keyd's key-use ledger with an audit bundle.
// Plain Node, no dependencies, no database, no trust in the API.
//
//   node tools/reconcile-ledger.mjs --ledger unwrap-ledger.jsonl --audit bundle.json \
//        [--heads ledger-anchored.jsonl | witness.json] [--ledger-key <base64 Ed25519 key>]
//
// --ledger  keyd's own file (/var/lib/tvkeyd/unwrap-ledger.jsonl, root-readable;
//           copy it off the server).
// --audit   GET /api/admin/audit/export, checked first with tools/verify-audit.mjs.
// --heads   published ledger heads: the anchor's ledger-anchored.jsonl, or the JSON
//           of /api/witness/keyd-ledger. Each must still match the ledger: a head
//           that no longer matches means the ledger was rewritten after it was
//           published. With --ledger-key, witness heads' signatures are checked too.
//
// Exit codes: 0 consistent; 1 a critical finding (printed); 2 usage or unreadable input.
//
// What it checks (docs/KEYS.md "Reconciliation"):
//  - the ledger chain: consecutive seq, each entry linked to the previous one's hash;
//  - every key release (unwrap ok) whose audit seq falls inside the bundle has an
//    ALLOWED audit event with that id and seq, the expected action, document and user;
//  - every ALLOWED download / rescan / re-encryption event in the bundle, within the
//    ledger's time span, has a key release or a recorded keyd refusal;
//  - refusals a correct API never causes (forged, malformed, mis-bound tickets);
//  - a ticket released twice.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const ZERO = '0'.repeat(64);
const FORMAT = 'tv-unwrap-ledger-v1';
const EXPECTED_AUDIT = { download: 'document.download', rescan: 'document.rescan_decrypt', reencrypt: 'keys.reencrypt_version' };
const HOSTILE = new Set([
  'ticket required', 'bad ticket mac', 'unknown ticket key', 'malformed ticket', 'ticket user does not fit its action',
  'ticket lifetime too long', 'ticket issued in the future', 'ticket is for another document version',
  'ticket is for another wrapped key', 'totp unwraps take no ticket',
]);
const GRACE_MS = 120_000;

const field = (v) => (v === null || v === undefined ? '~' : `${Buffer.byteLength(String(v), 'utf8')}:${v}`);

/** Same canonical encoding and hash as keyd/src/ledger.rs. */
export function entryHash(prevHex, e) {
  const canonical = [FORMAT, e.seq, e.ts, e.event, e.action, e.tid, e.user, e.doc, e.ver, e.audit_id, e.audit_seq, e.key_id, e.aad_sha256, e.result, e.detail]
    .map(field).join('');
  return createHash('sha256').update(Buffer.from(prevHex, 'hex')).update(canonical, 'utf8').digest('hex');
}

export function parseLedger(text) {
  return text.split('\n').filter((l) => l.trim()).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Error(`ledger line ${i + 1} is not JSON`);
    }
  });
}

export function verifyChain(entries) {
  let prev = ZERO;
  let seq = 0;
  for (const e of entries) {
    if (e.seq !== seq + 1) return `ledger seq jumps from ${seq} to ${e.seq}`;
    if (e.prev !== prev) return `ledger entry ${e.seq} does not link to entry ${seq}`;
    const h = entryHash(prev, e);
    if (e.hash !== h) return `ledger entry ${e.seq} hash mismatch`;
    prev = h;
    seq = e.seq;
  }
  return null;
}

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
export function headSignatureValid(h, keyB64) {
  try {
    const pub = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(keyB64, 'base64')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(`${FORMAT}|${h.seq}|${h.headHash}`, 'utf8'), pub, Buffer.from(h.signature, 'base64'));
  } catch {
    return false;
  }
}

/** Pure. Returns { findings: [{severity, kind, message}], stats }. */
export function reconcile(entries, bundle, heads = [], ledgerKey = null) {
  const findings = [];
  const add = (severity, kind, message) => findings.push({ severity, kind, message });
  const broken = verifyChain(entries);
  if (broken) add('critical', 'ledger_integrity', broken);
  const epoch = entries[0]?.hash ?? null;
  const bySeq = new Map(entries.map((e) => [Number(e.seq), e]));
  for (const h of heads) {
    if (h.epoch && h.epoch !== epoch) continue; // a head of another ledger file
    if (ledgerKey && h.signature && !headSignatureValid(h, ledgerKey)) add('critical', 'head_signature', `published head ${h.seq} has a bad signature`);
    const e = bySeq.get(Number(h.seq));
    if (!e) add('critical', 'ledger_truncated', `published head ${h.seq} is beyond the end of this ledger`);
    else if (e.hash !== h.headHash) add('critical', 'ledger_rewritten', `entry ${h.seq} no longer matches the head published for it`);
  }

  const events = new Map((bundle.events ?? []).map((e) => [e.id, e]));
  const seqs = (bundle.events ?? []).map((e) => BigInt(e.seq));
  const lo = seqs.length ? seqs.reduce((a, b) => (a < b ? a : b)) : 1n;
  const hi = seqs.length ? seqs.reduce((a, b) => (a > b ? a : b)) : 0n;
  let outside = 0;
  const tids = new Map();
  const byAudit = new Map();
  for (const e of entries) {
    if (e.audit_id) byAudit.set(e.audit_id, e);
    if (e.event === 'refuse' && HOSTILE.has(e.result)) add('critical', 'keyd_probe', `entry ${e.seq}: keyd refused a request: ${e.result}`);
    if (e.event !== 'unwrap' || e.result !== 'ok') continue;
    tids.set(e.tid, (tids.get(e.tid) ?? 0) + 1);
    if (e.audit_seq === null || BigInt(e.audit_seq) < lo || BigInt(e.audit_seq) > hi) { outside++; continue; }
    const ev = events.get(e.audit_id);
    const want = EXPECTED_AUDIT[e.action];
    const why = !ev ? 'no such audit event'
      : String(ev.seq) !== String(e.audit_seq) ? 'audit seq differs'
      : ev.outcome !== 'ALLOWED' ? 'audit event is not ALLOWED'
      : want && ev.action !== want ? 'audit action differs'
      : (ev.document_id ?? null) !== e.doc ? 'audit document differs'
      : (ev.actor_id ?? null) !== e.user ? 'audit user differs' : null;
    if (why) add('critical', 'release_without_audit', `entry ${e.seq} (${e.action}, document ${e.doc}): ${why}`);
    if (!want) add('warning', 'unknown_action', `entry ${e.seq}: action ${e.action} has no known audit action`);
  }
  for (const [tid, n] of tids) if (n > 1) add('critical', 'ticket_used_twice', `ticket ${tid} released ${n} times`);

  const first = entries.find((e) => e.event === 'unwrap')?.ts;
  const last = entries.at(-1)?.ts;
  if (first !== undefined) {
    for (const ev of bundle.events ?? []) {
      if (ev.outcome !== 'ALLOWED' || !Object.values(EXPECTED_AUDIT).includes(ev.action)) continue;
      const at = Date.parse(ev.occurred_at);
      if (at < first || at > last - GRACE_MS) continue;
      if (!byAudit.has(ev.id)) add('critical', 'release_without_key_service', `audit event ${ev.seq} (${ev.action}) has no key release or refusal in the ledger`);
    }
  }
  return { findings, stats: { entries: entries.length, unwraps: [...tids.values()].reduce((a, b) => a + b, 0), outsideBundle: outside, bundleRange: [String(lo), String(hi)] } };
}

export function run(argv, read = (p) => readFileSync(p, 'utf8'), out = console.log) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const ledgerPath = arg('--ledger');
  const auditPath = arg('--audit');
  if (!ledgerPath || !auditPath) {
    out('usage: node tools/reconcile-ledger.mjs --ledger <unwrap-ledger.jsonl> --audit <bundle.json> [--heads <file>] [--ledger-key <base64>]');
    return 2;
  }
  let entries, bundle, heads = [];
  try {
    entries = parseLedger(read(ledgerPath));
    bundle = JSON.parse(read(auditPath));
    const hp = arg('--heads');
    if (hp) {
      const text = read(hp).trim();
      heads = text.startsWith('{') ? (JSON.parse(text).checkpoints ?? []) : text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    }
  } catch (err) {
    out(`cannot read input: ${err.message}`);
    return 2;
  }
  const { findings, stats } = reconcile(entries, bundle, heads, arg('--ledger-key') ?? null);
  out(`ledger: ${stats.entries} entries, ${stats.unwraps} key releases (${stats.outsideBundle} refer to audit events outside the bundle ${stats.bundleRange.join('-')})`);
  for (const f of findings) out(`${f.severity.toUpperCase()} ${f.kind}: ${f.message}`);
  const critical = findings.filter((f) => f.severity === 'critical').length;
  out(critical ? `MISMATCH: ${critical} critical finding(s)` : 'consistent: every key release matches the audit log and vice versa');
  return critical ? 1 : 0;
}

if (process.argv[1]?.endsWith('reconcile-ledger.mjs')) process.exit(run(process.argv.slice(2)));
