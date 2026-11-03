import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { ENV, type Env } from '../config/env.js';
import { logger } from '../common/logger.js';

export const DEVICE_COOKIE = '__Host-tv_device';

export interface TrustedDevice {
  userId: string;
  deviceId: string;
  issuedAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * "This browser has signed in to this account before" (THREATS.md S9, S19).
 *
 * After a full sign-in — password, plus the second factor if the account
 * has one — the browser gets a long-lived `__Host-tv_device` cookie:
 * HttpOnly, Secure, SameSite=Strict, `v1.<user id>.<random device id>.<issued
 * ms>.<HMAC-SHA256>`. It is rotated (a new device id and time) at every full
 * sign-in. It is not a credential: it never signs anyone in and never skips
 * the password or the second factor. It only lets its owner past the
 * per-account throttles a stranger can trigger, so a guessing attack on an
 * account cannot lock its real owner out. It stops counting as soon as the
 * password changes (issued before `password_changed_at`), when it expires,
 * and after 10 failed attempts with it in 15 minutes (LoginThrottle).
 *
 * Stateless on purpose: nothing stored per device, so nothing to clean up.
 */
@Injectable()
export class DeviceTrustService {
  private readonly key: Buffer;

  constructor(@Inject(ENV) private readonly env: Env) {
    if (env.DEVICE_TRUST_KEY) {
      this.key = Buffer.from(env.DEVICE_TRUST_KEY, 'base64');
    } else if (env.NODE_ENV !== 'production' && env.LOCAL_MASTER_KEY) {
      // Development and tests: derived, so trusted devices survive a restart.
      this.key = Buffer.from(hkdfSync('sha256', Buffer.from(env.LOCAL_MASTER_KEY, 'base64'), Buffer.alloc(0), 'tv-device-trust-v1', 32));
    } else {
      this.key = randomBytes(32);
      if (env.NODE_ENV === 'production') logger.warn('DEVICE_TRUST_KEY not set: trusted devices are forgotten on restart');
    }
  }

  private mac(body: string): string {
    return createHmac('sha256', this.key).update(`tv-device-v1|${body}`).digest('base64url');
  }

  /** A fresh cookie value for this user (a new device id every time). */
  issue(userId: string, now = Date.now()): { value: string; expires: Date } {
    const body = `${userId}.${randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')}.${now}`;
    return { value: `v1.${body}.${this.mac(body)}`, expires: new Date(now + this.env.DEVICE_TRUST_DAYS * 86_400_000) };
  }

  /** The signed claim in a cookie, or null if it is malformed, forged or expired. */
  verify(value: string | undefined | null, now = Date.now()): TrustedDevice | null {
    if (!value || value.length > 200) return null;
    const parts = value.split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') return null;
    const [, userId, deviceId, issued, tag] = parts as [string, string, string, string, string];
    if (!UUID.test(userId) || !UUID.test(deviceId) || !/^\d{13}$/.test(issued)) return null;
    const expected = Buffer.from(this.mac(`${userId}.${deviceId}.${issued}`));
    const got = Buffer.from(tag);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
    const issuedAt = Number(issued);
    if (issuedAt > now + 60_000 || issuedAt + this.env.DEVICE_TRUST_DAYS * 86_400_000 <= now) return null;
    return { userId, deviceId, issuedAt };
  }

  /** Trusted for this account: signed for it, and issued after its last password change. */
  trustedFor(value: string | undefined | null, user: { id: string; passwordChangedAt: Date } | null): TrustedDevice | null {
    const d = this.verify(value);
    return d && user && d.userId === user.id && d.issuedAt >= user.passwordChangedAt.getTime() ? d : null;
  }

  setCookie(res: Response, userId: string): void {
    const { value, expires } = this.issue(userId);
    res.cookie(DEVICE_COOKIE, value, { httpOnly: true, secure: true, sameSite: 'strict', path: '/', expires });
  }
}

/** The device cookie from a raw Cookie header (the request context is built before cookie parsing). */
export function deviceCookieFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === DEVICE_COOKIE) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
