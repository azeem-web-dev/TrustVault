import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign as edSign, type KeyObject } from 'node:crypto';
import { createConnection } from 'node:net';
import {
  aadClass, checkTicketBinding, DEFAULT_LIMITS, MemoryLedger, RateLimiter, ticketKid, TicketError, verifyTicketMac,
  type KeyClass, type LedgerEntry, type NewLedgerEntry, type Ticket, type UnwrapLimits,
} from './key-ledger.js';

/**
 * Everything that needs a long-lived secret goes through a KeyProvider:
 * wrapping per-file data keys, wrapping TOTP secrets, and signing audit
 * checkpoints. In production this is `keyd`, a separate process running
 * as a different Linux user, so the API never holds a master key. The
 * local provider exists for development and tests only, and enforces the
 * same rules (tickets, rate limits, ledger) so the suite exercises them.
 *
 * Unwrapping a DOCUMENT data key needs a ticket from the database function
 * tv_issue_unwrap_ticket() (see issueUnwrapTicket in tickets.ts). keyd
 * verifies it; the API cannot mint one (docs/KEYS.md).
 */
export interface KeyProvider {
  /** Encrypts a small secret (a data key or TOTP secret) bound to `aad`. */
  wrap(plaintext: Buffer, aad: string): Promise<{ wrapped: Buffer; keyId: string }>;
  /** Document data keys need `ticket`; TOTP secrets must not have one. */
  unwrap(wrapped: Buffer, keyId: string, aad: string, ticket?: string): Promise<Buffer>;
  /** Re-wraps under the current key generation. The plaintext never reaches the caller. */
  rewrap(wrapped: Buffer, keyId: string, aad: string): Promise<{ wrapped: Buffer; keyId: string; changed: boolean }>;
  /** Does this wrapped value open (without returning it), and is it on the current key? */
  check(wrapped: Buffer, keyId: string, aad: string): Promise<{ ok: boolean; current: boolean }>;
  /** Ed25519 signature over `message` (audit checkpoints only; keyd refuses anything else). */
  sign(message: Buffer): Promise<{ signature: Buffer; keyId: string }>;
  /** Raw 32-byte Ed25519 public key, published so anyone can verify checkpoints. */
  publicKey(): Promise<{ publicKey: Buffer; keyId: string }>;
  /** Signed head of the key service's own key-use ledger. */
  ledgerHead(): Promise<LedgerHead>;
  /** Ledger entries from `from` (inclusive), at most 500. */
  ledgerRead(from: number, limit: number): Promise<LedgerEntry[]>;
  status(): Promise<KeyStatus>;
}

export interface LedgerHead {
  seq: number;
  headHash: string;
  /** base64 Ed25519 signature over `tv-unwrap-ledger-v1|<seq>|<headHash>`. */
  signature: string;
  /** base64 raw Ed25519 public key (distinct from the audit signing key). */
  publicKey: string;
  keyId: string;
}

export interface KeyStatus {
  generation: number;
  generations: number[];
  retired: number[];
  wrapKeyIds: { blob: string; totp: string };
  ticketKids: string[];
  ledgerSeq: number;
}

export const KEY_PROVIDER = Symbol('KEY_PROVIDER');

// PKCS#8 / SPKI DER prefixes for raw Ed25519 keys.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function ed25519PublicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** AES-256-GCM: output is nonce(12) || tag(16) || ciphertext. */
export function aesGcmSeal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([nonce, c.getAuthTag(), ct]);
}

export function aesGcmOpen(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < 28) throw new Error('sealed value too short');
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
}

const hkdf = (master: Buffer, label: string) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), label, 32));

function ed25519FromSeed(seed: Buffer): { key: KeyObject; pub: Buffer } {
  const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return { key, pub: Buffer.from(spki.subarray(spki.length - 32)) };
}

/** Development ticket key, derived from the local master key so dev and tests need no extra secret. */
export const localTicketKey = (masterKey: Buffer): Buffer => hkdf(masterKey, 'tv-local-ticket-key-v1');

export interface LocalKeyOptions {
  /** Further master key generations (2, 3, ...). Generation 1 is the constructor's key. */
  generations?: ReadonlyMap<number, Buffer>;
  currentGeneration?: number;
  retired?: readonly number[];
  /** Ticket MAC keys; default: localTicketKey(master). */
  ticketKeys?: readonly Buffer[];
  limits?: Partial<UnwrapLimits>;
  /** Unix ms; replaceable in tests. */
  clock?: () => number;
}

const SIGN_LEDGER_KEY_ID = 'local-ledger-ed25519-v1';

/**
 * Development/test provider: keyd's rules in-process. Key ids are
 * `local-g<N>-blob` / `local-g<N>-totp`; `local-v1` (one key for both
 * classes, from before key generations) is still opened. Refused in
 * production — see loadEnv().
 */
export class LocalKeyProvider implements KeyProvider {
  private readonly gens = new Map<number, { blob: Buffer; totp: Buffer }>();
  private readonly legacy: Buffer;
  private readonly current: number;
  private readonly retired: Set<number>;
  private readonly signKey: KeyObject;
  private readonly pub: Buffer;
  private readonly ledgerKey: KeyObject;
  private readonly ledgerPub: Buffer;
  private readonly ticketKeys = new Map<string, Buffer>();
  private readonly seen = new Map<string, number>();
  private readonly limiter: RateLimiter;
  private readonly clock: () => number;
  private suppressed = 0;
  /** The key-use ledger (memory only). Exposed for tests. */
  readonly ledger = new MemoryLedger();

  constructor(masterKey: Buffer, opts: LocalKeyOptions = {}) {
    if (masterKey.length !== 32) throw new Error('LOCAL_MASTER_KEY must be 32 bytes');
    const masters = new Map<number, Buffer>([[1, masterKey], ...(opts.generations ?? new Map())]);
    for (const [n, m] of masters) {
      if (m.length !== 32) throw new Error(`master key generation ${n} must be 32 bytes`);
      this.gens.set(n, { blob: hkdf(m, `tv-wrap-g${n}-blob`), totp: hkdf(m, `tv-wrap-g${n}-totp`) });
    }
    this.current = opts.currentGeneration ?? Math.max(...masters.keys());
    this.retired = new Set(opts.retired ?? []);
    if (!this.gens.has(this.current) || this.retired.has(this.current)) throw new Error('bad current key generation');
    this.legacy = hkdf(masterKey, 'tv-wrap-v1');
    ({ key: this.signKey, pub: this.pub } = ed25519FromSeed(hkdf(masterKey, 'tv-audit-sign-v1')));
    ({ key: this.ledgerKey, pub: this.ledgerPub } = ed25519FromSeed(hkdf(masterKey, 'tv-unwrap-ledger-sign-v1')));
    for (const k of opts.ticketKeys ?? [localTicketKey(masterKey)]) this.ticketKeys.set(ticketKid(k), k);
    this.limiter = new RateLimiter({ ...DEFAULT_LIMITS, ...opts.limits });
    this.clock = opts.clock ?? Date.now;
    this.ledger.append({
      event: 'start', result: 'ok',
      detail: `generations=[${[...this.gens.keys()].join(', ')}] current=${this.current} retired=[${[...this.retired].join(', ')}] ticket_kids=[${[...this.ticketKeys.keys()].join(', ')}] boot=${randomBytes(8).toString('hex')}`,
    }, this.clock());
  }

  private keyIdFor(cls: KeyClass, gen = this.current) {
    return `local-g${gen}-${cls}`;
  }

  private keyFor(keyId: string, cls: KeyClass): Buffer {
    if (keyId === 'local-v1') {
      if (this.retired.has(1)) throw new Error('key id is retired');
      return this.legacy;
    }
    const m = /^local-g([1-9][0-9]{0,3})-(blob|totp)$/.exec(keyId);
    if (!m) throw new Error(`unknown key id ${keyId}`);
    if (m[2] !== cls) throw new Error('key id does not match the aad');
    const gen = Number(m[1]);
    if (this.retired.has(gen)) throw new Error('key id is retired');
    const g = this.gens.get(gen);
    if (!g) throw new Error(`unknown key id ${keyId}`);
    return g[cls];
  }

  private refuse(e: NewLedgerEntry | Omit<NewLedgerEntry, 'event' | 'result'>, reason: string): never {
    const now = this.clock();
    if (this.limiter.logRefusal(Math.floor(now / 1000))) {
      const n = this.suppressed;
      this.suppressed = 0;
      this.ledger.append({ ...e, event: 'refuse', result: reason, ...(n > 0 ? { detail: `suppressed=${n}` } : {}) }, now);
    } else {
      this.suppressed++;
    }
    throw new TicketError(reason);
  }

  async wrap(plaintext: Buffer, aad: string) {
    const cls = aadClass(aad);
    return { wrapped: aesGcmSeal(this.gens.get(this.current)![cls], plaintext, aad), keyId: this.keyIdFor(cls) };
  }

  async unwrap(wrapped: Buffer, keyId: string, aad: string, ticket?: string): Promise<Buffer> {
    const cls = aadClass(aad);
    const nowMs = this.clock();
    const now = Math.floor(nowMs / 1000);
    const aadHash = createHash('sha256').update(aad).digest('hex');
    if (cls === 'totp') {
      const user = aad.slice('tv-totp-v1|'.length);
      const base = { action: 'totp', user, key_id: keyId };
      if (ticket !== undefined) this.refuse(base, 'totp unwraps take no ticket');
      if (!this.limiter.totpUnwrap(user, now)) this.refuse(base, 'rate limited');
      try {
        const plain = aesGcmOpen(this.keyFor(keyId, cls), wrapped, aad);
        this.ledger.append({ ...base, event: 'totp_unwrap', result: 'ok' }, nowMs);
        return plain;
      } catch (err) {
        this.ledger.append({ ...base, event: 'totp_unwrap', result: 'unwrap failed' }, nowMs);
        throw err;
      }
    }
    const bare = { key_id: keyId, aad_sha256: aadHash };
    if (ticket === undefined) this.refuse(bare, 'ticket required');
    let t: Ticket;
    try {
      t = verifyTicketMac(this.ticketKeys, ticket);
    } catch (err) {
      this.refuse(bare, (err as Error).message);
    }
    const entry = {
      action: t.action, tid: t.tid, user: t.user, doc: t.doc, ver: t.ver, audit_id: t.auditId,
      audit_seq: Number(t.auditSeq), key_id: keyId, aad_sha256: aadHash,
    };
    try {
      checkTicketBinding(t, now, aad, wrapped);
    } catch (err) {
      this.refuse(entry, (err as Error).message);
    }
    for (const [tid, until] of this.seen) if (until <= now) this.seen.delete(tid);
    if (this.seen.has(t.tid)) this.refuse(entry, 'ticket already used');
    this.seen.set(t.tid, t.exp + 5);
    const allowed = t.user ? this.limiter.userUnwrap(t.user, now) : this.limiter.systemUnwrap(t.action, now);
    if (!allowed) this.refuse(entry, 'rate limited');
    let plain: Buffer;
    try {
      plain = aesGcmOpen(this.keyFor(keyId, cls), wrapped, aad);
    } catch (err) {
      this.ledger.append({ ...entry, event: 'unwrap', result: 'unwrap failed' }, nowMs);
      throw err;
    }
    this.ledger.append({ ...entry, event: 'unwrap', result: 'ok' }, nowMs);
    return plain;
  }

  async rewrap(wrapped: Buffer, keyId: string, aad: string) {
    const cls = aadClass(aad);
    const nowMs = this.clock();
    if (!this.limiter.rewrap(Math.floor(nowMs / 1000))) throw new Error('rate limited');
    const plain = aesGcmOpen(this.keyFor(keyId, cls), wrapped, aad);
    try {
      if (keyId === this.keyIdFor(cls)) return { wrapped, keyId, changed: false };
      const out = await this.wrap(plain, aad);
      this.ledger.append({
        event: 'rewrap', result: 'ok', key_id: keyId, aad_sha256: createHash('sha256').update(aad).digest('hex'), detail: out.keyId,
      }, nowMs);
      return { ...out, changed: true };
    } finally {
      plain.fill(0);
    }
  }

  async check(wrapped: Buffer, keyId: string, aad: string) {
    const cls = aadClass(aad);
    try {
      aesGcmOpen(this.keyFor(keyId, cls), wrapped, aad).fill(0);
      return { ok: true, current: keyId === this.keyIdFor(cls) };
    } catch {
      return { ok: false, current: false };
    }
  }

  async sign(message: Buffer) {
    return { signature: edSign(null, message, this.signKey), keyId: 'local-ed25519-v1' };
  }

  async publicKey() {
    return { publicKey: this.pub, keyId: 'local-ed25519-v1' };
  }

  async ledgerHead(): Promise<LedgerHead> {
    const { seq, hash } = this.ledger.head();
    const msg = Buffer.from(`tv-unwrap-ledger-v1|${seq}|${hash}`, 'utf8');
    return { seq, headHash: hash, signature: edSign(null, msg, this.ledgerKey).toString('base64'), publicKey: this.ledgerPub.toString('base64'), keyId: SIGN_LEDGER_KEY_ID };
  }

  async ledgerRead(from: number, limit: number) {
    return this.ledger.read(from, limit);
  }

  async status(): Promise<KeyStatus> {
    return {
      generation: this.current, generations: [...this.gens.keys()].sort((a, b) => a - b), retired: [...this.retired],
      wrapKeyIds: { blob: this.keyIdFor('blob'), totp: this.keyIdFor('totp') }, ticketKids: [...this.ticketKeys.keys()],
      ledgerSeq: this.ledger.head().seq,
    };
  }
}

/**
 * Talks to keyd over a Unix socket: one JSON request per line, one JSON
 * response per line. The socket is only accessible to the trustvault group,
 * and keyd additionally checks the peer's uid (SO_PEERCRED).
 */
export class KeydKeyProvider implements KeyProvider {
  constructor(private readonly socketPath: string) {}

  private call(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(this.socketPath);
      let buf = '';
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('keyd timeout'));
      }, 5000);
      sock.setEncoding('utf8');
      sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
      sock.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.length > 4_000_000) {
          sock.destroy();
          reject(new Error('keyd response too large'));
          return;
        }
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          clearTimeout(timer);
          sock.end();
          try {
            const res = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
            if (typeof res.error === 'string') reject(new Error(`keyd: ${res.error}`));
            else resolve(res);
          } catch (err) {
            reject(err);
          }
        }
      });
      sock.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async wrap(plaintext: Buffer, aad: string) {
    const r = await this.call({ op: 'wrap', aad, data: plaintext.toString('base64') });
    return { wrapped: Buffer.from(r.data as string, 'base64'), keyId: r.key_id as string };
  }

  async unwrap(wrapped: Buffer, keyId: string, aad: string, ticket?: string) {
    const r = await this.call({ op: 'unwrap', aad, key_id: keyId, data: wrapped.toString('base64'), ...(ticket !== undefined ? { ticket } : {}) });
    return Buffer.from(r.data as string, 'base64');
  }

  async rewrap(wrapped: Buffer, keyId: string, aad: string) {
    const r = await this.call({ op: 'rewrap', aad, key_id: keyId, data: wrapped.toString('base64') });
    return { wrapped: Buffer.from(r.data as string, 'base64'), keyId: r.key_id as string, changed: r.changed === true };
  }

  async check(wrapped: Buffer, keyId: string, aad: string) {
    const r = await this.call({ op: 'check', aad, key_id: keyId, data: wrapped.toString('base64') });
    return { ok: r.ok === true, current: r.current === true };
  }

  async sign(message: Buffer) {
    const r = await this.call({ op: 'sign', data: message.toString('base64') });
    return { signature: Buffer.from(r.signature as string, 'base64'), keyId: r.key_id as string };
  }

  async publicKey() {
    const r = await this.call({ op: 'pubkey' });
    return { publicKey: Buffer.from(r.public_key as string, 'base64'), keyId: r.key_id as string };
  }

  async ledgerHead(): Promise<LedgerHead> {
    const r = await this.call({ op: 'ledger_head' });
    return { seq: r.seq as number, headHash: r.head_hash as string, signature: r.signature as string, publicKey: r.public_key as string, keyId: r.key_id as string };
  }

  async ledgerRead(from: number, limit: number) {
    const r = await this.call({ op: 'ledger_read', from, limit });
    return r.entries as LedgerEntry[];
  }

  async status(): Promise<KeyStatus> {
    const r = await this.call({ op: 'status' });
    const ids = r.wrap_key_ids as { blob: string; totp: string };
    return {
      generation: r.generation as number, generations: r.generations as number[], retired: r.retired as number[],
      wrapKeyIds: ids, ticketKids: r.ticket_kids as string[], ledgerSeq: r.ledger_seq as number,
    };
  }
}
