import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { canonicalCidr } from '../common/ip.js';
import { formatClock, parseClock, validTimeZone } from './schedule.js';

/** A time window as clients send it: { days: [1..7], start: "09:00", end: "17:30", timeZone: "Europe/London" }. */
export const WindowSchema = z.strictObject({
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  timeZone: z.string().min(1).max(64),
});

export const NetworksSchema = z.array(z.string().trim().min(2).max(64)).min(1).max(32);

/** Conditions on one share. Omitted on an existing share: keep what it has. */
export const SharePolicySchema = z.strictObject({
  downloadApproval: z.boolean().default(false),
  approverId: z.uuid().nullable().optional(),
  window: WindowSchema.nullable().optional(),
  networks: NetworksSchema.nullable().optional(),
});

export const RolePolicySchema = z.strictObject({
  window: WindowSchema.nullable().optional(),
  networks: NetworksSchema.nullable().optional(),
}).refine((v) => Boolean(v.window) || Boolean(v.networks), 'Give a time window, networks, or both');

export type WindowInput = z.infer<typeof WindowSchema>;
export type SharePolicyInput = z.infer<typeof SharePolicySchema>;

/** Database form of a window (the columns of grants / role_access_policies). */
export interface WindowColumns { days: number[] | null; start: number | null; end: number | null; tz: string | null }

export function windowColumns(w: WindowInput | null | undefined): WindowColumns {
  if (!w) return { days: null, start: null, end: null, tz: null };
  if (!validTimeZone(w.timeZone)) throw new BadRequestException(`Unknown time zone "${w.timeZone}": use a name like Europe/London`);
  let start: number, end: number;
  try {
    start = parseClock(w.start);
    end = parseClock(w.end);
  } catch (err) {
    throw new BadRequestException((err as Error).message);
  }
  if (start >= 1440) throw new BadRequestException('The window must start before 24:00');
  if (end <= start) throw new BadRequestException('The window must end after it starts (windows over midnight are not supported: use two days)');
  const days = [...new Set(w.days)].sort((a, b) => a - b);
  return { days, start, end, tz: w.timeZone };
}

/** Canonical CIDR strings, or null for "any network". */
export function networkColumns(list: string[] | null | undefined): string[] | null {
  if (!list) return null;
  try {
    return [...new Set(list.map(canonicalCidr))];
  } catch (err) {
    throw new BadRequestException((err as Error).message);
  }
}

/** For API responses: the window as clients send it. */
export function windowOut(days: number[] | null | undefined, start: number | null, end: number | null, tz: string | null) {
  if (!days || days.length === 0 || start === null || end === null || !tz) return null;
  return { days, start: formatClock(start), end: formatClock(end), timeZone: tz };
}

export const listOrNull = <T>(x: T[] | null | undefined): T[] | null => (x && x.length ? x : null);
