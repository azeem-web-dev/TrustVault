import { isIPv4, isIPv6 } from 'node:net';

/** The eight 16-bit groups of an IPv6 address, or null. */
function v6Groups(ip: string): number[] | null {
  if (!isIPv6(ip)) return null;
  let addr = ip.split('%')[0]!;
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (tail) {
    const o = tail[1]!.split('.').map(Number);
    addr = addr.slice(0, -tail[1]!.length) + `${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const [head, rest] = addr.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const r = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const fill = rest === undefined ? [] : Array<string>(8 - h.length - r.length).fill('0');
  const groups = [...h, ...fill, ...r].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * Where a request comes from, at the granularities the sign-in throttles use.
 *
 * - `client`: one attacker machine. The exact IPv4 address; for IPv6 the
 *   /64, because anyone with an IPv6 connection gets a whole /64 and can
 *   rotate through it for free.
 * - `network`: the surrounding network. IPv4 /24, IPv6 /48 — what one
 *   provider customer, office or small hosting block typically holds.
 *
 * IPv4-mapped IPv6 (::ffff:1.2.3.4, how Node reports IPv4 on a dual-stack
 * socket) is treated as the IPv4 address it is.
 */
export function clientNetwork(ip: string | null | undefined): { ip: string; client: string; network: string } {
  const raw = (ip ?? '').trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw);
  const v4 = mapped ? mapped[1]! : raw;
  if (isIPv4(v4)) {
    const o = v4.split('.');
    return { ip: v4, client: v4, network: `${o[0]}.${o[1]}.${o[2]}.0/24` };
  }
  const g = v6Groups(raw);
  if (g) {
    const hex = (xs: number[]) => xs.map((x) => x.toString(16)).join(':');
    return { ip: raw.toLowerCase(), client: `${hex(g.slice(0, 4))}::/64`, network: `${hex(g.slice(0, 3))}::/48` };
  }
  return { ip: raw || 'unknown', client: raw || 'unknown', network: raw || 'unknown' };
}
