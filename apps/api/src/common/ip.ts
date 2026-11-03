import { isIP } from 'node:net';

/**
 * IP addresses and CIDR ranges for the network allowlist (THREATS.md P5-P7).
 * The same rule runs in the database (inet <<= cidr); both sides use the
 * canonical form produced here, and an IPv4 client seen through an IPv6
 * socket (::ffff:a.b.c.d) is treated as the IPv4 address it is.
 */

export interface Ip { v: 4 | 6; n: bigint }

/** Normalises a client address: strips an IPv6 zone and unwraps IPv4-mapped IPv6. Null if not an address. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const kind = isIP(s);
  if (kind === 4) return formatIp(parseIp(s)!);
  if (kind !== 6) return null;
  const p = parseIp(s)!;
  if (p.n >> 32n === 0xffffn) return formatIp({ v: 4, n: p.n & 0xffffffffn });
  return formatIp(p);
}

export function parseIp(s: string): Ip | null {
  const kind = isIP(s);
  if (kind === 4) {
    const parts = s.split('.').map(Number);
    return { v: 4, n: parts.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n) };
  }
  if (kind !== 6) return null;
  let text = s.toLowerCase();
  // Embedded IPv4 tail (::ffff:1.2.3.4) becomes two hex groups.
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = parseIp(v4[1]!)!.n;
    text = text.slice(0, -v4[1]!.length) + `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') as [string, string] : [text, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  return { v: 6, n: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n) };
}

export function formatIp(ip: Ip): string {
  if (ip.v === 4) return [24n, 16n, 8n, 0n].map((sh) => ((ip.n >> sh) & 0xffn).toString()).join('.');
  const g: string[] = [];
  for (let i = 7; i >= 0; i--) g.push(((ip.n >> BigInt(i * 16)) & 0xffffn).toString(16));
  // Compress the longest run of zero groups (RFC 5952).
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === '0') j++;
    if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
    i = j;
  }
  if (best < 0) return g.join(':');
  return `${g.slice(0, best).join(':')}::${g.slice(best + bestLen).join(':')}`;
}

export interface Cidr { v: 4 | 6; net: bigint; bits: number }

/**
 * Parses "10.0.0.0/8", "2001:db8::/32" or a bare address (a /32 or /128).
 * Throws on anything else, and on host bits set ("10.0.0.1/8" is almost
 * always a typo for a much smaller or larger range than intended).
 */
export function parseCidr(text: string): Cidr {
  const [addr, len, extra] = text.trim().split('/');
  if (extra !== undefined || !addr) throw new Error(`"${text}" is not a network range`);
  const ip = parseIp(addr);
  if (!ip) throw new Error(`"${text}" is not a network range`);
  const max = ip.v === 4 ? 32 : 128;
  const bits = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : NaN;
  if (!Number.isInteger(bits) || bits < 0 || bits > max) throw new Error(`"${text}" has an invalid prefix length`);
  const hostMask = (1n << BigInt(max - bits)) - 1n;
  if ((ip.n & hostMask) !== 0n) throw new Error(`"${text}" has host bits set; did you mean ${formatIp({ v: ip.v, n: ip.n & ~hostMask })}/${bits}?`);
  return { v: ip.v, net: ip.n, bits };
}

export function formatCidr(c: Cidr): string {
  return `${formatIp({ v: c.v, n: c.net })}/${c.bits}`;
}

/** Canonical form, as stored in the database. Throws on invalid input. */
export function canonicalCidr(text: string): string {
  return formatCidr(parseCidr(text));
}

export function cidrContains(c: Cidr, ip: Ip): boolean {
  if (c.v !== ip.v) return false;
  const max = c.v === 4 ? 32 : 128;
  const shift = BigInt(max - c.bits);
  return (ip.n >> shift) === (c.net >> shift);
}

/** Null list: any network. Otherwise the address must be known and inside one range. */
export function ipAllowed(cidrs: readonly string[] | null | undefined, ip: string | null): boolean {
  if (!cidrs) return true;
  const addr = ip ? parseIp(normalizeIp(ip) ?? '') : null;
  if (!addr) return false;
  return cidrs.some((c) => {
    try { return cidrContains(parseCidr(c), addr); } catch { return false; }
  });
}
