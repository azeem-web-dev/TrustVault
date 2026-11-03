import { describe, expect, it } from 'vitest';
import { deviceLabel, ipPrefix } from '../src/risk/net.js';
import { baselineAlert, coverageAlert, median, offHoursAlert, peerAlert, volumeAlerts } from '../src/risk/rules.js';
import { RISK_KEYS, RISK_SETTINGS, validateRiskPatch, type RiskValues } from '../src/risk/risk-settings.service.js';
import { quotaDecision } from '../src/risk/download-limits.service.js';

const S = Object.fromEntries(RISK_KEYS.map((k) => [k, RISK_SETTINGS[k].def])) as RiskValues;
const NOW = new Date('2026-11-03T12:00:00Z');
const row = (o: Partial<{ hour: number; day: number; week: number; long: number }>) => ({ userId: 'u', email: 'u@t.io', hour: 0, day: 0, week: 0, long: 0, distinctDocsLong: 0, ...o });

describe('network and device', () => {
  it('groups addresses by /24 and /48', () => {
    expect(ipPrefix('203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('::ffff:10.1.2.3')).toBe('10.1.2.0/24');
    expect(ipPrefix('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(ipPrefix('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(ipPrefix('not an ip')).toBeNull();
    expect(ipPrefix(null)).toBeNull();
  });
  it('labels devices without versions', () => {
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36')).toBe('Chrome on Windows');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0')).toBe('Edge on Windows');
    expect(deviceLabel('Dart/3.9 (dart:io)')).toBe('TrustVault app on other');
    expect(deviceLabel('curl/8.0')).toBe('script on other');
    expect(deviceLabel(null)).toBe('unknown');
  });
});

describe('rules', () => {
  it('median', () => {
    expect(median([])).toBe(0);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('hour rule: medium, high at three times the threshold', () => {
    expect(volumeAlerts(row({ hour: 19 }), S, NOW)).toEqual([]);
    expect(volumeAlerts(row({ hour: 20 }), S, NOW).map((a) => [a.rule, a.severity])).toEqual([['bulk_download_hour', 'medium']]);
    expect(volumeAlerts(row({ hour: 60 }), S, NOW).map((a) => a.severity)).toEqual(['high']);
  });
  it('slow extraction: 15 an hour all day trips the day rule, not the hour rule', () => {
    expect(volumeAlerts(row({ hour: 15, day: 360, week: 360, long: 360 }), S, NOW).map((a) => a.rule)).toEqual(['bulk_download_day', 'bulk_download_week']);
  });
  it('dedup keys are stable within their window and change with it', () => {
    const a = volumeAlerts(row({ day: 100 }), S, NOW)[0]!;
    const b = volumeAlerts(row({ day: 200 }), S, new Date('2026-11-03T23:00:00Z'))[0]!;
    const c = volumeAlerts(row({ day: 100 }), S, new Date('2026-11-04T01:00:00Z'))[0]!;
    expect(a.dedupKey).toBe(b.dedupKey);
    expect(a.dedupKey).not.toBe(c.dedupKey);
  });
  it('baseline needs history and a real jump', () => {
    expect(baselineAlert('u', 'u@t.io', 60, [4, 4, 4], 3, S, NOW)).toBeNull(); // too little history
    expect(baselineAlert('u', 'u@t.io', 60, Array(20).fill(4), 20, S, NOW)?.rule).toBe('above_baseline');
    expect(baselineAlert('u', 'u@t.io', 60, Array(30).fill(15), 30, S, NOW)).toBeNull(); // 60 <= 5 x 15
    expect(baselineAlert('u', 'u@t.io', 29, Array(20).fill(1), 20, S, NOW)).toBeNull(); // under the floor
  });
  it('peers need at least three to compare with', () => {
    expect(peerAlert('u', 'u@t.io', 'VIEWER', 80, [3, 3], S, NOW)).toBeNull();
    expect(peerAlert('u', 'u@t.io', 'VIEWER', 80, [3, 3, 3], S, NOW)?.rule).toBe('above_peers');
    expect(peerAlert('u', 'u@t.io', 'VIEWER', 80, [20, 20, 20], S, NOW)).toBeNull();
  });
  it('coverage', () => {
    expect(coverageAlert('u', 'u@t.io', 12, 20, S, NOW)?.rule).toBe('document_coverage');
    expect(coverageAlert('u', 'u@t.io', 9, 20, S, NOW)).toBeNull();
    expect(coverageAlert('u', 'u@t.io', 10, 10, S, NOW)).toBeNull(); // too few documents to mean anything
  });
  it('unusual hours', () => {
    const usual = new Set([9, 10, 11]);
    expect(offHoursAlert('u', 'u@t.io', usual, Array(25).fill(3), 10, S, NOW)?.rule).toBe('unusual_hours');
    expect(offHoursAlert('u', 'u@t.io', usual, Array(25).fill(10), 10, S, NOW)).toBeNull();
    expect(offHoursAlert('u', 'u@t.io', usual, Array(25).fill(3), 6, S, NOW)).toBeNull();
  });
});

describe('limits and settings', () => {
  const L = { daily: 5, session: 3, overrideId: null, overrideExpiresAt: null };
  it('quota decision', () => {
    expect(quotaDecision(4, 2, L).allowed).toBe(true);
    expect(quotaDecision(5, 0, L).reason).toBe('download_limit_daily');
    expect(quotaDecision(1, 3, L).reason).toBe('download_limit_session');
  });
  it('settings are bounded', () => {
    expect(validateRiskPatch({ day_alert: 150 })).toEqual({ day_alert: 150 });
    expect(() => validateRiskPatch({ day_alert: 1 })).toThrow(/between/);
    expect(() => validateRiskPatch({ download_daily_limit: 2.5 })).toThrow(/whole/);
    expect(() => validateRiskPatch({ coverage_fraction: 2 })).toThrow(/between/);
    expect(() => validateRiskPatch({ bogus: 1 })).toThrow(/Unknown/);
    expect(() => validateRiskPatch({})).toThrow(/Nothing/);
    expect(validateRiskPatch({ coverage_fraction: 0.3 })).toEqual({ coverage_fraction: 0.3 });
  });
});
