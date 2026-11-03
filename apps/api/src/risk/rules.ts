import type { NewAlert, Severity } from './alert-store.service.js';
import type { RiskValues } from './risk-settings.service.js';

/**
 * The detection rules, as pure functions of facts already counted by SQL
 * and a supplied `now`. Pure so they can be tested directly and so the
 * same numbers always give the same alerts (THREATS.md L15).
 */

const H = 3_600_000;
const D = 24 * H;

export const dayKey = (now: Date): string => now.toISOString().slice(0, 10);
export const hourKey = (now: Date): string => now.toISOString().slice(0, 13);
/** Number of whole `days`-long periods since the epoch: a stable bucket for rolling-window dedup. */
export const periodKey = (now: Date, days: number): string => `p${days}-${Math.floor(now.getTime() / (days * D))}`;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface VolumeRow {
  userId: string;
  email: string;
  hour: number;
  day: number;
  week: number;
  long: number;
  distinctDocsLong: number;
}

/** Hour / day / week / long-window volume per person (slow extraction shows up in the longer windows). */
export function volumeAlerts(r: VolumeRow, s: RiskValues, now: Date): NewAlert[] {
  const out: NewAlert[] = [];
  const who = { subjectUserId: r.userId, subjectEmail: r.email, windowEnd: now };
  if (r.hour >= s.hour_alert) {
    const severity: Severity = r.hour >= 3 * s.hour_alert ? 'high' : 'medium';
    out.push({
      rule: 'bulk_download_hour', category: 'extraction', severity, ...who, observed: r.hour, threshold: s.hour_alert,
      windowStart: new Date(now.getTime() - H), dedupKey: `bulk_download_hour|${r.userId}|${hourKey(now)}|${severity}`,
      message: `${r.email} downloaded ${r.hour} files within one hour (alert at ${s.hour_alert})`,
    });
  }
  if (r.day >= s.day_alert) {
    out.push({
      rule: 'bulk_download_day', category: 'extraction', severity: 'high', ...who, observed: r.day, threshold: s.day_alert,
      windowStart: new Date(now.getTime() - D), dedupKey: `bulk_download_day|${r.userId}|${dayKey(now)}`,
      message: `${r.email} downloaded ${r.day} files within 24 hours (alert at ${s.day_alert})`,
    });
  }
  if (r.week >= s.week_alert) {
    out.push({
      rule: 'bulk_download_week', category: 'extraction', severity: 'high', ...who, observed: r.week, threshold: s.week_alert,
      windowStart: new Date(now.getTime() - 7 * D), dedupKey: `bulk_download_week|${r.userId}|${periodKey(now, 7)}`,
      message: `${r.email} downloaded ${r.week} files within 7 days (alert at ${s.week_alert})`,
    });
  }
  if (r.long >= s.long_alert) {
    out.push({
      rule: 'bulk_download_long', category: 'extraction', severity: 'high', ...who, observed: r.long, threshold: s.long_alert,
      windowStart: new Date(now.getTime() - s.long_window_days * D), dedupKey: `bulk_download_long|${r.userId}|${periodKey(now, s.long_window_days)}`,
      message: `${r.email} downloaded ${r.long} files within ${s.long_window_days} days (alert at ${s.long_alert})`,
      details: { distinctDocuments: r.distinctDocsLong },
    });
  }
  return out;
}

/**
 * Today against the person's own history: their median day over the 30 days
 * before (days without downloads count as 0). Needs 5 active days of history,
 * so a newcomer's first busy day is left to the fixed thresholds.
 */
export function baselineAlert(userId: string, email: string, today: number, history: number[], activeDays: number, s: RiskValues, now: Date): NewAlert | null {
  if (activeDays < 5 || today < s.baseline_min) return null;
  const padded = [...history, ...Array(Math.max(0, 30 - history.length)).fill(0)].slice(0, 30);
  const med = median(padded);
  const limit = Math.max(s.baseline_multiplier * med, s.baseline_min);
  if (today <= limit) return null;
  return {
    rule: 'above_baseline', category: 'extraction', severity: 'medium', subjectUserId: userId, subjectEmail: email,
    observed: today, threshold: limit, windowStart: new Date(now.getTime() - D), windowEnd: now,
    dedupKey: `above_baseline|${userId}|${dayKey(now)}`,
    message: `${email} downloaded ${today} files in 24 hours; their usual day is ${med} (median of the previous 30 days)`,
    details: { median: med, multiplier: s.baseline_multiplier },
  };
}

/** A week against the median week of people with the same role (needs 3 peers). */
export function peerAlert(userId: string, email: string, role: string, week: number, peerWeeks: number[], s: RiskValues, now: Date): NewAlert | null {
  if (peerWeeks.length < 3 || week < s.peer_min) return null;
  const med = median(peerWeeks);
  const limit = Math.max(s.peer_multiplier * Math.max(med, 1), s.peer_min);
  if (week <= limit) return null;
  return {
    rule: 'above_peers', category: 'extraction', severity: 'medium', subjectUserId: userId, subjectEmail: email,
    observed: week, threshold: limit, windowStart: new Date(now.getTime() - 7 * D), windowEnd: now,
    dedupKey: `above_peers|${userId}|${dayKey(now)}`,
    message: `${email} downloaded ${week} files in 7 days; the median for ${role.toLowerCase()} accounts is ${med}`,
    details: { role, peerMedian: med, peers: peerWeeks.length },
  };
}

/** Took a large share of everything they can open. */
export function coverageAlert(userId: string, email: string, distinctDocs: number, accessible: number, s: RiskValues, now: Date): NewAlert | null {
  if (accessible < s.coverage_min_docs || accessible === 0) return null;
  const fraction = distinctDocs / accessible;
  if (fraction < s.coverage_fraction) return null;
  return {
    rule: 'document_coverage', category: 'extraction', severity: 'high', subjectUserId: userId, subjectEmail: email,
    observed: Math.round(fraction * 1000) / 1000, threshold: s.coverage_fraction,
    windowStart: new Date(now.getTime() - s.long_window_days * D), windowEnd: now,
    dedupKey: `document_coverage|${userId}|${dayKey(now)}`,
    message: `${email} downloaded ${distinctDocs} of the ${accessible} documents they can open (${Math.round(fraction * 100)}%) within ${s.long_window_days} days`,
    details: { distinctDocuments: distinctDocs, accessibleDocuments: accessible },
  };
}

/** Downloads at hours of the day (UTC) this person never used in the previous 30 days. */
export function offHoursAlert(userId: string, email: string, usualHours: Set<number>, recentHours: number[], activeDays: number, s: RiskValues, now: Date): NewAlert | null {
  if (activeDays < 7) return null;
  const unusual = recentHours.filter((h) => !usualHours.has(h));
  if (unusual.length < s.off_hours_min) return null;
  return {
    rule: 'unusual_hours', category: 'extraction', severity: 'medium', subjectUserId: userId, subjectEmail: email,
    observed: unusual.length, threshold: s.off_hours_min, windowStart: new Date(now.getTime() - D), windowEnd: now,
    dedupKey: `unusual_hours|${userId}|${dayKey(now)}`,
    message: `${email} downloaded ${unusual.length} files in the last 24 hours at times of day they had not used in 30 days (UTC hours ${[...new Set(unusual)].sort((a, b) => a - b).join(', ')})`,
    details: { unusualHoursUtc: [...new Set(unusual)].sort((a, b) => a - b), usualHoursUtc: [...usualHours].sort((a, b) => a - b) },
  };
}
