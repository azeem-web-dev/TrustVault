import { isIPv4, isIPv6 } from 'node:net';

/**
 * The "network" an address belongs to: /24 for IPv4, /48 for IPv6. We have
 * no location data (no GeoIP database is shipped: the free ones need a
 * licence account or are large), so "unusual location" means "a network
 * prefix this account has not used before". A prefix is coarse on purpose:
 * a home router's address changing within its provider's /24 is not news.
 */
export function ipPrefix(ip: string | null | undefined): string | null {
  if (!ip) return null;
  let a = ip.trim();
  if (a.startsWith('::ffff:') && isIPv4(a.slice(7))) a = a.slice(7);
  if (isIPv4(a)) return `${a.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIPv6(a)) {
    const groups = expandV6(a);
    return groups ? `${groups.slice(0, 3).join(':')}::/48` : null;
  }
  return null;
}

function expandV6(a: string): string[] | null {
  const noZone = a.split('%')[0]!;
  const [head, tail] = noZone.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  if (h.some((g) => g.includes('.')) || t.some((g) => g.includes('.'))) return null; // embedded v4: rare, skip
  const missing = 8 - h.length - t.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  return [...h, ...Array(tail === undefined ? 0 : missing).fill('0'), ...t].map((g) => (parseInt(g || '0', 16) || 0).toString(16));
}

/**
 * A coarse device label from a User-Agent: browser or app family plus OS,
 * no version numbers. Two sign-ins with the same label count as the same
 * kind of device. A User-Agent is chosen by the client, so this is a hint
 * for noticing, never an identity (THREATS.md S25).
 */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return 'unknown';
  const os =
    /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad|iOS/i.test(ua) ? 'iOS'
    : /Windows/i.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
    : /CrOS/i.test(ua) ? 'ChromeOS'
    : /Linux/i.test(ua) ? 'Linux'
    : 'other';
  const app =
    /TrustVault/i.test(ua) ? 'TrustVault app'
    : /\bDart\//i.test(ua) ? 'TrustVault app'
    : /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : /curl|wget|python|okhttp|node|axios|go-http/i.test(ua) ? 'script'
    : 'other';
  return `${app} on ${os}`;
}
