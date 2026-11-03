import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluate, Level, type AccessFacts, type GrantFacts } from '../src/documents/access.js';
import { inWindow, validTimeZone, parseClock } from '../src/documents/schedule.js';
import { canonicalCidr, ipAllowed, normalizeIp } from '../src/common/ip.js';
import { windowColumns } from '../src/documents/policy-input.js';

// The application lock's access-policy rules, as pure functions. The same
// window cases run against the database lock in access-policy-db.test.ts.

const { cases } = JSON.parse(readFileSync(new URL('./fixtures/window-cases.json', import.meta.url), 'utf8')) as {
  cases: { name: string; w: { days: number[]; start: number; end: number; tz: string }; at: string; expect: boolean }[];
};

describe('time windows (app lock): boundaries and daylight saving', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(inWindow(c.w, new Date(c.at))).toBe(c.expect);
  });

  it('no window means always open', () => {
    expect(inWindow(null, new Date())).toBe(true);
  });

  it('time zones: named IANA zones only, never POSIX offsets', () => {
    expect(validTimeZone('Europe/London')).toBe(true);
    expect(validTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(validTimeZone('UTC')).toBe(true);
    for (const bad of ['UTC+5', '+05:30', 'Mars/Olympus', '', 'Europe/London; DROP TABLE x']) expect(validTimeZone(bad), bad).toBe(false);
  });

  it('clock parsing and window validation', () => {
    expect(parseClock('00:00')).toBe(0);
    expect(parseClock('24:00')).toBe(1440);
    expect(() => parseClock('24:01')).toThrow();
    expect(() => parseClock('9:00')).toThrow();
    expect(() => windowColumns({ days: [1], start: '17:00', end: '09:00', timeZone: 'UTC' })).toThrow(/after it starts/);
    expect(() => windowColumns({ days: [1], start: '09:00', end: '17:00', timeZone: 'UTC+5' })).toThrow(/Unknown time zone/);
    expect(windowColumns({ days: [5, 1, 1], start: '09:00', end: '17:30', timeZone: 'Asia/Kolkata' })).toEqual({ days: [1, 5], start: 540, end: 1050, tz: 'Asia/Kolkata' });
  });
});

describe('network allowlist (app lock)', () => {
  it('IPv4 and IPv6 ranges', () => {
    const list = ['10.0.0.0/8', '192.168.1.0/24', '2001:db8::/32'];
    expect(ipAllowed(list, '10.200.3.4')).toBe(true);
    expect(ipAllowed(list, '192.168.1.255')).toBe(true);
    expect(ipAllowed(list, '192.168.2.1')).toBe(false);
    expect(ipAllowed(list, '11.0.0.1')).toBe(false);
    expect(ipAllowed(list, '2001:db8:ffff::1')).toBe(true);
    expect(ipAllowed(list, '2001:db9::1')).toBe(false);
  });

  it('an IPv4 client seen through an IPv6 socket is matched as IPv4', () => {
    expect(normalizeIp('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(ipAllowed(['10.0.0.0/8'], '::ffff:10.1.2.3')).toBe(true);
    expect(ipAllowed(['::ffff:0:0/96'], '10.1.2.3')).toBe(false); // compared as IPv4, like Postgres after normalising
  });

  it('unknown or malformed addresses match nothing; no list matches everything', () => {
    expect(ipAllowed(['0.0.0.0/0'], null)).toBe(false);
    expect(ipAllowed(['0.0.0.0/0'], 'not-an-ip')).toBe(false);
    expect(ipAllowed(null, null)).toBe(true);
    expect(ipAllowed(['0.0.0.0/0'], '203.0.113.9')).toBe(true);
    expect(ipAllowed(['::/0'], '203.0.113.9')).toBe(false);   // families never mix
  });

  it('canonical CIDR form; host bits and junk refused', () => {
    expect(canonicalCidr('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(canonicalCidr('2001:DB8:0:0::/32')).toBe('2001:db8::/32');
    expect(canonicalCidr('203.0.113.7')).toBe('203.0.113.7/32');
    expect(canonicalCidr('fe80::1')).toBe('fe80::1/128');
    expect(() => canonicalCidr('10.0.0.1/8')).toThrow(/host bits/);
    expect(() => canonicalCidr('10.0.0.0/33')).toThrow();
    expect(() => canonicalCidr('10.0.0/8')).toThrow();
    expect(() => canonicalCidr('example.com/8')).toThrow();
  });
});

const ME = 'u-me';
const NOW = new Date('2026-11-04T10:00:00Z'); // a Wednesday, 10:00 UTC
const base = (grants: GrantFacts[], extra: Partial<AccessFacts> = {}): AccessFacts => ({
  document: { ownerId: 'u-owner', status: 'ACTIVE' },
  user: { role: 'VIEWER', status: 'ACTIVE', accessExpiresAt: null },
  grants, breakGlassUntil: null, ...extra,
});
const g = (extra: Partial<GrantFacts> = {}): GrantFacts => ({ level: 'READ', expiresAt: null, viaGroup: false, ...extra });
const open = { days: [3], start: 540, end: 660, tz: 'UTC' };    // Wed 09:00-11:00 UTC: open at NOW
const closed = { days: [3], start: 660, end: 720, tz: 'UTC' };  // Wed 11:00-12:00 UTC: closed at NOW

describe('decide() with access policies', () => {
  it('a share outside its window gives nothing, with a reason the person can read', () => {
    const d = evaluate(base([g({ window: closed })]), ME, 'view', NOW);
    expect(d).toMatchObject({ allowed: false, level: Level.NONE, reason: 'outside_time_window' });
    expect(d.policyMessage).toMatch(/Wed 11:00–12:00 \(UTC\)/);
    expect(evaluate(base([g({ window: open })]), ME, 'view', NOW).allowed).toBe(true);
  });

  it('a share from a network outside its allowlist gives nothing', () => {
    const facts = base([g({ networks: ['10.0.0.0/8'] })]);
    expect(evaluate(facts, ME, 'view', NOW, { ip: '10.9.9.9' }).allowed).toBe(true);
    expect(evaluate(facts, ME, 'view', NOW, { ip: '198.51.100.7' })).toMatchObject({ allowed: false, reason: 'network_not_allowed' });
    expect(evaluate(facts, ME, 'view', NOW, { ip: null }).allowed).toBe(false);
  });

  it('another usable share still counts, but a blocked EDIT share does not lend its level', () => {
    const facts = base([g({ level: 'EDIT', window: closed }), g({ level: 'READ' })]);
    expect(evaluate(facts, ME, 'view', NOW).allowed).toBe(true);
    expect(evaluate(facts, ME, 'edit', NOW)).toMatchObject({ allowed: false, reason: 'needs_edit' });
  });

  it('role rules apply on top of every share, and an owner exception does not lift them', () => {
    const rolePolicy = { window: closed, networks: null };
    expect(evaluate(base([g()], { rolePolicy }), ME, 'view', NOW)).toMatchObject({ allowed: false, reason: 'outside_time_window' });
    const exception = { overrideUntil: new Date(NOW.getTime() + 3_600_000).toISOString() };
    expect(evaluate(base([g()], { rolePolicy, ...exception }), ME, 'view', NOW).allowed).toBe(false);
    expect(evaluate(base([g()], { rolePolicy: { window: null, networks: ['10.0.0.0/8'] } }), ME, 'view', NOW, { ip: '8.8.8.8' }).reason).toBe('network_not_allowed');
  });

  it('owners and break-glass are never limited by share conditions', () => {
    const facts = base([g({ window: closed })], { rolePolicy: { window: closed } });
    expect(evaluate(facts, 'u-owner', 'download', NOW)).toMatchObject({ allowed: true, approvalRequired: false });
  });

  it('an owner exception lifts the share window, network and approval until it ends', () => {
    const until = new Date(NOW.getTime() + 3_600_000).toISOString();
    const facts = base([g({ window: closed, networks: ['10.0.0.0/8'], downloadApproval: true })], { overrideUntil: until });
    expect(evaluate(facts, ME, 'download', NOW, { ip: '8.8.8.8' })).toMatchObject({ allowed: true, approvalRequired: false });
    const later = new Date(NOW.getTime() + 2 * 3_600_000);
    expect(evaluate(facts, ME, 'download', later, { ip: '8.8.8.8' }).allowed).toBe(false);
  });

  it('download approval: needed only when every usable share that allows downloading asks for it', () => {
    expect(evaluate(base([g({ downloadApproval: true })]), ME, 'download', NOW)).toMatchObject({ allowed: true, approvalRequired: true });
    expect(evaluate(base([g({ downloadApproval: true }), g({ viaGroup: true })]), ME, 'download', NOW).approvalRequired).toBe(false);
    // An unconditioned share outside its window does not waive the approval.
    expect(evaluate(base([g({ downloadApproval: true }), g({ window: closed })]), ME, 'download', NOW).approvalRequired).toBe(true);
    // A View-only share never downloads, so it cannot waive another share's approval.
    expect(evaluate(base([g({ downloadApproval: true }), g({ level: 'VIEW', viaGroup: true })]), ME, 'download', NOW).approvalRequired).toBe(true);
    // And a View-only share alone is refused the download outright, not sent to ask.
    expect(evaluate(base([g({ level: 'VIEW' })]), ME, 'download', NOW)).toMatchObject({ allowed: false, reason: 'needs_read' });
    // An expired unconditioned share does not either.
    expect(evaluate(base([g({ downloadApproval: true }), g({ expiresAt: '2026-01-01T00:00:00Z' })]), ME, 'download', NOW).approvalRequired).toBe(true);
  });
});
