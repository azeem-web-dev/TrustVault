import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { Actor } from '../common/request-context.js';

/**
 * Every tunable number of the insider-extraction rules and the hard
 * download limits, with its safe default and the range an admin may set.
 * The ranges stop a setting from switching a rule off in all but name (a
 * download limit of 100 000 a day) — and every change is audited and raises
 * an alert the other admins see (THREATS.md L17).
 */
export const RISK_SETTINGS = {
  download_daily_limit:  { def: 200, min: 5, max: 5000, label: 'Hard limit: downloads per person per 24 hours' },
  download_session_limit:{ def: 100, min: 5, max: 5000, label: 'Hard limit: downloads per sign-in session' },
  hour_alert:            { def: 20, min: 5, max: 1000, label: 'Alert: downloads by one person within an hour' },
  day_alert:             { def: 100, min: 10, max: 5000, label: 'Alert: downloads by one person within 24 hours' },
  week_alert:            { def: 300, min: 20, max: 20000, label: 'Alert: downloads by one person within 7 days' },
  long_alert:            { def: 1000, min: 50, max: 50000, label: 'Alert: downloads by one person within the long window' },
  long_window_days:      { def: 30, min: 7, max: 90, label: 'Long window (days)' },
  baseline_multiplier:   { def: 5, min: 2, max: 50, label: "Alert when a day's downloads exceed this many times the person's median day" },
  baseline_min:          { def: 30, min: 5, max: 5000, label: '…and at least this many downloads that day' },
  peer_multiplier:       { def: 5, min: 2, max: 50, label: "Alert when a week's downloads exceed this many times the median of people with the same role" },
  peer_min:              { def: 50, min: 5, max: 20000, label: '…and at least this many downloads that week' },
  coverage_fraction:     { def: 0.5, min: 0.1, max: 1, label: 'Alert when a person downloads this fraction of the documents they can open (long window)' },
  coverage_min_docs:     { def: 20, min: 5, max: 10000, label: '…when they can open at least this many documents' },
  session_alert:         { def: 50, min: 5, max: 5000, label: 'Alert: downloads within one session' },
  off_hours_min:         { def: 20, min: 3, max: 1000, label: 'Alert: downloads in 24 hours at hours of day this person never used before' },
  shared_network_alert:  { def: 100, min: 10, max: 20000, label: 'Alert: downloads in 24 hours by several accounts from one network' },
  flood_per_subject:     { def: 10, min: 3, max: 1000, label: 'Alert flood: alerts about one person or document within 24 hours' },
} as const;

export type RiskKey = keyof typeof RISK_SETTINGS;
export type RiskValues = Record<RiskKey, number>;

export const RISK_KEYS = Object.keys(RISK_SETTINGS) as RiskKey[];

/** The only settings that may be fractional; every other one is a whole number. */
const FRACTIONAL: ReadonlySet<RiskKey> = new Set(['coverage_fraction', 'baseline_multiplier', 'peer_multiplier']);

export function validateRiskPatch(patch: Record<string, unknown>): Partial<RiskValues> {
  const out: Partial<RiskValues> = {};
  for (const [k, v] of Object.entries(patch)) {
    const spec = (RISK_SETTINGS as Record<string, { min: number; max: number }>)[k];
    if (!spec) throw new BadRequestException(`Unknown setting ${k}`);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequestException(`${k} must be a number`);
    if (!FRACTIONAL.has(k as RiskKey) && !Number.isInteger(v)) throw new BadRequestException(`${k} must be a whole number`);
    if (v < spec.min || v > spec.max) throw new BadRequestException(`${k} must be between ${spec.min} and ${spec.max}`);
    out[k as RiskKey] = v;
  }
  if (Object.keys(out).length === 0) throw new BadRequestException('Nothing to change');
  return out;
}

@Injectable()
export class RiskSettingsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Current values: stored ones over the defaults. */
  async values(tx?: Tx): Promise<RiskValues> {
    const rows = await (tx ?? this.prisma).$queryRaw<{ key: string; value: string }[]>`SELECT key, value::text AS value FROM risk_settings`;
    const out = Object.fromEntries(RISK_KEYS.map((k) => [k, RISK_SETTINGS[k].def])) as RiskValues;
    for (const r of rows) if (r.key in out) out[r.key as RiskKey] = Number(r.value);
    return out;
  }

  async describe() {
    const rows = await this.prisma.$queryRaw<{ key: string; value: string; updated_at: Date; updated_by_email: string | null }[]>`
      SELECT s.key, s.value::text AS value, s.updated_at, u.email AS updated_by_email
        FROM risk_settings s LEFT JOIN users u ON u.id = s.updated_by`;
    const stored = new Map(rows.map((r) => [r.key, r]));
    return {
      settings: RISK_KEYS.map((k) => {
        const s = stored.get(k);
        return {
          key: k, label: RISK_SETTINGS[k].label, value: s ? Number(s.value) : RISK_SETTINGS[k].def,
          default: RISK_SETTINGS[k].def, min: RISK_SETTINGS[k].min, max: RISK_SETTINGS[k].max,
          updatedAt: s?.updated_at ?? null, updatedBy: s?.updated_by_email ?? null,
        };
      }),
    };
  }

  /**
   * Admin change. Audited in the same transaction (no change without its
   * record), with before and after; the alert generator turns the audit
   * event into a policy alert that the admin who made it cannot resolve.
   */
  async update(actor: Actor, patch: Record<string, unknown>, reason: string) {
    const changes = validateRiskPatch(patch);
    await this.prisma.$transaction(async (tx) => {
      // One policy change at a time, so "before" is exact.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('tv-risk-settings', 0))`;
      const before = await this.values(tx);
      for (const [k, v] of Object.entries(changes)) {
        await tx.$executeRaw`
          INSERT INTO risk_settings (key, value, updated_by) VALUES (${k}, ${v}::numeric, ${actor.userId}::uuid)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`;
      }
      const diff = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, { before: before[k as RiskKey], after: v }]));
      await this.audit.record({ action: 'alert.policy_change', outcome: 'ALLOWED', targetType: 'risk_settings', details: { changes: diff, reason } }, tx);
    });
    return this.describe();
  }
}
