import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * TypeScript twins of keyd's ticket, ledger and rate-limit rules
 * (keyd/src/ticket.rs, ledger.rs, ratelimit.rs). LocalKeyProvider uses them
 * so that development and the test suite enforce exactly what keyd enforces
 * in production; KeyLedgerService uses the ledger functions to verify what
 * it mirrors from keyd. Formats are documented in docs/KEYS.md.
 */

const sha256hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;

// ------------------------------------------------------------------ AAD classes

export type KeyClass = 'blob' | 'totp';
export const BLOB_AAD_PREFIX = 'tv-blob-v1|';
export const TOTP_AAD_PREFIX = 'tv-totp-v1|';

/** Same rule as keyd's class_of(): only these two AAD shapes exist. */
export function aadClass(aad: string): KeyClass {
  if (aad.startsWith(BLOB_AAD_PREFIX)) {
    const p = aad.slice(BLOB_AAD_PREFIX.length).split('|');
    if (p.length === 3 && UUID.test(p[0]!) && UUID.test(p[1]!) && DECIMAL.test(p[2]!) && p[2] !== '0') return 'blob';
    throw new Error('malformed blob aad');
  }
  if (aad.startsWith(TOTP_AAD_PREFIX)) {
    if (UUID.test(aad.slice(TOTP_AAD_PREFIX.length))) return 'totp';
    throw new Error('malformed totp aad');
  }
  throw new Error('unsupported aad');
}

// ---------------------------------------------------------------------- tickets

export const TICKET_PREFIX = 'tv-unwrap-ticket-v1';
export const TICKET_MAX_TTL = 60;
export const TICKET_MAX_SKEW = 5;
export const SYSTEM_ACTIONS: ReadonlySet<string> = new Set(['rescan', 'reencrypt']);

export interface Ticket {
  kid: string;
  tid: string;
  action: string;
  doc: string;
  ver: string;
  user: string | null;
  aadSha256: string;
  wkSha256: string;
  auditId: string;
  auditSeq: bigint;
  iat: number;
  exp: number;
}

export const ticketKid = (key: Buffer): string => sha256hex(Buffer.concat([Buffer.from('tv-ticket-kid-v1|'), key])).slice(0, 16);

export function ticketBody(t: Ticket): string {
  return [TICKET_PREFIX, t.kid, t.tid, t.action, t.doc, t.ver, t.user ?? '-', t.aadSha256, t.wkSha256, t.auditId, t.auditSeq.toString(), String(t.iat), String(t.exp)].join('|');
}

/** What the database function does. Exported for tests (forgery attempts). */
export function mintTicket(key: Buffer, t: Omit<Ticket, 'kid'>): string {
  const full = { ...t, kid: ticketKid(key) };
  const body = ticketBody(full);
  return `${body}|${createHmac('sha256', key).update(body).digest('hex')}`;
}

export class TicketError extends Error {}

/** Strict parse + MAC check (constant time). Same rules as keyd verify_mac(). */
export function verifyTicketMac(keys: ReadonlyMap<string, Buffer>, s: string): Ticket {
  if (s.length > 1024) throw new TicketError('malformed ticket');
  const p = s.split('|');
  if (p.length !== 14 || p[0] !== TICKET_PREFIX) throw new TicketError('malformed ticket');
  const key = keys.get(p[1]!);
  if (!key) throw new TicketError('unknown ticket key');
  const mac = p[13]!;
  if (!HEX64.test(mac)) throw new TicketError('malformed ticket');
  const body = s.slice(0, s.length - mac.length - 1);
  const want = createHmac('sha256', key).update(body).digest();
  if (!timingSafeEqual(want, Buffer.from(mac, 'hex'))) throw new TicketError('bad ticket mac');
  const num = (x: string) => {
    if (!DECIMAL.test(x)) throw new TicketError('malformed ticket');
    return x;
  };
  const user = p[6] === '-' ? null : p[6]!;
  const t: Ticket = {
    kid: p[1]!, tid: p[2]!, action: p[3]!, doc: p[4]!, ver: p[5]!, user,
    aadSha256: p[7]!, wkSha256: p[8]!, auditId: p[9]!, auditSeq: BigInt(num(p[10]!)), iat: Number(num(p[11]!)), exp: Number(num(p[12]!)),
  };
  if (user !== null && !UUID.test(user)) throw new TicketError('malformed ticket');
  if (![t.tid, t.doc, t.ver, t.auditId].every((x) => UUID.test(x))) throw new TicketError('malformed ticket');
  if (!/^[a-z_]{1,32}$/.test(t.action) || !HEX64.test(t.aadSha256) || !HEX64.test(t.wkSha256) || t.auditSeq === 0n) throw new TicketError('malformed ticket');
  if (SYSTEM_ACTIONS.has(t.action) !== (user === null)) throw new TicketError('ticket user does not fit its action');
  return t;
}

/** Expiry and binding to the exact AAD and wrapped key. Same as keyd check_binding(). */
export function checkTicketBinding(t: Ticket, nowSec: number, aad: string, wrapped: Buffer): void {
  if (t.exp <= t.iat || t.exp - t.iat > TICKET_MAX_TTL) throw new TicketError('ticket lifetime too long');
  if (t.iat > nowSec + TICKET_MAX_SKEW) throw new TicketError('ticket issued in the future');
  if (nowSec >= t.exp) throw new TicketError('ticket expired');
  if (!aad.startsWith(`${BLOB_AAD_PREFIX}${t.doc}|${t.ver}|`) || sha256hex(aad) !== t.aadSha256) {
    throw new TicketError('ticket is for another document version');
  }
  if (sha256hex(wrapped) !== t.wkSha256) throw new TicketError('ticket is for another wrapped key');
}

// ----------------------------------------------------------------------- ledger

export const LEDGER_FORMAT = 'tv-unwrap-ledger-v1';
export const ZERO_HASH = '0'.repeat(64);

/** One keyd ledger entry, exactly as keyd serialises it. */
export interface LedgerEntry {
  seq: number;
  ts: number;
  event: string;
  action: string | null;
  tid: string | null;
  user: string | null;
  doc: string | null;
  ver: string | null;
  audit_id: string | null;
  audit_seq: number | null;
  key_id: string | null;
  aad_sha256: string | null;
  result: string;
  detail: string | null;
  prev: string;
  hash: string;
}

const field = (v: string | null): string => (v === null ? '~' : `${Buffer.byteLength(v, 'utf8')}:${v}`);

export function ledgerCanonical(e: LedgerEntry): Buffer {
  return Buffer.from(
    [LEDGER_FORMAT, String(e.seq), String(e.ts), e.event, e.action, e.tid, e.user, e.doc, e.ver, e.audit_id,
      e.audit_seq === null ? null : String(e.audit_seq), e.key_id, e.aad_sha256, e.result, e.detail]
      .map(field).join(''),
    'utf8',
  );
}

export const ledgerEntryHash = (prevHex: string, e: LedgerEntry): string =>
  sha256hex(Buffer.concat([Buffer.from(prevHex, 'hex'), ledgerCanonical(e)]));

export const ledgerHeadMessage = (seq: number | bigint, hashHex: string): Buffer => Buffer.from(`${LEDGER_FORMAT}|${seq}|${hashHex}`, 'utf8');

/**
 * Checks a run of entries continues from (prevSeq, prevHash): consecutive
 * seq, each linking to the one before, each hash recomputed. Returns the
 * first problem, or null.
 */
export function verifyLedgerRun(prevSeq: number, prevHash: string, entries: readonly LedgerEntry[]): string | null {
  let seq = prevSeq;
  let prev = prevHash;
  for (const e of entries) {
    if (e.seq !== seq + 1) return `ledger seq jumps from ${seq} to ${e.seq}`;
    if (e.prev !== prev) return `ledger entry ${e.seq} does not link to entry ${seq}`;
    const h = ledgerEntryHash(prev, e);
    if (e.hash !== h) return `ledger entry ${e.seq} hash mismatch`;
    seq = e.seq;
    prev = h;
  }
  return null;
}

export type NewLedgerEntry = Partial<Omit<LedgerEntry, 'seq' | 'ts' | 'prev' | 'hash'>> & { event: string; result: string };

/** In-memory ledger with keyd's format (LocalKeyProvider; development and tests). */
export class MemoryLedger {
  private readonly entries: LedgerEntry[] = [];

  append(n: NewLedgerEntry, nowMs: number): LedgerEntry {
    const last = this.entries.at(-1);
    const e: LedgerEntry = {
      seq: (last?.seq ?? 0) + 1, ts: nowMs, event: n.event, action: n.action ?? null, tid: n.tid ?? null, user: n.user ?? null,
      doc: n.doc ?? null, ver: n.ver ?? null, audit_id: n.audit_id ?? null, audit_seq: n.audit_seq ?? null, key_id: n.key_id ?? null,
      aad_sha256: n.aad_sha256 ?? null, result: n.result, detail: n.detail ?? null, prev: last?.hash ?? ZERO_HASH, hash: '',
    };
    e.hash = ledgerEntryHash(e.prev, e);
    this.entries.push(e);
    return e;
  }

  read(from: number, limit: number): LedgerEntry[] {
    return this.entries.slice(Math.max(from, 1) - 1, Math.max(from, 1) - 1 + Math.min(limit, 500)).map((e) => ({ ...e }));
  }

  head(): { seq: number; hash: string } {
    const last = this.entries.at(-1);
    return { seq: last?.seq ?? 0, hash: last?.hash ?? ZERO_HASH };
  }
}

// ------------------------------------------------------------------ rate limits

export interface UnwrapLimits {
  userPerMin: number;
  userPerHour: number;
  allPerMin: number;
  systemPerHour: number;
  maintPerHour: number;
  totpPerUser10Min: number;
  totpAllPerMin: number;
  rewrapPerMin: number;
  refusalsLoggedPerMin: number;
}

/** keyd's defaults (keyd/src/ratelimit.rs). */
export const DEFAULT_LIMITS: UnwrapLimits = {
  userPerMin: 60, userPerHour: 600, allPerMin: 600, systemPerHour: 2000, maintPerHour: 0,
  totpPerUser10Min: 20, totpAllPerMin: 120, rewrapPerMin: 20_000, refusalsLoggedPerMin: 120,
};

export class RateLimiter {
  private readonly windows = new Map<string, { win: number; n: number }>();
  constructor(readonly limits: UnwrapLimits) {}

  /** All-or-nothing over the buckets, like keyd. */
  take(buckets: [string, number, number][], nowSec: number): boolean {
    for (const [key, secs, limit] of buckets) {
      const w = this.windows.get(`${key}:${secs}`);
      const used = w && w.win === Math.floor(nowSec / secs) ? w.n : 0;
      if (used >= limit) return false;
    }
    for (const [key, secs] of buckets) {
      const id = Math.floor(nowSec / secs);
      const w = this.windows.get(`${key}:${secs}`);
      if (!w || w.win !== id) this.windows.set(`${key}:${secs}`, { win: id, n: 1 });
      else w.n++;
    }
    return true;
  }

  userUnwrap(user: string, now: number) {
    const l = this.limits;
    return this.take([[`u:${user}`, 60, l.userPerMin], [`u:${user}`, 3600, l.userPerHour], ['all', 60, l.allPerMin]], now);
  }
  systemUnwrap(action: string, now: number) {
    return this.take([[`sys:${action}`, 3600, action === 'reencrypt' ? this.limits.maintPerHour : this.limits.systemPerHour]], now);
  }
  totpUnwrap(user: string, now: number) { return this.take([[`totp:${user}`, 600, this.limits.totpPerUser10Min], ['totp-all', 60, this.limits.totpAllPerMin]], now); }
  rewrap(now: number) { return this.take([['rewrap', 60, this.limits.rewrapPerMin]], now); }
  logRefusal(now: number) { return this.take([['refusals', 60, this.limits.refusalsLoggedPerMin]], now); }
}
